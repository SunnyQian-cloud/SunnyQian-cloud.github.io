// Local-date helpers.
// Dates are 'YYYY-MM-DD' strings in the device's local time zone.
// Times of day are whole minutes since local midnight (0–1439).

export const pad = (n) => String(n).padStart(2, '0');

export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse 'YYYY-MM-DD' into a local-midnight Date, or null if invalid (e.g. 2026-02-30). */
export function parseISODate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

export const isValidISODate = (s) => parseISODate(s) !== null;

/** Build an ISO date from parts, or null if the date does not exist. */
export function makeISODate(y, m, d) {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isValidISODate(iso) ? iso : null;
}

export function addDays(iso, n) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n); // handles month/year boundaries and DST (local midnight)
  return toISODate(d);
}

/** Whole calendar days from a to b (b − a). DST-safe. */
export function daysBetween(a, b) {
  const da = parseISODate(a), db = parseISODate(b);
  return Math.round(
    (Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) -
      Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / 86400000
  );
}

export const weekdayOf = (iso) => parseISODate(iso).getDay();

/** 'HH:MM' (24h) → minutes since midnight, or null. */
export function parseHM(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function formatHM(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${pad(h)}:${pad(m)}`;
}

/** 1170 → '7:30 PM' */
export function formatTime12(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
}

/** 95 → '1 h 35 min', 60 → '1 h', 45 → '45 min' */
export function formatDuration(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function weekdayName(iso, long = false) {
  return (long ? WD_LONG : WD_SHORT)[weekdayOf(iso)];
}

/** 'Fri, Nov 6' (adds year if different from refYear) */
export function formatDate(iso, refIso) {
  const d = parseISODate(iso);
  let s = `${WD_SHORT[d.getDay()]}, ${MON_SHORT[d.getMonth()]} ${d.getDate()}`;
  if (refIso && parseISODate(refIso).getFullYear() !== d.getFullYear()) s += `, ${d.getFullYear()}`;
  return s;
}

/** 'Today', 'Tomorrow', 'Yesterday', else 'Fri, Nov 6' */
export function relativeDateLabel(iso, todayIso) {
  const diff = daysBetween(todayIso, iso);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return formatDate(iso, todayIso);
}

/** Local date + minutes for a Date object. */
export function localParts(date) {
  return { date: toISODate(date), minutes: date.getHours() * 60 + date.getMinutes() };
}

export const roundUpTo = (n, step) => Math.ceil(n / step) * step;
