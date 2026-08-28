# Morphit v1.13.0

**Theme: a rock-solid first install on any network — including heavily censored ones — and a config mistake that took a node down is now impossible to ship.**

## Fixed

**The indexer and relay no longer crash-loop when you set a fee recipient.** The setup wizard writes your fee-recipient account into `morphit.config.env`, but the config loader's allowlist didn't recognise that key and aborted on every boot — so both services crash-looped from the first start, pinning the CPU and taking the whole node offline (the database never migrated, backups skipped, the canary couldn't publish, and the site returned 500/403). `MORPHIT_INDEXER_FEE_RECIPIENT` is now allowlisted where it always belonged, alongside the other fee-tuning keys. A new CI guard (`config-env-allowlist-parity`) cross-checks every key the installer writes into `morphit.config.env` against the allowlist and fails the build if they ever drift again, so this class of mistake can never reach an operator.

## Improved

**A first install now survives a stale, partial, or filtered package cache.** On a fresh server image — or a slow, filtered, or censored connection — apt can hold an outdated index and try to fetch point-release `.deb`s the mirror has already superseded, giving a wall of "404 Not Found" that stopped the install cold. Base-package installation now self-heals exactly the way an operator would by hand (`rm -rf /var/lib/apt/lists/* && apt clean && apt update`) and retries automatically, so a first-time operator never sees a scary failure or has to touch apt.

**I2P installs cleanly on networks that block Launchpad and keyservers.** The i2pd install used to add a PPA, which fetches a signing key from a keyserver via deprecated tooling — both commonly blocked in censored countries, where it failed outright. When the offline bundle is present (which carries the maintained i2pd build), i2pd is now installed straight from that bundled package — no PPA, no keyserver, no Launchpad. On an online box with no bundle, the PPA step now retries a few times and, if it still can't be reached, falls back to the distribution's i2pd rather than halting the whole install.

**The offline bundle now proves its runtime-critical source survived packaging.** The bundle's build-time completeness check verified the vendored apt/docker/kubo/node payloads; it now also asserts the indexer and relay entrypoints, the `tsx` launcher, and every workspace package's source are actually in the shipped tarball — so a future packaging change can never quietly ship a bundle that installs but then can't start.

**The "run a node" page speaks plainly about what you earn and links where you'd go next.** It now states you earn **90% of the BLURT paid listing fees**, links "your own instance" straight to the instance directory, and gives realistic hardware guidance (2+ CPU cores, 4+ GB RAM, 60+ GB drive space). A new paragraph explains how your included Tor and I2P addresses — plus encouraging a VPN — let users reach you from jurisdictions where clearnet access is blocked, with no SSL certificate needed.

**The instances directory page explains federation up front.** The intro now describes how independent operators run instances and earn 90% of the listing fees on their sites, with links to the FAQ, the download, and the run-a-node page. The intro and the bookmark tip span the full content width, the live "LIVE" indicator sits on the same row as the status filter, and the "directory last updated" line now appears just below the instance cards.

**Assorted accuracy and polish.** The homepage/SEO descriptions and the public comparison image were refreshed and brought in line with the current feature set, and the operator brag-list figures were audited against the live counts.

## Notes

- No database migration in this release.
- Everything from v1.12.21 and earlier is included.
