import type { WebSocket } from 'ws';
import { AUDIO } from '../lib/env';
import { query, one } from '../lib/db';
import { Narrator, type NarratorMode, type NarratorTurn } from '../lib/llm/narrator';
import { absorb, type Absorbed } from '../lib/llm/absorb';
import { generateSessionPlan, fallbackPlan } from '../lib/llm/planner';
import { generateAcknowledgment } from '../lib/llm/acknowledge';
import { pickTargets } from '../lib/pedagogy';
import { pickPraiseWord } from '../lib/praise';
import { parseYesNo } from '../lib/ack';
import { planOpening, rememberLine, type OpeningPlan } from '../lib/opening';
import { pickCameo } from '../lib/notes';
import { improvedWords } from '../lib/progress';
import { createChildWithDefaults } from '../lib/db';
import * as T from '../lib/templates';
import { PronunciationSession, TalkRecognizer } from './azure';
import { tts, type SpeakHandle } from './cartesia';
import { PassageTracker, tokenize } from './tracker';
import type {
  Child,
  ChildMemory,
  ChildNote,
  ClientMessage,
  Mastery,
  Mode,
  Mood,
  ServerMessage,
  SessionPlan,
  TranscriptEntry,
} from '../lib/types';

const SESSION_MAX_MS = 15 * 60 * 1000;
/** Mood is absorbed, not discussed: "I'm tired" silently shortens the session. */
const TIRED_SESSION_MS = 8 * 60 * 1000;
const SILENCE_NUDGE_MS = 8_000;
const SILENCE_CHECKIN_MS = 28_000;
const SILENCE_PAUSE_MS = 45_000;
const WORD_STUCK_MS = 3_000;
const TALK_TIMEOUT_MS = 5_000;
const MAX_COACH_ATTEMPTS = 2;
const ADAPT_COACH_THRESHOLD = 3;
/** How long we wait for her to answer an open-mic question before moving on. */
const OPEN_MIC_MS = 9_000;

export class Session {
  private mode: Mode = 'IDLE';
  private sessionId: string | null = null;
  private narrator!: Narrator;
  private plan!: SessionPlan;
  private child!: Child;

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
  private beatIndex = 0;

  /** Things she volunteered this session, waiting to become story. */
  private notes: ChildNote[] = [];
  private cameosUsed = 0;
  private mood: Mood | null = null;
  private moodApplied = false;
  private sessionMaxMs = SESSION_MAX_MS;
  /** Best word she read today, so the ending never has to reach for one. */
  private bestWord: string | null = null;

  /** The ending is a sequence, not an event: cliffhanger, ask, maybe one more. */
  private ending = false;
  private extraBeatUsed = false;
  /** Resolves the open mic early when she answers with a button instead. */
  private cancelListen: ((text: string | null) => void) | null = null;
  /** Resolves once a grown-up has confirmed the spelling of her name. */
  private pendingName: ((name: string) => void) | null = null;

  private bufferedTurn: Promise<NarratorTurn> | null = null;
  private bufferToken = 0;

  private lastSpeechAt = Date.now();
  private nudgeStage = 0;
  private tick: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private talkTimer: NodeJS.Timeout | null = null;
  private closed = false;

  /** True when we have never met her and onboarding has to run first. */
  private readonly isNewChild: boolean;

  constructor(
    private ws: WebSocket,
    child: Child | null,
    private memory: ChildMemory,
    private mastery: Mastery[],
  ) {
    // A null child means onboarding fills `this.child` in before anything else
    // touches it. start() is the only caller allowed to run before that happens.
    if (child) this.child = child;
    this.isNewChild = child === null;
  }

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

  async start(localHour?: number) {
    this.tick = setInterval(() => this.onTick(), 500);

    // Onboarding and the doorway are the same beat of the session — a minute of
    // her talking before any reading — so she only ever gets one of them.
    // Onboarding already asked her name and what she likes.
    if (this.isNewChild) {
      await this.onboard();
      if (this.closed || !this.child) return;
    } else {
      await this.doorway(localHour);
      if (this.closed) return;
    }

    // Speak a template line FIRST, with no LLM in the way. Planning plus the
    // opening narrator turn is several seconds of round-trips; a child staring at
    // a silent screen for that long assumes it is broken. This also means the
    // very first thing that happens in a session exercises the whole audio path.
    this.setMode('NARRATE', 'greeting');
    const greeting = this.speak(
      this.isNewChild ? T.onboardingWriting(this.child.name) : T.writingLine(),
    );

    // Resolve the plan while that is playing.
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

    // Anything she told us in the doorway was held until there was a session row
    // to attach it to. It also may have quietly changed how long today runs.
    await this.flushNotes();
    this.applyMood();

    this.send({ t: 'ready', childName: this.child.name, plan: this.plan });
    this.debug('plan', this.plan);

    await this.narrate(
      'OPENING',
      `${this.child.name} has already been greeted out loud, so do not greet them again. Go straight into beat 0 of the story.`,
    );
  }

  // -------------------------------------------------------------------------
  // Onboarding: a child we have never met, reading within about a minute
  // -------------------------------------------------------------------------

  /**
   * Learn her name and one thing she likes, conversationally, then write.
   *
   * There is no placement test, ever — the first passage starts slightly below
   * where we would guess and the first few sentences calibrate us. A child's
   * first experience of this product has to be success.
   */
  private async onboard() {
    this.setMode('ONBOARDING', 'first time');

    await this.speak(T.onboardingGreeting());
    const heard = await this.listenOnce(OPEN_MIC_MS);

    // Her name is the one thing speech recognition must not get wrong: it ends
    // up in every story from here on. So we always show what we heard and let a
    // grown-up fix it, rather than guessing confidently and being stuck with it.
    this.send({ t: 'need_name', heard: guessName(heard) });
    const name = await this.waitForName();
    if (this.closed) return;

    await this.speak(T.onboardingLikes(name));
    const likes = await this.listenOnce(OPEN_MIC_MS);

    let notes: string | null = null;
    if (likes) {
      const absorbed = await absorb({ transcript: likes, context: 'doorway', childName: name });
      this.debug('lastAbsorbed', absorbed);
      await this.speak(absorbed.ack);
      if (absorbed.note) {
        notes = `Told me on day one: ${absorbed.note.subject}.`;
        this.rememberNote(absorbed.note);
      }
    }

    this.child = await createChildWithDefaults({ name, age: null, notes });
    this.memory = { interests: [], personality_notes: '', canon: {} };
    this.mastery = [];
    this.log('system', `onboarded ${name}`);
  }

  /** Block until the browser sends the confirmed spelling of her name. */
  private waitForName(): Promise<string> {
    return new Promise((resolve) => {
      this.pendingName = (name) => {
        this.pendingName = null;
        resolve(name.trim().slice(0, 40) || 'friend');
      };
    });
  }

  // -------------------------------------------------------------------------
  // The doorway: one question before the story
  // -------------------------------------------------------------------------

  /**
   * A short open door before reading. Ollie asks one thing, she talks, and
   * everything she says is absorbed rather than discussed — he answers with
   * "hm" and "I'm keeping that", never with a conversation.
   *
   * How much room the question gives depends on the two numbers this reads: what
   * time it is where she is, and how long since she was last here. Coming back an
   * hour later should not be met with "how was your day?" for the second time.
   */
  private async doorway(localHour?: number): Promise<OpeningPlan> {
    const hoursSinceLast = await this.hoursSinceLastSession();
    const hour = typeof localHour === 'number' ? localHour : new Date().getHours();
    const opening = planOpening({ hoursSinceLast, localHour: hour });
    this.debug('opening', { ...opening, hoursSinceLast, localHour: hour });

    this.setMode('DOORWAY', opening.shape);

    // Being remembered is how a child feels known, so say the specific thing
    // out loud — and say it in the same breath as the question, because two
    // clips butted together sound like two different thoughts.
    const remembered = rememberLine({
      lastNoteSubject: await this.lastNoteSubject(),
      openThread: this.memory.canon?.open_threads?.[0] ?? null,
    });
    await this.speak([remembered, opening.question].filter(Boolean).join(' '));

    const deadline = Date.now() + opening.doorwayMs;
    for (let turn = 0; turn < opening.maxTurns; turn++) {
      const remaining = deadline - Date.now();
      if (remaining < 2_000 || this.closed || this.mode !== 'DOORWAY') break;

      const said = await this.listenOnce(Math.min(OPEN_MIC_MS, remaining));
      if (!said) break;

      this.log('child_talk', said);
      const absorbed = await absorb({
        transcript: said,
        context: 'doorway',
        childName: this.child.name,
      });
      this.debug('lastAbsorbed', absorbed);

      // She spoke, so she hears something back. Always.
      await this.speak(absorbed.ack);
      this.keep(absorbed);
    }

    return opening;
  }

  private async hoursSinceLastSession(): Promise<number | null> {
    try {
      const row = await one<{ started_at: string }>(
        'SELECT started_at FROM sessions WHERE child_id = $1 ORDER BY started_at DESC LIMIT 1',
        [this.child.id],
      );
      if (!row?.started_at) return null;
      return (Date.now() - new Date(row.started_at).getTime()) / 3_600_000;
    } catch (err) {
      console.error('[session] could not read last session time', err);
      return null;
    }
  }

  /** The most recent thing she told us, for proving out loud that we remember. */
  private async lastNoteSubject(): Promise<string | null> {
    try {
      const row = await one<{ subject: string }>(
        `SELECT subject FROM child_notes
         WHERE child_id = $1 AND kind <> 'mood'
         ORDER BY id DESC LIMIT 1`,
        [this.child.id],
      );
      return row?.subject ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Open mic (doorway, onboarding, and the "one more bit?" question)
  // -------------------------------------------------------------------------

  /**
   * Open the mic, wait for one thing, close it.
   *
   * Used only where nothing else is listening. During reading the mic belongs to
   * pronunciation assessment and the owl button is the only way in — an
   * always-open mic there would fight the half-duplex gate (§8.2) and Azure's
   * reference-text scoring at the same time.
   */
  private listenOnce(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (text: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelListen = null;
        const recognizer = this.talk;
        this.talk = null;
        void recognizer?.close();
        this.send({ t: 'talk_closed', transcript: text, intent: null });
        resolve(text);
      };

      const timer = setTimeout(() => finish(null), timeoutMs);
      this.cancelListen = finish;

      this.send({ t: 'talk_open' });
      this.talk = new TalkRecognizer({
        onPartial: (text) => this.debug('talkPartial', text),
        onFinal: (text) => finish(text),
        onError: (m) => {
          console.error('[azure talk]', m);
          finish(null);
        },
      });
    });
  }

  async handleMessage(msg: ClientMessage) {
    switch (msg.t) {
      case 'start':
        if (this.mode === 'IDLE') await this.start(msg.localHour);
        break;
      case 'onboard_name':
        this.pendingName?.(msg.name);
        break;
      case 'doorway_done':
        // "Start reading" — the doorway is a floor, not a toll gate.
        this.cancelListen?.(null);
        if (this.mode === 'DOORWAY') this.setMode('NARRATE', 'doorway skipped');
        break;
      case 'wrap_answer':
        this.cancelListen?.(msg.more ? 'yes' : 'no');
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

    // A live conversational recognizer always wins: it only exists while Ollie
    // is deliberately listening — the owl button, the doorway, onboarding, or
    // the "one more bit?" question at the end.
    if (this.talk) {
      this.talk.write(pcm);
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
    speakPrefix?: string | null,
  ) {
    this.setMode('NARRATE');
    const turn = prefetched ?? (await this.narrator.turn(mode, context, { mustMention }));

    // Prepend rather than speak separately: one Cartesia context instead of two
    // (the free tier allows 2 concurrent), and it reads as a single natural
    // utterance rather than two clips butted together.
    if (speakPrefix) turn.speak_text = `${speakPrefix} ${turn.speak_text}`;
    this.beatIndex = turn.current_beat_index ?? this.beatIndex;
    this.debug('lastNarratorTurn', { mode, ...turn });

    await this.speak(turn.speak_text);

    if (turn.child_passage && turn.child_passage.trim()) {
      await this.startPassage(turn.child_passage.trim());
    } else if (mode === 'CLOSING') {
      await this.finishEnd();
    } else if (mode === 'CLIFFHANGER') {
      // end() drives what happens next: the recap, then "one more bit?".
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
        // Move the highlight while she is still speaking. The scored result only
        // arrives after end-of-utterance silence, and a highlight that lags a
        // second behind her voice reads as broken.
        const at = this.tracker?.heard(text);
        if (at !== null && at !== undefined) this.send({ t: 'heard', index: at });
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

    // A short acknowledgment before the story continues, so the child's turn
    // does not cut straight to narration. It has to be generated here rather
    // than baked into the buffered beat: the buffer is prefetched while the
    // child is still reading, so it cannot know how the reading went.
    //
    // Kicked off alongside the beat so the two overlap — when the beat is
    // already buffered this is the only thing on the critical path, and Haiku
    // keeps it to roughly a second.
    const ackPromise = this.tracker
      ? generateAcknowledgment({ childName: this.child.name, words: this.tracker.words })
      : Promise.resolve(null);

    // One thing she told us earlier comes back as scenery — not the plot, just a
    // presence. A promise visibly kept a few minutes later is what makes the book
    // feel alive; rewriting the story the instant she speaks teaches her that
    // interrupting reshapes the world, which is more fun than reading.
    const cameo = pickCameo(this.notes, this.cameosUsed);
    const buffered = cameo
      ? null // the buffered beat was written before she said it
      : this.bufferedTurn
        ? await this.bufferedTurn.catch(() => null)
        : null;
    this.discardBuffer();

    if (cameo) {
      this.cameosUsed += 1;
      await this.markNoteUsed(cameo, 'cameo');
      this.debug('cameo', cameo.subject);
    }

    const ack = await ackPromise;
    if (ack) this.debug('lastAck', { text: ack.text, band: ack.quality.band, source: ack.source });

    await this.narrate(
      'NEXT_BEAT',
      [
        `Advance to beat ${this.beatIndex + 1}.`,
        cameo
          ? `The child mentioned ${cameo.subject} earlier. Put it in as a small background detail — ` +
            'a thing that is simply there in the scene. It is not the plot, nobody remarks on it, ' +
            'and you never mention that she told you about it.'
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      buffered ?? undefined,
      null,
      ack?.text ?? null,
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

    // Keep the best word she has read today. The ending needs one concrete thing
    // to name, and a session that went badly at the end still went well somewhere.
    this.bestWord = pickPraiseWord(this.tracker.words) ?? this.bestWord;

    await this.pron?.close();
    this.pron = null;

    // The one extra bit she asked for is done. Nothing follows it but goodbye.
    if (this.extraBeatUsed) {
      await this.end('one more bit finished');
      return;
    }

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

    if (Date.now() - this.startedAt > this.sessionMaxMs) {
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
    // The mic is already open and waiting on her — the doorway, onboarding, or
    // "one more bit?". Opening a second recognizer would orphan the first.
    if (this.talk) return;

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

    const absorbed = await absorb({
      transcript,
      context: 'reading',
      childName: this.child.name,
      currentPassage: this.tracker?.passage ?? null,
      currentWord,
      storyPremise: this.plan?.premise ?? null,
    });

    this.debug('lastAbsorbed', { transcript, ...absorbed });
    this.send({ t: 'talk_closed', transcript, intent: absorbed.intent });

    await this.handleIntent(absorbed, transcript, currentWord);
  }

  /**
   * Route what she said. Exactly one of three destinations, never a conversation:
   * the current story, a future story, or what we understand about her.
   *
   * Whatever the destination, she gets an answer out loud first. A child who
   * volunteers something and hears nothing back has learned that talking to Ollie
   * does nothing, and that lesson sticks harder than any of the rest of this.
   */
  private async handleIntent(absorbed: Absorbed, transcript: string, currentWord: string | null) {
    const { intent } = absorbed;

    // Two intents answer for themselves: a procedural question needs the answer,
    // not an "mhm" in front of it, and a sensitive one has a fixed script.
    const answersItself = intent === 'help_with_word' || intent === 'sensitive_topic';
    if (!answersItself) {
      await this.speak(absorbed.ack);
      this.keep(absorbed);
    }

    switch (intent) {
      // Procedural help is never deflected. Answer directly, then keep reading.
      case 'help_with_word':
        await this.narrate(
          'ANSWER_DIRECTLY',
          `The child asked: "${transcript}". They are on the word "${currentWord ?? 'unknown'}". Tell them what it says and how to sound it out.`,
        );
        this.resumeReading();
        return;

      // About the story in front of her — the answer is in the passage she is
      // holding, so deferring it to tomorrow would just read as evasion.
      case 'question_about_story':
        await this.narrate(
          'ANSWER_IN_STORY',
          `The child asked: "${transcript}". Answer it from inside the story, in one or two sentences.`,
        );
        this.resumeReading();
        return;

      // The question jar. Ollie already said he does not know and that they will
      // find out — the note is what makes that promise true tomorrow.
      case 'question_about_world':
        this.log('system', `question jar: ${transcript}`);
        this.resumeReading();
        return;

      case 'change_request':
        this.discardBuffer();
        this.setMode('REMIX', transcript);
        await this.narrate(
          'REMIX',
          `The child said: "${transcript}". Rebuild the next beat around their idea. Keep difficulty ${this.plan.difficulty}, the same target skills, and the same must-use words: ${this.plan.vocab_constraints.must_use_words.join(', ')}.`,
        );
        return;

      // Acknowledged, kept, and that is all. The story does not stop to discuss
      // it and the passage she is reading is never rewritten underneath her.
      case 'chitchat':
        if (absorbed.note) {
          this.interestSignals.push(absorbed.note.subject);
          this.debug('interestSignals', this.interestSignals);
        }
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
  // The notebook: keeping what she volunteered
  // -------------------------------------------------------------------------

  /** Absorb one utterance's worth of keepables: the note, and the mood. */
  private keep(absorbed: Absorbed) {
    if (absorbed.note) this.rememberNote(absorbed.note);
    if (absorbed.mood && !this.mood) {
      this.mood = absorbed.mood;
      this.applyMood();
    }
  }

  private rememberNote(note: { kind: ChildNote['kind']; subject: string; weight: number }) {
    const row: ChildNote = {
      // Negative ids until Postgres assigns real ones; only used for ordering,
      // and they order the same way.
      id: -(this.notes.length + 1),
      kind: note.kind,
      subject: note.subject,
      detail: null,
      weight: note.weight,
      status: 'queued',
    };
    this.notes.push(row);
    // She sees it land in the notebook, so the ones that do not become story
    // today are visibly queued rather than apparently forgotten.
    this.send({ t: 'note', kind: row.kind, subject: row.subject });
    this.debug('notes', this.notes.map((n) => `${n.kind}: ${n.subject}`));
    void this.flushNotes();
  }

  /**
   * Mood is absorbed, never discussed. "I'm tired today" does not open a
   * conversation about feelings — it quietly shortens the session and drops the
   * difficulty, which is what a tutor does and a therapist does not.
   */
  private applyMood() {
    if (this.moodApplied || !this.plan) return;
    if (this.mood !== 'tired' && this.mood !== 'sad') return;
    this.moodApplied = true;

    this.sessionMaxMs = Math.min(this.sessionMaxMs, TIRED_SESSION_MS);
    this.plan = {
      ...this.plan,
      difficulty: Math.max(1, this.plan.difficulty - 1),
      vocab_constraints: {
        ...this.plan.vocab_constraints,
        max_sentence_words: Math.max(4, this.plan.vocab_constraints.max_sentence_words - 1),
      },
    };
    this.narrator?.updatePlan(this.plan);
    this.debug('mood', { mood: this.mood, sessionMaxMs: this.sessionMaxMs });
  }

  /** Write queued notes once there is a session row to hang them on. */
  private async flushNotes() {
    if (!this.sessionId) return;
    const unsaved = this.notes.filter((n) => n.id < 0);
    for (const n of unsaved) {
      try {
        const row = await one<{ id: number }>(
          `INSERT INTO child_notes (child_id, session_id, kind, subject, detail, weight, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [this.child.id, this.sessionId, n.kind, n.subject, n.detail, n.weight, n.status],
        );
        if (row) n.id = row.id;
      } catch (err) {
        console.error('[session] failed to write note', err);
        return;
      }
    }
  }

  private async markNoteUsed(note: ChildNote, status: ChildNote['status']) {
    note.status = status;
    if (note.id < 0) return;
    try {
      await query('UPDATE child_notes SET status = $2, used_at = now() WHERE id = $1', [
        note.id,
        status,
      ]);
    } catch (err) {
      console.error('[session] failed to mark note used', err);
    }
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

    if (Date.now() - this.startedAt > this.sessionMaxMs) {
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

  /**
   * Sessions end before she is finished, not after.
   *
   * The shape is: stop at a moment of tension, say when we pick it up, name one
   * concrete thing she can do now that she could not before, and offer exactly
   * one more bit. A session that ends while she still wants more is the single
   * strongest thing we can do for tomorrow's return, so the offer is capped at
   * one — "as much as you like" is how a good stopping point gets talked past.
   */
  async end(reason: string) {
    if (this.ending || this.mode === 'END' || this.closed) return;
    this.ending = true;

    this.discardBuffer();
    await this.pron?.close();
    this.pron = null;

    // She asked to stop, or she already had her extra bit. Zero guilt and no
    // upsell: being asked "one more?" right after saying you are done is not a
    // warm ending.
    if (reason === 'child wants to stop' || this.extraBeatUsed) {
      await this.finalGoodbye(reason);
      return;
    }

    await this.narrate(
      'CLIFFHANGER',
      'Stop the story at a moment of tension, with something about to happen. Do not resolve it. ' +
        'Two or three sentences, ending on the thing that is about to happen, and say you will pick ' +
        'it up next time.',
    );
    this.setMode('WRAP', reason);

    // Recap lightly: one concrete thing, in plain words, no scores and no metrics.
    const recap = await this.recapLine();
    await this.speak([recap, T.oneMoreLine()].filter(Boolean).join(' '));

    const answer = await this.listenOnce(OPEN_MIC_MS);
    if (this.closed) return;

    if (parseYesNo(answer) === true) {
      this.extraBeatUsed = true;
      this.ending = false;
      this.log('system', 'one more beat, by request');
      await this.oneMoreBeat();
      return;
    }

    await this.finalGoodbye(reason);
  }

  /**
   * The one extra bit she asked for.
   *
   * Deliberately not nextBeat(): the plan's beat list is a planning aid, and by
   * the time we are offering an extra it has usually run out. Asking a child if
   * she wants one more, hearing yes, and then saying goodbye is worse than never
   * offering, so this writes a beat whether or not the plan has one left.
   */
  private async oneMoreBeat() {
    this.discardBuffer();
    await this.narrate(
      'NEXT_BEAT',
      'She asked for one more bit, and this is the last one. Take the story one small step ' +
        'forward from the cliffhanger — do not resolve it, and leave something still hanging. ' +
        'Then give her one short passage to read.',
    );
  }

  /**
   * One thing she can do now that she could not before, or failing that one
   * thing that went well. Never a score, and never nothing: if the last few
   * minutes went badly we reach further back rather than ending on the failure.
   */
  private async recapLine(): Promise<string> {
    try {
      const grew = this.sessionId
        ? await improvedWords(this.child.id, { sessionId: this.sessionId, limit: 1 })
        : [];
      if (grew[0]) return T.grewLine(grew[0]);
    } catch (err) {
      console.error('[session] could not read progress for the recap', err);
    }
    if (this.bestWord) return `You read "${this.bestWord}" beautifully today.`;
    return '';
  }

  private async finalGoodbye(reason: string) {
    this.ending = true;
    this.setMode('END', reason);
    await this.pron?.close();
    this.pron = null;

    const passages = this.transcript.filter((t) => t.kind === 'child_passage').length;
    await this.narrate(
      'CLOSING',
      `Say goodbye warmly in two sentences. The story is paused, not finished — tell them you will ` +
        `pick it up next time. They read ${passages} passage(s) today. Reason for ending: ${reason}.`,
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

/**
 * Best guess at the name inside "um, my name is Maya".
 *
 * Only ever a suggestion — a grown-up confirms the spelling before it is
 * written down, because this string ends up in every story she ever reads and
 * speech recognition on a five-year-old saying her own name is a coin flip.
 */
export function guessName(transcript: string | null): string | null {
  if (!transcript) return null;

  const stripped = transcript
    .replace(/^\W+/, '')
    .replace(/^(um+|uh+|hi|hello|hey|well)\b[\s,]*/gi, '')
    .replace(/^(my name is|my name's|i am|i'm|im|it is|it's|its|call me)\b[\s,]*/gi, '');

  const first = stripped.match(/[A-Za-z][A-Za-z'-]*/);
  if (!first) return null;

  const name = first[0];
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}
