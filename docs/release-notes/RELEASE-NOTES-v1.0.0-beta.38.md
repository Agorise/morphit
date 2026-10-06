# Morphit v1.0.0-beta.38

This release is about being honest and current. The competitor comparisons in our FAQ are
brought up to date with what actually happened over the last few weeks, we spell out that
Morphit ships with **zero code obfuscation** — every line that runs in your browser is
published and auditable — and a couple of order-form rough edges are smoothed out. For
operators, the health screen now shows each price feed individually, and there's an honest
note about optional hardware memory encryption.

As always, Morphit keeps no data about you, and there's no sign-up or ID check. If you're
already signed in, your account, keys, and balances carry over untouched. This release
changes no third-party dependencies.

## Honest comparisons, kept current

- **OpenMonero.** Our comparison no longer says OpenMonero is gone — it went briefly
  offline in early June 2026 and is back online now, saying it is "more secure this time."
  We explain why that doesn't change the core difference: OpenMonero holds your coins in a
  custodial wallet (which is what kept getting drained), while Morphit holds nothing at
  all, so there is nothing to harden and nothing to lose.
- **Haveno / RetoSwap.** We added the second exploit, on June 16, 2026 — this one in the
  forced-arbitration / dispute path, where an attacker forced a dispute and had Monero
  released without ever sending the Bitcoin. Two protocol-level exploits in under a month,
  both in the arbitration machinery. Morphit has no arbitrator and no escrow, so neither
  attack class has anything to target here.

## Transparency

- **Zero code obfuscation.** We now say it plainly on the brag list and the comparison
  image: Morphit's frontend is minified only for size, never to hide what it does. Every
  byte of the running system is published AGPL source you can read and audit — no compiled
  bytecode, no opaque packed archives. Combined with the on-chain hash of every release and
  Subresource Integrity on every script, you can verify exactly what your browser is
  running, independent of whoever is hosting it.

## Polish

- **Changing a currency on the order form.** Once you picked a price currency, tapping it
  again did nothing — the field looked stuck. Now tapping the currency reopens the picker
  so you can change it.
- **A clearer hover on text fields.** Text boxes and dropdowns now gently strengthen their
  border when you move the pointer over them, so it's obvious what you're about to click.
  Fields showing a validation error keep their red border on hover.

## For operators

- **Per-feed price health.** The health view (`morphit-ops`, option 13) now lists each
  price provider on its own line — whether it's up and the price it last reported — so a
  dead or stalled feed is obvious at a glance. This is operator-only; the public health
  endpoint still never reveals which of your feeds are up or down, preserving the opacity
  that makes the averaged price hard to skew.
- **Optional: hardware memory encryption (advanced).** OPERATIONS.md and the node guide now
  document confidential-computing hosts (AMD SEV-SNP / Intel TDX) as optional
  defense-in-depth for the one secret the relay keeps in memory — your posting key, never
  anyone's funds. It's opt-in, not a default: Morphit makes no secure-enclave claim and
  doesn't depend on it, and a TEE roots trust in the CPU vendor, which is in tension with
  our decentralization priority. Tor-by-default, the strict CSP, SRI, and the on-chain
  release manifest already cover the essentials.
