import 'dotenv/config';
import { config } from 'dotenv';

// Next.js loads .env.local itself; the standalone WS server and scripts do not.
config({ path: '.env.local', override: false, quiet: true });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env.local.`);
  return v;
}

export const env = {
  get anthropicKey() {
    return required('ANTHROPIC_API_KEY');
  },
  get azureKey() {
    return required('AZURE_SPEECH_KEY');
  },
  get azureRegion() {
    return process.env.AZURE_SPEECH_REGION || 'eastus';
  },
  get cartesiaKey() {
    return required('CARTESIA_API_KEY');
  },
  get cartesiaVoiceId() {
    return required('CARTESIA_VOICE_ID');
  },
  get cartesiaModel() {
    return process.env.CARTESIA_MODEL || 'sonic-3';
  },
  get cartesiaVersion() {
    return process.env.CARTESIA_VERSION || '2026-03-01';
  },
  get databaseUrl() {
    return process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/primer';
  },
  get wsPort() {
    return Number(process.env.WS_PORT || 3001);
  },
};

/** Models. Sonnet for anything the child hears; Haiku for classification + safety. */
export const MODELS = {
  narrator: 'claude-sonnet-5',
  planner: 'claude-sonnet-5',
  consolidate: 'claude-sonnet-5',
  intent: 'claude-haiku-4-5',
  safety: 'claude-haiku-4-5',
} as const;

/** Audio constants. Mic is 16k mono PCM16 (Azure); TTS is 44.1k mono f32 (Web Audio). */
export const AUDIO = {
  micSampleRate: 16000,
  ttsSampleRate: 44100,
  /** Keep the mic gate closed this long after playback ends, to swallow the speaker tail. */
  gateTailMs: 300,
} as const;
