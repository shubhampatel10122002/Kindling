/** Shared domain + wire types. See PLAN.md §4, §6, §7, §13. */

export type Mode =
  | 'IDLE'
  /** Voice onboarding for a child we have never met. */
  | 'ONBOARDING'
  /** The doorway before the story: Ollie asks, the child talks, nothing is discussed. */
  | 'DOORWAY'
  | 'NARRATE'
  | 'CHILD_READS'
  | 'COACH'
  | 'ENCOURAGE'
  | 'TALK'
  | 'REMIX'
  | 'ADAPT'
  | 'PAUSED'
  /** Cliffhanger delivered; listening for "one more bit?". */
  | 'WRAP'
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
  /** About the story in front of her — answered now, inside the story. */
  | 'question_about_story'
  /** Curiosity about the world — goes in the question jar, answered by a future story. */
  | 'question_about_world'
  | 'change_request'
  | 'chitchat'
  | 'want_to_stop'
  | 'sensitive_topic'
  | 'unclear';

/** What kind of thing the child volunteered. Drives how a note is reused later. */
export type NoteKind = 'event' | 'interest' | 'question' | 'person' | 'mood';

export type NoteStatus = 'queued' | 'cameo' | 'used';

/** One thing the child told us, kept for a later story. See db/schema.sql. */
export interface ChildNote {
  id: number;
  kind: NoteKind;
  /** Short noun phrase, generalized if it named a brand or a public figure. */
  subject: string;
  /** What she actually said. */
  detail: string | null;
  weight: number;
  status: NoteStatus;
  ts?: string;
}

/** Mood is absorbed, never discussed: it only moves two deterministic knobs. */
export type Mood = 'tired' | 'sad' | 'excited';

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
  /** localHour is the child's clock, not the server's — it picks the opening. */
  | { t: 'start'; localHour?: number }
  | { t: 'talk_start' }
  | { t: 'talk_end' }
  /** Typed fallback for the one thing STT must not get wrong: her name. */
  | { t: 'onboard_name'; name: string }
  /** "Start reading" — closes the doorway early. */
  | { t: 'doorway_done' }
  /** Answer to "want one more bit?", by button rather than by voice. */
  | { t: 'wrap_answer'; more: boolean }
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
  /**
   * Provisional: Azure's interim hypothesis suggests she has just said this word.
   * Carries no score and never decides anything — it exists so the highlight
   * moves while she is still speaking, instead of a second later.
   */
  | { t: 'heard'; index: number }
  /** Something she told us went in the notebook. Shown so she sees it was kept. */
  | { t: 'note'; kind: NoteKind; subject: string }
  /** Ollie needs her name typed, because STT and five-year-olds disagree. */
  | { t: 'need_name'; heard: string | null }
  | { t: 'tts_start' }
  | { t: 'tts_end' }
  | { t: 'talk_open' }
  | { t: 'talk_closed'; transcript: string | null; intent: Intent | null }
  | { t: 'nudge'; text: string }
  | { t: 'flag'; type: string; detail: string }
  | { t: 'debug'; key: string; value: unknown }
  | { t: 'error'; message: string }
  | { t: 'ended'; sessionId: string };
