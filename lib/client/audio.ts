'use client';

/**
 * Browser audio pipeline. PLAN.md §8.
 *
 * Capture: getUserMedia -> AudioWorklet -> 16kHz PCM16 frames -> WebSocket.
 * Playback: float32 PCM chunks from the server -> Web Audio with a jitter buffer.
 * Half-duplex: the client pauses capture while the narrator speaks (the server
 * gate is authoritative; this is the belt-and-suspenders half).
 */

const TTS_SAMPLE_RATE = 44100;
const MIC_SAMPLE_RATE = 16000;
/** Buffer this much audio before starting playback, to survive network jitter. */
const JITTER_BUFFER_SEC = 0.12;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private playHead = 0;
  private scheduled: AudioBufferSourceNode[] = [];

  onAudioFrame: ((pcm: ArrayBuffer) => void) | null = null;
  onLevel: ((rms: number) => void) | null = null;

  get sampleRate() {
    return this.ctx?.sampleRate ?? 0;
  }

  async init(): Promise<void> {
    if (this.ctx) return;

    this.ctx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    if (this.ctx.sampleRate !== TTS_SAMPLE_RATE) {
      // The browser refused our requested rate. Playback still works (it
      // resamples), but flag it — it changes the maths if TTS ever sounds pitched.
      console.warn(
        `[audio] AudioContext runs at ${this.ctx.sampleRate}Hz, requested ${TTS_SAMPLE_RATE}Hz`,
      );
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    await this.ctx.audioWorklet.addModule('/worklets/capture-processor.js');

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { targetSampleRate: MIC_SAMPLE_RATE },
    });

    this.node.port.onmessage = (e) => {
      const data = e.data;
      if (data?.type === 'audio') this.onAudioFrame?.(data.buffer);
      else if (data?.type === 'level') this.onLevel?.(data.value);
    };

    this.source.connect(this.node);
  }

  /** Pause/resume capture. Called on tts_start / tts_end. */
  setMuted(muted: boolean) {
    this.node?.port.postMessage({ type: 'mute', value: muted });
  }

  /** Queue one float32 PCM chunk from the server for gapless playback. */
  playChunk(pcm: ArrayBuffer) {
    if (!this.ctx) return;

    // A backgrounded tab or an OS audio-device change can suspend the context
    // after it was unlocked. Scheduled sources then play into silence with no
    // error, which looks exactly like "the app is broken".
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }

    // Float32Array needs a 4-byte-aligned length; drop any ragged tail.
    const usable = pcm.byteLength - (pcm.byteLength % 4);
    if (usable <= 0) return;

    const samples = new Float32Array(pcm, 0, usable / 4);
    const buffer = this.ctx.createBuffer(1, samples.length, TTS_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (this.playHead < now + 0.01) {
      // Starting fresh (or we underran) — re-arm the jitter buffer.
      this.playHead = now + JITTER_BUFFER_SEC;
    }
    src.start(this.playHead);
    this.playHead += buffer.duration;

    this.scheduled.push(src);
    src.onended = () => {
      const i = this.scheduled.indexOf(src);
      if (i >= 0) this.scheduled.splice(i, 1);
    };
  }

  /** Barge-in: kill everything already scheduled, immediately. */
  stopPlayback() {
    for (const src of this.scheduled) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.scheduled = [];
    this.playHead = this.ctx?.currentTime ?? 0;
  }

  /** True while queued audio is still playing out. */
  get isPlaying() {
    return !!this.ctx && this.playHead > this.ctx.currentTime + 0.01;
  }

  async destroy() {
    this.stopPlayback();
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.source = null;
    this.stream = null;
  }
}
