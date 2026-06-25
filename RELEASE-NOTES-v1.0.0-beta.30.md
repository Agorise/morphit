# Morphit v1.0.0-beta.30

This release fixes an important sign-in reliability problem, adds a short bio to your
profile, tidies up the settings and sign-up screens, makes the navigation arrows
easier to see, and gives operators a new decentralized address option plus a fix for
a crash in the node-management tool.

Nothing here changes how trading works, what anything costs, or what data Morphit
keeps (still none of it). If you're already signed in, your account, keys, and
balances carry over untouched — and thanks to the fix below, staying signed in is now
more reliable.

## Staying signed in

- **Refreshing the page no longer signs you out.** If you chose to be remembered on
  this device, a normal page refresh could quietly drop you back to the import
  screen, as if you'd never saved your keys. That's fixed: refreshing the page,
  closing a tab, or locking one tab now leaves your saved keys in place, and only a
  real sign out clears them. Signing out in one tab still signs you out of the
  others, as before.

## Your profile and settings

- **New: a short bio.** You can add an optional short bio (up to 128 characters) to
  your profile from Settings. It appears under your name on your profile page. Like
  your display name, you can save it on this device only or broadcast it so other
  instances see it.

- **Clearer save buttons.** The two profile-save buttons are now labelled
  "Save locally only" and "Save & broadcast", with a one-line explanation of each
  above them, so it's obvious which one keeps a change on your device and which one
  publishes it.

- **A tidier settings screen.** The avatar card moved up next to your account name,
  some wordy explanations were trimmed, and the auto-lock timer now shows a brief
  "Changed to …" confirmation when you pick a new value.

## Signing up

- **A progress bar.** New accounts now see a simple "Step X of Y" progress bar during
  sign-up, so you can tell how far along you are. (If you're importing an existing
  account, you won't see it — that path is a single step.)

## Getting around

- **Bigger, clearer navigation arrows.** The small back and forward arrows around the
  app are now larger and easier to see, and they match the colour and size of the
  text next to them. They also point the correct way in right-to-left languages.

- **Consistent back links.** The "back" links at the top of the block explorer,
  privacy, and two-factor pages now all use the same clear styling instead of three
  different colours.

## Two-factor settings

- **A clearer two-factor page.** The authenticator-app two-factor settings page got a
  visual tidy-up — its expandable sections are easier to spot, the recommended and
  not-recommended app lists are alphabetised, and the headings are clearer. (How
  two-factor works is unchanged.)

## For operators

- **A new decentralized address option: ENS (`.eth`).** Your instance can now
  advertise an ENS `.eth` name alongside its Tor, i2p, and Lokinet addresses. It
  appears in the footer and on the instances page and links to the bare name
  (e.g. `morphit.eth`), which ENS-aware browsers resolve directly — no
  centralized gateway — giving visitors another censorship-resistant way to
  reach your node. Set it from the init wizard or the `morphit-ops alt-address`
  command; it's a display-only pointer, so there's no key to manage.

- **Fixed: the `morphit-ops` menu could crash after an upgrade.** If you ran
  `morphit-ops` from a directory that had been replaced during an upgrade, choosing
  most menu items (edit settings, alternate addresses, status, and so on) would crash
  with a `uv_cwd` error. The tool now recovers cleanly and works regardless of which
  directory you launch it from.

- As with recent betas, **this release changes no third-party dependencies.**

## Under the hood

- **A fresh, independent code review** of the recent changes re-ran the full test and
  type-checking suite from a clean slate and confirmed everything passes, with the
  sign-in fix above pinned by an automated regression test so it can't quietly return.
  A few internal code comments were also brought back in line with how the sign-in
  code now actually behaves.
