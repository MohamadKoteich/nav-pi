# UI rules

This is a developer document. These rules apply to every feature's UI. The dates say when a rule was last
changed. The features themselves are described in [FEATURES.md](FEATURES.md); the UI tests in
[TESTING.md](TESTING.md).

## Layout

(2026-11-22) Settings live in the left rail; the top bar shows information only. There is no Home screen: the app
starts on the map.

- **Dock** (left rail in landscape, bottom bar in portrait): Maps · Places · Media · Trips · GPS, each only where
  its feature is in the edition, then **Settings** (gear, from core, always last; in landscape at the bottom of
  the rail). Features add a dock button only if they are a main screen. `Shell` sorts them by `ORDER` in
  `features/core/shell.js`. In landscape the rail buttons are 112 px and shrink when more entries need the room.
- **Places** (`features/places/`, every edition; requires `nav`): Home / Work tiles, favourites, parked car, recent
  destinations. It reads and writes the same device store as the Saved places of the Maps search panel:
  localStorage `navpi.places` {home, work, favs}, `navpi.parked`, `navpi.recents`. One tap = a route preview via
  `Maps.preview`, never guidance; while guiding it asks before `Maps.navigateTo`. Recent destinations are shown in
  the Maps search panel and on the Places page.
- **Trips** (trip computer and trip log, `features/trip/view.html`) and **GPS** (status page,
  `features/gps/view.html`) are rail pages (`<section class="view page">`, a title and one column of cards).
- **Status bar: information only.** Clock, now-playing chip (tap = play / pause), Bluetooth icon (shown while
  Bluetooth is on, green = a device connected; bluetooth feature, polled every 30 s), Wi-Fi icon (wifi feature,
  30 s), GPS chip. No chevron, no pull-down, no swipe. The processor temperature is on the Pi health page, not in
  the status bar.
- **Settings page:** a category rail on the left (tinted icon tiles; icons only in portrait) and the chosen
  category's cards on the right, under its title. Categories in rail order:

  | Id | Shown as | Cards |
  |---|---|---|
  | `nav` | Navigation | voice prompts, speed warning |
  | `safety` | Driver alerts | driver alert switches, speed cameras, low-emission zones |
  | `display` | Screen | appearance, rotation, brightness, text and button size, split screen |
  | `sound` | Sound | sound settings |
  | `connect` | Connections | Wi-Fi, Bluetooth, USB |
  | `sat` | Satellite | satellite areas |
  | `car` | Car | service reminders |
  | `health` | Pi health | temperature, load, memory, storage, power, services |
  | `system` | System | language, system, updates, about |

  The table is `CATS` in `features/core/settings.js`. A category with no card in the edition is not listed; a card
  without `data-cat` lands in System. `Settings.open("<card id or category>")` opens the page there. Settings cards
  are one column (an earlier 2-column grid clipped cards at 1280x720).
- Test: `tools/ui-places.mjs` (recipe in its header). The Places feature itself: [FEATURES.md](FEATURES.md#places-every-edition).

## Drive view

(2026-11-22) A calm map with a prominent speed display: the turn card top left, the ETA bar at the bottom (a
bottom-left card in landscape), and above it the **speed cluster** `#speedo`: the current speed (large; red when
it is over the limit + threshold for 2 s) next to the round speed-limit sign.

The current speed has **one** source: the window event `navpi:speed {kmh, src}`, sent by maps.js for every
position (GPS, simulation, tunnel estimate). The display and the over-speed check read only that event, so a
later sensor (for example an IMU, not built) plugs in by sending the same event.

## Keyboard

(2026-11-22) Compact and floating, with its options on the keyboard itself and special characters by long press.

- Code: `features/core/keyboard.js` + `keyboard.css` (core). API for callers:
  `Keyboard.show(input, onChange, onDone, doneLabel)`, `hide()`, `isOpen()`, `place()`.
- **Placement:** a floating panel (rounded, shadow), docked bottom centre. It moves above, else below, the focused
  field when it would cover it. If neither fits, it scrolls the field's own scrolling list once (never `#views`).
  The panel cannot be dragged.
- **Layouts**, chosen with the keyboard's own options key (Material "tune" icon) and kept in `navpi.kbdLayout`:
  - `pad` (default): letters + a number column on the right (7-8-9 / 4-5-6 / 1-2-3 / , 0 .)
  - `letters`: letters only (digits on ?123 and by holding the top row, shown as corner hints)
  - `wide`: full width with a digit row (for big fingers)
- **Key size** S / M / L (`navpi.kbdSize`; keys 48 / 54 / 62 px tall). Nothing about the keyboard is in Settings.
- **Any screen** (see [Screen sizes](#screen-sizes)): S / M / L are px on the glass up to the 720 px base and grow
  with `--ui-s` above it. A key is never below 44 px wide / 48 px tall on the glass, and four letter rows stay
  within ~60 % of the window height (480x320: every size is 48 px).
- **Step-down when a layout does not fit** (`FITS` in keyboard.js, shown as `#kbd[data-fit]`; `data-layout` keeps
  the user's choice): number column → digit row on top (`row`; portrait 600 / 480 px wide, German 11-key rows on
  720 px) → smaller gaps (`tight`) → digits by hold / ?123 (corner hints) → German umlauts by hold (äöüß on
  a/o/u/s) on a 480 px window.
- All placement maths is in screen px (`getBoundingClientRect`, `innerWidth`) and written as UI px
  (/ `UiScale.value()`), the hold popup too.
- If the field sits in a `.navpanel` form that would run under the docked keyboard and there is no room above the
  field, the form gets a `max-height` ending above the keyboard and scrolls (the field is scrolled into view once),
  so the form's close / save buttons stay reachable (480x320 Places edit). This is undone on hide.
- The layout guard checks every keyboard key ≥ 44 px on the glass at every size (no exemption).
- **Languages:** en = QWERTY (äöüß by holding a/o/u/s), de = QWERTZ with ü ö ä ß as keys.
- **Long press** (450 ms): a popup of variants. The top row offers its digit first. Variants: a äàáâæãå,
  e éèêëē, i íìîï, o öóòôøœõ, u üúùû, y ýÿ, s ßśš, c çčć, n ñń, z žźż, l ł; - –_—·, ' "`´’‘, . …:;, ? ¿, ! ¡,
  € $£¥¢, ( [{<, ) ]}>, / \|, 0 °, 1 ¹½, 2 ², 3 ³. Slide onto one and lift, or lift and tap one.
- Letters type on release (so a hold can become a variant); Shift, Backspace and ?123 act on press; Backspace
  repeats while held. Shift = one capital, second tap = Caps Lock, third = off.
- **USB keyboard:** fields stay focusable (`inputmode="none"`, never `readonly`), native typing reaches `onChange`,
  Enter = the last key, Escape closes.
- Test: `tools/ui-keyboard.mjs` (also `--cdp` on the Pi; it restores the Pi's layout and size afterwards).

## Map gestures

(2026-11-22) Browsing the map must never open anything by accident.

- A short tap on the map does nothing (no sheet, no marker) in browse, preview and while driving.
- Only a long press opens the place sheet (`#pick`): one finger or the left mouse button held 500 ms without
  moving more than 10 px. A second finger, a user pan / zoom / rotate (`movestart` with an original event),
  lifting anywhere, `pointercancel`, blur or a hidden page cancel it. Only one timer exists.
- Sheet content: browse = Drive here, Start here, Park here, Save; preview = + Add stop; driving = Add stop
  (inserted where the point lies along the route, `insertStop`) and Drive here (`navigateTo`), no Start / Park
  here.
- Deliberate taps that remain: the grey alternative route line (in preview; not after a long press on it), the
  parked-car P marker (walk back), the route rows.
- Test: `tools/ui-maptap.mjs`.

## Screen sizes

(2026-11-22) **Rule for every feature:** write CSS in px for a **720 px short side** (the Touch Display 2 layout,
1280x720 / 720x1280) and let the shell scale it.

**How the scale works.** `features/core/scale.js` (loaded in `<head>`, before the first paint) sets ONE number,
`--ui-s`, on `<html>`, and `core.css` applies it as `html { zoom }`. So the rail, status bar, cards, keyboard,
speed cluster, turn card, ETA bar and any new page scale together. `#map` is zoomed back by `--ui-inv`: MapLibre
draws at the screen's own pixels, and its markers keep their size. The number is computed from:

- `auto` = short side / 720 (above 720 at half the rate)
- `phys`: if the kiosk passes `?mm=WxH` (the panel size from the EDID, `pi/kiosk.sh`), controls are never
  physically smaller than on the 5" Touch Display 2 (the reference panel, ~295 ppi) at scale 1:
  phys = ppi / 295, so only denser panels grow
- `user` = *Settings > Screen > Text and button size* (Smaller 0.85 / Normal 1 / Larger 1.2,
  localStorage `navpi.uiSize`, applied at once)
- final = clamp(max(auto, phys, 0.8) × user, 0.8, short side / 380)

Resulting values: 800x480 0.8 (Larger 0.96) · 1024x600 0.83 · 1280x720 1 · 1280x800 1.06 · 1920x1080 1.25 ·
1920x1200 1.33 · 480x320 0.8 · 720x1280 1 · 600x1024 0.83 · 480x800 0.8. At 0.8, a 56 px control is 45 px on the
glass and a 72 px control 58 px.

**Breakpoints by the room left, never by device names:** `<html data-fit="…">`, in layout px (after the scale):

| Class | Condition | Effect |
|---|---|---|
| `short` | height < 640 | rail cells share the height, tighter headers |
| `tiny` | height < 470 (3.5" 480x320, or 5" 800x480 with a known panel size) | status bar 48 px with a 30 px clock, rail 80 px with icons only, compact turn card, speed cluster beside the ETA bar, route sheet full width with Go kept in view |
| `narrow` | width < 760 | Settings rail icons only, media in one column, no split screen |
| `wide` | width > 1400 | |

**Rules for features:**

1. No `vw` / `vh` (they are screen px; if you must, multiply by `var(--ui-inv)`) and no
   `@media (min-width: …px)`. Use `:root[data-fit~="tiny"] …` next to your own CSS.
2. Page and Settings columns stop at `--content-max` (1040 px). This is automatic for `.page .pg-body > *` and
   `#settings .st-pane > *`.
3. In JS, `getBoundingClientRect()` is in screen px, but `scrollTop` / `offsetTop` / style px are UI px: divide by
   `UiScale.value()` (see `open` in settings.js). Map padding in screen px = UI px × `UiScale.value()` (see the
   preview in maps.js).
4. Every control is ≥ 44 px on the glass (the layout guard checks it at every size, keyboard keys included).
   Settings and Places controls are designed at 56 UI px and checked at ≥ max(44, 56 × UI scale) on the glass.

`UiScale.set(size)` fires `navpi:uiscale` and `resize`. The page can never be zoomed by the user (kiosk flags,
viewport meta tag and `touch-action`).

## Layout guard

(2026-11-12, updated 2026-11-22) After any UI change, run the layout guard:
`bash tools/run-ui-tests.sh layout-guard`, or by hand `node tools/ui-layout-guard.mjs <local-url> [shots-dir]`
(and `--cdp` on the Pi, see [TESTING.md](TESTING.md#on-the-device)).

- Locally it runs the screen matrix 800x480, 1024x600, 1280x720, 1280x800, 1920x1080, 1920x1200, 480x320,
  720x1280, 600x1024 and 480x800 (`SIZES=` narrows it).
- It checks that every control is ≥ 44 px (Settings ≥ 56 × UI scale), the status bar (nothing outside it, clock
  ≥ 20 px), and the UI size setting at 1280x720 and 800x480. It saves map, settings, page, sheet and guiding
  screenshots per size.
- It opens every Settings category (top and bottom of the pane) and fails on a control cut off at the edge, a
  Settings control smaller than 56 px, an empty category, or a leftover quick panel.
