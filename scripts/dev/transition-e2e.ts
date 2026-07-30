import { Narrator } from '../../lib/llm/narrator';
import { generateAcknowledgment } from '../../lib/llm/acknowledge';
import { PassageTracker } from '../../server/tracker';

const child = { id:'x', name:'Maya', age:5, onboarding_notes:'Loves dragons.' };
const memory = { interests:[], personality_notes:'', canon:{characters:['Blue the dragon']} };
const plan = { goal:'practice short_e', target_skills:['short_e'], premise:'Maya and Blue the dragon find a lost bell',
  characters:['Blue the dragon','Maya'], beats:['Blue finds a map','They cross a bridge','The bell is in the clock'],
  difficulty:2, vocab_constraints:{must_use_words:['bell','red','went'],max_sentence_words:8,allowed_patterns:'CVC'} };
const w = (word:string, accuracyScore:number) => ({ word, accuracyScore, errorType:'None', phonemes:[] });

async function main() {
  const t = new PassageTracker('The red bell went ding.');
  t.ingest([w('The',96),w('red',93),w('bell',91),w('went',94),w('ding',90)] as any);

  const n = new Narrator(child as any, memory as any, plan as any);
  const t0 = Date.now();
  // Exactly what session.nextBeat does: both concurrently, then prepend.
  const [ack, turn] = await Promise.all([
    generateAcknowledgment({ childName: child.name, words: t.words }),
    n.turn('NEXT_BEAT', 'Advance to beat 1.'),
  ]);
  const combined = `${ack.text} ${turn.speak_text}`;
  console.log(`concurrent total: ${Date.now()-t0}ms  (ack alone would add 0 when buffered)\n`);
  console.log('SPOKEN AS ONE UTTERANCE:');
  console.log('  ' + combined);
  console.log('\nTHEN CHILD READS:');
  console.log('  ' + turn.child_passage);
  const doublePraise = /\b(read|reading|smooth|great job|well done|nailed)\b/i.test(turn.speak_text);
  console.log(`\nbeat re-praises the reading (would double up)? ${doublePraise ? 'YES <-- check' : 'no'}`);
}
main().catch(e => { console.error(e); process.exit(1); });
