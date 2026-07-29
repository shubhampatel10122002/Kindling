import { Narrator } from '../../lib/llm/narrator';
const child = { id: 'x', name: 'Maya', age: 5, onboarding_notes: 'Loves dragons. Has a cat named Pepper.' };
const memory = { interests: [{ topic: 'dragons', weight: 1, last_seen: '' }], personality_notes: '', canon: { characters: ['Blue the dragon'] } };
const plan = { goal: 'practice short_e, blend_bl', target_skills: ['short_e','blend_bl','short_a'],
  premise: 'Maya and Blue the dragon look for the lost bell', characters: ['Blue the dragon','Maya'],
  beats: ['Maya finds a torn map','They cross the wobbly bridge','The bell is in the old clock'],
  difficulty: 2, vocab_constraints: { must_use_words: ['blue','bell','red'], max_sentence_words: 8, allowed_patterns: 'CVC, CCVC, and sight words' } };
async function main() {
  const n = new Narrator(child as any, memory as any, plan as any);
  for (const [mode, ctx] of [['OPENING','Maya was already greeted aloud. Go straight into beat 0.'],['NEXT_BEAT','Advance to beat 1.']] as const) {
    const t0 = Date.now();
    const turn = await n.turn(mode as any, ctx);
    const isTemplate = turn.speak_text.includes('took a big breath and looked around');
    console.log(`\n[${mode}] ${Date.now()-t0}ms  fallback=${isTemplate ? 'YES (bad)' : 'no'}`);
    console.log('  speak :', turn.speak_text);
    console.log('  read  :', turn.child_passage);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
