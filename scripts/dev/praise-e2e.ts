import { Narrator } from '../../lib/llm/narrator';
import { PassageTracker } from '../../server/tracker';
import { pickPraiseWord, mentionsWord } from '../../lib/praise';

const child = { id: 'x', name: 'Maya', age: 5, onboarding_notes: 'Loves dragons.' };
const memory = { interests: [], personality_notes: '', canon: {} };
// 'glad' deliberately planted in must_use_words — the exact trap that caused the bug.
const plan = { goal: 'practice blend_gl', target_skills: ['blend_gl'],
  premise: 'A frog and Blue the dragon cross a pond', characters: ['Blue the dragon','Maya'],
  beats: ['The frog hops','They reach the pond','They find the bell'],
  difficulty: 2, vocab_constraints: { must_use_words: ['glad','glow','glass','frog'], max_sentence_words: 8, allowed_patterns: 'CVC and gl blends' } };

async function main() {
  const t = new PassageTracker('The frog glides and hops.');
  t.ingest([
    { word:'The', accuracyScore:96, errorType:'None', phonemes:[] },
    { word:'frog', accuracyScore:88, errorType:'None', phonemes:[] },
    { word:'glides', accuracyScore:93, errorType:'None', phonemes:[] },
    { word:'and', accuracyScore:95, errorType:'None', phonemes:[] },
    { word:'hops', accuracyScore:90, errorType:'None', phonemes:[] },
  ] as any);

  const praiseWord = pickPraiseWord(t.words)!;
  console.log('deterministically chosen word:', praiseWord);

  const n = new Narrator(child as any, memory as any, plan as any);
  for (let i = 1; i <= 3; i++) {
    const turn = await n.turn('ENCOURAGE', 'They read two passages beautifully. Continue to beat 1.', { mustMention: praiseWord });
    const good = mentionsWord(turn.speak_text, praiseWord);
    const hallucinated = ['glad','glow','glass'].filter(w => mentionsWord(turn.speak_text, w));
    console.log(`\nrun ${i}: praises "${praiseWord}"? ${good ? 'YES' : 'NO <-- BUG'}`);
    if (hallucinated.length) console.log(`  !! mentions unspoken plan words: ${hallucinated.join(', ')}`);
    console.log('  ', turn.speak_text);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
