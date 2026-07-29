/**
 * Mic capture worklet. Downsamples the AudioContext rate to 16kHz mono and
 * emits 16-bit PCM frames for Azure. PLAN.md §8.1.
 *
 * Also reports an RMS level so the mic-check screen can show a live meter, and
 * honours a `mute` message so the client can pause capture while the narrator
 * is speaking (belt and suspenders — the server gate is authoritative).
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetSampleRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.cursor = 0;
    this.lastSample = 0;
    this.out = [];
    this.frameSize = 640; // 40ms at 16kHz
    this.muted = false;
    this.levelCounter = 0;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'mute') {
        this.muted = !!e.data.value;
        if (this.muted) this.out.length = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch || ch.length === 0) return true;

    // Level meter runs even while muted so the mic check can't be fooled.
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    if (++this.levelCounter % 4 === 0) {
      this.port.postMessage({ type: 'level', value: rms });
    }

    if (this.muted) {
      this.cursor = 0;
      return true;
    }

    // Linear-interpolating resample with a cursor that survives block boundaries.
    let i = this.cursor;
    while (i < ch.length) {
      const idx = Math.floor(i);
      const frac = i - idx;
      const a = idx === 0 ? this.lastSample : ch[idx - 1];
      const b = ch[idx];
      this.out.push(a + (b - a) * frac);
      i += this.ratio;
    }
    this.cursor = i - ch.length;
    this.lastSample = ch[ch.length - 1];

    while (this.out.length >= this.frameSize) {
      const chunk = this.out.splice(0, this.frameSize);
      const pcm = new Int16Array(chunk.length);
      for (let n = 0; n < chunk.length; n++) {
        const s = Math.max(-1, Math.min(1, chunk[n]));
        pcm[n] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ type: 'audio', buffer: pcm.buffer }, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
