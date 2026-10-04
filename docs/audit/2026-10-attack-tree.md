# Morphit attack tree (2026-10)

This tree replaces the 2026-05 attack tree (one goal: draining the relay) and
the attack-tree section of the 2026-09 delta model. It is the companion of
[`2026-10-stride-matrix.md`](2026-10-stride-matrix.md): element and flow IDs
(P\*, E\*, F\*, D\*, TB\*) refer to its §2, and the attacker classes (A-NET,
A-WEB, A-VIS, A-PEER, A-RPC, A-OP, A-SUP, A-LEG) to its §1.

Every leaf reflects the code after the 2026-10 fixes. Each leaf gives:

- **pre**: preconditions, and **cost**: what the attacker spends;
- **stop**: what stops it now, or **OPEN** / **known** / **accepted**;
- **guard**: the test or smoke that proves the stop. A guard named
  `<workspace>:<name>` is a smoke script; a `*.test.ts` file is a vitest file.

"FIXED" means the leaf was reachable before the 2026-10 fixes and is now
stopped, with a guard that was seen to fail on the old code. "known" means a
residual the project has decided to live with and documents.

---

## (a) De-anonymise a user

```
GOAL a: learn a user's IP or identity, link two accounts, or link account ↔ instance ↔ device
├── a1  Get the visitor's IP from the instance
│   ├── a1.1  Read the edge access log (A-OP, A-LEG)
│   │     pre: box access · cost: low
│   │     stop: frontend `access_log off`; bare-metal `error_log stderr crit`; BunkerWeb LOG_FORMAT
│   │           without the address and the container's Docker log driver set to none
│   │     guard: scripts/proxy-privacy-config-smoke.ts, the nginx-run smoke
│   │     residual: a rare critical nginx error line can name a client; ModSecurity's own audit
│   │           state inside the BunkerWeb container is not covered by a test
│   ├── a1.1b The edge sends visitor data to third parties (BunkerNet, DNSBL, reverse DNS,
│   │         anonymous reporting)
│   │     stop: FIXED — all off in the template and the example; `morphit-ops upgrade`
│   │           turns them off on installed boxes and checks BunkerWeb's generated settings;
│   │           BunkerWeb's own GeoIP, update-check and Pro-plugin jobs are removed, so it
│   │           contacts no third party
│   │     guard: apps/ops-cli:bunkerweb-privacy-settings-smoke,
│   │           apps/ops-cli:bunkerweb-no-phone-home-smoke
│   ├── a1.2  Read the relay journal (A-OP, A-LEG)
│   │     pre: a network that creates several similarly named accounts · cost: free
│   │     stop: FIXED — sequential refusals log `{reason, matched_count}` only; the
│   │           detector keys on a per-boot HMAC of the bucket, never the bucket or the names
│   │     guard: apps/relay/test/signupLogPrivacy.test.ts
│   ├── a1.3  Dump relay process memory or swap (A-OP, A-LEG)
│   │     pre: box access while running · cost: low
│   │     stop: known — client networks are held in memory only: up to 1 h for burst and push
│   │           limits, up to 24 h for the daily signup limit; nothing reaches disk or a log
│   │     guard: documented in SECURITY.md §4 and the FAQ (no "a few seconds" claim remains)
│   └── a1.4  Indexer memory (A-OP) — per-client read buckets live for minutes
│         stop: accepted (short-lived by design, documented)
├── a2  Get the visitor's IP from a third party
│   ├── a2.1  Run a Blurt RPC node that the release check reaches (A-RPC)
│   │     pre: be one of the clearnet nodes (or a hidden one, for Tor/I2P pages) · cost: medium
│   │     stop: accepted and documented with the exact budget: 1 × get_account_history (100)
│   │           + 1 × get_block to ONE node; +1 read of up to 10 000 entries if the release is
│   │           old (each POST may follow a CORS preflight); a second node only if the first fails, serves an unverifiable
│   │           record or another version; cached 24 h per build, success or failure, shared
│   │           by all tabs. Per-origin pools: https → clearnet, .onion → onion,
│   │           .i2p → I2P, plain-http clearnet → clearnet
│   │     guard: apps/web/src/lib/net/releaseVerify.test.ts,
│   │           apps/web/scripts/ip-disclosure-single-source-smoke.ts,
│   │           apps/web/scripts/rpc-privacy-routing-smoke.ts
│   ├── a2.2  Second browser request: past treasury BTC key proof
│   │     stop: FIXED — the request is gone: an older key is accepted only from releases
│   │           this browser already verified
│   │     guard: releaseVerify.test.ts "past treasury BTC keys", ip-disclosure-single-source-smoke
│   ├── a2.3  Push service correlates device ↔ instance ↔ chain timing
│   │     stop: accepted (documented in the push FAQ); push is off on hidden-only instances
│   │     guard: apps/relay/test/pushOffOnPurpose.test.ts
│   └── a2.4  Any other website sees the visitor (CDN, fonts, images)
│         stop: CSP `connect-src`/`img-src`/`font-src` limited to self and the browser's RPC pool
│         guard: scripts/csp-header-consistency-smoke.ts
├── a3  Link account ↔ instance
│   ├── a3.1  Register an instance on chain and receive every pushed chat
│   │     pre: one Blurt account and an origin · cost: one account
│   │     stop: FIXED — fast chat is pushed only to probe-verified peers, over Tor with
│   │           a fresh circuit per push and one sender per push; no fan-out without Tor
│   │     guard: apps/indexer/test/fanout/torIsolatedFanOut.test.ts
│   │     residual: a verified peer learns a (public) message seconds before its block, not which
│   │           instance sent it
│   ├── a3.2  Read chat-activity streams on many instances — public metadata, accepted
│   └── a3.3  Pairing forward reveals the phone's instance to the desktop's instance — inherent,
│             documented, accepted
├── a4  Link account ↔ device
│   ├── a4.1  Seize the relay database of a clearnet instance (A-LEG)
│   │     stop: FIXED — no user-agent is sent or stored; the locale is one of the 10 UI
│   │           codes; push rows are left out of backups
│   │     guard: apps/relay:push-subscription-store-smoke
│   │     residual: account ↔ push endpoint in the live database (inherent to push, documented)
│   └── a4.2  Fingerprint via the service worker or storage — no third-party script; accepted
├── a5  Link two accounts of one user
│   ├── a5.1  Same network creates both via the relay — no longer in any log (a1.2)
│   ├── a5.2  One browser subscribes streams for both on one instance — operator-trust
│   │         boundary, accepted
│   └── a5.3  Chain analysis (funding, timing) — documented in METADATA-LEAK-CATALOG.md
└── a6  Break chat confidentiality or authenticity
      ├── a6.1  Forge a pushed message — stop: signature against the stored or quorum key
      │         guard: test/integration/forged-block-trust.test.ts, posting-key-rotation.test.ts
      ├── a6.2  Replay a captured message — stop: expiry window and replay table
      │         guard: fastchat-abuse-guards-smoke
      ├── a6.3  Indexer writes a message "from" someone — FIXED: v2 envelope binds the
      │         sender's pinned key (static-static DH); v1 shown "Sender not verified"
      │         guard: chat crypto tests
      ├── a6.4  Silent key swap after first contact — FIXED: changes held until
      │         accepted; 60-digit safety number; first contact is trust-on-first-use
      │         guard: fingerprint / pubPin tests
      └── a6.5  Read old messages after a posting-key leak — known: no forward secrecy in either
                chat mode (documented in CHAT-CRYPTO.md)
```

## (b) De-anonymise a zero-clearnet operator

```
GOAL b: make a zero-clearnet (Tor and I2P) box reveal its clearnet address
├── b1  Morphit's own outbound legs
│   ├── b1.1  Chain RPC over clearnet — stop: empty clearnet pool and fail-closed router
│   │         guard: hiddenOnlyNoClearnet.test.ts, routerInstallPolicy.test.ts
│   ├── b1.2  Price/FX over clearnet — stop: clearnet price sources off; BTC/XMR prices and FX
│   │         come from the Haveno/Bisq pricenodes as onion services, BLURT from the federation
│   │         guard: clearnet-gate-smoke, onionPricenodes.test.ts
│   ├── b1.2b BTC/XMR fee checks over clearnet — stop: a zero-clearnet node drops the clearnet
│   │         entries (no DNS question) and verifies through onion explorers over Tor; it offers
│   │         BTC/XMR only while an onion explorer of that method answers
│   │         guard: test/integration/onion-fee-verification.test.ts
│   ├── b1.3  Push to a browser vendor — stop: push off on hidden-only · guard: pushOffOnPurpose.test.ts
│   ├── b1.4  Fast-chat push, pairing forward or compare to a clearnet peer — stop: Tor-only
│   │         transport and clearnet origin never offered
│   │         guard: torIsolatedFanOut.test.ts, hiddenOnlyIpPrefixName.test.ts, pairingForward.test.ts
│   ├── b1.5  `.onion` resolved locally — stop: SOCKS5 with domain address type
│   ├── b1.6  Upgrade download over clearnet — stop: hidden path fails closed
│   │         guard: apps/ops-cli/test/hiddenUpgradeTarget.test.ts
│   ├── b1.7  IPFS DHT or swarm — stop: `Routing.Type=none`, no swarm addresses
│   │         guard: scripts/ipfs-hidden-only-execution-smoke.ts
│   ├── b1.8  MCP fetches its instance URL — tor-only config leaves it without a usable URL,
│   │         so no request is made · ASSERTED (no test)
│   ├── b1.9  Matrix alert bot reaches matrix.org from the box
│   │         stop: FIXED — the wizard gates the homeserver on tor-only; the bot routes
│   │               via Tor SOCKS; a clearnet homeserver on a tor-only node is refused
│   │         guard: apps/matrix-bot:tor-socks-route-smoke
│   ├── b1.10 Hidden-only upgrade contacts the npm registry over clearnet
│   │         stop: FIXED — node_modules carried forward, the registry over Tor, or refuse
│   │         guard: apps/ops-cli/test/upgradeHiddenNpm.test.ts
│   ├── b1.11 `morphit-ops edit` probes clearnet RPC — FIXED
│   │         guard: apps/ops-cli/test/rpcStepHiddenOnly.test.ts
│   └── b1.12 i2pd reseed, host alert mail, fail2ban whois on clearnet
│             stop: FIXED — nftables table `inet morphit_egress` lets only Tor and
│                   i2pd reach the internet (local network allowed; DNS goes nowhere but the
│                   box itself); host alert mail is off unless a real relay is set, never on
│                   tor-only
│             guard: apps/ops-cli:tor-egress-smoke, apps/ops-cli:host-alert-mail-smoke
│             residual: i2pd talks to I2P routers directly (that is how I2P works)
├── b2  OS-level traffic (apt, NTP, snapd, fwupd, pollinate) — FIXED by the same egress
│         table; anything else bound for the internet is refused
├── b3  Fingerprint the hidden service to match a clearnet scan
│   ├── b3.1  nginx version in headers and error pages — FIXED: `server_tokens off`
│   │         guard: csp-header-consistency-smoke (server_tokens), nginx-served-hardening-smoke
│   ├── b3.2  `/v1/health` figures — public body is coarse; accepted
│   └── b3.3  Same box answers on a public address — stop: tor-only closes 80/443 and swarm ports
│             guard: tor-only-install-smoke
└── b4  Timing correlation of fast-chat pushes — Tor-level residual; accepted
```

## (c) Steal funds or fees

```
GOAL c: users' fees, the relay wallet, the operator's 90 % or the treasury's 10 %
├── c1  Redirect users' BTC/XMR fee payments
│   ├── c1.1  One hostile RPC node forges @morphit's history for the browser's release check
│   │         stop: FIXED — the transaction id is recomputed from the block and the
│   │               signature must recover to the pinned posting key; anything unverifiable
│   │               sends the check to a second node; a node can make it fail, not pass, but can
│   │               withhold the newest genuine release (late update notice)
│   │         guard: apps/web/src/lib/net/releaseVerify.test.ts
│   ├── c1.2  Forged release op applied by an indexer (treasury pin, upgrade hash)
│   │         stop: FIXED — signature recovered from the block's own transaction
│   │               must equal the pinned official key
│   │         guard: test/integration/official-op-trust.test.ts
│   ├── c1.3  Sybil "operators" in the RPC pool via a forged `morphit_rpc_v1`
│   │         stop: FIXED — the directory op is signature-checked; trusted quorum
│   │               is 2 whenever the pool has ≥2 operators, with veto on disagreement (operators
│   │               counted by node name; the default hidden nodes are project-run)
│   │         guard: official-op-trust.test.ts, rpc-operator-quorum.test.ts
│   └── c1.4  Hostile operator shows its own fee address — stop: addresses are chain-pinned and
│             now come from a verified release (c1.1)
├── c2  Fee recipient fraud across instances
│   ├── c2.1  Claim another operator's 90 % — stop: tag → owner → fee recipient as of block
│   │         guard: test/integration/cross-instance-fee-g1.test.ts
│   ├── c2.2  Skip the 10 % treasury leg — stop: the canonical share is mandatory
│   │         guard: blurt-fee-reverify-g1.test.ts
│   └── c2.3  BTC fee txid not bound to the payer — known (txid mode)
├── c3  Drain the relay wallet
│   ├── c3.1  Signup spam — stop: burst/daily/spacing limits, invite, ALTCHA (signature covers the
│   │         salt), global ceiling, kill switch
│   │         guard: apps/relay/test/create.test.ts, globalDailyCeiling.test.ts, altcha tests
│   ├── c3.2  Witness fee spike — stop: refuse above 110 % · guard: create.test.ts
│   ├── c3.3  Forged blocks queue welcome bonuses or delegations — known: ordinary user ops are
│   │         applied from one node's block; bounded per real recipient account; the periodic
│   │         consistency sample alarms
│   ├── c3.4  Steal the active key from disk
│   │         stop: encrypted keystore at `root:morphit-relay 0640`; passphrase sealed with
│   │               `systemd-creds --with-key=host`
│   │         residual: a full disk image unseals it (no TPM); use LUKS
│   │         guard: apps/relay/test/keystorePerms.test.ts (only `root:<relay group> 0640` or tighter)
│   └── c3.5  OOM-kill the relay with a hostile RPC reply — FIXED: a byte cap sized from the
│             request (at most 41 MiB, for a 10,000-entry history), plus value-count and depth
│             limits · guard: apps/relay:rpc-reply-bomb-smoke
└── c4  Treasury — keys never on servers; canonical account pinned in code · guard: config tests
```

## (d) Take over or backdoor an instance

```
GOAL d: run attacker code as root on operator boxes
├── d1  Clearnet `morphit-ops upgrade`
│   ├── d1.1  Compromise the Forgejo primary and publish an unsigned release with its own hash
│   │         stop: FIXED — the tarball must match @morphit's signed on-chain anchor and
│   │               the detached signature is checked against pinned fingerprints
│   │         guard: apps/ops-cli/test/upgradeReleaseAnchor.test.ts
│   ├── d1.2  Compromise the CI runner that holds the release signing key
│   │         stop: FIXED in the workflow — signer keys are no longer read from the tagged
│   │               tree · guard: scripts/release-signer-pin-smoke.ts
│   │         OPTIONAL (one-time repository settings): protect `v*` tags; own runner label
│   ├── d1.3  Mirror serves an older signed tarball — stop: hash must match and be strictly newer
│   │         guard: upgradeIntegrity.test.ts
│   └── d1.4  Tarball escape — stop: `--no-same-owner --no-same-permissions --no-overwrite-dir`
│             · ASSERTED
├── d2  Hidden-only `morphit-ops upgrade`
│   ├── d2.1  Hostile IPFS peer serves a trojan — stop: sha256 against the on-chain anchor
│   │         guard: hidden-upgrade-fetch-smoke
│   ├── d2.2  Forge the on-chain anchor — FIXED: the anchor is signature-checked
│   └── d2.3  Local process fakes the indexer — stop: listener proven from /proc
│             guard: hiddenUpgradeTarget.test.ts
├── d3  Snapshot / fast-sync poisoning — stop: snapshot op agreed by ≥2 operators (counted by
│         node name) and signed by
│         the pinned key; dump sha256; restricted psql in one transaction; code-defining
│         statements refused · guard: snapshot-restore tests
├── d4  Supply chain at install — frontend image pinned by digest; BunkerWeb pinned by tag
│         (1.5.10), not digest; `npm ci --ignore-scripts` with the native modules pinned
│         · residual: tag-pinned images
├── d5  Exposed services — MCP read-only, Kubo API loopback, PostgreSQL loopback
│         guard: postgres-pg-hba-loopback-smoke, mcp-server-read-only-invariant-smoke
└── d6  Service user → root through root units executing a user-writable tree
          stop: FIXED for the indexer and relay — tree root-owned; both run as their own
                users with an empty capability set; a root pre-start helper fixes file modes
          guard: apps/ops-cli:service-privilege-smoke, apps/ops-cli:service-perms-helper-smoke
          OPEN: several monitors and snapshot jobs still run as root
```

## (e) Forge trust

```
GOAL e: fake release, fake trades or reputation, fake chat, fake directory
├── e1  Fake release
│   ├── e1.1  In the browser via one RPC node (fake update, fake tamper alarm, fake green check)
│   │         stop: FIXED — see c1.1
│   ├── e1.2  In indexers — FIXED, see c1.2
│   └── e1.3  For upgrades — FIXED, see d1.1, d2.2
├── e2  Fake trades or reputation
│   ├── e2.1  Sock-puppet feedback — stop: verified-order citation, attestor eligibility (≥100
│   │         BLURT cumulative paid to the canonical treasury, or the launch-phase gate)
│   │         guard: feedback tests · known: Sybil within the launch phase
│   ├── e2.2  Forged blocks (ordinary ops) — known, see c3.3
│   └── e2.3  A stranger makes a seller's client show "paid ✓" and auto-complete
│             stop: FIXED — only the engaged counterparty, against the seller's own ask
│             guard: tradeVerifyGate.test.ts, myOrdersActions.test.ts
├── e3  Fake chat — see a6.1–a6.4
├── e4  Fake directory entries or phishing contact links — stop: origin/alt/contact validation,
│         reserved names · guard: operatorRegisterOrigin.test.ts, operator-tag-reserved-l3.test.ts
├── e5  Fake warrant canary — signed offline by the maintainer; verified with scripts/canary/verify.ts
└── e6  Operator serves a backdoored build with a green integrity check
          stop: none possible in the page — the operator serves the checker. The runtime hash
                check catches accidental or partial tampering only, and the docs say so.
                Users' defence: choose operators, verify the signed release, run their own.
```

## (f) Censor or deny service

```
GOAL f: deny service to users or to the federation
├── f1  Lock out Tor/I2P visitors (every visitor of a zero-clearnet instance)
│   ├── f1.1  Junk signups on the shared hidden-service identity
│   ├── f1.2  List-endpoint flood from Tor Browser
│   │         stop: PARTLY FIXED — shared Tor/I2P keys get 25× the per-client budget and
│   │               a separate stream share; the relay takes a burst slot only after the request
│   │               validates
│   │         guard: ratelimitTrustedProxy "Tor/I2P" cases, relay create.test.ts
│   │         residual: all hidden-service visitors still share one identity
├── f2  Exhaust the QR sign-in registry; drive it cross-origin
│         stop: FIXED — `/wait` holds a stream slot, entries dropped on abort,
│               delivery to an unwaited pid is 404; writes require `application/json` (415)
│         guard: test/api/loginPairingDos.test.ts, scripts/cors-star-smoke.ts
├── f3  Fast-chat intake flood — stop: admission depth and per-signer quotas
│         guard: intake-queue-latency.test.ts · residual: a spread-name flood degrades to chain timing
├── f4  Directory Sybil crowds the fan-out — known (registration is cheap)
├── f5  RPC pool poisoning through forged directory ops — FIXED, see c1.3
├── f6  Signup ceiling exhaustion by a botnet — accepted (absorb and contain)
└── f7  Fake tamper alarms for every visitor — FIXED, see e1.1
```

---

## Leaves still open, ranked

| Rank | Leaf                                                                                       | Goal | Status                                |
| ---- | ------------------------------------------------------------------------------------------ | ---- | ------------------------------------- |
| 1    | e6 operator serves a backdoored build with a green check                                   | e    | by nature; documented honestly        |
| 2    | c3.3 / e2.2 ordinary user ops applied from one node's block                                | c, e | known; consistency sample alarms      |
| 3    | f1 shared Tor/I2P identity                                                                 | f    | PARTLY FIXED                          |
| 4    | d1.2 release runner and tag protection                                                     | d    | optional settings                     |
| 5    | d6 sidecars running as root                                                                | d    | OPEN                                  |
| 6    | f4 directory Sybil                                                                         | f    | known                                 |
| 7    | c1.3 / d3 operator agreement on hidden RPC pools: the default hidden nodes are project-run | c, d | known; the op signatures stop forgery |
| —    | b1.8 MCP on tor-only, d1.4 tarball flags                                                   | b, d | ASSERTED (no test)                    |
| —    | a1.1 ModSecurity audit state inside the BunkerWeb container; d4 tag-pinned BunkerWeb image | a, d | not covered by a test                 |
