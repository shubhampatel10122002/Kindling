'use client';

import { useRef, useState } from 'react';

/**
 * Audio isolation ladder. Four independent tests, each adding exactly one layer,
 * so a failure identifies its own cause instead of leaving "I can't hear
 * anything" to be guessed at.
 *
 *   1. Web Audio output          — a locally generated tone. No network.
 *   2. Cartesia over HTTP        — a WAV in a native <audio>. No Web Audio.
 *   3. Cartesia via Web Audio    — the WAV decoded and scheduled the way the
 *                                  session does it.
 *   4. The live session path     — WebSocket streaming into the real engine.
 *
 * The first test that fails is the layer at fault.
 */

type Status = 'idle' | 'running' | 'pass' | 'fail';

interface Row {
  status: Status;
  detail: string;
}

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ??
  (typeof window !== 'undefined'
    ? `ws://${window.location.hostname}:3001/session`
    : 'ws://localhost:3001/session');

export default function AudioTest() {
  const [rows, setRows] = useState<Record<string, Row>>({});
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const set = (key: string, status: Status, detail = '') =>
    setRows((r) => ({ ...r, [key]: { status, detail } }));

  // --- 1. Web Audio output, no network -------------------------------------
  async function testTone() {
    set('tone', 'running', 'playing a 440Hz beep for 1s…');
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.2;
      osc.frequency.value = 440;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      await new Promise((r) => setTimeout(r, 1000));
      osc.stop();
      const rate = ctx.sampleRate;
      await ctx.close();
      set('tone', 'pass', `AudioContext ran at ${rate}Hz. Did you hear a beep?`);
    } catch (err) {
      set('tone', 'fail', String((err as Error).message ?? err));
    }
  }

  // --- 2. Cartesia over plain HTTP, native <audio> --------------------------
  async function testWav() {
    set('wav', 'running', 'asking the server to synthesize a line…');
    try {
      const res = await fetch('/api/tts?text=' + encodeURIComponent('Hello! This is Ollie.'));
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        set('wav', 'fail', body.error ?? `server returned ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const el = audioRef.current!;
      el.src = url;
      await el.play();
      set('wav', 'pass', `${blob.size} byte WAV playing. Did you hear a voice?`);
    } catch (err) {
      set('wav', 'fail', String((err as Error).message ?? err));
    }
  }

  // --- 3. Cartesia through Web Audio ---------------------------------------
  async function testWebAudio() {
    set('webaudio', 'running', 'decoding and scheduling via Web Audio…');
    try {
      const res = await fetch('/api/tts?text=' + encodeURIComponent('Testing Web Audio playback.'));
      if (!res.ok) {
        set('webaudio', 'fail', `server returned ${res.status}`);
        return;
      }
      const bytes = await res.arrayBuffer();
      const ctx = new AudioContext({ sampleRate: 44100 });
      if (ctx.state === 'suspended') await ctx.resume();
      const buffer = await ctx.decodeAudioData(bytes);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start();
      set(
        'webaudio',
        'pass',
        `${buffer.duration.toFixed(2)}s decoded at ${ctx.sampleRate}Hz. Did you hear a voice?`,
      );
    } catch (err) {
      set('webaudio', 'fail', String((err as Error).message ?? err));
    }
  }

  // --- 4. The live session path -------------------------------------------
  async function testSession() {
    set('session', 'running', 'connecting to the session server…');
    try {
      const { AudioEngine } = await import('@/lib/client/audio');
      const engine = new AudioEngine();
      await engine.init();

      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      let received = 0;

      ws.onopen = () => set('session', 'running', 'connected, requesting a test line…');

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          received += e.data.byteLength;
          engine.playChunk(e.data);
          set('session', 'running', `streaming… ${received} bytes received`);
          return;
        }
        try {
          const msg = JSON.parse(e.data);
          if (msg.t === 'tts_end') {
            set(
              'session',
              received > 0 ? 'pass' : 'fail',
              received > 0
                ? `${received} bytes streamed and scheduled. Did you hear a voice?`
                : 'the server reported it finished speaking but sent no audio',
            );
            setTimeout(() => {
              ws.close();
              void engine.destroy();
            }, 6000);
          }
          if (msg.t === 'error') set('session', 'fail', msg.message);
        } catch {
          /* ignore */
        }
      };

      ws.onerror = () =>
        set('session', 'fail', 'WebSocket failed — is `npm run ws` running on port 3001?');

      // Wait for the session's own opening greeting to finish, then ask for the
      // fixed test line so the two do not queue behind each other.
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'tts_test' }));
      }, 1500);
    } catch (err) {
      set('session', 'fail', String((err as Error).message ?? err));
    }
  }

  const tests: { key: string; label: string; hint: string; run: () => void }[] = [
    {
      key: 'tone',
      label: '1. Web Audio output (no network)',
      hint: 'Proves the browser can make sound at all.',
      run: testTone,
    },
    {
      key: 'wav',
      label: '2. Cartesia over HTTP (native audio player)',
      hint: 'Proves Cartesia + your credentials work, with none of my audio code.',
      run: testWav,
    },
    {
      key: 'webaudio',
      label: '3. Cartesia through Web Audio',
      hint: 'Adds decoding and scheduling.',
      run: testWebAudio,
    },
    {
      key: 'session',
      label: '4. Live session path (WebSocket streaming)',
      hint: 'The real path the story uses.',
      run: testSession,
    },
  ];

  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: '48px 24px 80px' }}>
      <h1 style={{ fontSize: 32, marginBottom: 6 }}>Audio check</h1>
      <p className="muted" style={{ fontSize: 17, lineHeight: 1.5, marginTop: 0 }}>
        Run these in order with your volume up. The first one that fails — or that
        reports success but you cannot hear — is the layer at fault.
      </p>

      <audio ref={audioRef} controls style={{ width: '100%', margin: '16px 0 28px' }} />

      {tests.map((t) => {
        const row = rows[t.key] ?? { status: 'idle' as Status, detail: '' };
        const colour =
          row.status === 'pass'
            ? 'var(--good)'
            : row.status === 'fail'
              ? 'var(--bad)'
              : 'var(--muted)';
        return (
          <div
            key={t.key}
            style={{
              border: '1px solid var(--line)',
              borderLeft: `4px solid ${colour}`,
              borderRadius: 12,
              padding: '16px 18px',
              marginBottom: 12,
              background: 'var(--card)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <b style={{ flex: 1 }}>{t.label}</b>
              <button className="btn" onClick={t.run} disabled={row.status === 'running'}>
                {row.status === 'running' ? 'running…' : 'Play'}
              </button>
            </div>
            <div className="muted" style={{ fontSize: 14, marginTop: 6 }}>
              {t.hint}
            </div>
            {row.detail && (
              <div style={{ fontSize: 14, marginTop: 8, color: colour, fontWeight: 600 }}>
                {row.detail}
              </div>
            )}
          </div>
        );
      })}

      <div
        style={{
          marginTop: 26,
          padding: '16px 18px',
          border: '1px solid var(--line)',
          borderRadius: 12,
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        <b>Reading the result</b>
        <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          <li>
            <b>1 fails or is silent</b> — system output device, tab mute, or browser
            volume. Nothing to do with this app.
          </li>
          <li>
            <b>1 works, 2 fails</b> — Cartesia credentials or account limits. The error
            text will say which.
          </li>
          <li>
            <b>2 works, 3 fails</b> — Web Audio decoding in this browser.
          </li>
          <li>
            <b>3 works, 4 fails</b> — the WebSocket streaming path. Check the server log
            for <code>[tts]</code> lines and the browser console for <code>[audio]</code>.
          </li>
          <li>
            <b>All four work</b> — audio is fine; the problem is elsewhere in the session.
          </li>
        </ul>
      </div>
    </div>
  );
}
