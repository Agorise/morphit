# Morphit v1.12.16

**Theme: attack-resilience hardening — tighter edge limits, faster slow-drip shedding, and a one-page incident runbook.**

## Hardened

**Per-IP concurrent-connection cap at the edge.** Every public vhost (relay, indexer, web) now caps simultaneous connections per client IP (`limit_conn`), so a single host can't exhaust connection slots even while staying under the request-rate limits. The cap is set generously so shared IPs (carrier-grade NAT, Tor exits) aren't affected.

**Slow-drip (slowloris) timeouts on all vhosts.** The indexer and web vhosts now apply the same tight `client_body`/`client_header`/`send` timeouts the relay already used, instead of falling back to nginx's longer defaults — slow-header/slow-body connections are dropped quickly.

## Added

**Operator incident runbook (`docs/INCIDENT-RUNBOOK.md`).** A single-page, top-to-bottom playbook for responding to an active attack, with exact reversible commands: halt signups instantly via the runtime kill switch (no restart), watch the balance/ceiling and price-disagreement alerts, ban abusive IPs/ASNs at the edge, and disclose privately. Consolidates controls that already existed into one sheet you can act on in seconds.

## Changed

**FAQ wording.** The "What is Morphit?" answer now describes Morphit as a *decentralised/distributed bulletin board service (DBBS)* rather than a plain bulletin board service (BBS), across all supported locales.

## Notes

- No database migration in this release.
- The edge-config changes ship in `ops/nginx/*.conf`; apply them on the host with `sudo nginx -t && sudo systemctl reload nginx`.
- Everything from v1.12.15 and earlier (the federation brand↔relay display fix, the relay/indexer security hardening, the block-explorer op labels, and the CI supply-chain gate) is included.
