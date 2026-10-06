# Morphit

**A federated, non-custodial, no-KYC peer-to-peer marketplace for trading fiat against Bitcoin, Monero, BLURT, USDT, USDC, DAI, Bitcoin Cash, Litecoin, Dash, Dogecoin, Zcash, Pirate Chain, Decred, Solana, Ethereum, and Ripple.**

You hold your own keys. There are no deposits to make and no withdrawals to wait for; trades settle directly between counterparty wallets. There is no central server to subpoena and no central database to leak — the orderbook lives on a public blockchain, and any operator running a Morphit indexer sees the same data. If one operator goes dark, another's URL still works and the federation continues.

This repository carries the full source for the indexer, relay, frontend, operator CLI, Matrix incident bot, and MCP server, plus the ops material (Ansible role, systemd units, env templates, runbooks) to stand up an instance on a fresh Ubuntu 24.04 machine with one guided install.

## Status

Live. The canonical public instance is **morphit.io** (clearnet, Tor and I2P); other instances run alongside it, including zero-clearnet ones (Tor and I2P only), and community operators are welcome to launch their own. Releases are signed, published on Forgejo and anchored on-chain; the release notes for each version are the `RELEASE-NOTES-v*.md` files in [`docs/release-notes/`](docs/release-notes/). The current threat model is in `docs/audit/2026-10-*.md` (STRIDE matrix, attack tree, red-team narrative).

## New here? Start here 👇

If you want to **run a Morphit node** (or upgrade one, or fix
something), don't read this whole file — go straight to the
plain-language navigation hub, which tells you exactly which guide
to open for what you want to do:

> ### 👉 [`docs/start-here/`](docs/start-here/README.md)

The two commands you'll use most, on your server:
`sudo morphit-ops` (opens a menu of everything) and
`sudo morphit-ops upgrade` (updates to the latest version). The
rest of *this* README is a technical overview for people
evaluating or building the software.

## What this is, concretely

- **Federated orderbook.** Orders are signed by the user's posting key and broadcast as custom-JSON ops on the underlying chain. Every Morphit indexer in the federation reads the same chain and surfaces the same orderbook.
- **Barter, too.** A listing isn't limited to cryptocurrency — it can offer goods or services ("barter"), priced in the seller's local currency and settled in a cryptocurrency the seller chooses to accept. The goods change hands off-platform; Morphit never touches them or the payment.
- **Non-custodial.** Trade settlement is wallet-to-wallet. There is no on-platform balance for an operator to mismanage. Listing fees are paid on-chain; the split is asymmetric and disclosed upfront: **BLURT-paid listing fees split 90/10 — 90% to the operator running the instance the order was posted through, 10% to the project treasury (`@morphit-fees`)**. **BTC- and XMR-paid listing fees go 100% to the project treasury** (the canonical morphit.io devs' wallets) — not to individual operators. This asymmetry is deliberate (BLURT splits atomically on-chain; BTC/XMR would require off-chain custodial bookkeeping that breaks the non-custodial design), and it's why operators earn from BLURT-paid fees only. Users pay 50% less when paying in BLURT, so BLURT-paid is where most volume — and operator revenue — naturally lands. Full mechanics: [`docs/FEES-AND-REWARDS.md`](docs/FEES-AND-REWARDS.md).
- **No KYC.** Signup is a cryptographic public key and a username. The system has no place to store an ID even if a regulator demanded one.
- **Privacy first.** No cookies, no analytics, no access logs: the servers see a visitor's IP like any web server and keep it in memory only, for rate limiting (at most 24 hours), never on disk. The browser's one request to a third party is a daily release check: two requests to one public Blurt RPC node (browsers may add a CORS preflight before each), and a second node only if the first fails, serves a record that does not verify, or names a version other than the one the site runs ([FAQ](https://morphit.io/en/faq) "Can a Blurt node see my IP?"). XMR fees are proven per payment with the payer's tx key (no view key anywhere). On every chain Morphit trades (BTC, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP, BLURT, XMR), the address-share modal offers default-ON amount randomization and address-reuse warnings; BTC also gets optional PayJoin (BIP-78) endpoint propagation; DASH gets a wallet-side PrivateSend pre-mix workflow explained in the per-asset guide.  Stablecoin trades (USDT, USDC, DAI) get the same amount-randomization defense at 6-decimal precision (Circle/Tether freeze power is a separate threat, documented in each per-asset privacy guide). Per-asset privacy guides live at `/[lang]/privacy/{asset}`.
- **Encrypted chat.** X25519 + ChaCha20-Poly1305-IETF with a fresh sender ephemeral per message and sender authentication, stored on-chain as ciphertext; no forward secrecy, and who-talks-to-whom is public — see `docs/CHAT-CRYPTO.md` and `docs/METADATA-LEAK-CATALOG.md`.
- **Reach.** Public hostname, Tor `.onion`, I2P `.b32`, Lokinet, and Nostr-relay channels are all first-class operator-config surfaces.

For the long version, every claim is enumerated and source-anchored in [`docs/MORPHIT-BRAG-LIST.md`](docs/MORPHIT-BRAG-LIST.md).

## Repo layout

| Directory | What's in it |
|---|---|
| `apps/web/` | SvelteKit frontend, fully prerendered per locale (10 locales × dozens of indexable routes; the canonical list of routes is whatever `apps/web/src/routes/[lang]/**/+page.svelte` enumerates at build time) |
| `apps/indexer/` | Reads Blurt blocks, materializes orderbook + chat + reputation, exposes `/v1/*` HTTP API |
| `apps/relay/` | Holds the operator's relay active key; signup broadcasts, welcome-bonus payouts, Web Push delivery |
| `apps/ops-cli/` | `morphit-ops` — the operator tool: guided install, settings, branding, upgrade, health, moderation (`sudo morphit-ops --help`) |
| `apps/matrix-bot/` | Optional Matrix incident-pager bot for operators who want push-to-phone alerting |
| `apps/mcp-server/` | Read-only MCP server exposing the orderbook to AI agents |
| `packages/` | Shared TypeScript packages: `asset-registry`, `hidden-transport`, `indexer-client`, `net-defense`, `node-health`, `operator-config`, `relay-client`, `release-schema`, `rpc-pool` |
| `docs/` | Guides and operator runbooks, ADRs (`docs/adr/0001-…` through `0052-…`), audit logs, the claims list (`docs/MORPHIT-BRAG-LIST.md`) |
| `docs/release-notes/` | One `RELEASE-NOTES-v*.md` per release |
| `ops/` | Ansible role, systemd units, env templates, nginx + BunkerWeb configs, postgres init |
| `scripts/` | Build, smoke, mediakit, sitemap, llms.txt, and ceremony helpers |
| top level | `morphit-setup.sh` (the installer), `morphit.config.env.example`, `README.md`, `SECURITY.md`, `LICENSE`, `THIRD-PARTY-LICENSES.md`, and the npm, TypeScript, Prettier and audit config files |

## Running an instance

The complete walkthrough is in **[`docs/RUN-A-MORPHIT-NODE.md`](docs/RUN-A-MORPHIT-NODE.md)**. The short version:

1. Get an Ubuntu 24.04 machine, or a 24.04-based flavour, x86-64 or arm64 (a VPS, or an old PC at home — 2+ CPUs, 4+ GB RAM, 80+ GB SSD) and point a domain at it (or skip the domain and run Tor-only). Hosting at home shows your home IP to clearnet visitors unless you run Tor-only.
2. Download a signed release from [morphit.io/en/download](https://morphit.io/en/download#source-code) onto that machine and extract it.
3. In that folder, run `sudo bash morphit-setup.sh` and choose **Full guided install**: it installs Node.js, PostgreSQL, the services, HTTPS, BunkerWeb, Tor/I2P and the hardening, asking a few plain-language questions.
4. Register your instance on-chain: `sudo morphit-ops register` (on the server).
5. Updating later: `sudo morphit-ops upgrade` — see [`docs/UPGRADING.md`](docs/UPGRADING.md).

Installing by hand (Ansible yourself, or "configure only", where you run the full setup wizard — `morphit-ops init`, ~23 prompts: treasury addresses, fee targets, explorer URLs, operator tag, Web Push keys) and every operator setting are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md). Before opening to traffic, see [`docs/LAUNCH-DAY.md`](docs/LAUNCH-DAY.md).

## For shop owners

A static, no-tracking QR kit for a storefront window, a receipt or a website (a link to your Morphit page, or your account name for scan-to-pay): [`docs/merchant-qr-kit/`](docs/merchant-qr-kit/README.md).

## For developers

- Architecture overview: `docs/ARCHITECTURE.md`
- API reference: `docs/API.md`
- ADR index: `docs/adr/0001-…` through `docs/adr/0052-…`
- Threat model: `docs/audit/2026-10-stride-matrix.md` (with `2026-10-attack-tree.md` and `2026-10-red-team-narrative.md`)
- Latest security and privacy review: `docs/SECURITY-REVIEW-2026-10.md`
- Per-language translation guide: `docs/CONTRIBUTING-TRANSLATIONS.md`
- Adding a workspace (apps/* or packages/*): `docs/ADDING-A-WORKSPACE.md`
- Adding a tradable coin: `docs/ADDING-A-COIN.md`
- Locale graduation (PLANNED → SUPPORTED): `docs/LOCALE-GRADUATION.md`

The smoke suite (more than 750 runners in `scripts/run-smokes.sh`) is the source of truth for behavior — run it on a development machine, not on a production node:

```
bash scripts/run-smokes.sh
```

Triple-pulse it (run three times back-to-back) to filter flakes before submitting changes.

## Reporting bugs

Use Forgejo's New Issue form — the bug-report template auto-loads and walks you through the fields we need. Issues are public. **Security-sensitive issues** (anything involving keys, funds, fee bypass, or leaked private data) go ONLY by Matrix direct message to **`@agorise:matrix.org`**, as [`SECURITY.md`](SECURITY.md) describes — never as a public issue or in the community chat room.

Offline alternative: `docs/NEW-ISSUE-FOUND.md` (plain Markdown copy of the bug-report fields you can email).

## Community

- **Matrix room (public):** [`#agorise:matrix.org`](https://matrix.to/#/#agorise:matrix.org) — for questions, announcements, "is this a known bug?"
- **Security disclosures (private):** `@agorise:matrix.org` direct message (E2EE) — see `docs/SECURITY.md`.

## License

AGPL-3.0-or-later. Every operator running a modified instance must make their source available to their users. See [`LICENSE`](LICENSE).

Third-party dependencies are used under their own licenses (overwhelmingly permissive — MIT/ISC/Apache-2.0/BSD); see [`THIRD-PARTY-LICENSES`](THIRD-PARTY-LICENSES.md). Note that the Blurt client `@beblurt/dblurt` carries a `BSD-3-Clause-No-Military-License` (a no-military-use restriction) — disclosed there for operators and redistributors.

---

*Don't trust the project's marketing — verify it. Every claim in [`docs/MORPHIT-BRAG-LIST.md`](docs/MORPHIT-BRAG-LIST.md) points at code, an ADR, or a smoke that proves it. If you find one that doesn't, open an issue.*
