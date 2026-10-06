# Morphit red-team narrative (2026-10)

This replaces the 2026-05 narrative. That one was a paper exercise against
the signup, fee and reputation surface. This one was run against the real
build, served behind the shipped nginx configuration with a real indexer, and
it found the problems that only show up when you read every byte the site
serves. The fixes that followed closed most of them; each day below says
what the attacker found and what the code does now. The
[STRIDE matrix](2026-10-stride-matrix.md) and the
[attack tree](2026-10-attack-tree.md) list the same findings by threat.

Ground rules: the attacker is a capable crew (network, pentest and crypto
people) with a botnet, a CAPTCHA farm, patience, and the willingness to host
a web page and let other people's browsers do the work. They read the AGPL
source and run it locally first.

---

## Day 1: Recon

AGPL means the attacker has the schema, every constant and bound, and the
exact bytes the site serves. They put the shipped web build behind the
shipped frontend nginx configuration and a real indexer in an afternoon, read
`docs/MORPHIT-BRAG-LIST.md` for claims to falsify, and read `docs/audit/` to skip
what is already fixed.

## Day 1b: The first hour of running it

`curl` and one browser session produced a target list without any exploit:

- **nginx version and OS on every response.** The relay's server block hid
  them, but the frontend configuration every Tor and I2P visitor reaches did
  not. _Now:_ `server_tokens off` in every server block, guarded by
  `csp-header-consistency-smoke` and `nginx-served-hardening-smoke`.
- **Host facts in `/v1/health`.** Any anonymous caller got CPU, memory and
  disk totals, free space and uptime: a hardware class and a restart clock,
  exactly what you need to match a hidden service to a candidate host.
  _Now:_ the public body is coarse (status, chain position, lag, RPC and
  relay state); host details come only with a local header that every edge
  strips, guarded by `health.test.ts` and the relay's
  `healthExposure` test.
- **The clearnet brand in every page.** Pages, sitemap, robots.txt, llms.txt
  and the JavaScript named the project's clearnet domain, so a hidden-only
  instance declared it publicly and a shared link made an unfurler fetch
  from it. _Now:_ the JavaScript carries no fixed site origin and uses the
  page's own origin; prerendered pages and the text files record every
  absolute URL, and install, upgrade and `morphit-ops edit` rewrite them to
  the instance's own origin (root-relative on a hidden-only instance). The
  page template names no clearnet domain. Guards: `originSlots.test.ts`,
  `apps/ops-cli/test/instanceOrigin.test.ts`.
- **CORS `*` on the whole API, and an unlimited sign-in wait.** See Day 9b.
  _Now:_ fixed.

## Days 2–6: Signup, fees, reputation, XSS, homographs

The money attacks were re-walked against the running indexer and the source.
The defences hold: fee memos bind to the permlink, external transaction reuse
is checked, the fee floor is re-enforced on replace, Sybil tiers run
sequentially within a block, avatar sanitising is deep, and reserved-name
homographs are caught. The reputation Sybil path remains a modest-cost
partial gap. Since then the attestor gate counts only the canonical treasury
share (≥100 BLURT cumulative paid to the canonical treasury), with a
launch-phase gate that lets aged accounts qualify, and a stranger can no
longer make a seller's client show "paid ✓".

## Day 7: Chat metadata, and cross-visit tracking by an operator

On-chain chat metadata is structural and documented: who, when, which order,
read receipts and blocks are public (`METADATA-LEAK-CATALOG.md`).

As a **hostile operator**, the attacker can keep cookieless anchors on a
visitor across visits: the service worker and its Cache Storage, a
`localStorage` key, and per-visitor `ETag` values on revalidated files. This
is not something the page can defend against: the operator serves the code.
The project's answer is honesty about operator trust: the catalog states that
the operator serves the code your browser runs, and SECURITY.md says to pick
operators you trust or run your own. Account-name and session material left
on disk after sign-out, which the attacker also found, is fixed.

## Day 8: The release pipeline

This was the attacker's highest-value target, and the static reviewers had
found the path:

1. one RPC node forges `@morphit`'s release record for every visitor's
   browser (fee addresses, tamper verdict, download link);
2. indexers apply a forged release or RPC-directory op on one endpoint's word;
3. the two-operator quorum collapses to one after a transient failure;
4. on a clearnet box, `morphit-ops upgrade` trusts the Forgejo primary's own
   hash, and on a hidden-only box, a forged anchor decides the install.

_Now:_ every link is cut. The browser recomputes the transaction id from
the block and recovers the signature to the pinned posting key; a node that
serves anything unverifiable sends it to a second node. Releases are ordered
by their signed version, so an older genuine release is never taken for an
update; a node can still withhold the newest one, which delays the update
notice. Indexers recover the signature of release and directory ops from the
block's own transaction. The trusted quorum stays 2 whenever the pool has two
operators (counted by node name; the default hidden nodes are run by the
project, so on a hidden-only node that agreement is not independent, and the
signatures are what stop forgery).
Clearnet upgrades must match the signed on-chain anchor and the
detached signature; hidden-only upgrades match the signed
`source_sha256`. Guards: `releaseVerify.test.ts`,
`official-op-trust.test.ts`, `rpc-operator-quorum.test.ts`,
`upgradeReleaseAnchor.test.ts`.

What remains: a node can make the browser's check **fail** (nothing is
shown), not pass. And an operator who deliberately serves altered code also
serves the check; the runtime hash check catches accidental or partial
tampering only, and the docs say so.

## Day 9: Federation probe, and drive-by availability

The SSRF and DNS-rebinding analysis holds: registration refuses loopback,
metadata and private addresses, and probes resolve, validate and pin.

The availability attack: the QR sign-in wait had no rate limit and no stream
cap, the registry held 10 000 entries, and because the API answered every
origin, a web page could make **its visitors' browsers** fill the registry,
so every QR sign-in failed. On a zero-clearnet instance, where all visitors
share one rate bucket, that was total.

_Now:_ the wait holds a stream slot under the per-client, shared-gateway and
total stream caps, entries are dropped when the stream closes, and a delivery
to a pid nobody waits on is refused. Cross-origin pages can read GETs
only; every write must be `application/json`, which needs a preflight the
API does not grant for POST. Tor and I2P visitors still share one
identity, but that identity gets 25 times the per-client budget and its own
stream share. Guards: `loginPairingDos.test.ts`, `cors-star-smoke`,
the `ratelimitTrustedProxy` Tor/I2P cases.

What remains: a page with enough visitors can still occupy stream slots, but
only within those caps, like any flood of reads.

## Day 10: Verdict

The input layer was hard from the start: 395 malformed, oversized, Unicode
and prototype-pollution requests produced no 5xx and no stack trace; body
caps, rate limits and header limits fired; nginx and Node refused
request-smuggling framing; path traversal and dotfiles were blocked.

The first run showed that the privacy story had gaps that a paper review
could not see: a version banner and host facts on hidden services, the
clearnet brand in every page, a sign-in that strangers' browsers could take
down, and a release chain that one RPC node could forge. After the fixes:

- the version banner and host facts are gone;
- the release chain is signature-checked at every hop;
- the sign-in wait is capped and cross-origin writes are refused;
- each instance's pages name its own origin, applied at build, install and
  upgrade.

**Where an attacker would look next:**

1. **The operator seat.** An operator serves the code, sees visitor
   addresses in memory, and can track visitors across visits. This is the
   trust boundary, and it is documented as one.
2. **Ordinary user ops from one RPC node's block.** Trust-anchor ops need
   signatures (and agreement between RPC operators, which on hidden pools is
   not independent); ordinary ops are still applied from one
   node's block, and the consistency sample only raises an alarm.
3. **The shared hidden-service identity.** It is softened, not gone.
4. **Directory Sybils** crowding the federation, since registration is
   cheap.

Items the run could not prove either way are listed in the audit's
unproven list: an `ETag`-based cross-visit check, a co-residency oracle
across instances, slow-request exhaustion, and the end-to-end release
forgery against a multi-node fake chain.
