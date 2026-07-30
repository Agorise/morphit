# Morphit v1.0.0

This is Morphit's **1.0.0** release. It carries everything from the beta series
plus a final batch of fixes and refinements from beta testing.

## Wallet

- Your BLURT balance now shows its approximate value in **your** chosen currency
  — the one you set in Settings — formatted for your language. If you use euros,
  you'll see something like `~5,67 € eur` instead of a dollar figure.
- The **Blurt Power** number on your wallet no longer keeps flashing after it
  has settled. It highlights briefly when it changes, then stays calm.

## Orders

- An **expired listing** on **My Orders** no longer shows a red "visible in the
  order book" state with a broken help link. It now reads plainly as "Not
  visible in order book," and its **Re-list** button is sized correctly.
- Your **profile** no longer lists an expired order under "Active orders."
- The **Featured** panel no longer says "No featured-slot bids yet — be the
  first" when one of your featured orders is already live in the panel above it.
  When a featured order is live, it shows a neutral note about price history
  instead.

## Smaller touches

- A posted time now reads "Posted 5d **ago**" rather than "Posted 5d."
- On phones, the **seed-backup reminder** lays out cleanly instead of squeezing
  into a narrow column.
- The Barter listing's Terms field highlights a little longer, so the
  Markdown hint is easier to notice.

## Accuracy

- The **Featured-slot** help now correctly describes **3** promoted slots (it had
  briefly said 5), including what happens when you're outbid.
- The API reference and the machine-readable site index used by AI assistants
  were brought in line with the current list of tradable assets, including
  **barter** (goods and services).

## For operators

There are no new database migrations in this release. As always, take a database
snapshot before upgrading.
