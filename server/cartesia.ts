import WebSocket from 'ws';
import { env, AUDIO } from '../lib/env';

/**
 * Cartesia streaming TTS over the raw WebSocket endpoint.
 *
 * Verified against the current Cartesia API reference rather than the npm SDK:
 * the published @cartesia/cartesia-js pins Cartesia-Version 2024-06-10, which
 * predates the sonic-3 model family. Talking to the socket directly also gives
 * us per-context cancel, which is what makes talk-button barge-in instant.
 *
 * Output is raw float32 little-endian PCM at 44.1kHz — exactly what the browser
 * Web Audio path wants, with no client-side decode step.
 */

const RECONNECT_DELAY_MS = 500;

type CartesiaIn =
  | { type: 'chunk'; data: string; context_id?: string }
  | { type: 'done'; context_id?: string }
  | { type: 'error'; error?: string; message?: string; context_id?: string }
  | { type: string; [k: string]: unknown };

export interface SpeakHandle {
  /** Resolves when the full utterance has been streamed (or was cancelled). */
  done: Promise<void>;
  /** Stop this utterance immediately — used for barge-in. */
  cancel: () => void;
}

export class CartesiaTTS {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private contextSeq = 0;
  private active = new Map<
    string,
    { onChunk: (pcm: Buffer) => void; resolve: () => void; cancelled: boolean }
  >();

  private url() {
    const u = new URL('wss://api.cartesia.ai/tts/websocket');
    u.searchParams.set('cartesia_version', env.cartesiaVersion);
    u.searchParams.set('api_key', env.cartesiaKey);
    return u.toString();
  }

  private async connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.url());

      ws.on('open', () => {
        this.ws = ws;
        this.connecting = null;
        resolve(ws);
      });

      ws.on('message', (raw) => this.onMessage(raw));

      ws.on('error', (err) => {
        this.connecting = null;
        this.failAll(`cartesia socket error: ${err.message}`);
        reject(err);
      });

      ws.on('close', () => {
        this.ws = null;
        this.connecting = null;
        this.failAll('cartesia socket closed');
      });
    });

    return this.connecting;
  }

  private onMessage(raw: WebSocket.RawData) {
    let msg: CartesiaIn;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const ctx = typeof msg.context_id === 'string' ? msg.context_id : undefined;
    const entry = ctx ? this.active.get(ctx) : undefined;
    if (!entry) return;

    if (msg.type === 'chunk' && typeof (msg as any).data === 'string') {
      if (entry.cancelled) return;
      entry.onChunk(Buffer.from((msg as any).data, 'base64'));
      return;
    }
    if (msg.type === 'done') {
      this.active.delete(ctx!);
      entry.resolve();
      return;
    }
    if (msg.type === 'error') {
      console.error('[cartesia] error', (msg as any).error ?? (msg as any).message);
      this.active.delete(ctx!);
      entry.resolve();
    }
  }

  private failAll(reason: string) {
    if (this.active.size) console.error('[cartesia]', reason);
    for (const [, entry] of this.active) entry.resolve();
    this.active.clear();
  }

  /**
   * Stream one utterance. Chunks are delivered to onChunk as raw float32 PCM
   * buffers as they arrive — the caller forwards them straight to the browser.
   */
  speak(text: string, onChunk: (pcm: Buffer) => void): SpeakHandle {
    const contextId = `primer-${Date.now()}-${this.contextSeq++}`;
    let cancelled = false;

    const done = (async () => {
      let ws: WebSocket;
      try {
        ws = await this.connect();
      } catch (err) {
        console.error('[cartesia] connect failed', err);
        return;
      }
      if (cancelled) return;

      const finished = new Promise<void>((resolve) => {
        this.active.set(contextId, { onChunk, resolve, cancelled: false });
      });

      ws.send(
        JSON.stringify({
          model_id: env.cartesiaModel,
          transcript: text,
          voice: { mode: 'id', id: env.cartesiaVoiceId },
          output_format: {
            container: 'raw',
            encoding: 'pcm_f32le',
            sample_rate: AUDIO.ttsSampleRate,
          },
          language: 'en',
          context_id: contextId,
          continue: false,
        }),
      );

      await finished;
    })();

    return {
      done,
      cancel: () => {
        cancelled = true;
        const entry = this.active.get(contextId);
        if (entry) {
          entry.cancelled = true;
          this.active.delete(contextId);
          entry.resolve();
        }
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ context_id: contextId, cancel: true }));
        }
      },
    };
  }

  close() {
    this.failAll('shutting down');
    this.ws?.close();
    this.ws = null;
  }
}

/** Shared instance — one socket serves the whole process. */
let shared: CartesiaTTS | null = null;
export function tts(): CartesiaTTS {
  if (!shared) shared = new CartesiaTTS();
  return shared;
}

/** One-shot connectivity check used by scripts/smoke.ts. */
export async function checkCartesia(): Promise<number> {
  const client = new CartesiaTTS();
  let bytes = 0;
  const handle = client.speak('Hello! Ready to read?', (pcm) => {
    bytes += pcm.length;
  });
  await Promise.race([
    handle.done,
    new Promise((r) => setTimeout(r, 15_000)),
  ]);
  client.close();
  if (bytes === 0) throw new Error('Cartesia returned no audio — check key, voice id, and model.');
  return bytes;
}

/** Retry once with the previous model id if the configured one is rejected. */
export { RECONNECT_DELAY_MS };
