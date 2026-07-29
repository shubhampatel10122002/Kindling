import { createAnthropic } from '@ai-sdk/anthropic';
import { env, MODELS } from '../env';

/**
 * Resolve the API base URL defensively.
 *
 * @ai-sdk/anthropic reads ANTHROPIC_BASE_URL and uses it verbatim. Machines with
 * Claude Code installed commonly export `ANTHROPIC_BASE_URL=https://api.anthropic.com`
 * (no `/v1`), which makes every request 404 against `/messages`. Normalising here
 * means the app works whether or not that variable is set.
 */
function baseURL(): string {
  const raw = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  return /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
}

let _anthropic: ReturnType<typeof createAnthropic> | null = null;

export function anthropic() {
  if (!_anthropic) {
    _anthropic = createAnthropic({ apiKey: env.anthropicKey, baseURL: baseURL() });
  }
  return _anthropic;
}

export const model = {
  narrator: () => anthropic()(MODELS.narrator),
  planner: () => anthropic()(MODELS.planner),
  consolidate: () => anthropic()(MODELS.consolidate),
  intent: () => anthropic()(MODELS.intent),
  safety: () => anthropic()(MODELS.safety),
};
