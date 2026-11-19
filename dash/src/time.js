// Windowing and time labels.
//
// GA4 labels hours as `dateHour` strings ("YYYYMMDDHH") in the PROPERTY's
// timezone. Nothing in this file converts them to or from the browser's clock:
// parseDH and toDH are inverses in the browser's local time, so arithmetic that
// round-trips through them is exact whatever timezone the labels denote. That is
// why window edges are derived from a label GA returned, never from Date.now().
// See README, "Window semantics".

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 1440;

// The one range the standard report cannot serve: dateHour is GA4's finest
// historical bucket, so a half hour has to come from runRealtimeReport.
export const REALTIME_MINUTES = 30;
export const isRealtimeRange = minutes => minutes <= REALTIME_MINUTES;

/** Whole hours a range spans: the chart's bucket count, floored at one. */
export const rangeHours = minutes => Math.max(1, Math.round(minutes / MINUTES_PER_HOUR));

/** How a range reads in prose: "last 30 m", "last 24 h", "last 7 days". */
export function rangeLabel(minutes) {
  if (minutes < MINUTES_PER_HOUR) return `last ${minutes} m`;
  if (minutes <= MINUTES_PER_DAY) return `last ${minutes / MINUTES_PER_HOUR} h`;
  return `last ${minutes / MINUTES_PER_DAY} days`;
}

/** The label a tile uses: one hour is GA's latest reported hour, not a rolling 60 minutes. */
export const tileRangeLabel = minutes =>
  minutes === MINUTES_PER_HOUR ? "latest reported hour" : rangeLabel(minutes);

/**
 * Start date for a day-granular report covering the last `minutes`.
 *
 * `NdaysAgo` is a DATE, so `NdaysAgo..today` spans N+1 calendar days. Floored at
 * one day back, never zero: `0daysAgo..today` is *today* in the property's
 * timezone, which can be an hour old. A day too wide is a small error; most of a
 * day missing is not.
 */
export const rangeStart = minutes =>
  `${Math.max(1, Math.ceil(minutes / MINUTES_PER_DAY) - 1)}daysAgo`;

/** The day-granular span a whole-day card covers, in prose. */
export const daySpanLabel = minutes =>
  minutes <= MINUTES_PER_DAY ? "today and yesterday" : `last ${minutes / MINUTES_PER_DAY} days`;

export function parseDH(dh) {
  return new Date(+dh.slice(0, 4), +dh.slice(4, 6) - 1, +dh.slice(6, 8), +(dh.slice(8, 10) || 0));
}

export function toDH(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}`;
}

/** Hour arithmetic in label space. */
export function shiftDH(dh, hours) {
  const d = parseDH(dh);
  d.setHours(d.getHours() + hours);
  return toDH(d);
}

/** Day arithmetic on a GA `date` label (YYYYMMDD). */
export function shiftDay(day, days) {
  const d = parseDH(`${day}00`);
  d.setDate(d.getDate() + days);
  return toDH(d).slice(0, 8);
}

/** Every dateHour from start to end inclusive. */
export function hoursIn({ start, end }) {
  const out = [];
  for (let dh = start; dh && dh <= end; dh = shiftDH(dh, 1)) out.push(dh);
  return out;
}

/** "YYYYMMDDHH" or "YYYYMMDD" as an ISO date for a GA dateRange. */
export const isoDay = dh => `${dh.slice(0, 4)}-${dh.slice(4, 6)}-${dh.slice(6, 8)}`;

/**
 * The window a range covers, anchored to the latest hour GA reported. `latest`
 * IS "now" in property time, so counting back from it needs no timezone.
 * At 1 h the window is that one hour.
 */
export function anchoredWindow(latest, minutes) {
  if (!latest) return null;
  return { start: shiftDH(latest, -(rangeHours(minutes) - 1)), end: latest };
}

/** The same-length window immediately before `win`. */
export function previousWindow(win) {
  if (!win) return null;
  const hours = hoursIn(win).length;
  return { start: shiftDH(win.start, -hours), end: shiftDH(win.start, -1) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDH(dh, withHour = true) {
  const d = parseDH(dh);
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return withHour ? `${day}, ${String(d.getHours()).padStart(2, "0")}:00` : day;
}

/** A GA `date` (YYYYMMDD) as "Mon Mar 4" or "Mar 4". */
export function fmtDay(day, weekday = false) {
  const d = parseDH(`${day}00`);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return weekday ? `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${base}` : base;
}

/** How long before `now` (both dateHour labels) an hour was, coarsely. */
export function relativeDH(dh, now) {
  if (!dh || !now) return null;
  const hours = Math.round((parseDH(now) - parseDH(dh)) / 3600e3);
  if (hours <= 0) return "this hour";
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} d ago`;
  return `${Math.floor(days / 7)} wk ago`;
}

// ---- chart buckets ---------------------------------------------------------

export const BUCKET_MINUTES = { hour: MINUTES_PER_HOUR, day: MINUTES_PER_DAY, week: 7 * MINUTES_PER_DAY };

/** A bucket the range cannot fill twice over draws one column, which is not a series. */
export const bucketFits = (bucket, minutes) => minutes >= 2 * BUCKET_MINUTES[bucket];

/** The dateHour that starts the bucket `dh` falls in. Weeks start Monday, in property time. */
export function bucketStart(dh, bucket) {
  if (bucket === "hour") return dh;
  const d = parseDH(dh);
  d.setHours(0, 0, 0, 0);
  if (bucket === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDH(d);
}

/**
 * Hourly points folded into day or week columns, by summing.
 *
 * For a de-duplicated count such as activeUsers a summed day is traffic volume,
 * not people per day (somebody who comes back after lunch is in it twice), and
 * the chart says so. The secondary (event) series keeps its unknown-versus-zero
 * distinction: a bucket whose every hour is unknown stays null.
 */
export function bucketPoints(pts, bucket) {
  if (bucket === "hour") return pts;
  const out = [], byKey = new Map();
  for (const p of pts) {
    const ts = bucketStart(p.ts, bucket);
    let b = byKey.get(ts);
    if (!b) {
      b = { ts, bucket, hours: 0, value: 0, baseline: null, secondary: null };
      byKey.set(ts, b);
      out.push(b);
    }
    b.hours++;
    b.value += p.value || 0;
    if (p.baseline != null) b.baseline = (b.baseline || 0) + p.baseline;
    if (p.secondary != null) b.secondary = (b.secondary || 0) + p.secondary;
  }
  return out;
}

/**
 * How a point names itself. A realtime point says how long ago it was and
 * nothing more: minutesAgo is relative to the request, dateHour to the property,
 * and minting a wall-clock label would silently mean one of them.
 */
export function pointLabel(p, withHour = true) {
  if (p.minutesAgo != null) return p.minutesAgo === 0 ? "now" : `${p.minutesAgo} min ago`;
  if (p.bucket === "day") return fmtDH(p.ts, false);
  if (p.bucket === "week") return `week of ${fmtDH(p.ts, false)}`;
  return fmtDH(p.ts, withHour);
}

/** A YYYY-MM-DD config date as a dateHour at the start of that day. */
export const dateToDH = iso => (iso ? `${iso.replace(/-/g, "")}00` : null);
