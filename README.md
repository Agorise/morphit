# Morphit

**A federated, non-custodial, no-KYC peer-to-peer marketplace for trading fiat against Bitcoin, Monero, BLURT, USDT, USDC, DAI, Bitcoin Cash, Litecoin, Dash, Dogecoin, Zcash, Pirate Chain, Decred, Solana, Ethereum, and Ripple.**

You hold your own keys. There are no deposits to make and no withdrawals to wait for; trades settle directly between counterparty wallets. There is no central server to subpoena and no central database to leak — the orderbook lives on a public blockchain, and any operator running a Morphit indexer sees the same data. If one operator goes dark, another's URL still works and the federation continues.

This repository carries the full source for the indexer, relay, frontend, operator CLI, and Matrix incident bot, plus the ops material (Ansible role, systemd units, env templates, runbooks) to stand up an instance on a fresh Ubuntu 24.04 VPS in roughly 30 minutes.

## Status

Approaching `v1.0.0-beta.1` (~2026-05-22). The canonical public instance is **morphit.io**; community operators are welcome to launch their own nodes alongside. There are no production deployments yet — the codebase has been through an intensive multi-month pre-launch hardening campaign documented in `docs/AUDIT-2026-05.md`.

## What this is, concretely

- **Federated orderbook.** Orders are signed by the user's posting key and broadcast as custom-JSON ops on the underlying chain. Every Morphit indexer in the federation reads the same chain and surfaces the same orderbook.
- **Non-custodial.** Trade settlement is wallet-to-wallet. There is no on-platform balance for an operator to mismanage. Listing fees are paid on-chain; the split is asymmetric and disclosed upfront: **BLURT-paid listing fees split 90/10 — 90% to the operator running the instance the order was posted through, 10% to the project treasury (`@morphit-fees`)**. **BTC- and XMR-paid listing fees go 100% to the project treasury** (the canonical morphit.io devs' wallets) — not to individual operators. This asymmetry is deliberate (BLURT splits atomically on-chain; BTC/XMR would require off-chain custodial bookkeeping that breaks the non-custodial design), and it's why operators earn from BLURT-paid fees only. Users pay 50% less when paying in BLURT, so BLURT-paid is where most volume — and operator revenue — naturally lands. Full mechanics: [`docs/FEES-AND-REWARDS.md`](docs/FEES-AND-REWARDS.md).
- **No KYC.** Signup is a cryptographic public key and a username. The system has no place to store an ID even if a regulator demanded one.
- **Privacy first.** No cookies, no analytics, no IP logging. XMR support hardens with subaddresses and per-payment view-key proofs (the operator's private view key never reaches the network). On every transparent chain Morphit trades (BTC, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP, BLURT, XMR), the address-share modal offers default-ON amount randomization and address-reuse warnings; BTC also gets optional PayJoin (BIP-78) endpoint propagation; DASH gets a wallet-side PrivateSend pre-mix workflow explained in the per-asset guide.  Stablecoin trades (USDT, USDC, DAI) get the same amount-randomization defense at 6-decimal precision (cp30 reversal of the cp26 USDT pass-through decision — Circle/Tether freeze power is a separate, independently-real threat documented in each per-asset privacy guide). Per-asset privacy guides live at `/[lang]/privacy/{asset}`.
- **Encrypted chat.** Per-message ECIES (X25519 + ChaCha20-Poly1305-IETF) with sender ephemerals, stored on-chain as ciphertext — see `docs/adr/0015-chat-crypto.md`.
- **Reach.** Public hostname, Tor `.onion`, I2P `.b32`, Lokinet, and Nostr-relay channels are all first-class operator-config surfaces.

For the long version, every claim is enumerated and source-anchored in [`MORPHIT-BRAG-LIST.md`](MORPHIT-BRAG-LIST.md).

## Repo layout

| Directory | What's in it |
|---|---|
| `apps/web/` | SvelteKit frontend, fully prerendered per locale (10 locales × dozens of indexable routes; the canonical list of routes is whatever `apps/web/src/routes/[lang]/**/+page.svelte` enumerates at build time) |
| `apps/indexer/` | Reads Blurt blocks, materializes orderbook + chat + reputation, exposes `/v1/*` HTTP API |
| `apps/relay/` | Holds the operator's relay posting key; signup broadcasts, welcome-bonus payouts, ACT minting, Web Push delivery |
| `apps/ops-cli/` | `morphit-ops init / edit / upgrade` — operator setup wizard and release apply tool |
| `apps/matrix-bot/` | Optional Matrix incident-pager bot for operators who want push-to-phone alerting |
| `packages/` | Shared TypeScript packages: `asset-registry`, `indexer-client`, `relay-client`, `operator-config`, `release-schema`, `net-defense`, `rpc-pool` |
| `docs/` | ADRs (`docs/adr/0001-…` through `0046-…`), audit logs, operator runbooks |
| `ops/` | Ansible role, systemd units, env templates, nginx/Caddy snippets, postgres init |
| `scripts/` | Build, smoke, mediakit, sitemap, llms.txt, and ceremony helpers |

## Running an instance

The complete walkthrough is in **[`docs/RUN-A-MORPHIT-NODE.md`](docs/RUN-A-MORPHIT-NODE.md)**. The short version:

1. Provision a $5/mo Ubuntu 24.04 VPS with Postgres reachable.
2. `git clone` this repo (or extract a signed release tarball — see `docs/UPGRADING.md`).
3. `npm ci` from the repo root (workspace install — must be run from the root).
4. `npx morphit-ops init` to walk the setup wizard (~20 prompts; configures treasury addresses, fee targets, explorer URLs, operator tag, VAPID keys for Web Push).
5. `bash scripts/run-smokes.sh` to confirm the self-checks (~150 runners, several thousand scenarios) pass against your environment.
6. Follow **[`docs/PRE-LAUNCH-CHECKLIST.md`](docs/PRE-LAUNCH-CHECKLIST.md)** and **[`docs/LAUNCH-DAY.md`](docs/LAUNCH-DAY.md)** before opening to traffic.

## For developers

- Architecture overview: `docs/ARCHITECTURE.md`
- API reference: `docs/API.md`
- ADR index: `docs/adr/0001-…` through `docs/adr/0046-…`
- Audit log: `docs/AUDIT-2026-05.md`
- Per-language translation guide: `docs/CONTRIBUTING-TRANSLATIONS.md`
- Adding a workspace (apps/* or packages/*): `docs/ADDING-A-WORKSPACE.md`
- Adding a tradable coin: `docs/ADDING-A-COIN.md`
- Locale graduation (PLANNED → SUPPORTED): `docs/LOCALE-GRADUATION.md`

The smoke suite is the source of truth for behavior:

```
bash scripts/run-smokes.sh
```

Triple-pulse it (run three times back-to-back) to filter flakes before submitting changes.

## Reporting bugs

Use Forgejo's New Issue form — the bug-report template auto-loads and walks you through the fields we need. **Security-sensitive issues** (anything involving keys, funds, fee bypass, or leaked private data) go to the operator's Matrix DM channel listed in §16 of the form — do NOT post them as a public issue or in the community chat room.

Offline alternative: `docs/NEW-ISSUE-FOUND.md` (plain Markdown copy of the bug-report fields you can email).

## Community

- **Matrix room (public):** [`#agorise:matrix.org`](https://matrix.to/#/#agorise:matrix.org) — for questions, announcements, "is this a known bug?"
- **Security disclosures (private):** `@agorise:matrix.org` direct message (E2EE) — see `docs/SECURITY.md`.

## License

AGPL-3.0-only. Every operator running a modified instance must make their source available to their users. See [`LICENSE`](LICENSE).

---

*Don't trust the project's marketing — verify it. Every claim in `MORPHIT-BRAG-LIST.md` points at code, an ADR, or a smoke that proves it. If you find one that doesn't, open an issue.*
