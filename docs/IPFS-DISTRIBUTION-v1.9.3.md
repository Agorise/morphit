# IPFS + IPNS distribution — v1.9.3 design (self-hosted seed, no commercial pinners)

**Status:** design / not yet implemented. Rewritten after the provider spikes
(2026-07-27) proved that no commercial pinning service works for us on a free
tier. This is the plan to build against — deliberately, when rested. v1.9.2 is
live on the mirror + GPG-signature + on-chain-SHA-256 path, so there is **no
deadline** and **no dead pointer** anywhere on-chain.

> Priorities (unchanged): privacy #1, decentralization #2, grandma-UX #3, tiny
> footprint #4. Hard constraint from Ken: **no paid services, ever — no Pinata,
> Storacha/fil.one, or Lighthouse plans, no crypto, no accounts we depend on.**
> This design honours that: the only host is infrastructure we already run.

---

## 0. What we want

1. A **permanent, public IPNS address** that always resolves to the **latest**
   release (one stable `k51…` name; not an index of all releases).
2. **Pin the latest only**, not the whole history.
3. **Every Morphit instance hosts the latest** over its own Kubo node.
4. **Zero ongoing cost, no third-party accounts.** ← added after the spikes.

---

## 1. Spike findings — why all three commercial pinners are OUT

Ran throwaway tests (2026-07-27) before writing any code. Results:

- **Pinata** — free plan **blocks pin-by-CID**: `pinByHash` on our canonical CID
  returned `{"reason":"PAID_FEATURE_ONLY","details":"You must be on a paid plan to
  pin by CID"}`. Its only free path is `pinFileToIPFS` — the directory-multipart
  upload that **silently produces an empty 0-byte `bafkrei…` object** on our
  (newer, Files/x402-era) account, which is what broke the v1.9.2 attempt in the
  first place. Both free paths are dead ends. **Out.**
- **Lighthouse** — dashboard shows **"14-day free trial" + 5 GB**, i.e. a trial,
  not a permanent free tier. Even if uploads worked, it becomes a paywall in two
  weeks. **Out.** (Also GitHub-OAuth signup, no wallet — but that doesn't change
  the trial limit.)
- **Storacha / fil.one** — mid-rebrand; the upload host **`up.storacha.network`
  does not resolve** for us (only host failing out of six checked — DNS is
  healthy, the endpoint is simply down/moving). Free tier is also "min 30 days
  retention," not indefinite. Unusable now and uncertain later. **Out.**

**Conclusion:** the "replicate across several pinning services" idea does not
survive free-tier reality. That's fine — see §2. The spikes did exactly their
job: killed a bad assumption *before* it reached the release pipeline.

### 1.1 v1.9.2 pin post-mortem (kept for the record)
`release.yml`'s pin step used Pinata `pinFileToIPFS` with bare-named multipart
files (the "assemble a directory" trick). On our account that returns an empty
`bafkrei…` (`NumberOfFiles:1`, `PinSize:0`) — no usable CID → the IPNS step logged
`No ipfs-cid.txt … skipping` → v1.9.2 shipped with no `ipfs_cid`/`ipns_name` (both
schema-optional). `PINATA_JWT` also held a legacy `aNh…` key (not a JWT) — fixed
mid-session, now moot since Pinata is dropped. `MORPHIT_IPNS_KEY` validated GOOD
(real w3name key → the `k51qzi5…nra4c8` name in `apps/web/src/lib/ipns.ts`).

---

## 2. The decision: self-seed with our own Kubo

We don't need a pinning company. **An IPFS CID is deterministic**, so we never
have to "upload" anywhere to get one — we *compute* it, and we host it on
infrastructure we already run.

1. **Compute the canonical CID with Kubo** (the `v0.42.0` we already pin, SHA-512
   `054c38a0…d840d156`). `ipfs add -r --cid-version 1 --only-hash <staged-dir>`
   yields the CID **offline** — no daemon, no network, no account, deterministic.
   CI does this to fill the on-chain anchor's `ipfs_cid`.
2. **Host it on our own seed node** — Ken's release VPS (a Morphit instance
   running Kubo) `ipfs add -r --cid-version 1 <same staged-dir>` to actually store
   + announce it. Same tool + version + files ⇒ **identical CID** (verified equal
   to CI's `--only-hash` value; fail loud if not). That box is the origin + first
   public host.
3. **w3name publishes the permanent IPNS name** (`MORPHIT_IPNS_KEY`) at that CID —
   the `ipns://k51qzi5…` "always latest" pointer. Unchanged tooling; w3name's free
   IPNS publishing is independent of any upload endpoint.
4. **Every instance pins from the network** — the existing
   `ops/ipfs/morphit-ipfs-pin.sh` reads `/v1/release`, gets `ipfs_cid`, and
   `ipfs pin add`s it (fetching from the seed + other instances). Unchanged.

Net: permanent public IPNS + latest-pinned + real decentralization, at **zero
cost, depending on no company.** The load-bearing hosts are the Morphit instances
themselves (grows with the network) + the seed; the git mirrors + on-chain
SHA-256 + GPG signature remain the authenticity anchors.

**Why this is actually better than the pinner plan:** the pinning services were
only ever a convenience seed (a nice always-up gateway URL). Instance-Kubo hosting
was always the real decentralization. Removing the companies removes a dependency
and a cost, and matches the project's ethos.

### 2.1 Proven end-to-end (spikes, cp573) — the model is de-risked
Both halves confirmed live, zero paid services:
- **Self-seed hosting ✅** — `ipfs add -rQ --cid-version 1` of a test dir on the VPS
  (`bafybeibebk6sxb…`) resolved on **`ipfs.io`** and **`dweb.link`** (independent
  public gateways, no pinner). A self-hosted Kubo node IS publicly retrievable.
  Cold content took a retry on `dweb.link` (504→200) — hence the guard rule below.
- **Permanent IPNS ✅** — `scripts/ipns-publish.mjs` published `k51qzi5…nra4c8`
  → `/ipfs/bafybeibebk6sxb…` via w3name; the w3name resolver
  (`https://name.web3.storage/name/<k51>`) returned `"value":"/ipfs/bafybeibebk6sxb…"`
  with validity `2027-07-27` (the ~1-yr record). Name→CID resolves.

### 2.2 DECISION — IPNS stays on w3name (not self-hosted DHT IPNS)
Considered publishing the IPNS record from our own Kubo (`ipfs name publish`, DHT,
no Storacha). **Rejected for v1.9.3.** DHT IPNS records live *hours* and need the
node constantly re-publishing; resolution is slow/flaky. w3name records live ~1 yr
(re-published every release automatically) and resolve reliably through
w3name-aware gateways. **The w3name dependency is soft:** it's only the "which CID
is latest" *pointer* — the content resolves by CID on any gateway regardless, and
releases stay fully verifiable/fetchable via git mirrors + on-chain SHA-256 + GPG
even if w3name vanished (you'd just re-publish the pointer elsewhere). Acceptable
failure mode for a free convenience layer; least-fragile way to get a genuinely
permanent name. (Ken's call, delegated 2026-07-27.) Note: w3name resolution is via
`name.web3.storage` / `w3s.link` / `dweb.link`, **not** native `ipfs.io/ipns/`
(which does DHT-only resolution and 500s on w3name-hosted names — expected).

### 2.3 Guard rule refinement (from the spike)
The reachability guard (§5.3) passes on **the first independent public gateway that
serves the CID**, with backoff — it must NOT require *all* gateways, because a
healthy node routinely has one gateway serve instantly while another 504s on cold
content (observed above). Poll a couple (`ipfs.io`, `dweb.link`), pass on first
success.

---

## 3. Current-tree contract (mostly unchanged)

- **Schema (`packages/release-schema` + indexer handler):** `distribution` accepts
  `ipfs_cid` as CIDv1 (`b[a-z2-7]{58,110}` — `bafybei…` valid) + `ipns_name`
  (`k51…`), both optional; `source_sha256`+`gpg_fingerprint` required together;
  `mirrors` ≤ 8; block ≤ 4096 bytes. **No schema change needed.**
- **Payload builder (`release-build-payload.ts`):** already reads
  `MORPHIT_BUILD_IPFS_CID` / `MORPHIT_BUILD_IPNS_NAME` and emits the block.
  **No builder change needed.**
- **Instance pin (`ops/ipfs/morphit-ipfs-pin.sh`):** already does
  daemon-check → already-pinned? → `ipfs pin add <cid>` (fetch from network) →
  best-effort drop of stale older pins. **Fetch-from-network is unchanged.** The
  only new sibling it needs is a *seed* path (add local files) for the origin —
  see §5.2.
- **Kubo pin (`ops/ipfs/morphit-ipfs-setup.sh`):** Kubo `v0.42.0`, SHA-512
  `054c38a0…d840d156`, `ipfs init --profile lowpower`, systemd `ipfs.service` +
  `morphit-ipfs-pin.{service,timer}`. **This is exactly the tool CI + the seed use
  for the CID.**
- **`/v1/release`** serves `distribution` (migration v53). **No change.**
- **IPNS tooling** (`scripts/ipns-keygen.mjs`, `scripts/ipns-publish.mjs` [w3name],
  `apps/web/src/lib/ipns.ts` hardcoded `k51…` + helpers). **Unchanged.**

**Everything the redesign touches is in `release.yml`, one new seed script + its
`morphit-ops` wiring, two smokes (update) + one new, and operator docs.**

---

## 4. Determinism — the one thing the whole design rests on

`ipfs add -r --cid-version 1` with Kubo defaults (chunker `size-262144` = 256 KiB,
`raw-leaves=true` for CIDv1, balanced layout, sha2-256) is deterministic: same
bytes + same filenames + same Kubo version ⇒ same CID. `--only-hash` builds the
identical DAG without storing/announcing, so **CI's `--only-hash` CID == the seed
node's `add` CID** as long as both use **Kubo v0.42.0** and the **byte-identical
staged directory** (same files, same names). We pin both. As belt-and-suspenders,
the seed step **asserts its `add` CID equals the anchored CID** and fails loud on
mismatch (guards against a future Kubo default change).

Staged directory (identical in CI and on the seed), bare names at root so
`ipns://<name>/<file>` resolves directly:
```
morphit-v<ver>.tar.gz   morphit-latest.tar.gz   morphit-v<ver>.tar.gz.sha256
morphit-v<ver>.tar.gz.asc   RELEASE-NOTES.md   RELEASE-NOTES-v<ver>.md   metadata.json
```

**⚠ The metadata-determinism trap (found + fixed in build):** IPFS hashes content +
filenames, **not** mtimes/modes — so file timestamps don't affect the CID. But a
value *inside* a file does. The old Pinata-era `metadata.json` embedded a live
`released_utc` timestamp; CI and the seed would each generate a *different* one →
different `metadata.json` bytes → different CID → the guard/assert rejects **every**
release. Fix: `metadata.json` now carries **only tag-derived, fixed values** (name,
version, tag, tarball, sha256, repository, release_url, verify_guide) with a
**fixed key order** — no timestamp, host, or random. **Implemented as one shared
script, `ops/ipfs/stage-release-dir.sh <tag> <out-dir>`, called by BOTH CI and the
seed**, so the staging can never drift between them. It also verifies the fetched
tarball against its published `.sha256` before staging. (Written cp572; POSIX,
deterministic, no secrets.)

---

## 5. What changes

### 5.1 `release.yml` — replace the Pinata step with a deterministic CID + IPNS
Remove the "Pin release directory to IPFS (Pinata)" step entirely. In its place:

**Install pinned Kubo (ephemeral, in the runner).** Reuse the exact version +
SHA-512 from `ops/ipfs/morphit-ipfs-setup.sh` (`v0.42.0` / `054c38a0…`). Verify the
checksum before use (same as the instance setup does).

**Compute the canonical CID (offline, deterministic).** Stage via the shared
script (§4), then hash it with the pinned Kubo — no daemon, no network:
```
STAGE="$(mktemp -d)/morphit"; mkdir -p "$STAGE"
sh ops/ipfs/stage-release-dir.sh "$TAG" "$STAGE"      # single source of truth
export IPFS_PATH="$(mktemp -d)"; ipfs init --profile lowpower >/dev/null
CID="$(ipfs add -rQ --cid-version 1 --only-hash "$STAGE")"   # -Q = root CID only
echo "$CID" > ipfs-cid.txt
```
No upload, no secret, no account.

**Publish IPNS (unchanged step, now decoupled from any pinning).** Run
`scripts/ipns-publish.mjs` with `RELEASE_CID=$CID` + `MORPHIT_IPNS_KEY` →
`ipns-name.txt`. (The old "no ipfs-cid.txt → skip" coupling is gone because the CID
is always computed now.)

**Write the anchor (existing step, unchanged logic):** `source_sha256` +
`gpg_fingerprint` always; `MORPHIT_BUILD_IPFS_CID` from `ipfs-cid.txt`;
`MORPHIT_BUILD_IPNS_NAME` from `ipns-name.txt`. Attach `distribution-anchor.env`.

Net effect on the ELI5 ceremony: **Block 4 is unchanged** — it `source`s the anchor
and the payload now carries `ipfs_cid` + `ipns_name` automatically. No Pinata, no
manual overrides.

### 5.2 New: `ops/ipfs/morphit-ipfs-seed.sh` — make the release box the origin host
A small POSIX script (sibling to `morphit-ipfs-pin.sh`) the **seed** runs. It:
1. reads the current release + `ipfs_cid` from `/v1/release` (or takes the tag as
   an arg pre-broadcast),
2. reconstructs the staged directory via **`ops/ipfs/stage-release-dir.sh <tag>
   <dir>`** — the SAME script CI used, so the tree is byte-identical (this is what
   makes the CIDs match),
3. `ipfs add -rQ --cid-version 1 "$STAGE"` → hosts + announces,
4. **asserts the resulting CID == the expected `ipfs_cid`** (fail loud on
   mismatch — the determinism check in practice),
5. optionally `ipfs routing provide` to push the provider record promptly.

`ops/ipfs/stage-release-dir.sh` already exists (cp572, syntax-verified). What
remains for §5.2 is `morphit-ipfs-seed.sh` (the add + assert + provide wrapper)
plus its `morphit-ops` wiring.

### 5.3 The guard — never anchor/broadcast a CID the public can't fetch
Before Block 5 (broadcast), verify the canonical CID **actually resolves on
independent public gateways** (`https://dweb.link/ipfs/<CID>/metadata.json` **and**
`https://ipfs.io/ipfs/<CID>/metadata.json`, expecting `"version":"<ver>"`), with a
few-minute backoff budget. This proves the seed is publicly reachable (see §6). If
it never resolves → **do not broadcast**; fix the seed's reachability first. (This
is the check that would have stopped tonight's dead `Qmb11j…`/empty-`bafkr…`.)
Implement as a step/script run between seeding and broadcast.

---

## 6. The real tradeoff of self-hosting: the seed must be publicly reachable

A commercial pinner was always dialable; our own node might not be. For public
gateways and other instances to fetch the CID, the **seed's Kubo must be reachable
on the DHT** — i.e. **TCP/UDP 4001 reachable from the internet** (public IP or port
forward), and it must announce (provide) its content. Considerations:

- Ken's VPS has a public IP — likely fine, but **the `lowpower` profile limits
  connections/DHT participation**; the seed may need a less-restricted profile or
  `Routing.Type=dhtserver` + `Reprovider` tuned so it announces reliably.
- The **guard (§5.3) is the safety net**: if the seed isn't reachable, the CID
  won't resolve on public gateways and we won't broadcast. So a mis-networked seed
  fails *loudly before* the chain, never silently after.
- **Cold-start / single-seed availability:** if only the seed hosts the CID and it
  goes down before any instance has pinned, the release is unreachable over IPFS
  (mirrors + on-chain hash still fine). Mitigations: the seed stays up long enough
  for instances' timers to pin (minutes–hours); Ken can run the seed on >1 box; the
  guard confirms reachability at broadcast time. Document this as an operational
  expectation, not a flaw — it's the price of owning the infra.

**Open item to verify (spike, §9):** confirm the VPS's Kubo, once set up, is
actually dialable and its CID resolves on `dweb.link`/`ipfs.io`. If a home/NAT box
can't be made reachable, the seed must be a public-IP host (the VPS) — which it is.

---

## 7. Secrets

| secret | keep? | why |
|---|---|---|
| `MORPHIT_IPNS_KEY` | **KEEP** | w3name IPNS publish still used |
| `PINATA_JWT` | **DELETE** | Pinata dropped; nothing references it after §5.1 |
| Storacha / Lighthouse keys | n/a | never added; not needed |

No new secrets. The CID computation + seeding use only the pinned Kubo binary —
no credentials at all.

---

## 8. What does NOT change

Schema / validator / indexer handler; `release-build-payload.ts`; Block 4 / the
ELI5 ceremony (still `source`s the anchor); `ops/ipfs/morphit-ipfs-pin.sh` fetch
model; `/v1/release`; `ipns-publish.mjs` + `ipns.ts` + the `k51…` name; the Kubo
v0.42.0 pin. Contained changes only: `release.yml` (pin step → Kubo `--only-hash`
+ decoupled IPNS), new `morphit-ipfs-seed.sh` + `morphit-ops` wiring, the guard,
two smokes updated (`ipns-release-wiring-smoke` drop the bare-filename/Pinata
assertions; `ipfs-release-hosting-smoke`) + one new (`ipfs-selfseed-smoke`), and
operator docs (`OPERATIONS.md` + `RUN-A-MORPHIT-NODE.md` together;
`VERIFY-YOUR-DOWNLOAD.md`; `ops/ipfs/` notes).

---

## 9. Open questions to confirm at implementation (spikes — don't assume)

1. **Seed reachability:** after `morphit-ipfs-setup.sh` on the VPS, does
   `ipfs add` content there resolve on `dweb.link` + `ipfs.io` within a couple
   minutes? (Tests dialability + announce.) If not, tune the profile/reprovider
   (§6). *This is the new go/no-go gate — the pinner spikes are replaced by this
   one.*
2. **Determinism in practice:** `ipfs add -rQ --cid-version 1 --only-hash` (CI,
   offline) vs `ipfs add -rQ --cid-version 1` (seed, real) on the *same* staged
   dir with Kubo v0.42.0 — confirm identical CID. (Expected yes; the seed step
   asserts it regardless.)
3. **`--only-hash` in a fresh CI repo:** confirm it needs only `ipfs init` (no
   daemon) and emits the root CID cleanly with `-rQ`.
4. **Guard gateway timing:** how long after the seed's `add` + `provide` does
   `dweb.link`/`ipfs.io` serve it? Sets the guard's backoff budget.

Each is a small throwaway test on the VPS + a CI scratch run, done before wiring
the release path.

---

## 10. Implementation order (when rested)

1. **Seed-reachability spike** (§9.1) on the VPS — the gate. If a self-hosted Kubo
   node can't be made publicly retrievable, the whole model needs rethinking, so
   prove it first.
2. **Determinism spike** (§9.2/9.3) — CI `--only-hash` == seed `add`.
3. **Delete `PINATA_JWT`** from Forgejo.
4. **`release.yml`** — remove Pinata step; add pinned-Kubo install + `--only-hash`
   CID; decouple IPNS; keep anchor.
5. **`ops/ipfs/morphit-ipfs-seed.sh`** + `morphit-ops` wiring (§5.2) + the guard
   script (§5.3).
6. **Smokes** — update `ipns-release-wiring-smoke` + `ipfs-release-hosting-smoke`;
   add `ipfs-selfseed-smoke` (asserts: no commercial-pinner refs in release.yml;
   Kubo `--only-hash` present; seed script asserts CID equality; guard present).
7. **Operator docs** (§8).
8. **Version bump** 1.9.2 → 1.9.3 (all 19 version-consistency touchpoints +
   lockfile via `npm install --package-lock-only`, **never** `npm audit fix`) +
   `RELEASE-NOTES-v1.9.3.md`.
9. **Full deep-deep** — 5 persona walkthroughs + full ~563-runner battery in
   ~30–45-runner chunks (re-verify `vitest-must-pass` #204 + `workspace-typecheck`
   #335 standalone) + static audit A–L.
10. **Ship** via the 6 ELI5 blocks — the release now: seeds the CID from Ken's box,
    publishes IPNS, anchors both; instances pick it up. Ken runs the one-time
    `morphit-ipfs-setup.sh` on `/opt/morphit` first so it *is* the seed.

---

## 11. Success criteria

- `curl https://morphit.io/v1/release` shows `ipfs_cid` **and** `ipns_name`.
- `https://dweb.link/ipfs/<cid>/metadata.json` **and** `https://ipfs.io/ipfs/<cid>/metadata.json` both return `"version":"1.9.3"` — publicly retrievable from our own seed, no company involved.
- `https://dweb.link/ipns/k51qzi5…/morphit-latest.tar.gz` downloads the v1.9.3 tarball.
- A second instance running `morphit-ipfs-setup.sh` pins the CID from the network within a timer tick or two (proves instance-to-instance hosting works).
- CI's `--only-hash` CID equals the seed's `add` CID (the anchor matches reality).
- `node scripts/verify-download.mjs` still verifies against the on-chain SHA-256 + GPG (IPFS is additive, never the sole anchor).
- The guard provably refuses to broadcast a CID that doesn't resolve (tested with a bogus CID).
- **Recurring cost: $0. Third-party accounts required: none.**
