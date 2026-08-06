# Morphit v1.8.11

This release is almost entirely about one thing: **signing out of one account and into another now actually gives you a clean slate.** Several separate faults all pointed the same way, and together they meant a second account on the same browser could inherit the first one's settings.

## Your settings no longer follow the wrong person

Sign out of one account, sign into another, open Settings — and you could be looking at the previous account's values. There were two causes, and both are fixed.

**Sign out kept too much.** It cleared your keys, your paired-device marker and your account name, and stopped there. Your display name, bio, links, chat peers, pinned conversations, unsent drafts and preferences all stayed behind. Most were stored per-account so the next person couldn't read them, but not all: your currency and region were kept under a single shared key, so they carried over outright.

Sign out now forgets everything that belongs to *you* and keeps only what belongs to *this browser* — your language, your auto-lock timing, your chosen nodes. It's built as a list of what to keep rather than a list of what to clear, so anything added later is forgotten by default instead of surviving until someone remembers it.

**And the Settings page could look up the wrong account.** It worked out which account's drafts to show once, when the page first opened. Sign out and back in without reloading and that answer was never revised, so the page kept reading the previous account's. It now re-checks whenever you sign in or out.

## Settings that belong to you now follow you

Morphit already backed up your notification preferences, hidden accounts, privacy toggles and currency/region to the chain, encrypted so the operator only ever stores an opaque blob. But restoring only ever *applied* what it found — so an account that had never saved any settings restored nothing, and simply kept whatever the previous account had left behind.

Settings now reset to their defaults before your own are applied. "Nothing saved yet" means factory defaults, never "inherit the last person". Your syndication choices have joined the backup too, so they follow you to a new browser like everything else — and, like the other publishing options, they start switched off for a new account rather than inheriting a choice you never made.

## You can now see what's public and what isn't

The Settings page writes to two different places and never said which was which. Your display name, avatar, bio and links go to a **public, permanent** record on the blockchain that anyone can read — that's the point, it's how a trading partner recognises you. Your notification settings, hidden accounts and region go somewhere else entirely, **encrypted** before they leave your device.

Every section now says which it is, in plain words, before you press anything.

## Fixes

- **The header button now always matches your state.** Locking shows "Unlock"; signing out shows "Start". Signing out while already locked used to leave it stuck on "Unlock".
- **Your avatar shows up straight away.** After signing in on a new browser, the menu could sit on a placeholder while your profile page showed your real picture on the same screen — and then correct itself minutes later. Morphit was treating "not published yet" as "there is no picture"; publishing takes about a minute to become visible, so it now waits and checks again. Removing your avatar still takes effect instantly.
- **Signing out no longer leaves your picture in other tabs.** The tab you signed out from cleared it; the others didn't.
- **Your public key shows on every order card.** It was appearing on the order page but not always on the card, depending on whether a background job had caught up yet. All three places that show it now agree. The key is what proves an account is really yours, so "usually visible" wasn't good enough.
- **Reviews that don't count now say so.** A profile could state "this user has not been reviewed by any counterparty" directly above visible reviews. If every review is excluded from the score, the page now explains that instead of denying they exist.

## For people running a node

Nothing to do. No database changes, no configuration changes, and nothing about how your instance runs is affected — this release is entirely browser-side.

Your data, your keys, your trades — all untouched throughout.
