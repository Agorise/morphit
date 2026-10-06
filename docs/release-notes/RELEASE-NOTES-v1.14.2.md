# Morphit v1.14.2

**A bugfix + polish release. No new features, no database migration, no on-chain changes. Includes everything from v1.14.1.**

## Fixed

**The `morphit-ops` menu no longer moves "Upgrade" out from under your muscle memory.** In v1.14.0/v1.14.1 the new fast-sync entry was inserted as menu item 2, shifting "Upgrade to the latest version" to item 3 — so selecting option 2 during a release landed on fast-sync (which then refused, because the indexer was running). The order is restored to **Install (1) → Upgrade (2) → Fast-sync (3)**, matching the release ceremony's "choose option 2" and everyone's habit.

**The setup wizard now accepts dots in relay/fees account names.** Blurt account names can contain dots (e.g. `my.relay`), but the wizard's validation rejected them — it used a stricter rule than the rest of the software. It now matches Blurt's real account-name rules (lowercase letters, digits, dots, and dashes; each dot-separated part starting with a letter), so valid names like `my.relay` are accepted while malformed ones are still caught with a clear message.

## Changed

**Account and domain name suggestions no longer use "morphit".** The setup wizard, its fallback examples, and the docs previously suggested names like `my-morphit-relay`, `morphit.eth`, and `morphit.mydomain.org` for an operator's own relay/fees accounts and addresses. Those are now neutral, brand-your-own examples — operators should name their accounts and domains after **their own** instance, not the reserved "morphit" namespace. (The canonical protocol accounts `@morphit-fees` / `@morphit-relay` are unchanged — those are factual references, not suggestions.)

**The manual (non-BunkerWeb) nginx instructions match the single-domain reality.** The wizard's manual-nginx path used to hand operators three server blocks for a split relay/indexer/frontend subdomain layout that is no longer the design. It now installs a single `web.conf` that serves the frontend and reverse-proxies `/relay/`, `/v1/`, `/rss/`, and `/mcp` on one domain — which also means Morphit deploys cleanly on a **subdomain** (e.g. `trade.yourdomain.com`), verified end to end. The optional split-service configs remain for advanced operators, with neutral example hostnames instead of stale ones.

## Notes

- Upgrade in place; everything from v1.14.1 and earlier is included.
