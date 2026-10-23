# Morphit — Architecture

## High-level topology

```
                     ┌───────────────────────────────────────┐
                     │        User device (browser)          │
                     │  SvelteKit app (static + PWA)         │
                     │  libsodium · encrypted keystore       │
                     │  (Argon2id + XSalsa20-Poly1305)       │
                     └──────┬──────────────────────┬─────────┘
                            │ same origin           │ once a day: release
                            │ (reads, signed txs,   │ check to 2 public
                            │  chat ciphertext)     │ Blurt RPC nodes
                            ▼                       ▼
        ┌──────────────────────────────────────┐  Blurt RPC
        │ edge: BunkerWeb (TLS) → frontend     │  (5 clearnet /
        │ nginx; Tor and I2P reach the         │   7 onion / 7 I2P,
        │ frontend nginx directly              │   by page origin)
        └────┬──────────────────────┬──────────┘
             │ /relay/               │ /v1/, /rss/
             ▼                       ▼
      ┌──────────────┐        ┌──────────────┐     verified peers
      │ relay        │        │ indexer      │ ─── (fast chat push,
      │ own active   │        │ REST + SSE,  │     over Tor only;
      │ key: account │        │ /v1/broadcast│     probes; prices)
      │ creation,    │        │ chain relay  │
      │ bonuses, push│        │ fee checks   │
      └──────┬───────┘        └──────┬───────┘
             │       ┌─────────────┐ │
             └──────►│ PostgreSQL  │◄┘
                     └─────────────┘
             │                       │
             ▼                       ▼
        Blurt RPC pool (6 clearnet + 14 hidden nodes; the
        servers read and broadcast through it)

   Inside the indexer: BTC/XMR fee verifiers (explorers / Monero
   nodes), BLURT fees read straight from the chain, the price feed.
   Optional sidecars: matrix-bot (operator alerts), MCP server,
   host monitors, IPFS (Kubo) seeding the signed release.
```

## Data flow — placing an order

1. User composes order in browser.
2. Browser asks for fee payment (BTC / XMR / BLURT), displays address + QR.
3. For BTC/XMR: indexer's verifier polls explorers (or accepts a
   user-supplied payment tx key for XMR) and credits the fee.  (Since
   v1.20.0, with the treasury xpub / main address pinned, BTC and XMR fees
   are paid to per-order addresses — OPERATIONS §40.12–40.13.)  For BLURT:
   the indexer sees a `transfer` op directly on the next Blurt block.
4. Browser constructs the `custom_json` op (`id = morphit_order_v1`) —
   plus, for a BLURT fee, the fee transfers in the same transaction —
   and signs **in memory only**: with the active key (decrypted just for
   this, then wiped) when a BLURT fee rides in the same transaction,
   otherwise with the posting key.
5. Browser POSTs the signed transaction to its own indexer
   (`/v1/broadcast`), which forwards it to the Blurt RPC pool. The user's
   account pays Blurt's small per-op fee; there is no relay "RC pool".
6. Next Blurt block (~3s) contains the op.
7. Every indexer reads the chain itself, sees the op, inserts into
   PostgreSQL. (Indexers do not gossip orders to each other; the chain
   is the shared source.)
8. Browsers polling `/v1/orderbook` (or subscribed to the SSE
   orderbook stream) see the new order.

**At no point does the relay, indexer, or any server see the user's private
key.** They receive a signed transaction; the signature was produced
locally.

## Data flow — chat

1. The sender's browser encrypts the message with
   ChaCha20-Poly1305-IETF, in one of two envelopes
   (`docs/CHAT-CRYPTO.md` decides which):
   - **v2, chat keys.** A fresh ephemeral X25519 keypair; the message
     key comes from two ECDHs — ephemeral × recipient and sender ×
     recipient chat keys (both derived from Blurt posting keys,
     published on chain) — via BLAKE2b.
   - **v3, posting keys** (v1.21.13). Used whenever v2 is not (for
     example, a peer with no published chat key). A fresh content key encrypts the message once and is wrapped
     for each of the recipient's posting keys that can sign alone (up
     to three), each wrap keyed from ECDHs on secp256k1 posting keys
     (ephemeral × recipient and sender × recipient). The recipient's
     keys come from the indexer's `/v1/account/:account/keys`, which
     answers only when two RPC operators agree (v1.21.14), unless they
     are already pinned.
   The header carries the envelope version and the ephemeral key (and,
   for v3, the posting keys and wraps).
2. The signed `custom_json` (`id = morphit_chat_v1`) goes to the
   sender's own indexer (`/v1/broadcast`), which forwards it to one
   Blurt RPC node — without waiting for a block when the browser asks
   for that (`chat_async`).
3. Three fast routes show it before it is in the durable record. All
   three are display and notification only: they check the op's
   signature against the signer's posting key and the recipient's
   block list, emit on the same in-process event bus, and write no
   message state (ADR-0048, ADR-0052).
   - **Federation push.** The sender's indexer pushes the transaction
     over Tor, one fresh circuit per push, to probe-verified peer
     instances (at most 40) — before the node has accepted it when its
     own check passed, otherwise after. Each peer verifies it again on
     a bounded queue. No Tor configured: no push.
   - **Local delivery.** When both people use the same instance, it
     delivers to its own listeners once the node has accepted the
     message and the signature has verified there.
   - **Head tailer.** Every indexer polls for the next head block
     (every second by default) and emits any chat op in it that no
     other route has already delivered (the fast-emit ledger).
   The browser receives these on two live streams (the inbox activity
   stream and the open conversation), which need a ticket signed by
   the account's posting key (v1.21.14). Whether a fast message may
   also light the inbox, raise a Web Push or be replayed into a
   conversation opened later is a separate, narrower gate. The browser
   collapses a fast copy into its later durable copy by `client_tag`.
4. The durable poller stores the message in `chat_messages` once its
   block is irreversible (45–63 s), after the anti-spam gates
   (stranger fee, no-reply caps). A block holding a chat or inbox op
   is applied only when two RPC operators serve the same transaction
   (v1.21.14). This is the only chat history.
5. Counterparty's client decrypts locally: v2 with its own chat key and
   the sender's pinned chat key; v3 with its own posting key, the
   sender proved when the header's sender key is one of the posting
   keys pinned for them.
6. Indexer, relay, server operators only ever see ciphertext — plus
   the public metadata (who, when, which order, read receipts).

## Data flow — feedback

1. After a trade, a party signs a feedback op (`morphit_feedback_v1`)
   with the order permlink, a rating and a short text. The indexer
   rejects it unless the two had a real two-way chat (2+ messages each
   way over 15+ minutes).
2. It is broadcast through the user's indexer; every indexer ingests it.
   Only a reviewer's latest order-bound review of a trader counts.
3. Feedback is never editable. A response can be posted (as a separate
   signed op) but the original remains.

## Unstoppability layers

1. **Static frontend** (SvelteKit static build) — any HTTP server can host it.
2. **Federation directory** — every instance lists the others
   (`/instances`); a user can switch by hand.
3. **PWA cache** — once installed, works offline / through host outages.
4. **IPFS release** — every release has a content address and a stable
   IPNS name; every instance re-hosts it.
5. **Signed source** — GPG-signed tags and tarballs on Forgejo,
   mirrored to GitHub and Codeberg.
6. **Blurt discovery op** — tiny on-chain pointer (version + hashes +
   IPFS CID + mirror list) makes the current release findable from any
   Blurt node.
7. **Chain as shared source** — every indexer rebuilds the same data
   from the chain, so data survives any single indexer outage.
8. **Transports** — clearnet + Tor + I2P on every guided install
   (Lokinet opt-in).

No single host, domain, operator, or network is load-bearing.

## Key handling — architectural guarantees

- Private keys **only** exist:
  - in user memory (decrypted, during active signing)
  - in user localStorage (encrypted with Argon2id + XSalsa20-Poly1305)
  - in user-initiated encrypted backup file (downloaded locally)
- Private keys **never**:
  - appear in any `fetch()`, `XHR`, `WebSocket`, or `postMessage()` to a
    remote origin (by code and the review checklist; the CSP limits
    `connect-src` to this origin)
  - appear in any log
  - appear in any database
  - transit any Morphit-operated server

## Service specifications

### `morphit-relay`

- Runtime: Node.js / TypeScript (tsx), single process under systemd
- Input: inbound HTTP — account creation (invite + public keys),
  Web Push subscribe/unsubscribe, health.
- Process: creates accounts with its own **active** key (paying the
  chain's account-creation fee plus 4 BLURT starter balance from its
  liquid balance), and pays from a Postgres-backed
  `relay_pending_transfers` queue: welcome bonuses, low-balance dust
  refills and loyalty BP delegations; the drainer broadcasts queued
  transfers asynchronously. Delivers Web Push. It does not broadcast
  users' ops (the indexer forwards those) and it holds no user key.
- Output: Blurt transaction IDs, structured error logs, queue state
- State: shares the indexer's Postgres database (one schema, two
  workspaces) — relay reads the indexer's read models for
  attribution decisions and writes its own queue tables.

### `morphit-indexer`

- Runtime: Node.js / TypeScript (tsx), single process under systemd
- Input: Blurt blocks (pulled from its RPC pool, 3s cadence, plus a
  head-block fast path for chat); signed transactions from browsers
  (`/v1/broadcast`, forwarded to the chain); fast-chat pushes from
  verified peers (`/v1/federation/chat-fast`)
- Process: filters `morphit_*` custom_json ops, normalizes, persists
- Output: PostgreSQL state + REST API at `/v1/*` + Server-Sent
  Events for the orderbook + chat fan-out buses + the federation
  endpoints other indexers consume
- Enforces application-layer rules (15-min replace window, sybil fee
  check, self-trade detection, suppression Signals A/B/C, attestation
  phase eligibility).  Note that `custom_json` ops are protocol-level
  immutable; "edits" are handled as layer-2 `_replace_v1` ops that
  the indexer recognizes within the edit window and ignores outside
  it.

### Fee verification (lives inside the indexer)

There is NO separate payment-watcher service.  Fee verification
runs as modules inside the indexer process:

- `apps/indexer/src/indexer/fee/bitcoinExplorerVerifier.ts` —
  polls configured BTC explorers, marks orders verified when the
  expected sats arrive at the chain-pinned treasury (a per-order
  address derived from the pinned xpub once it is pinned).
- `apps/indexer/src/indexer/fee/moneroProofVerifier.ts` — accepts
  the payment's tx key (`tx_key`, 64 hex) carried in the order op
  (v1.20.0; the earlier OutProof `tx_proof` never verified),
  verifies against a configured Monero block explorer (no view-key
  required since later+).  See ADR-0019.
- BLURT fees are verified directly: the indexer sees the
  `transfer` op land on chain alongside the order op and matches
  amount + recipient.

### Avatars

There is no avatar service. An avatar is part of the user's on-chain
profile: the frontend sanitizes the image (SVG or a small bitmap) and
stores it as a data URI in the profile op, so it travels with the chain
like the rest of the profile.

## Deployment

Single Ubuntu 24.04 host (or a 24.04-based flavour). The code lives in
`/opt/morphit/`, owned by root. The indexer and relay run as their own
users (`morphit-indexer`, `morphit-relay`) with an empty capability set
and `ProtectSystem=strict`; a root pre-start helper fixes the
permissions of their env files and of the relay keystore
(`root:morphit-relay 0640`) before every start. Several host monitors,
the snapshot jobs and the IPFS garbage collector still run as root.
The relay's active key is an encrypted keystore whose passphrase is
sealed to the host's systemd credential key (no TPM); it unlocks
unattended. BunkerWeb terminates TLS and proxies to a frontend nginx
container, which serves the static site and proxies `/v1/`, `/relay/`
and `/rss/` to the host services; Tor and I2P deliver straight to the
frontend.

Hidden-service daemons (Tor, i2pd; Lokinet only if the operator adds
it) run as their own system users. The installer's wizard generates the
onion key (or Tor creates one on first start), so these keys ARE
generated on the server and live there.
