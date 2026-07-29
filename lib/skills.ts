/** Hardcoded skill list + word→skill mapping. PLAN.md §3. Pure TS, no LLM. */

export interface Skill {
  id: string;
  description: string;
  examples: string[];
  prerequisites: string[];
}

export const SKILLS: Skill[] = [
  // --- short vowels -------------------------------------------------------
  { id: 'short_a', description: 'Short a as in cat', examples: ['cat', 'map', 'bat', 'hand'], prerequisites: [] },
  { id: 'short_e', description: 'Short e as in bed', examples: ['bed', 'red', 'test', 'went'], prerequisites: [] },
  { id: 'short_i', description: 'Short i as in sit', examples: ['sit', 'big', 'hill', 'this'], prerequisites: [] },
  { id: 'short_o', description: 'Short o as in dog', examples: ['dog', 'hop', 'lost', 'rock'], prerequisites: [] },
  { id: 'short_u', description: 'Short u as in cup', examples: ['cup', 'bug', 'jump', 'must'], prerequisites: [] },

  // --- consonant blends ---------------------------------------------------
  { id: 'blend_bl', description: 'bl blend', examples: ['blue', 'black', 'block'], prerequisites: ['short_a'] },
  { id: 'blend_cl', description: 'cl blend', examples: ['clap', 'clock', 'climb'], prerequisites: ['short_a'] },
  { id: 'blend_fl', description: 'fl blend', examples: ['flag', 'fly', 'flat'], prerequisites: ['short_a'] },
  { id: 'blend_gl', description: 'gl blend', examples: ['glad', 'glow', 'glass'], prerequisites: ['short_a'] },
  { id: 'blend_pl', description: 'pl blend', examples: ['play', 'plan', 'plum'], prerequisites: ['short_a'] },
  { id: 'blend_sl', description: 'sl blend', examples: ['slid', 'slow', 'sleep'], prerequisites: ['short_i'] },
  { id: 'blend_br', description: 'br blend', examples: ['bridge', 'brown', 'brave'], prerequisites: ['short_i'] },
  { id: 'blend_cr', description: 'cr blend', examples: ['crab', 'cry', 'crown'], prerequisites: ['short_a'] },
  { id: 'blend_dr', description: 'dr blend', examples: ['dragon', 'drum', 'dress'], prerequisites: ['short_u'] },
  { id: 'blend_tr', description: 'tr blend', examples: ['tree', 'truck', 'trap'], prerequisites: ['short_u'] },
  { id: 'blend_st', description: 'st blend', examples: ['stop', 'star', 'stand'], prerequisites: ['short_o'] },
  { id: 'blend_sn', description: 'sn blend', examples: ['snow', 'snap', 'snail'], prerequisites: ['short_a'] },

  // --- digraphs -----------------------------------------------------------
  { id: 'digraph_sh', description: 'sh digraph', examples: ['ship', 'shop', 'wish'], prerequisites: ['short_i'] },
  { id: 'digraph_ch', description: 'ch digraph', examples: ['chip', 'chair', 'much'], prerequisites: ['short_i'] },
  { id: 'digraph_th', description: 'th digraph', examples: ['this', 'that', 'with'], prerequisites: ['short_i'] },
  { id: 'digraph_wh', description: 'wh digraph', examples: ['when', 'what', 'whale'], prerequisites: ['short_e'] },

  // --- sight words (20) ---------------------------------------------------
  ...(
    [
      'the', 'and', 'you', 'was', 'said', 'they', 'have', 'friend', 'because',
      'little', 'because', 'want', 'come', 'from', 'were', 'there', 'what',
      'some', 'would', 'could', 'people', 'again',
    ]
      .filter((w, i, a) => a.indexOf(w) === i)
      .slice(0, 20)
      .map((w) => ({
        id: `sight_${w}`,
        description: `Sight word "${w}"`,
        examples: [w],
        prerequisites: [] as string[],
      }))
  ),
];

export const SKILL_BY_ID = new Map(SKILLS.map((s) => [s.id, s]));

const SIGHT_WORDS = new Set(
  SKILLS.filter((s) => s.id.startsWith('sight_')).map((s) => s.id.slice('sight_'.length)),
);

const BLENDS = ['bl', 'cl', 'fl', 'gl', 'pl', 'sl', 'br', 'cr', 'dr', 'tr', 'st', 'sn'];
const DIGRAPHS = ['sh', 'ch', 'th', 'wh'];

export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, '');
}

/**
 * Which skills does reading this word exercise? Deliberately coarse — this is a
 * heuristic mapping, not a phonics engine.
 */
export function skillsForWord(rawWord: string): string[] {
  const w = normalizeWord(rawWord);
  if (!w) return [];
  const out = new Set<string>();

  if (SIGHT_WORDS.has(w)) out.add(`sight_${w}`);

  for (const d of DIGRAPHS) {
    if (w.includes(d)) out.add(`digraph_${d}`);
  }
  for (const b of BLENDS) {
    // Blends count at the start of the word or right after a vowel (e.g. "apple"->no, "bridge"->br).
    if (w.startsWith(b)) out.add(`blend_${b}`);
  }

  // Short vowel: CVC-ish pattern with a single vowel not followed by a silent e.
  const vowels = w.match(/[aeiou]/g) ?? [];
  if (vowels.length === 1 && !/[aeiou][a-z]?e$/.test(w) && w.length <= 6) {
    out.add(`short_${vowels[0]}`);
  }

  return [...out].filter((id) => SKILL_BY_ID.has(id));
}

/** Human-friendly skill labels for the debug panel. */
export function describeSkill(id: string): string {
  return SKILL_BY_ID.get(id)?.description ?? id;
}
