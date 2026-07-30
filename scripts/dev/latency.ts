import { generateObject } from 'ai';
import { z } from 'zod';
import { anthropic } from '../../lib/llm/client';
import { MODELS } from '../../lib/env';

const schema = z.object({ speak_text: z.string(), child_passage: z.string().nullable() });
const prompt = 'Tell the next beat of a story about a dragon named Blue in 2-3 short spoken sentences, then give a 1-sentence passage a 5-year-old reads aloud (max 7 words).';

async function timed(label: string, model: any, extra: Record<string, unknown> = {}) {
  const t0 = Date.now();
  try {
    const r = await generateObject({ model, schema, prompt, ...extra });
    console.log(`${label.padEnd(38)} ${String(Date.now() - t0).padStart(6)}ms  in=${r.usage?.inputTokens} out=${r.usage?.outputTokens}`);
    return r.object;
  } catch (e: any) {
    console.log(`${label.padEnd(38)} FAILED: ${String(e.message).slice(0, 90)}`);
    return null;
  }
}

async function main() {
  const a = anthropic();
  const first = await timed('sonnet-5 default (adaptive on)', a(MODELS.narrator));
  await timed('sonnet-5 thinking disabled', a(MODELS.narrator), {
    providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
  });
  await timed('sonnet-4-6 (previous)', a('claude-sonnet-4-6'));
  await timed('haiku-4-5 (intent/safety)', a('claude-haiku-4-5'));
  if (first) console.log('\nsample speak_text:', first.speak_text);
}
main().catch(e => { console.error(e); process.exit(1); });
