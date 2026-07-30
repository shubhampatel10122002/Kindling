import { CartesiaTTS } from '@/server/cartesia';
import { AUDIO } from '@/lib/env';
import { floatPcmToWav } from '@/lib/wav';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Synthesize one line and return it as a WAV file.
 *
 * This exists purely to isolate layers when audio is not audible. It bypasses
 * the WebSocket, the AudioWorklet, and the Web Audio scheduling entirely — a
 * plain <audio src> can play it. If this is audible but the live session is not,
 * the fault is in the browser audio path, not in Cartesia or the credentials.
 */

export async function GET(req: Request) {
  const text =
    new URL(req.url).searchParams.get('text') ??
    'Hello! This is Ollie. If you can hear me, your sound is working.';

  const client = new CartesiaTTS();
  const chunks: Buffer[] = [];

  try {
    const handle = client.speak(text, (c) => chunks.push(c));
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 30_000))]);
  } finally {
    client.close();
  }

  const pcm = Buffer.concat(chunks);
  if (pcm.length === 0) {
    return Response.json(
      {
        error:
          'Cartesia returned no audio. Check CARTESIA_API_KEY, CARTESIA_VOICE_ID and ' +
          'CARTESIA_MODEL in .env.local, and whether the account hit its concurrency limit.',
      },
      { status: 502 },
    );
  }

  const wav = floatPcmToWav(pcm, AUDIO.ttsSampleRate);
  return new Response(new Uint8Array(wav), {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      'Cache-Control': 'no-store',
      'X-Pcm-Bytes': String(pcm.length),
    },
  });
}
