# Morphit v1.0.0-beta.8

A front-end, feeds, and operator-tooling release on top of beta.7.
Every orderbook feed now comes in three formats — RSS 2.0, Atom, and
JSON Feed — so any reader works, and one click on the orange RSS pill
copies the feed's URL in whichever format you prefer. The home page
and orderbook get a round of polish, operators running Linux Mint can
now provision a node, and the ops CLI restarts the affected services
for you after a config change. Recommended for all operators.

## Added

- **Every feed now speaks three formats — RSS 2.0, Atom, and JSON
  Feed.** The worldwide, per-asset, and per-trader orderbook feeds are
  each available as `.xml` (RSS 2.0), `.atom` (Atom 1.0), and `.json`
  (JSON Feed 1.1), all carrying identical order data — pick whichever
  your reader prefers. Click any orange RSS pill — in the site footer,
  beside a filtered orderbook, or on a trader's profile — to choose a
  format and copy its URL to your clipboard. The picker and its
  confirmation are translated into all ten languages. See the "Can I
  follow Morphit with RSS?" entry in the FAQ.

- **The ops CLI restarts the affected services after a change.** After
  you edit your instance configuration or wire alternative-network
  (Tor / Lokinet / I2P) footer addresses, `morphit-ops` now offers to
  restart the affected services for you, so the change takes effect
  without having to remember the `systemctl` incantation. Declining
  leaves everything untouched.

- **Linux Mint is a supported node OS.** The Ansible provisioning
  playbook now recognises Mint and other Ubuntu *noble* derivatives
  and provisions them correctly, rather than only bare Ubuntu. See
  `RUN-A-MORPHIT-NODE.md`.

## Changed

- **A more polished home page and orderbook.** "Products" are now
  called "goods" throughout, the home-page hero copy is tightened,
  "global" is now "worldwide," the home-page cards share an even
  height, and the wordmark's entrance animation has been retired in
  favour of a subtle header shine. On the orderbook, the filter
  dropdowns close cleanly the moment you pick an option. Updated in
  all ten languages.

- **The create-order form is easier to follow.** The asset, currency,
  and payment fields now show a green focus ring as you tab through
  them — matching the region and "I want to see" fields — and the
  region field types out real place names one character at a time as a
  gentle hint (and stays still if you've asked your system to reduce
  motion).

- **A refreshed batch of FAQ answers** for clarity and accuracy,
  across all ten languages.

## Fixed

- **The per-trader feed link now points to the trader's profile.** The
  "follow this trader" subscribe link advertised a homepage URL that
  no longer exists; the feed now links to the trader's `/@handle` page,
  the same canonical profile URL used everywhere else on the site.
