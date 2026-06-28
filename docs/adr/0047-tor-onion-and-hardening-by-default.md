# ADR-0047 — Tor onion service and host hardening on by default

**Status:** Accepted (implemented), 2026-06-28
**Supersedes:** none
**Superseded by:** none

## Context

Privacy is Morphit's first stated priority, and "as much security by default"
is the operator-facing corollary. Both were *supported* but *opt-in*:

- **Tor** was a first-class endpoint, but reaching it required the operator to
  generate a hidden-service key (`scripts/generate-onion.sh` / `mkp224o`) and
  paste the resulting `.onion` into `MORPHIT_INSTANCE_TOR_ADDRESS`. Most
  operators never did, so most instances shipped with no onion at all — the
  worst outcome for a privacy-first project.
- **Host hardening** shipped as a complete, idempotent Ansible role
  (`ops/ansible/roles/hardening`, OPERATIONS §37 + §34) plus a `morphit-ops
  harden` checklist generator, but running it was a deliberate operator choice.
  A first-time operator following the happy path could expose an un-hardened
  internet-facing box.

The friction was the problem, not the capability. The fix is to flip both
defaults to on while keeping every escape hatch intact.

## Decision

### 1. Every instance generates and serves a Tor `.onion` by default

- The setup wizard (`morphit-ops init`) **generates a v3 onion in the
  background** while the operator answers the other prompts — instant, no wait,
  no vanity grinding. Generation uses Node's built-in `crypto` only (new
  `apps/ops-cli/src/init/torOnion.ts`, zero new dependencies) and follows
  rend-spec-v3 §6 exactly: `address = base32(pubkey ‖ SHA3-256(".onion
  checksum" ‖ pubkey ‖ 0x03)[:2] ‖ 0x03) + ".onion"`; the 96-byte
  `hs_ed25519_secret_key` is the `== ed25519v1-secret: type0 ==` header plus
  `clamp(SHA-512(seed))`. The implementation is cross-checked against PyNaCl
  (libsodium), Python's stdlib base32, a from-spec checksum, and a fixed-seed
  vector.
- The wizard **never asks** about Tor and **never overwrites** an operator-set
  address: if `MORPHIT_INSTANCE_TOR_ADDRESS` already exists in the environment
  or an existing config, that value is kept.
- The hidden-service key files are written to `tor-hidden-service/`
  (`hs_ed25519_secret_key` mode 0600, dir 0700) **only on the success path**,
  so an aborted wizard leaves no orphan keys.
- The shipped **`tor` Ansible role** (`ops/ansible/roles/tor`, `enable_tor`
  default-on in `group_vars/all.yml`) installs Tor and points its
  `HiddenServiceDir` at the wizard's keys (`morphit_tor_key_src`), so the
  daemon serves the *same* address the site advertises.
- Reachability lights up automatically: the address flows from the env var →
  indexer config → `/v1/instance` `alt_networks.tor` → the web instance store →
  the footer Tor pill and the `Onion-Location` response header (so Tor Browser
  offers the onion with no user action).

### 2. Host hardening is applied by default, and the wizard hand-holds it

- The Ansible `hardening` role already imports **all 16 sub-features
  unconditionally** (SSH, unattended-upgrades, sysctl, mounts, auditd,
  AppArmor, AIDE, secrets-perms, outbound, alerting, rkhunter, GRUB, password
  policy, UFW, fail2ban) and runs with no `when:` gate — so the automated path
  was already maximal. No change was needed there.
- The wizard's hardening step now **walks the operator through the major
  pillars** (SSH lockdown, firewall + fail2ban, automatic updates, kernel
  hardening, intrusion detection) as a short run of yes-default confirmations,
  and records them so the generated `morphit-hardening-checklist.md` reflects
  what the operator confirmed.

## Why generate the onion locally instead of letting Tor do it

Tor can generate its own hidden-service key on first start, but then the
address is **not known at config-write time**. Generating it locally in the
wizard means the address can be written into the config, surfaced in the footer
pill + `Onion-Location`, and printed for the operator in the *same* setup run —
none of which is possible if the address only appears after the Tor daemon
boots later. Local generation is also instant and dependency-free at setup
time (Tor need not even be installed yet).

## Security notes

- The HS **secret key** is treated like any other secret: written 0600 on
  success only, and **structurally excluded from the save-as-you-go progress
  file** (`WizardProgress = Partial<Omit<WizardAnswers, … | 'torOnion'>>` plus a
  defense-in-depth `delete safe.torOnion` in `saveProgress`). Only the public
  `.onion` address is ever remembered (in `altNetworks.tor`).
- The wizard choices in pillar (2) **never weaken the automated path** — the
  Ansible playbook applies every hardening sub-feature regardless; a declined
  pillar only annotates the by-hand checklist ("strongly reconsider").

## Consequences

- Every fresh instance is Tor-reachable by default — a direct privacy win, and
  the onion pill/`Onion-Location` now appear for the common case rather than the
  rare configured one.
- Operators get a hardened host on the default path, with informed-consent
  framing rather than silent application.
- Setup produces one extra artifact (`tor-hidden-service/`); operators serving
  the onion must point the `tor` role's `morphit_tor_key_src` at it.
- A **vanity** `.onion` remains a deliberate manual step (generate on operator
  hardware, paste via `morphit-ops alt-address`); pasting one simply replaces
  the basic address and is never overwritten.

## Alternatives considered

- **Keep Tor opt-in** — rejected; the friction is exactly why most instances
  had no onion, which contradicts the project's first priority.
- **Let the Tor daemon generate the key on first start** — rejected; the
  address would be unknown during the wizard run (see "Why generate locally").
- **Vanity onion by default** — rejected; prefix grinding is slow and unbounded,
  defeating the "instant, no wait" property. Vanity stays a manual choice.
