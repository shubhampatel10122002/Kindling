import { pool, query, one, getDemoChild } from '../../lib/db';
const child = await getDemoChild();
const plan = { goal:'practice blend_bl, short_e', target_skills:['blend_bl','short_e','short_a'],
  premise:'Maya and Blue the dragon hunt for the lost bell', characters:['Blue the dragon','Maya'],
  beats:['Maya finds a torn map','They cross the wobbly bridge','The bell is in the old clock'],
  difficulty:2, vocab_constraints:{must_use_words:['blue','bell','red','map'],max_sentence_words:7,allowed_patterns:'short vowels + bl blend'} };
const transcript = [
  {ts:new Date().toISOString(),kind:'narrator',text:'Hi Maya! Blue the dragon lost his little bell in the garden.'},
  {ts:new Date().toISOString(),kind:'child_passage',text:'The blue map is here.'},
  {ts:new Date().toISOString(),kind:'child_talk',text:'I got a new bike for my birthday! It is red.'},
  {ts:new Date().toISOString(),kind:'narrator',text:'A red bike! Blue would love to race you. Look, the map shows a bridge.'},
  {ts:new Date().toISOString(),kind:'child_passage',text:'Blue ran to the red bell.'},
  {ts:new Date().toISOString(),kind:'coach',text:'Let us sound it out: b... e... l... l.'},
  {ts:new Date().toISOString(),kind:'narrator',text:'You found the bell inside the old clock! What a great helper you are.'},
];
const s = await one<{id:string}>('INSERT INTO sessions (child_id, plan, ended_at, transcript) VALUES ($1,$2,now(),$3) RETURNING id',
  [child!.id, JSON.stringify(plan), JSON.stringify(transcript)]);
const words: [string,string,number,number][] = [
  ['The','None',96,1],['blue','None',91,1],['map','None',88,1],['is','None',94,1],['here','None',90,1],
  ['Blue','None',89,1],['ran','None',92,1],['to','None',95,1],['the','None',97,1],['red','None',85,1],
  ['bell','Mispronunciation',42,1],['bell','None',87,2],['bed','Developmental',58,1],['let','None',83,1],
];
for (const [w,e,score,attempt] of words) {
  await query('INSERT INTO reading_events (session_id, child_id, expected_word, attempt, error_type, accuracy_score, phonemes, pause_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [s!.id, child!.id, w, attempt, e, score, '[]', 0]);
}
await query("INSERT INTO session_flags (session_id, type, detail) VALUES ($1,'interest_signals',$2)", [s!.id, 'bikes, birthdays']);
console.log('Seeded session', s!.id, 'with', words.length, 'reading events');
await pool.end();
