/**
 * Calendar dates and the domain clock.
 *
 * Posted dates are date-only strings, never instants: a transaction posted on
 * 2026-03-08 is on that day regardless of the reader's timezone. "Today" and
 * "this month", by contrast, are questions about a moment, and the ledger
 * answers them in `America/New_York` (TDD section 2).
 *
 * The contract's own pattern accepts impossible dates such as 2026-02-31, so
 * calendar correctness is checked here rather than assumed from the regex.
 */

export const LEDGER_TIME_ZONE = "America/New_York";

/** Matches the contract's `LocalDate` pattern; shape only, not the calendar. */
const DATE_SHAPE = /^(19|2[0-9])[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const MONTH_SHAPE = /^(19|2[0-9])[0-9]{2}-(0[1-9]|1[0-2])$/;

export const MIN_DATE = "1900-01-01";
export const MAX_DATE = "2999-12-31";

export class DateFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateFormatError";
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** True only for a date that exists: 2028-02-29 does, 2026-02-29 does not. */
export function isCalendarDate(text: unknown): text is string {
  if (typeof text !== "string" || !DATE_SHAPE.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  if (day > daysInMonth(year, month)) return false;
  return text >= MIN_DATE && text <= MAX_DATE;
}

export function assertCalendarDate(text: unknown): string {
  if (!isCalendarDate(text)) throw new DateFormatError("not a calendar date");
  return text;
}

export function isYearMonth(text: unknown): text is string {
  return typeof text === "string" && MONTH_SHAPE.test(text) && text >= "1900-01" && text <= "2999-12";
}

export function assertYearMonth(text: unknown): string {
  if (!isYearMonth(text)) throw new DateFormatError("not a calendar month");
  return text;
}

/**
 * Canonical dates compare correctly as plain strings, which is why every
 * comparison in the service runs through validation first.
 */
export function compareDates(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

/** Exclusive end of a month: calendar-month queries never touch a timezone. */
export function nextMonthStart(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  const nextYear = index === 12 ? year + 1 : year;
  const nextIndex = index === 12 ? 1 : index + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextIndex).padStart(2, "0")}-01`;
}

/** Last day of a month, as a date. */
export function monthEnd(month: string): string {
  return addDays(nextMonthStart(month), -1);
}

export function addDays(date: string, days: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  // UTC arithmetic on a date-only value: no local timezone is involved, so no
  // daylight-saving shift can move the result onto the wrong day.
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatUtcDate(shifted);
}

export function dayBefore(date: string): string {
  return addDays(date, -1);
}

function formatUtcDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + 1;
  const day = value.getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const easternFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: LEDGER_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Today in the ledger's timezone. At 00:30 Eastern on 3 March it is still
 * 05:30 UTC on 3 March, but at 20:00 Eastern it is already the 4th in UTC —
 * taking the UTC date would silently file an evening transaction under
 * tomorrow.
 */
export function easternDate(epochMs: number): string {
  return easternFormatter.format(new Date(epochMs));
}

export function easternMonth(epochMs: number): string {
  return monthOf(easternDate(epochMs));
}
