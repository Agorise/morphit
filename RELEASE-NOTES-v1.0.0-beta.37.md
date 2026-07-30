# Morphit v1.0.0-beta.37

This release leans into privacy. Every Morphit instance is now reachable over **Tor by
default** — operators no longer have to set anything up, and Tor Browser is offered the
`.onion` automatically. Prices are now averaged across **many independent market feeds**
instead of leaning on one, so no single source can break or skew them. The order pages
get more polish, the app loads a little lighter, and setting up your own instance is
friendlier than ever.

As always, Morphit keeps no data about you, and there's no sign-up or ID check. If you're
already signed in, your account, keys, and balances carry over untouched.

## Privacy

- **Reachable over Tor, automatically.** Every instance now generates and serves its own
  Tor `.onion` address as part of setup — no extra steps, no key-grinding. When you visit
  over Tor Browser, the site advertises its onion (via an `Onion-Location` header) so the
  browser can offer you the `.onion` without you doing anything. VPN, Tor, Lokinet, and
  I2P access were always welcome here; now the onion is on by default, not an afterthought.

## Prices you can trust

- **Many feeds, averaged.** Instead of relying on a single price source, Morphit now
  gathers prices from several independent feeds and takes the middle (median) value, with
  outliers dropped. If any one feed is down, wrong, or rate-limited, it simply drops out
  of the average — it can never skew or break the price. The price is still only ever used
  to work out amounts for you; it is never treated as a source of truth for anything else.

## Placing and editing orders

- **A more polished order form.** Number fields highlight in red the moment something's
  out of range (rather than a confusing mix of colors), the terms box shows a live
  character count as you approach the limit, and the payment-method picker has consistent
  hover highlights throughout. Barter listings explain what to describe more clearly.
- **Lighter, faster pages.** The order and sign-up pages now load their heavier pieces
  only when you actually reach them, so the first paint is quicker.

## A few nice touches

- **Profile pages** show the Nostr and Blurt.media links neatly stacked at the corner of
  the avatar.
- **Settings** — the "Set up two-factor authentication" button now has a clear, visible
  hover so it's obvious it's a link.
- As with recent betas, **this release changes no third-party dependencies.**

## For operators

- **A Tor onion is generated for you.** The setup wizard creates a `.onion` in the
  background while you answer the other questions — instant, no waiting, no vanity
  grinding. It never overwrites an address you set yourself, and a matching Tor role in
  the shipped Ansible playbook serves it. (A custom vanity onion is still a manual step
  if you want one.)
- **Hardening, by default and hand-held.** The wizard now walks you through securing your
  server — SSH lockdown, firewall + fail2ban, automatic security updates, kernel
  hardening, and intrusion detection — as a short run of "yes" confirmations, and the
  Ansible hardening role applies all of it for you. Your server is locked down on the
  default path, not as an afterthought.
- **Setup remembers where you left off.** If you get interrupted partway through the
  wizard, run it again and it offers to pick up where you stopped — re-asking only the two
  things it never writes to disk (your database connection and your relay's active key).
- **More resilient pricing.** Your instance's fees and floors stay aligned with the
  market using the same multi-feed median, so a single feed outage doesn't knock anything
  over.

## Housekeeping

- A large internal audit pass, a leaner "Run a Morphit node" guide, and tidied-up
  translations across all ten languages. These are behind-the-scenes; nothing you do
  changes.
