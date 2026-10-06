# Morphit v1.0.0-beta.22

A sign-in, session, and polish release. The headline is that your session now
follows you across browser tabs: open a Morphit link in a new tab — or reload
one tab while others stay open — and you no longer have to sign in again, with no
keys ever written to disk. And when you sign out, you now sign out of every open
tab at once. On top of that, signing in got more helpful as you type, your avatar
now matches your public profile everywhere, two broken account links are fixed,
and a handful of smaller annoyances are cleaned up.

For operators: there's nothing required beyond deploying this build. Everything
in this release is on the visitor side — there are no configuration, service, or
command changes since beta.21.

## New

- **Stay signed in across your open tabs.** If you already have Morphit open and
  unlocked in one tab, opening a link in a new tab (or reloading another tab)
  picks up your session automatically — no second sign-in, not even a password
  prompt. Your keys are handed from tab to tab in memory only; they are never
  written to disk and they disappear the moment your last Morphit tab closes.
  This is separate from "Remember me," which remains the opt-in for surviving a
  full browser close.
- **Sign out everywhere at once.** Signing out in one tab now also signs you out
  of every other open Morphit tab, so an explicit sign-out leaves no session
  lingering elsewhere. Closing a single tab, or letting a tab auto-lock after
  idling, does *not* sign out your other tabs — only an explicit Sign Out does.

## Fixed

- **Account links in the block explorer and your orders now work.** A couple of
  links to an account's explorer page were showing a literal placeholder instead
  of the account name and led nowhere. Both now go to the right place.
- **No more phantom "Draft restored" message on a fresh New Post.** Arriving at
  the New Post page from a prompt (for example the welcome flow, or a re-list)
  could later pop up a "draft restored" banner for a draft you never wrote.
  Pre-filled visits no longer save a stray draft, so the banner only appears for
  a draft you actually started.
- **"Back up my keys" handles posting-key sign-ins correctly.** If you signed in
  with only a posting key, the page no longer offers a 12-word seed-phrase backup
  that doesn't apply to you; it shows the right note and keeps your encrypted
  keyfile backup.

## Improved

- **"Remember me on this device" now works however you sign in.** Previously only
  a seed-phrase sign-in could be remembered; signing in with a JSON keyfile or a
  posting key is now offered the same choice. It stays unchecked by default, so
  nothing is saved to your device unless you ask for it.
- **Your avatar now matches your profile everywhere.** The little identicon next
  to your name is now drawn from your account name consistently — so the avatar
  in the top-right menu matches the one on your public profile, in the order
  book, in chat, and everywhere else you appear.
- **The sign-in boxes check your input as you type.** The account-name box
  re-checks whenever you edit it and turns red with a clear "invalid" marker if
  the name can't exist or isn't found on Blurt; the posting-key box flags an
  obviously-wrong key (wrong length or prefix) the moment you paste it. A
  connection problem never shows a false red — that isn't your fault.
- **Clearer wording in a few places.** The welcome / first-trade card explains
  more plainly what your first trade gets you, and several labels and notes
  around saving links and keys were tightened. The "blurt.media" link box also
  now catches a mistyped address that used to slip through.
- **Small polish.** The square cards on your Orders page lift on hover and press
  in on click like the rest of the site, and rows with a checkbox or radio button
  now show a subtle highlight when you hover them.

## Under the hood

- **Regression guards for the cross-tab session work.** New automated checks pin
  the cross-tab sign-out so it propagates to sibling tabs, and — just as
  importantly — verify the safety rule that closing a tab or an idle auto-lock
  never signs you out of your other tabs. Closing this gap is what the release's
  cross-tab sign-out is about.
- **Regression guards for the sign-in validation.** The new live checks on the
  account-name and posting-key boxes are pinned so a future edit can't quietly
  undo them.
- **Translation upkeep.** Every new and reworded piece of on-screen text ships in
  all ten languages.
