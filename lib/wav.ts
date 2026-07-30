/**
 * Minimal WAV writer. Cartesia streams raw float32 LE PCM; a WAV wrapper makes
 * it playable by a plain <audio> element, which is what lets the audio-check
 * page isolate Cartesia from the Web Audio path.
 *
 * Emits 16-bit PCM rather than IEEE float: format 1 is the most broadly
 * supported container across browsers.
 */
export function floatPcmToWav(float32: Buffer, sampleRate: number): Buffer {
  const sampleCount = Math.floor(float32.byteLength / 4);
  const data = Buffer.alloc(sampleCount * 2);

  for (let i = 0; i < sampleCount; i++) {
    let s = float32.readFloatLE(i * 4);
    s = Math.max(-1, Math.min(1, s));
    data.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}
