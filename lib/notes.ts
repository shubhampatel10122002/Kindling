/**
 * The notebook: what the child volunteered, and when it is allowed to surface.
 *
 * Three speeds, and the delay is the point (see the behavioral spec):
 *   1. Immediately — Ollie acknowledges it and says he is keeping it. No action.
 *   2. Later this session — at most ONE detail returns as background scenery.
 *   3. Next session — a detail or a question becomes what the story is about.
 *
 * Instant rewriting teaches a child that interrupting reshapes the world, which
 * is more fun than reading and will replace it. The caps below are the whole
 * quality control: they are small integers rather than a scoring model, because
 * a small integer cannot fail in an interesting way.
 */

import type { ChildNote } from './types';

/** One cameo per session. A second one stops feeling like the world noticing her. */
export const MAX_CAMEOS_PER_SESSION = 1;

/** How many kept details a single session plan may be built from. */
export const MAX_SUBJECTS_PER_PLAN = 2;

/** A cameo needs something you can picture. Moods and questions are neither. */
const CAMEO_KINDS = new Set(['event', 'interest', 'person']);

/**
 * The detail that should appear as background scenery in the next passage, or
 * null if nothing qualifies or the session has already had its one cameo.
 *
 * Prefers what she said most recently: the promise Ollie made two minutes ago is
 * the one she is still holding him to.
 */
export function pickCameo(queued: ChildNote[], cameosUsed: number): ChildNote | null {
  if (cameosUsed >= MAX_CAMEOS_PER_SESSION) return null;

  const eligible = queued.filter((n) => n.status === 'queued' && CAMEO_KINDS.has(n.kind));
  if (eligible.length === 0) return null;

  return eligible.slice().sort((a, b) => b.id - a.id)[0];
}

/**
 * What the next session's story should be built from: up to two kept details,
 * plus the newest unanswered question from the jar.
 *
 * The question is the retention loop — she asked "why is the sky blue?", Ollie
 * said "let's find out", and tomorrow's story is someone climbing up to see. The
 * newest one wins because it is the one still alive in her head; older ones stay
 * queued rather than being dropped.
 */
export function pickPlanNotes(queued: ChildNote[]): {
  material: ChildNote[];
  question: ChildNote | null;
} {
  const open = queued.filter((n) => n.status !== 'used');

  const question = open
    .filter((n) => n.kind === 'question')
    .slice()
    .sort((a, b) => b.id - a.id)[0] ?? null;

  const seen = new Set<string>();
  const material = open
    .filter((n) => n.kind !== 'question' && n.kind !== 'mood')
    .slice()
    // Heaviest first, and among equals the most recent.
    .sort((a, b) => b.weight - a.weight || b.id - a.id)
    // She mentions the same thing across sessions, so the same subject can be
    // queued twice. "Build the story around a loose tooth, and also a loose
    // tooth" wastes one of only two slots.
    .filter((n) => {
      const key = n.subject.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SUBJECTS_PER_PLAN);

  return { material, question };
}

/**
 * One naming rule: things personal to her are absorbed literally (her cat, her
 * sister, her tooth), while brands, public figures, and known characters are
 * generalized into their category. The classifier is asked to do this, and this
 * is the backstop for the handful it will still let through.
 */
const KNOWN_IP = new Map<RegExp, string>([
  [/\belsa\b|\bfrozen\b|\banna\b(?!\s)/i, 'a snow queen'],
  [/\bpokemon\b|\bpikachu\b/i, 'a pocket monster'],
  [/\bspider[- ]?man\b|\bbatman\b|\bsuperman\b|\bhulk\b/i, 'a superhero'],
  [/\bpaw patrol\b|\bbluey\b|\bpeppa\b/i, 'a cartoon dog'],
  [/\bminecraft\b|\broblox\b|\bfortnite\b/i, 'a building game'],
  [/\bbarbie\b/i, 'a doll'],
  [/\bmickey\b|\bdisney\b/i, 'a cartoon mouse'],
  [/\bstar wars\b|\bdarth\b/i, 'a space knight'],
  [/\btaylor swift\b|\bmrbeast\b|\bronaldo\b|\bmessi\b/i, 'someone famous'],
]);

export function generalizeSubject(subject: string): string {
  for (const [pattern, replacement] of KNOWN_IP) {
    if (pattern.test(subject)) return replacement;
  }
  return subject;
}
