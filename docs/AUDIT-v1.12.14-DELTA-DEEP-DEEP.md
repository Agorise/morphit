# AUDIT — v1.12.14 DELTA (deep-deep)

Adversarial self-review of everything changed since v1.12.13: cp774 (the real relay:up:false fix — code + systemd unit), the node:http probe (cp773) as it stands, the instances-page copy change, and the two doc removals.

Battery at time of audit: ~19,700 smoke scenarios / 0 failures; 2,131 vitest / 0 failing; 27/27 workspace typecheck; version 20/20; lockfile 4/4; doc-drift 32/32. relay-probe-gateway 21/21; operational-health 20/20.

## cp774 — the relay:up:false root cause (proven live)

**Established by evidence, not theory.** A `refresh()` trace injected into the *running* indexer on morphit.io logged: `relay=rejected relayVal="uv_interface_addresses returned Unknown system error 97"` on every refresh, with `ipfs`/`system` fulfilled. That is `os.networkInterfaces()` throwing `EAFNOSUPPORT` — the indexer unit's `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` omits `AF_NETLINK`, which libuv needs to enumerate interfaces. The throw propagated out of `relayProbeCandidates` → `probeRelayAny` rejected → `refresh()`'s `allSettled` recorded `rejected` → the merge kept the previous value → `/v1/health` was frozen at the default `up:false`, with no fetch ever attempted.

**Change (two parts).**
1. Code: `relayProbeCandidates` wraps the `networkInterfaces()` enumeration in try/catch; on failure `addrs` is empty and it falls back to `buildRelayCandidates(configured, [], gateway)` — i.e. the configured URL + loopback. It can no longer throw out of the probe.
2. Unit: `morphit-indexer.service` `RestrictAddressFamilies` now includes `AF_NETLINK`, so `networkInterfaces()` works and cp771 auto-detection (host IPs incl. the docker bridge) functions.

**Review.**
- *Does it fix it?* Verified live: `apply-relay-fix.sh` applied part 1 to the deployed code and `/v1/health` flipped to `relay:{up:true}`. Part 2 (the unit) makes enumeration succeed outright so the guard is a safety net rather than the sole mechanism.
- *Can it produce a false up?* No. Catching the throw only lets the probe *proceed* to real fetches against real candidates; each candidate still must answer `2xx` to count as up.
- *Can it hide a genuinely-down relay?* No. If the relay is down, the configured/loopback fetches fail and it reports `up:false` correctly. The guard only affects the interface-enumeration step, not the reachability decision.
- *Security of the unit change.* `AF_NETLINK` lets the process talk to the kernel's netlink interface (used for interface/route enumeration). It is the minimal family required for `networkInterfaces()`; the unit keeps all other hardening (`PrivateTmp`, `ProtectHome`, `NoNewPrivileges`, etc.). This is a narrow, justified relaxation, not a broad one. The code guard means that even a node that (for its own reasons) keeps `AF_NETLINK` denied still reports the relay correctly via the configured URL.
- *Regression surface.* Only `relayProbeCandidates` changed in code; `buildRelayCandidates`, `probeRelay`, `probeRelayAny`, the merge, and the snapshot lifecycle are untouched. relay-probe-gateway-smoke gained two locks (try/catch present; unit grants AF_NETLINK) → 21.

**Why five prior attempts missed it.** cp766 (snapshot resilience), cp769 (loopback candidate), cp771 (auto-probe all local addrs), cp772 (undici dispatcher), cp773 (node:http) all addressed candidate selection or the fetch transport — all *downstream* of an exception thrown during candidate *construction*. No downstream change could matter. Two environmental traps extended the hunt and are recorded in REVISIT: `PrivateTmp=yes` made `/tmp` debug logs invisible from the host (fix: log to a shared path or the journal), and reasoning about "isolated works, running doesn't" should immediately point at a sandbox/runtime difference and a trace of the orchestrator (`refresh`), not the leaf functions.

## node:http probe (cp773), as shipped

The local relay probe uses `node:http`/`node:https` rather than `fetch`. With the real cause now known to be the interface-enumeration throw, this is not load-bearing for the fix, but it is a reasonable, harmless choice for a purely local health check (no dependence on the process's global HTTP-client dispatcher) and is covered by smoke. Kept.

## Instances-page copy + doc removals

Copy-only i18n change to `bookmark_tip` (valid JSON; doc-drift 32/32). `HIDDEN-RPC-Q2-RESPONSE.md` and `HIDDEN-RPC-SNAPSHOT-INSTRUCTIONS.md` removed — no code/doc/config references them (grep clean), absent from the tarball.

## Version bump

1.12.13 → 1.12.14 across 15 package.json + lockfile + 3 TS consts + docs. version-consistency 20/20.

## Verdict

CLEAR, and — for the first time in this sequence — the fix is proven on the live endpoint rather than reasoned. cp774 can only turn a false-down into a true-up, never manufacture a false-up or mask a real outage. The unit relaxation is minimal and justified, and the code guard stands even without it. No leak, no weakened reachability check, no regression. No database migration.
