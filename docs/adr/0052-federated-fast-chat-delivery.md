# ADR-0052: Federated fast chat delivery (chat leaves the chain's critical path)

**Status:** Accepted
**Date:** 2026-09-19
**Extends:** ADR-0048 (chat head-block fast path), ADR-0051 (head-block fast path
generalisation) — both stand in full; this adds a second, faster route to the
same emit point and does not remove the first.
**Depends on:** ADR-0008 (indexer architecture), ADR-0048, ADR-0051

## Context

ADR-0048 and ADR-0051 got the *indexer* out of the irreversibility wait: the head
tailer reads the chain HEAD and emits a provisional chat event without waiting
45-63 seconds for `last_irreversible_block_num`. That was the right fix for the
problem it was aimed at, and it holds.

It also has a floor, and the floor is the chain itself. Every hop below is
serial, and the message cannot be delivered until the last one finishes:

| Hop | Cost | Why it is there |
|---|---|---|
| Sender's browser → their instance | 1 hidden-service round trip | the sender is on a `.onion`/`.b32.i2p` instance |
| Instance → RPC node, `broadcast_transaction_synchronous` | up to 3,000 ms | the call **blocks until the transaction is in a block** |
| Block propagates; recipient's instance tails head | up to ~2,000 ms poll | `MORPHIT_INDEXER_FASTPATH_INTERVAL_MS` |
| Recipient's instance → their browser | 1 hidden-service round trip | the recipient is on a hidden-service instance too |

On the modelled hops this release is measured against
(`fastchat-three-leg-smoke.ts`): **~7,250 ms** for the old route. Two people on *one* instance were no better — worse, in fact, because
the federation query that feeds the fast path excluded the instance from itself
(`WHERE ki.origin <> $1`, since normalised). Same-instance chat had **no fast path at all**
and waited on the head tailer: up to **6.8 s** on a privacy-only instance, for
the most ordinary case there is.

The requirement is explicit and it is not a target, it is a definition:

> **Under six seconds. Sending and receiving. Whatever kind of instance either
> person is on. Including the first message of a conversation — the one that has
> to appear in a stranger's inbox as a new chatroom request.**

No amount of tuning gets there through the chain. 3,000 (block) + 2,000 (poll)
alone is 5,000 ms before a single hidden hop, and there are three of those. The
floor is above the ceiling.

## Decision

**A chat message is delivered between instances directly, and is written to the
chain in parallel rather than in front of the delivery.** The chain remains the
only durable record and the only thing anyone's history is rebuilt from; it stops
being the *transport*.

Seven changes, each of which is load-bearing:

### 1. Chat broadcasts asynchronously, when the client asks

`broadcast.ts` chooses its RPC method by what the transaction contains **and by
whether the client asked for the fast answer**:

```
const chatAsync = chatOnly && chatAsyncRequested === true;
const method = chatAsync ? 'broadcast_transaction' : 'broadcast_transaction_synchronous';
```

`chatOnly` is deliberately narrow: **every** op in the transaction must be a
`custom_json` with id `morphit_chat_v1`. A mixed transaction — chat plus anything
else — takes the synchronous path, because the caller of that other op is
entitled to know it landed.

**And the server does not decide alone.** A browser tab can be older than the
indexer serving it: a bundle from before this release calls the generic submit
path, which treats a missing `block_num` as a malformed reply and throws. That
user would watch their chat message be delivered to the recipient and shown to
themselves as a permanent red failure, beside a retry button that posts a second
copy. So the fast answer is something the client ASKS for (`chat_async: true`),
an older client simply never asks, and no combination of versions produces a lie.
Everything else still runs for an un-flagged chat send — the fan-out, the relay
log, local delivery — so an old bundle loses its own acknowledgement speed and
nothing else.

The async call returns `{ id }` and no `block_num`. That is affordable only
because *chat already discards `block_num` at both send sites*; this was verified
in the client before the method was changed, not assumed. The web transport now
has an explicit `ChatBroadcastResult { block_num: null; trx_id: string }` so the
nullability is a type, not a convention, and `chatService` / `settledElsewhere`
were widened to match. `computeTrxId` derives the id locally when the node does
not return one.

This removes up to 3,000 ms from the *sender's* leg, which is the half no
recipient-side work can touch.

### 2. Instances push chat to each other directly

`POST /v1/federation/chat-fast` accepts a signed transaction (`{ trx }`, or
`{ trxs }` for a batch) from a peer instance, over whatever transport that peer
is reachable on — clearnet, Tor SOCKS5, or I2P HTTP proxy. The sending instance
fans out to its peers **before** it calls the chain, not after:

```
if (fastDispatch !== undefined) fastDispatch.dispatchIfChat(trx);
```

so the fan-out and the chain write overlap instead of queueing.

**What makes this safe is that nothing is trusted.** The receiving instance
verifies the pushed transaction's signature against the signer's posting key
before it emits anything. A push is not an assertion that something happened; it
is a *copy of the same signed object the chain will get*, arriving by a faster
road. A forged push fails signature recovery and dies; a replayed push hits the
dedupe. There is no state, no money, and no reputation on this path — it emits
exactly the provisional display event ADR-0051's matrix already permits, and
ADR-0048's invariant #1 — **the fast path never writes the database** — is
untouched and still the thing that makes it all safe. That is not a figure of
speech: a remediation in this release briefly added one write here (a stale
posting key, corrected from the chain), which is an entirely reasonable line to
write and quietly voided the premise. It is now held in memory instead, and
`fastpath-always-on-smoke` greps this module and the intake route as well as the
head tailer, so the next such line fails a test rather than a fact-check.

**The one exception, which this ADR did not state until the post-cut review
(R4).** When the notify gate passes and the recipient has a push subscription,
delivery enqueues the web push: one row in `push_pending`, keyed on the
transaction id under a unique index. It is a notification queue, not message
state — the relay's sender and janitor own it from there, and a message is
enqueued once however many routes deliver it — but it is a write, and the
sentence above said "never". `fastpath-writes-nothing.test.ts` now drives that
case against a real database and asserts `push_pending` is the only table
touched, by one row.

**Which posting key, and why it can be trusted.** The key checked is the one this
instance holds in `accounts.posting_pubkey`. That makes the column
security-critical, and it was not being kept current: it was written once and
never updated. Two fixes, both in the DURABLE indexer, so the fast path still
writes nothing:
- the dispatcher records every `account_update` rotation, and drops any
  in-memory correction it outranks (F27);
- every key recorded before v1.18.0 starts unconfirmed. Migration v61 adds
  `posting_key_reconciled`, and the boot backfill confirms those keys against
  the chain (F37).

Until a key is confirmed, the fast path asks the chain rather than trust it. No
answer means no fast verdict, and the message goes by chain delivery. A leaked
key its owner rotated away from, before or after the upgrade, is never the key
a push is checked against.

Signature verification costs a **measured 4.36 ms** (~229/s/core), which is far
too much to do on the response path at federation scale. So the route does the
cheap half inline — `structuralCheckChatOp`, no crypto, no DB — answers **202**,
and verifies on a worker with a bounded queue (`VERIFY_QUEUE_MAX = 500`) and a
`setImmediate` yield between verifications so the event loop keeps serving SSE.
Measured: **2 ms to answer vs 328 ms inline**.

### 3. Same-instance chat is delivered locally

The federation query excludes self by design, so two people on one instance were
never going to be reached by (2). `broadcast.ts` takes a `localChatDeliver`
callback and hands the located chat op straight to the same emit point the
federation intake uses. One instance, no network, no chain — **527 ms**
clearnet, **1,334 ms** on a privacy-only instance, first contact.

### 4. The notification gate consults the instance's own relay log

This is the bug the whole feature would have shipped with.

The safe-subset gate (`fastNotifyAllowed`) exists to stop strangers from pushing
notifications at people, and it stays — it is the anti-spam protection and it is
worth keeping. But it allowed a push only if the recipient had replied before, or
if the message responded to an order *the recipient owns*, read from the durable
table. Which means the **seller's reply to a first-contact buyer notified
nobody**: the order is the seller's, not the buyer's, and the durable row is
45-63 s behind anyway. The inbox ping still arrived, so a test that watched only
the ping would have been green against a closed browser that stayed silent.

An instance knows something the durable table does not: **who it just relayed a
message for.** `recentOutboundChat` records `(from → to)` when — and only when —
the node has accepted an outbound chat message, with a 15-minute TTL and a 20,000
entry cap. The gate consults it **first**:

```
if (hasRecentOutboundChat(located.recipient, located.signer)) return true;
```

The key is **directional** on purpose. `A → B` does not license `B → A` by
itself; it licenses the reply *to A from B*, which is exactly the conversation A
started. And because the entry is written only after the node accepted the
message, a forged or rejected push records nothing — it cannot mint its own
permission.

### 5. A fast-emitted transaction is not emitted twice

The head tailer will see, seconds later, the very transaction the fast path
already delivered. `fastEmitLedger` records the trx id **only on a real emit** —
not on a drop, not on a could-not-tell — and the tailer skips what it finds
there. `markFastEmitted` sits after the emit in `deliverVerifiedPush` for that
reason; putting it before would silence the tailer for a message nobody received.

The **delivery path reads the ledger too**, not just the tailer. The fast route
can reach the same transaction twice by itself: two peers can both push it, and
an instance whose registered site origin does not match its configured indexer
origin does not recognise its own directory row, so its local delivery and its
own federation push are both live for the same message. The replay memory does
not cover that — it is written inside verification, and local delivery never goes
through verification.

The **TTL is derived, not chosen**: `MAX_CATCHUP_BLOCKS × block interval × 2`, or
twelve minutes. The tailer skips ahead only when it is more than 120 blocks
behind head, so it will scan a block just under six minutes old; a flat five
minutes — the value this shipped with in draft — was *shorter than that*, which
meant a tailer catching up after any stall re-emitted everything the fast path
had already delivered. The two constants live in different modules, because
importing one into the other would be a cycle, and a smoke asserts they still
agree.

### 6. The intake is bounded in every dimension an attacker controls

Everything on this endpoint is reachable without a key, without a valid message
and without an account, so every unbounded quantity is a lever:

- **Signatures per transaction (2).** Each costs a full elliptic-curve recovery
  in a loop that does not yield; unbounded, a single request inside the body cap
  fits dozens of canonical-but-wrong ones, and every one is recovered before the
  transaction is refused. A chat op has exactly one posting auth, so the cap
  costs nothing real.
- **How far in the future an expiry may sit (3 minutes).** Graphene permits an
  hour. Against a ten-minute replay memory, that let a captured message be
  re-pushed long after the instance had forgotten seeing it — wait out the
  memory, push again. The client signs head + 60 s, so the bound is generous.
- **Bytes per outbound batch (200 KB).** A count is not a bound on a request.
  Sixty-four maximum-length messages is a quarter of a megabyte against an
  indexer body cap measured in kilobytes — and batches form only when a peer is
  already busy, so the fast path worked while idle and 413'd itself off under
  exactly the load it exists to carry. The receiving cap was raised to match
  (`/v1/federation`, 256 KB, in `bodyCap` and in all three shipped proxy configs
  — `ops/nginx/web.conf`, `ops/nginx/indexer.conf`,
  `ops/bunkerweb/frontend/nginx.conf`), and a peer
  that refuses the size anyway gets the messages one at a time rather than losing
  them.
- **Its own rate-limit tier.** The limiter keys buckets by `tier:ip`, not by
  `tier:ip:limit`, so two middlewares sharing a tier share one timestamp array
  while each checks it against its own ceiling — and the lower ceiling throttles
  both. On the `resource` tier, where `/v1/broadcast` lives at 600/min, a few
  hundred peer pushes a minute would have 429'd every user write on the instance:
  no chat, no orders, no transfers. Over Tor that is ten requests a second from
  anyone at all, because every caller arrives as `127.0.0.1`.

### 7. A first-contact notification from a peer is metered

The anti-stranger policy is unchanged and deliberately so: a buyer can still open
a conversation with a seller about the seller's own live order, because otherwise
the marketplace does not work. What changed is the **price** of sending one.

Before, every chat message reached its recipient through a block: it cost
resource credits, sat under the chain's own rate limiting, and left a public
record. A message pushed peer-to-peer costs a signature and a POST — free,
unmetered, repeatable, invisible to anyone auditing the chain. The gate did not
change, but a gate sized against an expensive channel is not the same gate on a
free one.

So `fastNotifyBudget` caps unreplied first-contact notifications per
SENDER→RECIPIENT PAIR per minute, on the peer route only. The pair is the whole
design: a budget held per recipient is spendable by anybody, so one hostile
account could empty a seller's allowance every minute and deny the next real
buyer — a control turned into a weapon against the person it protects. Keyed on
the pair, a flooder exhausts only their own channel. a message this instance relayed itself paid
resource credits, and one the head tailer read came out of a block, so both are
already metered and charging them again would throttle legitimate traffic to pay
for a hole they are not part of. Established pairs are exempt entirely — two
people mid-negotiation are not strangers, and a cap that bites hardest during a
busy trade would be worse than none. Delivery into an open chatroom is untouched:
a conversation you are looking at is not a notification.

The live inbox ping is now gated on the same `replayable` verdict the web push
and the cold-start replay already used. It was the one unguarded route into
someone's inbox, which mattered little when a message had to come out of a block
and matters a great deal now that a peer can push one straight in.

### 9. Which peers get one of the bounded fan-out slots

Every message goes to every peer, so the fan-out cost is linear in the peer
count and is bounded at 40. Past that bound some instances get chain-speed chat,
and WHICH ones is a decision rather than an accident. It used to be an accident.

The order was `last_probed_at DESC NULLS LAST` — probe recency, which says
nothing about whether a peer can answer. Two consequences, both backwards. An
instance known to be DEAD, probed a minute ago, outranked a healthy one probed
an hour ago, so slots went to peers that could not take a message. And a newly
registered instance has `last_probe_status = 'never'` with a NULL
`last_probed_at`, so `NULLS LAST` put it below every corpse — the one instance
whose users have no established conversations to fall back on, ranked last.

Peers are now ranked by health: `good`, `quiet`, `syncing`, `clearnet_blocked`,
then `never`, `stale`, `unreachable`, with an unrecognised status sorting with
the failures rather than ahead of the healthy. Ties break by most recently
confirmed, then by longest registered.

- **`clearnet_blocked` sits with the healthy tiers.** It means the peer answered
  nothing over clearnet but is demonstrably alive on chain — a censored
  instance, not a sick one, and a censored instance reachable only over a hidden
  address is the case this whole subsystem exists for.
- **`never` is NOT promoted to the top**, which is the tempting fix for the
  second consequence. Registering an origin is an ordinary on-chain operation,
  so `never` is the one tier an attacker can manufacture in bulk; first place
  would let a burst of junk registrations evict the live federation from every
  peer list at once. It sits in the middle, one probe cycle from proving itself.
  The longest-registered tiebreak is the same defence applied within the tier.
- **The ranking is in TypeScript, not in the `ORDER BY`.** An ordering expressed
  only in SQL can be checked only by reading the SQL — and this release already
  had to replace one test that asserted a source token instead of a behaviour,
  and watched it go red for a change that made the behaviour better. No
  federation today comes near the bound, so this is a rule that will first
  matter on somebody else's deployment years from now with nobody watching,
  which is exactly the kind of rule that has to be executable in a test. The
  query keeps a 500-row scan cap, a memory bound on a table whose size an
  attacker has some say in.
- **The bound reports itself.** `peersTruncated` in `/v1/health` and a
  `peer_directory_truncated` warning say how many instances were left out. Past
  the bound a peer can be healthy, reachable and still on chain timing, and
  nothing else would ever explain it. A silent designed limit is not
  distinguishable from the bug.

### The fan-out is one hop, and the mechanism is an absence

The instance whose user SENT a message fans it out. An instance that RECEIVES
one does not fan it out again — and nothing enforces that beyond
`dispatchIfChat` being called from the broadcast route and from nowhere else.

That absence is worth more than it looks. With forty peers, one message costs
forty pushes; re-dispatching on receipt makes it forty plus forty times forty,
so a single chat line becomes sixteen hundred requests over hidden transports.
It terminates — the replay memory answers `duplicate` on the second round — and
that is exactly what makes it dangerous, because it does not run away. It looks
survivable in a three-instance test and melts a federation of forty under
ordinary load.

It is also an easy line to add with a good reason attached: relay it on, in case
the sender could not reach a peer that we can. The answer is that the chain
already carries that case, durably, and building a mesh is a different design
decision from this one rather than a tweak to the intake route.

Guarded structurally, in `fastpath-always-on-smoke`, because there is nothing
else to guard: the intake route takes no dispatcher, so there is no seam to
drive and no behaviour to observe. The absence IS the property, so the absence
is what is asserted — that the route neither calls `dispatchIfChat` nor holds a
sender of its own.

### Ordering is immune to clock skew, and that is not an accident

A fast-path message carries no timestamp; the receiver recovers one by
subtracting a fixed lead from the transaction's signed `expiration`, and the
transcript sorts strictly by it. That would be fragile if the expiry came from
the sender's clock — two operators whose servers disagree would reorder each
other's messages.

It does not. The client builds the expiry from the CHAIN's head block time
(`getRefBlockInfo`), and every instance reads the same chain. No clock
synchronisation is required anywhere in the federation.

What IS fragile is the lead itself, written in two packages with nothing linking
them. Change one and every fast-path message's recovered time shifts by the
difference — silently, and only against messages that arrived by the other
route, which is the hardest ordering bug to see and the easiest to introduce
while tidying a constant. `chat-expiry-lead-parity-smoke` asserts the round trip
rather than the number, so drift on either side fails.

### Transport: the hidden-service pool

A hidden service costs a **circuit build** (30-60 s cold) for every new
connection, so the pool pins `CONNECTIONS_PER_ORIGIN = 1` and keeps it alive
(4 min idle, 8 min max). This is measured, not assumed: over a real SOCKS5
tunnel a cold first message pays the full circuit build, six further sequential
messages open **no** new tunnels, and the slowest of them costs about **24 ms**.
The claim that actually needs a test is about CONCURRENCY, because a sequential
loop reuses one connection at any pool size — so four concurrent pushes to one
origin are asserted to share the single connection, and at `connections: 4` that
same burst opens **three extra circuit builds** (`M31`).
Origins are warmed every 3 minutes so a real message never pays for a cold
circuit — and the idle keep-alive (4 min) is deliberately LONGER than that gap.
Below it, every warm-up would find a closed socket and rebuild, turning the loop
that removes the cold-start cost into the thing that pays it on a timer; above
Tor's ~10-minute circuit idle, we would hold a connection the network has
already reclaimed. Those two constants live in different files and neither
mentions the other, so the relationship is asserted rather than trusted, against
a cliff first demonstrated at millisecond scale. Lowering the keep-alive to 1 ms
previously left the whole battery green: every reuse check sends its messages
back-to-back, and a socket that never goes idle never tests an idle timeout.

Reuse is asserted on BOTH hidden transports now. Tor had a concurrency check
from the first draft; the I2P leg made a single push, which cannot tell a pooled
tunnel from a rebuilt one — a gap that mattered more once that leg moved to a
connector of ours, since a hand-written connector sits underneath undici's
pooling and getting it wrong costs a tunnel per message without losing a single
one.

**Each network is dialled through a connector we wrote, and that is about
diagnosis rather than control.** Tor has always had a hand-written SOCKS5
connector; I2P now has a hand-written CONNECT one, and Lokinet needs neither
because its tun resolves names directly. The reason is the same in both cases:
the failure has to arrive as something a decision can be made from. undici's
`ProxyAgent` reports a refused tunnel as `UND_ERR_ABORTED` with the status
inside the message text — and `UND_ERR_ABORTED` is also an ordinary abort, so a
router configured to refuse every CONNECT was indistinguishable from a request
that timed out, and was recorded against the PEER. The refusal is now a typed
error carrying the status as a number.

The status is CARRIED, not interpreted. Which status means "I refuse all
tunnels" (ours) and which means "I cannot reach that one" (theirs) differs per
router and has not been verified against a live Java router, so the fault is
classed ambiguous and settled by the corroboration rule in decision 8 — the
same mechanism Lokinet needs, reused rather than re-invented.

This decision had THREE homes — the chat pool, the routing dispatcher and the
probe's own fetch — and all three had to change together. Fixing only the pool
would have left the probe writing `unreachable` across every I2P peer in the
directory, which is worse than the sender losing one message.

### 8. A peer is an instance, not an address

The first version of this chose ONE address per peer when the directory was
read: prefer whatever hidden address the peer had published, and drop the rest.
Nothing asked whether *this* instance could reach the network it had just
committed to.

That is fatal on the commonest configuration there is. A box with no Tor daemon
— which is a fresh install, since the shipped default `127.0.0.1:9050` is
non-empty whether or not anything is behind it — picked the `.onion` of every
onion-publishing peer, discarded the working clearnet origin sitting in the same
row, and failed every push locally in about a millisecond. Federated chat
between those pairs did not degrade; it stopped. The symptom was "chat is
sometimes slow", because every message fell back silently to chain timing, and
the peer count looked perfectly healthy throughout.

So a peer now carries **every address it published that this instance could
plausibly dial**, in preference order, and the choice is made at SEND time:

- **The privacy preference is unchanged.** Hidden addresses come first, for the
  two reasons that always pointed the same way: a zero-clearnet instance has no
  other route, and a clearnet peer reached over its onion keeps this instance's
  network position out of the peer's logs. What changed is that preferring one
  no longer means discarding the others.
- **All four dialable networks are read**, not two: `tor`, `i2p_b32`,
  `i2p_name`, `lokinet`. `ens` is a name, not a transport, and is never dialled.
- **A blanked proxy setting is honoured up front.** It is the only reachability
  fact knowable before anything is tried, because the defaults are non-empty on
  every install.
- **A local transport fault fails over inside the same push.** Making the first
  message of a conversation pay for the discovery would sacrifice exactly the
  message whose latency this whole design protects. A refused local socket costs
  a handful of milliseconds — 11 to 15 across runs — so the fallback is
  effectively free. The smoke holds it under a second, which is the property
  that matters: what must never happen is the failure being WAITED OUT at the
  push timeout rather than detected.
- **A PEER failure does not fail over.** A peer that answered has been reached;
  dialling it elsewhere is not a retry, it is a second delivery.
- **The instance learns once, for all peers.** If our Tor is down it is down for
  every onion in the federation, so the network is marked down for 60 s rather
  than re-discovered per peer per message. The warm-up loop — which runs at boot,
  before anyone has sent anything — is the cheapest detector and feeds the same
  tracker, and any success clears the mark at once.
- **...but only on evidence that reaches the network.** Failing over is about
  THIS message and needs no corroboration. Taking a network away from every
  other peer for a minute is a claim about our own daemon, and on one of the
  three networks a single failure cannot support it. Tor and I2P can: the SOCKS
  connector raises the marker only when our OWN proxy failed or answered the
  greeting wrongly — a dead onion takes the other branch deliberately — and the
  I2P branch matches the address and port we configured. Lokinet's local fault
  is a DNS miss carrying THEIR name, and a stale or mistyped `.loki` record
  produces exactly the `ENOTFOUND` our own router being gone produces. So on
  Lokinet the breaker waits for two DISTINCT addresses inside the window, which
  a router that is really gone supplies in the same batch because it fails every
  address. Without this, one peer's bad chain record moved every other `.loki`
  peer onto the clearnet for a minute — on an instance whose operator chose a
  hidden network. The warm-up loop had the principle written down from the start
  ("one peer's tunnel refusing to build is that peer's problem") and still
  convicted a network on one address when the directory held only one, so both
  paths now call `reportAddressFault` instead of each reaching its own verdict.
  The rule has one owner, which is the only version of it that cannot drift.

  **Amended after the cut (v1.18.0 review, S2): two distinct PEERS, not
  addresses.** A registration may publish two names on one network, and
  `sendBatchToPeer` reports each of them, so one registration with two dead I2P
  names convicted I2P for every instance that tried it. Faults are now keyed on
  `peerKey` (`CORROBORATING_PEERS = 2`). A router that is really gone still
  fails two peers in the same batch.

  **And Lokinet is opt-in (S3).** A `.loki` name is resolved through the system
  resolver, so on a box without lokinet — every box Morphit installs — each
  liveness check and each `.loki` peer lookup went to the ISP's DNS. Unless
  `MORPHIT_INDEXER_LOKINET` is on (default `auto`: on when this instance
  publishes a `.loki`), the indexer resolves no `.loki` name at all: liveness
  reports `null`, `.loki` addresses leave the peer list, and the dispatcher and
  the router refuse them.
- **The mark can never silence a peer.** If every candidate is on a down
  network the peer is attempted anyway; that attempt is how a recovery is found.
- **The queue key is the peer's registered origin, not its current address.**
  Otherwise a peer that failed over would acquire a second send queue and the
  messages in the first would never be pumped again.
- **A recovered fault is still recorded.** A successful failover reports success,
  so without an explicit note the only trace of a dead Tor would be a flag nobody
  reads — an operator would see chat working, a delivery count climbing, and no
  hint that every message to every onion-publishing peer had quietly stopped
  taking the privacy route it was published for.

**The related bug this exposed, in code that predates this release.**
`federationProbe` implemented "never penalise a healthy peer for our Tor being
offline" as `err instanceof ProxyUnavailableError` at a `fetch()` boundary.
`fetch` does not propagate a connector's error — it raises `TypeError: fetch
failed` and hangs the real reason off `cause` — so the branch was unreachable,
and an instance whose Tor stopped would walk its directory writing `unreachable`
across every onion peer in the federation. On I2P and Lokinet the rule had never
been implemented at all, because neither transport raised the marker class.
Both transport entry points now normalise a local fault into that class, and
consumers ask `isProxyUnavailable()`, which walks the chain.

One connection per origin caps a peer at ~0.67 msg/s, and a thousand chatting
users need ~16.7. The answer is **opportunistic batching**, not timed batching:
one push is in flight per origin at a time, and whatever arrives meanwhile
coalesces into the next one (`BATCH_MAX = 64`). A lone message still leaves in
**4 ms** — it waits for nothing — while a burst of 40 crosses in **2 round trips**
(17.9×). A timer would have added latency to the common case to help the rare
one; this adds latency to neither.

**Rate limiting had to be re-thought, not just re-tuned.** Over Tor every peer
arrives as `127.0.0.1`, so a per-IP limit is really a *global* limit: at 240/min
the 241st push in a minute — from any instance in the federation — was refused.
`PUSHES_PER_MIN = 6_000`, and the real protection is the bounded verify queue,
which sheds under load instead of rejecting by identity it cannot see.

## Results

First contact / reply, message → recipient's inbox
(`fastchat-instance-matrix-smoke.ts`, 62 scenarios):

| Sender → recipient | First contact | Reply |
|---|---|---|
| same instance, clearnet | 527 ms | 525 ms |
| same instance, privacy-only | 1,334 ms | 1,309 ms |
| clearnet → clearnet | 199 ms | 191 ms |
| clearnet → privacy-only | 978 ms | 972 ms |
| privacy-only → clearnet | 980 ms | 975 ms |
| **privacy-only → privacy-only** | **1,367 ms** | **1,364 ms** |

Against a 6,000 ms requirement. The worst case — two people on two different
zero-clearnet instances, the case the requirement was written about — has
**4.6 seconds of headroom**.

### The worst case, across the networks it actually runs on

"Privacy instance" is not one network. Morphit runs over three and they do not
perform alike, so a matrix pinned to a single Tor-shaped hop answers a narrower
question than the one the requirement asks. `privacy → privacy` is therefore
walked across a band — it is the case with the least headroom and the only one
with no fallback underneath it:

| Hidden round trip | First contact | Reply | Budget used |
|---|---|---|---|
| 350 ms (a fast Lokinet hop) | 546 ms | 540 ms | 9% |
| 900 ms (a typical Tor circuit) | 1,366 ms | 1,371 ms | 23% |
| 1,800 ms (a typical I2P tunnel pair) | 2,719 ms | 2,715 ms | 45% |
| 2,600 ms (I2P having a bad day) | 3,917 ms | 3,915 ms | 65% |

The band figures are not measurements of those live networks, which nothing in
this tree is in a position to make. They are a range chosen to bracket what
those networks plausibly do, run as real cases against real code.

**Two ceilings, and they land on the same number.** The worst case crosses three
half-hops, so its latency is 1.5 round trips and the 6,000 ms target divides out
to a hidden round trip of **4,000 ms**. Independently, the federation push is
abandoned at `PUSH_TIMEOUT_MS = 4,000 ms`, which bounds the instance-to-instance
round trip whatever the latency budget would allow.

What a transport inside the budget but outside the timeout costs is worth
stating exactly, because it is less than it sounds and worse than it looks. The
message still ARRIVES: the recipient's instance has received and emitted the
push before the sender gives up on the answer. What is lost is the sender's
knowledge of it — the push is recorded as a failure, the delivery accounting is
wrong, and the peer is treated from then on as one that did not take the last
message. A federation that cannot tell delivered from undelivered is a worse
place to be than a slow one, so the timeout is a real ceiling even though it
does not stop the message.

Both numbers are derived from the source at run time rather than written down
here, so they cannot drift apart from the code, and `Q8` lowers the timeout
beneath the slowest band to prove the matrix notices.

**What these numbers are, exactly.** The instances, routes, gates, signatures
and sockets are real; the per-hop latency is MODELLED, at 900 ms for a privacy
hop, 120 ms for a clearnet hop and 400 ms for the Blurt node's acknowledgement.
So this is a measurement of the software under a stated model of the network,
not a measurement of Tor. The old path's ~7.2 s figure is the same model plus a
block interval and a poll interval; it is an illustration for comparison, not a
measurement of the old system, and the smoke now says so.

An earlier draft of this table was wrong, and the way it was wrong is worth
recording. Every assertion was `elapsed < 6000` — a ceiling with no floor — so a
message that skipped a leg entirely passed, and looked good doing it. Adding a
floor (the sum of the hops that case actually has to cross) immediately failed
eight scenarios and found two defects in the test: the federation hop was
modelled in one direction only, so every reply figure was short by half a hop,
and the chain stub returned one transaction id for every message, so the
fast-emit ledger correctly suppressed the second message in each case while the
smoke — which only checked that pings arrived — never noticed. **A number that
is too good is a bug**, and the floor is what says so.

`fastchat-three-leg-smoke.ts` pins the pieces separately: sending leg 1,341 ms,
receiving leg 1,395 ms, delivery with an RPC node stalled for twenty seconds
917 ms (the chain is not on the critical path, so a slow node cannot stall a
conversation), and async 3,409 ms vs block-waiting 6,407 ms across a 3,000 ms
hop.

## Consequences

**Good.** Chat latency stops being a function of block time, poll interval, or
RPC node health. A slow or stalled node delays the *record*, not the
*conversation*. Same-instance chat — previously the slowest case — becomes the
fastest. The notification gate now says yes to the exact conversations it was
always meant to allow, without widening what a stranger can do.

**Cost.** A second delivery route to keep correct, and a real distributed-systems
surface where there was none: dedupe across two paths, per-origin queues, pooled
connections to hidden services, a ledger and a relay log that both expire.
Federation peers now talk to each other on a path that did not exist, which is
new attack surface — bounded by the fact that everything on it is signature-
verified and display-only.

**The risk we are accepting.** A pushed message is provisional in exactly the
sense ADR-0051 defines: it may be shown and then never confirmed, if the chain
write fails after the push succeeded. That is the same annoyance a reorg already
carried, and the durable pass remains the source of truth for history.

Accepting the risk is not the same as hiding it. What the browser does with such
a message is settled in `chatService.ts` and pinned by `neverRecorded.test.ts`
(F29 in the fast-chat audit):

- **The recipient's copy is never removed.** They have read it. Once it has gone
  `NEVER_RECORDED_AFTER_MS` (150 s) without a durable twin, it is marked "Not
  recorded on the blockchain". The window is 60 s to expiry plus 63 s to
  irreversibility, plus margin, timed on the recipient's own clock. The chat
  export says the same on that line instead of "pending". A durable copy
  arriving late clears the mark.
- **The sender is told.** Their own instance delivers every accepted message
  back to them provisionally, so "confirmed" in the sender's view proves only
  that the node took it. After the same window with no durable copy, the
  message becomes failed, with Retry.
- **A retry is recognisably the same message.** It names the attempts it
  replaces in `header.prior_tags`, which the indexer stores opaquely. The
  recipient folds it into the earlier copy only when the tag link **and** the
  decrypted words both match, from the same sender. Its trade side effects do
  not run a second time.

The trade-status side effects of a provisional still run when it arrives. The
latency is the product, a funds-sent claim is verified against the chain
regardless, and that store is memory-only, so a reload converges on the durable
record.

**The risk we are NOT accepting** is unverified data reaching a user. Every
pushed op is signature-checked before it is emitted, and the fast path still
never writes the database — now enforced by a test on all three routes to the
event bus rather than by intention.

**What would invalidate this ADR.** If the fast path ever needs to write durable
state — history, receipts, read markers — the argument collapses in the same way
ADR-0051 says its own would: unverifiable-at-emit-time data would then have
consequences that outlive it, and this must be re-opened rather than patched.

## How this is pinned

Claims here are asserted by tests, and the tests are themselves proven to fail
against the bug they claim to guard (`ops/test/*-harness.sh`, mutation-based):

- `federation-chat-fast-smoke.ts` (113 scenarios) / `federation-chat-fast-harness.sh`
  (M1-M47) — verification, dedupe, batching, shedding, gates, every bound in
  decision 6, the verify worker surviving a database failure, and — new in this
  release — all three hidden transports and the failover between them. The I2P
  leg runs through a real CONNECT proxy against a real origin, which is the
  first time anything in this tree exercised that branch at all; before it, two
  of Morphit's three hidden networks were carried entirely by their resemblance
  to the one that was tested. It also covers the proxy that ANSWERS a CONNECT
  and refuses it, which is what a Java router configured to refuse in-network
  tunnels does.
- `fastchat-three-leg-smoke.ts` (14) / `fastchat-three-leg-harness.sh` (N1-N5) —
  the per-leg budget, the async-vs-synchronous crossover, the mixed
  chat-plus-transfer transaction, and the un-flagged send an older browser makes.
- `fastchat-instance-matrix-smoke.ts` (62) / `fastchat-instance-matrix-harness.sh`
  (Q1-Q8) — the table above with two-sided bands, the worst case walked across
  the four transport latencies, both derived ceilings, the notification gate in
  BOTH directions, and the wire format including `at`.
- `fastPeerAddressing.test.ts` (69) — which address a message actually goes out
  over, given a directory and a set of local daemons, and what happens when that
  address turns out not to work, including the case that decides whether a lost
  ANSWER becomes a duplicate delivery.
- `localTransportFault.test.ts` (38) / `federationProbeLocalProxyDown.test.ts` (16)
  / `chatFastDispatcherWarm.test.ts` (22) — "was that our transport or their
  instance?", which addresses the warm-up opens, and what its verdict teaches
  the sender. The first is asserted against errors produced by dialling a closed
  port rather than written by hand, and that distinction is the point: the bug
  being fixed was a correct-looking `instanceof` written against an error shape
  `fetch()` does not produce, so a hand-built fixture would have been built from
  the same wrong belief and agreed with it.
- `fastchat-transport-harness.sh` (T1-T50) — the mutation harness behind those
  three files and `fastPeerAddressing.test.ts`. It exists because the
  alternative was a paragraph saying the mutations had been watched by hand
  once, which is a claim rather than a guarantee — this ADR had exactly such a
  paragraph about `broadcastTransport`, and the client harness below has since
  retired it too. Its own first run reported five mutations
  as SURVIVED, and they had not survived: the harness symlinked `node_modules`
  wholesale, so `@morphit/hidden-transport` still resolved to the real tree and
  every mutation to that package was applied to a file the tests never read.
  `mutate()`'s found-exactly-once check cannot catch that — the text was found,
  and was replaced. The harness now rebuilds `node_modules` with `@morphit/*`
  redirected into its own copy, and PROVES the redirection took before applying
  a single mutation, because a harness that can be wrong about this is a harness
  whose green means nothing.
- `fast-emit-ledger-smoke.ts` (23) / `fast-emit-ledger-harness.sh` (R1-R8) —
  runs the real `HeadTailer`; no double emit, no silence, both TTLs exercised
  against an injected clock, and the relay log proven not to record a send the
  chain rejected.
- `broadcastTransport.test.ts` (10) / `provisionalTwin.test.ts` (9) /
  `fastchat-client-harness.sh` (C1-C7) — the browser half, which is where
  everything the federation does actually ends up. The first covers the
  BROADCAST contract this release changed, including version skew in both
  directions; the second covers what the browser does when the same message
  reaches it twice, which since this release is the NORMAL path rather than an
  edge case — a peer push, then the durable copy a minute later.
  `provisionalTwin`'s sharpest case is not the duplicate on screen but the
  payload decode behind it: a funds-sent claim recorded against an order a
  second time is a marketplace problem, not a rendering one, and the guard
  against it was a bare `continue` with a comment.
- `neverRecorded.test.ts` (28) / `fastchat-client-harness.sh` (N1-N15) — a
  message the chain never records, on both sides: the sender told, the
  recipient's copy marked and never removed, a retry folded into the attempt it
  resends only on a tag link AND identical words, and a peer unable to use a
  named tag to swallow the other side's message.

  An earlier draft of this ADR said of `broadcastTransport.test.ts` that its
  five mutations "were watched to fail BY HAND … that check does not repeat
  itself and the claim should not be read as if it does." That was honest and it
  is now obsolete: the harness exists, it covers both files, and the claim does
  repeat.
- `globalChatActivityStream.test.ts` — the browser half of the frame contract.
  The indexer smoke asserts the route emits exactly `{ peer, order, inbound, at }`
  with `at: null` on a live ping; this asserts the browser refuses a frame
  missing `order` or `inbound`, and carries a replayed `at` through unchanged.
  Two deliberate exceptions, so the claim is not read wider than it is: `peer` is
  guarded three times over — here, in the store, and again in the listing — so
  removing any one of them changes nothing and an assertion about it would be
  over-determined; and `at` is optional by design, because a live ping has no
  original time to carry. Renaming `order` or `inbound` on either side fails a
  test, which was previously a silent, federation-wide breakage.

Two things about that list are worth stating plainly, because they are the
lesson of this release rather than a detail of it.

**A ceiling is not an assertion.** Every timing claim here was once `< 6000 ms`,
which a four-fold regression passes and a message that never travelled passes
even more easily. They are now two-sided: a result faster than the hops it had to
cross is a failure, and saying so found two real defects in the test itself.

**Every mutation listed above was watched to fail**, and several did not, the
first time. One mutated a reject-code string rather than opening the hole it
described; five checked "did my edit apply?" with a grep that the unmutated file
already satisfied; and five harness needles were matched against the whole
output, including the ✓ lines, so any failure at all satisfied them. A harness
that cannot fail is the same shape of problem as a test that cannot fail, one
level up.
