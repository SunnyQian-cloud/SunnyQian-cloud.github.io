// Calendar reminders without a server: a .ics file of repeating events for the student's free class blocks
// and study hours, each with an alert 5 minutes before. The events never change week to week, so the student
// imports them once; Blockwise itself says what to work on when they open it.
import { addDays, weekdayOf, parseHM, formatHM, pad } from './dates.js';
import { SCHOOLS } from './schools/middlesex.js';
import { daySettings, weekTypeFor } from './plan.js';

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const icsDate = (iso, hm) => `${iso.replace(/-/g, '')}T${hm.replace(':', '')}00`;
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Merge touching class periods (e.g. C 2:10–2:55 + Cx 2:55–3:20) into one free stretch. */
function mergePeriods(periods) {
  const out = [];
  for (const p of periods) {
    const last = out[out.length - 1];
    if (last && parseHM(p.start) <= parseHM(last.end)) { last.end = p.end; last.codes.push(p.code); }
    else out.push({ start: p.start, end: p.end, codes: [p.code] });
  }
  return out;
}

/** First date on/after `from` that falls on weekday `wd` (and, if given, in week type `type`). */
function firstDate(state, from, wd, type) {
  for (let i = 0; i < 21; i++) {
    const d = addDays(from, i);
    if (weekdayOf(d) === wd && (!type || weekTypeFor(state, d) === type)) return d;
  }
  return null;
}

/**
 * The repeating reminder events for a student, as plain objects (also used to show what will be added).
 * Each: { uid, title, weekday, start, end, firstDate, everyOtherWeek }
 */
export function reminderEvents(state, today) {
  const events = [];
  const sc = state.settings && state.settings.school;
  const school = sc && SCHOOLS[sc.id];
  if (school && sc.anchor) {
    const free = new Set([...sc.freeBlocks, ...sc.freeBlocks.map((b) => `${b}x`), ...(sc.freeExt || [])]);
    for (const type of school.weekTypes) {
      for (let wd = 0; wd < 7; wd++) {
        const keep = new Set(sc.keepFree || []);
        const periods = (school.grid[type][wd] || []).filter((p) => free.has(p.code) && !keep.has(p.code[0]));
        // Days identical in both week types get one weekly event (made from the first week type only).
        const sameBoth = JSON.stringify(school.grid[school.weekTypes[0]][wd]) === JSON.stringify(school.grid[school.weekTypes[1]][wd]);
        if (sameBoth && type !== school.weekTypes[0]) continue;
        for (const m of mergePeriods(periods)) {
          const label = m.codes.filter((c) => !c.endsWith('x')).join(' + ') || m.codes.join(' + ');
          const start = sameBoth ? firstDate(state, today, wd) : firstDate(state, today, wd, type);
          if (!start) continue;
          events.push({
            uid: `blockwise-${sc.id}-${type}-${wd}-${m.start.replace(':', '')}@blockwise`,
            title: `${label} block free – open Blockwise`, weekday: wd, start: m.start, end: m.end,
            firstDate: start, everyOtherWeek: !sameBoth,
          });
        }
      }
    }
  }
  // Study hours: one weekly event per weekday that has them (usual week, ignoring one-day changes).
  const usualOnly = { ...state, days: {} };
  for (let wd = 0; wd < 7; wd++) {
    const d = firstDate(state, today, wd);
    const ds = daySettings(usualOnly, d);
    if (!ds.studyStart || !ds.studyStop) continue;
    events.push({
      uid: `blockwise-study-${wd}@blockwise`, title: 'Study hours – open Blockwise', weekday: wd,
      start: ds.studyStart, end: ds.studyStop, firstDate: d, everyOtherWeek: false,
    });
  }
  return events.sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.start.localeCompare(b.start));
}

/** Build the .ics text. Times are "floating" (the phone's local time), which suits one school's time zone. */
export function buildReminderCalendar(state, { today, now = new Date(), until = '2027-06-30', appUrl = '' } = {}) {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Blockwise//Pilot//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Blockwise reminders'];
  for (const e of reminderEvents(state, today)) {
    lines.push('BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(e.firstDate, e.start)}`,
      `DTEND:${icsDate(e.firstDate, e.end)}`,
      `RRULE:FREQ=WEEKLY;${e.everyOtherWeek ? 'INTERVAL=2;' : ''}BYDAY=${BYDAY[e.weekday]};UNTIL=${until.replace(/-/g, '')}T235959`,
      `SUMMARY:${esc(e.title)}`,
      `DESCRIPTION:${esc(`Blockwise has already picked what to work on. Open it to see.${appUrl ? ` ${appUrl}` : ''}`)}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, 'TRIGGER:-PT5M', 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export { formatHM };
