// Shared domain rules: task kinds, estimates, buffers and deadline semantics.
import { addDays, parseHM, roundUpTo, formatTime12 } from './dates.js';

export const KINDS = ['assignment', 'project', 'test'];
export const KIND_LABELS = { assignment: 'Assignment', project: 'Project', test: 'Test prep' };
export const PRIORITIES = ['high', 'normal', 'low'];
export const PRIORITY_LABELS = { high: 'High', normal: 'Normal', low: 'Low' };
export const BLOCK_CATEGORIES = ['activity', 'class', 'meal', 'rest', 'other'];

/** Suggested starting estimates when the student gives none. Always labeled as suggestions. */
export const SUGGESTED_MINUTES = { assignment: 30, project: 60, test: 45 };

/** Shortest useful work session. Shorter pieces are only scheduled if they finish a task. */
export const MIN_SESSION = 15;
/** Extra share planned for uncertain estimates. Off (0) in the simplified pilot: students correct estimates via Done instead. */
export const BUFFER_RATE = 0;
/** A task with at least this many planned minutes counts as "substantial". */
export const SUBSTANTIAL_MIN = 60;
/** Needing this many minutes per day (or more) to finish on time makes a task "at risk". */
export const AT_RISK_PACE = 30;
/** Undated tasks are treated as if spread over this many days when ranking. */
export const UNDATED_HORIZON_DAYS = 14;
export const PRIORITY_WEIGHT = { high: 1.5, normal: 1, low: 0.6 };
export const SESSION_CHOICES = [20, 25, 30, 45, 60];

export const DEFAULT_SETTINGS = Object.freeze({
  studyStart: '19:30',
  studyStop: '22:00',
  sessionMin: 25,
});

/** Break after a session: 5 min after sessions up to 30 min, 10 min after longer ones. */
export const breakAfter = (sessionLen) => (sessionLen > 30 ? 10 : 5);

/** Low energy shortens sessions (same priorities): 25→15, 30→20, 45/60→20, 20→15. */
export function effectiveSessionLength(sessionMin, energy) {
  if (energy !== 'low') return sessionMin;
  return Math.max(MIN_SESSION, Math.min(20, sessionMin - 10));
}

export function bufferMinutes(task) {
  if (!BUFFER_RATE || !task.estimateUncertain || !(task.remainingMin > 0)) return 0;
  return Math.max(5, roundUpTo(task.remainingMin * BUFFER_RATE, 5));
}

/** Minutes the planner reserves: remaining estimate plus any uncertainty buffer. */
export const plannedMinutes = (task) => (task.remainingMin > 0 ? task.remainingMin + bufferMinutes(task) : 0);

export const isSubstantial = (task) => plannedMinutes(task) >= SUBSTANTIAL_MIN;
export const hasStarted = (task) => Array.isArray(task.progress) && task.progress.some((p) => p.workedMin > 0);

/** Neutral first step that never invents assignment requirements or subject content. */
export function neutralFirstStep(kind) {
  return kind === 'test'
    ? 'List what the test covers and pick one topic to start with.'
    : 'Review the instructions and identify the first deliverable.';
}

/** Deadline moment as minutes on its date. Date-only deadlines count as due at the start of the day (0). */
export function deadlineMinutes(deadline) {
  if (!deadline) return null;
  const t = deadline.time ? parseHM(deadline.time) : null;
  return t == null ? 0 : t;
}

/**
 * The last date the student can still work on a task before it is due.
 * Date-only: the day before. Timed: the deadline date if the deadline is after that
 * day's earliest study time, otherwise the day before.
 * @param {(date:string)=>number} earliestStudyMin
 */
export function lastWorkDate(task, earliestStudyMin) {
  if (!task.deadline) return null;
  const dl = task.deadline;
  const dm = deadlineMinutes(dl);
  if (dm > 0 && dm > earliestStudyMin(dl.date)) return dl.date;
  return addDays(dl.date, -1);
}

/** Human description of what a deadline means, used in review cards and task details. */
export function deadlineMeaning(deadline, kind) {
  if (!deadline) return kind === 'test' ? 'No test date — it will only be planned in spare time.' : 'No deadline — it will only be planned in spare time.';
  const what = kind === 'test' ? 'Prep is planned to finish' : 'Work is planned to finish';
  if (!deadline.time) return `Date only: treated as due at the start of that day. ${what} the evening before.`;
  return `Exact time: ${what.toLowerCase()} before ${formatTime12(parseHM(deadline.time))} that day.`;
}

export function newId(prefix = 't') {
  const rnd = (globalThis.crypto && globalThis.crypto.getRandomValues)
    ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join('')
    : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `${prefix}_${rnd.slice(0, 12)}`;
}
