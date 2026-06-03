# Morphit v1.0.0-beta.2

Second public beta of Morphit — a federated, non-custodial, no-KYC peer-to-peer
marketplace for fiat ↔ BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE,
ZEC, ARRR, DCR, SOL, ETH, and XRP trades.

This release builds on `v1.0.0-beta.3` and is focused almost entirely on the
**operator experience** — the part beta-testing surfaced as the roughest. If
you ran a beta.1 node, the headline is that running and maintaining your
instance is now a guided, menu-driven experience, and upgrades safely preserve
your configuration and signing key.

## Install

See `docs/RUN-A-MORPHIT-NODE.md` for the friendly walkthrough.
Plan two evenings: the first to set up the server and install
things, the second to troubleshoot whatever didn't work the
first time.  Runs comfortably on a $5/mo VPS or a Raspberry Pi 4.

For the day-zero procedure (the morning-of and first-24-hour
operator runbook) see `docs/LAUNCH-DAY.md`.

For ongoing day-1-through-day-7 monitoring see
`docs/POST-LAUNCH-WEEK-ONE.md`.

## Upgrading from beta.1

Use the built-in upgrader — `docs/UPGRADING.md` has the full procedure:

    sudo -u morphit npx morphit-ops upgrade

It downloads this release, verifies the SHA-256, backs up your current
install, swaps in the new code, **carries your config and signing key
forward automatically**, reinstalls dependencies, and restarts your
services — rolling everything back if any step fails.

> **One-time note for this specific upgrade.** `morphit-ops upgrade` runs
> the carry-forward using the code of the version you're upgrading *from*.
> beta.1 predates that feature, so on this first jump your config is not
> auto-carried — it is **not** lost, it's in the timestamped backup. Before
> upgrading, copy `morphit.config.env`, `morphit.env`, `apps/relay/keystore.*`,
> and `apps/relay/altnet/` somewhere safe; after the upgrade, confirm they're
> present in your install dir and, if any are missing, copy them back from
> `/opt/morphit.bak-<timestamp>/` and restart `morphit-indexer` and
> `morphit-relay`. From beta.2 onward every upgrade preserves them for you.

Your on-chain operator registration is unaffected by any upgrade — it lives
on the Blurt chain, not in your install.

## Verify the download

    sha256sum -c morphit-v1.0.0-beta.2.tar.gz.sha256

For belt-and-braces, see `docs/UPGRADING.md` "Belt-and-braces verification"
— it walks you through cloning the repo separately, running
`git tag -v v1.0.0-beta.2`, and re-deriving the manifest from a
clean checkout to compare against the tarball you downloaded.

## What's new since beta.1

Everything below is shipped, smoke-tested, and source-verifiable against the
tagged commit.

### One command to run your instance

- **`morphit-ops` now opens a menu.** Run it with no arguments on a
  terminal and you get a grouped, plain-English menu — set up and
  change the instance, check on it (status, signups, abuse alerts,
  pending transfers, moderation flags), or manage keys and payment
  methods — so you pick an action by what you want to do instead of
  memorizing subcommand names. Every action is still runnable
  directly (e.g. `morphit-ops status`), and scripts/cron are
  unaffected: non-interactive runs print help exactly as before.
- **`morphit-ops edit` for ongoing changes.** Change your RPC
  endpoints, description/SEO, origin, listing fees, or operator tag
  without re-running the full setup. It writes atomically, preserves
  permissions, and tells you exactly which services to restart.
- **Safe re-run of the setup wizard.** Running `morphit-ops init` on
  an instance that's already configured no longer risks clobbering it
  — it warns you, then offers to edit a few settings (recommended),
  overwrite everything (with a confirmation and a backup), or cancel.

### A dedicated hardening wizard

- **`morphit-ops harden`** (also "Harden this server" in the menu)
  walks you through securing the host: it generates a **personalized
  hardening checklist** with your domain and your reverse-proxy choice
  baked in — leading with the SSH-lockout safety rule — and can walk
  you through BunkerWeb, daily database backups, and the full
  Ubuntu / SSH / firewall / fail2ban / TLS checklist, or point you at
  the fully-automated Ansible path. Nothing here is Morphit-specific;
  it's the baseline every internet-facing server needs, sequenced for
  you with copy-paste commands.

### Setup wizard improvements

- **BunkerWeb step.** The setup wizard now asks whether BunkerWeb (an
  open-source reverse-proxy WAF, shipped turnkey at `ops/bunkerweb/`)
  will front your instance, and wires the trusted-proxy setting for
  you when you say yes — so your relay sees real client IPs.
- **Hardening step.** The wizard finishes by offering to generate the
  same personalized hardening checklist described above.
- **Matrix alerting is on by default.** The optional Matrix incident
  bot is now presented as a recommended default with clear setup
  steps for its own credentials, rather than an easy-to-miss opt-in.
- **Clearer prompts throughout** — the wizard greeting reflects the
  real number of steps, the optional steps are clearly skippable with
  safe defaults, and the prompts spell out where each value appears
  publicly.

### Clearer on-chain registration

- **Honest, accurate output from `morphit-ops register`.** The success
  screen no longer prints a confusing "Block: undefined" (Blurt
  confirms asynchronously — there's no block number at broadcast time)
  and no longer leaks internal RPC retry noise when your node
  transparently fails over to a healthy endpoint.
- **Specific failure guidance.** When a broadcast fails, the tool now
  tells you exactly why (reserved tag, taken tag, wrong key, low Mana,
  all endpoints unreachable, …) and what to do — and on a low-Mana
  failure it offers to retry in place once you've powered up, with no
  wizard re-run.
- **Key verification made concrete.** Prompts that ask you to confirm
  your relay's key now name the **"Active Auth"** field and give you
  the exact explorer URL — `https://blocks.blurtwallet.com/#/@<your-account>`
  — to check it against. `morphit-ops show-key` uses the same
  guidance.
- **Re-registration reminder.** If you change your origin or operator
  tag with `morphit-ops edit`, the tool reminds you to re-run
  `morphit-ops register` so the rest of the federation sees the change
  (those two values live in your on-chain record; other settings are
  local-only).

### Safer upgrades

- **Your config and keys survive upgrades.** `morphit-ops upgrade` now
  explicitly carries `morphit.config.env`, `morphit.env`, your relay
  keystore, your alt-network keys, and your hardening checklist forward
  into each new release — with their permissions intact — so a release
  upgrade brings your instance back up exactly as it was, on the new
  code, with no re-configuration. (See the one-time note above for the
  beta.1 → beta.2 jump specifically.)
- **`docs/UPGRADING.md` corrected and expanded** to document the
  carry-forward step and the exact files preserved.

### Documentation and accuracy

- **`docs/RUN-A-MORPHIT-NODE.md`** gained a "Managing your instance
  later" section covering the menu, the hardening wizard, and the
  re-registration rule.
- **README and operator docs** were swept for accuracy against the
  actual code (app and config inventory, the relay's key type, the
  reverse-proxy configs that actually ship, and more).

## Reach

Morphit instances are reachable over the public web, Tor `.onion`
hidden services, I2P `.b32` addresses, Lokinet, and Nostr.  The
federation directory at `/instances` on any node shows the other
known instances and their alt-network addresses.

## Reporting issues

Bug reports: open a New Issue on Forgejo
(`git.agorise.net/agorise/morphit`) — the bug-report template
auto-loads with the fields needed.

**Security disclosures** go to the operator's Matrix DM channel
listed in §16 of the bug-report template (or in
`docs/SECURITY.md`).  Do NOT post security issues as public
Forgejo issues or in the community Matrix room.

## Acknowledgements

Built on Blurt for the chain layer.  The audit campaign is
publicly readable in this repo, and so are the design tradeoffs
— we made arguable calls, especially around chat-crypto
primitives, and the reasoning is in the ADRs for you to push
back on.

---

**Tag:** `v1.0.0-beta.2`
**Built by:** Forgejo Actions from a signed annotated tag (see
`.forgejo/workflows/release.yml`)
**License:** AGPL-3.0-only
