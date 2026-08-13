# macOS Light/Dark App Icon — investigation and implementation record

Date: 2026-08-13. This documents how Raff's Dock/Finder app icon switches
between the canonical Light and Dark Figma masters, and the primary evidence
behind every claim — so the mechanism can be verified or revisited without
repeating the investigation from scratch.

## UPDATE (v4.2.0) — the §6 conclusion below was wrong; here is what actually ships

§6's conclusion — "the Light canonical icon ships correctly, unchanged in
every other respect" — was based on inspecting bundle *files* (`icon.icns`,
byte-identical, correct artwork) and did not account for how macOS 26
*resolves* a legacy `.icns` at display time. It does not simply show it: it
decomposes the icon into a background "plate" and a foreground glyph and
re-renders the plate with system material — in Dark Mode that plate becomes
near-black. Raff's terracotta *is* the plate, so the Light-only `icon.icns`
that §6 verified as correct on disk **rendered black in Dock/Finder/Spotlight
whenever the system was in Dark Mode**, discovered only by asking macOS
directly (`NSWorkspace.icon(forFile:)`, rendered to a PNG and inspected) —
never by reading the bundle. Proven with controls: the same `icon.icns` under
a different bundle identifier still rendered black (not a cache); another
app's legacy `.icns` in an identical throwaway bundle kept its true colour
(not systemic darkening — that app ships a modern icon asset, Raff didn't).

**What ships now:** the `.icon` document this file investigates below is
compiled and shipped after all — but through a different path than §3–§6
tried, specifically to dodge the `ibtoold` crash: `scripts/apply-app-icon.mjs`
invokes `actool` **standalone**, outside `tauri build`/`tauri-bundler`
entirely, as a step run *after* the app is already built. `tauri build`'s own
`create_assets_car_file` (and its `ibtoold` fragility) is never exercised.
Locally this runs via `scripts/build-candidate.mjs`; in CI, since
`tauri-action` has no post-build hook, `.github/workflows/release.yml` runs
`scripts/ci-fix-release-icon.mjs` immediately after the build-and-publish
step, which also regenerates the DMG and the updater archive **from the
icon-patched app** (never re-uses tauri-action's pre-patch DMG/archive) and
re-signs the regenerated archive with the same secret key.

Two more real bugs in the `.icon` document itself, found rendering the actual
resolved icon (not just reading its JSON): its `mark.png` carried an opaque
`#F5F5F5` background from a Figma in-context export (the same failure mode
§5/`gen-icons.mjs` already document for the raster masters), so the "mark"
layer covered the whole icon once filled — fixed by deriving a true
transparent-alpha glyph from the canonical light master. And
`"glass": true` + translucency rendered the white mark nearly invisible
against a light plate — fixed by making the mark solid.

**This is deliberately not "Dark Mode App Icon support."** Per product
policy, the `.icon` document's `dark` appearance fill was set **identical**
to its default (light) fill — verified: resolved plate RGB is
`(194,111,73)` under both forced-light and forced-dark drawing appearance.
One canonical Light icon, in both system appearances; only Raff's *interior*
UI (Automatic/Light/Dark) still varies. `icon-dark.icns` (§1) remains
unreferenced by any active bundle path.

**Runner requirement, confirmed:** Icon Composer's `.icon` format needs
`actool` from Xcode ≥ 26. `macos-14` (this repo's release runner at the time
§6 was written) has no Xcode 26 at all — the release workflow now runs on
`macos-26` (Xcode 26.6 default as of 2026-07-21), matching what was verified
working on this machine. `macos-14` is also being sunset by GitHub
independent of this (unsupported after 2026-11-02).

The investigation below (§1–§6) is left as-written: the `ibtoold` crash
inside `tauri-bundler`'s own integration is still real and still reproduces
if that path is ever used directly — it just isn't the path in use anymore.

## 1. What was already true before this work

- Figma has one canonical app-icon system: `COMPONENT_SET` "Brand / App Icon"
  (`157:102`), variants `Mode=Light` (`157:92`) / `Mode=Dark` (`157:97`),
  promoted 2026-08-12 after a real visual comparison against the previous
  single-appearance master.
- `scripts/gen-icons.mjs` renders both variants to `icon.icns` and
  `icon-dark.icns` from Figma-exported 1024×1024 PNGs. `icon-dark.icns`
  existed on disk but was not referenced anywhere in `tauri.conf.json`.
- `tauri.conf.json`'s `bundle.macOS.minimumSystemVersion` is `"12.0"` — Raff
  ships back to macOS Monterey.

## 2. What macOS actually supports (verified, not assumed)

Classic macOS app icons are a single static `.icns` referenced by
`CFBundleIconFile` — no built-in light/dark switching exists for that
mechanism at any macOS version, old or current.

**macOS 26 (Tahoe) adds a real, OS-native, appearance-aware app-icon
mechanism** via a compiled **Asset Catalog** (`Assets.car`), referenced by
`CFBundleIconName` instead of `CFBundleIconFile`. The catalog can register
distinct icon renditions per system appearance
(`NSAppearanceNameAqua` = Light, `NSAppearanceNameDarkAqua` = Dark, plus
Tinted/Clear). This is genuinely static, OS-resolved bundle metadata — no
app code, no polling, no relaunch.

The source format authored for this is Apple's **Icon Composer** `.icon`
document (a directory bundle: `icon.json` manifest + an `Assets/` folder of
image layers), compiled to `Assets.car` by **`actool`** — and `actool`
version ≥ 26 is required (ships with Xcode ≥ 26).

Verified on this machine:
```
$ sw_vers
ProductVersion: 26.6.1
$ xcodebuild -version
Xcode 26.6
$ xcrun --find actool
/Applications/Xcode.app/Contents/Developer/usr/bin/actool
```

## 3. What Tauri v2 actually supports (verified from real source, not docs — none exist yet)

Tauri's official docs (`v2.tauri.app/develop/icons/`) do **not** document this
feature at all as of this writing. The mechanism was instead confirmed
directly from the **compiled, installed CLI** (`@tauri-apps/cli` 2.11.4) and
from reading `tauri-bundler`'s real source
(`crates/tauri-bundler/src/bundle/macos/{icon,app}.rs`, `dev` branch):

- `Settings::build()` splits the `bundle.icon` config array into two views:
  `icon_files` (everything **except** paths ending `.icon`) and `icons()`
  (the raw, unfiltered list). `create_icns_file()` — the classic `.icns`
  generator — only ever sees `icon_files`, so **a `.icon` entry cannot break
  `.icns` generation**; it's excluded before that code runs.
- `create_assets_car_file()` reads the unfiltered list, finds any `.icon`
  path, checks `actool --version` is ≥ 26 (`"actool version is less than 26,
  skipping Assets.car file creation"` if not — a **silent, safe skip**, not a
  build failure), then runs `actool ... --compile ... --app-icon Icon
  --include-all-app-icons ... --platform macosx` and copies the resulting
  `Assets.car` into the bundle.
- `create_info_plist()` receives **both** results and sets **both** keys:
  `CFBundleIconFile` (the `.icns`, unconditionally, "the fallback icns
  file" per its own code comment) and, only if `Assets.car` compiled
  successfully, `CFBundleIconName` (looked up via `assetutil --info` on the
  real compiled catalog, not guessed).

**Conclusion: this is additive, not exclusive.** Listing both the existing
`.icns`/`.png` paths and a new `.icon` path in the same `bundle.icon` array
produces a bundle with both `CFBundleIconFile` and `CFBundleIconName`
present — exactly what "prefer a native, no-relaunch solution" requires, with
the pre-existing Light `.icns` staying the fallback for macOS 12–25 or any
machine building without Xcode ≥ 26.

## 4. The `.icon` document — schema and real-world precedent

No official Apple schema for `icon.json` is published. The schema used here
was reverse-engineered from real, production `icon.json` files committed to
open-source macOS apps (via authenticated GitHub code search — see the
per-repo citations below), not guessed:

- **HandBrake** (`macosx/HandBrake.icon/icon.json`) — top-level
  `fill-specializations` with a `linear-gradient` value for the default
  (light) entry and an `{"appearance": "dark", ...}` entry for dark. This is
  the exact pattern Raff's icon needs (two genuinely different gradients).
- **Sparkle**, **Gifski**, **Chromium** — a layer's own colour varies per
  appearance via a layer-level `fill-specializations` array, applied to a
  **single static mask image** (`image-name` never changes per appearance in
  any of the four real examples checked). This is why Raff's `.icon` uses one
  mark image (`Assets/mark.png`, a plain white alpha mask exported from the
  canonical Light Figma component with its background/shadow stripped) tinted
  white in the default entry and `#F5EDE5` in the dark entry, rather than two
  separate mark images.

Raff's `src-tauri/icon-composer/AppIcon.icon/icon.json` was validated by
running the real `actool` compiler directly, in isolation, before being wired
into the build:

```
$ xcrun actool src-tauri/icon-composer/AppIcon.icon --compile ... \
    --app-icon Icon --include-all-app-icons --platform macosx --minimum-deployment-target 26.0
/* com.apple.actool.compilation-results */
.../Assets.car
.../partial-info.plist
```

Inspecting the compiled catalog (`assetutil --info Assets.car`) confirmed
real, distinct renditions were registered under both appearance names:

```
"Appearances": {
  "NSAppearanceNameAqua": 8,
  "NSAppearanceNameDarkAqua": 1,
  "NSAppearanceNameSystem": 0
}
```

## 5. Colour and geometry fidelity

Every value in `icon.json` is the exact canonical Figma value, not
approximated:

| | Light | Dark |
|---|---|---|
| Background gradient | `#C4704B` → `#A35634` | `#2A2018` → `#1B140F` |
| Mark colour | `#FFFFFF` | `#F5EDE5` |

These are the same values already mirrored into `tokens.css`
(`--terracotta-*`, `--color-app-icon-*`) and the same values compiled into
`icon.icns`/`icon-dark.icns`. `Assets/mark.png` is a real Figma export of the
canonical `Mode=Light` component (`157:92`) with only its background
fill/stroke/effects stripped — the bar geometry, position, and proportions
are untouched. Shadow/translucency/specular values (`opacity: 0.5` etc.) use
Icon Composer's own tool defaults, matched to what every real reference
`icon.json` inspected here also uses unless deliberately customised — Icon
Composer computes real-time dynamic lighting rather than accepting literal
pixel blur/offset values, so this is the closest faithful translation of the
approved Figma bevel's *intent*, not a numeric 1:1 conversion (which the two
rendering models don't support).

## 6. Production build validation — the mechanism works, but is not shipped yet

The `.icon` document was wired into `tauri.conf.json`'s `bundle.icon` array
and put through a **real `npm run tauri build`** (not a dry run). Result:
**`Failed to create app Assets.car: 'failed to run actool'`** — the full
build failed.

The failure was traced to ground truth, not left as a guess:

```
$ xcrun actool src-tauri/icon-composer/AppIcon.icon --compile ... [same flags Tauri uses]
/* com.apple.actool.errors */
.../AppIcon.icon: error: Exception while running actool:
*** -[__NSPlaceholderArray initWithObjects:count:]: attempt to insert nil object from objects[0]
  ... IBICAbstractPlatformAdapter selectCatalogIconComposerItemsFromCollection: ...
  ... in ibtoold ...
```

Reproduced in isolation (bypassing Tauri and Cargo entirely, so this is
purely an `actool`/`ibtoold` fact, not anything about this project):

- The exact same document, same flags, same actool binary: **succeeded the
  first time**, then **failed on every subsequent invocation** — including
  re-running the identical command against the identical unmodified file.
- Neither the input path, the directory name (`AppIcon.icon` vs the
  Tauri-internal rename to `Icon.icon`), nor `xcrun actool` vs bare
  `Command::new("actool")` changed the outcome once it started failing.
- `ps aux | grep ibtoold` showed a live
  `.../Xcode.app/.../ibtoold --sending-client-environment` process — the same
  daemon named in the crash backtrace.
- `pkill -f ibtoold` followed by an immediate retry of the exact failing
  command **succeeded again**, producing a real `Assets.car` with both
  `NSAppearanceNameAqua` and `NSAppearanceNameDarkAqua` renditions
  (confirmed via `assetutil --info`) — repeatable.

**Conclusion, evidenced not assumed:** the `.icon` document is correct and
`actool` compiles it correctly *when its background daemon is healthy*.
`ibtoold` (part of Xcode 26.6 — first-generation Icon Composer tooling)
reliably enters a crashing state after repeated compilations on this
machine. `tauri-bundler`'s `create_assets_car_file` does not catch this the
way it catches an old-`actool`-version mismatch (that path logs and returns
`Ok(None)`, a silent skip); an `ibtoold` crash instead propagates through
`cmd.output_ok()?` as a hard error that fails the **entire** `tauri build` —
app and DMG included, not just the dynamic icon.

**Decision:** per the explicit instruction to prefer a clean native
mechanism but *not* ship a fragile workaround, `"icon-composer/AppIcon.icon"`
was **removed** from `tauri.conf.json`'s active `bundle.icon` list.
`icons/icon.icns` (Light) remains the sole, proven-reliable
`CFBundleIconFile`. The validated `.icon` document stays on disk, fully
built and ready — re-adding one line to `tauri.conf.json` is the entire
remaining integration step once Apple ships a more stable `actool`/`ibtoold`,
or once this project adds a defensive `pkill ibtoold` immediately before the
bundle step (not done here, to avoid papering over an external tool bug with
a process-management hack in the same turn that discovered it).

### What was verified in the actual shipped Raff.app bundle

A second real `npm run tauri build` was run with `tauri.conf.json` reverted
to Light-only (`bundle.icon` back to its original 4 `.icns`/`.png` entries,
no `.icon` path). Result: identical to the project's already-documented
baseline — the app and DMG bundle successfully; the overall command still
exits 1, but only at the separate updater-signature step
(`A public key has been found, but no private key... set
TAURI_SIGNING_PRIVATE_KEY`), which is pre-existing and unrelated to icons.

Verified directly against the real build output
(`src-tauri/target/release/bundle/`):

- `Raff.app/Contents/Resources/`: **exactly one file**, `icon.icns`
  (408,388 bytes). No `icon-dark.icns`, no `Assets.car`, no stale/duplicate
  icon of any kind.
- `Info.plist`: `CFBundleIconFile = "icon.icns"`; **`CFBundleIconName` is
  absent** — correct, since it is only ever written when `Assets.car`
  compiles (confirmed from the real `create_info_plist` source, §3).
  `LSMinimumSystemVersion = "12.0"` unchanged. `CFBundleVersion` /
  `CFBundleShortVersionString` both `"4.0.0"`, unchanged.
  `LSUIElement = true` — Raff is a menu-bar/background utility with no
  persistent Dock presence by design, so "Dock appearance" for this app
  means the icon shown during the brief bounce on launch and in the
  ⌥-right-click "Open Recent"-style contexts, not a resident Dock tile.
- `codesign --verify --deep --strict`: **exit 0**, valid ad-hoc signature.
- DMG (`Raff_4.0.0_aarch64.dmg`): mounts cleanly; the app copy inside has
  the **byte-identical** `icon.icns`; the DMG's own volume icon
  (`bundle/dmg/icon.icns`) is also byte-identical to the app's.
- Updater artifact: `Raff.app.tar.gz` (4,671,810 bytes) was created
  successfully — only its detached signature failed to generate, for the
  pre-existing, documented reason above.
- The shipped `icon.icns` was extracted (`sips -s format png`) and visually
  confirmed to be the correct, current canonical Light construction
  (squircle corners, gradient, bevel highlight) — not a stale prior icon.
- `qlmanage -t` (Quick Look thumbnail generation, the same code path Finder
  uses) and `lsregister -f` both hung for >30s/>2min in this sandboxed
  session and were abandoned rather than force-killed into an
  unrepresentative result — a real limitation of this verification
  *environment*, not a finding about the icon. Direct extraction of the
  exact bytes Finder/Dock/Spotlight/Quick Look all read from
  (`CFBundleIconFile` → `icon.icns`) stands in as the verification instead.

**No claim of Dark Mode App Icon support is made** — none is active in the
shipped bundle. What is verified: the Light canonical icon ships correctly,
unchanged in every other respect, and the Dark mechanism is real, tested,
and one config line away from active once the `ibtoold` reliability issue is
no longer a live risk.
