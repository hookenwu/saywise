// Blind pairwise "human-likeness" judge using Gemini audio understanding.
// usage: node --env-file=server/.env test/naturalness/judge.mjs <expDir> <baselineCond> <cond1,cond2,...> [model]
// Every (text, rep) pair is judged in BOTH orders (A/B swapped) to cancel position bias.
import fs from 'node:fs';
const { GoogleGenAI } = await import(new URL('../../server/node_modules/@google/genai/dist/node/index.mjs', import.meta.url).pathname);
const [exp, base, condsArg, modelArg] = process.argv.slice(2);
const MODEL = modelArg || 'gemini-3.1-pro-preview';
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const man = JSON.parse(fs.readFileSync(`${exp}/manifest.json`, 'utf8'));
const conds = condsArg.split(',');

const PROMPT = (text) => `You are an expert speech scientist and voice director evaluating text-to-speech output for a product whose users speak in live video meetings through a cloned version of their own voice. Listeners must not be able to tell it is synthetic.

Both clips (A then B) deliver the same message with the same cloned voice. Wording may differ slightly between them (e.g. one may contain natural fillers like "uh", a discourse marker, or a small rephrasing) — judge the delivery, not wording choices, but penalise unclear, garbled or wrong words. Intended message:
"""${text}"""

Judge which clip sounds MORE like a real person naturally talking in a meeting (spontaneous, conversational) rather than a machine or someone reading aloud. Consider: intonation variety and appropriateness, rhythm and timing (pause placement/length, pacing, phrase-final lengthening), stress on the right words, emotional appropriateness/sincerity, conversational vs. read-speech register, and any artifacts (glitches, odd breaths, mispronunciations, wrong words, robotic buzz, unnatural pitch jumps). Accuracy to the text matters: a clip that drops or changes words is worse.

Return ONLY JSON: {"a":{"human":1-10,"prosody":1-10,"artifacts":1-10},"b":{"human":1-10,"prosody":1-10,"artifacts":1-10},"winner":"A"|"B"|"tie","reason":"<=25 words"}
(artifacts: 10 = no artifacts).`;

async function judge(fa, fb, text) {
  const part = (f) => ({ inlineData: { mimeType: 'audio/mp3', data: fs.readFileSync(f).toString('base64') } });
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const r = await client.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: 'Clip A:' }, part(fa), { text: 'Clip B:' }, part(fb), { text: PROMPT(text) }] }],
        config: { responseMimeType: 'application/json', temperature: 0 },
      });
      return JSON.parse(r.text);
    } catch (e) {
      await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)));
      if (attempt === 7) throw e;
    }
  }
}

const out = [];
const key = (m) => `${m.tid}_${m.rep}`;
const baseBy = Object.fromEntries(man.filter((m) => m.cond === base).map((m) => [key(m), m]));
const jobs = [];
for (const c of conds) for (const m of man.filter((x) => x.cond === c)) {
  const b = baseBy[key(m)];
  if (b) jobs.push({ c, m, b });
}
let done = 0;
const CONC = 3;
async function worker() {
  while (jobs.length) {
    const { c, m, b } = jobs.shift();
    try {
      const [r1, r2] = await Promise.all([judge(b.file, m.file, m.text), judge(m.file, b.file, m.text)]);
      // normalise to cond's perspective: +1 cond wins, -1 baseline wins
      const s1 = r1.winner === 'B' ? 1 : r1.winner === 'A' ? -1 : 0;
      const s2 = r2.winner === 'A' ? 1 : r2.winner === 'B' ? -1 : 0;
      const humanDelta = ((r1.b.human - r1.a.human) + (r2.a.human - r2.b.human)) / 2;
      out.push({ cond: c, tid: m.tid, rep: m.rep, score: (s1 + s2) / 2, humanDelta, condHuman: (r1.b.human + r2.a.human) / 2, baseHuman: (r1.a.human + r2.b.human) / 2, reasons: [r1.reason, r2.reason] });
    } catch (e) { console.log('judge fail', c, m.tid, e.message.slice(0, 100)); }
    process.stderr.write(`\r${++done}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
fs.writeFileSync(`${exp}/judge_${base}.json`, JSON.stringify(out, null, 1));
console.log(`\nJudge ${MODEL}: cond vs baseline "${base}"  (score: +1 = cond preferred in both orders, -1 = baseline preferred)`);
for (const c of conds) {
  const rs = out.filter((r) => r.cond === c);
  if (!rs.length) continue;
  const mean = (k) => (rs.reduce((s, r) => s + r[k], 0) / rs.length).toFixed(2);
  const wins = rs.filter((r) => r.score > 0).length, losses = rs.filter((r) => r.score < 0).length;
  console.log(`${c.padEnd(24)} pref=${mean('score').padStart(6)}  W/L/T=${wins}/${losses}/${rs.length - wins - losses}  human ${mean('condHuman')} vs base ${mean('baseHuman')}  n=${rs.length}`);
}
