// listening — the arithmetic of an audiobook: where you are, how much is left, how much you have done.
//
// One place for these answers, so every screen rounds them the same way: "6 h 34 m left" must not depend on which
// screen you look at.
//
// Pure: no DOM, no listenClock of its own (a `now` is always passed), no storage. Chrome 96 safe.

/** Seconds → "3:21" / "1:02:03". Negative and rubbish inputs read as 0:00, never "NaN:aN". */
export function listenClock(seconds, span = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  // `span`: the length this clock sits beside. From an hour up, every clock of that row shows its hours
  // ("0:03:21" beside "−9:36:12"), so elapsed and remaining read as one kind of number.
  const hours = h || (Number(span) || 0) >= 3600;
  const mm = hours ? String(m).padStart(2, "0") : String(m);
  return (hours ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}

/**
 * Seconds → "6 h 34 min" / "42 min" / "under 1 min". The one duration wording every screen uses —
 * listening stats and every listening screen alike
 * (all time spans use this one formatter).
 * For spans a person reads, not a running position.
 */
export function listenSpan(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return "under 1 min";
  // Round to whole minutes ONCE, then split — so 3599 s (59.98 min) carries to "1 h", not "0 h 60 min".
  const totalMin = Math.round(total / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (!h) return m + " min";
  return m ? h + " h " + m + " min" : h + " h";
}

/** 0-100, rounded, clamped. `null` when the duration is unknown — a bar with no length is a lie. */
export function listenPercent(position, duration) {
  const d = Number(duration) || 0;
  if (d <= 0) return null;
  const p = Math.max(0, Number(position) || 0);
  return Math.max(0, Math.min(100, Math.round((p / d) * 100)));
}

/**
 * Seconds of listening left — at the speed being played, which is the number people actually want:
 * at 1.5× a two-hour book is 80 minutes of your evening, not 120.
 */
export function listenTimeLeft(position, duration, rate) {
  const d = Number(duration) || 0;
  if (d <= 0) return 0;
  const left = Math.max(0, d - Math.max(0, Number(position) || 0));
  const r = Number(rate) > 0 ? Number(rate) : 1;
  return left / r;
}

/** "22:14" — the wall listenClock this book ends at, or "" when the duration is unknown. */
export function listenEndsAt(position, duration, rate, now) {
  const left = listenTimeLeft(position, duration, rate);
  if (!(Number(duration) > 0)) return "";
  const at = new Date((Number(now) || Date.now()) + left * 1000);
  return String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
}

/** A book counts as finished within this much of the end (credits, a closing note, a dead tail). */
export const LISTEN_FINISHED_SLACK_SECONDS = 30;

export function listenIsFinished(position, duration) {
  const d = Number(duration) || 0;
  if (d <= 0) return false;
  const p = Number(position) || 0;
  // A file shorter than the slack (a 25 s clip) has no 30 s tail of credits to allow for, and
  // position 0 is never "finished" — a book barely begun must not read as done.
  if (p <= 0) return false;
  const slack = Math.min(LISTEN_FINISHED_SLACK_SECONDS, d * 0.1);
  return p >= d - slack;
}

/**
 * The one line under a title on a shelf card: "34% · 6 h 34 m left", "Finished", "Not started yet".
 * `duration` unknown → the position alone, because "0% of nothing" tells nobody anything.
 */
export function listenProgressLine(position, duration, rate) {
  const p = Math.max(0, Number(position) || 0);
  const d = Number(duration) || 0;
  if (d <= 0) return p > 0 ? listenSpan(p) + " in" : "Not started yet";
  if (listenIsFinished(p, d)) return "Finished";
  if (p <= 0) return listenSpan(d);
  return listenPercent(p, d) + "% · " + listenSpan(listenTimeLeft(p, d, rate)) + " left";
}

/** Which chapter contains `t`, or -1. Chapters are `{start, end}` in whole-book seconds. */
export function listenChapterAt(chapters, t) {
  const list = chapters || [];
  for (let i = 0; i < list.length; i++) {
    if (t >= list[i].start && t < list[i].end) return i;
  }
  return -1;
}

/**
 * Where "previous" goes. Every player agrees on this: restart the chapter you are in unless you are
 * within `restartWithin` seconds of its start, in which case go to the one before.
 */
export const LISTEN_RESTART_WITHIN_SECONDS = 3;

export function listenPrevTarget(chapters, t, restartWithin) {
  const slack = restartWithin == null ? LISTEN_RESTART_WITHIN_SECONDS : restartWithin;
  const i = listenChapterAt(chapters, t);
  if (i < 0) return Math.max(0, t - 300);
  const here = chapters[i];
  if (t - here.start > slack) return here.start;
  return i > 0 ? chapters[i - 1].start : 0;
}

/**
 * Roll daily totals into what the Audiobooks page shows.
 * `rows`: `[{day: "2026-09-06", seconds: 1234}, …]` in any order. `today`: "YYYY-MM-DD".
 * The streak counts back from today, and tolerates today being empty (the day is not over yet).
 */
export function listenSummarise(rows, today) {
  const byDay = Object.create(null);
  let total = 0;
  for (const row of rows || []) {
    const day = String(row.day || "");
    const secs = Math.max(0, Number(row.seconds) || 0);
    if (!day) continue;
    byDay[day] = (byDay[day] || 0) + secs;
    total += secs;
  }
  const days = [];
  let week = 0;
  for (let i = 6; i >= 0; i--) {
    const day = listenShiftDay(today, -i);
    const seconds = byDay[day] || 0;
    days.push({ day, seconds });
    week += seconds;
  }
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const day = listenShiftDay(today, -i);
    if (byDay[day] > 0) streak++;
    else if (i > 0) break; // an empty today is allowed; an empty yesterday ends it
  }
  return { today: byDay[today] || 0, week, total, streak, days };
}

/** "2026-09-06" ± n days, in local terms — the days a person lived, not UTC's. */
export function listenShiftDay(day, delta) {
  const parts = String(day || "").split("-");
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (isNaN(d.getTime())) return String(day || "");
  d.setDate(d.getDate() + delta);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")
    + "-" + String(d.getDate()).padStart(2, "0");
}


/** Chapter-relative UI/OS timeline; chapters remain in their published order. */
export function listenSeekWindow(chapters, position, duration, scope) {
  const total = Math.max(0, Number(duration) || 0), pos = Math.max(0, Math.min(total, Number(position) || 0));
  let start = 0, end = total;
  if (scope !== "book" && chapters && chapters.length) {
    let i = listenChapterAt(chapters, pos);
    if (i < 0 && pos === total) i = chapters.length - 1;
    const chapter = chapters[i];
    if (chapter && chapter.end > chapter.start) { start = chapter.start; end = chapter.end; }
  }
  return {start, end, position: Math.max(0, Math.min(end - start, pos - start)), duration: end - start};
}

/** End of N chapters including the one playing; clamp at the final chapter. */
export function listenSleepChapterEnd(chapters, position, count) {
  const i = listenChapterAt(chapters, position);
  if (i < 0) return 0;
  const n = Math.max(1, Math.min(99, Math.floor(Number(count) || 1)));
  return chapters[Math.min(chapters.length - 1, i + n - 1)].end;
}

/** Offer recovery only when an actual saved local position changed by more than 30 seconds. */
export function listenSyncUndo(local, remote, fromServer) {
  if (!fromServer || !local || !remote || !Number.isFinite(Number(local.position)) || !Number.isFinite(Number(remote.position))) return null;
  return Math.abs(Number(remote.position) - Number(local.position)) > 30 ? Math.max(0, Number(local.position)) : null;
}
