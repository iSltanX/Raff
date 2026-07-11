# NOTES — implementation ↔ plan mapping

## Plan phases (خطة التطوير §7) → what shipped in 0.1.0

| Plan stage | Features | Status |
| --- | --- | --- |
| **مرحلة ٠ — الهيكل** | menu-bar tray, global hotkey (⇧⌘V), text capture with history, floating panel list, paste into previous app | ✅ shipped |
| **مرحلة ١** | instant search/filter (diacritic- and digit-insensitive), paste as plain text (⌥⏎), delete item (⌘⌫), clear history, concealed-flag handling | ✅ shipped |
| **مرحلة ٢** | pin/unpin (⌥P + hover pin), «مثبّت» shelf (never auto-pruned, separate pinned.json) | ✅ shipped |
| **مرحلة ٣** | images (PNG + thumbnails), type icons, per-app exclusion list | ✅ shipped (link previews deferred — plan allows) |
| **مرحلة ٤** | small friction-driven refinements | ⏳ deferred by design — usage should drive it |
| **مرحلة ٥ / §9** | adaptive ranking | ⏳ deferred by design. v1 does **silent logging only**: `copyCount` / `pasteCount` / `lastUsedAt` per item. Settings expose تفعيل/تعطيل التعلّم, «عرض ما تعلّمه رفّ», and «مسح بيانات التعلّم» as the plan's privacy conditions require. Sorting is plain recency. |

Also shipped from §4: launch at login (macOS Launch Agent via tauri-plugin-autostart),
local persistent storage, first-run Accessibility screen, «الالتقاط» on/off in the tray.

## Engineering decisions & deviations

- **Swift → Tauri**: the plan's §6 architecture is Swift-specific and was
  disregarded per the brief; the same behaviors are implemented in Rust
  (`NSPanel` non-activating panel, pasteboard `changeCount` polling at 350ms,
  `CGEvent` ⌘V, Accessory activation policy).
- **arboard → objc2-app-kit**: the brief suggested the `arboard` crate, but it
  cannot observe `changeCount`, the concealed pasteboard flags, or multiple
  representations (plain + HTML + RTF), all of which the brief also requires.
  Capture/write therefore use the audited safe `objc2-app-kit` NSPasteboard
  bindings directly — the same approach the plan prescribed for Swift.
- **enigo → core-graphics**: ⌘V synthesis uses a `CGEvent` directly (the
  brief's allowed alternative); it is smaller and API-stable.
- **`unsafe` policy**: zero `unsafe` in app logic. The only `unsafe` is the
  Accessibility C FFI (`AXIsProcessTrusted[WithOptions]`) at the bottom of
  `macos.rs`, each call with a SAFETY note. All AppKit calls go through
  objc2's audited safe bindings.
- **Rich paste**: history stores optional HTML/RTF representations (≤256 KB)
  so a normal paste restores formatting; «لصق كنص عادي» writes only the plain
  string. This is what makes the plain-paste feature meaningful.
- **Dedup**: exceeds the "consecutive duplicates" minimum — re-copying content
  identical to *any* stored item bumps that item (and moves history items to
  the top) instead of creating a duplicate. Images dedupe by content hash.
- **Pinned = separate layer**: pinning *moves* an item from history to
  pinned.json (the plan's two-layer model); unpinning returns it to its
  recency position. Pinned items are excluded from the history cap.
- **AA contrast**: key-hint/placeholder greys from the reference mockup
  (#A09589 light / #736A5E dark) fail 4.5:1, so hints use the secondary tokens
  instead; small accent-colored text uses a darkened honey (`--accent-text`
  #8F5B14) in light mode. Everything else matches the reference values exactly.
- **Fonts**: Cairo ships as static weights (300–900) rather than the variable
  file — `R/fonts` contains statics; same rendered result. `@font-face`
  `unicode-range` limits both families to Arabic script so Latin text and
  digits fall through to SF Pro / SF Mono per the identity.
- **Tray menu**: rebuilt on every store change (last-5 items, capture
  checkbox). Clicking an item copies it to the clipboard (menus can't paste
  into another app without stealing context).
- **First-run**: shown once when Accessibility is missing; polls after opening
  System Settings and closes itself on grant. Degrades gracefully — without
  the permission ⏎ copies to the clipboard and the panel shows a hint toast.
- **Design-review mock**: `src/js/mock.js` serves the reference sample items
  when pages are opened outside Tauri (plain browser); inert inside the app.

## Verified during development

- `cargo test` (7 tests: type detection, dedupe, cap, pin round-trip, corrupt
  file guard, learning reset) and `npm test` (7 tests: digits, normalization,
  filtering, relative time, hotkey display/recording) pass.
- Live end-to-end: copied Arabic text / URL / code / screenshot with the app
  running → correct typing, dedupe bump (`copyCount: 2`), image + thumbnail
  files, correct source-app attribution in `history.json`.
- All three screens pixel-checked against the R/ reference in light and dark.
