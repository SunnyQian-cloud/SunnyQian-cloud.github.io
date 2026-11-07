// Builds a day plan: rank (rank.js) → allocate minutes in bounded passes → place (schedule.js).
import { localParts, parseHM, formatTime12, formatDuration, roundUpTo, toISODate, weekdayOf, addDays, daysBetween } from './dates.js';
import { SCHOOLS } from './schools/middlesex.js';
import { DEFAULT_SETTINGS, effectiveSessionLength, MIN_SESSION, KIND_LABELS } from './model.js';
import { rankTasks } from './rank.js';
import { computeFreeSlots, Placer, blockInterval } from './schedule.js';

export const LIMITS = Object.freeze({ maxTasks: 100, maxSessions: 60, maxRounds: 200 });

/**
 * Effective study settings for a date.
 * Order: this-date override → usual week for that weekday (null = no study time that day) → defaults.
 */
export function daySettings(state, date) {
  const s = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  const day = (state.days && state.days[date]) || {};
  const week = s.week && s.week.study ? s.week.study : {};
  const wd = String(weekdayOf(date));
  const usual = wd in week ? week[wd] : { start: s.studyStart, stop: s.studyStop };
  const hasOverride = !!(day.studyStart && day.studyStop);
  const study = day.noStudy ? null : hasOverride ? { start: day.studyStart, stop: day.studyStop } : usual;
  return {
    studyStart: study ? study.start : null,
    studyStop: study ? study.stop : null,
    sessionMin: s.sessionMin,
    energy: day.energy || null,
    skipped: Array.isArray(day.skipped) ? day.skipped : [],
    off: Array.isArray(day.off) ? day.off : [],
    hasOverride,
    noStudy: !!day.noStudy,
  };
}

/** Monday of the week containing `date` (weeks run Monday–Sunday). */
export function mondayOf(date) {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** Which school week type (e.g. 'BF' / 'ADB') a date falls in, alternating from the student's anchor week. */
export function weekTypeFor(state, date) {
  const sc = state.settings && state.settings.school;
  const school = sc && SCHOOLS[sc.id];
  if (!school || !sc.anchor) return null;
  const monday = mondayOf(date);
  const fromCalendar = school.calendar.weekTypes[monday];
  if (fromCalendar) return fromCalendar;
  const weeks = Math.round(daysBetween(sc.anchor.monday, monday) / 7);
  const [a, b] = school.weekTypes;
  const other = sc.anchor.type === a ? b : a;
  return ((weeks % 2) + 2) % 2 === 0 ? sc.anchor.type : other;
}

/**
 * Free class blocks from the student's school timetable for a date.
 * Returns { blocks, weekType, unknown (grid not confirmed for that day), noClasses }.
 */
export function schoolBlocksForDate(state, date) {
  const sc = state.settings && state.settings.school;
  const school = sc && SCHOOLS[sc.id];
  if (!school) return { blocks: [], weekType: null, unknown: false, noClasses: false, configured: false };
  const day = (state.days && state.days[date]) || {};
  const weekType = weekTypeFor(state, date);
  const noClasses = !!day.noClasses || school.calendar.noClassDates.includes(date);
  if (noClasses) return { blocks: [], weekType, unknown: false, noClasses: true, configured: true };
  const periods = school.grid[weekType] ? school.grid[weekType][weekdayOf(date)] : null;
  if (periods == null) return { blocks: [], weekType, unknown: true, noClasses: false, configured: true };
  const free = new Set([...sc.freeBlocks, ...sc.freeBlocks.map((b) => `${b}x`), ...(sc.freeExt || [])]);
  const blocks = periods.filter((p) => free.has(p.code)).map((p) => ({
    id: `s_${p.code}_${p.start.replace(':', '')}`, date, start: p.start, end: p.end,
    label: `${p.code} block`, kind: 'free', category: 'free', school: true,
  }));
  return { blocks, weekType, unknown: false, noClasses: false, configured: true };
}

/**
 * The student's classes on a date: school periods that aren't free, with each x block joined
 * to its letter when they touch (Saturday BF: Bx 9:05–9:30 + B 9:30–10:15 → B 9:05–10:15).
 * Display only; the planner never uses class time.
 */
export function classPeriodsForDate(state, date) {
  const sc = state.settings && state.settings.school;
  const school = sc && SCHOOLS[sc.id];
  if (!school) return [];
  const info = schoolBlocksForDate(state, date);
  if (info.noClasses || info.unknown) return [];
  const periods = school.grid[info.weekType][weekdayOf(date)] || [];
  const free = new Set(info.blocks.map((b) => b.label.replace(/ block$/, '')));
  const out = [];
  for (const p of [...periods].sort((a, b) => a.start.localeCompare(b.start))) {
    if (free.has(p.code)) continue;
    const letter = p.code[0], s = parseHM(p.start), e = parseHM(p.end);
    const last = out[out.length - 1];
    if (last && last.letter === letter && s <= last.e) { last.e = Math.max(last.e, e); continue; }
    out.push({ letter, s, e });
  }
  return out.map((c) => ({ code: c.letter, start: c.s, end: c.e }));
}

/** Dated items, school free blocks and usual-week items for a date (minus usual-week items switched off that date). */
export function blocksForDate(state, date) {
  const day = (state.days && state.days[date]) || {};
  const off = new Set(Array.isArray(day.off) ? day.off : []);
  const wd = weekdayOf(date);
  const weekly = ((state.settings && state.settings.week && state.settings.week.items) || [])
    .filter((it) => it.days.includes(wd) && !off.has(it.id))
    .map((it) => ({ id: `w_${it.id}`, weeklyId: it.id, date, start: it.start, end: it.end, label: it.label, kind: it.kind, category: it.category, weekly: true }));
  return [...(state.blocks || []).filter((b) => b.date === date), ...schoolBlocksForDate(state, date).blocks, ...weekly];
}

/** Earliest minute on a date when the student might study (study start or an earlier free block). */
export function earliestStudyFn(state) {
  return (date) => {
    const ds = daySettings(state, date);
    let min = ds.studyStart ? parseHM(ds.studyStart) ?? 1440 : 1440;
    for (const b of blocksForDate(state, date)) {
      if (b.kind !== 'free') continue;
      const iv = blockInterval(b);
      if (iv && iv.start < min) min = iv.start;
    }
    return min;
  };
}

/** Inputs that make a saved plan outdated when they change. Time passing does not. */
export function planFingerprint(state, date) {
  const ds = daySettings(state, date);
  const relevant = {
    date, start: ds.studyStart, stop: ds.studyStop, session: ds.sessionMin, energy: ds.energy,
    skipped: [...ds.skipped].sort(),
    blocks: blocksForDate(state, date)
      .map((b) => [b.id, b.kind, b.start, b.end]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    tasks: (state.tasks || []).map((t) => [
      t.id, t.status, t.remainingMin, !!t.estimateUncertain, t.deadline ? t.deadline.date : null,
      t.deadline ? t.deadline.time : null, t.priority, t.kind, !!t.lateWork,
    ]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  };
  return hashString(JSON.stringify(relevant));
}

export function hashString(str) {
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Build a plan for `date` at moment `now` (a Date).
 * Allocation passes (bounded):
 *  1. Urgent tasks due at a time later today: earliest deadline first, until done.
 *  2. Other urgent tasks (last study day is today, or chosen late work): take turns, one session each per round.
 *  3. At-risk tasks: one first session each, in rank order.
 *  4. At-risk then normal tasks: top up to today's share (planned ÷ days left).
 *  5. Spare time: "getting ahead", in rank order (optional).
 */
export function buildPlan(state, { date, now, ahead = 'all' }) {
  const { date: today, minutes: nowMin } = localParts(now);
  const ds = daySettings(state, date);
  const sessionLen = effectiveSessionLength(ds.sessionMin, ds.energy);
  const free = computeFreeSlots({
    date, today, nowMin, studyStart: ds.studyStart, studyStop: ds.studyStop, blocks: blocksForDate(state, date),
  });
  const ctx = {
    date, today, refMin: date === today ? nowMin : null,
    earliestStudyMin: earliestStudyFn(state), skipped: new Set(ds.skipped),
  };
  const openTasks = (state.tasks || []).filter((t) => t.status !== 'done');
  const rank = rankTasks(openTasks, ctx);
  const warnings = [...free.warnings];
  let considered = rank.ranked;
  if (considered.length > LIMITS.maxTasks) {
    warnings.push(`Only the top ${LIMITS.maxTasks} tasks were considered.`);
    considered = considered.slice(0, LIMITS.maxTasks);
  }

  const placer = new Placer(free.ok ? free.slots : [], { maxSessions: LIMITS.maxSessions });
  const st = considered.map((r) => ({ r, placed: 0 }));
  const left = (x) => x.r.planned - x.placed;
  const place = (x, target, purpose) => {
    const c = placer.place({
      taskId: x.r.task.id, remaining: left(x), target: Math.min(target, left(x)),
      sessionLen, cutoff: x.r.cutoffMin, purpose,
    });
    x.placed += c;
    return c;
  };
  const byTier = (tier) => st.filter((x) => x.r.tier === tier);
  const urgent = byTier('urgent');
  const urgentTimed = urgent.filter((x) => x.r.cutoffMin != null);
  const urgentRest = urgent.filter((x) => x.r.cutoffMin == null);
  const atRisk = byTier('atRisk'), normal = byTier('normal'), flexible = byTier('flexible');
  const shareOf = (x) => Math.min(x.r.planned, roundUpTo(x.r.planned / x.r.daysLeft, 5));

  if (free.ok) {
    // Pass 1
    for (const x of urgentTimed) {
      let guard = 0;
      while (left(x) > 0 && guard++ < LIMITS.maxRounds && place(x, left(x), 'urgent') > 0);
    }
    // Pass 2 — take turns (a high-priority task gets two turns per round)
    let active = urgentRest.filter((x) => left(x) > 0);
    for (let round = 0; active.length && round < LIMITS.maxRounds; round++) {
      const next = [];
      for (const x of active) {
        const turns = x.r.task.priority === 'high' ? 2 : 1;
        let ok = true;
        for (let k = 0; k < turns && ok && left(x) > 0; k++) ok = place(x, left(x), 'urgent') > 0;
        if (ok && left(x) > 0) next.push(x);
      }
      active = next;
    }
    // Pass 3 — a first session for each at-risk task
    for (const x of atRisk) place(x, Math.min(sessionLen, left(x)), 'atRisk');
    // Pass 4 — today's share
    for (const x of [...atRisk, ...normal]) {
      const share = shareOf(x);
      let guard = 0;
      while (x.placed < share && left(x) > 0 && guard++ < LIMITS.maxRounds) {
        if (place(x, share - x.placed, x.r.tier === 'atRisk' ? 'atRisk' : 'share') === 0) break;
      }
    }
    // Pass 5 — getting ahead (optional). Week planning lets only undated work use spare time,
    // so free time stays free instead of pulling every future task forward.
    const aheadList = ahead === 'none' ? [] : ahead === 'flexibleOnly' ? flexible : [...atRisk, ...normal, ...flexible];
    for (const x of aheadList) {
      let guard = 0;
      while (left(x) > 0 && guard++ < LIMITS.maxRounds) if (place(x, left(x), 'ahead') === 0) break;
    }
  }

  // Assemble
  const busyItems = blocksForDate(state, date).filter((b) => b.kind !== 'free')
    .map((b) => ({ ...blockInterval(b), b })).filter((x) => x.start != null)
    .map((x) => ({ type: 'busy', start: x.start, end: x.end, label: x.b.label || 'Busy', category: x.b.category || 'other', blockId: x.b.id }));
  const timeline = placer.timeline().filter((it) => it.type !== 'break' || !busyItems.some((b) => b.start < it.end && b.end > it.start));
  let n = 0;
  const items = [...timeline, ...busyItems]
    .sort((a, b) => a.start - b.start || (a.type === 'busy' ? -1 : 1))
    .map((it) => ({ id: `i${++n}`, ...it }));

  const tasks = {};
  const notFit = [];
  for (const x of st) {
    const r = x.r;
    const share = r.tier === 'urgent' ? r.planned : r.tier === 'flexible' ? 0 : shareOf(x);
    tasks[r.task.id] = {
      tier: r.tier, planned: r.planned, buffer: r.buffer, remainingMin: r.task.remainingMin,
      scheduled: x.placed, unscheduled: r.planned - x.placed, share, daysLeft: r.daysLeft,
      cutoffMin: r.cutoffMin, late: r.late, reasons: r.reasons, pace: r.pace, started: r.started,
      substantial: r.substantial, lastWorkDate: r.lastWorkDate,
    };
    if (r.tier === 'urgent' && x.placed < r.planned) {
      notFit.push({ taskId: r.task.id, minutes: r.planned - x.placed, kind: 'deadline' });
    } else if ((r.tier === 'atRisk' || r.tier === 'normal') && x.placed < share) {
      notFit.push({ taskId: r.task.id, minutes: share - x.placed, kind: 'share' });
    }
  }
  for (const r of rank.ranked.slice(LIMITS.maxTasks)) {
    notFit.push({ taskId: r.task.id, minutes: r.planned, kind: 'limit' });
  }

  const sessions = items.filter((i) => i.type === 'session');
  const scheduledTotal = sessions.reduce((s, i) => s + i.minutes, 0);
  const urgentShort = notFit.filter((f) => f.kind === 'deadline').reduce((s, f) => s + f.minutes, 0);
  if (!free.ok) {
    // errors shown by UI
  } else if (free.totalFree === 0 && considered.length && !warnings.includes('Study hours are over for today.')) {
    warnings.push(date === today && nowMin >= free.stop
      ? 'Study hours are over for today.'
      : 'No free study time is left in this day after your commitments.');
  }
  if (urgentShort > 0) {
    const names = notFit.filter((f) => f.kind === 'deadline')
      .map((f) => `“${considered.find((r) => r.task.id === f.taskId).task.title}” (${formatDuration(f.minutes)})`);
    warnings.push(`Not everything due before your next study day fits: ${names.join(' and ')} won't fit before study time ends at ${formatTime12(free.stop ?? 0)}.`);
  }
  for (const s of rank.skipped) {
    if (s.tier === 'urgent') warnings.push(`You skipped “${s.task.title}” for today, but today is its last study day.`);
  }

  return {
    date,
    generatedAt: now.toISOString(),
    generatedFor: today,
    generatedAtMin: date === today ? nowMin : null,
    fingerprint: planFingerprint(state, date),
    studyStart: ds.studyStart, studyStop: ds.studyStop, stopMin: free.stop ?? null,
    sessionLen, energy: ds.energy,
    errors: free.errors, warnings,
    freeSlots: free.slots, freeTotal: free.totalFree, floor: free.floor,
    items, tasks, notFit,
    attention: rank.attention.map((a) => ({ taskId: a.task.id, state: a.state, dueTodayDateOnly: a.dueTodayDateOnly, planned: a.planned })),
    skipped: rank.skipped.map((s) => ({ taskId: s.task.id, tier: s.tier, planned: s.planned })),
    scheduledTotal,
    logged: {},
  };
}

/** Is a saved plan outdated compared to the current inputs? */
export function isPlanOutdated(plan, state) {
  return !!plan && plan.fingerprint !== planFingerprint(state, plan.date);
}

/** The session to do now or next. */
export function nextSession(plan, state, now) {
  if (!plan) return null;
  const { date: today, minutes: nowMin } = localParts(now);
  const byId = new Map((state.tasks || []).map((t) => [t.id, t]));
  const skipped = new Set(daySettings(state, plan.date).skipped);
  const isToday = plan.date === today;
  for (const it of plan.items) {
    if (it.type !== 'session') continue;
    const t = byId.get(it.taskId);
    if (!t || t.status === 'done' || skipped.has(it.taskId) || (plan.logged && plan.logged[it.id])) continue;
    if (isToday && it.end <= nowMin) continue;
    return { item: it, task: t, info: plan.tasks[it.taskId], status: isToday && it.start <= nowMin ? 'now' : 'next' };
  }
  return null;
}

/** Plain-language "why" for a session, built from the same numbers the planner used. */
export function explainSession(plan, state, item) {
  const info = plan.tasks[item.taskId];
  if (!info) return [];
  const byId = new Map((state.tasks || []).map((t) => [t.id, t]));
  const lines = [info.reasons[0]];
  if (item.purpose === 'urgent' && !info.late && info.cutoffMin == null) {
    const others = Object.entries(plan.tasks)
      .filter(([id, o]) => id !== item.taskId && o.tier === 'urgent' && o.cutoffMin == null && o.scheduled > 0)
      .map(([id]) => {
        const s = plan.items.find((i) => i.type === 'session' && i.taskId === id && i.start > item.start);
        const t = byId.get(id);
        return t ? (s ? `“${t.title}” (next at ${formatTime12(s.start)})` : `“${t.title}”`) : null;
      }).filter(Boolean);
    if (others.length) {
      const t = byId.get(item.taskId);
      const extra = t && t.priority === 'high' ? ' It gets two turns for each of theirs because it is high priority.' : '';
      lines.push(`It takes turns with ${others.join(' and ')} so one deadline doesn't crowd out the other.${extra}`);
    }
  }
  if (item.purpose === 'atRisk') {
    lines.push(info.started
      ? `Today's share is ${formatDuration(info.share)} of ${formatDuration(info.planned)}, so the rest stays manageable.`
      : 'A first session now makes the rest easier to finish on time.');
  }
  if (item.purpose === 'share') lines.push(`Today's share: ${formatDuration(info.share)} of ${formatDuration(info.planned)}, spread over ${info.daysLeft} days.`);
  if (item.purpose === 'ahead') lines.push('Optional: nothing more urgent fits here, so this gets you ahead.');
  if (plan.energy === 'low') lines.push(`Energy is low, so sessions are shorter (${plan.sessionLen} min). The order of priorities doesn't change.`);
  const extra = info.reasons.slice(1).filter((r) => /High priority|Low priority|uncertain|suggested/.test(r));
  return [...lines, ...extra];
}

export { MIN_SESSION, KIND_LABELS, toISODate };


/**
 * Plan the next `days` days by rolling forward: each day is planned with whatever earlier days did not cover.
 * Today starts from now; later days use their whole free time. Work is spread evenly up to each due date,
 * urgent work takes turns, big work starts early, and leftover free time stays free (undated tasks may use it).
 * Returns { days: [plan…], scheduled: Map(taskId → minutes), shortfalls: [{taskId, minutes, date}] }.
 */
export function buildWeek(state, { now, days = 7 }) {
  const { date: today } = localParts(now);
  const base = state.tasks || [];
  const used = new Map();
  const plans = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i);
    const tasks = base.map((t) => (used.has(t.id) ? { ...t, remainingMin: Math.max(0, t.remainingMin - used.get(t.id)) } : t));
    const plan = buildPlan({ ...state, tasks }, { date, now, ahead: 'flexibleOnly' });
    for (const it of plan.items) if (it.type === 'session') used.set(it.taskId, (used.get(it.taskId) || 0) + it.minutes);
    plans.push(plan);
  }
  const shortfalls = [];
  const last = plans[plans.length - 1];
  for (const plan of plans) {
    for (const f of plan.notFit) {
      if (f.kind !== 'deadline') continue;
      const info = plan.tasks[f.taskId];
      if (info && info.late && plan !== last) continue; // late work keeps going; judged at the end of the window
      shortfalls.push({ taskId: f.taskId, minutes: f.minutes, date: plan.date });
    }
  }
  return { days: plans, scheduled: used, shortfalls };
}
