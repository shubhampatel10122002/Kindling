'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine } from '@/lib/client/audio';
import MicCheck from './MicCheck';
import PassageView, { type WordState } from './PassageView';
import TalkButton from './TalkButton';
import DebugPanel from './DebugPanel';
import type { Intent, Mode, ServerMessage, SessionPlan } from '@/lib/types';

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ??
  (typeof window !== 'undefined'
    ? `ws://${window.location.hostname}:3001/session`
    : 'ws://localhost:3001/session');

export default function SessionView() {
  const [micReady, setMicReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState<Mode>('IDLE');
  const [narratorText, setNarratorText] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [words, setWords] = useState<WordState[]>([]);
  const [cursor, setCursor] = useState(0);
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [debug, setDebug] = useState<Record<string, unknown>>({});
  const [lastIntent, setLastIntent] = useState<{ transcript: string; intent: Intent | null } | null>(
    null,
  );
  const [transcript, setTranscript] = useState<{ kind: string; text: string }[]>([]);
  const [flags, setFlags] = useState<{ type: string; detail: string }[]>([]);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  /** What she has told Ollie this session, so she can see it was kept. */
  const [notebook, setNotebook] = useState<{ kind: string; subject: string }[]>([]);
  const [needName, setNeedName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  /** Connected, but the server never started the session. Says so, rather than spinning. */
  const [stalled, setStalled] = useState(false);
  /** Bytes of TTS audio this browser actually received for the current utterance. */
  const [audioBytes, setAudioBytes] = useState(0);

  const engineRef = useRef<AudioEngine | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const gateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Caption updates waiting for the previous utterance to finish playing. */
  const captionTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  /**
   * Apply a caption change only once the audio already queued has played out.
   *
   * A `speak` message arrives just *before* its own audio streams, so whatever is
   * still queued at that moment is precisely the tail of the previous utterance.
   * Delaying by that much keeps text and voice roughly together without needing
   * word-level timing.
   */
  const afterCurrentAudio = useCallback((fn: () => void) => {
    const delay = engineRef.current?.playbackRemainingMs() ?? 0;
    if (delay < 120) {
      fn();
      return;
    }
    const timer = setTimeout(() => {
      captionTimers.current = captionTimers.current.filter((t) => t !== timer);
      fn();
    }, delay);
    captionTimers.current.push(timer);
  }, []);

  /** Barge-in and teardown must not leave stale captions queued. */
  const flushCaptions = useCallback(() => {
    for (const t of captionTimers.current) clearTimeout(t);
    captionTimers.current = [];
  }, []);

  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.t) {
      case 'ready':
        setPlan(msg.plan);
        break;

      case 'mode':
        setMode(msg.mode);
        break;

      case 'speak':
        // Hold the caption until the previous utterance has finished out loud.
        afterCurrentAudio(() => setNarratorText(msg.text));
        setTranscript((t) => [...t, { kind: 'narrator', text: msg.text }]);
        break;

      case 'passage':
        // The server sends this once it has finished *sending* audio, which is
        // before the browser has finished playing it. Same treatment.
        afterCurrentAudio(() => {
          setWords(msg.words.map((w) => ({ word: w, status: 'pending', score: null })));
          setCursor(0);
        });
        setTranscript((t) => [...t, { kind: 'passage', text: msg.text }]);
        break;

      case 'word':
        setWords((ws) =>
          ws.map((w, i) => (i === msg.index ? { ...w, status: msg.status, score: msg.score } : w)),
        );
        break;

      case 'cursor':
        setCursor(msg.index);
        // The authoritative cursor also cleans up: anything still showing as
        // provisionally-heard from here on was never confirmed by a real score,
        // so it goes back to unread rather than sitting half-lit forever.
        setWords((ws) =>
          ws.map((w, i) => (i >= msg.index && w.status === 'reading' ? { ...w, status: 'pending' } : w)),
        );
        break;

      case 'heard':
        // Provisional, from Azure's interim hypothesis. No score, no decisions —
        // it just keeps the highlight with her voice instead of a second behind.
        setWords((ws) =>
          ws.map((w, i) => (i <= msg.index && w.status === 'pending' ? { ...w, status: 'reading' } : w)),
        );
        setCursor(msg.index + 1);
        break;

      case 'note':
        setNotebook((n) => [{ kind: msg.kind, subject: msg.subject }, ...n]);
        break;

      case 'need_name':
        setNameDraft(msg.heard ?? '');
        setNeedName(true);
        break;

      case 'tts_start':
        setSpeaking(true);
        setAudioBytes(0);
        // Belt and suspenders: pause capture client-side too. PLAN.md §8.2
        engineRef.current?.setMuted(true);
        if (gateTimer.current) clearTimeout(gateTimer.current);
        break;

      case 'tts_end':
        setSpeaking(false);
        // Reopen 300ms after playback ends, to swallow the speaker tail.
        if (gateTimer.current) clearTimeout(gateTimer.current);
        gateTimer.current = setTimeout(() => engineRef.current?.setMuted(false), 300);
        break;

      case 'talk_open':
        setListening(true);
        break;

      case 'talk_closed':
        setListening(false);
        if (msg.transcript) {
          setLastIntent({ transcript: msg.transcript, intent: msg.intent });
          setTranscript((t) => [
            ...t,
            { kind: `child · ${msg.intent ?? 'unknown'}`, text: msg.transcript! },
          ]);
        }
        break;

      case 'flag':
        setFlags((f) => [{ type: msg.type, detail: msg.detail }, ...f]);
        break;

      case 'debug':
        setDebug((d) => ({ ...d, [msg.key]: msg.value }));
        if (msg.key === 'plan') setPlan(msg.value as SessionPlan);
        break;

      case 'nudge':
        setTranscript((t) => [...t, { kind: 'nudge', text: msg.text }]);
        break;

      case 'error':
        setError(msg.message);
        break;

      case 'ended':
        setEnded(true);
        setMode('END');
        break;
    }
    // afterCurrentAudio is stable, but declare it: an empty dep array here is
    // exactly the stale-closure shape that silently broke audio once already.
  }, [afterCurrentAudio]);

  const connect = useCallback(
    (engine: AudioEngine) => {
      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        engine.onAudioFrame = (pcm) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
        };
        // The server's clock is not the child's. How the session opens depends on
        // what time it is where she is, so she tells it.
        ws.send(JSON.stringify({ t: 'start', localHour: new Date().getHours() }));
      };

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          setAudioBytes((n) => n + (e.data as ArrayBuffer).byteLength);
          engine.playChunk(e.data);
          return;
        }
        try {
          handleServerMessage(JSON.parse(e.data) as ServerMessage);
        } catch {
          /* ignore malformed frame */
        }
      };

      ws.onclose = () => setConnected(false);
      ws.onerror = () =>
        setError('Could not reach the session server. Is `npm run ws` running on port 3001?');
    },
    [handleServerMessage],
  );

  function onMicReady(engine: AudioEngine) {
    engineRef.current = engine;
    setMicReady(true);
    connect(engine);
  }

  const send = (msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  function pressTalk() {
    // Barge-in: kill local playback the instant the button goes down, and drop
    // any caption still waiting on audio that will now never play.
    flushCaptions();
    engineRef.current?.stopPlayback();
    engineRef.current?.setMuted(false);
    setSpeaking(false);
    setListening(true);
    send({ t: 'talk_start' });
  }

  function releaseTalk() {
    if (!listening) return;
    setListening(false);
    send({ t: 'talk_end' });
  }

  /**
   * The session should leave IDLE within a moment of connecting. If it does not,
   * something upstream is wrong and an endless "Ollie is thinking…" is the least
   * useful thing we could show — it looks identical to working correctly.
   */
  useEffect(() => {
    if (!connected || mode !== 'IDLE') {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), 10_000);
    return () => clearTimeout(timer);
  }, [connected, mode]);

  useEffect(() => {
    return () => {
      if (gateTimer.current) clearTimeout(gateTimer.current);
      flushCaptions();
      wsRef.current?.close();
      void engineRef.current?.destroy();
    };
  }, [flushCaptions]);

  if (!micReady) return <MicCheck onReady={onMicReady} />;

  return (
    <div className="shell">
      <main className="stage">
        <header className="header">
          <div className="logo">Primer</div>
          <div className="mode-pill" data-mode={mode}>
            {mode.replace('_', ' ')}
          </div>
          <div className="status-line">
            {!connected
              ? 'connecting…'
              : speaking
                ? 'Ollie is speaking…'
                : ended
                  ? 'all done'
                  : mode === 'IDLE'
                    ? 'waking Ollie up…'
                      : mode === 'CHILD_READS'
                      ? 'listening to you'
                      : mode === 'TALK' || mode === 'DOORWAY' || mode === 'ONBOARDING'
                        ? 'listening…'
                        : mode === 'WRAP'
                          ? 'one more?'
                          : mode === 'PAUSED'
                            ? 'paused'
                            : // NARRATE / COACH / REMIX / ADAPT between utterances
                              // all mean one thing: waiting on the LLM.
                              'Ollie is thinking…'}
          </div>
        </header>

        {error && (
          <div className="miccheck-error" style={{ marginBottom: 20 }}>
            <h3>Something went wrong</h3>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{error}</p>
          </div>
        )}

        {stalled && !error && (
          <div className="miccheck-error" style={{ marginBottom: 20 }}>
            <h3>Ollie hasn&rsquo;t woken up</h3>
            <p style={{ margin: 0 }}>
              The connection is open but the session never started. Check the terminal running{' '}
              <b>npm run dev</b> — the session server logs the reason there. Reloading this page
              usually fixes it.
            </p>
          </div>
        )}

        <div className={`narrator${speaking ? ' speaking' : ''}`}>
          <span className="owl-mini">🦉</span>
          <span>{narratorText || 'Getting your story ready…'}</span>
        </div>

        {needName ? (
          <div>
            <div className="passage-label">What&rsquo;s your name?</div>
            <p className="empty-passage">
              Grown-ups: check the spelling. Ollie uses this name in every story.
            </p>
            <form
              className="name-card"
              onSubmit={(e) => {
                e.preventDefault();
                const name = nameDraft.trim();
                if (!name) return;
                send({ t: 'onboard_name', name });
                setNeedName(false);
              }}
            >
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Type your name"
                aria-label="Child's name"
              />
              <button className="btn btn-primary" type="submit" disabled={!nameDraft.trim()}>
                That&rsquo;s me!
              </button>
            </form>
          </div>
        ) : mode === 'DOORWAY' ? (
          <div>
            <div className="passage-label">Tell Ollie anything</div>
            <p className="empty-passage">
              {listening ? 'Ollie is listening…' : 'Ollie is thinking about what you said…'}
            </p>
            <button className="btn" onClick={() => send({ t: 'doorway_done' })}>
              Let&rsquo;s just read
            </button>
          </div>
        ) : mode === 'WRAP' ? (
          <div>
            <div className="passage-label">One more bit?</div>
            <p className="empty-passage">{narratorText}</p>
            <div className="choice-row">
              <button
                className="btn btn-primary"
                onClick={() => send({ t: 'wrap_answer', more: true })}
              >
                Yes, one more!
              </button>
              <button className="btn" onClick={() => send({ t: 'wrap_answer', more: false })}>
                That&rsquo;s enough for today
              </button>
            </div>
          </div>
        ) : mode === 'PAUSED' ? (
          <div>
            <div className="passage-label">Paused</div>
            <p className="empty-passage">Ollie is waiting for you.</p>
            <button className="btn btn-primary" onClick={() => send({ t: 'resume' })}>
              I&rsquo;m back!
            </button>
          </div>
        ) : ended ? (
          <div>
            <div className="passage-label">All done</div>
            <p className="empty-passage">
              Great reading today! Hit <b>Consolidate memory</b> to see what Ollie learned.
            </p>
          </div>
        ) : (
          <>
            <div className="passage-label">Your turn to read</div>
            <PassageView words={words} cursor={cursor} />
          </>
        )}

        {notebook.length > 0 && (
          // She sees what she told Ollie land somewhere. The ones that do not
          // turn up in today's story are visibly queued, not quietly dropped.
          <div className="notebook">
            <div className="notebook-title">Ollie&rsquo;s notebook</div>
            <ul>
              {notebook.map((n, i) => (
                <li key={i}>{n.subject}</li>
              ))}
            </ul>
          </div>
        )}

        <TalkButton
          listening={listening}
          // In these modes Ollie is already listening with the mic open, so the
          // owl has nothing to do — pressing it would open a second recognizer.
          disabled={
            !connected || ended || mode === 'DOORWAY' || mode === 'WRAP' || mode === 'ONBOARDING'
          }
          onPress={pressTalk}
          onRelease={releaseTalk}
        />
      </main>

      <DebugPanel
        mode={mode}
        plan={plan}
        debug={debug}
        lastIntent={lastIntent}
        transcript={transcript}
        liveFlags={flags}
        audioBytes={audioBytes}
        onTtsTest={() => send({ t: 'tts_test' })}
        connected={connected}
      />
    </div>
  );
}
