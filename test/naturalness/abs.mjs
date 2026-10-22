// Absolute single-clip human-likeness rating (for cross-voice upper-bound comparisons).
// usage: node --env-file=server/.env test/naturalness/abs.mjs <expDir> <cond1,cond2>
import fs from 'node:fs';
const { GoogleGenAI } = await import(new URL('../../server/node_modules/@google/genai/dist/node/index.mjs', import.meta.url).pathname);
const [exp, condsArg] = process.argv.slice(2);
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const man = JSON.parse(fs.readFileSync(`${exp}/manifest.json`, 'utf8')).filter((m) => condsArg.split(',').includes(m.cond));
const PROMPT = (t) => `You are an expert speech scientist. Rate how much this clip sounds like a REAL HUMAN naturally talking in a live video meeting (not a TTS system, not someone reading aloud). Intended message: """${t}"""
Anchors: 1-2 obviously robotic; 3-4 clearly synthetic, read-aloud, flat; 5-6 good TTS, still detectably synthetic/read; 7-8 mostly human-like conversational speech with minor tells; 9-10 indistinguishable from a real person speaking spontaneously.
Return ONLY JSON {"human":1-10,"tells":"<=20 words on what gives it away"}`;
const rows = []; const jobs = [...man];
async function w() { while (jobs.length) { const m = jobs.shift(); for (let a = 0; a < 4; a++) { try {
  const r = await client.models.generateContent({ model: 'gemini-3.1-pro-preview', contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/mp3', data: fs.readFileSync(m.file).toString('base64') } }, { text: PROMPT(m.text) }] }], config: { responseMimeType: 'application/json', temperature: 0 } });
  rows.push({ cond: m.cond, tid: m.tid, ...JSON.parse(r.text) }); break; } catch (e) { await new Promise((r) => setTimeout(r, 3000)); } } } }
await Promise.all([w(), w(), w(), w()]);
fs.writeFileSync(`${exp}/abs.json`, JSON.stringify(rows, null, 1));
for (const c of condsArg.split(',')) { const rs = rows.filter((r) => r.cond === c); if (!rs.length) continue; const v = rs.map((r) => r.human); console.log(c.padEnd(24), 'human', (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), 'n', v.length, '|', rs.slice(0, 2).map((r) => r.tells).join(' / ')); }
