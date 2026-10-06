# Morphit v1.15.4

**The one-command installer now says up front that it needs Ubuntu 24.04, instead of a fresh box getting several steps in and hitting a confusing dead-end.**

## Fixed

**The installer tells you the OS requirement before it does anything.** The one-command installer provisions the Ubuntu 24.04 "noble" base (or a 24.04-based derivative — Linux Mint 22, Pop!_OS 24.04, Zorin OS 17); the playbook pins its apt repos and package paths to that base and has always asserted it. But a box on an older base (e.g. Ubuntu 22.04 "jammy") only learned this when Ansible reached the check several steps in and stopped with an assertion the installer didn't recognise — so it pointed the operator at support instead of at the fix. Now the installer reads `/etc/os-release` first and, if the base isn't `noble`, stops immediately — before writing any secrets or running Ansible — with plain guidance to provision a 24.04 machine. If a run somehow still reaches the playbook's assertion (an unusual derivative, a bypassed pre-check), the failure summariser maps that assertion to the same guidance rather than the "email support" last resort.

**The wizard and docs no longer imply 22.04 is a supported one-command target.** The pre-check remediation text and the run-a-node guide referenced Ubuntu 22.04 as the baseline; they now reference the actual supported base, Ubuntu 24.04 (whose stock `apt` PostgreSQL 16 and Ansible 2.16 clear Morphit's floors comfortably). The general system-check still recognises other Ubuntu/Debian-based systems as fine *operating systems* — Morphit still supports by-hand installs on them (Kicksecure, Debian, …) — it's only the one-command path that is noble-only.

**Carried forward from the unreleased v1.15.3** (see the correction note below): the BunkerWeb step calls the `docker compose` v2 CLI plugin directly (no dependency on a newer ansible-core), and every upgrade re-captures a node's Tor onion into its config if it went missing, so a clearnet-censored node stays reachable over Tor.

## Notes

- **v1.15.3 was never published.** Its headline — "installs on a stock Ubuntu 22.04 box" — was incorrect: the one-command installer has targeted the Ubuntu 24.04 "noble" base since the beta. v1.15.4 supersedes it and corrects the installer's messaging; the genuinely useful v1.15.3 code changes (the `docker compose` CLI call and the onion self-heal) are included here.
- A new `os-support-parity` smoke ties the installer's noble pre-check, the playbook's `morphit_ubuntu_codename == "noble"` assertion, and the run-a-node guide together, so this class of "the surfaces disagree about the supported OS" drift can't recur silently.
- Everything from v1.15.2 is included. No database migration beyond v1.15.0's additive `orders.lang` (schema v56). Upgrade in place.
