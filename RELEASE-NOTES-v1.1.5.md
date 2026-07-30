# Morphit v1.1.5

A patch release on top of **1.1.2** with more of the small UI fixes people
reported, a real fix for the duplicate update prompt on phones, and a smoother
login for older accounts. (1.1.3 and 1.1.4 were skipped to keep versioning
aligned across the deployment.)

## Fixes

- **The "Load it now" update prompt no longer shows twice on phones.** After a
  new version deployed, the prompt could appear, then reappear a moment later.
  The page now always loads a fresh copy of the app on reload, so a single tap
  lands the new version — no second prompt.
- **Your username fills in faster when signing in with a posting key.** Paste
  your key and the account name now appears right away, instead of waiting for
  you to click out of the field.
- **Older accounts fill their username automatically at login.** Accounts that
  predate the Blurt fork couldn't always be matched to their key automatically
  and had to type their name in. If you've used Morphit before, it now
  recognizes you and fills the name for you.
- **Order titles wrap less on phones.** Titles were bumping to extra lines even
  when there was room, which meant fewer orders on screen. They now use the
  full width and fit more cards per screen.
- **Fixed a stray gap on the wallet card.** There was an odd blank line between
  your BLURT balance and its value in your currency. It's gone.
- **The "expires" hover now reads plainly.** Hovering an order's expiry chip
  showed a raw machine timestamp; it now reads like "Order expires on
  4 August, 2026 @ 17:59:30 UTC," in your language.

## Under the hood

- Removed the temporary diagnostic logging added while chasing a few reported
  bugs.
- Added a database index that speeds up the account lookup performed at login.
