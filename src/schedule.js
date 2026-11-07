// Free time and placement. Knows nothing about ranking — it places what it is asked to place.
import { parseHM, roundUpTo } from './dates.js';
import { MIN_SESSION, breakAfter } from './model.js';

/** Merge overlapping or touching [start, end) intervals. Input is not mutated. */
export function mergeIntervals(list) {
  const sorted = list.filter((i) => i.end > i.start).map((i) => ({ start: i.start, end: i.end })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push(iv);
  }
  return out;
}

/** windows − busy (both lists of intervals). */
export function subtractIntervals(windows, busy) {
  let result = mergeIntervals(windows);
  for (const b of mergeIntervals(busy)) {
    const next = [];
    for (const w of result) {
      if (b.end <= w.start || b.start >= w.end) { next.push(w); continue; }
      if (b.start > w.start) next.push({ start: w.start, end: b.start });
      if (b.end < w.end) next.push({ start: b.end, end: w.end });
    }
    result = next;
  }
  return result;
}

export function blockInterval(b) {
  const start = parseHM(b.start), end = parseHM(b.end);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

/**
 * Free study time for one date.
 * Free = (study window ∪ free blocks, clipped where study hours end) − busy blocks − time already passed today.
 */
export function computeFreeSlots({ date, today, nowMin, studyStart, studyStop, blocks }) {
  const errors = [], warnings = [];
  const noStudy = studyStart == null && studyStop == null; // a day with no usual study time (free blocks still count)
  const s = noStudy ? null : parseHM(studyStart), e = noStudy ? null : parseHM(studyStop);
  if (!noStudy && (s == null || e == null)) errors.push('Set when study hours start and end.');
  else if (!noStudy && e <= s) errors.push('Study hours must end after they start.');
  if (date < today) errors.push('This date has already passed, so it can\'t be planned.');
  const dayBlocks = (blocks || []).filter((b) => b.date === date);
  const busy = [], freeExtra = [];
  for (const b of dayBlocks) {
    const iv = blockInterval(b);
    if (!iv) continue;
    if (b.kind === 'free') freeExtra.push({ ...iv, block: b });
    else busy.push(iv);
  }
  const busyMerged = mergeIntervals(busy);
  if (errors.length) return { ok: false, errors, warnings, slots: [], busy: busyMerged, totalFree: 0, stop: e, start: s };

  const windows = noStudy ? [] : [{ start: s, end: e }];
  const cap = noStudy ? 1440 : e;
  for (const f of freeExtra) {
    if (f.start >= cap) { warnings.push(`Free block “${f.block.label || 'Free time'}” starts after study hours end, so it isn't used.`); continue; }
    if (f.end > cap) warnings.push(`Free block “${f.block.label || 'Free time'}” runs past the end of study hours; only the part before is used.`);
    windows.push({ start: f.start, end: Math.min(f.end, cap) });
  }
  let slots = subtractIntervals(windows, busyMerged);
  let floor = null;
  if (date === today) {
    floor = roundUpTo(nowMin, 5);
    slots = slots.map((iv) => ({ start: Math.max(iv.start, floor), end: iv.end })).filter((iv) => iv.end > iv.start);
    if (!noStudy && nowMin >= e) warnings.push('Study hours are over for today.');
  }
  const totalFree = slots.reduce((sum, iv) => sum + iv.end - iv.start, 0);
  const lastEnd = windows.reduce((m, w) => Math.max(m, w.end), 0);
  return { ok: true, errors, warnings, slots, busy: busyMerged, totalFree, stop: noStudy ? lastEnd : e, start: s, floor, noStudy };
}

/**
 * How long the next piece of a task should be.
 * R = minutes of the task not yet placed, target = minutes wanted now, S = session length, A = minutes available here.
 * Never returns a piece shorter than MIN_SESSION unless it finishes the task, and avoids leaving a scrap behind.
 */
export function chunkSize(R, target, S, A, MIN = MIN_SESSION) {
  if (!(R > 0) || !(A > 0) || !(target > 0)) return 0;
  let c = Math.min(S, target, R);
  if (c < MIN) c = Math.min(R, MIN);
  if (R - c > 0 && R - c < MIN) c = R; // finish instead of leaving a scrap (runs up to MIN−1 longer)
  if (c > A) {
    c = A;
    if (R - c > 0 && R - c < MIN) c = R - MIN; // leave a usable remainder instead
  }
  c = Math.floor(c);
  if (c <= 0) return 0;
  if (c < MIN && c < R) return 0;
  return c;
}

/** Places sessions earliest-first into free intervals, reserving a short break after each one. */
export class Placer {
  constructor(slots, { maxSessions = 60 } = {}) {
    this.free = slots.map((s) => ({ start: s.start, end: s.end }));
    this.sessions = [];
    this.maxSessions = maxSessions;
  }

  /** @returns minutes placed (0 if nothing fits) */
  place({ taskId, remaining, target, sessionLen, cutoff = null, purpose }) {
    if (this.sessions.length >= this.maxSessions) return 0;
    for (const iv of this.free) {
      if (iv.end <= iv.start) continue;
      if (cutoff != null && iv.start >= cutoff) break; // later intervals are past the deadline too
      const end = cutoff != null ? Math.min(iv.end, cutoff) : iv.end;
      const c = chunkSize(remaining, target, sessionLen, end - iv.start);
      if (c <= 0) continue;
      const start = iv.start, stop = start + c;
      this.sessions.push({ type: 'session', taskId, start, end: stop, minutes: c, purpose });
      iv.start = Math.min(stop + breakAfter(c), iv.end);
      return c;
    }
    return 0;
  }

  /** Sessions sorted by time, with a break shown only where a session directly follows another. */
  timeline() {
    const sessions = [...this.sessions].sort((a, b) => a.start - b.start);
    const items = [];
    sessions.forEach((s, i) => {
      const prev = sessions[i - 1];
      if (prev && s.start > prev.end && s.start - prev.end <= 10 && s.start - prev.end === breakAfter(prev.minutes)) {
        items.push({ type: 'break', start: prev.end, end: s.start, minutes: s.start - prev.end });
      }
      items.push(s);
    });
    return items;
  }
}
