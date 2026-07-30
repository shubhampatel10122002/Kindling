import type { WebSocket } from 'ws';
import { AUDIO } from '../lib/env';
import { query, one } from '../lib/db';
import { Narrator, type NarratorMode, type NarratorTurn } from '../lib/llm/narrator';
import { classifyIntent } from '../lib/llm/intent';
import { generateSessionPlan, fallbackPlan } from '../lib/llm/planner';
import { pickTargets } from '../lib/pedagogy';
import { pickPraiseWord } from '../lib/praise';
import * as T from '../lib/templates';
import { PronunciationSession, TalkRecognizer } from './azure';
import { tts, type SpeakHandle } from './cartesia';
import { PassageTracker, tokenize } from './tracker';
import type {
  Child,
  ChildMemory,
  ClientMessage,
  Intent,
  Mastery,
  Mode,
  ServerMessage,
  SessionPlan,
  TranscriptEntry,
} from '../lib/types';

const SESSION_MAX_MS = 15 * 60 * 1000;
const SILENCE_NUDGE_MS = 8_000;
const SILENCE_CHECKIN_MS = 28_000;
const SILENCE_PAUSE_MS = 45_000;
const WORD_STUCK_MS = 3_000;
const TALK_TIMEOUT_MS = 5_000;
const MAX_COACH_ATTEMPTS = 2;
const ADAPT_COACH_THRESHOLD = 3;
const MAX_SOCRATIC_QUESTIONS = 3;

export class Session {
  private mode: Mode = 'IDLE';
  private sessionId: string | null = null;
  private narrator!: Narrator;
  private plan!: SessionPlan;

  private tracker: PassageTracker | null = null;
  private pron: PronunciationSession | null = null;
  private talk: TalkRecognizer | null = null;

  private speaking: SpeakHandle | null = null;
  private gateOpenAt = 0; // mic frames before this timestamp are dropped
  private isSpeaking = false;
  /** Tail of the utterance queue — see speak(). */
  private speechChain: Promise<void> = Promise.resolve();

  private transcript: TranscriptEntry[] = [];
  private interestSignals: string[] = [];
  private pendingEvents: any[] = [];

  private coachAttempts = new Map<number, number>();
  private coachEventsThisPassage = 0;
  private strongPassages = 0;
  private socraticCount = 0;
  private beatIndex = 0;

  private bufferedTurn: Promise<NarratorTurn> | null = null;
  private bufferToken = 0;

  private lastSpeechAt = Date.now();
  private nudgeStage = 0;
  private tick: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private talkTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private ws: WebSocket,
    private child: Child,
    private memory: ChildMemory,
    private mastery: Mastery[],
  ) {}

  // -------------------------------------------------------------------------
  // Wire helpers
  // -------------------------------------------------------------------------

  private send(msg: ServerMessage) {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
  }

  private sendAudio(pcm: Buffer) {
    if (this.ws.readyState !== 1) return;
    this.ws.send(pcm, { binary: true });
  }

  private log(kind: TranscriptEntry['kind'], text: string, meta?: Record<string, unknown>) {
    this.transcript.push({ ts: new Date().toISOString(), kind, text, meta });
  }

  private setMode(mode: Mode, reason?: string) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.log('mode', mode, reason ? { reason } : undefined);
    this.send({ t: 'mode', mode, reason });
  }

  private debug(key: string, value: unknown) {
    this.send({ t: 'debug', key, value });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start() {
    this.tick = setInterval(() => this.onTick(), 500);

    // Speak a template greeting FIRST, with no LLM in the way. Planning plus the
    // opening narrator turn is several seconds of round-trips; a child staring at
    // a silent screen for that long assumes it is broken. This also means the
    // very first thing that happens in a session exercises the whole audio path.
    this.setMode('NARRATE', 'greeting');
    const greeting = this.speak(T.openingLine(this.child.name));

    // Resolve the plan while the greeting is playing.
    const planning = (async (): Promise<SessionPlan> => {
      const stored = await one<{ plan: SessionPlan }>(
        'SELECT plan FROM next_plans WHERE child_id = $1',
        [this.child.id],
      );
      if (stored?.plan) return stored.plan;

      const targets = pickTargets(this.mastery);
      try {
        return await generateSessionPlan({
          child: this.child,
          memory: this.memory,
          mastery: this.mastery,
          targetSkills: targets,
        });
      } catch (err) {
        console.error('[session] planner failed, using fallback', err);
        return fallbackPlan(this.child, targets);
      }
    })();

    const [, plan] = await Promise.all([greeting, planning]);
    if (this.closed) return;
    this.plan = plan;

    const row = await one<{ id: string }>(
      'INSERT INTO sessions (child_id, plan) VALUES ($1, $2) RETURNING id',
      [this.child.id, JSON.stringify(this.plan)],
    );
    this.sessionId = row!.id;

    this.narrator = new Narrator(this.child, this.memory, this.plan);

    this.send({ t: 'ready', childName: this.child.name, plan: this.plan });
    this.debug('plan', this.plan);

    await this.narrate(
      'OPENING',
      `${this.child.name} has already been greeted out loud, so do not greet them again. Go straight into beat 0 of the story.`,
    );
  }

  async handleMessage(msg: ClientMessage) {
    switch (msg.t) {
      case 'start':
        if (this.mode === 'IDLE') await this.start();
        break;
      case 'talk_start':
        await this.openTalk();
        break;
      case 'talk_end':
        await this.closeTalk();
        break;
      case 'resume':
        if (this.mode === 'PAUSED') {
          this.lastSpeechAt = Date.now();
          this.nudgeStage = 0;
          this.setMode('CHILD_READS', 'resumed');
        }
        break;
      case 'stop':
        await this.end('child asked to stop');
        break;
      case 'tts_test':
        // Exercises the real audio path — Cartesia -> WebSocket -> Web Audio —
        // with no LLM involved, so "can I hear anything at all?" is one click.
        await this.speak(
          "Hello! This is Ollie testing the sound. If you can hear me, the audio is working.",
        );
        break;
      case 'ping':
        break;
    }
  }

  /** Mic frames from the browser. The server-side gate is authoritative. §8.2 */
  onAudio(pcm: Buffer) {
    if (this.closed) return;
    if (Date.now() < this.gateOpenAt) return; // half-duplex: never listen to ourselves

    if (this.mode === 'TALK') {
      this.talk?.write(pcm);
      return;
    }
    if (this.mode === 'CHILD_READS' || this.mode === 'COACH') {
      this.pron?.write(pcm);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.tick) clearInterval(this.tick);
    if (this.talkTimer) clearTimeout(this.talkTimer);
    this.speaking?.cancel();
    await Promise.all([this.pron?.close(), this.talk?.close()]);
  }

  // -------------------------------------------------------------------------
  // Speaking (half-duplex)
  // -------------------------------------------------------------------------

  /**
   * Serialise speech. Two utterances must never overlap: the narrator would talk
   * over itself, and Cartesia's free tier caps concurrent contexts at 2 — which
   * is exactly the "concurrency limit of 2" error a nudge firing mid-utterance
   * (or a Test-sound click during a story beat) produces.
   */
  private async speak(text: string): Promise<void> {
    const previous = this.speechChain;
    let release!: () => void;
    this.speechChain = new Promise<void>((r) => (release = r));
    try {
      await previous;
      await this.speakNow(text);
    } finally {
      release();
    }
  }

  private async speakNow(text: string): Promise<void> {
    if (!text.trim() || this.closed) return;

    this.isSpeaking = true;
    this.gateOpenAt = Number.MAX_SAFE_INTEGER; // close the gate for the whole utterance
    this.send({ t: 'tts_start' });
    this.send({ t: 'speak', text });
    this.log('narrator', text);

    // Count what actually leaves the server. When a founder reports "I can't hear
    // anything", this line is the difference between a server-side and a
    // browser-side problem — and it costs one integer.
    let bytes = 0;
    const started = Date.now();
    let firstChunkMs = -1;

    const handle = tts().speak(text, (chunk) => {
      if (firstChunkMs < 0) firstChunkMs = Date.now() - started;
      bytes += chunk.length;
      this.sendAudio(chunk);
    });
    this.speaking = handle;

    try {
      await handle.done;
      const seconds = bytes / 4 / AUDIO.ttsSampleRate;
      if (bytes === 0) {
        console.error(
          `[tts] produced NO audio for "${text.slice(0, 50)}…" — check CARTESIA_API_KEY, CARTESIA_VOICE_ID and CARTESIA_MODEL`,
        );
      } else {
        console.log(
          `[tts] ${bytes} bytes (~${seconds.toFixed(2)}s audio), first chunk in ${firstChunkMs}ms`,
        );
      }
      this.debug('lastTts', { bytes, seconds: Number(seconds.toFixed(2)), firstChunkMs });
    } finally {
      this.speaking = null;
      this.isSpeaking = false;
      // Keep the gate shut for the audio tail so we don't hear our own voice.
      this.gateOpenAt = Date.now() + AUDIO.gateTailMs;
      this.send({ t: 'tts_end' });
      this.lastSpeechAt = Date.now();
    }
  }

  /** Barge-in: kill playback instantly and reopen the mic. */
  private stopSpeaking() {
    if (this.speaking) {
      this.speaking.cancel();
      this.speaking = null;
    }
    this.isSpeaking = false;
    this.gateOpenAt = 0;
    this.send({ t: 'tts_end' });
  }

  // -------------------------------------------------------------------------
  // NARRATE
  // -------------------------------------------------------------------------

  private async narrate(
    mode: NarratorMode,
    context: string,
    prefetched?: NarratorTurn,
    mustMention?: string | null,
  ) {
    this.setMode('NARRATE');
    const turn = prefetched ?? (await this.narrator.turn(mode, context, { mustMention }));
    this.beatIndex = turn.current_beat_index ?? this.beatIndex;
    this.debug('lastNarratorTurn', { mode, ...turn });

    await this.speak(turn.speak_text);

    if (turn.child_passage && turn.child_passage.trim()) {
      await this.startPassage(turn.child_passage.trim());
    } else if (mode === 'CLOSING') {
      await this.finishEnd();
    } else {
      // A conversational turn with no passage — go back to whatever they were reading.
      if (this.tracker && !this.tracker.isComplete()) {
        this.setMode('CHILD_READS', 'resuming passage');
        this.lastSpeechAt = Date.now();
      } else {
        await this.nextBeat();
      }
    }
  }

  private async startPassage(passage: string) {
    await this.pron?.close();
    this.pron = null;

    this.tracker = new PassageTracker(passage);
    this.coachAttempts.clear();
    this.coachEventsThisPassage = 0;
    this.nudgeStage = 0;
    this.lastSpeechAt = Date.now();

    this.log('child_passage', passage);
    this.send({ t: 'passage', text: passage, words: tokenize(passage) });
    this.send({ t: 'cursor', index: 0 });

    this.pron = new PronunciationSession(passage, {
      onPartial: (text) => {
        this.lastSpeechAt = Date.now();
        this.nudgeStage = 0;
        this.debug('azurePartial', text);
      },
      onWords: (words, recognized) => {
        void this.onWords(words, recognized);
      },
      onError: (m) => {
        console.error('[azure]', m);
        this.send({ t: 'error', message: m });
      },
    });

    this.setMode('CHILD_READS');
    this.prefetchNextBeat();
  }

  /** Keep ONE beat buffered while the child reads. PLAN.md §4 cross-cutting rules. */
  private prefetchNextBeat() {
    const token = ++this.bufferToken;
    this.bufferedTurn = this.narrator
      .turn(
        'NEXT_BEAT',
        `The child is currently reading. Prepare beat ${this.beatIndex + 1} of ${
          this.plan.beats.length
        }.`,
      )
      .then((turn) => {
        if (token !== this.bufferToken) throw new Error('stale buffer');
        return turn;
      })
      .catch(() => null as unknown as NarratorTurn);
  }

  private discardBuffer() {
    this.bufferToken++;
    this.bufferedTurn = null;
  }

  private async nextBeat() {
    if (this.beatIndex >= this.plan.beats.length - 1) {
      await this.end('story complete');
      return;
    }
    const buffered = this.bufferedTurn ? await this.bufferedTurn.catch(() => null) : null;
    this.discardBuffer();
    await this.narrate(
      'NEXT_BEAT',
      `Advance to beat ${this.beatIndex + 1}.`,
      buffered ?? undefined,
    );
  }

  // -------------------------------------------------------------------------
  // CHILD_READS -> COACH / ENCOURAGE
  // -------------------------------------------------------------------------

  private async onWords(words: any[], recognized: string) {
    if (!this.tracker || this.closed) return;
    if (this.mode !== 'CHILD_READS' && this.mode !== 'COACH') return;

    this.lastSpeechAt = Date.now();
    this.nudgeStage = 0;

    const result = this.tracker.ingest(words);
    this.debug('azureRecognized', recognized);
    this.debug('lastWords', this.tracker.summary());

    for (const u of result.updates) {
      this.send({
        t: 'word',
        index: u.index,
        status: u.word.status,
        score: u.word.bestScore,
        errorType: u.word.errorType,
      });
      if (u.event) this.pendingEvents.push(u.event);
    }
    this.send({ t: 'cursor', index: this.tracker.cursor });
    void this.flushEvents();

    if (result.complete) {
      await this.onPassageComplete();
      return;
    }
    if (result.needsCoaching !== null) {
      await this.coach(result.needsCoaching);
    }
  }

  private async coach(index: number) {
    if (!this.tracker) return;
    const word = this.tracker.words[index];
    if (!word) return;

    const attempts = (this.coachAttempts.get(index) ?? 0) + 1;
    this.coachAttempts.set(index, attempts);
    this.coachEventsThisPassage += 1;

    // Frustration / repeated struggle inside one passage -> ADAPT. PLAN.md §4.
    if (this.coachEventsThisPassage >= ADAPT_COACH_THRESHOLD) {
      await this.adapt('3+ coaching moments in one passage');
      return;
    }

    if (attempts > MAX_COACH_ATTEMPTS) {
      // Say the word warmly and move on. Never let a child grind on one word.
      const line = T.giveWordLine(word.expected);
      this.tracker.markGiven(index);
      this.send({ t: 'word', index, status: 'given', score: word.bestScore, errorType: word.errorType });
      this.send({ t: 'cursor', index: this.tracker.cursor });
      this.log('coach', line, { word: word.expected, gave: true });

      this.setMode('COACH', 'gave the word');
      await this.speak(line);

      if (this.tracker.isComplete()) {
        await this.onPassageComplete();
      } else {
        this.setMode('CHILD_READS');
      }
      return;
    }

    this.setMode('COACH', `stuck on "${word.expected}"`);
    this.tracker.markCoaching(index);

    const line = T.coachLine(word.expected, attempts);
    this.log('coach', line, { word: word.expected, attempt: attempts });
    await this.speak(line);

    // Back to CHILD_READS on the same word.
    this.setMode('CHILD_READS');
    this.lastSpeechAt = Date.now();
  }

  private async onPassageComplete() {
    if (!this.tracker) return;

    const strong = this.tracker.wasStrong();
    this.strongPassages = strong ? this.strongPassages + 1 : 0;
    this.debug('strongPassages', this.strongPassages);

    await this.pron?.close();
    this.pron = null;

    if (this.strongPassages >= 2) {
      this.strongPassages = 0;
      this.discardBuffer();
      this.setMode('ENCOURAGE', 'two strong passages');

      // Code picks the word, not the narrator. Asked to "name something
      // specific", the model would reach for a plausible word from its context
      // (a must_use_word, a skill example) instead of one the child said.
      const praiseWord = pickPraiseWord(this.tracker.words);
      this.debug('praiseWord', praiseWord);

      await this.narrate(
        'ENCOURAGE',
        `They read two passages beautifully. Then continue to beat ${this.beatIndex + 1}.`,
        undefined,
        praiseWord,
      );
      return;
    }

    if (Date.now() - this.startedAt > SESSION_MAX_MS) {
      await this.end('15 minutes elapsed');
      return;
    }

    await this.nextBeat();
  }

  private async adapt(reason: string) {
    this.discardBuffer();
    this.setMode('ADAPT', reason);
    this.send({ t: 'flag', type: 'frustration', detail: reason });
    await this.flag('frustration', reason);

    this.plan = {
      ...this.plan,
      difficulty: Math.max(1, this.plan.difficulty - 1),
      vocab_constraints: {
        ...this.plan.vocab_constraints,
        max_sentence_words: Math.max(4, this.plan.vocab_constraints.max_sentence_words - 2),
      },
    };
    this.narrator.updatePlan(this.plan);
    this.debug('plan', this.plan);

    await this.pron?.close();
    this.pron = null;

    await this.narrate(
      'ADAPT',
      'The child is finding this hard. One short sentence only, simplest words, and offer them a choice.',
    );
  }

  // -------------------------------------------------------------------------
  // TALK mode + intent router (PLAN.md §5)
  // -------------------------------------------------------------------------

  private async openTalk() {
    if (this.mode === 'END' || this.closed) return;

    // 1. Kill playback instantly and stop pronunciation assessment.
    this.stopSpeaking();
    await this.pron?.close();
    this.pron = null;

    this.setMode('TALK', 'talk button');
    this.send({ t: 'talk_open' });

    let settled = false;
    const finish = async (text: string | null) => {
      if (settled) return;
      settled = true;
      if (this.talkTimer) clearTimeout(this.talkTimer);
      await this.talk?.close();
      this.talk = null;
      await this.routeTalk(text);
    };

    this.talk = new TalkRecognizer({
      onPartial: (text) => this.debug('talkPartial', text),
      onFinal: (text) => void finish(text),
      onError: (m) => console.error('[azure talk]', m),
    });

    // 3. No intelligible speech within 5s -> playful nudge, resume where we were.
    this.talkTimer = setTimeout(() => void finish(null), TALK_TIMEOUT_MS);
  }

  private async closeTalk() {
    // Push-to-talk release. The recognizer's own final result usually wins the
    // race; this just shortens the tail when the child lets go early.
    if (this.mode !== 'TALK') return;
    if (this.talkTimer) clearTimeout(this.talkTimer);
    this.talkTimer = setTimeout(() => {
      if (this.mode === 'TALK') void this.routeTalkTimeout();
    }, 1200);
  }

  private async routeTalkTimeout() {
    await this.talk?.close();
    this.talk = null;
    await this.routeTalk(null);
  }

  private async routeTalk(transcript: string | null) {
    if (this.closed) return;

    if (!transcript || transcript.trim().length < 2) {
      this.send({ t: 'talk_closed', transcript: null, intent: null });
      await this.speak(T.talkTimeoutLine());
      this.resumeReading();
      return;
    }

    this.log('child_talk', transcript);

    const currentWord =
      this.tracker && this.tracker.cursor < this.tracker.words.length
        ? this.tracker.words[this.tracker.cursor].expected
        : null;

    const { intent, interestTopic, reasoning } = await classifyIntent({
      transcript,
      currentPassage: this.tracker?.passage ?? null,
      currentWord,
      storyPremise: this.plan.premise,
    });

    this.debug('lastIntent', { transcript, intent, reasoning });
    this.send({ t: 'talk_closed', transcript, intent });

    await this.handleIntent(intent, transcript, interestTopic, currentWord);
  }

  private async handleIntent(
    intent: Intent,
    transcript: string,
    interestTopic: string | null,
    currentWord: string | null,
  ) {
    switch (intent) {
      // Procedural help is never Socratic. Answer directly, then keep reading.
      case 'help_with_word':
        await this.narrate(
          'ANSWER_DIRECTLY',
          `The child asked: "${transcript}". They are on the word "${currentWord ?? 'unknown'}". Tell them what it says and how to sound it out.`,
        );
        this.resumeReading();
        return;

      case 'question_about_story_or_world': {
        this.discardBuffer();
        this.socraticCount += 1;
        this.setMode('SOCRATIC', `question #${this.socraticCount}`);

        if (this.socraticCount > MAX_SOCRATIC_QUESTIONS) {
          // Patience beats pedagogy purity. Edge case #8.
          this.socraticCount = 0;
          await this.narrate(
            'ANSWER_DIRECTLY',
            `The child asked: "${transcript}". You have already asked them several guiding questions. Give them the answer warmly now, then weave back to the story in one sentence.`,
          );
        } else {
          await this.narrate(
            'SOCRATIC',
            `The child asked: "${transcript}". This is guiding question ${this.socraticCount} of ${MAX_SOCRATIC_QUESTIONS}.`,
          );
        }
        this.resumeReading();
        return;
      }

      case 'change_request':
        this.discardBuffer();
        this.setMode('REMIX', transcript);
        await this.narrate(
          'REMIX',
          `The child said: "${transcript}". Rebuild the next beat around their idea. Keep difficulty ${this.plan.difficulty}, the same target skills, and the same must-use words: ${this.plan.vocab_constraints.must_use_words.join(', ')}.`,
        );
        return;

      case 'chitchat':
        if (interestTopic) {
          this.interestSignals.push(interestTopic);
          this.debug('interestSignals', this.interestSignals);
        }
        await this.narrate(
          'CHITCHAT',
          `The child said: "${transcript}". Acknowledge it warmly in one sentence and weave back to the story.`,
        );
        this.resumeReading();
        return;

      case 'want_to_stop':
        await this.flag('early_exit', transcript);
        this.send({ t: 'flag', type: 'early_exit', detail: transcript });
        await this.end('child wants to stop');
        return;

      case 'sensitive_topic': {
        // FIXED template. Never improvised. Flagged for the parent. PLAN.md §5.
        const character = this.plan.characters[0] ?? 'our friend';
        const line = T.sensitiveTopicLine(character);
        await this.flag('sensitive_topic', transcript);
        this.send({ t: 'flag', type: 'sensitive_topic', detail: transcript });
        this.log('narrator', line, { template: 'sensitive_topic' });
        await this.speak(line);
        this.resumeReading();
        return;
      }

      case 'unclear':
      default:
        await this.speak(T.unclearLine());
        this.resumeReading();
        return;
    }
  }

  /** Return to the passage the child was on, restarting assessment on it. */
  private resumeReading() {
    if (this.closed || this.mode === 'END') return;
    if (!this.tracker || this.tracker.isComplete()) return;

    const passage = this.tracker.passage;
    if (!this.pron) {
      this.pron = new PronunciationSession(passage, {
        onPartial: (text) => {
          this.lastSpeechAt = Date.now();
          this.nudgeStage = 0;
          this.debug('azurePartial', text);
        },
        onWords: (words, recognized) => void this.onWords(words, recognized),
        onError: (m) => console.error('[azure]', m),
      });
    }
    this.setMode('CHILD_READS', 'back to the story');
    this.lastSpeechAt = Date.now();
    this.nudgeStage = 0;
    this.send({ t: 'cursor', index: this.tracker.cursor });
  }

  // -------------------------------------------------------------------------
  // Timers: silence ladder + stuck-word detection
  // -------------------------------------------------------------------------

  private onTick() {
    if (this.closed || this.isSpeaking) return;
    if (this.mode !== 'CHILD_READS') return;

    const idle = Date.now() - this.lastSpeechAt;

    // Pause > 3000ms on the current word counts as being stuck. PLAN.md §4.
    if (
      this.tracker &&
      idle > WORD_STUCK_MS &&
      this.nudgeStage === 0 &&
      this.tracker.cursor < this.tracker.words.length &&
      (this.coachAttempts.get(this.tracker.cursor) ?? 0) === 0 &&
      idle < SILENCE_NUDGE_MS
    ) {
      // Give them a beat of quiet before the nudge ladder kicks in.
      return;
    }

    if (idle > SILENCE_PAUSE_MS && this.nudgeStage < 3) {
      this.nudgeStage = 3;
      this.setMode('PAUSED', 'no speech for 45s');
      void this.speak(T.pausedLine());
      return;
    }
    if (idle > SILENCE_CHECKIN_MS && this.nudgeStage < 2) {
      this.nudgeStage = 2; // never nag more than twice
      this.send({ t: 'nudge', text: 'checking in' });
      void this.speak(T.stillThereLine());
      return;
    }
    if (idle > SILENCE_NUDGE_MS && this.nudgeStage < 1) {
      this.nudgeStage = 1;
      const w = this.tracker?.words[this.tracker.cursor];
      if (w) {
        this.send({ t: 'nudge', text: 'gentle prompt' });
        void this.speak(T.silenceNudge(w.expected));
      }
      return;
    }

    if (Date.now() - this.startedAt > SESSION_MAX_MS) {
      void this.end('15 minutes elapsed');
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async flushEvents() {
    if (!this.sessionId || this.pendingEvents.length === 0) return;
    const batch = this.pendingEvents.splice(0, this.pendingEvents.length);
    try {
      for (const e of batch) {
        await query(
          `INSERT INTO reading_events
             (session_id, child_id, expected_word, attempt, error_type, accuracy_score, phonemes, pause_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            this.sessionId,
            this.child.id,
            e.expected_word,
            e.attempt,
            e.error_type,
            e.accuracy_score,
            JSON.stringify(e.phonemes ?? []),
            e.pause_ms ?? 0,
          ],
        );
      }
    } catch (err) {
      console.error('[session] failed to write reading_events', err);
    }
  }

  private async flag(type: string, detail: string) {
    if (!this.sessionId) return;
    try {
      await query('INSERT INTO session_flags (session_id, type, detail) VALUES ($1,$2,$3)', [
        this.sessionId,
        type,
        detail,
      ]);
    } catch (err) {
      console.error('[session] failed to write flag', err);
    }
  }

  // -------------------------------------------------------------------------
  // END
  // -------------------------------------------------------------------------

  async end(reason: string) {
    if (this.mode === 'END' || this.closed) return;
    this.discardBuffer();
    this.setMode('END', reason);

    await this.pron?.close();
    this.pron = null;

    const strongest = this.transcript.filter((t) => t.kind === 'child_passage').length;
    await this.narrate(
      'CLOSING',
      `Wrap the story up in one beat — never on a cliffhanger. Reference something specific: they read ${strongest} passage(s) today. Reason for ending: ${reason}.`,
    );
  }

  private async finishEnd() {
    await this.flushEvents();

    if (this.sessionId) {
      try {
        await query('UPDATE sessions SET ended_at = now(), transcript = $2 WHERE id = $1', [
          this.sessionId,
          JSON.stringify(this.transcript),
        ]);
        if (this.interestSignals.length) {
          await query('INSERT INTO session_flags (session_id, type, detail) VALUES ($1,$2,$3)', [
            this.sessionId,
            'interest_signals',
            this.interestSignals.join(', '),
          ]);
        }
      } catch (err) {
        console.error('[session] failed to save transcript', err);
      }
    }

    this.send({ t: 'ended', sessionId: this.sessionId ?? '' });
    await this.close();
  }
}
