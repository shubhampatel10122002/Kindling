/** Shared domain + wire types. See PLAN.md §4, §6, §7, §13. */

export type Mode =
  | 'IDLE'
  | 'NARRATE'
  | 'CHILD_READS'
  | 'COACH'
  | 'ENCOURAGE'
  | 'TALK'
  | 'SOCRATIC'
  | 'REMIX'
  | 'ADAPT'
  | 'PAUSED'
  | 'END';

export type ErrorType =
  | 'None'
  | 'Mispronunciation'
  | 'Omission'
  | 'Insertion'
  | 'Timeout'
  | 'Developmental';

export type Intent =
  | 'help_with_word'
  | 'question_about_story_or_world'
  | 'change_request'
  | 'chitchat'
  | 'want_to_stop'
  | 'sensitive_topic'
  | 'unclear';

export interface SessionPlan {
  goal: string;
  target_skills: string[];
  premise: string;
  characters: string[];
  beats: string[];
  difficulty: number;
  vocab_constraints: {
    must_use_words: string[];
    max_sentence_words: number;
    allowed_patterns: string;
  };
}

export interface ChildMemory {
  interests: { topic: string; weight: number; last_seen: string }[];
  personality_notes: string;
  canon: {
    characters?: string[];
    past_summaries?: string[];
    open_threads?: string[];
  };
  version?: number;
}

export interface Child {
  id: string;
  name: string;
  age: number | null;
  onboarding_notes: string | null;
}

export interface Mastery {
  skill_id: string;
  p_mastery: number;
  last_practiced: string | null;
}

/** One word of the passage the child is currently reading. */
export interface TrackedWord {
  index: number;
  expected: string;
  /** Best accuracy seen across all attempts at this word (PLAN.md §9.4). */
  bestScore: number | null;
  errorType: ErrorType | null;
  attempts: number;
  status: 'pending' | 'current' | 'passed' | 'coaching' | 'given';
}

export interface TranscriptEntry {
  ts: string;
  kind: 'narrator' | 'child_passage' | 'child_talk' | 'mode' | 'coach' | 'system';
  text: string;
  meta?: Record<string, unknown>;
}

/** Per-word result handed from Azure to the state machine. */
export interface WordAssessment {
  word: string;
  accuracyScore: number;
  errorType: ErrorType;
  phonemes: {
    /** The phoneme the reference text expects. */
    phoneme: string;
    accuracyScore: number;
    /**
     * What Azure actually heard, best-first (from NBestPhonemes). Lets the
     * leniency table check the real substitution instead of assuming one.
     */
    actual?: string[];
  }[];
}

// ---------------------------------------------------------------------------
// WebSocket protocol.
// Client -> server binary frames are mic PCM16 @16k.
// Server -> client binary frames are TTS float32 PCM @44.1k.
// Everything else is JSON text.
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: 'start' }
  | { t: 'talk_start' }
  | { t: 'talk_end' }
  | { t: 'resume' }
  | { t: 'stop' }
  /** Speak a fixed line — verifies the audio path without involving the LLM. */
  | { t: 'tts_test' }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'ready'; childName: string; plan: SessionPlan }
  | { t: 'mode'; mode: Mode; reason?: string }
  | { t: 'speak'; text: string }
  | { t: 'passage'; text: string; words: string[] }
  | { t: 'word'; index: number; status: TrackedWord['status']; score: number | null; errorType: ErrorType | null }
  | { t: 'cursor'; index: number }
  | { t: 'tts_start' }
  | { t: 'tts_end' }
  | { t: 'talk_open' }
  | { t: 'talk_closed'; transcript: string | null; intent: Intent | null }
  | { t: 'nudge'; text: string }
  | { t: 'flag'; type: string; detail: string }
  | { t: 'debug'; key: string; value: unknown }
  | { t: 'error'; message: string }
  | { t: 'ended'; sessionId: string };
