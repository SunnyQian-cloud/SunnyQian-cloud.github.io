// Turns one typed (or dictated) line into an editable draft. Never saves anything itself.
// Rules: never invent a deadline; label suggested durations; keep the original text when unsure;
// resolve "tomorrow"/weekdays against the CURRENT local date passed in as `today`.
import { addDays, daysBetween, makeISODate, weekdayOf, formatDate, isValidISODate, parseHM, formatHM, formatTime12 } from './dates.js';
import { SUGGESTED_MINUTES, KINDS, PRIORITIES, newId, MIN_SESSION } from './model.js';

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, 'twenty-five': 25, thirty: 30, forty: 40,
  'forty-five': 45, fifty: 50, sixty: 60, ninety: 90,
};
const NUM = `(\\d+(?:\\.\\d+)?|${Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|')})`;
const toNum = (s) => (s in NUM_WORDS ? NUM_WORDS[s] : parseFloat(s));
const HOUR = '(?:hours?|hrs?|h)\\b';
const MINS = '(?:minutes?|mins?|m)\\b';
const UNC = '((?:(?:for|about|around|roughly|approx(?:imately|\\.)?|maybe|probably|like|at\\s+least|~)\\s*)*)';
const UNC_SUFFIX = '((?:\\s*(?:or\\s+so|-?ish|\\?))?)';
const UNCERTAIN_WORDS = /about|around|roughly|approx|maybe|probably|like|at\s+least|~|or\s+so|ish|\?/;

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = `(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')})`;
const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const WD_RE = `(${Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|')})`;
const DATE_PREFIX = '((?:\\b(?:due|by|on|before|for)\\s+(?:on\\s+)?)?)';
const MERIDIEM = '(a\\.?m\\.?|p\\.?m\\.?)';

/** Lower-case ASCII letters only, so string length (and match positions) never change. */
const lowerAscii = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function makeState(text) {
  return { text, work: lowerAscii(text), spans: [], flags: [] };
}
/** Find the first match in the not-yet-consumed text; optionally consume it. */
function find(state, source) {
  const re = new RegExp(source, 'i');
  const m = re.exec(state.work);
  return m;
}
function consume(state, m) {
  const start = m.index, end = m.index + m[0].length;
  state.work = state.work.slice(0, start) + ' '.repeat(end - start) + state.work.slice(end);
  state.spans.push([start, end]);
}
function flag(state, field, level, message, alternatives) {
  state.flags.push(alternatives ? { field, level, message, alternatives } : { field, level, message });
}

// ---------- duration ----------
function parseDuration(state) {
  const rules = [
    [`\\b${UNC}${NUM}\\s+and\\s+a\\s+half\\s+${HOUR}${UNC_SUFFIX}`, (m) => (toNum(m[2]) + 0.5) * 60],
    [`\\b${UNC}an?\\s+hour\\s+and\\s+a\\s+half${UNC_SUFFIX}`, () => 90],
    [`\\b${UNC}half\\s+(?:an?\\s+)?hour${UNC_SUFFIX}`, () => 30],
    [`\\b${UNC}(\\d+(?:\\.\\d+)?)\\s*(?:-|–|to)\\s*(\\d+(?:\\.\\d+)?)\\s*(${HOUR}|${MINS})${UNC_SUFFIX}`, (m) => {
      const unitIsHour = /^h/.test(m[4]);
      return { min: Math.max(toNum(m[2]), toNum(m[3])) * (unitIsHour ? 60 : 1), range: true };
    }],
    [`\\b${UNC}(\\d+)\\s*(?:hours?|hrs?|h)\\s*(?:and\\s*)?(\\d+)\\s*${MINS}${UNC_SUFFIX}`, (m) => toNum(m[2]) * 60 + toNum(m[3])],
    [`\\b${UNC}${NUM}\\s*-?\\s*${HOUR}${UNC_SUFFIX}`, (m) => toNum(m[2]) * 60],
    [`\\b${UNC}${NUM}\\s*-?\\s*${MINS}${UNC_SUFFIX}`, (m) => toNum(m[2])],
  ];
  // "~" is not a word character, so also try with a leading "~" outside \b.
  for (const [src, fn] of rules) {
    const m = find(state, src.replace(/^\\b/, '(?:\\b|(?=~))'));
    if (!m) continue;
    const res = fn(m);
    const min = Math.round(typeof res === 'object' ? res.min : res);
    if (!(min > 0)) continue;
    const prefix = m[1] || '';
    const suffix = m[m.length - 1] || '';
    const uncertain = (typeof res === 'object' && res.range) || UNCERTAIN_WORDS.test(prefix + ' ' + suffix);
    consume(state, m);
    return { minutes: Math.min(min, 24 * 60), uncertain, raw: m[0].trim(), tooLong: min > 24 * 60, start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/**
 * Words around a duration that say what it measures. "study 45 min" / "45 min of prep" → study time
 * (the words are removed from the title). "45 min long" / "test length 45 min" / "45 min test" → how
 * long the test itself lasts, which is NOT study time.
 */
function durationContext(state, dur) {
  const before = state.work.slice(0, dur.start);
  const after = state.work.slice(dur.end);
  const take = (start, end) => consume(state, { index: start, 0: state.work.slice(start, end) });
  const lengthBefore = /\b(?:test|exam|quiz)?\s*(?:length|lasts?|is)\s*(?:of|is|for)?\s*[:=]?\s*$/.exec(before);
  const lengthAfter = /^\s*-?\s*(?:long\b|(?:test|exam|quiz)\b)/.exec(after);
  if (lengthAfter && /long/.test(lengthAfter[0])) { take(dur.end, dur.end + lengthAfter[0].length); return 'length'; }
  if (lengthBefore && /length|last/.test(lengthBefore[0])) { take(dur.start - lengthBefore[0].length, dur.start); return 'length'; }
  if (lengthAfter) return 'length'; // "45 min test": keep the word "test" in the title
  let study = false;
  // Only at the start of the line or after punctuation, so "SAT prep 2 hours" keeps "prep" in the title.
  const sb = /(?:^|[,;:\-–—(]\s*|\band\s+)((?:study(?:ing)?|prep(?:ping|aring)?|review(?:ing)?)(?:\s+time)?(?:\s+for)?\s*[:=]?\s*)$/.exec(before);
  if (sb) { take(dur.start - sb[1].length, dur.start); study = true; }
  const sa = /^\s*(?:of\s+)?(?:study(?:ing)?|prep|review)(?:\s+time)?\b/.exec(after);
  if (sa) { take(dur.end, dur.end + sa[0].length); study = true; }
  if (study) {
    // "study 30 min for Spanish quiz" → title "Spanish quiz"
    const rest = state.work.slice(dur.end);
    const fr = /^\s*for\b/.exec(rest);
    if (fr) take(dur.end, dur.end + fr[0].length);
  }
  return study ? 'study' : null;
}

/** "D block" / "block D" / "in D block": the class block a test (or due work) is in. */
function parseBlock(state, original) {
  const m = find(state, '\\b(?:(?:in|during)\\s+)?(?:([a-g])\\s*-?\\s*block|block\\s+([a-g]))\\b');
  if (!m) return null;
  const letter = (m[1] || m[2]);
  const at = m.index + m[0].indexOf(letter, m[0].search(/[a-g]\s*-?\s*block|block\s+[a-g]/));
  // "a block of problems" is not A block: a lone "a" must be typed as a capital.
  if (letter === 'a' && original[at] !== 'A') return null;
  consume(state, m);
  return letter.toUpperCase();
}

// ---------- times ----------
function to24(h, mm, mer) {
  const pm = /^p/.test(mer);
  if (h < 1 || h > 12 || mm > 59) return null;
  return ((h % 12) + (pm ? 12 : 0)) * 60 + mm;
}
/** Try to read a time. Returns { minutes, ambiguous, alt, raw } or null. */
function parseTimeAt(state, sourcePrefix = '') {
  const rules = [
    [`${sourcePrefix}(\\d{1,2})(?::(\\d{2}))?\\s*${MERIDIEM}(?![a-z])`, (m) => {
      const v = to24(+m[m.length - 3], m[m.length - 2] ? +m[m.length - 2] : 0, m[m.length - 1]);
      return v == null ? null : { minutes: v };
    }],
    [`${sourcePrefix}(noon|midday)\\b`, () => ({ minutes: 12 * 60 })],
    [`${sourcePrefix}(midnight)\\b`, () => ({ minutes: 23 * 60 + 59, note: '“Midnight” was read as 11:59 PM that day.' })],
    [`${sourcePrefix}(\\d{1,2}):(\\d{2})(?![\\d:/])`, (m) => {
      const hs = m[m.length - 2], h = +hs, mm = +m[m.length - 1];
      if (h > 23 || mm > 59) return null;
      if (h >= 13 || h === 0 || hs.startsWith('0')) return { minutes: h * 60 + mm };
      return ambiguousHour(h, mm);
    }],
  ];
  for (const [src, fn] of rules) {
    const m = find(state, src);
    if (!m) continue;
    const r = fn(m);
    if (!r) continue;
    consume(state, m);
    return { ...r, raw: m[0].trim() };
  }
  return null;
}
function ambiguousHour(h, mm) {
  // Without am/pm: 7–11 → morning, 12 → noon, 1–6 → afternoon/evening. Always flagged.
  const am = h >= 7 && h <= 11;
  const minutes = (am ? h % 12 : (h % 12) + 12) * 60 + mm;
  const alt = (am ? (h % 12) + 12 : h % 12) * 60 + mm;
  return { minutes, ambiguous: true, alt };
}

// ---------- dates ----------
function resolveMonthDay(today, month, day, yearText) {
  if (yearText) {
    let y = +yearText;
    if (y < 100) y += 2000;
    const iso = makeISODate(y, month, day);
    return iso ? { date: iso } : null;
  }
  const thisYear = +today.slice(0, 4);
  let iso = makeISODate(thisYear, month, day);
  if (!iso) {
    const next = makeISODate(thisYear + 1, month, day); // e.g. Feb 29 in a leap year
    return next ? { date: next } : null;
  }
  const diff = daysBetween(today, iso);
  // A date more than 60 days in the past most likely means next year (e.g. "Jan 4" typed in late December).
  if (diff < -60) {
    const next = makeISODate(thisYear + 1, month, day);
    return next ? { date: next } : null;
  }
  return { date: iso };
}

function weekdayDate(today, wd, qualifier) {
  const diff = (wd - weekdayOf(today) + 7) % 7;
  if (qualifier === 'this' || qualifier === 'this coming' || qualifier === 'coming') {
    return { date: addDays(today, diff === 0 && qualifier !== 'this' ? 7 : diff) };
  }
  if (qualifier === 'next') {
    const soon = addDays(today, diff === 0 ? 7 : diff);
    const later = addDays(soon, 7);
    return { date: soon, ambiguous: true, alt: later, why: 'next' };
  }
  if (diff === 0) {
    return { date: addDays(today, 7), ambiguous: true, alt: today, why: 'today' };
  }
  return { date: addDays(today, diff) };
}

function parseDeadline(state, today) {
  const candidates = [];
  const tryRule = (src, fn) => {
    const re = new RegExp(src, 'ig');
    let m;
    while ((m = re.exec(state.work)) !== null) {
      const r = fn(m);
      if (r) candidates.push({ m, r });
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  tryRule(`${DATE_PREFIX}\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`, (m) => {
    const iso = makeISODate(+m[2], +m[3], +m[4]);
    return iso ? { date: iso } : { invalid: m[0].trim() };
  });
  tryRule(`${DATE_PREFIX}\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b`, (m) => {
    let a = +m[2], b = +m[3];
    let swapped = false;
    if (a > 12 && b <= 12) { [a, b] = [b, a]; swapped = true; } // clearly day/month
    const r = resolveMonthDay(today, a, b, m[4]);
    if (!r) return { invalid: m[0].trim() };
    return swapped ? { ...r, note: `Read “${m[2]}/${m[3]}” as day/month.` } : r;
  });
  tryRule(`${DATE_PREFIX}\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`, (m) => {
    return resolveMonthDay(today, MONTHS[m[2]], +m[3], m[4]) || { invalid: m[0].trim() };
  });
  tryRule(`${DATE_PREFIX}\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s*(\\d{4}))?`, (m) => {
    return resolveMonthDay(today, MONTHS[m[3]], +m[2], m[4]) || { invalid: m[0].trim() };
  });
  tryRule(`${DATE_PREFIX}\\b(?:the\\s+)?day\\s+after\\s+tomorrow\\b`, () => ({ date: addDays(today, 2) }));
  tryRule(`${DATE_PREFIX}\\b(tomorrow|tmrw|tmr|tomorow)(?:\\s+(morning|afternoon|evening|night))?\\b`, (m) => {
    const part = m[3];
    if (part === 'evening' || part === 'night') return { date: addDays(today, 1), time: 23 * 60 + 59, note: `“${part}” was read as 11:59 PM — change it if it's due earlier.` };
    if (part === 'afternoon') return { date: addDays(today, 1), timeMissing: true };
    return { date: addDays(today, 1) };
  });
  tryRule(`${DATE_PREFIX}\\b(tonight|this\\s+evening)\\b`, () => ({ date: today, time: 23 * 60 + 59, note: '“Tonight” was read as 11:59 PM today — change it if it\'s due earlier.' }));
  tryRule(`${DATE_PREFIX}\\b(today)\\b`, () => ({ date: today, timeMissing: true }));
  tryRule(`${DATE_PREFIX}\\bin\\s+${NUM}\\s+days?\\b`, (m) => {
    const n = toNum(m[2]);
    return Number.isInteger(n) && n >= 0 && n < 400 ? { date: addDays(today, n) } : null;
  });
  tryRule(`${DATE_PREFIX}\\bin\\s+a\\s+week\\b`, () => ({ date: addDays(today, 7) }));
  tryRule(`${DATE_PREFIX}\\b(?:(this\\s+coming|this|next|coming)\\s+)?${WD_RE}\\b`, (m) => {
    const q = m[2] ? m[2].replace(/\s+/g, ' ') : '';
    // "sat"/"sun" are too easily confused with words like "SAT prep"; require "due/by/on/this/next".
    if ((m[3] === 'sat' || m[3] === 'sun') && !m[1] && !q) return null;
    return weekdayDate(today, WEEKDAYS[m[3]], q);
  });
  tryRule(`${DATE_PREFIX}\\b(next\\s+week|this\\s+week|end\\s+of\\s+(?:the\\s+)?week|this\\s+weekend|next\\s+weekend|next\\s+month|soon|later)\\b`, (m) => ({ vague: m[0].trim() }));

  // Keep non-overlapping candidates in text order (earlier and longer wins).
  candidates.sort((x, y) => x.m.index - y.m.index || y.m[0].length - x.m[0].length);
  const chosen = [];
  let lastEnd = -1;
  for (const c of candidates) {
    if (c.m.index >= lastEnd) { chosen.push(c); lastEnd = c.m.index + c.m[0].length; }
  }
  if (!chosen.length) return null;
  const main = chosen.find((c) => c.r.date) || chosen[0];
  for (const c of chosen) consume(state, c.m);
  const others = chosen.filter((c) => c !== main);
  return { ...main.r, raw: main.m[0].trim(), others: others.map((c) => c.m[0].trim()) };
}

// ---------- kind & priority ----------
function detectKind(lower) {
  if (/\b(test|quiz|exam|midterm|finals?|assessment)\b/.test(lower)) return { kind: 'test', source: 'text' };
  if (/\b(project|essay|paper|report|presentation|poster|research)\b/.test(lower)) return { kind: 'project', source: 'text' };
  if (/\b(worksheet|homework|hw|problem\s+set|pset|reading|exercises?|assignment|questions)\b/.test(lower)) return { kind: 'assignment', source: 'text' };
  const study = /\b(study|studying|review|revise|revision|prep|prepare|cram)\b/.exec(lower);
  if (study) return { kind: 'test', source: 'guess', word: study[1] };
  return { kind: 'assignment', source: 'default' };
}

function parsePriority(state) {
  const rules = [
    ['\\b(?:priority\\s*[:=]?\\s*)?(high|top)\\s*(?:priority|prio|pri)\\b', 'high'],
    ['\\bpriority\\s*[:=]?\\s*(high|top)\\b', 'high'],
    ['\\b(urgent|important)\\b', 'high'],
    ['!!+', 'high'],
    ['\\blow\\s*(?:priority|prio|pri)\\b', 'low'],
    ['\\bpriority\\s*[:=]?\\s*low\\b', 'low'],
    ['\\b(optional|whenever)\\b', 'low'],
    ['\\b(?:normal|medium|med)\\s*(?:priority|prio|pri)\\b', 'normal'],
  ];
  for (const [src, p] of rules) {
    const m = find(state, src);
    if (m) { consume(state, m); return p; }
  }
  return null;
}

function cleanTitle(original, spans) {
  const chars = original.split('');
  for (const [s, e] of spans) for (let i = s; i < e; i++) chars[i] = ' ';
  let t = chars.join('').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s+([,;:.!?])/g, '$1').replace(/([,;:])(?:[\s,;:]*[,;:])+/g, '$1');
  const edge = /(?:^|[\s,;:.!?\-–—]+)(?:\b(?:due|by|on|for|at|about|around|and|is|it's|its|before)\b)?[\s,;:.!?\-–—]*$/i;
  for (let i = 0; i < 6; i++) {
    const next = t.replace(edge, '').trim();
    if (next === t) break;
    t = next;
  }
  t = t.replace(/^[\s,;:.!?\-–—•*]+/, '').trim();
  if (t && /[a-z]/.test(t[0])) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

/**
 * Parse one line into an editable draft.
 * @param {string} input
 * @param {string} today  current local date 'YYYY-MM-DD' (NOT the selected planning date)
 */
export function parseTaskText(input, today) {
  const original = String(input ?? '').replace(/\s+/g, ' ').trim()
    // A time typed right after a word still counts: "Bio test45 mins" → "Bio test 45 mins" ("45m"/"2h" only with no space)
    .replace(/(\p{L})(\d+(?:\.\d+)?(?:\s*(?:mins?|minutes?|hrs?|hours?)|[mh])\b)/giu, '$1 $2');
  const state = makeState(original);
  const draft = {
    id: newId('d'),
    original,
    title: '',
    kind: 'assignment', kindSource: 'default',
    deadlineDate: null, deadlineTime: null, deadlineBlock: null, deadlineSource: null,
    remainingMin: null, durationSource: null, suggestedMin: null,
    estimateUncertain: false,
    priority: 'normal', prioritySource: 'default',
    firstStep: '',
    flags: [],
    include: true,
  };
  if (!original) {
    flag(state, 'title', 'missing', 'Type what the task is.');
    draft.flags = state.flags;
    return draft;
  }

  // 1. Optional first step ("first step: outline intro") — consumed first so its words aren't parsed.
  const fs = find(state, '\\b(?:first\\s+step|1st\\s+step|start\\s+by|start\\s+with)\\s*[:\\-–]?\\s*(.+)$');
  if (fs) {
    draft.firstStep = original.slice(fs.index + fs[0].length - fs[1].length).replace(/[\s.;,]+$/, '');
    consume(state, fs);
  }

  // 2. Priority
  const p = parsePriority(state);
  if (p) { draft.priority = p; draft.prioritySource = 'text'; }

  // 3. Duration (+ whether it's study time or how long the test lasts)
  let dur = parseDuration(state);
  let testLength = null;
  if (dur) {
    const ctx = durationContext(state, dur);
    if (ctx === 'length') { testLength = dur; dur = null; }
  }

  // 3b. Class block ("D block")
  const block = parseBlock(state, original);

  // 4. Deadline (+ attached time) and any standalone time
  const dl = parseDeadline(state, today);
  let time = null;
  if (dl && dl.time != null) time = { minutes: dl.time, note: dl.note };
  if (!time) time = parseTimeAt(state, '(?:,?\\s*(?:at|by|@|before)\\s*)?');
  if (!time) {
    const bare = find(state, '\\b(?:at|by|@|before)\\s*(\\d{1,2})\\b(?![:/\\d])');
    if (bare && +bare[1] >= 1 && +bare[1] <= 12) {
      time = { ...ambiguousHour(+bare[1], 0), raw: bare[0].trim() };
      consume(state, bare);
    }
  }

  // 5. Kind (title keeps these words)
  const k = detectKind(lowerAscii(original));
  draft.kind = k.kind; draft.kindSource = k.source;
  const isTest = draft.kind === 'test';
  const dlWord = isTest ? 'test date' : 'deadline';

  if (k.source === 'guess') flag(state, 'kind', 'info', `Type guessed as test prep from “${k.word}”. Change it if this is an assignment.`);

  // Deadline outcomes
  if (dl && dl.date) {
    draft.deadlineDate = dl.date;
    draft.deadlineSource = 'text';
    if (dl.ambiguous && dl.why === 'today') {
      flag(state, 'deadline', 'ambiguous', `“${dl.raw}” could mean today or next week. Read as ${formatDate(dl.date, today)}.`,
        [{ label: `Today (${formatDate(dl.alt, today)})`, date: dl.alt }]);
    } else if (dl.ambiguous && dl.why === 'next') {
      flag(state, 'deadline', 'ambiguous', `“${dl.raw}” can mean two dates. Read as ${formatDate(dl.date, today)}.`,
        [{ label: formatDate(dl.alt, today), date: dl.alt }]);
    }
    if (dl.note && dl.time == null) flag(state, 'deadline', 'info', dl.note);
    if (dl.others && dl.others.length) {
      flag(state, 'deadline', 'ambiguous', `Found more than one date (${[dl.raw, ...dl.others].map((s) => `“${s}”`).join(', ')}). Check the ${dlWord}.`);
    }
  } else if (dl && dl.vague) {
    flag(state, 'deadline', 'ambiguous', `“${dl.vague}” isn't a specific day, so no ${dlWord} was set. Pick a date or keep it undated.`);
  } else if (dl && dl.invalid) {
    flag(state, 'deadline', 'ambiguous', `Couldn't read “${dl.invalid}” as a real date. Pick a date or keep it undated.`);
  }

  if (block) {
    draft.deadlineBlock = block;
    if (time) { flag(state, 'deadlineTime', 'info', `Used ${block} block for the time, not ${formatTime12(time.minutes)}.`); time = null; }
    if (!draft.deadlineDate) flag(state, 'deadline', 'missing', `Found ${block} block but no ${dlWord}. Add the date.`);
  }

  if (time) {
    draft.deadlineTime = formatHM(time.minutes);
    if (time.ambiguous) {
      flag(state, 'deadlineTime', 'ambiguous', `No AM/PM given — read as ${formatTime12(time.minutes)}.`,
        [{ label: formatTime12(time.alt), time: formatHM(time.alt) }]);
    }
    if (time.note) flag(state, 'deadlineTime', 'info', time.note);
    if (!draft.deadlineDate) {
      flag(state, 'deadline', 'missing', `Found a time (${formatTime12(time.minutes)}) but no date. Add the date, or clear the time to keep it undated.`);
    }
  }

  if (!draft.deadlineDate && !state.flags.some((f) => f.field === 'deadline')) {
    if (/\bdue\b/.test(state.work)) {
      flag(state, 'deadline', 'missing', `Found “due” but no date I could read. Add the ${dlWord} or keep it undated.`);
      state.work = state.work.replace(/\bdue\b/, '   ');
      const m = /\bdue\b/i.exec(original);
      if (m) state.spans.push([m.index, m.index + 3]);
    } else {
      flag(state, 'deadline', 'missing', `No ${dlWord} found. Add one, or keep it undated — undated work is only planned in spare time.`);
    }
  }

  if (draft.deadlineDate) {
    const diff = daysBetween(today, draft.deadlineDate);
    if (diff < 0) flag(state, 'deadline', 'warning', `${formatDate(draft.deadlineDate, today)} has already passed. Check the date.`);
    else if (diff === 0 && !draft.deadlineTime && !draft.deadlineBlock) flag(state, 'deadlineTime', 'warning', 'Due today with no time. Date-only deadlines count as due at the start of the day — add the time it\'s due so Blockwise can plan before it.');
    else if (diff > 180) flag(state, 'deadline', 'warning', `${formatDate(draft.deadlineDate, today)} is more than six months away. Check the date.`);
    if (dl && dl.timeMissing && diff > 0 && !draft.deadlineBlock) flag(state, 'deadlineTime', 'info', 'If it\'s due at a specific time that day, add it.');
  }

  // Duration outcomes
  if (dur) {
    draft.remainingMin = dur.minutes;
    draft.durationSource = 'text';
    draft.estimateUncertain = dur.uncertain;
    if (dur.uncertain) flag(state, 'duration', 'info', `Marked “not sure” because you wrote “${dur.raw}”.`);
    if (dur.tooLong) flag(state, 'duration', 'warning', 'Estimates are capped at 24 hours. Consider splitting this into parts.');
  } else {
    draft.suggestedMin = SUGGESTED_MINUTES[draft.kind];
    draft.remainingMin = draft.suggestedMin;
    draft.durationSource = 'suggested';
    draft.estimateUncertain = true;
    flag(state, 'duration', 'missing', testLength
      ? `Read “${testLength.raw}” as how long the test lasts, not study time. ${draft.suggestedMin} min of study is a starting guess — change it if you know better.`
      : `No time estimate found. ${draft.suggestedMin} min is a starting guess, not from your text — change it if you know better.`);
  }

  // Title
  draft.title = cleanTitle(original, state.spans);
  if (!draft.title) {
    draft.title = original.slice(0, 120);
    flag(state, 'title', 'missing', 'Couldn\'t separate a title from the details. Edit the title.');
  }
  if (draft.title.length > 120) {
    draft.title = draft.title.slice(0, 120).trim();
    flag(state, 'title', 'warning', 'Title shortened to 120 characters.');
  }

  draft.flags = state.flags;
  return draft;
}

/** True when the parser was unsure about something, so the original text should be kept. */
export const draftIsUncertain = (d) => d.flags.some((f) => f.level === 'missing' || f.level === 'ambiguous');

/** Reviewed bulk paste: one task per line, at most `max` lines. Bullets/numbering are stripped. */
export function parseBulk(text, today, max = 20) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•–]|\[\s?[xX]?\s?\]|\d{1,2}[.)])\s+/, '').trim())
    .filter((l) => l.length > 0);
  const drafts = lines.slice(0, max).map((l, i) => ({ ...parseTaskText(l, today), line: i + 1 }));
  return { drafts, total: lines.length, truncated: lines.length > max, max };
}

/**
 * Validate an edited draft. Returns { ok, errors: {field: message} }.
 * Deadline time without date is an error; everything else optional.
 */
export function validateDraft(d) {
  const errors = {};
  const title = String(d.title ?? '').trim();
  if (!title) errors.title = 'Add a title.';
  else if (title.length > 120) errors.title = 'Keep the title under 120 characters.';
  if (!KINDS.includes(d.kind)) errors.kind = 'Choose a type.';
  if (!PRIORITIES.includes(d.priority)) errors.priority = 'Choose a priority.';
  if (d.deadlineDate && !isValidISODate(d.deadlineDate)) errors.deadlineDate = 'Enter a real date.';
  if (d.deadlineTime) {
    if (parseHM(d.deadlineTime) == null) errors.deadlineTime = 'Enter a time like 23:59.';
    else if (!d.deadlineDate) errors.deadlineTime = 'Add a date for this time, or clear the time.';
  }
  if (d.deadlineBlock != null && !BLOCK_LETTERS.includes(d.deadlineBlock)) errors.deadlineBlock = 'Pick a block from A to G.';
  const mins = Number(d.remainingMin);
  if (d.remainingMin === '' || d.remainingMin == null || !Number.isFinite(mins) || mins <= 0 || !Number.isInteger(mins)) {
    errors.remainingMin = 'Enter whole minutes (1 or more).';
  } else if (mins > 24 * 60) errors.remainingMin = 'Keep estimates to 24 hours or less — split bigger work.';
  if (String(d.firstStep ?? '').length > 200) errors.firstStep = 'Keep the first step under 200 characters.';
  return { ok: Object.keys(errors).length === 0, errors };
}

const BLOCK_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
/** A stored deadline. With a block, the time is filled in from the timetable when the plan is made. */
export function makeDeadline(date, time, block) {
  return block ? { date, time: null, block } : { date, time: time || null };
}

/** Convert a validated draft into a stored task. */
export function draftToTask(d, nowIso) {
  const mins = Number(d.remainingMin);
  const task = {
    id: newId('t'),
    title: String(d.title).trim(),
    kind: d.kind,
    deadline: d.deadlineDate ? makeDeadline(d.deadlineDate, d.deadlineTime, d.deadlineBlock) : null,
    remainingMin: mins,
    estimateUncertain: !!d.estimateUncertain,
    estimateSource: d.durationSource === 'suggested' && mins === d.suggestedMin ? 'suggested' : 'user',
    priority: d.priority,
    firstStep: String(d.firstStep ?? '').trim(),
    status: 'open',
    lateWork: false,
    progress: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (draftIsUncertain(d) && d.original) task.sourceText = d.original.slice(0, 500);
  return task;
}

export { MIN_SESSION };
