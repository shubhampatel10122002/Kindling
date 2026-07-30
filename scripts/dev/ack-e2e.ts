import { generateAcknowledgment } from '../../lib/llm/acknowledge';
import { PassageTracker } from '../../server/tracker';
import { MAX_ACK_WORDS } from '../../lib/ack';

const w = (word: string, accuracyScore: number, errorType: any = 'None') => ({ word, accuracyScore, errorType, phonemes: [] });

function flawless() {
  const t = new PassageTracker('The frog glides and hops.');
  t.ingest([w('The',96),w('frog',92),w('glides',94),w('and',95),w('hops',91)] as any);
  return t;
}
function solid() {
  const t = new PassageTracker('The cat sat down.');
  t.ingest([w('The',95)] as any);
  t.ingest([w('cat',40,'Mispronunciation')] as any);
  t.ingest([w('cat',90),w('sat',92),w('down',91)] as any);
  return t;
}
function effortful() {
  const t = new PassageTracker('The dragon roared loudly.');
  t.ingest([w('The',95)] as any);
  t.markGiven(1);
  t.ingest([w('roared',62),w('loudly',58)] as any);
  return t;
}

async function main() {
  for (const [label, make] of [['flawless',flawless],['solid',solid],['effortful',effortful]] as const) {
    const seen: string[] = [];
    let totalMs = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const r = await generateAcknowledgment({ childName: 'Maya', words: make().words });
      totalMs += Date.now() - t0;
      const words = r.text.split(/\s+/).length;
      const bad = words > MAX_ACK_WORDS ? '  <-- TOO LONG' : '';
      seen.push(r.text);
      console.log(`${label.padEnd(10)} band=${r.quality.band.padEnd(9)} src=${r.source.padEnd(8)} ${String(Date.now()-t0).padStart(5)}ms  "${r.text}"${bad}`);
    }
    console.log(`${' '.repeat(10)} avg ${Math.round(totalMs/3)}ms | distinct: ${new Set(seen).size}/3\n`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
