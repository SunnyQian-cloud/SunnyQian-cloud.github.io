// Blockwise UI. Plain DOM + modules; all task text rendered with textContent (see dom.js).
import { h, clear, uniqueId, append } from './dom.js';
/** Append children, skipping null/false (Element.append would print "null"). */
const put = (el, ...xs) => append(el, xs);
import * as D from './dates.js';
import {
  KIND_LABELS, PRIORITY_LABELS, SESSION_CHOICES, SUGGESTED_MINUTES, BLOCK_CATEGORIES,
  bufferMinutes, neutralFirstStep, deadlineMeaning, newId, isSubstantial, lastWorkDate, plannedMinutes,
} from './model.js';
import { parseTaskText, parseBulk, validateDraft, draftToTask, makeDeadline } from './parse.js';
import {
  buildPlan, buildWeek, nextSession, explainSession, daySettings, earliestStudyFn,
  blocksForDate, schoolBlocksForDate, classPeriodsForDate, weekTypeFor, mondayOf, gridPeriods, freeMeetingKeys,
  blockStartOn, classBlocksOn, syncBlockDeadlines, timetableForDate,
} from './plan.js';
import { MIDDLESEX } from './schools/middlesex.js';
import { buildReminderCalendar, reminderEvents } from './ics.js';
import { rankTasks } from './rank.js';
import { computeFreeSlots } from './schedule.js';
import {
  createStore, emptyState, exportPayload, parseImport, summarizeState, isStateEmpty,
  STORAGE_KEY, DEMO_KEY, MODE_KEY, UNREADABLE_PREFIX,
} from './store.js';
import { buildDemoState, DEMO_CLOCK_MIN } from './demo.js';
import { createVoiceController, VOICE_ERRORS, getRecognitionCtor } from './voice.js';
import { createUsage, USAGE_KEY } from './usage.js';

const DEMO_CLOCK_KEY = 'blockwise.demo.clock';
const $ = (sel) => document.querySelector(sel);
const store = createStore(() => window.localStorage);

// ---------- usage counts (school-approved; see src/usage.js for exactly what's sent) ----------
// The counter's public address. It only accepts step counts; it can't read anything back.
const USAGE_ENDPOINT = 'https://script.google.com/macros/s/AKfycbyts130FLEPUrYnToNrFVjEvsylXegs-oxc0z_V2DuwJkZEMCCAfVT_LHKZMouv-X_9Kg/exec';
const APP_VERSION = '2026.11.12';
const usage = createUsage({
  endpoint: USAGE_ENDPOINT, version: APP_VERSION,
  get: (k) => store.get(k), set: (k, v) => store.set(k, v),
  fetchFn: (...a) => window.fetch(...a),
});
/** Counting runs only for the student's own data, after they've been shown the note, and not if they turned it off. */
const usageOn = () => app.mode === 'real' && !!USAGE_ENDPOINT && store.available && usage.noticeShown() && !usage.isOff();
const usageFlags = () => ({ hasSchool: !!app.state.settings.school, hasTask: app.state.tasks.length > 0 });
const srcParam = () => { try { return new URLSearchParams(window.location.search).get('src'); } catch { return null; } };
let usageTimer = null;
const usageSendSoon = () => { clearTimeout(usageTimer); usageTimer = setTimeout(() => usage.flush(), 1500); };
function usageOpened() { if (!usageOn() || document.hidden) return; usage.opened(today(), usageFlags(), srcParam()); usageSendSoon(); }
function usageChanged() { if (!usageOn()) return; usage.changed(today(), usageFlags()); usageSendSoon(); }
/** What counts as "did something": tasks, the schedule, study hours (not view settings or dismissed tips). */
const meaningful = (s) => JSON.stringify([s.tasks, s.days, s.settings, s.week]);

const app = {
  mode: 'real',
  state: emptyState(),
  clockOffset: 0,
  view: 'today',
  planDate: null,
  scheduleDate: null,
  banners: { storage: false, unreadable: null, saveError: null },
  blockSaves: false,
  open: {},
  addOpen: false,   // the add box on Today
  addDraft: null,   // a parsed line waiting for Save
  addText: '',      // what's typed in the add box (kept across re-renders)
  voiceState: null,
  lastToday: null,
};

// ---------- clock ----------
const now = () => new Date(Date.now() + (app.mode === 'demo' ? app.clockOffset : 0));
const today = () => D.toISODate(now());
const nowMin = () => { const d = now(); return d.getHours() * 60 + d.getMinutes(); };

// ---------- persistence ----------
function loadReal() {
  const r = store.readState(STORAGE_KEY);
  app.state = r.state;
  app.banners.storage = r.status === 'unavailable';
  app.banners.unreadable = null;
  app.blockSaves = false;
  if (r.status === 'unreadable') {
    const key = store.keepAside(r.raw);
    app.banners.unreadable = { raw: r.raw, key, errors: r.errors || [] };
    if (!key) app.blockSaves = true; // never overwrite data we could not keep a copy of
  }
}

function loadDemo() {
  const r = store.readState(DEMO_KEY);
  const off = Number(store.get(DEMO_CLOCK_KEY));
  app.clockOffset = Number.isFinite(off) ? off : 0;
  if (r.status !== 'ok') return false;
  app.state = r.state;
  return true;
}

function prune(state) {
  const t = today();
  for (const d of Object.keys(state.plans)) if (D.daysBetween(d, t) > 7) delete state.plans[d];
  for (const d of Object.keys(state.days)) if (D.daysBetween(d, t) > 30) delete state.days[d];
}

function persist() {
  if (app.blockSaves) return;
  prune(app.state);
  const r = store.writeState(app.mode === 'demo' ? DEMO_KEY : STORAGE_KEY, app.state);
  if (!r.ok && store.available) {
    app.banners.saveError = r.error === 'full'
      ? 'Your last change couldn\'t be saved because this browser\'s storage is full. Export a backup from Settings to keep your data safe.'
      : 'Your last change couldn\'t be saved on this device. Export a backup from Settings to keep your data safe.';
  } else app.banners.saveError = null;
}

/** Apply a change, save, re-render, and optionally announce. */
function commit(mutate, message) {
  const before = meaningful(app.state);
  mutate(app.state);
  syncBlockDeadlines(app.state);
  persist();
  if (meaningful(app.state) !== before) usageChanged();
  render();
  if (message) toast(message);
}

const dayRecord = (date) => (app.state.days[date] ||= {});
const taskById = (id) => app.state.tasks.find((t) => t.id === id);

// ---------- feedback ----------
let toastTimer = null;
/** Short status message; optional action button (e.g. Undo). */
function toast(msg, action) {
  const el = $('#toast');
  clear(el);
  put(el, h('span', {}, msg), action ? h('button', { type: 'button', class: 'toast-action', onclick: () => { el.classList.remove('show'); action.fn(); } }, action.label) : null);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 7000 : 4000);
}

// ---------- small view helpers ----------
const fmtT = (m) => D.formatTime12(m);
/** '3:30–5:30 PM' (drops the repeated AM/PM). */
function fmtRange(a, b) {
  const x = fmtT(a), y = fmtT(b);
  return x.slice(-2) === y.slice(-2) ? `${x.slice(0, -3)}–${y}` : `${x}–${y}`;
}
const fmtDur = (m) => D.formatDuration(m);
function kindBadge(kind) { return h('span', { class: `badge badge-${kind}` }, KIND_LABELS[kind]); }
function dueLabel(task, t = today()) {
  if (!task.deadline) return task.kind === 'test' ? 'No test date' : 'No deadline';
  const rel = D.relativeDateLabel(task.deadline.date, t);
  const time = task.deadline.block ? ` in ${task.deadline.block} block` : task.deadline.time ? ` at ${fmtT(D.parseHM(task.deadline.time))}` : ' (date only)';
  return `${task.kind === 'test' ? 'Test' : 'Due'} ${['Today', 'Tomorrow', 'Yesterday'].includes(rel) ? rel.toLowerCase() : rel}${time}`;
}
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
function remainingLabel(task) {
  if (task.status === 'done') return 'Done';
  const base = `${task.kind === 'test' ? 'Study' : 'About'} ${fmtDur(task.remainingMin)} ${task.kind === 'test' ? 'still needed' : 'left'}`;
  const notes = [];
  if (task.estimateUncertain) notes.push('not sure');
  if (task.estimateSource === 'suggested') notes.push('suggested estimate');
  return notes.length ? `${base} (${notes.join(', ')})` : base;
}
function firstStepFor(task) {
  if (task.firstStep) return { text: task.firstStep, suggested: false };
  return { text: neutralFirstStep(task.kind), suggested: true };
}
function sectionTitle(text, extra) { return h('div', { class: 'section-title' }, h('h2', {}, text), extra || null); }
function button(label, onclick, cls = 'btn-secondary', attrs = {}) {
  return h('button', { type: 'button', class: `btn ${cls}`, onclick, ...attrs }, label);
}
function emptyNote(text) { return h('p', { class: 'muted' }, text); }

// ---------- banners & nav ----------
function renderBanners() {
  const root = clear($('#banners'));
  const b = app.banners;
  if (app.mode === 'demo') {
    const simulated = app.clockOffset !== 0;
    put(root, h('div', { class: 'banner banner-demo banner-slim', role: 'region', 'aria-label': 'Example mode' },
      h('div', { class: 'slim-row' },
        h('p', {}, h('strong', {}, 'Example'), simulated ? ` · clock set to ${fmtT(nowMin())}` : ' · real clock'),
        button('Exit', exitDemo, 'btn-secondary btn-small', { 'aria-label': 'Exit example' })),
      h('details', { class: 'slim-details' }, h('summary', {}, 'Details'),
        h('p', {}, `Fictional tasks only — your own data is untouched. ${simulated ? 'The clock is moved to the afternoon so you can see a full day.' : ''}`),
        button(simulated ? 'Use real time' : 'Use example time (4 PM)', toggleDemoClock, 'btn-ghost btn-small'))));
  }
  if (b.storage) {
    put(root, h('div', { class: 'banner banner-warn', role: 'alert' },
      h('p', {}, h('strong', {}, 'Not saving on this device. '),
        'This browser is blocking storage (for example, in private browsing). You can keep using Blockwise, but your tasks will be lost when this page closes. Export a backup from Settings to keep them.')));
  }
  if (b.unreadable) {
    put(root, h('div', { class: 'banner banner-warn', role: 'alert' },
      h('p', {}, h('strong', {}, 'Saved data couldn\'t be read. '),
        b.unreadable.key ? 'A copy was kept on this device, and Blockwise started fresh. ' : 'Blockwise won\'t save over it until you choose what to do. ',
        'You can download the unreadable data, or restore an exported backup from Settings.'),
      h('div', { class: 'banner-actions' },
        button('Download unreadable data', () => downloadText(b.unreadable.raw, 'blockwise-unreadable-data.txt', 'text/plain'), 'btn-ghost'),
        app.blockSaves
          ? button('Start fresh', startFreshAfterUnreadable, 'btn-secondary')
          : button('Dismiss', () => { app.banners.unreadable = null; renderBanners(); }, 'btn-secondary'))));
  }
  if (b.saveError) put(root, h('div', { class: 'banner banner-warn', role: 'alert' }, h('p', {}, b.saveError)));
  // Students who started before counting (or skipped the welcome screen) see this once before anything is counted.
  if (app.mode === 'real' && USAGE_ENDPOINT && store.available && !usage.noticeOk() && !usage.isOff() && !showIntro()) {
    usage.markNoticeShown();
    put(root, h('div', { class: 'banner banner-slim banner-usage', role: 'region', 'aria-label': 'Usage counts' },
      h('p', {}, h('strong', {}, 'New: '), 'Blockwise counts basic steps, like “made a plan,” to see whether it helps. Never your tasks or name.'),
      h('div', { class: 'slim-row' },
        button('OK', () => { usage.markNoticeOk(); renderBanners(); }, 'btn-secondary btn-small', { 'data-key': 'usage-ok' }),
        button('Turn off', () => { usage.setOff(true); renderBanners(); toast('Usage counts are off. Turn them back on in ⋯ → Usage counts.'); }, 'btn-ghost btn-small', { 'data-key': 'usage-off' }),
        button('Details', openUsageSheet, 'btn-link btn-small'))));
  }
  $('#mode-pill').hidden = app.mode !== 'demo';
}

async function startFreshAfterUnreadable() {
  const ok = await confirmDialog({
    title: 'Start fresh?',
    body: [h('p', {}, 'New changes will replace the unreadable data on this device. Download it first if you might need it.')],
    okLabel: 'Start fresh', danger: true,
  });
  if (!ok) return;
  app.blockSaves = false;
  app.banners.unreadable = null;
  persist();
  render();
}



// ---------- render ----------
const FOCUSABLE = 'button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), h1[tabindex]';
function render() {
  // Keep keyboard focus stable across re-renders: same data-key, else same position in the view.
  const active = document.activeElement;
  const main = $('#main');
  let key = null, index = -1;
  if (active && main.contains(active)) {
    key = active.dataset ? active.dataset.key : null;
    index = [...main.querySelectorAll(FOCUSABLE)].indexOf(active);
  }
  const intro = showIntro();
  if (intro) app.view = 'today';
  document.body.classList.toggle('intro-on', intro);
  renderBanners();
  renderNav();
  let week = null;
  syncBlockDeadlines(app.state);
  try { week = buildWeek(app.state, { now: now() }); } catch (e) { console.error(e); }
  if (app.view === 'week') renderWeek(week); else if (app.view === 'tasks') renderTasks(week); else renderToday(week);
  if (key || index >= 0) {
    const el = (key && main.querySelector(`[data-key="${CSS.escape(key)}"]`)) || main.querySelectorAll(FOCUSABLE)[index];
    if (el && !$('#sheet').open && !$('#confirm').open) el.focus({ preventScroll: true });
  }
}

function renderNav() {
  for (const b of document.querySelectorAll('.nav-btn')) {
    if (b.dataset.view === app.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('#view-today').hidden = app.view !== 'today';
  $('#view-week').hidden = app.view !== 'week';
  $('#view-tasks').hidden = app.view !== 'tasks';
}

function go(view, { focus = true } = {}) {
  app.view = view;
  if (view === 'week') markReviewed();
  render();
  if (focus) {
    const heading = $(`#view-${view} h1`);
    if (heading) heading.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

function openAdd() {
  app.addOpen = true;
  if (app.view !== 'today') go('today', { focus: false }); else render();
  const input = document.getElementById('add-input');
  if (input) input.focus();
}

// ===================== TODAY =====================
// What to do now, for how long, and why. Done / Not now. The rest of today underneath.
// The week plan is computed fresh from the student's tasks and free time on every render,
// so it always reflects what they've told Blockwise.
const CATEGORY_LABEL = { activity: 'Activity', class: 'Class', meal: 'Meal', rest: 'Rest', other: 'Busy', free: 'Free time' };

function renderToday(week) {
  const root = clear($('#view-today'));
  if (showIntro()) { put(root, introScreen()); return; }
  const t = today();
  const state = app.state;
  const school = schoolBlocksForDate(state, t);
  const day = state.days[t] || {};
  put(root, h('div', { class: 'home-head' },
    h('h1', { id: 'today-title', tabindex: '-1' }, 'Today'),
    h('span', { class: 'subtle' }, D.formatDate(t, t)),
    school.configured ? weekChip(t, school.weekType) : null,
    school.noClasses ? h('span', { class: 'chip' }, 'No classes') : null,
    day.noStudy ? h('span', { class: 'chip' }, 'Busy tonight') : null,
    button('Edit schedule', openSchedule, 'btn-link btn-small head-edit', { 'data-key': 'head-edit-today' })));

  const open = state.tasks.filter((x) => x.status === 'open');
  if (app.mode === 'real' && isStandalone() && !state.tasks.length && !state.prefs.bringOverDismissed) put(root, bringOverCard());
  if (app.mode === 'real' && !state.settings.school && !state.prefs.setupNudgeDismissed) put(root, setupCard());
  else if (checklistOpen()) put(root, checklistCard());
  // The Home Screen card waits until the student is set up and has something saved (it was crowding the first screen).
  if (app.mode === 'real' && !isStandalone() && isTouchDevice() && !state.prefs.homeScreenDismissed && state.tasks.length && !checklistOpen()) put(root, homeScreenCard(true));
  if (app.addOpen || app.addDraft || !open.length) put(root, addBox(open.length > 0));
  if (!open.length) {
    const guided = (app.mode === 'real' && !state.settings.school && !state.prefs.setupNudgeDismissed) || checklistOpen();
    if (!guided) put(root, h('p', { class: 'empty-hint' }, 'Add what\'s due — one line is enough, like “Bio test Tuesday, study 45 min”.'));
    put(root, doneToday(t));
    if (week) put(root, todaySchedule(week.days[0], t)); // the day's timetable shows even before anything is added
    if (app.mode === 'real') put(root, h('p', { class: 'example-link' }, button('See an example day', enterDemo, 'btn-link btn-small')));
    return;
  }
  if (!week) { put(root, h('p', { class: 'alert alert-danger' }, 'Something went wrong making your plan. Your tasks are safe.')); return; }
  const plan = week.days[0];
  put(root, nowCard(plan, t, week));
  put(root, alerts(plan, t));
  put(root, doneToday(t));
  put(root, todaySchedule(plan, t));
}

// ---------- welcome screen (first visit only) ----------
/** Brand-new visitors only: nothing saved, no schedule, not skipped. Anyone with data goes straight to Today. */
function showIntro() {
  const st = app.state;
  return app.mode === 'real' && !st.prefs.introDone && !st.tasks.length && !st.settings.school && !st.prefs.setupNudgeDismissed && !isStandalone();
}

function introScreen() {
  const counting = !!USAGE_ENDPOINT && store.available && !usage.isOff();
  if (counting) usage.markNoticeShown();
  const start = () => {
    if (counting) usage.markNoticeOk();
    commit((s) => { s.prefs.introDone = true; });
    window.scrollTo(0, 0);
    document.querySelector('[data-key="setup-title"]')?.focus({ preventScroll: true });
  };
  return h('section', { class: 'intro', 'aria-labelledby': 'intro-title' },
    h('h1', { id: 'intro-title', class: 'intro-title', tabindex: '-1' }, 'Free block. ', h('span', { class: 'intro-title-2' }, 'Now what?')),
    h('p', { class: 'intro-sub' }, 'Make the most of your free blocks and study hours.'),
    h('p', { class: 'intro-lead' }, 'Add what\'s due and how long it\'ll take. Blockwise builds a study plan around your classes, and adjusts it automatically when you change a task or your schedule.'),
    introDemo(),
    h('div', { class: 'intro-actions' },
      button('Plan my next free block', start, 'btn-primary intro-go', { 'data-key': 'intro-go' }),
      button('See an example', enterDemo, 'btn-secondary', { 'data-key': 'intro-example' })),
    h('p', { class: 'intro-fine' }, h('strong', {}, 'Spend less time planning. Know what to start next.'), h('br'), 'Free · No account · Your plan stays on your device'),
    counting ? h('p', { class: 'intro-fine intro-usage' }, 'Blockwise counts basic steps, like “made a plan,” to see whether it helps. Never your tasks or name. Turn off in ⋯ → Usage counts.') : null);
}

/** A tiny picture of the one idea: a test on Friday becomes study time in a free block before it. Plays once. */
function introDemo() {
  return h('div', { class: 'intro-demo', role: 'img', 'aria-label': 'Example: a Bio test on Friday in D block. Blockwise plans 45 minutes of study for it in Thursday\'s free A block.' },
    h('div', { class: 'idemo-task', 'aria-hidden': 'true' },
      h('span', { class: 'idemo-title' }, 'Bio test'),
      h('span', { class: 'due-pill' }, 'Test'),
      h('span', { class: 'idemo-meta' }, 'Friday, D block · study 45 min')),
    h('p', { class: 'idemo-link', 'aria-hidden': 'true' }, '↓ planned before the test'),
    h('div', { class: 'idemo-row', 'aria-hidden': 'true' },
      h('span', { class: 'idemo-when' }, h('span', { class: 'slot-name' }, 'Thu · A block')),
      h('span', { class: 'idemo-slot' },
        h('span', { class: 'free-pill idemo-free' }, 'Free'),
        h('span', { class: 'idemo-session' }, 'Study for Bio test', h('span', { class: 'mins' }, '45 min')))));
}

/** “ECF week ⇄” — one tap to switch the alternation if a break threw it off. */
function weekChip(date, weekType) {
  const label = weekType ? `${weekType} week` : 'No Sat. classes';
  return button(h('span', {}, `${label} `, h('span', { 'aria-hidden': 'true' }, '⇄')), () => openWeekSheet(date), 'chip-btn', { 'aria-label': `${label}. Change`, 'data-key': 'week-chip' });
}

/** The three answers to "which blocks meet on Saturday?": E, C, F · ECF week / A, D, B · ADB week / No classes · Free Saturday. */
function weekChoiceButtons(current, onPick, keyPrefix) {
  const choice = (value, big, small) => h('button', {
    type: 'button', class: 'block-chip wide week-choice', 'aria-pressed': String(current === value), 'data-key': `${keyPrefix}-${value}`,
    onclick: () => onPick(value),
  }, h('span', { class: 'wk-letters' }, big), h('span', { class: 'wk-name' }, small));
  return [...MIDDLESEX.weekTypes.map((w) => choice(w, saturdayLetters(w), `${w} week`)), choice('NONE', 'No classes', 'Free Saturday')];
}

/** The week button on Today: this week's Saturday blocks, or no Saturday classes. Later weeks alternate from an E, C, F / A, D, B answer. */
function openWeekSheet(date) {
  const sc = app.state.settings.school;
  const sat = D.addDays(mondayOf(date), 5);
  const current = sc.anchor || (app.state.days[sat] && app.state.days[sat].satType) ? weekTypeFor(app.state, date) : 'NONE';
  const choose = (wk) => {
    closeSheet();
    commit((s) => {
      s.settings.school.anchor = wk === 'NONE' ? null : { monday: mondayOf(date), type: wk };
      if (s.days[sat]) { delete s.days[sat].satType; if (wk !== 'NONE') delete s.days[sat].noClasses; }
    }, wk === 'NONE' ? 'No Saturday classes. If a Saturday has classes, tap it on Week.' : `${wk} week. Later weeks alternate from here.`);
  };
  openSheet('Saturday classes', [
    h('p', { class: 'hint' }, `Look at Saturday, ${thisSatShort(date)} in your planner. Which blocks meet?`),
    h('div', { class: 'block-grid', role: 'group', 'aria-label': 'Saturday blocks this week' }, ...weekChoiceButtons(current, choose, 'wk')),
    h('p', { class: 'hint' }, 'E, C, F or A, D, B: later weeks alternate from your answer (use this after a break). No classes: Saturdays stay free unless you set one on Week.'),
  ]);
}

// ---------- first-run setup (inline, two taps) ----------
/** "E, C, F" — the class blocks that meet on Saturday in a week type. */
/** "Nov 14": this week's Saturday (weeks run Monday–Sunday). */
function thisSatShort(date = today()) { return D.formatDate(D.addDays(mondayOf(date), 5), date).replace(/^\w+, /, ''); }
function saturdayLetters(weekType) {
  const sat = (MIDDLESEX.grid[weekType] && MIDDLESEX.grid[weekType][6]) || [];
  return [...new Set(sat.map((p) => p.code[0]))].join(', ');
}

// ---------- getting started ----------
function checklistSteps() {
  const st = app.state;
  const skipped = !st.settings.school && !!st.prefs.setupNudgeDismissed;
  const set = !!st.settings.school || skipped;
  return [
    { label: `Choose your week (${MIDDLESEX.weekTypes.map(saturdayLetters).join(' or ')} on Saturday).`, done: set },
    { label: 'Mark your free blocks: tell Blockwise when you can work.', done: set },
    { label: 'Add something due and how long it will take.', done: st.tasks.length > 0 },
    { label: 'Review your next step: change anything that doesn\'t fit.', done: !!st.prefs.reviewedNext },
  ];
}
const checklistOpen = () => app.mode === 'real' && !app.state.prefs.checklistDismissed && checklistSteps().some((x) => !x.done);

function checklistList(steps) {
  const cur = steps.findIndex((x) => !x.done);
  return h('ol', { class: 'checklist' }, ...steps.map((x, i) => h('li', { class: [x.done && 'is-done', i === cur && 'is-current'] },
    h('span', { class: 'check-mark', 'aria-hidden': 'true' }, x.done ? '✓' : String(i + 1)),
    h('span', {}, x.label, x.done ? h('span', { class: 'visually-hidden' }, ' (done)') : null))));
}

function checklistCard() {
  const steps = checklistSteps();
  const n = steps.filter((x) => x.done).length;
  return h('section', { class: 'callout-card checklist-card', 'aria-label': 'Getting started' },
    h('div', { class: 'checklist-head' },
      h('p', { class: 'callout-title' }, `Getting started · ${n} of ${steps.length} done`),
      button('Hide', () => commit((s) => { s.prefs.checklistDismissed = true; }, 'You can find it again in ⋯ → How to use Blockwise.'), 'btn-link btn-small', { 'aria-label': 'Hide the getting started list' })),
    checklistList(steps),
    scheduleTip());
}

/** Optional, never a required step: where one-day changes live (the app's real control names). */
function scheduleTip() {
  return h('p', { class: 'checklist-tip' }, h('strong', {}, 'Day off or schedule change? '),
    'On Week, tap that day and turn on “No classes this day” or “Busy that evening.” For today, use Edit schedule.');
}

/** Step 4 is done once the student looks at or changes a suggestion. */
function markReviewed() {
  if (app.mode !== 'real' || app.state.prefs.reviewedNext || !app.state.tasks.length) return;
  app.state.prefs.reviewedNext = true;
  persist();
  render(); // the Getting started list ticks off step 4 right away
}

function openHowTo() {
  const dismissed = app.mode === 'real' && app.state.prefs.checklistDismissed && checklistSteps().some((x) => !x.done);
  openSheet('How to use Blockwise', [
    checklistList(checklistSteps()),
    scheduleTip(),
    h('h3', { class: 'small-heading' }, 'Every day'),
    h('ul', { class: 'steps' },
      h('li', {}, h('strong', {}, 'Today'), ' shows what to do now and the rest of your day, block by block.'),
      h('li', {}, h('strong', {}, 'Done'), ' — say whether you finished or about how much is left. ', h('strong', {}, 'Not now'), ' moves it off today; the plan rearranges.'),
      h('li', {}, h('strong', {}, 'Week'), ' shows your free blocks and study hours for the next days. Tap a free block to keep it free.'),
      h('li', {}, 'Tap any task name to change it, finish it or delete it. ⋯ → All tasks lists everything.')),
    dismissed ? button('Show the list on Today again', () => { closeSheet(); commit((s) => { delete s.prefs.checklistDismissed; }); }, 'btn-secondary btn-small') : null,
  ]);
}

/**
 * First-run setup, one question at a time: Step 1 the week (answered with Saturday's blocks), Step 2 free blocks.
 * Progress lives in app.setupDraft (memory only), so the 30-second refresh never wipes a half-finished setup.
 */
// ---------- the free-block grid (Mon–Fri, like the printed schedule) ----------
const GRID_DAYS = [1, 2, 3, 4, 5];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Every Mon–Fri period of a letter: its block and its x block. */
const letterKeys = (L) => GRID_DAYS.flatMap((wd) => gridPeriods(MIDDLESEX, wd).filter((p) => !p.extra && p.code[0] === L).map((p) => `${wd}:${p.code}`));
/** Tapping a letter turns all its weekday periods on or off (Saturday uses the letters directly). */
function toggleLetter(free, meetings, L) {
  const on = !free.has(L);
  if (on) free.add(L); else free.delete(L);
  for (const k of letterKeys(L)) { if (on) meetings.add(k); else meetings.delete(k); }
}
/** Letters free somewhere: a free letter, or that block (not just its x block) free on at least one weekday. */
function freeLettersIn(free, meetings) {
  const out = new Set(free);
  for (const k of meetings) { const code = k.split(':')[1]; if (/^[A-G]$/.test(code)) out.add(code); }
  return out;
}
const gridTime = (hm) => { const [h0, m] = hm.split(':').map(Number); return `${((h0 + 11) % 12) + 1}:${String(m).padStart(2, '0')}`; };
/** Mon–Fri columns of periods in time order. Tap a period to mark it free (or not) that day. */
function freeGrid(meetings, onToggle, keyPrefix) {
  return h('div', { class: 'fgrid', role: 'group', 'aria-label': 'Free periods, Monday to Friday' },
    ...GRID_DAYS.map((wd) => h('div', { class: 'fgrid-day', role: 'group', 'aria-label': DAY_LONG[wd] },
      h('div', { class: 'fgrid-head', 'aria-hidden': 'true' }, DAY_SHORT[wd]),
      ...gridPeriods(MIDDLESEX, wd).map((p) => {
        const key = `${wd}:${p.code}`;
        const on = meetings.has(key);
        return h('button', {
          type: 'button', class: ['fgrid-cell', on && 'is-free', p.extra && 'is-extra', p.code.endsWith('x') && 'is-x', !p.extra && `blk-${p.code[0]}`],
          'aria-pressed': String(on), 'data-key': `${keyPrefix}-${wd}-${p.code}`, onclick: () => onToggle(key),
        },
        h('span', { class: 'visually-hidden' }, `${DAY_LONG[wd]} `),
        p.label === 'Community time'
          ? [h('span', { class: 'fgrid-code', 'aria-hidden': 'true' }, 'Comm.'), h('span', { class: 'visually-hidden' }, 'Community time')]
          : h('span', { class: 'fgrid-code' }, p.extra ? p.label : p.code),
        p.extra ? null : h('span', { class: 'visually-hidden' }, ' block'),
        h('span', { class: 'fgrid-time' }, ` ${gridTime(p.start)}`));
      }))));
}

function setupCard() {
  const d = (app.setupDraft ||= { step: 1, wk: null, free: [], keep: [], meetings: [] });
  const free = new Set(d.free), keep = new Set(d.keep), meetings = new Set(d.meetings || []);
  const update = (focusKey) => {
    d.free = [...free].sort();
    d.meetings = [...meetings].sort();
    const somewhere = freeLettersIn(free, meetings);
    d.keep = [...keep].filter((L) => somewhere.has(L)).sort();
    render();
    if (focusKey) document.querySelector(`[data-key="${focusKey}"]`)?.focus();
  };
  const go2 = (step) => { d.step = step; update('setup-title'); };
  const notHere = button('Not at Middlesex', () => { app.setupDraft = null; commit((s) => { s.prefs.setupNudgeDismissed = true; }); }, 'btn-link btn-small');
  if (d.step === 1 || !d.wk) {
    return h('section', { class: 'setup', 'aria-label': 'Set up your classes' },
      h('p', { class: 'setup-step' }, 'Step 1 of 2'),
      h('h2', { class: 'setup-title', tabindex: '-1', 'data-key': 'setup-title' }, 'Choose your week'),
      h('p', { class: 'hint' }, `Look at Saturday, ${thisSatShort()} in your school planner. Which blocks meet?`),
      h('div', { class: 'block-grid', role: 'group', 'aria-label': 'Saturday blocks this week' },
        ...weekChoiceButtons(d.wk, (w) => { d.wk = w; go2(2); }, 'setup-wk')),
      h('p', { class: 'hint' }, 'Not sure? You can change it later with the week button on Today.'),
      h('div', { class: 'actions' }, notHere));
  }
  const letters = h('div', { class: 'block-grid', role: 'group', 'aria-label': 'Free blocks' },
    ...MIDDLESEX.blocks.map((L) => h('button', {
      type: 'button', class: 'block-chip', 'aria-pressed': String(free.has(L)), 'data-key': `setup-free-${L}`,
      onclick: () => { toggleLetter(free, meetings, L); update(`setup-free-${L}`); },
    }, L)));
  const grid = freeGrid(meetings, (key) => { meetings.has(key) ? meetings.delete(key) : meetings.add(key); update(`setup-grid-${key.replace(':', '-')}`); }, 'setup-grid');
  const somewhere = freeLettersIn(free, meetings);
  const keepRow = somewhere.size ? h('div', {},
    h('p', { class: 'setup-q' }, 'Keep any of them free for yourself?', h('span', { class: 'hint block' }, 'Optional. Blockwise won\'t plan work in these.')),
    h('div', { class: 'block-grid', role: 'group', 'aria-label': 'Free blocks to keep free' },
      ...[...somewhere].sort().map((L) => h('button', {
        type: 'button', class: 'block-chip', 'aria-pressed': String(keep.has(L)), 'aria-label': `Keep ${L} block free`, 'data-key': `setup-keep-${L}`,
        onclick: () => { keep.has(L) ? keep.delete(L) : keep.add(L); update(`setup-keep-${L}`); },
      }, L)))) : null;
  return h('section', { class: 'setup', 'aria-label': 'Set up your classes' },
    h('p', { class: 'setup-step' }, 'Step 2 of 2'),
    h('h2', { class: 'setup-title', tabindex: '-1', 'data-key': 'setup-title' }, 'What are your free blocks?'),
    h('p', { class: 'setup-summary' }, d.wk === 'NONE' ? `Saturday, ${thisSatShort()}: no classes ` : `Week: ${saturdayLetters(d.wk)} on Saturday (${d.wk} week) `,
      button('Change', () => go2(1), 'btn-link btn-small', { 'aria-label': 'Change the week' })),
    d.wk === 'NONE' ? h('p', { class: 'hint' }, 'Saturdays stay class-free. If a later Saturday has classes, tap it on Week.') : null,
    h('p', { class: 'hint' }, 'Tap each letter where you usually have no class.'),
    letters,
    h('p', { class: 'setup-q' }, 'Check each day', h('span', { class: 'hint block' }, 'Some blocks aren\'t free every day (an ensemble, a lab). Tap a period to change just that day. Senate, Meet and Community time are here too.')),
    grid,
    keepRow,
    h('div', { class: 'actions' },
      button('Back', () => go2(1), 'btn-ghost'),
      button('Save schedule', () => {
        const wk = d.wk;
        app.setupDraft = null;
        commit((s) => {
          // "No classes" → no week type: Saturdays stay free unless the student sets one (Week → tap Saturday)
          s.settings.school = { id: 'middlesex', freeBlocks: [...free].sort(), freeExt: [], freeMeetings: [...meetings].sort(), anchor: wk === 'NONE' ? null : { monday: mondayOf(today()), type: wk } };
          const kf = [...keep].filter((L) => freeLettersIn(free, meetings).has(L)).sort();
          if (kf.length) s.settings.school.keepFree = kf;
          ensureWeek(s).study = JSON.parse(JSON.stringify(MIDDLESEX.study));
          s.prefs.setupNudgeDismissed = true;
        }, 'Saved. Your free blocks and study hours are in.');
      }, 'btn-primary', { 'data-key': 'setup-save' })),
    h('div', { class: 'actions setup-foot' }, notHere));
}

// ---------- add: type → one tappable line → Save ----------
let voice = null;
/** Voice is off for the pilot (it didn't work reliably for testers). `?voice=1` turns it on to test it. */
const VOICE_ON = (() => { try { return new URLSearchParams(window.location.search).has('voice'); } catch { return false; } })();

function addBox(canClose) {
  const input = h('input', { id: 'add-input', type: 'text', maxlength: '300', autocomplete: 'off', enterkeyhint: 'done', placeholder: 'What\'s due? e.g. Bio test Tuesday, study 45 min', 'aria-label': 'What\'s due?', 'data-key': 'add-input', oninput: (e) => { app.addText = e.target.value; } });
  input.value = app.addText;
  const voiceOk = VOICE_ON && !!getRecognitionCtor(window);
  const form = h('form', { class: 'add-form', novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    app.addDraft = parseTaskText(text, today());
    render();
    document.querySelector('[data-key="draft-save"]')?.focus();
  } },
  input,
  voiceOk ? h('button', { type: 'button', class: 'btn btn-icon add-mic', 'aria-label': 'Speak instead', onclick: startVoiceFlow, 'data-key': 'voice-start' }, micIcon()) : null,
  h('button', { type: 'submit', class: 'btn btn-primary add-go', 'data-key': 'add-go' }, 'Add'));
  return h('section', { class: 'add', 'aria-label': 'Add something due' },
    form,
    app.voiceState ? voicePanel() : null,
    VOICE_ON && !voiceOk ? h('p', { class: 'hint' }, VOICE_ERRORS.unsupported) : null,
    app.addDraft ? draftLine(app.addDraft) : null,
    !canClose && !app.addDraft ? h('p', { class: 'hint add-hint' }, 'For a test, give the study time — not how long the test lasts.') : null,
    canClose && !app.addDraft ? h('div', { class: 'add-foot' },
      button('Paste a list instead', () => openCapture({ bulk: true }), 'btn-link btn-small'),
      button('Close', () => { app.addOpen = false; app.addText = ''; stopVoice(); render(); }, 'btn-link btn-small', { 'data-key': 'add-close' })) : null);
}

function micIcon() {
  const svg = svgEl('svg', { width: '22', height: '22', viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' });
  svg.append(svgEl('rect', { x: '9', y: '3', width: '6', height: '11', rx: '3' }), svgEl('path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v3' }));
  return svg;
}
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** The review card, reduced to one line of tappable parts. Nothing is saved until Save. */
function draftLine(d) {
  const t = today();
  const due = d.deadlineDate ? `${d.kind === 'test' ? 'Test ' : 'Due '}${D.relativeDateLabel(d.deadlineDate, t)}${d.deadlineTime && !d.deadlineBlock ? ` ${fmtT(D.parseHM(d.deadlineTime))}` : ''}` : 'No due date';
  const guessTime = d.durationSource === 'suggested' && Number(d.remainingMin) === d.suggestedMin;
  const test = d.kind === 'test';
  const schoolSet = !!app.state.settings.school;
  const blocksKnown = schoolSet || !app.state.prefs.setupNudgeDismissed; // before setup, weekday class times are already known
  const blockStart = d.deadlineBlock && d.deadlineDate ? blockStartOn(app.state, d.deadlineDate, d.deadlineBlock) : null;
  const blockOff = !!(d.deadlineBlock && d.deadlineDate && !blockStart);
  const mins = fmtDur(Number(d.remainingMin) || 0);
  const chip = (label, onclick, extra = {}) => h('button', { type: 'button', class: ['draft-chip', extra.warn && 'is-warn', extra.cls], onclick, 'aria-label': extra.aria }, label);
  const notes = [];
  const amb = d.flags.find((f) => (f.field === 'deadline' || f.field === 'deadlineTime') && (f.level === 'ambiguous' || f.level === 'warning') && !f.resolved);
  if (amb) notes.push(amb.message);
  else if (!d.deadlineDate) notes.push('No due date found. Tap it to add one, or save without.');
  if (blockOff) notes.push(schoolSet || D.weekdayOf(d.deadlineDate) !== 6 ? `${d.deadlineBlock} block doesn't meet that day, so it counts as due when the day starts. Tap it to pick another.` : `Saturday's blocks depend on the week. Choose your week (step 1) so Blockwise knows when ${d.deadlineBlock} block is.`);
  const lengthFlag = d.flags.find((f) => f.field === 'duration' && /how long the test lasts/.test(f.message));
  if (guessTime && lengthFlag) notes.push(`Read that as how long the test lasts, not study time. ${fmtDur(d.remainingMin)} of study is a guess — tap it to change.`);
  else if (guessTime) notes.push(test ? `${fmtDur(d.remainingMin)} of study is a guess — tap it to change.` : `${fmtDur(d.remainingMin)} is a guess — tap it to change.`);
  const alt = amb && amb.alternatives && amb.alternatives[0];
  const v = validateDraft(d);
  // Ask for the block right here, while adding (not later on Week): the classes that meet that day, one tap each.
  // Optional — skipped when a block or a time was typed, when no classes meet that day, or once answered for this date.
  const pickBlock = (L) => {
    d.deadlineBlock = L; d.blockAnsweredFor = d.deadlineDate;
    if (L) d.deadlineTime = null;
    for (const f of d.flags) if (f.field === 'deadlineTime') f.resolved = true;
    render();
    document.querySelector('[data-key="draft-save"]')?.focus({ preventScroll: true });
  };
  // Always asked once there's a date and no block or time yet; it goes away when answered for that date.
  const askOpen = !!(d.deadlineDate && !d.deadlineBlock && !d.deadlineTime && d.blockAnsweredFor !== d.deadlineDate);
  const askClasses = askOpen && blocksKnown ? classBlocksOn(app.state, d.deadlineDate) : [];
  let askWhy = null; // why there are no block buttons for that date
  if (askOpen && !askClasses.length && blocksKnown) {
    const sat = D.weekdayOf(d.deadlineDate) === 6;
    askWhy = sat && !schoolSet ? 'Saturday\'s blocks depend on the week: choose your week above to see them.'
      : sat && schoolBlocksForDate(app.state, d.deadlineDate).satOff ? 'No Saturday classes are set for that day. If there are, tap that Saturday on Week.'
      : 'No classes meet that day.';
  }
  const askId = uniqueId('ask');
  const askWt = d.deadlineDate && D.weekdayOf(d.deadlineDate) === 6 ? weekTypeFor(app.state, d.deadlineDate) : null;
  const askDate = d.deadlineDate ? `${D.formatDate(d.deadlineDate, t)}${askWt ? ` · ${askWt} week` : ''}` : '';
  const blockQuestion = askOpen ? h('div', { class: 'draft-ask', role: 'group', 'aria-labelledby': askId },
    h('p', { class: 'draft-ask-q', id: askId },
      askClasses.length ? (test ? 'Which block is the test in?' : 'Due in a class? Which block?') : (test ? 'When is the test?' : 'When is it due?'),
      ' ', h('span', { class: 'draft-ask-date' }, askDate)),
    askWhy ? h('p', { class: 'hint draft-ask-why' }, askWhy) : null,
    h('div', { class: 'quick-chips' },
      ...askClasses.map((c) => button(`${c.letter} · ${fmtT(D.parseHM(c.start))}`, () => pickBlock(c.letter), 'chip-btn', { 'data-key': `ask-${c.letter}` })),
      button(askClasses.length ? 'Other time…' : 'Add a time…', () => askDraftTime(d), 'chip-btn', { 'data-key': 'ask-time' }),
      button('Skip', () => pickBlock(null), 'chip-btn', { 'data-key': 'ask-skip' }))) : null;
  // No block and no time: say what that means (due when the day starts, so the work happens the day before).
  if (d.deadlineDate && d.deadlineDate > t && !d.deadlineBlock && !d.deadlineTime && !askOpen && !amb) {
    notes.push(`No block or time, so it counts as due at the start of ${D.formatDate(d.deadlineDate, t)}: ${test ? 'study' : 'work'} is planned to finish the day before.`);
  }
  return h('section', { class: 'draft', 'aria-label': 'Check before saving' },
    h('div', { class: 'draft-chips' },
      chip(d.title || 'Add a title', () => editDraftTitle(d), { aria: `Title: ${d.title || 'missing'}. Change`, warn: !d.title }),
      chip(KIND_LABELS[d.kind], () => { d.kind = d.kind === 'assignment' ? 'project' : d.kind === 'project' ? 'test' : 'assignment'; if (guessTime) { d.suggestedMin = SUGGESTED_MINUTES[d.kind]; d.remainingMin = d.suggestedMin; } render(); }, { aria: `Type: ${KIND_LABELS[d.kind]}. Tap to change` }),
      chip(due, () => editDraftDue(d), { aria: `${due}. Change`, warn: !d.deadlineDate || !!amb }),
      d.deadlineDate && (blocksKnown || d.deadlineBlock) && !blockQuestion
        // Once answered (or when there's nothing to ask), the block stays one tap away
        ? chip(d.deadlineBlock ? `In ${d.deadlineBlock} block${blockStart ? ` · ${fmtT(D.parseHM(blockStart))}` : ''}` : `+ ${test ? 'Test' : 'Due'} block`, () => openBlockPicker(d.deadlineDate, d.kind, d.deadlineBlock, (L) => { d.deadlineBlock = L; if (L) d.deadlineTime = null; for (const f of d.flags) if (f.field === 'deadlineTime') f.resolved = true; render(); }),
          { aria: d.deadlineBlock ? `In ${d.deadlineBlock} block${blockStart ? ` · ${fmtT(D.parseHM(blockStart))}` : ''}. Change` : null, warn: blockOff, cls: !d.deadlineBlock && 'is-optional' })
        : null,
      chip(test ? `Study ${guessTime ? '~' : ''}${mins}${guessTime ? '?' : ''}` : `${guessTime ? '~' : ''}${mins}${guessTime ? '?' : ''} of work`, () => editDraftTime(d),
        { aria: `${test ? `Study ${mins}` : `${mins} of work`}${guessTime ? ', a guess' : ''}. Change`, warn: guessTime })),
    blockQuestion,
    notes.length ? h('p', { class: 'draft-note' }, notes.join(' '),
      alt ? button(alt.date ? `Use ${alt.label}` : `Use ${alt.label}`, () => {
        if (alt.date) d.deadlineDate = alt.date;
        if (alt.time) d.deadlineTime = alt.time;
        amb.resolved = true; render();
      }, 'btn-link btn-small') : null) : null,
    !v.ok ? h('p', { class: 'field-error', role: 'alert' }, Object.values(v.errors)[0]) : null,
    h('div', { class: 'actions' },
      button('Save', () => saveDraft(d), 'btn-primary', { 'data-key': 'draft-save' }),
      button('Cancel', () => { app.addDraft = null; render(); }, 'btn-ghost')));
}

function saveDraft(d) {
  if (!validateDraft(d).ok) { render(); return; }
  const task = draftToTask(d, now().toISOString());
  app.addDraft = null;
  app.addOpen = true;
  app.addText = '';
  commit((s) => { s.tasks.push(task); }, `Added “${task.title}”. Your week is updated.`);
  const input = document.getElementById('add-input');
  if (input) { input.value = ''; input.focus(); }
}

function editDraftTitle(d) {
  const id = uniqueId('dt');
  const inp = h('input', { id, type: 'text', maxlength: '120', value: d.title });
  openSheet('Title', h('form', { class: 'stack', novalidate: true, onsubmit: (e) => { e.preventDefault(); d.title = inp.value.trim(); closeSheet(); render(); } },
    h('div', { class: 'field' }, h('label', { for: id }, 'What is it?'), inp),
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Done'))), { focus: `#${id}` });
}

function editDraftDue(d) {
  const t = today();
  const dId = uniqueId('dd'), tId = uniqueId('dtm');
  const dateIn = h('input', { id: dId, type: 'date', value: d.deadlineDate || '' });
  const timeIn = h('input', { id: tId, type: 'time', value: d.deadlineTime || '' });
  const set = (date) => { d.deadlineDate = date; d.deadlineTime = timeIn.value || null; if (d.deadlineTime) d.deadlineBlock = null; for (const f of d.flags) if (f.field.startsWith('deadline')) f.resolved = true; closeSheet(); render(); };
  const picks = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => D.addDays(t, n));
  openSheet(d.kind === 'test' ? 'Test date' : 'Due date', [
    h('div', { class: 'quick-chips' }, ...picks.map((p, i) => button(i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : D.formatDate(p, t), () => set(p), 'chip-btn'))),
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' }, h('label', { for: dId }, 'Other date'), dateIn),
      h('div', { class: 'field' }, h('label', { for: tId }, 'Time (optional)'), timeIn)),
    h('p', { class: 'hint' }, 'Without a time or block, it counts as due when the school day starts, so the work happens the day before. You can pick the class block next.'),
    h('div', { class: 'actions' },
      button('Use this date', () => { if (D.isValidISODate(dateIn.value)) set(dateIn.value); else dateIn.focus(); }, 'btn-primary'),
      button('No due date', () => { d.deadlineDate = null; d.deadlineTime = null; d.deadlineBlock = null; for (const f of d.flags) if (f.field.startsWith('deadline')) f.resolved = true; closeSheet(); render(); }, 'btn-ghost')),
  ]);
}

/** "Other time…" from the block question: just the time, for that date (e.g. due 8 PM, or online at 11:59 PM). */
function askDraftTime(d) {
  const id = uniqueId('at');
  const inp = h('input', { id, type: 'time', value: d.deadlineTime || '' });
  openSheet(d.kind === 'test' ? 'What time is the test?' : 'What time is it due?', [
    h('p', { class: 'hint' }, D.formatDate(d.deadlineDate, today())),
    h('form', { class: 'stack', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      if (!/^\d{2}:\d{2}$/.test(inp.value)) { inp.focus(); return; }
      d.deadlineTime = inp.value; d.deadlineBlock = null; d.blockAnsweredFor = d.deadlineDate;
      for (const f of d.flags) if (f.field === 'deadlineTime') f.resolved = true;
      closeSheet(); render();
    } },
      h('div', { class: 'field' }, h('label', { for: id }, 'Time'), inp),
      h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Use this time'))),
  ]);
}

function editDraftTime(d) {
  const id = uniqueId('dm');
  const test = d.kind === 'test';
  const inp = h('input', { id, type: 'number', inputmode: 'numeric', min: '1', max: '1440', value: d.remainingMin });
  const set = (m) => { d.remainingMin = m; d.durationSource = 'text'; closeSheet(); render(); };
  openSheet(test ? 'How long do you need to study?' : 'How long will it take?', [
    test ? h('p', { class: 'hint' }, 'All the studying you still need before the test — not how long the test lasts.') : null,
    h('div', { class: 'quick-chips' }, ...[15, 30, 45, 60, 90, 120, 180].map((m) => button(fmtDur(m), () => set(m), 'chip-btn'))),
    h('form', { class: 'stack', novalidate: true, onsubmit: (e) => { e.preventDefault(); const m = Number(inp.value); if (Number.isInteger(m) && m > 0 && m <= 1440) set(m); else inp.focus(); } },
      h('div', { class: 'field' }, h('label', { for: id }, test ? 'Minutes of study' : 'Minutes'), inp),
      h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Use this'))),
  ]);
}

/** "Which block is it in?" — classes that meet that day (not the student's free blocks), with start times. */
function openBlockPicker(date, kind, current, onPick) {
  const t = today();
  const classes = classBlocksOn(app.state, date);
  const schoolSet = !!app.state.settings.school;
  openSheet(kind === 'test' ? 'Which block is the test in?' : 'Which class is it due in?', [
    h('p', { class: 'hint' }, `${D.formatDate(date, t)}. Work is planned to finish before that class starts, so free blocks earlier that day count too.`),
    classes.length
      ? h('div', { class: 'quick-chips', role: 'group', 'aria-label': 'Class blocks' }, ...classes.map((c) =>
        button(`${c.letter} block · ${fmtT(D.parseHM(c.start))}`, () => { closeSheet(); onPick(c.letter); }, ['chip-btn', current === c.letter && 'is-on'].filter(Boolean).join(' '), { 'aria-pressed': String(current === c.letter) })))
      : h('p', {}, schoolSet ? 'You have no classes that day.' : 'No class blocks are known for that day yet. Choose your week first (Saturday depends on it).'),
    h('div', { class: 'actions' }, button('Not in a class', () => { closeSheet(); onPick(null); }, 'btn-ghost')),
  ]);
}

// ---------- voice (inline under the add box) ----------
async function startVoiceFlow() {
  if (!app.state.prefs.voiceNoticeSeen) {
    const ok = await confirmDialog({
      title: 'Before you use the microphone',
      body: [
        h('p', {}, 'Voice input uses your browser\'s own speech service to turn speech into text. Depending on your browser, the audio may be sent to the browser maker\'s servers (for example Google for Chrome, or Apple for Safari) to be transcribed.'),
        h('p', {}, 'Blockwise never records or stores audio. Nothing is saved until you check the text and tap Save.'),
      ],
      okLabel: 'Continue', cancelLabel: 'Not now',
    });
    if (!ok) return;
    commit((s) => { s.prefs.voiceNoticeSeen = true; });
  }
  if (!voice) voice = createVoiceController({ win: window, onChange: (vs) => { app.voiceState = vs.state === 'idle' ? null : vs; render(); } });
  voice.start();
}
function stopVoice() { if (voice) { voice.cancel(); voice = null; } app.voiceState = null; }

function voicePanel() {
  const vs = app.voiceState;
  if (vs.state === 'listening' || vs.state === 'processing') {
    return h('div', { class: 'voice-live', role: 'status' },
      h('span', { class: 'pulse', 'aria-hidden': 'true' }),
      h('strong', {}, vs.state === 'listening' ? 'Listening… say one task.' : 'Finishing…'),
      vs.transcript ? h('p', { class: 'transcript' }, vs.transcript) : null,
      h('div', { class: 'actions' },
        button('Stop', () => voice.stop(), 'btn-primary btn-small', { disabled: vs.state !== 'listening', 'data-key': 'voice-stop' }),
        button('Cancel', () => voice.cancel(), 'btn-secondary btn-small', { 'data-key': 'voice-cancel' })));
  }
  if (vs.state === 'review') {
    const tid = uniqueId('vt');
    const ta = h('textarea', { id: tid, rows: '2' });
    ta.value = vs.transcript;
    return h('div', { class: 'voice-review' },
      h('label', { for: tid }, 'What I heard (edit if needed)'), ta,
      h('div', { class: 'actions' },
        button('Use this text', () => { app.addText = ta.value; app.addDraft = parseTaskText(ta.value, today()); voice.reset(); }, 'btn-primary btn-small', { 'data-key': 'voice-use' }),
        button('Try again', () => voice.start(), 'btn-secondary btn-small'),
        button('Discard', () => voice.reset(), 'btn-ghost btn-small')));
  }
  return h('div', { class: 'callout callout-warn', role: 'alert' }, h('p', {}, VOICE_ERRORS[vs.error] || VOICE_ERRORS.error),
    h('div', { class: 'actions' },
      vs.error !== 'denied' && vs.error !== 'unsupported' ? button('Try again', () => voice.start(), 'btn-secondary btn-small') : null,
      button('Type instead', () => { voice.reset(); document.getElementById('add-input')?.focus(); }, 'btn-ghost btn-small')));
}

// ---------- now ----------
/** Name of the free time a session sits in: “C block”, “Study hours”, a free-time label, or null. */
function slotLabel(date, item) {
  const st = app.state;
  for (const b of blocksForDate(st, date)) {
    if (b.kind !== 'free') continue;
    const s = D.parseHM(b.start), e = D.parseHM(b.end);
    if (item.start >= s && item.start < e) return b.school ? b.label.replace(/x block$/, ' block') : (b.label || 'Free time');
  }
  const ds = daySettings(st, date);
  if (ds.studyStart && item.start >= D.parseHM(ds.studyStart) && item.start < D.parseHM(ds.studyStop)) return 'Study hours';
  return null;
}

function nowCard(plan, t, week) {
  const ns = nextSession(plan, app.state, now());
  if (!ns) {
    const next = week.days.slice(1).map((p) => ({ p, i: p.items.find((x) => x.type === 'session') })).find((x) => x.i);
    const over = plan.stopMin != null && nowMin() >= plan.stopMin;
    const title = over ? 'That\'s it for today' : plan.freeTotal === 0 ? 'No free time left today' : 'Nothing more today';
    const first = over ? 'Study hours are over.' : '';
    const nextText = next ? `Next up: ${taskById(next.i.taskId)?.title} · ${D.relativeDateLabel(next.p.date, t)}${slotLabel(next.p.date, next.i) ? `, ${slotLabel(next.p.date, next.i)}` : ''} ${fmtT(next.i.start)}.` : 'Nothing else needs time this week.';
    return h('section', { class: 'now now-empty', 'aria-label': 'Now' }, h('h2', { tabindex: '-1' }, title), h('p', { class: 'muted' }, `${first} ${nextText}`.trim()));
  }
  const { item, task, status } = ns;
  const fs = firstStepFor(task);
  const label = slotLabel(t, item);
  return h('section', { class: 'now', 'aria-labelledby': 'now-title' },
    h('p', { class: 'eyebrow' }, `${status === 'now' ? 'Now' : 'Next'} · ${label ? `${label} · ` : ''}${fmtRange(item.start, item.end)}`),
    h('h2', { id: 'now-title', tabindex: '-1' }, task.title),
    h('p', { class: 'why-short' }, nowLine(plan, item, task)),
    task.firstStep || isSubstantial(task) ? h('p', { class: 'first-step' }, 'Start with: ', fs.text) : null,
    h('div', { class: 'actions now-actions' },
      button('Done', () => openDone(item, task), 'btn-primary btn-large', { 'data-key': 'now-done' }),
      button('Not now', () => notNow(t, task), 'btn-secondary btn-large', { 'data-key': 'now-skip' })),
    h('div', { class: 'now-links' },
      button('Why this?', () => openWhy(plan, item, task), 'btn-link btn-small why-link'),
      button('Edit', () => openEditTask(task.id), 'btn-link btn-small', { 'aria-label': `Edit ${task.title}: due date, time left, priority`, 'data-key': 'now-edit' })));
}

/** “Test tomorrow. 45 min of 1 h left.” (+ turn-taking when two things are due). */
function nowLine(plan, item, task) {
  const info = plan.tasks[item.taskId] || {};
  const t = today();
  const parts = [];
  if (info.late) parts.push('Past its due date — you said you\'re still doing it.');
  else if (task.deadline) {
    const rel = D.relativeDateLabel(task.deadline.date, t);
    const when = ['Today', 'Tomorrow'].includes(rel) ? rel.toLowerCase() : rel;
    parts.push(`${task.kind === 'test' ? 'Test' : 'Due'} ${when}${task.deadline.block ? ` in ${task.deadline.block} block` : task.deadline.time ? ` at ${fmtT(D.parseHM(task.deadline.time))}` : ''}.`);
  } else parts.push('No due date, so it uses spare time.');
  parts.push(`This session ${fmtDur(item.minutes)} · ${fmtDur(task.remainingMin)} left in total.`);
  return parts.join(' ');
}

/** “Takes turns with …” when two urgent things share tonight (shown under Why this?). */
function turnTaking(plan, item) {
  const info = plan.tasks[item.taskId] || {};
  if (info.tier !== 'urgent' || info.late || info.cutoffMin != null) return null;
  const partner = Object.entries(plan.tasks).find(([id, o]) => id !== item.taskId && o.tier === 'urgent' && o.scheduled > 0 && taskById(id) && taskById(id).status === 'open');
  return partner ? `Takes turns with “${taskById(partner[0]).title}” so neither gets squeezed.` : null;
}

function openWhy(plan, item, task) {
  markReviewed();
  const turns = turnTaking(plan, item);
  openSheet('Why this?', [
    h('ul', {}, ...(turns ? [turns] : []).concat(explainSession(plan, app.state, item)).map((l) => h('li', {}, l))),
    h('p', { class: 'small muted' }, 'Blockwise fills your free blocks and study hours for the week, and updates the plan whenever something changes.'),
    button('Edit this task', () => openEditTask(task.id), 'btn-secondary btn-small'),
  ]);
}

function openDone(item, task) {
  markReviewed();
  const asPlanned = Math.max(0, task.remainingMin - item.minutes);
  const options = [...new Set([asPlanned, 15, 30, 45, 60, 90, 120, 180].filter((m) => m > 0))].sort((a, b) => a - b);
  openSheet(task.title, [
    h('button', { type: 'button', class: 'choice', onclick: () => logDone(item, task, 0), 'data-key': 'done-finished' },
      h('span', { class: 'choice-title' }, 'Finished it'), h('span', { class: 'choice-sub' }, 'Marks it done')),
    h('p', { class: 'field-label' }, 'Not yet — about how much is left?'),
    h('div', { class: 'quick-chips' }, ...options.map((m) => button(m === asPlanned ? `${fmtDur(m)} (as planned)` : fmtDur(m), () => logDone(item, task, m), 'chip-btn', { 'aria-label': `About ${fmtDur(m)} left` }))),
    button('I didn\'t get to it', () => { closeSheet(); notNow(today(), task); }, 'btn-link btn-small'),
  ]);
}

/** The student just did a session; they tell us what's really left (not assumed from minutes worked). */
function logDone(item, task, left) {
  closeSheet();
  const stamp = now().toISOString();
  commit(() => {
    task.progress.push({ at: stamp, date: today(), workedMin: item.minutes, remainingBefore: task.remainingMin, remainingAfter: left });
    task.remainingMin = left;
    task.estimateSource = 'user';
    task.updatedAt = stamp;
    if (left === 0) { task.status = 'done'; task.completedAt = stamp; }
  }, null);
  const undo = { label: 'Undo', fn: () => commit(() => {
    const p = task.progress.pop();
    task.remainingMin = p.remainingBefore;
    if (task.status === 'done') { task.status = 'open'; delete task.completedAt; }
  }, 'Undone.') };
  toast(left === 0 ? `Nice work — “${task.title}” is done.` : `Got it — about ${fmtDur(left)} left. Your week is updated.`, undo);
}

function notNow(date, task) {
  markReviewed();
  commit(() => { const d = dayRecord(date); d.skipped = [...new Set([...(d.skipped || []), task.id])]; }, null);
  toast(`“${task.title}” moved to later days.`, { label: 'Undo', fn: () => unskipTask(date, task.id) });
}
function unskipTask(date, id) {
  commit(() => { const d = dayRecord(date); d.skipped = (d.skipped || []).filter((x) => x !== id); }, 'Back on today.');
}
function completeTask(id) {
  commit(() => {
    const x = taskById(id);
    x.status = 'done'; x.remainingMin = 0; x.completedAt = now().toISOString(); x.updatedAt = x.completedAt;
  }, 'Marked done.');
}

/** One-line warnings: what doesn't fit, what's overdue, what was moved, and plain notes. */
function alerts(plan, t) {
  const out = [];
  const short = plan.notFit.filter((x) => x.kind === 'deadline').map((f) => ({ f, task: taskById(f.taskId) })).filter((x) => x.task && x.task.status === 'open');
  if (short.length === 1) {
    out.push(h('p', { class: 'alert alert-danger' },
      `About ${fmtDur(short[0].f.minutes)} of “${short[0].task.title}” won't fit before it's due. `,
      button('What can I do?', openOverflowHelp, 'btn-link btn-small')));
  } else if (short.length > 1) {
    const total = short.reduce((m, x) => m + x.f.minutes, 0);
    out.push(h('div', { class: 'alert alert-danger' },
      h('p', {}, `About ${fmtDur(total)} of work across ${short.length} tasks won't fit before it's due. `, button('What can I do?', openOverflowHelp, 'btn-link btn-small')),
      h('details', { class: 'alert-details' }, h('summary', {}, 'Which tasks'),
        h('ul', {}, ...short.map(({ f, task }) => h('li', {}, `“${task.title}”: about ${fmtDur(f.minutes)}`))))));
  }
  const live = rankTasks(app.state.tasks.filter((x) => x.status === 'open'), { date: t, today: t, refMin: nowMin(), earliestStudyMin: earliestStudyFn(app.state), skipped: new Set() });
  for (const a of live.attention) {
    out.push(h('p', { class: 'alert alert-warn' },
      a.dueTodayDateOnly ? `“${a.task.title}” is due today (no time given). `
        // Not over yet, but there's no free time left before it (e.g. a test in B block with no free block before it)
        : a.state === 'beforeStudy' ? `“${a.task.title}”: ${dueLabel(a.task, t)}, with no free time left before it. `
        : a.task.kind === 'test' ? `“${a.task.title}”: the test was ${lowerFirst(dueLabel(a.task, t).replace(/^Test /, ''))}. `
        : `“${a.task.title}” was ${lowerFirst(dueLabel(a.task, t))}. `,
      button('Finished', () => completeTask(a.task.id), 'btn-link btn-small', { 'aria-label': `Finished ${a.task.title}` }),
      a.task.kind === 'test' ? null : button('Still doing it', () => commit(() => { taskById(a.task.id).lateWork = true; }, 'Added back as late work.'), 'btn-link btn-small', { 'aria-label': `Still doing ${a.task.title}` }),
      button('Change date', () => openEditTask(a.task.id, 'deadline'), 'btn-link btn-small', { 'aria-label': `Change date for ${a.task.title}` })));
  }
  const skipped = daySettings(app.state, t).skipped.map(taskById).filter((x) => x && x.status === 'open');
  if (skipped.length) {
    out.push(h('p', { class: 'alert' }, `Moved off today: ${skipped.map((x) => x.title).join(', ')}. `,
      ...skipped.map((x) => button(skipped.length > 1 ? `Bring back ${x.title}` : 'Bring back', () => unskipTask(t, x.id), 'btn-link btn-small', { 'aria-label': `Bring back ${x.title}` }))));
  }
  for (const w of plan.warnings || []) {
    if (w.startsWith('Not everything due') || w.startsWith('You skipped') || w.startsWith('Study hours are over') || w.startsWith('No free study time')) continue;
    out.push(h('p', { class: 'alert' }, w));
  }
  return out.length ? h('div', { class: 'alerts' }, ...out) : null;
}

function openOverflowHelp() {
  openSheet('When it doesn\'t all fit', [
    h('ul', {},
      h('li', {}, 'Talk with your teacher early — sooner is easier than the night before.'),
      h('li', {}, 'Tap “Not now” on something less urgent to free up time.'),
      h('li', {}, 'Have a free afternoon? Add it from the ⋯ menu.'),
      h('li', {}, 'If it\'s smaller than you thought, tap Done and say how much is left.')),
    h('p', { class: 'small muted' }, 'Blockwise won\'t plan past your study hours — sleep matters too.'),
  ]);
}

/** A task's name as a button that opens it (edit, mark done, delete). */
/** In a block's row: study time for a test reads "Study for Bio test", so it can't be mistaken for the test itself. */
function workLink(task) {
  if (task.kind !== 'test') return taskLink(task);
  const label = /^(study|prep|review|revise)\b/i.test(task.title) ? task.title : `Study for ${task.title}`;
  return h('button', { type: 'button', class: 'task-link', onclick: () => openEditTask(task.id) }, label);
}
function taskLink(task, extra = null) {
  return h('button', { type: 'button', class: 'task-link', onclick: () => openEditTask(task.id) }, task.title,
    task.kind === 'test' ? h('span', { class: 'tag-test' }, 'test') : null, extra);
}

/** Done today (ticked), then the rest of today's sessions, labelled by block. */
function doneToday(t) {
  const done = new Map();
  for (const task of app.state.tasks) {
    const worked = (task.progress || []).filter((p) => p.date === t).reduce((s, p) => s + p.workedMin, 0);
    if (worked > 0 || (task.status === 'done' && task.completedAt && D.toISODate(new Date(task.completedAt)) === t)) done.set(task.id, { task, worked });
  }
  const rows = [];
  for (const { task, worked } of done.values()) {
    rows.push(h('li', { class: 'is-done' },
      h('span', { class: 'sl-main' }, taskLink(task), ' ', h('span', { class: 'check', 'aria-label': 'done' }, '✓')),
      h('span', { class: 'sl-meta' }, task.status === 'done' ? 'finished' : `${fmtDur(worked)} done`)));
  }
  if (!rows.length) return null;
  return h('section', { class: 'list-section', 'aria-label': 'Done today' }, h('ol', { class: 'simple-list' }, ...rows));
}

/** All of today, block by block: the same rows as Week (classes, free blocks, study hours). Finished blocks are dimmed. */
function todaySchedule(plan, t) {
  const nm = nowMin();
  const skipped = new Set(daySettings(app.state, t).skipped);
  const items = plan.items.filter((i) => i.type !== 'session' || (i.end > nm && !skipped.has(i.taskId) && taskById(i.taskId)?.status === 'open'));
  const info = daySlots({ ...plan, items }, t);
  if (!info.slots.length && !info.notes.length && !info.dueOther.length) return null;
  const inProgress = info.slots.some((sl) => sl.s <= nm && sl.e > nm);
  const nextIdx = inProgress ? -1 : info.slots.findIndex((sl) => sl.s > nm);
  const lis = info.slots.map((sl, idx) => {
    const past = sl.e <= nm;
    const now = !past && sl.s <= nm;
    const next = idx === nextIdx;
    const li = slotRow(past && !sl.cls && !sl.unset ? { ...sl, past: true } : (now ? { ...sl, freeTail: sl.items && sl.items.length ? Math.min(sl.freeTail, sl.e - nm) : sl.e - nm } : sl));
    if (past) li.classList.add('is-past');
    if (now || next) {
      li.classList.add('is-now');
      li.querySelector('.slot-when').append(h('span', { class: 'now-tag' }, now ? 'now' : 'next'));
    }
    return li;
  });
  const allOver = info.slots.length > 0 && info.slots.every((sl) => sl.e <= nm);
  return h('section', { class: 'list-section', 'aria-label': 'Today\'s blocks' },
    h('div', { class: 'day-card today-card' },
      h('h2', { class: 'today-card-title' }, 'Today\'s blocks'),
      app.state.tasks.some((x) => x.status === 'open') ? h('p', { class: 'hint today-tip' }, 'Tap a task to edit it.') : null,
      info.dueOther.length ? h('p', { class: 'day-due' }, 'Due today: ', ...joinNodes(info.dueOther.map((x) => taskLink(x, x.deadline.time && !x.deadline.block ? h('span', { class: 'muted small' }, ` · ${fmtT(D.parseHM(x.deadline.time))}`) : x.deadline.block ? h('span', { class: 'muted small' }, ` · ${x.deadline.block} block`) : null)))) : null,
      lis.length ? h('ul', { class: 'slots' }, ...lis) : null,
      allOver ? h('p', { class: 'day-note' }, 'No more scheduled blocks today.') : null,
      ...info.notes.map((n) => h('p', { class: 'day-note' }, n))));
}
// ===================== WEEK =====================
// Each day lists its free blocks and study hours as rows: what Blockwise put there, or "Free".
function renderWeek(week) {
  const root = clear($('#view-week'));
  const t = today();
  put(root, h('div', { class: 'week-head' },
    h('div', { class: 'week-title-row' }, h('h1', { id: 'week-title', tabindex: '-1' }, 'This week'),
      button('Edit schedule', openSchedule, 'btn-link btn-small head-edit', { 'data-key': 'head-edit-week' })),
    h('p', { class: 'lead' }, 'Your free blocks and study hours, filled in for you.'),
    app.state.prefs.weekTipHidden ? null : h('p', { class: 'hint week-tip' }, 'Updates by itself. Tap any task, day or block to change it. ',
      button('Hide', () => commit((s) => { s.prefs.weekTipHidden = true; }), 'btn-link btn-small', { 'aria-label': 'Hide this tip', 'data-key': 'week-tip-hide' }))));
  if (!week) { put(root, h('p', { class: 'alert alert-danger' }, 'Something went wrong making your plan. Your tasks are safe.')); return; }
  if (!app.state.settings.school) {
    put(root, h('section', { class: 'callout-card', 'aria-label': 'Set up your free blocks' },
      h('p', { class: 'callout-title' }, 'Which of these blocks are free for you?'),
      h('p', { class: 'small' }, 'Here\'s the Middlesex timetable. Mark your free blocks and Blockwise will plan work in them. Until then, it only uses study hours.'),
      h('div', { class: 'actions' }, button('Set up free blocks', openSchoolSetup, 'btn-primary btn-small', { 'data-key': 'week-setup' }))));
  }
  const open = app.state.tasks.filter((x) => x.status === 'open');
  const name = (x) => taskLink(x, x.deadline && x.deadline.block ? h('span', { class: 'muted small' }, ` · ${x.deadline.block} block`) : null);
  // On a phone, one day at a time: a row of day buttons with ‹ ›. On a computer, the whole week (the row is hidden).
  const days = week.days.slice(1); // tomorrow … six days out (today is on Today)
  const sel = Math.min(Math.max(app.weekSel || 0, 0), days.length - 1);
  const end = D.addDays(t, week.days.length - 1);
  const dueThisWeek = open.filter((x) => x.deadline && x.deadline.date > t && x.deadline.date <= end).length;
  const wontFit = new Set(week.shortfalls.map((f) => f.taskId)).size;
  if (dueThisWeek || wontFit) {
    put(root, h('p', { class: 'week-summary' }, [dueThisWeek ? `${dueThisWeek} due this week` : null, wontFit ? `${wontFit} won't fit` : null].filter(Boolean).join(' · ')));
  }
  const pick = (i) => { app.weekSel = i; render(); };
  const dueOn = (date) => open.some((x) => x.deadline && x.deadline.date === date);
  put(root, h('div', { class: 'week-pager' },
    button('‹', () => pick(sel - 1), 'ws-arrow', { 'aria-label': 'Previous day', disabled: sel === 0, 'data-key': 'ws-prev' }),
    h('div', { class: 'week-strip', role: 'group', 'aria-label': 'Days' }, ...days.map((plan, i) => {
      const date = plan.date;
      const wd = D.weekdayName(date, true);
      const due = dueOn(date);
      // Shows "Mon / 16"; screen readers hear "Mon 16" (plus "Tomorrow" and "something due" where they apply)
      return h('button', { type: 'button', class: ['ws-day', i === sel && 'is-selected'], 'aria-pressed': String(i === sel), 'data-key': `ws-${i}`, onclick: () => pick(i) },
        i === 0 ? h('span', { class: 'visually-hidden' }, 'Tomorrow, ') : null,
        h('span', { class: 'ws-wd' }, wd.slice(0, 3)),
        h('span', { class: 'ws-num' }, String(Number(date.slice(8))), due ? h('span', { class: 'visually-hidden' }, ', something due') : null),
        due ? h('span', { class: 'ws-dot', 'aria-hidden': 'true' }) : null);
    })),
    button('›', () => pick(sel + 1), 'ws-arrow', { 'aria-label': 'Next day', disabled: sel === days.length - 1, 'data-key': 'ws-next' })));
  const list = h('ol', { class: 'week-list' });
  for (let i = 1; i < week.days.length; i++) {
    const plan = week.days[i];
    const date = plan.date;
    const plannedMin = plan.items.filter((it) => it.type === 'session').reduce((m, it) => m + it.minutes, 0);
    const short = week.shortfalls.filter((f) => f.date === date).map((f) => ({ f, task: taskById(f.taskId) })).filter((x) => x.task);
    const info = daySlots(plan, date);
    const due = info.dueOther; // due in a class block → shown in that block's row instead
    const wt = D.weekdayOf(date) === 6 ? weekTypeFor(app.state, date) : null;
    list.append(h('li', { class: ['day-card', i - 1 === sel && 'is-selected'] },
      h('div', { class: 'day-top' },
        h('button', { type: 'button', class: 'day-name', onclick: () => openDaySheet(date) },
          i === 1 ? 'Tomorrow' : D.weekdayName(date, true), ' ',
          h('span', { class: 'day-date' }, i === 1 ? D.formatDate(date, t) : D.formatDate(date, t).replace(/^\w+, /, '')),
          h('span', { class: 'visually-hidden' }, ' – change this day')),
        wt ? h('span', { class: 'chip' }, `${wt} week`) : null),
      h('p', { class: 'day-planned' }, plannedMin ? `${fmtDur(plannedMin)} of study planned` : 'No study planned'),
      due.length ? h('p', { class: 'day-due' }, 'Due: ', ...joinNodes(due.map(name))) : null,
      info.slots.length ? h('ul', { class: 'slots' }, ...info.slots.map(slotRow)) : null,
      ...info.notes.map((n) => h('p', { class: 'day-note' }, n)),
      ...short.map(({ f, task }) => h('p', { class: 'day-warn' }, `About ${fmtDur(f.minutes)} of “${task.title}” won't fit before it's due.`))));
  }
  put(root, list);
  const later = open.filter((x) => x.deadline && x.deadline.date > end).sort((a, b) => a.deadline.date.localeCompare(b.deadline.date));
  const undated = open.filter((x) => !x.deadline);
  if (later.length || undated.length) {
    put(root, h('section', { class: 'list-section', 'aria-label': 'Later' }, h('ul', { class: 'simple-list' },
      later.length ? h('li', {}, h('span', { class: 'sl-time' }, 'Later'), h('span', { class: 'sl-main names' }, ...joinNodes(later.map((x) => h('span', {}, name(x), h('span', { class: 'muted small' }, ` ${D.formatDate(x.deadline.date, t)}`)))))) : null,
      undated.length ? h('li', {}, h('span', { class: 'sl-time' }, 'No date'), h('span', { class: 'sl-main names' }, ...joinNodes(undated.map(name)))) : null)));
  }
  put(root, remindersCard());
}

/** A small colored square for a block letter (decorative: the letter is always written next to it). */
const blockDot = (code) => (code && /^[A-G]/.test(code) ? h('span', { class: `blk-dot blk-${code[0]}`, 'aria-hidden': 'true' }) : null);

function slotRow(sl) {
  // What's due in this block: the task's name and a "Test"/"Due" tag, never minutes (minutes mean work time).
  const dueEls = (sl.due || []).map((task) => h('p', { class: 'slot-due' },
    h('button', { type: 'button', class: 'task-link', onclick: () => openEditTask(task.id) }, task.title),
    h('span', { class: 'due-pill' }, task.kind === 'test' ? 'Test' : 'Due')));
  const hasDue = dueEls.length > 0;
  if (sl.unset) {
    return h('li', { class: ['slot is-class is-unset', hasDue && 'has-due'] },
      h('div', { class: 'slot-when' }, h('span', { class: 'slot-name' }, blockDot(sl.letter || sl.block), sl.name), h('span', { class: 'slot-time' }, fmtRange(sl.s, sl.e))),
      h('div', { class: 'slot-what' }, ...dueEls, h('span', { class: 'class-label' }, 'Not set yet')));
  }
  const nameEl = sl.letter
    ? h('button', { type: 'button', class: 'slot-name slot-btn', onclick: () => openBlockSheet(sl.date, sl.letter), 'aria-label': `${sl.name}, ${fmtRange(sl.s, sl.e)}. ${sl.kept ? 'Kept free' : 'Free'}. Change` }, blockDot(sl.letter), sl.name)
    : h('span', { class: 'slot-name' }, blockDot(sl.letter || sl.block), sl.name);
  if (sl.kept) {
    return h('li', { class: ['slot is-kept', hasDue && 'has-due'] },
      h('div', { class: 'slot-when' }, nameEl, h('span', { class: 'slot-time' }, fmtRange(sl.s, sl.e))),
      h('div', { class: 'slot-what' }, ...dueEls, h('span', { class: 'class-label' }, sl.kept === 'always' ? 'Kept free' : 'Kept free this day')));
  }
  if (sl.cls) {
    return h('li', { class: ['slot is-class', hasDue && 'has-due'] },
      h('div', { class: 'slot-when' }, h('span', { class: 'slot-name' }, blockDot(sl.letter || sl.block), sl.name), h('span', { class: 'slot-time' }, fmtRange(sl.s, sl.e))),
      h('div', { class: 'slot-what' }, ...(hasDue ? dueEls : [h('span', { class: 'class-label' }, 'Class')])));
  }
  if (sl.past) {
    return h('li', { class: ['slot', hasDue && 'has-due'] },
      h('div', { class: 'slot-when' }, h('span', { class: 'slot-name' }, blockDot(sl.letter || sl.block), sl.name), h('span', { class: 'slot-time' }, fmtRange(sl.s, sl.e))),
      h('div', { class: 'slot-what' }, ...dueEls, h('span', { class: 'class-label' }, 'Over')));
  }
  const free = !sl.items.length;
  return h('li', { class: ['slot', free && 'is-free', hasDue && 'has-due'] },
    h('div', { class: 'slot-when' }, nameEl, h('span', { class: 'slot-time' }, fmtRange(sl.s, sl.e))),
    h('div', { class: 'slot-what' }, ...dueEls,
      ...sl.items.map((m) => { const task = taskById(m.taskId); return h('p', { class: 'slot-task' }, task ? workLink(task) : 'Task', h('span', { class: 'mins' }, fmtShort(m.minutes))); }),
      free ? h('span', { class: 'free-pill' }, 'Free')
        : sl.freeTail >= 15 ? h('span', { class: 'free-pill' }, `Free · ${fmtShort(sl.freeTail)}`) : null));
}
const fmtShort = (m) => fmtDur(m).replace(' min', ' m');

/** A day's rows: free blocks, extra free time and study hours (with what was placed in each), plus classes for context. */
function daySlots(plan, date) {
  const st = app.state;
  const ds = daySettings(st, date);
  const school = schoolBlocksForDate(st, date);
  const slots = [];
  for (const b of blocksForDate(st, date).filter((x) => x.kind === 'free').sort((a, c) => a.start.localeCompare(c.start))) {
    const s = D.parseHM(b.start), e = D.parseHM(b.end);
    const last = slots[slots.length - 1];
    if (last && s <= last.e && last.school && b.school) { last.e = Math.max(last.e, e); continue; }
    slots.push({ s, e, name: b.school ? b.label.replace(/x block$/, ' block') : (b.label || 'Free time'), school: b.school, letter: b.school ? b.letter : null, date });
  }
  if (ds.studyStart) slots.push({ s: D.parseHM(ds.studyStart), e: D.parseHM(ds.studyStop), name: 'Study hours' });
  const sessions = plan.items.filter((i) => i.type === 'session');
  for (const sl of slots) {
    const inside = sessions.filter((i) => i.start >= sl.s && i.start < sl.e);
    sl.items = [];
    for (const i of inside) {
      const last = sl.items[sl.items.length - 1];
      if (last && last.taskId === i.taskId) last.minutes += i.minutes; else sl.items.push({ taskId: i.taskId, minutes: i.minutes });
    }
    const lastEnd = inside.reduce((m, i) => Math.max(m, i.end), sl.s);
    sl.freeTail = inside.length ? sl.e - lastEnd : sl.e - sl.s;
  }
  const kept = [];
  for (const b of [...school.kept].sort((a, c) => a.start.localeCompare(c.start))) {
    const s = D.parseHM(b.start), e = D.parseHM(b.end);
    const last = kept[kept.length - 1];
    if (last && s <= last.e && last.letter === b.letter) { last.e = Math.max(last.e, e); continue; }
    kept.push({ s, e, name: `${b.letter} block`, letter: b.letter, date, kept: b.keptWhy, items: [] });
  }
  slots.push(...kept);
  for (const c of classPeriodsForDate(st, date)) slots.push({ s: c.start, e: c.end, name: `${c.code} block`, block: c.code, cls: true });
  // Before setup: show the timetable, with each block's availability "not set" (nothing is planned in them).
  let unsetNote = null;
  if (!school.configured && !(st.days[date] && st.days[date].noClasses)) {
    const tt = timetableForDate(date);
    if (tt === null) unsetNote = `Saturday classes depend on the week (${MIDDLESEX.weekTypes.join(' or ')}). Set up your free blocks to see them.`;
    else for (const c of tt) slots.push({ s: c.start, e: c.end, name: `${c.code} block`, block: c.code, unset: true });
  }
  slots.sort((a, c) => a.s - c.s);
  // Something due in a class block ("Bio test Friday, D block") shows in that block's row: it happens then,
  // it isn't work to do then. Anything else due that day (no block, or the block doesn't meet) is listed separately.
  const dueAll = st.tasks.filter((x) => x.status === 'open' && x.deadline && x.deadline.date === date);
  const dueOther = [];
  for (const task of dueAll) {
    const dl = task.deadline;
    const tm = dl.block && dl.time ? D.parseHM(dl.time) : null;
    const inRow = (sl) => tm !== null && sl.s <= tm && tm < sl.e;
    const row = tm === null ? null
      : slots.find((sl) => (sl.block || sl.letter) === dl.block && inRow(sl))
        || slots.find((sl) => sl.cls && inRow(sl)) || slots.find((sl) => sl.name !== 'Study hours' && inRow(sl));
    if (row) (row.due ||= []).push(task); else dueOther.push(task);
  }
  const notes = [];
  if (unsetNote) notes.push(unsetNote);
  if (school.noClasses) notes.push(school.satOff ? 'No Saturday classes. Tap the day if there are.' : 'No classes this day.');
  if (!ds.studyStart) notes.push(ds.noStudy ? 'Busy that evening.' : 'No study hours.');
  if (!slots.some((x) => !x.cls && !x.kept && !x.unset) && !notes.length) notes.push('No free time.');
  return { slots, notes, dueOther };
}
const joinNodes = (nodes) => nodes.flatMap((n, i) => (i ? [', ', n] : [n]));

function openDaySheet(date) {
  const st = app.state;
  const school = schoolBlocksForDate(st, date);
  const day = st.days[date] || {};
  const sw = (label, sub, checked, onchange) => {
    const id = uniqueId('sw');
    return h('label', { class: 'switch-row', for: id }, h('input', { type: 'checkbox', role: 'switch', id, checked, onchange }), h('span', {}, h('strong', {}, label), h('span', { class: 'muted small block' }, sub)));
  };
  openSheet(D.formatDate(date, today()), [
    school.configured && D.weekdayOf(date) === 6 ? h('div', { class: 'field' },
      h('span', { class: 'field-label', id: `${date}-satq` }, 'Classes this Saturday'),
      h('div', { class: 'block-grid', role: 'group', 'aria-labelledby': `${date}-satq` },
        ...weekChoiceButtons(school.noClasses ? 'NONE' : school.weekType, (wk) => { closeSheet(); commit(() => {
          const rec = dayRecord(date);
          if (wk === 'NONE') { rec.noClasses = true; delete rec.satType; } else { delete rec.noClasses; rec.satType = wk; }
        }, wk === 'NONE' ? 'No classes that Saturday.' : `${saturdayLetters(wk)} that Saturday.`); }, 'sat'))) : null,
    school.configured && D.weekdayOf(date) !== 6 ? sw('No classes this day', 'Day off, long weekend or special schedule', school.noClasses, (e) => commit(() => { if (e.target.checked) dayRecord(date).noClasses = true; else delete dayRecord(date).noClasses; }, 'Updated.')) : null,
    sw('Busy that evening', 'No study hours (game, rehearsal, event)', !!day.noStudy, (e) => commit(() => { if (e.target.checked) dayRecord(date).noStudy = true; else delete dayRecord(date).noStudy; }, 'Updated.')),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Add free time that day'),
      h('div', { class: 'quick-chips' }, ...[['Morning', '09:00', '12:00'], ['Afternoon', '13:00', '17:00']].map(([l, s, e]) =>
        button(`${l} ${fmtRange(D.parseHM(s), D.parseHM(e))}`, () => { closeSheet(); addFreeTime(date, l, s, e); }, 'chip-btn')))),
  ]);
}

/** One free block on one day: keep it free that day, or always. */
function openBlockSheet(date, letter) {
  const st = app.state;
  const t = today();
  const always = ((st.settings.school && st.settings.school.keepFree) || []).includes(letter);
  const skipped = ((st.days[date] && st.days[date].skipBlocks) || []).includes(letter);
  const dayName = date === t ? 'today' : `on ${D.weekdayName(date, true)}`;
  const idDay = uniqueId('sw'), idAll = uniqueId('sw');
  const daySwitch = h('input', { type: 'checkbox', role: 'switch', id: idDay, checked: !skipped && !always, disabled: always, onchange: (e) => {
    commit((s) => {
      const rec = (s.days[date] ||= {});
      const set = new Set(rec.skipBlocks || []);
      if (e.target.checked) set.delete(letter); else set.add(letter);
      if (set.size) rec.skipBlocks = [...set].sort(); else delete rec.skipBlocks;
    }, e.target.checked ? `${letter} block is back in the plan ${dayName}.` : `${letter} block kept free ${dayName}.`);
  } });
  const allSwitch = h('input', { type: 'checkbox', role: 'switch', id: idAll, checked: always, onchange: (e) => {
    commit((s) => {
      const set = new Set(s.settings.school.keepFree || []);
      if (e.target.checked) set.add(letter); else set.delete(letter);
      if (set.size) s.settings.school.keepFree = [...set].sort(); else delete s.settings.school.keepFree;
    }, e.target.checked ? `${letter} block is kept free every week.` : `${letter} block is used for work again.`);
    daySwitch.disabled = e.target.checked;
    daySwitch.checked = !e.target.checked && !((app.state.days[date] && app.state.days[date].skipBlocks) || []).includes(letter);
  } });
  openSheet(`${letter} block · ${D.formatDate(date, t)}`, [
    h('label', { class: 'switch-row', for: idDay }, daySwitch, h('span', {}, h('strong', {}, `Plan work in ${letter} block ${dayName}`), h('span', { class: 'muted small block' }, 'Turn off to keep it free just this once.'))),
    h('label', { class: 'switch-row', for: idAll }, allSwitch, h('span', {}, h('strong', {}, `Always keep ${letter} block free`), h('span', { class: 'muted small block' }, 'For lunch, a club, or time off. Blockwise won\'t plan work in it any week.'))),
  ]);
}

// ---------- reminders ----------
function remindersCard() {
  const bell = svgEl('svg', { width: '18', height: '18', viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  bell.append(svgEl('path', { d: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0' }));
  return h('section', { class: 'reminders', 'aria-label': 'Reminders' },
    h('p', {}, 'Get a phone alert before each free block and study hours'),
    h('button', { type: 'button', class: 'btn btn-secondary btn-block', onclick: openReminders, 'data-key': 'reminders' }, bell, ' Add reminders to my calendar'));
}

function openReminders() {
  const t = today();
  const events = reminderEvents(app.state, t);
  const blocks = events.filter((e) => !e.title.startsWith('Study'));
  const demo = app.mode === 'demo';
  openSheet('Reminders in your calendar', [
    h('p', {}, `This adds ${events.length} repeating event${events.length === 1 ? '' : 's'} to your phone's calendar — ${blocks.length ? `one for each free block and ` : ''}one for each evening's study hours — each with an alert 5 minutes before. They say “open Blockwise”, and Blockwise shows what to do.`),
    !app.state.settings.school ? h('p', { class: 'callout' }, 'Tap your free blocks first (Edit schedule → Classes & free blocks) to get block reminders too.') : null,
    h('ul', { class: 'small' },
      h('li', {}, 'iPhone: open the downloaded file and tap “Add All”.'),
      h('li', {}, 'Google Calendar: on a computer, open calendar.google.com → Settings → Import and choose the file. Some Android calendar apps can open it directly.'),
      h('li', {}, 'Your free blocks don\'t change, so you only do this once (again only if your blocks change).'),
      h('li', {}, 'Alerts still go off on days off — delete that day\'s event if you like. To remove them all, delete the Blockwise events.'),
      h('li', {}, 'Nothing is sent anywhere: the file is made on this device.')),
    demo ? h('p', { class: 'callout' }, 'This is the example, so its reminders would be fictional. Exit the example to make your own.') : null,
    h('div', { class: 'actions' },
      button('Download calendar file', () => {
        const url = /^https?:/.test(location.protocol) ? location.origin + location.pathname : '';
        downloadText(buildReminderCalendar(app.state, { today: t, now: now(), appUrl: url }), 'blockwise-reminders.ics', 'text/calendar');
        toast('Calendar file made — check your downloads.');
      }, 'btn-primary', { disabled: demo || !events.length, 'data-key': 'reminders-download' })),
  ]);
}

// ---------- the ⋯ menu ----------
function openMenu() {
  const st = app.state;
  const demo = app.mode === 'demo';
  const row = (label, sub, onclick, key) => h('button', { type: 'button', class: 'menu-row', onclick, 'data-key': key }, h('span', { class: 'choice-title' }, label), sub ? h('span', { class: 'choice-sub' }, sub) : null);
  openSheet('Menu', [
    h('h3', { class: 'small-heading' }, 'Help'),
    row('How to use Blockwise', 'The four steps, and what the buttons do', openHowTo, 'menu-howto'),
    row('How Blockwise decides', null, () => openSheet('How Blockwise decides', rulesExplainer()), 'menu-rules'),
    demo ? row('Exit the example', 'Back to your own tasks', () => { closeSheet(); exitDemo(); }, 'menu-exit-demo')
      : row('See an example day', 'Fictional — kept separate from your tasks', () => { closeSheet(); enterDemo(); }, 'demo-open'),
    h('h3', { class: 'small-heading' }, 'More'),
    row('Reminders', 'Phone alerts before free blocks and study hours', () => { closeSheet(); openReminders(); }, 'menu-reminders'),
    row('Add to your Home Screen', null, openInstallHelp, 'menu-install'),
    row('Feedback', 'Questions to answer and copy', () => openSheet('Feedback', feedbackForm()), 'menu-feedback'),
    row('Backup and data', 'Export, restore or delete', openDataSheet, 'menu-data'),
    USAGE_ENDPOINT ? row('Usage counts', usage.isOff() ? 'Off' : 'On · basic steps only, never your tasks', openUsageSheet, 'menu-usage') : null,
    demo ? null : h('div', { class: 'menu-danger' }, row('Start over…', 'Delete everything on this phone and set up again', startOver, 'menu-reset')),
  ]);
}

/** ⋯ → Usage counts: exactly what's sent, and the off switch. */
function openUsageSheet() {
  const id = uniqueId('usage');
  const on = !usage.isOff();
  openSheet('Usage counts', [
    h('p', {}, 'To see whether Blockwise helps, it counts a few basic steps. Middlesex approved this for the pilot.'),
    h('ul', { class: 'plain-list' },
      h('li', {}, 'Opened Blockwise (once a day)'),
      h('li', {}, 'Finished setup · made a first plan'),
      h('li', {}, 'Did something that day (added, edited or finished a task, or changed the schedule)'),
      h('li', {}, 'Came back in the second week after a first plan')),
    h('p', {}, h('strong', {}, 'Never sent: '), 'your tasks, deadlines, classes, free blocks, name, or anything you type or say. Each count has a random one-time code so it isn\'t counted twice, and nothing that links your counts together.'),
    h('p', { class: 'muted small' }, 'Counts go to a private Google Sheet only the person running the pilot can see. Like any website, Google receives your connection\'s IP address when a count is sent. The example day is never counted.'),
    h('label', { class: 'switch-row', for: id },
      h('input', { type: 'checkbox', role: 'switch', id, checked: on, onchange: (e) => {
        usage.setOff(!e.target.checked);
        if (e.target.checked) usageOpened();
        renderBanners();
        toast(e.target.checked ? 'Usage counts are on.' : 'Usage counts are off. Nothing more is sent.');
      } }),
      h('span', {}, h('strong', {}, 'Share usage counts'), h('span', { class: 'muted small block' }, 'Turn off anytime. Blockwise works the same either way.'))),
  ]);
}

/** Edit schedule: today-only changes first (with the date), then the usual week. Changes update the plan right away. */
function openSchedule() {
  const t = today();
  const st = app.state;
  const school = schoolBlocksForDate(st, t);
  const day = st.days[t] || {};
  const row = (label, sub, onclick, key) => h('button', { type: 'button', class: 'menu-row', onclick, 'data-key': key }, h('span', { class: 'choice-title' }, label), sub ? h('span', { class: 'choice-sub' }, sub) : null);
  const sw = (label, sub, checked, onchange) => {
    const id = uniqueId('sw');
    return h('label', { class: 'switch-row', for: id }, h('input', { type: 'checkbox', role: 'switch', id, checked, onchange }), h('span', {}, h('strong', {}, label), h('span', { class: 'muted small block' }, sub)));
  };
  const todayLetters = school.configured ? [...new Set([...school.blocks, ...school.kept.filter((b) => b.keptWhy === 'day')].map((b) => b.letter))].sort() : [];
  const skippedToday = new Set(day.skipBlocks || []);
  const sc = st.settings.school;
  openSheet('Edit schedule', [
    h('p', { class: 'hint' }, 'Changes update your plan right away. Your tasks and progress stay as they are.'),
    h('h3', { class: 'small-heading' }, `Today only — ${D.formatDate(t, t)}`),
    h('p', { class: 'hint' }, 'These change today only. For another day, tap that day on Week.'),
    school.configured ? sw('No classes today', 'Day off or special schedule', school.noClasses, (e) => commit(() => { if (e.target.checked) dayRecord(t).noClasses = true; else delete dayRecord(t).noClasses; }, e.target.checked ? 'No classes today.' : 'Classes back on.')) : null,
    sw('Busy tonight', 'No study hours tonight (game, rehearsal, event)', !!day.noStudy, (e) => commit(() => { if (e.target.checked) dayRecord(t).noStudy = true; else delete dayRecord(t).noStudy; }, e.target.checked ? 'Tonight is off.' : 'Study hours back on tonight.')),
    todayLetters.length ? h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'keep-today-label' }, 'Keep a free block free today'),
      h('div', { class: 'quick-chips', role: 'group', 'aria-labelledby': 'keep-today-label' }, ...todayLetters.map((L) => h('button', {
        type: 'button', class: 'block-chip', 'aria-pressed': String(skippedToday.has(L)), 'data-key': `keep-today-${L}`,
        onclick: (e) => {
          const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
          e.currentTarget.setAttribute('aria-pressed', String(on));
          commit((s2) => {
            const rec = (s2.days[t] ||= {});
            const set = new Set(rec.skipBlocks || []);
            if (on) set.add(L); else set.delete(L);
            if (set.size) rec.skipBlocks = [...set].sort(); else delete rec.skipBlocks;
          }, on ? `${L} block kept free today.` : `${L} block is back in today's plan.`);
        } }, L)))) : null,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Add free time today'),
      h('div', { class: 'quick-chips' }, ...[['Morning', '09:00', '12:00'], ['Afternoon', '13:00', '17:00']].map(([l, s0, e0]) =>
        button(`${l} ${fmtRange(D.parseHM(s0), D.parseHM(e0))}`, () => { closeSheet(); addFreeTime(t, l, s0, e0); }, 'chip-btn')),
        button('Other time…', () => openBlockEditor({ date: t, kind: 'free' }), 'chip-btn'))),
    h('h3', { class: 'small-heading' }, 'Usual schedule'),
    row('Classes & free blocks', sc ? `Free blocks ${sc.freeBlocks.join(', ') || 'none'}${(sc.keepFree || []).length ? ` (${sc.keepFree.join(', ')} kept free)` : ''}` : 'Tap your free blocks', openSchoolSetup, 'menu-classes'),
    sc ? row('Week rotation', sc.anchor ? `This is an ${school.weekType} week · change it after a break, or set no Saturday classes` : 'No Saturday classes · change it if Saturdays have classes', () => { closeSheet(); openWeekSheet(t); }, 'menu-rotation') : null,
    row('Study hours', studyHoursSummary().join(' · '), openStudyHoursEditor, 'menu-study'),
  ]);
}

function addFreeTime(date, label, start, end) {
  commit((s) => { s.blocks.push({ id: newId('b'), date, start, end, label: `${label} free time`, kind: 'free', category: 'free' }); }, `${label} free time added.`);
}

/** Every task in one place: tap to change, finish or delete. */
/**
 * Tasks tab: everything added, in the order to work on it (by each task's next planned session; then what isn't
 * planned yet, by due date). On a wide screen: Assignments & projects | Tests, side by side, each in that order.
 */
function renderTasks(week) {
  const root = clear($('#view-tasks'));
  const t = today();
  put(root, h('div', { class: 'week-head' },
    h('h1', { id: 'tasks-title', tabindex: '-1' }, 'Tasks'),
    h('p', { class: 'lead' }, 'Everything you\'ve added, in the order to work on it.'),
    h('p', { class: 'hint' }, 'Tap a task to change its due date, time left or priority, finish it, or delete it.')));
  const next = new Map(); // taskId → first planned session { date, start }
  for (const plan of (week ? week.days : [])) {
    for (const it of plan.items) if (it.type === 'session' && !next.has(it.taskId)) next.set(it.taskId, { date: plan.date, start: it.start });
  }
  const dueKey = (x) => (x.deadline ? `${x.deadline.date} ${String(x.deadline.time ? D.parseHM(x.deadline.time) : 0).padStart(4, '0')}` : '9999');
  const order = (a, b) => {
    const na = next.get(a.id), nb = next.get(b.id);
    if (na && nb) return na.date.localeCompare(nb.date) || na.start - nb.start;
    if (na || nb) return na ? -1 : 1;
    return dueKey(a).localeCompare(dueKey(b)) || a.title.localeCompare(b.title);
  };
  const open = app.state.tasks.filter((x) => x.status === 'open').sort(order);
  const done = app.state.tasks.filter((x) => x.status === 'done').sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || ''))).slice(0, 30);
  const nextLabel = (x) => {
    const n = next.get(x.id);
    if (!n) return 'Not planned yet';
    return `Next: ${n.date === t ? 'today' : D.formatDate(n.date, t)} ${fmtT(n.start)}`;
  };
  const row = (x, keyPrefix) => h('li', {}, h('button', { type: 'button', class: 'task-row', 'data-key': `${keyPrefix}-${x.id}`, onclick: () => openEditTask(x.id) },
    h('span', { class: 'task-row-title' }, x.title, x.kind === 'test' ? h('span', { class: 'tag-test' }, 'test') : null),
    h('span', { class: 'task-row-meta' }, x.status === 'done' ? 'Finished · tap to reopen or delete' : `${dueLabel(x, t)} · ${remainingLabel(x)} · ${nextLabel(x)}`)));
  if (!open.length) put(root, h('p', { class: 'empty-hint' }, 'Nothing to do yet. Add something with + Add task.'));
  else {
    // One list in "do next" order (phones); two columns by type (wide screens)
    put(root, h('ol', { class: 'task-list tasks-all', 'aria-label': 'Open tasks, in order' }, ...open.map((x) => row(x, 'task'))));
    const tests = open.filter((x) => x.kind === 'test'), work = open.filter((x) => x.kind !== 'test');
    put(root, h('div', { class: 'tasks-split' },
      h('section', { 'aria-labelledby': 'tasks-work' }, h('h2', { id: 'tasks-work', class: 'small-heading' }, `Assignments & projects (${work.length})`),
        work.length ? h('ol', { class: 'task-list' }, ...work.map((x) => row(x, 'taskw'))) : h('p', { class: 'muted small' }, 'None.')),
      h('section', { 'aria-labelledby': 'tasks-tests' }, h('h2', { id: 'tasks-tests', class: 'small-heading' }, `Tests (${tests.length})`),
        tests.length ? h('ol', { class: 'task-list' }, ...tests.map((x) => row(x, 'taskt'))) : h('p', { class: 'muted small' }, 'None.'))));
  }
  if (done.length) put(root, h('details', { class: 'disclosure-plain' }, h('summary', {}, `Finished (${done.length})`), h('ul', { class: 'task-list', 'aria-label': 'Finished tasks' }, ...done.map((x) => row(x, 'taskd')))));
}

// ---------- Home Screen ----------
const isStandalone = () => (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const isTouchDevice = () => (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || /iPhone|iPad|iPod|Android/.test(navigator.userAgent || '');

/** Before (or soon after) a student adds work in a phone browser: their plan only lives on this phone. */
function homeScreenCard(hasTasks) {
  return h('section', { class: 'callout-card', 'aria-label': 'Add to your Home Screen' },
    h('p', { class: 'callout-title' }, hasTasks ? 'Keep your plan safe: add Blockwise to your Home Screen' : 'First, add Blockwise to your Home Screen'),
    h('p', { class: 'small' }, 'Your plan is saved only on this phone. Safari can erase a website\'s saved data if you don\'t open it for about a week. Opened from your Home Screen, it stays.'),
    h('div', { class: 'actions' },
      button('Show me how', openInstallHelp, 'btn-primary btn-small', { 'data-key': 'hs-how' }),
      button('Not now', () => commit((s) => { s.prefs.homeScreenDismissed = true; }, 'You can find this later in ⋯ → Add to your Home Screen.'), 'btn-ghost btn-small', { 'data-key': 'hs-later' })));
}

/** First open from the Home Screen on an iPhone starts empty: offer to bring tasks over from Safari. */
function bringOverCard() {
  return h('section', { class: 'callout-card', 'aria-label': 'Bring your plan over' },
    h('p', { class: 'callout-title' }, 'Used Blockwise in Safari before?'),
    h('p', { class: 'small' }, 'The Home Screen app keeps its own copy, so it starts empty. In Safari, open Blockwise → ⋯ → Add to your Home Screen → Copy my plan. Then paste it here.'),
    h('div', { class: 'actions' },
      button('Paste my plan', openBringOver, 'btn-primary btn-small', { 'data-key': 'bring-over' }),
      button('Start fresh', () => commit((s) => { s.prefs.bringOverDismissed = true; }), 'btn-ghost btn-small')));
}

function openBringOver() {
  const out = h('div', { 'aria-live': 'polite' });
  openSheet('Bring your plan over', [pasteRestore(out, { open: true }), out]);
}

function openInstallHelp() {
  const hasTasks = app.mode === 'real' && app.state.tasks.length > 0;
  const out = h('div', { 'aria-live': 'polite' });
  openSheet('Add to your Home Screen', [
    h('p', {}, 'Your plan is saved only on this phone, not online. Safari can erase a website\'s saved data if you don\'t open it for about a week. Opened from your Home Screen, it stays.'),
    h('h3', { class: 'small-heading' }, 'iPhone or iPad (Safari)'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Tap the Share button (the square with an arrow).'),
      h('li', {}, 'Scroll down, tap Add to Home Screen, then Add.'),
      h('li', {}, 'From now on, open Blockwise from the new icon.')),
    h('h3', { class: 'small-heading' }, 'Android (Chrome)'),
    h('p', {}, 'Tap ⋮, then Add to Home screen (or Install app). Your tasks come with it.'),
    hasTasks ? h('h3', { class: 'small-heading' }, 'Already added tasks here?') : null,
    hasTasks ? h('p', {}, 'On iPhone, the Home Screen app starts empty. Copy your plan first. Then open the new icon, tap Paste my plan, and paste.') : null,
    hasTasks ? button('Copy my plan', () => copyBackup(out), 'btn-secondary', { 'data-key': 'copy-plan' }) : null,
    out,
  ]);
}

function openDataSheet() {
  const demo = app.mode === 'demo';
  const sum = summarizeState(app.state);
  const fileId = uniqueId('file');
  const importOut = h('div', { 'aria-live': 'polite' });
  const fileIn = h('input', { id: fileId, type: 'file', accept: 'application/json,.json', class: 'visually-hidden', disabled: demo, onchange: (e) => handleImportFile(e.target.files && e.target.files[0], importOut, e.target) });
  openSheet('Backup and data', [
    h('p', {}, `Stored only in this browser on this device: ${sum.tasks} task${sum.tasks === 1 ? '' : 's'}. No account, no analytics, nothing sent anywhere.`),
    h('ul', { class: 'small' },
      h('li', {}, 'Clearing your browser data, or switching browser or device, means starting empty. The only way to recover is a backup you exported earlier.'),
      h('li', {}, 'Browser storage isn\'t encrypted. Anyone using this browser could open Blockwise and see your tasks.'),
      h('li', {}, 'Please don\'t put names, grades or student ID numbers in tasks.')),
    demo ? h('p', { class: 'callout' }, 'These apply to your own data. Exit the example first.') : null,
    h('div', { class: 'actions' },
      button('Export backup', exportData, 'btn-secondary', { disabled: demo, 'data-key': 'export' }),
      button('Copy backup text', () => copyBackup(importOut), 'btn-ghost', { disabled: demo }),
      h('label', { for: fileId, class: ['btn btn-secondary', demo && 'is-disabled'], role: 'button', tabindex: demo ? '-1' : '0', 'aria-disabled': demo ? 'true' : 'false',
        onkeydown: (e) => { if (!demo && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileIn.click(); } } }, 'Import backup…'),
      fileIn,
      button('Delete all data', deleteAll, 'btn-ghost btn-danger-text', { disabled: demo })),
    demo ? null : pasteRestore(importOut),
    importOut,
  ]);
}

// ===================== SCHEDULE =====================
// Set the usual week once (classes, study hours, repeating things); change a single day only when needed.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];




function usualStudy(wd) {
  const s = app.state.settings;
  const study = (s.week && s.week.study) || {};
  return String(wd) in study ? study[wd] : { start: s.studyStart, stop: s.studyStop };
}

function studyHoursSummary() {
  const groups = [];
  for (const wd of WEEK_ORDER) {
    const v = usualStudy(wd);
    const text = v ? fmtRange(D.parseHM(v.start), D.parseHM(v.stop)) : 'none';
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.days.push(wd); else groups.push({ text, days: [wd] });
  }
  return groups.map((g) => `${g.days.length > 2 ? `${WD[g.days[0]]}–${WD[g.days[g.days.length - 1]]}` : g.days.map((d) => WD[d]).join(', ')}: ${g.text}`);
}


const daysText = (days) => {
  const sorted = WEEK_ORDER.filter((d) => days.includes(d));
  if (sorted.length === 7) return 'Every day';
  if (sorted.join() === '1,2,3,4,5') return 'Mon–Fri';
  return sorted.map((d) => WD[d]).join(' ');
};




function ensureWeek(s) { s.settings.week = s.settings.week || { study: {}, items: [] }; s.settings.week.study = s.settings.week.study || {}; s.settings.week.items = s.settings.week.items || []; return s.settings.week; }

function openSchoolSetup() {
  const sc = app.state.settings.school;
  const free = new Set(sc ? sc.freeBlocks : []);
  const meetings = sc ? freeMeetingKeys(sc, MIDDLESEX) : new Set(); // older saves: every period of the free letters
  const keep = new Set(sc ? sc.keepFree || [] : []);
  const t = today();
  const current = sc ? (sc.anchor ? weekTypeFor(app.state, t) : 'NONE') : null;
  const letterBox = h('div', { class: 'block-grid', role: 'group', 'aria-label': 'Free blocks' });
  const gridBox = h('div', {});
  const keepBox = h('div', { class: 'block-grid', role: 'group', 'aria-label': 'Free blocks to keep free' });
  const keepNone = h('p', { class: 'hint' }, 'Pick your free blocks first.');
  // Redraw in place, then put focus back on the control that was tapped
  const renderChips = (focusKey) => {
    clear(letterBox); clear(gridBox); clear(keepBox);
    for (const L of MIDDLESEX.blocks) {
      letterBox.append(h('button', { type: 'button', class: 'block-chip', 'aria-pressed': String(free.has(L)), 'data-key': `school-free-${L}`, onclick: () => { toggleLetter(free, meetings, L); renderChips(`school-free-${L}`); } }, L));
    }
    gridBox.append(freeGrid(meetings, (key) => { meetings.has(key) ? meetings.delete(key) : meetings.add(key); renderChips(`school-grid-${key.replace(':', '-')}`); }, 'school-grid'));
    const somewhere = freeLettersIn(free, meetings);
    for (const L of [...keep]) if (!somewhere.has(L)) keep.delete(L);
    for (const L of [...somewhere].sort()) keepBox.append(h('button', { type: 'button', class: 'block-chip', 'aria-pressed': String(keep.has(L)), 'aria-label': `Keep ${L} block free`, 'data-key': `school-keep-${L}`, onclick: () => { keep.has(L) ? keep.delete(L) : keep.add(L); renderChips(`school-keep-${L}`); } }, L));
    keepNone.hidden = somewhere.size > 0;
    if (focusKey) document.querySelector(`#sheet [data-key="${focusKey}"]`)?.focus();
  };
  renderChips();
  const wtName = uniqueId('wt');
  const useStudyId = uniqueId('mxs');
  const err = h('p', { class: 'field-error', role: 'alert' });
  openSheet('Classes & free blocks', [
    h('form', { class: 'stack', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const picked = e.target.querySelector(`input[name="${wtName}"]:checked`);
      if (!picked) { err.textContent = 'Pick which week this is.'; return; }
      const useStudy = e.target.querySelector(`#${useStudyId}`).checked;
      commit((s) => {
        s.settings.school = { id: 'middlesex', freeBlocks: [...free].sort(), freeExt: [], freeMeetings: [...meetings].sort(), anchor: picked.value === 'NONE' ? null : { monday: mondayOf(t), type: picked.value } };
        const kf = [...keep].filter((L) => freeLettersIn(free, meetings).has(L)).sort();
        if (kf.length) s.settings.school.keepFree = kf;
        if (useStudy) ensureWeek(s).study = JSON.parse(JSON.stringify(MIDDLESEX.study));
        s.prefs.setupNudgeDismissed = true;
      }, 'Classes saved. Your free blocks now count as study time.');
      closeSheet();
    } },
    h('fieldset', { class: 'field' },
      h('legend', {}, '1. What are your free blocks?'),
      h('p', { class: 'hint' }, 'Tap each letter where you usually have no class.'),
      letterBox),
    h('fieldset', { class: 'field' },
      h('legend', {}, 'Check each day'),
      h('p', { class: 'hint' }, 'Some blocks aren\'t free every day. Tap a period to change just that day. Senate, Meet and Community time are here too.'),
      gridBox),
    h('fieldset', { class: 'field' },
      h('legend', {}, 'Keep any free block for yourself? (optional)'),
      h('p', { class: 'hint' }, 'Tap a free block you\'d rather not use for work — lunch, a club, time off. You can also keep a block free for one day from Week.'),
      keepNone, keepBox),
    h('fieldset', { class: 'field' },
      h('legend', {}, '2. Which week is this?'),
      h('p', { class: 'hint' }, MIDDLESEX.weekTypeHint),
      h('div', { class: 'segmented' }, ...[...MIDDLESEX.weekTypes.map((w) => [w, `${w} week`]), ['NONE', 'No Sat. classes']].map(([w, label]) => h('label', { class: 'seg' },
        h('input', { type: 'radio', name: wtName, value: w, checked: current === w }), h('span', {}, label))))),
    h('label', { class: 'check-row', for: useStudyId },
      h('input', { type: 'checkbox', id: useStudyId, checked: !hasCustomStudy() }),
      h('span', {}, 'Use dorm study hours (Sun–Thu 7:30–9:30 PM, Fri 7:30–9:00 PM, none Sat)')),
    err,
    h('div', { class: 'actions sticky-actions' }, h('button', { type: 'submit', class: 'btn btn-primary', 'data-key': 'save-school' }, 'Save'), button('Cancel', closeSheet, 'btn-ghost'))),
  ], { focus: '.block-chip' });
}

function hasCustomStudy() {
  const st = app.state.settings.week && app.state.settings.week.study;
  return !!st && Object.keys(st).length > 0 && JSON.stringify(st) !== JSON.stringify(MIDDLESEX.study);
}

function openStudyHoursEditor() {
  const rows = WEEK_ORDER.map((wd) => {
    const v = usualStudy(wd);
    const on = h('input', { type: 'checkbox', id: uniqueId('on'), checked: !!v });
    const start = h('input', { type: 'time', value: v ? v.start : '19:30', 'aria-label': `${WD[wd]} start` });
    const stop = h('input', { type: 'time', value: v ? v.stop : '21:30', 'aria-label': `${WD[wd]} stop` });
    const sync = () => { start.disabled = !on.checked; stop.disabled = !on.checked; };
    on.addEventListener('change', sync); sync();
    return { wd, on, start, stop };
  });
  const err = h('p', { class: 'field-error', role: 'alert' });
  openSheet('Study hours', [
    h('form', { class: 'stack', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const study = {};
      for (const r of rows) {
        if (!r.on.checked) { study[r.wd] = null; continue; }
        const a = D.parseHM(r.start.value), b = D.parseHM(r.stop.value);
        if (a == null || b == null || b <= a) { err.textContent = `${WD[r.wd]}: the end must be later than the start.`; r.stop.focus(); return; }
        study[r.wd] = { start: D.formatHM(a), stop: D.formatHM(b) };
      }
      commit((s) => { ensureWeek(s).study = study; }, 'Study hours saved.');
      closeSheet();
    } },
    button('Use Middlesex dorm study hours', () => {
      for (const r of rows) {
        const v = MIDDLESEX.study[r.wd];
        r.on.checked = !!v; if (v) { r.start.value = v.start; r.stop.value = v.stop; }
        r.on.dispatchEvent(new Event('change'));
      }
    }, 'btn-secondary btn-small'),
    h('div', { class: 'study-rows' }, ...rows.map((r) => h('div', { class: 'study-row' },
      h('label', { class: 'check-row', for: r.on.id }, r.on, h('span', {}, WD[r.wd])), r.start, h('span', { 'aria-hidden': 'true' }, '–'), r.stop))),
    err,
    h('div', { class: 'actions sticky-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'), button('Cancel', closeSheet, 'btn-ghost'))),
  ]);
}


/** One-time item on a single date. */
function openBlockEditor({ date, block = null, kind = 'busy', after = null }) {
  const editing = !!block;
  const k = block ? block.kind : kind;
  const ids = { label: uniqueId('bl'), start: uniqueId('bs'), end: uniqueId('be'), cat: uniqueId('bc') };
  const labelIn = h('input', { id: ids.label, type: 'text', maxlength: '80', value: block ? block.label : '', placeholder: k === 'free' ? 'e.g. Free period' : 'e.g. Game, Appointment' });
  const startIn = h('input', { id: ids.start, type: 'time', value: block ? block.start : '' });
  const endIn = h('input', { id: ids.end, type: 'time', value: block ? block.end : '' });
  const catSel = h('select', { id: ids.cat }, ...BLOCK_CATEGORIES.map((c) => h('option', { value: c, selected: (block ? block.category : 'activity') === c }, CATEGORY_LABEL[c])));
  const err = h('p', { class: 'field-error', role: 'alert' });
  const save = () => {
    const s = D.parseHM(startIn.value), e = D.parseHM(endIn.value);
    if (s == null || e == null) { err.textContent = 'Enter a start and end time.'; return; }
    if (e <= s) { err.textContent = 'The end time must be after the start time.'; return; }
    const base = { label: labelIn.value.trim().slice(0, 80), start: D.formatHM(s), end: D.formatHM(e), kind: k, category: k === 'free' ? 'free' : catSel.value };
    closeSheet();
    if (editing) Object.assign(app.state.blocks.find((x) => x.id === block.id), base);
    else app.state.blocks.push({ id: newId('b'), date, ...base });
    if (after) after(); else commit(() => {}, editing ? 'Saved.' : 'Added for this day.');
  };
  openSheet(`${editing ? 'Edit' : 'Add'} ${k === 'free' ? 'free time' : 'commitment'} · ${D.formatDate(date, today())}`, [
    h('form', { class: 'stack', novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
      h('div', { class: 'field' }, h('label', { for: ids.label }, 'Name ', h('span', { class: 'muted' }, '(optional)')), labelIn),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', { for: ids.start }, 'Starts'), startIn),
        h('div', { class: 'field' }, h('label', { for: ids.end }, 'Ends'), endIn)),
      k === 'busy' ? h('div', { class: 'field' }, h('label', { for: ids.cat }, 'Kind'), catSel) : null,
      h('p', { class: 'hint' }, 'Only for this date. For something every week, use “Repeating” on the Schedule tab.'),
      err,
      h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, editing ? 'Save' : 'Add'), button('Cancel', closeSheet, 'btn-ghost'))),
  ], { focus: `#${ids.label}` });
}

// ===================== SHEET & CONFIRM =====================
let sheetOnClose = null;
function openSheet(title, content, { focus, onClose, wide } = {}) {
  const dlg = $('#sheet');
  $('#sheet-title').textContent = title;
  const body = clear($('#sheet-body'));
  for (const c of [content].flat()) if (c) body.append(c);
  dlg.classList.toggle('sheet-wide', !!wide);
  sheetOnClose = onClose || null;
  if (!dlg.open) dlg.showModal();
  const target = focus ? body.querySelector(focus) : body.querySelector('input, textarea, select, button');
  if (target) target.focus();
}
function closeSheet() { const dlg = $('#sheet'); if (dlg.open) dlg.close(); }
function onSheetClosed() {
  if ($('#sheet').open) return; // a new sheet opened before this close event arrived — keep its content
  clear($('#sheet-body'));
  const cb = sheetOnClose; sheetOnClose = null;
  if (cb) cb();
}

function confirmDialog({ title, body, okLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#confirm');
    $('#confirm-title').textContent = title;
    const b = clear($('#confirm-body'));
    for (const c of [body].flat()) if (c) b.append(c);
    const ok = $('#confirm-ok');
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    $('#confirm-cancel').textContent = cancelLabel;
    dlg.returnValue = 'cancel';
    const done = () => { dlg.removeEventListener('close', done); resolve(dlg.returnValue === 'ok'); };
    dlg.addEventListener('close', done);
    dlg.showModal();
    $('#confirm-cancel').focus();
  });
}

// ===================== TASK FORM (review, bulk, edit) =====================
/**
 * Editable fields bound to a draft-like object:
 * { title, kind, deadlineDate, deadlineTime, remainingMin, estimateUncertain, priority, firstStep, durationSource, suggestedMin, flags, original }
 */
function taskFields(draft, { compact = false, showFlags = true, idPrefix = uniqueId('tf'), disabled = false } = {}) {
  const id = (k) => `${idPrefix}-${k}`;
  const wrap = h('div', { class: ['task-fields', compact && 'compact'] });
  const errs = {};
  const errorEl = (k) => (errs[k] = h('p', { class: 'field-error', id: id(`${k}-err`), role: 'alert' }));
  const flagsBox = h('div', { class: 'flags' });
  const renderFlags = () => {
    clear(flagsBox);
    if (!showFlags) return;
    const flags = (draft.flags || []).filter((f) => !f.resolved);
    if (!flags.length) return;
    const LABEL = { missing: 'Missing', ambiguous: 'Check', warning: 'Check', info: 'Note' };
    put(flagsBox, h('ul', { class: 'flag-list', 'aria-label': 'Things to check' }, ...flags.map((f) => h('li', { class: `flag flag-${f.level}` },
      h('span', { class: 'flag-level' }, LABEL[f.level] || 'Note'), ' ', f.message,
      ...(f.alternatives || []).map((a) => button(a.date ? `Use ${a.label}` : `Use ${a.label}`, () => {
        if (a.date) { draft.deadlineDate = a.date; dateIn.value = a.date; }
        if (a.time) { draft.deadlineTime = a.time; timeIn.value = a.time; }
        f.resolved = true; renderFlags(); updateMeaning();
      }, 'btn-link btn-small', { disabled }))))));
  };

  const titleIn = h('input', { id: id('title'), type: 'text', value: draft.title, maxlength: '120', required: true, disabled, 'aria-describedby': id('title-err'), oninput: (e) => { draft.title = e.target.value; } });
  const kindName = id('kind');
  const kindGroup = h('div', { class: 'segmented' }, ...['assignment', 'project', 'test'].map((k) => h('label', { class: 'seg' },
    h('input', { type: 'radio', name: kindName, value: k, checked: draft.kind === k, disabled, onchange: () => {
      const wasSuggested = draft.durationSource === 'suggested' && Number(draft.remainingMin) === draft.suggestedMin;
      draft.kind = k;
      if (wasSuggested) { draft.suggestedMin = SUGGESTED_MINUTES[k]; draft.remainingMin = draft.suggestedMin; minIn.value = String(draft.remainingMin); }
      updateLabels();
    } }), h('span', {}, KIND_LABELS[k]))));
  const dateLabel = h('label', { for: id('date') });
  const timeLabel = h('label', { for: id('time') });
  const dateIn = h('input', { id: id('date'), type: 'date', value: draft.deadlineDate || '', disabled, 'aria-describedby': `${id('meaning')} ${id('deadlineDate-err')}`, onchange: (e) => { draft.deadlineDate = e.target.value || null; resolveFlags('deadline'); fillBlocks(); syncTime(); updateMeaning(); } });
  const timeIn = h('input', { id: id('time'), type: 'time', value: draft.deadlineBlock ? '' : (draft.deadlineTime || ''), disabled: disabled || !!draft.deadlineBlock, 'aria-describedby': `${id('meaning')} ${id('deadlineTime-err')}`, onchange: (e) => { draft.deadlineTime = e.target.value || null; if (draft.deadlineTime) { draft.deadlineBlock = null; fillBlocks(); } resolveFlags('deadlineTime'); updateMeaning(); } });
  const blockLabel = h('label', { for: id('block') });
  const blockSel = h('select', { id: id('block'), disabled, onchange: (e) => {
    draft.deadlineBlock = e.target.value || null;
    draft.deadlineTime = null; // a block sets its own time; removing the block doesn't leave its start time behind
    syncTime();
    updateMeaning();
  } });
  // With a block chosen, the time box shows when that block starts (greyed out), never a stale or placeholder time.
  function syncTime() {
    const test = draft.kind === 'test';
    if (draft.deadlineBlock) {
      timeIn.value = (draft.deadlineDate && blockStartOn(app.state, draft.deadlineDate, draft.deadlineBlock)) || '';
      timeIn.disabled = true;
      timeLabel.textContent = `${test ? 'Test' : 'Due'} time (from ${draft.deadlineBlock} block)`;
    } else {
      timeIn.value = draft.deadlineTime || '';
      timeIn.disabled = !!disabled;
      timeLabel.textContent = test ? 'Test time (optional)' : 'Due time (optional)';
    }
  }
  const showBlocks = !!app.state.settings.school || !app.state.prefs.setupNudgeDismissed || !!draft.deadlineBlock;
  function fillBlocks() {
    clear(blockSel);
    blockSel.append(h('option', { value: '' }, 'No block'));
    const classes = draft.deadlineDate ? classBlocksOn(app.state, draft.deadlineDate) : [];
    for (const c of classes) blockSel.append(h('option', { value: c.letter }, `${c.letter} block (${fmtT(D.parseHM(c.start))})`));
    if (draft.deadlineBlock && !classes.some((c) => c.letter === draft.deadlineBlock)) blockSel.append(h('option', { value: draft.deadlineBlock }, `${draft.deadlineBlock} block (doesn't meet that day)`));
    blockSel.value = draft.deadlineBlock || '';
  }
  fillBlocks();
  const meaning = h('p', { class: 'hint', id: id('meaning') });
  const minLabel = h('label', { for: id('min') });
  const minIn = h('input', { id: id('min'), type: 'number', inputmode: 'numeric', min: '1', max: '1440', step: '1', value: draft.remainingMin ?? '', disabled, 'aria-describedby': `${id('min-hint')} ${id('remainingMin-err')}`, oninput: (e) => { draft.remainingMin = e.target.value === '' ? '' : Number(e.target.value); updateSuggestedTag(); } });
  const suggestedTag = h('span', { class: 'tag tag-suggested' }, 'Suggested estimate');
  const minHint = h('p', { class: 'hint', id: id('min-hint') });
  const uncertainIn = h('input', { type: 'checkbox', id: id('unc'), checked: !!draft.estimateUncertain, disabled, onchange: (e) => { draft.estimateUncertain = e.target.checked; updateSuggestedTag(); } });
  const prName = id('pr');
  const prGroup = h('div', { class: 'segmented' }, ...['high', 'normal', 'low'].map((p) => h('label', { class: 'seg' },
    h('input', { type: 'radio', name: prName, value: p, checked: draft.priority === p, disabled, onchange: () => { draft.priority = p; } }), h('span', {}, PRIORITY_LABELS[p]))));
  const stepIn = h('input', { id: id('step'), type: 'text', maxlength: '200', value: draft.firstStep || '', disabled, oninput: (e) => { draft.firstStep = e.target.value; } });
  const stepHint = h('p', { class: 'hint' });

  function resolveFlags(field) { for (const f of draft.flags || []) if (f.field === field && f.level !== 'info') f.resolved = true; renderFlags(); }
  function updateLabels() {
    const test = draft.kind === 'test';
    dateLabel.textContent = test ? 'Test date' : 'Due date';
    syncTime();
    minLabel.textContent = test ? 'Study time still needed (estimate, minutes)' : 'Time still needed (estimate, minutes)';
    blockLabel.textContent = test ? 'Which block is the test in? (optional)' : 'Due in a class block? (optional)';
    stepIn.placeholder = neutralFirstStep(draft.kind);
    stepHint.textContent = `Optional. If empty, big tasks show a neutral step: “${neutralFirstStep(draft.kind)}”`;
    updateMeaning();
  }
  function updateMeaning() {
    const dl = draft.deadlineDate ? (draft.deadlineBlock
      ? { date: draft.deadlineDate, block: draft.deadlineBlock, time: blockStartOn(app.state, draft.deadlineDate, draft.deadlineBlock) }
      : { date: draft.deadlineDate, time: draft.deadlineTime || null }) : null;
    let text = deadlineMeaning(dl, draft.kind);
    if (dl) text = `${D.isValidISODate(dl.date) ? D.formatDate(dl.date, today()) : ''}. ${text}`;
    if (draft.kind === 'test') text += ' The minutes below are study time, not how long the test lasts.';
    meaning.textContent = text;
  }
  function updateSuggestedTag() {
    const isSuggested = draft.durationSource === 'suggested' && Number(draft.remainingMin) === draft.suggestedMin;
    suggestedTag.hidden = !isSuggested;
    const buf = draft.estimateUncertain && Number(draft.remainingMin) > 0 ? bufferMinutes({ estimateUncertain: true, remainingMin: Number(draft.remainingMin) }) : 0;
    minHint.textContent = (isSuggested ? 'This number is a starting guess, not from what you typed. ' : '') + 'It\'s an estimate — after each session you\'ll say how much is really left.';
  }

  put(wrap, 
    flagsBox,
    draft.original && showFlags ? h('p', { class: 'original' }, h('span', { class: 'muted' }, 'You typed: '), `“${draft.original}”`) : null,
    h('div', { class: 'field' }, h('label', { for: id('title') }, 'Title'), titleIn, errorEl('title')),
    h('fieldset', { class: 'field' }, h('legend', {}, 'Type'), kindGroup),
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' }, dateLabel, dateIn, errorEl('deadlineDate')),
      h('div', { class: 'field' }, timeLabel, timeIn, errorEl('deadlineTime'))),
    showBlocks ? h('div', { class: 'field' }, blockLabel, blockSel) : null,
    h('div', { class: 'deadline-meta' }, meaning,
      button(draft.kind === 'test' ? 'No test date' : 'No deadline', () => { draft.deadlineDate = null; draft.deadlineTime = null; draft.deadlineBlock = null; dateIn.value = ''; fillBlocks(); syncTime(); resolveFlags('deadline'); resolveFlags('deadlineTime'); updateMeaning(); }, 'btn-link btn-small', { disabled })),
    h('div', { class: 'field' }, h('div', { class: 'label-row' }, minLabel, suggestedTag), minIn,
      compact ? null : h('div', { class: 'quick-chips', 'aria-label': 'Quick estimates' }, ...[15, 30, 45, 60, 90, 120].map((m) => button(fmtDur(m), () => { draft.remainingMin = m; minIn.value = String(m); updateSuggestedTag(); }, 'chip-btn', { disabled, 'aria-label': `Set estimate to ${fmtDur(m)}` }))),
      minHint, errorEl('remainingMin')),
    h('fieldset', { class: 'field' }, h('legend', {}, 'Priority'), prGroup),
    h('div', { class: 'field' }, h('label', { for: id('step') }, 'First step ', h('span', { class: 'muted' }, '(optional)')), stepIn, stepHint, errorEl('firstStep')),
  );
  renderFlags(); updateLabels(); updateSuggestedTag();

  /** Show validation errors; returns true if valid. */
  wrap.validate = () => {
    const v = validateDraft(draft);
    for (const [k, el] of Object.entries(errs)) el.textContent = v.errors[k] || '';
    const map = { title: titleIn, deadlineDate: dateIn, deadlineTime: timeIn, remainingMin: minIn, firstStep: stepIn };
    for (const [k, el] of Object.entries(map)) { if (v.errors[k]) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
    if (!v.ok) { const first = Object.keys(map).find((k) => v.errors[k]); if (first) map[first].focus(); }
    return v.ok;
  };
  return wrap;
}

// ===================== CAPTURE =====================
function openCapture() {
  openSheet('Paste a list', bulkCapture(today()), { wide: true });
}


function bulkCapture(t) {
  const id = uniqueId('bulk');
  const ta = h('textarea', { id, rows: '6', maxlength: '4000', placeholder: 'Bio test tomorrow\nHistory project due Friday, about two hours\nMath worksheet, 20 minutes' });
  const out = h('div', { class: 'bulk-out', 'aria-live': 'polite' });
  const review = () => {
    const r = parseBulk(ta.value, today());
    clear(out);
    if (!r.drafts.length) { put(out, h('p', { class: 'field-error', role: 'alert' }, 'Paste at least one line.')); return; }
    const cards = [];
    const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' });
    const count = () => cards.filter((c) => c.draft.include).length;
    const updateCount = () => { const n = count(); saveBtn.textContent = n ? `Save ${n} task${n === 1 ? '' : 's'}` : 'Nothing selected'; saveBtn.disabled = n === 0; };
    const list = h('ol', { class: 'bulk-list' });
    for (const draft of r.drafts) {
      const card = h('li', { class: 'bulk-card' });
      const rebuild = () => {
        clear(card);
        card.classList.toggle('is-excluded', !draft.include);
        const incId = uniqueId('inc');
        const fields = taskFields(draft, { compact: true, disabled: !draft.include });
        put(card, 
          h('div', { class: 'bulk-head' },
            h('label', { class: 'check-row', for: incId },
              h('input', { type: 'checkbox', id: incId, checked: draft.include, onchange: (e) => { draft.include = e.target.checked; rebuild(); updateCount(); } }),
              h('span', {}, `Include line ${draft.line}`)),
            h('span', { class: 'muted small' }, draft.include ? '' : 'Won\'t be saved')),
          fields);
        entry.fields = fields;
      };
      const entry = { draft, fields: null };
      cards.push(entry);
      rebuild();
      put(list, card);
    }
    put(out, 
      r.truncated ? h('p', { class: 'callout callout-warn' }, `Only the first ${r.max} of ${r.total} lines were read. Add the rest in another batch.`) : null,
      h('p', { class: 'muted small' }, 'Check each one — pasted lists can be out of date. Untick anything you don\'t want to save.'),
      h('form', { novalidate: true, class: 'stack', onsubmit: (e) => {
        e.preventDefault();
        let ok = true;
        for (const c of cards) if (c.draft.include && !c.fields.validate()) { ok = false; break; }
        if (!ok) { toast('Fix the highlighted fields, or untick that line.'); return; }
        const tasks = cards.filter((c) => c.draft.include).map((c) => draftToTask(c.draft, now().toISOString()));
        commit((s) => { s.tasks.push(...tasks); }, `Saved ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`);
        closeSheet();
      } }, list, h('div', { class: 'actions sticky-actions' }, saveBtn)));
    updateCount();
    out.querySelector('.bulk-card input, .bulk-card textarea')?.focus();
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'field' },
      h('label', { for: id }, 'One task per line (up to 20)'),
      ta,
      h('p', { class: 'hint' }, 'Short lists only — Blockwise doesn\'t read whole syllabuses. You\'ll review every line before anything is saved.')),
    h('div', { class: 'actions' }, button('Review list', review, 'btn-primary', { 'data-key': 'bulk-review' })),
    out);
}

// ===================== EDIT TASK =====================
function openEditTask(id, focusField) {
  markReviewed();
  const task = taskById(id);
  if (!task) return;
  const draft = {
    title: task.title, kind: task.kind, deadlineDate: task.deadline ? task.deadline.date : null, deadlineTime: task.deadline ? task.deadline.time : null,
    deadlineBlock: task.deadline && task.deadline.block ? task.deadline.block : null,
    remainingMin: task.remainingMin, estimateUncertain: task.estimateUncertain, priority: task.priority, firstStep: task.firstStep,
    durationSource: task.estimateSource === 'suggested' ? 'suggested' : 'text', suggestedMin: task.estimateSource === 'suggested' ? task.remainingMin : null,
    flags: [], original: null,
  };
  const reopening = focusField === 'reopen' || task.status === 'done';
  if (reopening && !(draft.remainingMin > 0)) draft.remainingMin = '';
  const fields = taskFields(draft, { showFlags: false });
  const t = today();
  const deadlinePassed = (dl) => !!dl && (dl.date < t || (dl.date === t && (dl.time ? D.parseHM(dl.time) : 0) <= nowMin()));
  const isPastDeadline = deadlinePassed(task.deadline);
  const lateId = uniqueId('late');
  const lateBox = isPastDeadline && task.status === 'open' ? h('label', { class: 'check-row', for: lateId },
    h('input', { type: 'checkbox', id: lateId, checked: task.lateWork, onchange: (e) => { draft.lateWork = e.target.checked; } }),
    h('span', {}, 'Plan this as late work (it\'s past its deadline)')) : null;
  const history = (task.progress || []).length ? h('details', { class: 'disclosure-plain' },
    h('summary', {}, `Progress history (${task.progress.length})`),
    h('ul', { class: 'list small' }, ...task.progress.map((p) => h('li', {}, `${D.formatDate(p.date, t)}: worked ${fmtDur(p.workedMin)}, estimate ${fmtDur(p.remainingBefore)} → ${fmtDur(p.remainingAfter)}`)))) : null;
  const form = h('form', { novalidate: true, class: 'stack', onsubmit: (e) => {
    e.preventDefault();
    if (!fields.validate()) return;
    commit(() => {
      const x = taskById(id);
      const mins = Number(draft.remainingMin);
      x.title = draft.title.trim(); x.kind = draft.kind;
      x.deadline = draft.deadlineDate ? makeDeadline(draft.deadlineDate, draft.deadlineTime, draft.deadlineBlock) : null;
      if (mins !== x.remainingMin) x.estimateSource = 'user';
      x.remainingMin = mins; x.estimateUncertain = !!draft.estimateUncertain;
      x.priority = draft.priority; x.firstStep = (draft.firstStep || '').trim();
      if (draft.lateWork !== undefined) x.lateWork = draft.lateWork;
      if (!deadlinePassed(x.deadline)) x.lateWork = false;
      if (reopening) { x.status = 'open'; delete x.completedAt; }
      x.updatedAt = now().toISOString();
    }, reopening ? 'Reopened.' : 'Changes saved.');
    closeSheet();
  } },
  task.sourceText ? h('p', { class: 'original' }, h('span', { class: 'muted' }, 'Originally typed: '), `“${task.sourceText}”`) : null,
  reopening ? h('p', { class: 'callout' }, 'Reopening: set how much time is still needed, then save.') : null,
  fields, lateBox, history,
  h('div', { class: 'actions sticky-actions' },
    h('button', { type: 'submit', class: 'btn btn-primary' }, reopening ? 'Reopen task' : 'Save changes'),
    !reopening ? button('Mark done', () => { closeSheet(); completeTask(id); }, 'btn-secondary') : null,
    button('Delete', () => deleteTask(id), 'btn-ghost btn-danger-text')));
  const focusSel = focusField === 'deadline' ? 'input[type="date"]' : focusField === 'reopen' ? 'input[type="number"]' : 'input';
  openSheet(reopening ? 'Reopen task' : 'Edit task', form, { focus: focusSel });
}

async function deleteTask(id) {
  const task = taskById(id);
  if (!task) return;
  const ok = await confirmDialog({ title: 'Delete this task?', body: [h('p', {}, `“${task.title}” and its progress history will be removed from this device.`)], okLabel: 'Delete', danger: true });
  if (!ok) return;
  closeSheet();
  commit((s) => {
    s.tasks = s.tasks.filter((x) => x.id !== id);
    for (const d of Object.values(s.days)) if (d.skipped) d.skipped = d.skipped.filter((x) => x !== id);
  }, 'Task deleted.');
}

// ===================== MORE: settings, data, help =====================

function rulesExplainer() {
  return h('div', { class: 'rules small' },
    h('ol', {},
      h('li', {}, h('strong', {}, 'Free time. '), 'Your free class blocks, plus study hours (Sun–Thu 7:30–9:30, Fri 7:30–9:00 at Middlesex), minus anything you mark busy or keep free. Nothing is planned after your study hours end.'),
      h('li', {}, h('strong', {}, 'Due dates. '), 'Without a time or block, something counts as due when the school day starts, so “due tomorrow” means doing it today. In a block (“Friday, D block”), it\'s due when that class starts, so free blocks earlier that day count.'),
      h('li', {}, h('strong', {}, 'Tests. '), 'The minutes on a test are study time, not how long the test lasts.'),
      h('li', {}, h('strong', {}, 'What comes first. '), 'Work whose last chance is today. If two things are both due tomorrow, they take turns so neither gets squeezed out. Next: big tasks that need 30+ minutes a day or haven\'t been started. Short tasks don\'t jump the line just for being short.'),
      h('li', {}, h('strong', {}, 'Sessions. '), '25 minutes with short breaks, never shorter than 15 minutes unless that finishes the task.'),
      h('li', {}, h('strong', {}, 'Honesty. '), 'If something won\'t fit before it\'s due, Blockwise says so. Overdue work isn\'t planned unless you say you\'re still doing it. It plans one day at a time, so it can\'t promise later deadlines will fit.'),
      h('li', {}, h('strong', {}, 'Changes. '), 'The plan updates whenever you add, finish or skip something — or when a planned session passes.')));
}

const FEEDBACK_QUESTIONS = [
  'What did you add to Blockwise this week, and how did adding it compare with how you usually keep track?',
  'Did Blockwise show you a deadline you might otherwise have missed or noticed late? (No need to name the class.)',
  'Did you start a bigger task or test prep earlier than usual? What helped or got in the way?',
  'Was the suggested next step useful? Was any suggestion wrong, confusing or stressful?',
  'What made you open Blockwise — or not — on a given day?',
  'Anything else you\'d change?',
];
/** Counts only (no task text), from data already on this device. Shown to the student before they copy it. */
export function activitySummary(state, todayIso) {
  const since = D.addDays(todayIso, -6);
  const inWeek = (d) => d && d >= since && d <= todayIso;
  const localDate = (iso) => { const x = new Date(iso); return Number.isNaN(x.getTime()) ? null : D.toISODate(x); };
  const tasks = state.tasks || [];
  const progressDays = new Set(tasks.flatMap((t) => (t.progress || []).map((p) => p.date)).filter(inWeek));
  return [
    `Activity on this device, ${D.formatDate(since, todayIso)} – ${D.formatDate(todayIso, todayIso)} (counts only):`,
    `- Tasks added: ${tasks.filter((t) => inWeek(localDate(t.createdAt))).length}`,
    `- Days progress was logged: ${progressDays.size}`,
    `- Tasks completed: ${tasks.filter((t) => t.status === 'done' && inWeek(localDate(t.completedAt))).length}`,
    `- Open tasks now: ${tasks.filter((t) => t.status === 'open').length}`,
  ].join('\n');
}

function feedbackForm() {
  const areas = FEEDBACK_QUESTIONS.map((q) => { const id = uniqueId('fb'); return { q, id, ta: h('textarea', { id, rows: '2', maxlength: '1000' }) }; });
  const status = h('p', { class: 'hint', role: 'status' });
  const sumId = uniqueId('sum');
  const summaryText = activitySummary(app.state, today());
  const summaryBox = h('pre', { class: 'summary-preview', hidden: true }, summaryText);
  const includeSummary = h('input', { type: 'checkbox', id: sumId, onchange: (e) => { summaryBox.hidden = !e.target.checked; } });
  return h('div', { class: 'stack' },
    h('p', { class: 'small' }, 'Nothing is sent from Blockwise. Copy your answers and paste them wherever the pilot organizer asks (for example a form or a message). Please leave out names and grades.'),
    ...areas.map((a) => h('div', { class: 'field' }, h('label', { for: a.id }, a.q), a.ta)),
    h('label', { class: 'check-row', for: sumId }, includeSummary, h('span', {}, 'Also include a short activity summary (counts only, no task names — shown below before you copy)')),
    summaryBox,
    button('Copy answers', async () => {
      let text = areas.map((a, i) => `${i + 1}. ${a.q}\n${a.ta.value.trim() || '(no answer)'}`).join('\n\n');
      if (includeSummary.checked) text += `\n\n${summaryText}`;
      try { await navigator.clipboard.writeText(text); status.textContent = 'Copied. Paste it wherever the organizer asked — nothing was sent.'; }
      catch {
        const ta = h('textarea', { rows: '6', readonly: true, 'aria-label': 'Your answers', class: 'copy-fallback' }); ta.value = text;
        status.textContent = 'Copying isn\'t allowed here. Select the text below and copy it yourself.';
        status.after(ta); ta.select();
      }
    }, 'btn-secondary'),
    status);
}

function downloadText(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData() {
  const payload = exportPayload(app.state, now());
  downloadText(JSON.stringify(payload, null, 2), `blockwise-backup-${today()}.json`, 'application/json');
  toast('Backup file created — check your downloads. If nothing downloaded, use “Copy backup text”.');
}

async function handleImportFile(file, out, input) {
  clear(out);
  if (!file) return;
  let text;
  try { text = await file.text(); } catch { text = null; }
  input.value = '';
  await handleImportText(text, out);
}

function pasteRestore(out, { open = false } = {}) {
  const id = uniqueId('paste');
  const ta = h('textarea', { id, rows: '3', placeholder: '{"app":"Blockwise", …}' });
  return h('details', { class: 'disclosure-plain', open },
    h('summary', {}, 'Restore from pasted backup text'),
    h('div', { class: 'field' }, h('label', { for: id }, 'Paste the text from “Copy backup text”'), ta),
    button('Check and restore', () => handleImportText(ta.value, out), 'btn-secondary'));
}

async function copyBackup(out) {
  clear(out);
  const text = JSON.stringify(exportPayload(app.state, now()));
  try {
    await navigator.clipboard.writeText(text);
    put(out, h('p', { class: 'hint', role: 'status' }, 'Backup text copied. Paste it somewhere private (for example a note only you can see). Anyone with it can read your tasks.'));
  } catch {
    const ta = h('textarea', { rows: '4', readonly: true, 'aria-label': 'Backup text', class: 'copy-fallback' });
    ta.value = text;
    put(out, h('p', { class: 'hint', role: 'status' }, 'Copying isn\'t allowed here. Select the text below and copy it yourself.'), ta);
    ta.select();
  }
}

async function handleImportText(text, out) {
  clear(out);
  const r = parseImport(text);
  if (!r.ok) {
    put(out, h('div', { class: 'callout callout-danger', role: 'alert' },
      h('p', {}, h('strong', {}, 'Couldn\'t import this file. '), 'Nothing was changed.'),
      h('ul', { class: 'small' }, ...r.errors.slice(0, 5).map((e) => h('li', {}, e)))));
    return;
  }
  const cur = summarizeState(app.state);
  const sm = r.summary;
  const when = sm.exportedAt ? new Date(sm.exportedAt) : null;
  const body = [
    h('p', {}, `Backup${when && !Number.isNaN(when.getTime()) ? ` from ${D.formatDate(D.toISODate(when), today())}` : ''}: ${sm.tasks} task${sm.tasks === 1 ? '' : 's'} (${sm.openTasks} open, ${sm.doneTasks} done), ${sm.blocks} schedule item${sm.blocks === 1 ? '' : 's'}, ${sm.plans} saved plan${sm.plans === 1 ? '' : 's'}.`),
    ...(r.notes || []).map((n) => h('p', { class: 'small' }, n)),
  ];
  const hasData = !isStateEmpty(app.state);
  if (hasData) body.push(h('p', { class: 'callout callout-warn' }, `This replaces everything in Blockwise on this device right now (${cur.tasks} task${cur.tasks === 1 ? '' : 's'}, ${cur.blocks} schedule item${cur.blocks === 1 ? '' : 's'}). It can't be undone — export a backup first if you might need it.`));
  const ok = await confirmDialog({ title: 'Restore this backup?', body, okLabel: hasData ? 'Replace my data' : 'Restore', danger: hasData });
  if (!ok) { put(out, h('p', { class: 'hint', role: 'status' }, 'Import cancelled. Nothing was changed.')); return; }
  app.state = r.state;
  app.banners.unreadable = null;
  app.blockSaves = false;
  persist();
  closeSheet();
  app.planDate = today();
  render();
  toast('Backup restored.');
}

async function deleteAll() {
  const ok = await confirmDialog({
    title: 'Delete all Blockwise data?',
    body: [h('p', {}, 'This removes every task, schedule item, plan and setting from this browser. It can\'t be undone unless you have an exported backup.')],
    okLabel: 'Delete everything', danger: true,
  });
  if (!ok) return;
  wipeEverything('All Blockwise data on this device was deleted.');
}

/** Remove every Blockwise record on this device (real data, example, unreadable copies) and go back to first use. */
function wipeEverything(message) {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k && (k === STORAGE_KEY || k.startsWith(UNREADABLE_PREFIX) || k === DEMO_KEY || k === MODE_KEY || k === DEMO_CLOCK_KEY || k === USAGE_KEY)) window.localStorage.removeItem(k);
    }
  } catch { /* storage unavailable: nothing persisted anyway */ }
  app.state = emptyState();
  app.mode = 'real';
  app.addDraft = null; app.addOpen = false; app.setupDraft = null;
  app.banners.unreadable = null; app.banners.saveError = null; app.blockSaves = false;
  closeSheet();
  app.planDate = today();
  go('today');
  toast(message);
}

/** ⋯ → Start over…: say exactly what goes, offer a backup first, then reset to first use. */
async function startOver() {
  const st = app.state;
  const open = st.tasks.filter((x) => x.status === 'open').length;
  const done = st.tasks.length - open;
  const out = h('div', { 'aria-live': 'polite' });
  const items = [
    `${st.tasks.length} task${st.tasks.length === 1 ? '' : 's'}${st.tasks.length ? ` (${open} open, ${done} finished)` : ''}`,
    st.settings.school ? 'your classes, free blocks and week type' : null,
    'your study hours and any changes to single days',
    'the example day, if you opened it',
  ].filter(Boolean);
  closeSheet();
  const ok = await confirmDialog({
    title: 'Start over?',
    body: [
      h('p', {}, 'This deletes everything Blockwise has saved on this phone:'),
      h('ul', { class: 'steps' }, ...items.map((x) => h('li', {}, x))),
      h('p', {}, 'Then Blockwise opens like new. This can\'t be undone. Calendar reminders you already added stay in your calendar.'),
      st.tasks.length ? button('Copy a backup first', () => copyBackup(out), 'btn-secondary btn-small', { 'data-key': 'reset-copy' }) : null,
      out,
    ],
    okLabel: 'Delete and start over', cancelLabel: 'Cancel', danger: true,
  });
  if (!ok) { toast('Nothing was deleted.'); return; }
  wipeEverything('Blockwise was reset. Start with step 1: your free blocks.');
}

// ---------- demo ----------
function demoOffsetFor(realNow) {
  const target = new Date(realNow);
  target.setHours(Math.floor(DEMO_CLOCK_MIN / 60), DEMO_CLOCK_MIN % 60, 0, 0);
  const off = target.getTime() - realNow.getTime();
  return Math.abs(off) < 60_000 ? 0 : off;
}
async function enterDemo() {
  const unsaved = !store.available && !isStateEmpty(app.state);
  const ok = await confirmDialog({
    title: 'Open the example day?',
    body: [
      h('p', {}, 'It\'s fictional and kept separate from your own tasks. Nothing of yours is changed or mixed in, and you can exit any time.'),
      unsaved ? h('p', { class: 'callout callout-warn' }, 'This browser isn\'t saving data, so your current tasks would be lost. Export a backup first.') : null,
    ],
    okLabel: 'Open example',
  });
  if (!ok) return;
  const real = new Date();
  app.mode = 'demo';
  app.clockOffset = demoOffsetFor(real);
  app.state = buildDemoState(today(), now().toISOString());
  store.set(MODE_KEY, 'demo');
  store.set(DEMO_CLOCK_KEY, String(app.clockOffset));
  persist();
  app.planDate = today();
  render();
  toast('Example day opened. This is the plan Blockwise made for it.');
}
function exitDemo() {
  store.remove(DEMO_KEY); store.remove(MODE_KEY); store.remove(DEMO_CLOCK_KEY);
  app.mode = 'real';
  app.clockOffset = 0;
  loadReal();
  app.planDate = today();
  render();
  toast('Back to your own data.');
}
function toggleDemoClock() {
  app.clockOffset = app.clockOffset ? 0 : demoOffsetFor(new Date());
  store.set(DEMO_CLOCK_KEY, String(app.clockOffset));
  app.planDate = today();
  render();
}

// ---------- startup ----------
function init() {
  if (store.get(MODE_KEY) === 'demo') {
    app.mode = 'demo';
    if (!loadDemo()) { app.mode = 'real'; store.remove(MODE_KEY); loadReal(); }
  } else loadReal();
  app.lastToday = today();
  app.planDate = today();
  $('#more-btn').addEventListener('click', openMenu);
  $('#schedule-btn').addEventListener('click', openSchedule);
  $('#add-btn').addEventListener('click', openAdd);
  for (const b of document.querySelectorAll('.nav-btn')) b.addEventListener('click', () => go(b.dataset.view));
  $('#sheet .sheet-close').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('close', onSheetClosed);
  window.addEventListener('pagehide', stopVoice);
  $('#sheet').addEventListener('click', (e) => { if (e.target === $('#sheet')) closeSheet(); });
  const tick = () => {
    const t = today();
    if (t !== app.lastToday) {
      if (app.planDate === app.lastToday || app.planDate < t) app.planDate = t;
      app.lastToday = t;
      render();
      return;
    }
    if (!$('#sheet').open && !$('#confirm').open && !app.voiceState) render();
    usageOpened(); // counts a new day if the app stays open past midnight
  };
  setInterval(tick, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); else usage.flush({ keepalive: true }); });
  window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY && app.mode === 'real' && !$('#sheet').open) { loadReal(); render(); } });
  render();
  usageOpened();
  document.documentElement.dataset.ready = 'true';
}

init();
