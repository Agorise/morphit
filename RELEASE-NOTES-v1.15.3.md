# Morphit v1.15.3

> **Superseded and never published — see RELEASE-NOTES-v1.15.4.md.** The headline
> below was incorrect: the one-command installer targets the Ubuntu 24.04 "noble"
> base, not 22.04. v1.15.4 corrects the installer's messaging. The two real code
> changes described here — the `docker compose` v2 CLI call and the Tor onion
> self-heal — are OS-agnostic and roll forward into v1.15.4. The floor-lowering
> notes below are moot for the supported OS (24.04 ships Ansible 2.16 / PostgreSQL 16).

**The fix for the failing fresh install: Morphit now installs on a stock Ubuntu 22.04 box with no Ansible or Postgres upgrade required.**

## Fixed

**The BunkerWeb step no longer needs a modern Ansible.** The install was failing with `couldn't resolve module/action 'community.docker.docker_compose_v2'` on Ubuntu 22.04's default Ansible (2.10). That module only exists in community.docker 3.x, which needs ansible-core ≥ 2.15 — so the distro-default Ansible couldn't load it. The playbook now calls the `docker compose` v2 **CLI plugin directly** (present on every box that has Docker) instead of that module. It works on Ansible 2.10 with no upgrade, and behaves the same (brings the stack up using the already-built image).

**The pre-checks now match what actually works, instead of demanding upgrades that aren't needed:**
- **Ansible floor lowered to 2.10.** Since the only thing that required a newer Ansible is gone, Ubuntu 22.04's stock 2.10 is fine. The check only flags genuinely ancient versions (< 2.10, where the `ansible.builtin` module path may not resolve).
- **PostgreSQL floor lowered to 14.** Morphit's own playbook installs the distro Postgres (14 on Ubuntu 22.04), the indexer enforces no minimum, and the schema uses no 15-only features — so 14 is what Morphit actually runs on. The earlier 15 gate contradicted the playbook and would have forced an unnecessary upgrade.

Net effect: a plain `apt install ansible postgresql docker.io` on Ubuntu 22.04 is now enough — the wizard stops asking the operator to upgrade tooling that already works.

**Censored nodes advertise their Tor onion automatically.** The onion is generated a few seconds after Tor first starts, so on some boxes the install-time config write lost the race and left `MORPHIT_INSTANCE_TOR_ADDRESS` empty — the node then advertised `tor: null` and was unreachable over Tor, which is fatal for a node whose clearnet is blocked (e.g. in Iran). Every upgrade now re-captures the onion from `/var/lib/tor/morphit/hostname` into the config if it's missing, so `/v1/instance` advertises it and the federation can reach the node over Tor. (The operator still broadcasts it once with `morphit-ops → Alt addresses` so peers learn it on-chain.)

## Notes

- Everything from v1.15.2 is included (the pre-flight/backstop/watchdog/spinner hardening, the DNS + locale + port/subnet checks, the DB-host auto-normalize, the language feature).
- No database migration beyond v1.15.0's additive `orders.lang` (schema v56). Upgrade in place.
