// sleep-timer — when should an audiobook stop playing itself?
//
// Extracted because it is the one part of the audiobook transport that is pure decision rather than
// DOM or platform: given a mode, a clock and where the listener is in the chapter, should playback
// stop now? The player owns the fade, the <audio> element and the countdown label; this owns the
// rule.
//
// Two modes, because they are the two ways people actually fall asleep to a book:
//   * a duration — "stop in 30 minutes", the clock decides;
//   * end of chapter — stop at the seam, so you can pick the book up at a sensible place rather
//     than mid-sentence.
//
// The end-of-chapter rule fires slightly BEFORE the boundary (see END_SLACK_SECONDS): a `timeupdate`
// arrives about four times a second, and waiting for `position >= end` exactly would often mean the
// next chapter had already begun playing.

import { listenSpan } from "./listening.js";

/** How close to the chapter end counts as "the end". One tick of a 4 Hz timeupdate, with room. */
export const END_SLACK_SECONDS = 1;

/** Durations offered in the UI, in minutes. `chapter` is handled as its own mode. */
export const SLEEP_MINUTES = [10, 15, 30, 45, 60, 90];

/**
 * Turn what the listener picked into timer state.
 * @param {string|number} choice  a minute count, "chapter", or 0/"" for off
 * @param {number} now            epoch ms
 * @returns {{mode: "off"|"duration"|"chapter", until: number, minutes: number}}
 */
export function sleepTimerFrom(choice, now) {
  if (choice === "chapter") return { mode: "chapter", until: 0, minutes: 0 };
  const minutes = parseInt(choice, 10) || 0;
  if (minutes <= 0) return { mode: "off", until: 0, minutes: 0 };
  return { mode: "duration", until: now + minutes * 60000, minutes };
}

/**
 * Should playback stop now?
 * @param {{mode: string, until: number}} timer
 * @param {{now: number, position: number, chapterEnd: number}} at
 */
export function shouldStop(timer, at) {
  if (!timer || timer.mode === "off") return false;
  if (timer.mode === "duration") return at.now >= timer.until;
  if (timer.mode === "chapter") {
    // A chapter end of 0 means we do not know where the seam is (a stream with no duration yet):
    // never stop on a guess, or the book pauses itself for no visible reason.
    if (!(at.chapterEnd > 0)) return false;
    return at.position >= at.chapterEnd - END_SLACK_SECONDS;
  }
  return false;
}

/**
 * The countdown to show. Empty string when there is nothing to say.
 * @param {{mode: string, until: number}} timer
 * @param {number} now
 */
export function sleepTimerLabel(timer, now) {
  if (!timer || timer.mode === "off") return "";
  if (timer.mode === "chapter") return "until the end of the chapter";
  const left = timer.until - now;
  if (left <= 0) return "stopping now";
  // listenSpan (listening.js) is the one place every player spells a span, rounding included — a
  // hand-rolled `Math.round(left / 60000)` here never carried 60 rounded minutes into "1 h" the
  // way listenSpan does.
  return listenSpan(left / 1000) + " left";
}
