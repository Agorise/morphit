# Morphit v1.0.0-beta.45

A usability and correctness release on top of beta.44. The headline is a
much simpler sign-in for people who bring an existing Blurt account: the
posting-key import no longer asks you to type your username — Morphit
detects it from your key. Alongside that, order terms now support light
formatting, there's a public network-statistics page, operators can
auto-generate an I2P address for their node, and a confusing listing-fee
error is fixed. The rest is chat, post-page, and onboarding polish.
**Recommended for all operators.**

## Added

- **A public network-statistics page.** A new `/v1/stats` endpoint and a
  human-readable stats page (linked from the footer) show network-wide
  numbers at a glance, with a link to the raw JSON for anyone who wants
  it. Times are shown in 24-hour UTC, consistent with the rest of the
  site.

- **One-click I2P for your node.** Operators can now auto-generate an
  I2P `b32.i2p` destination for their instance as part of setup, making
  it easier to run Morphit as a censorship-resistant hidden service. The
  Ansible role and the run-a-node docs cover the new option.

- **Formatting in listing terms.** When you write the terms of an order
  you can now use a small set of Markdown — headings, **bold**,
  *italics*, bulleted and numbered lists, and horizontal rules — and it
  renders cleanly on the order page. On the compact browse cards the
  formatting is stripped to a single tidy line so the list stays scannable.
  (Terms remain safe to display: the formatting is rendered without ever
  turning attacker-supplied text into live code or clickable links beyond
  the existing Blurt image-link support.)

## Changed

- **Signing in with a posting key is simpler.** You no longer type your
  Blurt account name — Morphit detects it automatically from the key you
  paste. The explanation on that screen is also clearer about what a
  posting-key login does: you can read, post, and trade with others, but
  you won't get the discounted Blurt listing-fee rate (paying the fee in
  Blurt needs your active key, which a posting-key login doesn't carry —
  pay in BTC/XMR, or sign in with your 12-word seed or Keyfile instead).

- **The listing-fee step is clearer when you pay in Blurt.** Paying the
  fee in Blurt is a signed transfer that needs your active key, so the
  post page now says so plainly, disables the Blurt option (with a short
  explanation) when you're signed in with a posting-key-only session, and
  keeps a summary of the order you're about to sign visible on the
  password, posting, and error steps rather than showing a bare password
  box.

- **The "posted by" card on an order now matches the orderbook cards.**
  The poster's avatar, name, reputation, and trade count are shown
  identically wherever you see them, so an order page and its card look
  consistent.

- **Chat action buttons only appear when there's a trade to act on.** The
  pay-now, share-address, and shipment buttons no longer show up in a
  plain message opened from someone's profile — they appear only when the
  conversation is tied to a live order, and they follow which side of the
  trade you're on.

- **Clearer FAQ.** The "How do I buy crypto?" and "Can I trade goods and
  services?" answers were rewritten with concrete step-by-step examples,
  including trading physical goods and services for crypto.

- **Onboarding and interface polish.** Friendlier, plain-language titles
  on the funds-sent and pay-in-Blurt dialogs; better contrast on chat
  message bubbles; refined buttons on the settings screen; a short hover
  delay on the asset tooltips so they don't flicker as you move across
  the grid; a Clear button on the short-bio field; and proper app icons
  for installing Morphit to a phone home screen.

## Fixed

- **A misleading "couldn't broadcast" error when posting.** If you tried
  to pay the listing fee in Blurt from a posting-key-only session, the
  page used to report that the blockchain rejected your post — when in
  fact the post never left your device, because that session has no
  active key to sign the fee transfer. The message now explains the real
  cause and points you to a fee method that works.

---

*This is a beta release, published to the project's Forgejo instance at
[git.agorise.net/agorise/morphit](https://git.agorise.net/agorise/morphit).
Morphit is AGPL-3.0 and non-custodial: it never holds or moves your
funds, and all signing happens in your browser.*
