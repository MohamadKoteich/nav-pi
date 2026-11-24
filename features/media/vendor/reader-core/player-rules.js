// player-rules — the decisions an audiobook player makes: playback speeds, skip lengths, how far to rewind when
// a book is picked up again, the lock-screen (MediaSession) actions and chapter restarts. The player keeps its own
// DOM, storage and transport; everything here is pure, so it can be tested without a browser. Written for older
// browsers too (no `??=`, no `.at()`, no `Object.hasOwn`).

/** Playback speeds offered, in order. 1 is always present so "back to normal" exists. */
export const AUDIO_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];   // 0.5–3x

/** The ceiling a stored or restored speed is held to — above this, speech stops being speech. */
export const AUDIO_SPEED_MAX = 4;

/** Seconds the skip buttons move. 30 is the default because it is roughly a lost sentence. */
export const SKIP_CHOICES = [10, 15, 30, 60];
export const SKIP_SECONDS_DEFAULT = 30;

/**
 * How far back to step when a book is picked up again, by how long the listener was away.
 * Landing exactly where the audio stopped means rejoining mid-word; a coffee break needs a
 * couple of seconds, overnight needs a run-up.
 */
export const REWIND_ON_RESUME = [
  { awayMinutes: 0, back: 0 },
  { awayMinutes: 1, back: 3 },
  { awayMinutes: 10, back: 10 },
  { awayMinutes: 60, back: 20 },
  { awayMinutes: 24 * 60, back: 30 },
];

/**
 * Pressing "previous chapter" this far into a chapter restarts it instead of going back one —
 * the behaviour every music player has trained people to expect.
 */
export const CHAPTER_RESTART_WINDOW = 3;

/** The lock-screen / notification actions the player registers. */
export const MEDIA_SESSION_ACTIONS = [
  "play", "pause", "stop", "seekbackward", "seekforward",
  "previoustrack", "nexttrack", "seekto",
];

/** A speed that is safe to apply: a positive number inside the ceiling, else 1. */
export function clampAudioSpeed(value) {
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!(n > 0)) return 1;
  return n > AUDIO_SPEED_MAX ? AUDIO_SPEED_MAX : n;
}

/**
 * The next speed in the ring. Off-list speeds (a restored 1.1) step up to the next listed one
 * rather than snapping to the start, so pressing the button always speeds up first.
 */
export function nextAudioSpeed(current, speeds) {
  const list = speeds && speeds.length ? speeds : AUDIO_SPEEDS;
  const now = clampAudioSpeed(current);
  for (let i = 0; i < list.length; i++) if (list[i] > now + 1e-6) return list[i];
  return list[0];
}

/** The speed sheet's − / + step, and the range it steps within (AUDIO_SPEEDS' ends). */
export const AUDIO_SPEED_STEP = 0.05;

/**
 * One − (dir < 0) or + (dir > 0) press of the speed sheet: onto the 0.05 grid (an off-grid restored
 * 1.12 goes to 1.15 or 1.10, not 1.17), held to 0.5–3x, rounded so twenty presses from 1 are 2.
 */
export function stepAudioSpeed(current, dir) {
  const lo = AUDIO_SPEEDS[0], hi = AUDIO_SPEEDS[AUDIO_SPEEDS.length - 1];
  const now = clampAudioSpeed(current);
  const k = now / AUDIO_SPEED_STEP;
  const onGrid = Math.abs(k - Math.round(k)) < 1e-6;
  const steps = dir > 0 ? (onGrid ? Math.round(k) + 1 : Math.ceil(k)) : (onGrid ? Math.round(k) - 1 : Math.floor(k));
  const next = Math.round(steps * AUDIO_SPEED_STEP * 100) / 100;
  return next < lo ? lo : next > hi ? hi : next;
}

/** A skip setting that is safe to store: one of the offered choices, else the default. */
export function normalizeSkipSeconds(value) {
  const n = parseInt(value, 10);
  return SKIP_CHOICES.indexOf(n) >= 0 ? n : SKIP_SECONDS_DEFAULT;
}

/**
 * Seconds to step back for a gap of `awayMs`. `enabled` is the listener's setting; when it is
 * off this is always 0, so a caller never has to remember to check.
 */
export function rewindSecondsFor(awayMs, enabled) {
  if (enabled === false) return 0;
  const minutes = Math.max(0, Number(awayMs) || 0) / 60000;
  let back = 0;
  for (let i = 0; i < REWIND_ON_RESUME.length; i++) {
    if (minutes >= REWIND_ON_RESUME[i].awayMinutes) back = REWIND_ON_RESUME[i].back;
  }
  return back;
}

/**
 * Where "previous chapter" should go.
 * @param {number} index              the chapter/track now playing
 * @param {number} secondsIntoChapter how far into it playback is
 * @returns {{index: number, restart: boolean}}
 */
export function previousChapterTarget(index, secondsIntoChapter) {
  const i = Math.max(0, Math.floor(Number(index) || 0));
  const into = Math.max(0, Number(secondsIntoChapter) || 0);
  if (into > CHAPTER_RESTART_WINDOW || i === 0) return { index: i, restart: true };
  return { index: i - 1, restart: false };
}

/**
 * The seek offset the lock screen and headset buttons should use: the player's own skip
 * setting, so the two never disagree about what "back" means.
 */
export function mediaSeekOffsetFor(skipSeconds) {
  return normalizeSkipSeconds(skipSeconds);
}

/**
 * The sleep-timer menu, as one list: the timer durations plus the
 * end-of-chapter mode. `SLEEP_MINUTES` stays the source of the numbers (sleep-timer.js).
 */
export function sleepChoices(minutes) {
  const list = minutes && minutes.length ? minutes : [10, 15, 30, 45, 60, 90];
  const out = [{ value: 0, label: "Off" }];
  for (let i = 0; i < list.length; i++) out.push({ value: list[i], label: list[i] + " min" });
  out.push({ value: "chapter", label: "End of chapter" });
  return out;
}
