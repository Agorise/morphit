# Morphit v1.1.1

A small patch release on top of **1.1.0** fixing two things people reported.

## Fixes

- **Expired orders now look right on their own page.** When one of your orders
  passes its expiry it disappears from the order book automatically — but if
  you opened that order's direct link it still showed a green "Live" tag, a
  confusing "Expires in Expiring now" tag, and a Cancel button. Now it clearly
  shows **Expired**, drops the countdown, and — if it's your order — offers a
  **Re-list** button that reopens the post form pre-filled from the old order
  (a fresh listing with a new expiry; nothing is silently re-signed).
- **The "Load it now" update prompt no longer asks twice on mobile.** After you
  tap it, if your phone was slow to switch over to the new version, the app now
  quietly finishes applying the update on the next load instead of asking you
  again.
