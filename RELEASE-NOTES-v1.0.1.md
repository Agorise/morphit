# Morphit v1.0.1

A maintenance release on top of **1.0.0** — display fixes, faster featured
orders, a fixed footer link, and a batch of operator-facing corrections.

## Orders

- **Featured orders on the home page** now show as full-width horizontal cards,
  matching the order book, instead of a squished portrait grid where a single
  order was crushed into a narrow column.
- When you **feature one of your orders**, the "Pay and feature" button now takes
  you straight to the order book, where your order shows up as featured within a
  few seconds — instead of the button appearing to do nothing while the network
  caught up.

## Fixes

- The **Canary** link in the site footer now opens `/canary.txt` correctly. It
  previously led to a "page not found" on a language-prefixed address.

## For operators

- **`morphit-ops upgrade`** now reminds you to re-upload your warrant canary
  after an upgrade. An upgrade rebuilds the served files, so the canary needs
  replacing afterward, or it would silently go stale and eventually warn your
  users for no reason.
- **`morphit-ops health`** now checks the canary where it is actually served, so
  a live, valid canary no longer shows as "missing."
- **Release tooling** is now consistent about size limits: the release manifest
  is checked against the real on-chain limit *before* you sign, so you can't
  build one that broadcasts but then gets rejected by the indexer. The signing
  prompt is also clearer about pasting your **private** posting key.
- **Documentation** for the warrant canary (now correctly describing the
  sign-on-your-own-machine model) and the release manifest has been corrected to
  match how the running system actually works.
