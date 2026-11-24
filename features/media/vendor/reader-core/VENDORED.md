# Vendored: reader-core (audiobook playback rules)

These three files are copied from `reader-core`, a small audio-player library (pure functions, no DOM). They are licensed
under GPL-3.0, the same licence as the rest of nav-pi. The code is unchanged; some comments were shortened or reworded.

| File | Content |
|---|---|
| `player-rules.js` | playback speeds, skip, rewind on resume, chapter restart, MediaSession actions |
| `sleep-timer.js` | the sleep timer rules (after a duration, or at the end of the chapter) |
| `listening.js` | time spans and progress; used by `sleep-timer.js` |

Keep these files identical to the library: behaviour changes are made in `reader-core` first and then copied here.
