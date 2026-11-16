// Relative date parsing for date fields (e.g. `job 1284 eta fri`).
// All arithmetic is in local time; results are local calendar dates.
//
// Accepted forms:
//   today, tod · tomorrow, tmr, tmrw, tom
//   weekday names (mon, tues, friday…) → the next such day; today counts
//   +3, +3d, 3d → days from today · +2w, 2w → weeks from today
//   2026-11-14 (ISO)
//   nov 14, 14 nov, november 14 → this year, or next year if already past
// Numeric slash dates (3/4) are rejected as day/month vs month/day ambiguous.

export interface ParsedDate {
  /** Local calendar date as yyyy-mm-dd. */
  iso: string;
  /** Short display label, e.g. "Fri 13 Nov". */
  label: string;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Words a date can start with; used for completion and "still typing" detection. */
export const DATE_WORDS = [
  "today", "tomorrow",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const DAY_NAMES =["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/** yyyy-mm-dd from the local calendar date (never via toISOString, which is UTC). */
export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dateLabel(d: Date): string {
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function validDate(y: number, m: number, day: number): Date | null {
  const d = new Date(y, m, day);
  return d.getFullYear() === y && d.getMonth() === m && d.getDate() === day ? d : null;
}

function result(d: Date): ParsedDate {
  return { iso: toIsoDate(d), label: dateLabel(d) };
}

export function parseDate(text: string, now: Date): ParsedDate | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  const today = startOfDay(now);

  if (s === "today" || s === "tod") return result(today);
  if (["tomorrow", "tmr", "tmrw", "tom"].includes(s)) return result(addDays(today, 1));

  if (s in WEEKDAYS) {
    const delta = (WEEKDAYS[s] - today.getDay() + 7) % 7;
    return result(addDays(today, delta));
  }

  const rel = /^(?:\+(\d{1,3})([dw])?|(\d{1,3})([dw]))$/.exec(s);
  if (rel) {
    const n = Number(rel[1] ?? rel[3]);
    const unit = rel[2] ?? rel[4] ?? "d";
    return result(addDays(today, unit === "w" ? n * 7 : n));
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) {
    const d = validDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return d ? result(d) : null;
  }

  const md = /^([a-z]+) (\d{1,2})$/.exec(s) ?? /^(\d{1,2}) ([a-z]+)$/.exec(s);
  if (md) {
    const [monthWord, dayStr] = /^\d/.test(md[1]) ? [md[2], md[1]] : [md[1], md[2]];
    const month = MONTHS[monthWord];
    if (month === undefined) return null;
    const day = Number(dayStr);
    let d = validDate(today.getFullYear(), month, day);
    if (d && d < today) d = validDate(today.getFullYear() + 1, month, day);
    // Feb 29 in a non-leap year: invalid this year, maybe valid next; reject if neither.
    if (!d) d = validDate(today.getFullYear() + 1, month, day);
    return d ? result(d) : null;
  }

  return null;
}
