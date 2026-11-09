// Local persistence, validation, export and import. No network, no accounts.
import { DEFAULT_SETTINGS, KINDS, PRIORITIES, BLOCK_CATEGORIES } from './model.js';
import { isValidISODate, parseHM } from './dates.js';

export const SCHEMA_VERSION = 1;
export const STORAGE_KEY = 'blockwise.v1';
export const DEMO_KEY = 'blockwise.demo.v1';
export const MODE_KEY = 'blockwise.mode';
export const UNREADABLE_PREFIX = 'blockwise.unreadable.';
export const BACKUP_FORMAT = 'blockwise-backup';
export const MAX_IMPORT_BYTES = 1_000_000;
const LIMITS = { tasks: 1000, blocks: 5000, progress: 500, plans: 60, days: 400 };

export function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, settings: { ...DEFAULT_SETTINGS }, tasks: [], blocks: [], days: {}, plans: {}, prefs: {} };
}

const BLOCK_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max = 10000) => typeof v === 'string' && v.length <= max;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isHM = (v) => typeof v === 'string' && parseHM(v) != null;
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

function cleanTask(t, i, errors) {
  const where = `Task ${i + 1}`;
  if (!isObj(t)) { errors.push(`${where} is not a valid record.`); return null; }
  const bad = (msg) => { errors.push(`${where}: ${msg}`); return null; };
  if (!isId(t.id)) return bad('missing or invalid id.');
  if (!isStr(t.title, 200) || !t.title.trim()) return bad('missing title.');
  if (!KINDS.includes(t.kind)) return bad('unknown type.');
  let deadline = null;
  if (t.deadline != null) {
    if (!isObj(t.deadline) || !isValidISODate(t.deadline.date)) return bad('invalid deadline date.');
    if (t.deadline.time != null && !isHM(t.deadline.time)) return bad('invalid deadline time.');
    deadline = { date: t.deadline.date, time: t.deadline.time ?? null };
    if (t.deadline.block != null) {
      if (!BLOCK_LETTERS.includes(t.deadline.block)) return bad('invalid class block.');
      deadline.block = t.deadline.block;
    }
  }
  if (!isInt(t.remainingMin, 0, 1440)) return bad('invalid remaining minutes.');
  if (!PRIORITIES.includes(t.priority)) return bad('invalid priority.');
  if (t.status !== 'open' && t.status !== 'done') return bad('invalid status.');
  if (t.firstStep != null && !isStr(t.firstStep, 200)) return bad('first step too long.');
  if (t.sourceText != null && !isStr(t.sourceText, 500)) return bad('original text too long.');
  const progress = [];
  if (t.progress != null) {
    if (!Array.isArray(t.progress) || t.progress.length > LIMITS.progress) return bad('invalid progress history.');
    for (const p of t.progress) {
      if (!isObj(p) || !isValidISODate(p.date) || !isInt(p.workedMin, 0, 1440) ||
          !isInt(p.remainingBefore, 0, 1440) || !isInt(p.remainingAfter, 0, 1440) || !isStr(p.at, 40)) {
        return bad('invalid progress entry.');
      }
      progress.push({ at: p.at, date: p.date, workedMin: p.workedMin, remainingBefore: p.remainingBefore, remainingAfter: p.remainingAfter });
    }
  }
  for (const k of ['createdAt', 'updatedAt', 'completedAt']) if (t[k] != null && !isStr(t[k], 40)) return bad(`invalid ${k}.`);
  const out = {
    id: t.id, title: t.title.trim(), kind: t.kind, deadline, remainingMin: t.remainingMin,
    estimateUncertain: !!t.estimateUncertain,
    estimateSource: t.estimateSource === 'suggested' ? 'suggested' : 'user',
    priority: t.priority, firstStep: (t.firstStep ?? '').trim(), status: t.status, lateWork: !!t.lateWork,
    progress, createdAt: t.createdAt ?? '', updatedAt: t.updatedAt ?? '',
  };
  if (t.completedAt) out.completedAt = t.completedAt;
  if (t.sourceText) out.sourceText = t.sourceText;
  return out;
}

function cleanBlock(b, i, errors) {
  const bad = (msg) => { errors.push(`Schedule item ${i + 1}: ${msg}`); return null; };
  if (!isObj(b)) return bad('not a valid record.');
  if (!isId(b.id)) return bad('missing or invalid id.');
  if (!isValidISODate(b.date)) return bad('invalid date.');
  if (!isHM(b.start) || !isHM(b.end) || parseHM(b.end) <= parseHM(b.start)) return bad('invalid times (end must be after start).');
  if (b.kind !== 'busy' && b.kind !== 'free') return bad('invalid kind.');
  if (b.label != null && !isStr(b.label, 80)) return bad('label too long.');
  const category = BLOCK_CATEGORIES.includes(b.category) ? b.category : (b.kind === 'free' ? 'free' : 'other');
  return { id: b.id, date: b.date, start: b.start, end: b.end, label: (b.label ?? '').trim(), kind: b.kind, category };
}

/** Usual week: study hours per weekday ('0'–'6' → {start, stop} or null for none) and repeating items. */
function cleanWeek(w, errors) {
  if (!isObj(w)) { errors.push('Usual week is invalid.'); return null; }
  const out = { study: {}, items: [] };
  if (w.study != null) {
    if (!isObj(w.study)) { errors.push('Usual study hours are invalid.'); return null; }
    for (const [k, v] of Object.entries(w.study)) {
      if (!/^[0-6]$/.test(k)) { errors.push('Usual study hours use an unknown day.'); return null; }
      if (v === null) { out.study[k] = null; continue; }
      if (!isObj(v) || !isHM(v.start) || !isHM(v.stop) || parseHM(v.stop) <= parseHM(v.start)) { errors.push('Usual study hours have invalid times.'); return null; }
      out.study[k] = { start: v.start, stop: v.stop };
    }
  }
  if (w.items != null) {
    if (!Array.isArray(w.items) || w.items.length > 200) { errors.push('Usual week items are invalid.'); return null; }
    const ids = new Set();
    for (const [i, it] of w.items.entries()) {
      const bad = (m) => { errors.push(`Usual week item ${i + 1}: ${m}`); return null; };
      if (!isObj(it) || !isId(it.id) || ids.has(it.id)) return bad('missing or duplicate id.');
      if (!Array.isArray(it.days) || !it.days.length || !it.days.every((d) => isInt(d, 0, 6))) return bad('invalid days.');
      if (!isHM(it.start) || !isHM(it.end) || parseHM(it.end) <= parseHM(it.start)) return bad('invalid times.');
      if (it.kind !== 'busy' && it.kind !== 'free') return bad('invalid kind.');
      if (it.label != null && !isStr(it.label, 80)) return bad('label too long.');
      ids.add(it.id);
      out.items.push({ id: it.id, days: [...new Set(it.days)].sort(), start: it.start, end: it.end, kind: it.kind,
        label: (it.label ?? '').trim(), category: BLOCK_CATEGORIES.includes(it.category) ? it.category : (it.kind === 'free' ? 'free' : 'other') });
    }
  }
  return out;
}

function cleanPlan(p) {
  if (!isObj(p) || !isValidISODate(p.date) || !isStr(p.fingerprint, 64) || !Array.isArray(p.items) || !isObj(p.tasks)) return null;
  for (const it of p.items) {
    if (!isObj(it) || !isStr(it.id, 16) || !['session', 'break', 'busy'].includes(it.type) ||
        !isInt(it.start, 0, 1440) || !isInt(it.end, 0, 1440)) return null;
    if (it.type === 'session' && (!isId(it.taskId) || !isInt(it.minutes, 1, 1440))) return null;
  }
  // Plans are derived data; keep them as-is once the shape checks pass (text is rendered safely).
  return JSON.parse(JSON.stringify(p));
}

/**
 * Strictly validate and normalize a saved or imported state.
 * Returns { ok, state, errors, notes }. Never throws.
 */
export function validateState(raw) {
  const errors = [], notes = [];
  if (!isObj(raw)) return { ok: false, errors: ['The data is not a Blockwise data object.'], notes };
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, errors: [typeof raw.schemaVersion === 'number' && raw.schemaVersion > SCHEMA_VERSION
      ? 'This data was made by a newer version of Blockwise.'
      : 'Unknown data version.'], notes };
  }
  const settings = { ...DEFAULT_SETTINGS };
  if (raw.settings != null) {
    if (!isObj(raw.settings)) errors.push('Settings are invalid.');
    else {
      if (raw.settings.studyStart != null) isHM(raw.settings.studyStart) ? (settings.studyStart = raw.settings.studyStart) : errors.push('Default start time is invalid.');
      if (raw.settings.studyStop != null) isHM(raw.settings.studyStop) ? (settings.studyStop = raw.settings.studyStop) : errors.push('Default end of study hours is invalid.');
      if (raw.settings.sessionMin != null) isInt(raw.settings.sessionMin, 10, 120) ? (settings.sessionMin = raw.settings.sessionMin) : errors.push('Session length is invalid.');
      if (raw.settings.school != null) {
        const sc = raw.settings.school;
        const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
        if (!isObj(sc) || sc.id !== 'middlesex' || !Array.isArray(sc.freeBlocks) || !sc.freeBlocks.every((b) => letters.includes(b)) ||
            (sc.freeExt != null && (!Array.isArray(sc.freeExt) || !sc.freeExt.every((b) => letters.map((l) => `${l}x`).includes(b)))) ||
            (sc.keepFree != null && (!Array.isArray(sc.keepFree) || !sc.keepFree.every((b) => letters.includes(b)))) ||
            !isObj(sc.anchor) || !isValidISODate(sc.anchor.monday) || !['BF', 'ADB'].includes(sc.anchor.type)) {
          errors.push('School schedule settings are invalid.');
        } else {
          settings.school = { id: sc.id, freeBlocks: [...new Set(sc.freeBlocks)].sort(), freeExt: [...new Set(sc.freeExt || [])].sort(), anchor: { monday: sc.anchor.monday, type: sc.anchor.type } };
          const keep = [...new Set(sc.keepFree || [])].filter((b) => sc.freeBlocks.includes(b)).sort();
          if (keep.length) settings.school.keepFree = keep;
        }
      }
      if (raw.settings.week != null) {
        const w = cleanWeek(raw.settings.week, errors);
        if (w) settings.week = w;
      }
    }
  }
  if (!Array.isArray(raw.tasks)) errors.push('Tasks are missing.');
  else if (raw.tasks.length > LIMITS.tasks) errors.push(`Too many tasks (over ${LIMITS.tasks}).`);
  if (!Array.isArray(raw.blocks)) errors.push('Schedule items are missing.');
  else if (raw.blocks.length > LIMITS.blocks) errors.push(`Too many schedule items (over ${LIMITS.blocks}).`);
  if (errors.length) return { ok: false, errors, notes };

  const tasks = raw.tasks.map((t, i) => cleanTask(t, i, errors));
  const blocks = raw.blocks.map((b, i) => cleanBlock(b, i, errors));
  const ids = new Set();
  for (const t of tasks) if (t) { if (ids.has(t.id)) errors.push(`Duplicate task id ${t.id}.`); ids.add(t.id); }
  const bids = new Set();
  for (const b of blocks) if (b) { if (bids.has(b.id)) errors.push(`Duplicate schedule id ${b.id}.`); bids.add(b.id); }

  const days = {};
  if (raw.days != null) {
    if (!isObj(raw.days) || Object.keys(raw.days).length > LIMITS.days) errors.push('Day settings are invalid.');
    else for (const [date, d] of Object.entries(raw.days)) {
      if (!isValidISODate(date) || !isObj(d)) { errors.push(`Day settings for ${String(date).slice(0, 20)} are invalid.`); continue; }
      const out = {};
      if (d.studyStart != null) { if (isHM(d.studyStart)) out.studyStart = d.studyStart; else errors.push(`Start time for ${date} is invalid.`); }
      if (d.studyStop != null) { if (isHM(d.studyStop)) out.studyStop = d.studyStop; else errors.push(`End of study hours for ${date} is invalid.`); }
      if (d.energy != null) { if (['low', 'normal', 'high'].includes(d.energy)) out.energy = d.energy; else errors.push(`Energy for ${date} is invalid.`); }
      if (d.skipped != null) {
        if (Array.isArray(d.skipped) && d.skipped.every(isId)) out.skipped = [...new Set(d.skipped)];
        else errors.push(`Skipped tasks for ${date} are invalid.`);
      }
      if (d.noStudy != null) { if (typeof d.noStudy === 'boolean') { if (d.noStudy) out.noStudy = true; } else errors.push(`Busy-tonight flag for ${date} is invalid.`); }
      if (d.noClasses != null) { if (typeof d.noClasses === 'boolean') { if (d.noClasses) out.noClasses = true; } else errors.push(`No-class flag for ${date} is invalid.`); }
      if (d.skipBlocks != null) {
        if (Array.isArray(d.skipBlocks) && d.skipBlocks.every((b) => BLOCK_LETTERS.includes(b))) { if (d.skipBlocks.length) out.skipBlocks = [...new Set(d.skipBlocks)].sort(); }
        else errors.push(`Kept-free blocks for ${date} are invalid.`);
      }
      if (d.off != null) {
        if (Array.isArray(d.off) && d.off.every(isId)) out.off = [...new Set(d.off)];
        else errors.push(`Usual-week changes for ${date} are invalid.`);
      }
      days[date] = out;
    }
  }
  const plans = {};
  if (raw.plans != null) {
    if (!isObj(raw.plans)) errors.push('Saved plans are invalid.');
    else {
      let dropped = 0;
      for (const [date, p] of Object.entries(raw.plans).slice(0, LIMITS.plans)) {
        const cp = isValidISODate(date) ? cleanPlan(p) : null;
        if (cp && cp.date === date) plans[date] = cp; else dropped++;
      }
      if (dropped) notes.push(`${dropped} saved plan(s) couldn't be read and were left out. You can make a new plan.`);
    }
  }
  const prefs = {};
  if (isObj(raw.prefs)) for (const [k, v] of Object.entries(raw.prefs)) if (typeof v === 'boolean' && /^[a-zA-Z]{1,40}$/.test(k)) prefs[k] = v;

  if (errors.length) return { ok: false, errors: errors.slice(0, 20), notes };
  return { ok: true, errors, notes, state: { schemaVersion: SCHEMA_VERSION, settings, tasks, blocks, days, plans, prefs } };
}

export function summarizeState(state) {
  const tasks = state.tasks || [];
  return {
    tasks: tasks.length,
    openTasks: tasks.filter((t) => t.status === 'open').length,
    doneTasks: tasks.filter((t) => t.status === 'done').length,
    blocks: (state.blocks || []).length,
    plans: Object.keys(state.plans || {}).length,
  };
}

export const isStateEmpty = (state) => !(state.tasks || []).length && !(state.blocks || []).length;

export function exportPayload(state, now = new Date()) {
  return { app: 'Blockwise', format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), data: state };
}

/** Parse and validate a backup file's text. Never touches stored data. */
export function parseImport(text) {
  if (typeof text !== 'string') return { ok: false, errors: ['Could not read the file.'] };
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, errors: ['The file is too large to be a Blockwise backup.'] };
  let obj;
  try { obj = JSON.parse(text); } catch { return { ok: false, errors: ['The file is not valid JSON.'] }; }
  if (!isObj(obj) || obj.format !== BACKUP_FORMAT || !isObj(obj.data)) {
    return { ok: false, errors: ['This file is not a Blockwise backup.'] };
  }
  const v = validateState(obj.data);
  if (!v.ok) return { ok: false, errors: v.errors };
  return { ok: true, state: v.state, notes: v.notes, summary: { ...summarizeState(v.state), exportedAt: isStr(obj.exportedAt, 40) ? obj.exportedAt : null } };
}

/**
 * Wraps localStorage (or any Storage-like object). Every call is guarded:
 * storage can be missing, blocked, full, or hold malformed data.
 */
export function createStore(getStorage) {
  let storage = null, available = false;
  try {
    storage = getStorage();
    const k = '__blockwise_probe__';
    storage.setItem(k, '1');
    storage.removeItem(k);
    available = true;
  } catch { available = false; storage = null; }

  return {
    available,
    get(key) { try { return available ? storage.getItem(key) : null; } catch { return null; } },
    set(key, value) {
      if (!available) return { ok: false, error: 'unavailable' };
      try { storage.setItem(key, value); return { ok: true }; } catch (e) {
        return { ok: false, error: e && /quota/i.test(String(e.name) + String(e.message)) ? 'full' : 'failed' };
      }
    },
    remove(key) { try { if (available) storage.removeItem(key); } catch { /* ignore */ } },
    /** Read a state. status: 'empty' | 'ok' | 'unreadable' | 'unavailable' */
    readState(key) {
      if (!available) return { status: 'unavailable', state: emptyState() };
      let raw;
      try { raw = storage.getItem(key); } catch { return { status: 'unavailable', state: emptyState() }; }
      if (raw == null) return { status: 'empty', state: emptyState() };
      let obj;
      try { obj = JSON.parse(raw); } catch { return { status: 'unreadable', state: emptyState(), raw, errors: ['Saved data is not valid JSON.'] }; }
      const v = validateState(obj);
      if (!v.ok) return { status: 'unreadable', state: emptyState(), raw, errors: v.errors };
      return { status: 'ok', state: v.state, notes: v.notes };
    },
    writeState(key, state) { return this.set(key, JSON.stringify(state)); },
    /** Keep unreadable data aside instead of overwriting it. Returns the key used, or null. */
    keepAside(raw, now = new Date()) {
      const key = UNREADABLE_PREFIX + now.toISOString().replace(/[:.]/g, '-');
      return this.set(key, raw).ok ? key : null;
    },
  };
}
