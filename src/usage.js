/**
 * Usage counts (approved by the school for the pilot).
 *
 * A few step signals, so we can see whether students try Blockwise and come back:
 *   first_visit · open (once a day) · setup_done · first_plan · active (once a day) · return_w2
 * Each phone works out its own milestones and sends each one once. A signal holds only the step, the date,
 * the app version, an optional link label (?src=xc) and a random one-time code so a retried send isn't
 * counted twice. Never task titles, deadlines, schedules, names or typed text — and no ID that follows the phone.
 *
 * Everything lives under its own storage key (not in the plan, not in backups). Start over clears it.
 */
import { daysBetween } from './dates.js';

export const USAGE_KEY = 'blockwise.usage';
export const EVENT_TYPES = ['first_visit', 'open', 'setup_done', 'first_plan', 'active', 'return_w2'];
const SIGNAL_KEYS = ['e', 'd', 'id', 'v', 'src', 'fp'];
const MAX_QUEUE = 100;
const PER_SEND = 25;
const SRC_RE = /^[a-z0-9-]{1,20}$/;

/** A random one-time code (16 lowercase letters/digits) — identifies one signal, never the phone. */
export function oneTimeCode(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(rand(16), (x) => chars[x % 36]).join('');
}

export function cleanSrc(s) { return typeof s === 'string' && SRC_RE.test(s) ? s : null; }

/**
 * @param {object} o
 * @param {string} o.endpoint   where signals go ('' turns sending off)
 * @param {string} o.version    app version label
 * @param {(k:string)=>string|null} o.get   storage read
 * @param {(k:string,v:string)=>void} o.set storage write
 * @param {Function} o.fetchFn  fetch
 */
export function createUsage({ endpoint, version, get, set, fetchFn, code = oneTimeCode }) {
  let sending = false;

  const read = () => {
    try {
      const v = JSON.parse(get(USAGE_KEY) || 'null');
      if (v && typeof v === 'object' && Array.isArray(v.queue)) return v;
    } catch { /* unreadable: start over */ }
    return { queue: [] };
  };
  const write = (m) => { try { set(USAGE_KEY, JSON.stringify(m)); } catch { /* storage full or blocked */ } };

  const add = (m, e, d, extra = {}) => {
    const ev = { e, d, id: code(), v: version };
    if (m.src) ev.src = m.src;
    Object.assign(ev, extra);
    m.queue.push(ev);
    if (m.queue.length > MAX_QUEUE) m.queue.splice(0, m.queue.length - MAX_QUEUE);
  };

  /** One-time milestones that follow from what's saved (also catches students who started before counting). */
  const milestones = (m, today, { hasSchool, hasTask }) => {
    if (hasSchool && !m.setupDone) { m.setupDone = true; add(m, 'setup_done', today); }
    if (hasTask && !m.firstPlan) { m.firstPlan = today; add(m, 'first_plan', today); }
  };

  return {
    /** Has the student been shown the note about counting? (Welcome screen or the one-time notice.) */
    noticeShown: () => !!read().noticeShown,
    noticeOk: () => !!read().noticeOk,
    isOff: () => !!read().off,
    markNoticeShown() { const m = read(); if (!m.noticeShown) { m.noticeShown = true; write(m); } },
    markNoticeOk() { const m = read(); m.noticeShown = true; m.noticeOk = true; write(m); },
    /** Off: stop counting and drop anything not yet sent. On: start again from here. */
    setOff(off) { const m = read(); m.off = !!off; m.noticeShown = true; m.noticeOk = true; if (off) m.queue = []; write(m); },

    /** The app is open and visible on `today` (real mode only — the caller checks). */
    opened(today, flags, srcParam) {
      const m = read();
      if (!m.firstVisit) { m.firstVisit = true; const src = cleanSrc(srcParam); if (src) m.src = src; add(m, 'first_visit', today); }
      if (m.lastOpen !== today) { m.lastOpen = today; add(m, 'open', today); }
      milestones(m, today, flags);
      if (m.firstPlan && !m.w2) {
        const n = daysBetween(m.firstPlan, today);
        if (n >= 7 && n <= 13) { m.w2 = 'sent'; add(m, 'return_w2', today, { fp: m.firstPlan }); }
        else if (n > 13) m.w2 = 'missed';
      }
      write(m);
    },

    /** Something meaningful changed: a task added/edited/finished, progress, or the schedule. */
    changed(today, flags) {
      const m = read();
      if (m.lastActive !== today) { m.lastActive = today; add(m, 'active', today); }
      milestones(m, today, flags);
      write(m);
    },

    pending: () => read().queue.length,

    /** Send what's waiting. Kept on failure (offline, blocked) and retried later with the same codes. */
    async flush({ keepalive = false } = {}) {
      if (sending || !endpoint) return;
      sending = true;
      try {
        for (let round = 0; round < 4; round++) {
          const batch = read().queue.slice(0, PER_SEND)
            .map((ev) => Object.fromEntries(SIGNAL_KEYS.filter((k) => ev[k] != null).map((k) => [k, ev[k]])));
          if (!batch.length) return;
          let ok = false;
          try {
            const r = await fetchFn(endpoint, {
              method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify({ events: batch }), keepalive, credentials: 'omit', cache: 'no-store',
            });
            ok = !!(r && r.ok); // the counter answered; it keeps valid signals and ignores repeats
          } catch { ok = false; }
          if (!ok) return;
          const sent = new Set(batch.map((x) => x.id));
          const m = read();
          m.queue = m.queue.filter((x) => !sent.has(x.id));
          write(m);
        }
      } finally { sending = false; }
    },
  };
}
