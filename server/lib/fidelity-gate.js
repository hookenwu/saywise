/**
 * Humanize Fidelity Gate (specs/voice-copilot-humanize-fidelity-gate). A deterministic,
 * zero-LLM check that a Humanize rewrite says the same thing as the user's original:
 * same facts (numbers, units, dates, terms), negation, subjects, certainty, commitments,
 * conditions and aspect. Verdicts:
 *   pass      the rewrite is spoken as-is;
 *   repaired  an added pure modal/attitude adverb (其实, 估计, definitely…) was deleted,
 *             and the result passes every check;
 *   fallback  anything else, so the original text is spoken verbatim.
 * Meaning beats naturalness: when in doubt, fall back.
 */

// ---------------------------------------------------------------- Chinese

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };
const CN_BIG = { 万: 1e4, 亿: 1e8 };

/** '两百' → 200, '二十七' → 27, '三' → 3, '两万' → 20000. NaN if unparsable. */
export function parseCnNumber(s) {
  let total = 0, section = 0, digit = null;
  for (const ch of s) {
    if (ch in CN_DIGIT) digit = CN_DIGIT[ch];
    else if (ch in CN_UNIT) { section += (digit ?? 1) * CN_UNIT[ch]; digit = null; }
    else if (ch in CN_BIG) { total += (section + (digit ?? 0)) * CN_BIG[ch]; section = 0; digit = null; }
    else return NaN;
  }
  return total + section + (digit ?? 0);
}

// Words that contain numeral characters but are not numbers.
const ZH_NUMERAL_WORDS = [
  '第一时间', '一模一样', '一口气', '一方面', '一会儿', '一块儿', '一点儿', '一次性', '百分之百',
  '统一', '万一', '一样', '一起', '唯一', '一直', '一些', '一下', '一会', '十分', '千万', '万万',
  '一定', '一旦', '一般', '一切', '一边', '一点', '有点', '一致', '一律', '一向', '同一', '一来',
  '三思', '一遍', '一次', '一番', '一阵', '一声', '一眼', '一句', '一步', '一面',
];
const ZH_UNITS = '毫秒|分钟|小时|块钱|季度|秒|点|号|日|月|年|天|周|元|块|家|个|次|倍|岁|位|条|台|%';
const ZH_UNIT_CANON = { 块钱: '元', 块: '元', 号: '日' };
const ZH_ARTICLE_UNITS = new Set(['个', '次', '位', '条', '台']);
const ZH_WEEKDAY_RE = /(?:周|星期|礼拜)([一二三四五六日天])/g;
const ZH_DATE_WORDS = [
  ['今天晚上', '今晚'], ['今晚', '今晚'], ['明天晚上', '明晚'], ['明晚', '明晚'], ['今天', '今天'], ['明天', '明天'],
  ['后天', '后天'], ['昨天', '昨天'], ['前天', '前天'], ['上午', '上午'], ['下午', '下午'], ['中午', '中午'],
  ['早上', '早上'], ['晚上', '晚上'], ['周末', '周末'], ['月底', '月底'], ['年底', '年底'], ['月初', '月初'],
  ['下周', '下周'], ['下个星期', '下周'], ['上周', '上周'], ['这周', '这周'], ['本周', '这周'], ['下个月', '下个月'],
  ['上个月', '上个月'], ['这个月', '这个月'], ['本月', '这个月'],
];

/** Each class: [surface form, canonical member]. Sets of canonical members must match. */
const ZH_CLASSES = {
  hedge: [['说不定', '可能'], ['可能', '可能'], ['也许', '可能'], ['或许', '可能'], ['估计', '估计'], ['恐怕', '恐怕'],
    ['怕是', '恐怕'], ['好像', '好像'], ['似乎', '好像'], ['预计', '预计'], ['不一定', '不一定']],
  approx: [['左右', '约'], ['大概', '约'], ['大约', '约'], ['差不多', '约'], ['将近', '约'], ['上下', '约']],
  opinion: [['觉得', '觉得'], ['感觉', '觉得'], ['认为', '觉得']],
  certain: [['肯定', '肯定'], ['绝对', '肯定'], ['必然', '肯定'], ['必定', '肯定'], ['当然', '当然'], ['确定', '确定'],
    ['毫无疑问', '肯定'], ['百分之百', '肯定']],
  must: [['必须', '必须'], ['务必', '必须'], ['非得', '必须'], ['一定要', '必须'], ['不得不', '必须'], ['只能', '只能']],
  commit: [['承诺', '承诺'], ['保证', '保证'], ['确保', '保证'], ['答应', '答应'], ['负责', '负责'], ['担保', '保证']],
  // Decision state: only decisive verbs are tracked, so dropping one (再决定 → 再看看) or adding
  // one is a mismatch, while tentative 看看/考虑 alone (very common spoken filler) is not.
  decision: [['决定', '决定'], ['敲定', '决定'], ['拍板', '决定'], ['定下来', '决定'], ['同意', '同意'], ['批准', '同意'],
    ['确认', '确认'], ['拒绝', '拒绝']],
  intent: [['打算', '打算'], ['计划', '计划'], ['准备', '准备'], ['争取', '争取'], ['尽量', '尽量'], ['想要', '想要']],
  timing: [['准时', '准时'], ['按时', '准时'], ['尽快', '尽快'], ['马上', '马上'], ['立刻', '马上'], ['立即', '马上'],
    ['第一时间', '第一时间'], ['及时', '及时'], ['随时', '随时']],
  condition: [['如果', '如果'], ['要是', '如果'], ['假如', '如果'], ['假设', '如果'], ['万一', '万一'], ['只要', '只要'],
    ['除非', '除非'], ['一旦', '一旦'], ['只有', '只有']],
  qualifier: [['合格', '合格'], ['通过', '通过'], ['全额', '全额'], ['全部', '全部'], ['提前', '提前'], ['最晚', '最晚'],
    ['最迟', '最晚'], ['至少', '至少'], ['最多', '最多'], ['以内', '以内'], ['之内', '以内'], ['截止', '截止'], ['为止', '为止'], ['正式', '正式']],
  aspect: [['已经', '已经'], ['还没', '还没'], ['尚未', '还没'], ['刚才', '刚才'], ['刚刚', '刚才'], ['曾经', '曾经']],
  attitude: [['其实', '其实'], ['确实', '确实'], ['真的', '真'], ['真', '真']],
  degree: [['不太', '不太'], ['不怎么', '不太'], ['不大', '不太'], ['有点', '有点'], ['有些', '有点'], ['稍微', '有点'], ['略微', '有点'],
    ['非常', '非常'], ['特别', '非常']],
};
// Words to strip before matching a class, because they contain one of its members (主要是 ⊃ 要是).
const ZH_CLASS_STRIP = {
  condition: ['主要', '重要', '需要', '想要'],
  intent: ['准备好'],
  attitude: ['认真', '真正', '真实', '真相', '真心', '真诚', '天真', '逼真'],
  degree: ['特别是', '有点儿'],
  // 刚才 pointing at this very conversation (我刚才没听清 / 你刚才说) adds no fact.
  aspect: [/(刚才|刚刚)(?=[^，。？！,.?!]{0,4}(听|说|讲|提))/g],
};
// Lexicalised words to strip before counting negation / 前后 (they don't negate or order anything).
const ZH_NOT_NEGATION = ['不过', '不好意思', '不管', '不仅', '不论', '不断', '不少', '不同', '不久', '要不然', '要不', '不然',
  '差不多', '没错', '没关系', '不客气', '不错', '别人', '别的', '特别', '区别', '分别', '级别', '类别', '告别', '说不定'];
const ZH_NOT_ORDER = ['前端', '后端', '前面', '后面', '最后', '然后', '往后', '后来', '目前', '前提', '提前', '先前', '后续',
  '背后', '后悔', '落后', '前进', '前天', '后天', '前段'];
const ZH_PRONOUNS = [['我们', 'we'], ['咱们', 'we'], ['你们', 'you-pl'], ['您', 'you'], ['他们', 'they'], ['她们', 'they'],
  ['大家', 'all'], ['我', 'i'], ['你', 'you'], ['他', 'he'], ['她', 'he']];
const ZH_ALLOWED_ADDED_LATIN = new Set(['ok', 'okay']);

/** Repairable added words: pure modal/attitude adverbs whose deletion restores the source meaning. */
const ZH_DELETABLE = ['其实', '确实', '真的', '真', '肯定', '绝对', '估计', '恐怕', '怕是', '准时', '当然'];
const ZH_COMPOUND_AFTER = /^(?:的|值|句|地|性|不)/; // 估计值, 肯定的, 绝对值…: not an adverb, don't delete
const ZH_NEGATED_BEFORE = /[不没别未]$/;

function stripAll(text, words) {
  let t = text;
  for (const w of [...words].sort((a, b) => String(b).length - String(a).length)) t = w instanceof RegExp ? t.replace(w, ' ') : t.split(w).join(' ');
  return t;
}

function zhFacts(text) {
  const out = new Set();
  let t = text.replace(/\s+/g, ' ');
  t = t.replace(ZH_WEEKDAY_RE, (_, d) => { out.add(`weekday:${d === '天' ? '日' : d}`); return ' '; });
  t = t.replace(/百分之([零〇一二两三四五六七八九十百千万]+)/g, (_, n) => { out.add(`${parseCnNumber(n)}|%`); return ' '; });
  t = t.replace(/(\d[\d,]*(?:\.\d+)?)\s*(万|亿)?\s*(毫秒|分钟|小时|块钱|季度|秒|点|号|日|月|年|天|周|元|块|家|个|次|倍|岁|位|条|台|%)?/g,
    (_, n, big, unit) => {
      const v = parseFloat(n.replace(/,/g, '')) * (big ? CN_BIG[big] : 1);
      out.add(`${v}|${ZH_UNIT_CANON[unit] || unit || ''}`);
      return ' ';
    });
  t = stripAll(t, ZH_NUMERAL_WORDS);
  t = t.replace(new RegExp(`([零〇一二两三四五六七八九十百千万亿]+)(${ZH_UNITS})?`, 'g'), (m, n, unit) => {
    // bare 一, or 一 used as an article (一个/一次/一位…), is not a figure
    if (n === '一' && (!unit || ZH_ARTICLE_UNITS.has(unit))) return ' ';
    const v = parseCnNumber(n);
    if (!Number.isNaN(v)) out.add(`${v}|${ZH_UNIT_CANON[unit] || unit || ''}`);
    return ' ';
  });
  for (const canon of classMembers(text, ZH_DATE_WORDS)) out.add(`date:${canon}`);
  return out;
}

function latinTerms(text) {
  return new Set((text.match(/[A-Za-z][A-Za-z0-9_.+-]*[A-Za-z0-9]|[A-Za-z]/g) || []).map((w) => w.toLowerCase()));
}

function zhNegations(text) {
  let t = stripAll(text, ZH_NOT_NEGATION);
  t = t.replace(/(.)[不没]\1/g, ' '); // A-not-A questions: 能不能, 是不是, 有没有
  return (t.match(/[不没别未勿]/g) || []).length;
}

function zhOrder(text) {
  let t = text.replace(/之前|以前/g, '前').replace(/之后|以后/g, '后');
  t = stripAll(t, ZH_NOT_ORDER.map((w) => w.replace(/之前|以前/g, '前').replace(/之后|以后/g, '后')));
  return `前${(t.match(/前/g) || []).length}后${(t.match(/后/g) || []).length}`;
}

function zhPronouns(text) {
  const set = new Set();
  let t = stripAll(text, ['其他', '其它']);
  for (const [w, canon] of ZH_PRONOUNS) if (t.includes(w)) { set.add(canon); t = t.split(w).join(' '); }
  return set;
}

// Who commits: the pronoun in front of a commitment verb (我会…, 我们保证…, 你负责…).
const ZH_COMMIT_SUBJECT_RE = /(我们|咱们|你们|您|他们|她们|我|你|他|她)(?:这边|那边)?[^，。？！,.?!]{0,4}?(会|将|承诺|保证|确保|负责|答应|争取)/g;
function zhCommitSubjects(text) {
  const canon = Object.fromEntries(ZH_PRONOUNS);
  return new Set([...stripAll(text, ['其他', '其它']).matchAll(ZH_COMMIT_SUBJECT_RE)].map((m) => canon[m[1]]));
}

function classMembers(text, entries) {
  const set = new Set();
  let t = text;
  for (const [w, canon] of [...entries].sort((a, b) => b[0].length - a[0].length)) {
    if (t.includes(w)) { set.add(canon); t = t.split(w).join(' '); }
  }
  return set;
}

// ---------------------------------------------------------------- English

const EN_SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const EN_ORD = { first: 'one', second: 'two', third: 'three', fifth: 'five', eighth: 'eight', ninth: 'nine', twelfth: 'twelve' };
const EN_MULT = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };

function enWordToNum(w) {
  let s = w.toLowerCase();
  if (EN_ORD[s]) s = EN_ORD[s];
  else if (/ieth$/.test(s)) s = s.replace(/ieth$/, 'y');
  else if (/th$/.test(s) && (EN_SMALL[s.slice(0, -2)] !== undefined || EN_SMALL[s.slice(0, -2) + 'e'] !== undefined)) s = EN_SMALL[s.slice(0, -2)] !== undefined ? s.slice(0, -2) : s.slice(0, -2) + 'e';
  if (EN_SMALL[s] !== undefined) return EN_SMALL[s];
  if (EN_TENS[s] !== undefined) return EN_TENS[s];
  if (EN_MULT[s] !== undefined) return { mult: EN_MULT[s] };
  return null;
}

function enFacts(text) {
  // Digits and spelled-out numbers describe the same figure, so only values are compared.
  const out = new Set();
  const t = text.replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  for (const m of t.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(String(parseFloat(m[0].replace(/,/g, ''))));
  let cur = null;
  const flush = () => { if (cur !== null) out.add(String(cur)); cur = null; };
  for (const raw of t.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    const v = enWordToNum(raw);
    if (v === null) { flush(); continue; }
    if (typeof v === 'object') cur = (cur ?? 1) * v.mult;
    else cur = (cur ?? 0) + v;
  }
  flush();
  return out;
}

const EN_NUM = '(?:\\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|a hundred|a thousand)';
const EN_CLASSES = {
  hedge: [['maybe', 'maybe'], ['perhaps', 'maybe'], ['possibly', 'maybe'], ['might', 'might'], ['probably', 'probably'],
    ['likely', 'probably'], ['i think', 'think'], ['i guess', 'think'], ['i believe', 'think'], ['seems', 'seems'], ['not sure', 'unsure']],
  approx: [[`about ${EN_NUM}`, 'approx'], [`around ${EN_NUM}`, 'approx'], ['roughly', 'approx'], ['approximately', 'approx'], ['nearly', 'approx'], ['almost', 'approx']],
  certain: [['definitely', 'definitely'], ['certainly', 'definitely'], ['surely', 'definitely'], ['absolutely', 'definitely'],
    ['for sure', 'definitely'], ['of course', 'of course'], ['guaranteed', 'guarantee']],
  must: [['must', 'must'], ['have to', 'have to'], ['has to', 'have to'], ['need to', 'need to'], ['got to', 'have to'], ['only option', 'only']],
  commit: [['promise', 'promise'], ['guarantee', 'guarantee'], ['ensure', 'guarantee'], ['commit', 'commit']],
  decision: [['decide', 'decide'], ['decided', 'decide'], ['decision', 'decide'], ['finalize', 'decide'], ['confirm', 'confirm'],
    ['confirmed', 'confirm'], ['approve', 'approve'], ['approved', 'approve'], ['agree', 'agree'], ['agreed', 'agree'], ['reject', 'reject'], ['sign off', 'approve']],
  intent: [['plan to', 'plan'], ['planning to', 'plan'], ['intend', 'intend'], ['aim to', 'aim'], ['try to', 'try']],
  timing: [['on time', 'on time'], ['asap', 'asap'], ['as soon as possible', 'asap'], ['right away', 'now'], ['immediately', 'now'], ['first thing', 'first thing']],
  condition: [['if', 'if'], ['unless', 'unless'], ['as long as', 'as long as'], ['in case', 'in case'], ['provided', 'provided']],
  date: [['today', 'today'], ['tomorrow', 'tomorrow'], ['tonight', 'tonight'], ['yesterday', 'yesterday'], ['morning', 'morning'],
    ['afternoon', 'afternoon'], ['evening', 'evening'], ['monday', 'monday'], ['tuesday', 'tuesday'], ['wednesday', 'wednesday'],
    ['thursday', 'thursday'], ['friday', 'friday'], ['saturday', 'saturday'], ['sunday', 'sunday'], ['next week', 'next week'], ['last week', 'last week']],
  aspect: [['already', 'already'], ['not yet', 'not yet'], ['just now', 'just now']],
  attitude: [['actually', 'actually'], ['really', 'really'], ['honestly', 'honestly']],
};
const EN_PRONOUNS = [['we', 'we'], ['us', 'we'], ['our', 'we'], ['i', 'i'], ['me', 'i'], ['my', 'i'], ['you', 'you'], ['your', 'you'],
  ['they', 'they'], ['them', 'they'], ['he', 'he'], ['she', 'he']];
const EN_DELETABLE = ['definitely', 'certainly', 'surely', 'absolutely', 'actually', 'really'];

// Spoken fillers the English delivery prompt itself asks for; they carry no subject or claim.
const EN_FILLER_PHRASES = / (you know|i mean|you see)(?= )/g;

function enNorm(text) {
  return ` ${text.toLowerCase().replace(/[’']/g, "'").replace(/\b(i|we|you|they|he|she)'(m|re|ll|ve|d|s)\b/g, '$1 _$2')
    .replace(/n't\b/g, ' not').replace(/[^a-z0-9%$'._ -]+/g, ' ').replace(/\s+/g, ' ')} `.replace(EN_FILLER_PHRASES, ' ').replace(/\s+/g, ' ');
}

function enClassMembers(norm, entries) {
  const set = new Set();
  for (const [w, canon] of entries) if (new RegExp(` ${w}(?![a-z])`).test(norm)) set.add(canon);
  return set;
}

const EN_COMMIT_SUBJECT_RE = / (i|we|you|they|he|she) (?:\w+ )?(?:_ll|will|promise|guarantee|commit|ensure)(?![a-z])/g;
function enCommitSubjects(norm) {
  return new Set([...norm.matchAll(EN_COMMIT_SUBJECT_RE)].map((m) => (m[1] === 'she' ? 'he' : m[1])));
}

function enNegations(norm) {
  return (norm.match(/ (not|no|never|nothing|none|nobody|without|cannot|neither|nor) /g) || []).length;
}

function enPronouns(norm) {
  const set = new Set();
  for (const w of norm.trim().split(' ')) for (const [p, canon] of EN_PRONOUNS) if (w === p) set.add(canon);
  return set;
}

function enTerms(text) {
  // Acronyms / identifiers: QA, API, P99, iOS — any token with a capital after its first letter or a digit.
  return new Set((text.match(/\b[A-Za-z]*[A-Z0-9][A-Za-z0-9_-]*\b/g) || []).filter((w) => /[A-Z].*[A-Z0-9]|[0-9]/.test(w) && /[A-Za-z]/.test(w) && !/^(I|OK)$/i.test(w) && !/^\d[\d,.]*(st|nd|rd|th|s|k|ms|am|pm)?$/i.test(w)).map((w) => w.toLowerCase()));
}

// ---------------------------------------------------------------- comparison

const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const diff = (a, b) => [...a].filter((x) => !b.has(x));

/** Returns the list of mismatch reason codes (empty = meaning-equivalent). */
export function findMismatches(source, output, lang) {
  const reasons = [];
  // Who acts or commits must not change: an added or swapped subject is a mismatch; a dropped one
  // (Chinese pro-drop: 我觉得我们可以 → 我觉得可以) is not.
  const noneAdded = (code, a, b) => { if (diff(b, a).length) reasons.push(`${code}+${diff(b, a).join('/')}`); };
  // Committer: if the source names who commits, the output must not change it; if it names none,
  // the output may make an existing participant explicit (Let me check → I'll check) but no one new.
  const committer = (srcC, outC, srcPron) => {
    const added = diff(outC, srcC);
    if (added.length && (srcC.size || added.some((p) => !srcPron.has(p)))) reasons.push(`committer+${added.join('/')}`);
  };
  const cmpSet = (code, a, b) => { if (!eqSet(a, b)) reasons.push(`${code}${diff(b, a).length ? `+${diff(b, a).join('/')}` : ''}${diff(a, b).length ? `-${diff(a, b).join('/')}` : ''}`); };
  if (lang === 'zh') {
    cmpSet('fact', zhFacts(source), zhFacts(output));
    const srcLatin = latinTerms(source), outLatin = latinTerms(output);
    const added = diff(outLatin, srcLatin).filter((w) => !ZH_ALLOWED_ADDED_LATIN.has(w));
    if (diff(srcLatin, outLatin).length || added.length) reasons.push('term');
    if (zhNegations(source) !== zhNegations(output)) reasons.push('negation');
    if (zhOrder(source) !== zhOrder(output)) reasons.push('order');
    noneAdded('subject', zhPronouns(source), zhPronouns(output));
    committer(zhCommitSubjects(source), zhCommitSubjects(output), zhPronouns(source));
    for (const [cls, entries] of Object.entries(ZH_CLASSES)) {
      const prep = (t) => (ZH_CLASS_STRIP[cls] ? stripAll(t, ZH_CLASS_STRIP[cls]) : t);
      cmpSet(cls, classMembers(prep(source), entries), classMembers(prep(output), entries));
    }
  } else {
    const ns = enNorm(source), no = enNorm(output);
    cmpSet('fact', enFacts(source), enFacts(output));
    cmpSet('term', enTerms(source), enTerms(output));
    if (enNegations(ns) !== enNegations(no)) reasons.push('negation');
    noneAdded('subject', enPronouns(ns), enPronouns(no));
    committer(enCommitSubjects(ns), enCommitSubjects(no), enPronouns(ns));
    for (const [cls, entries] of Object.entries(EN_CLASSES)) cmpSet(cls, enClassMembers(ns, entries), enClassMembers(no, entries));
  }
  return reasons;
}

function repairZh(source, output) {
  let text = output;
  const deleted = [];
  for (const w of ZH_DELETABLE) {
    if (source.includes(w) || !text.includes(w)) continue;
    let unsafe = false;
    text = text.replace(new RegExp(`(^|[，。！？、；：…—\\s])?${w}([，,]?)`, 'g'), (m, pre = '', comma, offset, whole) => {
      const before = whole.slice(0, offset + pre.length), after = whole.slice(offset + m.length);
      if (ZH_NEGATED_BEFORE.test(before) || (!comma && ZH_COMPOUND_AFTER.test(after))) { unsafe = true; return m; }
      return pre ? pre : comma && /[，。！？、；：…—\s]$/.test(before) ? '' : comma;
    });
    if (unsafe) return null;
    deleted.push(w);
  }
  if (!deleted.length) return null;
  text = text.replace(/([，,])\s*[，,]/g, '$1').replace(/^[，,\s]+/, '');
  return { text, deleted };
}

function repairEn(source, output) {
  let text = output;
  const deleted = [];
  const ns = enNorm(source);
  for (const w of EN_DELETABLE) {
    if (ns.includes(` ${w} `) || !new RegExp(`\\b${w}\\b`, 'i').test(text)) continue;
    text = text.replace(new RegExp(`\\s*\\b${w}\\b,?`, 'gi'), '');
    deleted.push(w);
  }
  if (!deleted.length) return null;
  text = text.replace(/^\s*,?\s*/, '').replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return { text, deleted };
}

/**
 * @param {string} source the user's original Speech Text
 * @param {string} output the Humanize rewrite
 * @param {'zh'|'en'} lang output language (same as the source in rewrite mode)
 * @returns {{ verdict: 'pass'|'repaired'|'fallback', text: string, reasons: string[] }}
 */
export function gateRewrite(source, output, lang) {
  const out = (output || '').trim();
  if (!out) return { verdict: 'fallback', text: source, reasons: ['empty'] };
  const reasons = findMismatches(source, out, lang);
  if (!reasons.length) return { verdict: 'pass', text: out, reasons };
  const repaired = (lang === 'zh' ? repairZh : repairEn)(source, out);
  if (repaired && !findMismatches(source, repaired.text, lang).length) {
    return { verdict: 'repaired', text: repaired.text, reasons: repaired.deleted.map((w) => `del:${w}`) };
  }
  return { verdict: 'fallback', text: source, reasons };
}
