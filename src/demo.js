// Fictional example (the critical acceptance scenario), set up the way a Middlesex student would use Blockwise.
// Nothing here is special-cased by the planner.
import { addDays, weekdayOf } from './dates.js';
import { MIDDLESEX } from './schools/middlesex.js';

/** Simulated clock for the example: 4:00 PM on the current date. */
export const DEMO_CLOCK_MIN = 16 * 60;

export function buildDemoState(today, nowIso = new Date().toISOString()) {
  const t = (id, extra) => ({
    id, status: 'open', lateWork: false, progress: [], estimateSource: 'user', firstStep: '',
    estimateUncertain: false, priority: 'normal', createdAt: nowIso, updatedAt: nowIso, ...extra,
  });
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  return {
    schemaVersion: 1,
    settings: {
      studyStart: '19:30', studyStop: '21:30', sessionMin: 25,
      school: { id: 'middlesex', freeBlocks: ['A', 'C'], freeExt: [], anchor: { monday: '2026-10-19', type: 'ECF' } }, // real alternation: Oct 24 was an ECF Saturday
      week: {
        study: JSON.parse(JSON.stringify(MIDDLESEX.study)),
        items: [{ id: 'demo_practice', days: [1, 2, 3, 4, 5], start: '15:30', end: '17:30', kind: 'busy', label: 'Practice', category: 'activity' }],
      },
    },
    tasks: [
      t('demo_project', { title: 'Biology project', kind: 'project', deadline: { date: addDays(today, 1), time: null }, remainingMin: 120 }),
      t('demo_test', { title: 'Biology test', kind: 'test', deadline: { date: addDays(today, 1), time: null }, remainingMin: 60 }),
      t('demo_math', { title: 'Math worksheet', kind: 'assignment', deadline: { date: addDays(today, 3), time: null }, remainingMin: 20 }),
      t('demo_essay', { title: 'English essay draft', kind: 'project', deadline: { date: addDays(today, 9), time: null }, remainingMin: 180 }),
    ],
    blocks: [],
    days: {},
    plans: {},
    prefs: { installHintDismissed: true, setupNudgeDismissed: true },
  };
}
