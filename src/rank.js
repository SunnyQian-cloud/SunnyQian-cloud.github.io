// Ranking: decides ORDER and TIER only. Placement into time slots lives in schedule.js / plan.js.
// Every reason string is generated from the same numbers that drive the decision.
import { daysBetween, formatTime12, relativeDateLabel, formatDuration } from './dates.js';
import {
  plannedMinutes, bufferMinutes, deadlineMinutes, lastWorkDate, isSubstantial, hasStarted,
  PRIORITY_WEIGHT, AT_RISK_PACE, UNDATED_HORIZON_DAYS,
} from './model.js';

export const TIER_ORDER = { urgent: 0, atRisk: 1, normal: 2, flexible: 3 };

/**
 * Where a task stands relative to the planning date.
 * ctx = { date, refMin (minutes now if planning today, else null), earliestStudyMin(date) }
 */
export function classifyTask(task, ctx) {
  if (task.status === 'done') return { state: 'done' };
  if (!(task.remainingMin > 0)) return { state: 'noRemaining' };
  if (!task.deadline) return { state: 'undated' };
  const dd = task.deadline.date;
  const dlMin = deadlineMinutes(task.deadline);
  const ref = ctx.refMin ?? 0;
  if (dd < ctx.date || (dd === ctx.date && dlMin <= ref)) {
    return { state: 'past', dueTodayDateOnly: dd === ctx.date && !task.deadline.time };
  }
  const lwd = lastWorkDate(task, ctx.earliestStudyMin);
  if (lwd < ctx.date) return { state: 'beforeStudy' };
  const daysLeft = daysBetween(ctx.date, lwd) + 1;
  return {
    state: daysLeft === 1 ? 'lastDay' : 'dated',
    daysLeft,
    lastWorkDate: lwd,
    cutoffMin: dd === ctx.date ? dlMin : null,
  };
}

function dueText(task, today) {
  const d = task.deadline;
  const rel = relativeDateLabel(d.date, today);
  const relLower = rel === 'Today' || rel === 'Tomorrow' ? rel.toLowerCase() : rel;
  const at = d.block && d.time ? ` in ${d.block} block (${formatTime12(deadlineMinutes(d))})` : d.time ? ` at ${formatTime12(deadlineMinutes(d))}` : '';
  return task.kind === 'test' ? `Test ${relLower}${at}` : `Due ${relLower}${at}`;
}

/**
 * Rank open tasks for a planning date.
 * Returns { ranked, attention, skipped, inactive }.
 */
export function rankTasks(tasks, ctx) {
  const ranked = [], attention = [], skipped = [], inactive = [];
  const today = ctx.today ?? ctx.date;
  for (const task of tasks) {
    const c = classifyTask(task, ctx);
    if (c.state === 'done' || c.state === 'noRemaining') { inactive.push({ task, state: c.state }); continue; }
    const planned = plannedMinutes(task);
    const buffer = bufferMinutes(task);
    const started = hasStarted(task);
    const substantial = isSubstantial(task);
    const weight = PRIORITY_WEIGHT[task.priority] ?? 1;
    const reasons = [];
    let tier, pace, daysLeft = null, cutoffMin = null, late = false;

    if (c.state === 'past' || c.state === 'beforeStudy') {
      if (!task.lateWork) { attention.push({ task, state: c.state, dueTodayDateOnly: !!c.dueTodayDateOnly, planned }); continue; }
      late = true; tier = 'urgent'; daysLeft = 1; pace = planned;
      reasons.push('Past its deadline — you chose to plan it as late work.');
    } else if (c.state === 'undated') {
      tier = 'flexible';
      pace = planned / UNDATED_HORIZON_DAYS;
      reasons.push('No deadline, so it is only planned in spare time.');
    } else {
      daysLeft = c.daysLeft; cutoffMin = c.cutoffMin;
      pace = planned / daysLeft;
      const due = dueText(task, today);
      if (c.state === 'lastDay') {
        tier = 'urgent';
        if (cutoffMin != null) reasons.push(`${due}, so it's planned first to finish in time.`);
        else reasons.push(`${due}, so today is the last chance to work on it.`); // date-only: due when the day starts; or due before that day's study time
      } else {
        const highPace = pace >= AT_RISK_PACE;
        const bigUnstarted = substantial && !started && daysLeft <= 3;
        tier = highPace || bigUnstarted ? 'atRisk' : 'normal';
        reasons.push(`${due}.`); // the per-day pace isn't shown: sessions are at least 25 min, so it didn't match the plan
        if (highPace) reasons.push(`At risk: that is ${AT_RISK_PACE}+ min a day, so waiting makes it harder.`);
        else if (bigUnstarted) reasons.push('At risk: it is a big task that has not been started yet.');
      }
    }
    if (substantial && !started && tier !== 'flexible' && !reasons.some((r) => r.includes('not been started'))) {
      reasons.push('Not started yet.');
    }
    if (task.priority === 'high') reasons.push('High priority (counts 1.5× when ranking).');
    if (task.priority === 'low') reasons.push('Low priority (counts 0.6× when ranking).');
    if (buffer) reasons.push(`Estimate marked uncertain: ${formatDuration(task.remainingMin)} + ${buffer} min buffer.`);
    if (task.estimateSource === 'suggested') reasons.push('Uses a suggested estimate — update it once you know more.');

    const entry = {
      task, tier, planned, buffer, pace, score: pace * weight, daysLeft, cutoffMin, late,
      lastWorkDate: c.lastWorkDate ?? null, started, substantial, reasons,
    };
    if (ctx.skipped && ctx.skipped.has(task.id)) skipped.push(entry);
    else ranked.push(entry);
  }
  ranked.sort(compareRanked);
  skipped.sort(compareRanked);
  return { ranked, attention, skipped, inactive };
}

function deadlineKey(t) {
  return t.deadline ? `${t.deadline.date} ${String(deadlineMinutes(t.deadline)).padStart(4, '0')}` : '9999';
}

export function compareRanked(a, b) {
  if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
  if (a.tier === 'urgent') {
    const ac = a.cutoffMin != null, bc = b.cutoffMin != null;
    if (ac !== bc) return ac ? -1 : 1;
    if (ac && bc && a.cutoffMin !== b.cutoffMin) return a.cutoffMin - b.cutoffMin;
  }
  if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
  const dk = deadlineKey(a.task).localeCompare(deadlineKey(b.task));
  if (dk) return dk;
  const pw = (PRIORITY_WEIGHT[b.task.priority] ?? 1) - (PRIORITY_WEIGHT[a.task.priority] ?? 1);
  if (pw) return pw;
  const ca = String(a.task.createdAt ?? ''), cb = String(b.task.createdAt ?? '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
}
