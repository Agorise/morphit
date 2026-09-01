# Morphit v1.15.0

**Headline: the orderbook now speaks your language. Plus a rollup of installer, UX, and hardening fixes.**

## Added

**Per-order language + an orderbook language filter.** A first visit to a busy instance no longer means scrolling past orders in languages you don't read. You tell Morphit which languages you understand, and the orderbook shows you orders written in those — nothing is translated, it's simply filtered.

- **Tag your post's language.** The order form (new and edit) has a "This post is in …" selector under "Listing expires," defaulted to your last-used post language → your primary preferred language → the language the site is set to. The choice rides along in the order's on-chain broadcast.
- **Set your preferred languages.** A new "Preferred languages" card in Settings lets you pick a primary (the default for your own posts) plus any other languages you read. It's saved to your on-chain profile, so it follows you across devices.
- **Filter the orderbook.** A searchable "Language" field (green removable pills, next to "Payment methods accepted") defaults to your preferred set — or, for a first-time visitor, just the language the site is in. Clear it to see every language.
- **Nothing disappears.** Orders posted before this release carry no language tag, and the filter never hides an untagged order — it only ever hides orders that *declared* a different language. The orderbook fills in over time as new orders carry a language.

## Changed / Fixed (rollup)

- **`morphit-ops` menu order restored** — "Upgrade to the latest version" is option 2 again (a fast-sync entry had shifted it to 3), matching the release ceremony and muscle memory.
- **Account names accept dots** — the setup wizard now allows Blurt-valid names like `my.relay` (it had been stricter than the rest of the software).
- **No more "morphit" in name suggestions** — the wizard, its fallbacks, and the docs now suggest brand-your-own names for relay/fees accounts and addresses instead of the reserved `morphit` namespace.
- **Single-domain nginx reality** — the manual (non-BunkerWeb) install path installs one `web.conf` that path-routes everything on one domain; Morphit deploys cleanly on a subdomain.
- **RPC endpoints card tells the truth on refresh** — a node you shut down now shows "offline at the moment" instead of a stale latency (a failed probe is retried once; only a genuine double-miss reads as down).
- **A self-healing installer** — pre-flight checks for port/subnet/localhost conflicts, honest errors when Ansible can't run (instead of a misleading "0 hosts"), consented one-keystroke fixes for what's safely fixable, and a final report of everything fixed/skipped. `agorise@pm.me` / `@agorise:matrix.org` appear only as a genuine last resort.
- **fail2ban `ignoreip`** baked into the standard hardening so an admin can't lock themselves out mid-release.

## Notes

- No database migration is required beyond the automatic additive `orders.lang` column (schema v56); no breaking on-chain changes — the new order/profile fields are optional and backward-compatible.
- Everything from v1.14.2 and earlier is included.
