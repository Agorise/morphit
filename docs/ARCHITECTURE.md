# Morphit — Architecture

## High-level topology

```
                     ┌───────────────────────────────────────┐
                     │        User device (browser)          │
                     │                                       │
                     │  ┌─────────────────────────────────┐  │
                     │  │    SvelteKit app (SSG + PWA)    │  │
                     │  │                                 │  │
                     │  │  libsodium  WebCrypto           │  │
                     │  │                                 │  │
                     │  │  Encrypted keystore (in-memory  │  │
                     │  │  + localStorage, user password) │  │
                     │  └─────────────────────────────────┘  │
                     └──────┬──────────┬────────────┬────────┘
                            │          │            │
            signed ops      │          │  reads     │  E2EE chat
            (no keys)       │          │  orderbook │  ciphertext
                            ▼          ▼            ▼
        ┌──────────────────────────────────────────────────────┐
        │  nginx (4 vhosts: clearnet / Tor / Lokinet / I2P)    │
        └────┬─────────────┬──────────────┬────────────────────┘
             │             │              │
             ▼             ▼              ▼
      ┌───────────┐  ┌───────────┐  ┌──────────────┐
      │  relay    │  │ indexer   │  │ avatar       │
      │  (Node.js │  │ (Node.js  │  │ static       │
      │   /tsx)   │  │  /tsx)    │  │ (nginx)      │
      │           │  │           │  │              │
      │ broadcasts│  │ REST+SSE  │  │ user-PUT     │
      │ signed    │  │ filters   │  │ to chain     │
      │ ops       │  │           │  │ pubkey-      │
      │           │  │           │  │ committed    │
      │           │  │           │  │ hash         │
      └─────┬─────┘  └─────┬─────┘  └──────────────┘
            │              │  │
            │              │  └────────── gossip ──────► peer indexers
            │              │
            │              ▼
            │        ┌─────────────┐
            │        │ PostgreSQL  │
            │        └─────────────┘
            │
            ▼
   ┌─────────────────────┐
   │  Blurt RPC pool     │
   │  (public, rotated)  │
   │  rpc.blurt.blog     │
   │  blurt-rpc.saboin   │
   │  rpc.beblurt.com    │
   └─────────────────────┘

   Parallel paths (independent of the services above):
   ┌────────────────────────────────────────────────────┐
   │  Fee verifiers live INSIDE the indexer process:    │
   │   - BTC explorer-poll (bitcoinExplorerVerifier.ts) │
   │   - XMR tx-proof verifier (moneroProofVerifier.ts) │
   │   - BLURT direct on-chain (no external verifier)   │
   │  Operator-side (off-monorepo):                     │
   │   - Zabbix or similar — infra monitoring, alerts   │
   │     via the operator's chosen channel              │
   │   - Matrix bridge bot — tracked separately for     │
   │     future iteration (see ADDING-A-COIN.md tail)   │
   └────────────────────────────────────────────────────┘
```

## Data flow — placing an order

1. User composes order in browser.
2. Browser asks for fee payment (BTC / XMR / BLURT), displays address + QR.
3. For BTC/XMR: indexer's verifier polls explorers (or accepts a
   user-supplied tx_proof for XMR) and credits the fee.  For BLURT:
   the indexer sees a `transfer` op directly on the next Blurt block.
4. Browser constructs `custom_json` op (`id = morphit_order_v1`), signs with
   user's active key **in memory only**.
5. Browser POSTs signed op to relay.
6. Relay wraps the signed op in a Blurt transaction paid from the relay's
   RC pool, broadcasts to the Blurt RPC pool.
7. Next Blurt block (~3s) contains the op.
8. Indexer subscribes to Blurt, sees op, inserts into PostgreSQL.
9. Other indexers pick it up via gossip (federation).
10. Browsers polling `/v1/orders` (or subscribed to the SSE
    orderbook bus) see the new order.

**At no point does the relay, indexer, or any server see the user's private
key.** The relay receives a signed op; the signature was produced locally.

## Data flow — chat

1. Sender derives a fresh ephemeral X25519 keypair and computes the
   shared message key via ECDH against the recipient's chat pubkey
   (deterministically derived from their Blurt posting key per
   ADR-0015).
2. The plaintext is encrypted with ChaCha20-Poly1305-IETF using a
   per-message key derived via BLAKE2b. The ephemeral pubkey
   travels in the message header.
3. Ciphertext is published as `custom_json` (`id = morphit_chat_v1`) via
   the posting relay.
4. Counterparty's client reads the op from Blurt, decrypts locally.
5. Indexer, relay, server operators only ever see ciphertext.

## Data flow — feedback

1. After trade completion, each party signs a feedback op with:
   - trade reference (the completion op's ID)
   - role (`buyer` | `seller`)
   - rating + short text
2. Relay broadcasts. Indexer ingests and attaches to both profiles.
3. Feedback is never editable. A response can be posted (as a separate
   signed op) but the original remains.

## Unstoppability layers

1. **Static frontend** (SvelteKit SSG) — any HTTP server can host it.
2. **Multi-mirror** — ships with a list of community frontend hosts;
   auto-failover.
3. **PWA cache** — once installed, works offline / through host outages.
4. **IPFS release** — every release has a stable IPNS address.
5. **Distributable artifacts** — APK, Flatpak, signed tarball on Forgejo
   and mirrored to IPFS.
6. **Blurt discovery op** — tiny on-chain pointer (version + IPFS CID +
   mirror list) makes the current release findable from any Blurt node.
7. **Indexer gossip** — data survives any single indexer outage.
8. **Four transports** — clearnet + Tor + Lokinet + I2P.

No single host, domain, operator, or network is load-bearing.

## Key handling — architectural guarantees

- Private keys **only** exist:
  - in user memory (decrypted, during active signing)
  - in user localStorage (encrypted with Argon2id + XSalsa20-Poly1305)
  - in user-initiated encrypted backup file (downloaded locally)
- Private keys **never**:
  - appear in any `fetch()`, `XHR`, `WebSocket`, or `postMessage()` to a
    remote origin (enforced by CSP `connect-src 'self'` + code review
    checklist)
  - appear in any log
  - appear in any database
  - transit any Morphit-operated server

## Service specifications

### `morphit-relay`

- Runtime: Node.js / TypeScript (tsx), single process under systemd
- Input: signed `custom_json` ops (POSTed by browser), inbound HTTP
  (account create, chat-identity, low-balance refill triggers, etc.)
- Process: validates op is well-formed, wraps in transaction, pays
  resource credits from relay Blurt account, broadcasts to Blurt RPC
  pool.  Maintains a Postgres-backed `relay_pending_transfers` queue
  for welcome bonuses, operator payouts, low-balance refills, and
  account-creation retries; drainer broadcasts queued transfers
  asynchronously.
- Output: Blurt transaction IDs, structured error logs, queue state
- State: shares the indexer's Postgres database (one schema, two
  workspaces) — relay reads the indexer's read models for
  attribution decisions and writes its own queue tables.

### `morphit-indexer`

- Runtime: Node.js / TypeScript (tsx), single process under systemd
- Input: Blurt blocks (pulled from RPC pool, 3s cadence) + peer
  federation gossip (`/v1/federation/...`)
- Process: filters `morphit_*` custom_json ops, normalizes, persists
- Output: PostgreSQL state + REST API at `/v1/*` + Server-Sent
  Events for the orderbook + chat fan-out buses + the federation
  endpoints other indexers consume
- Enforces application-layer rules (3-min replace window, sybil fee
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
  expected sats arrive at the canonical chain-pinned BTC treasury
  address.
- `apps/indexer/src/indexer/fee/moneroProofVerifier.ts` — accepts
  user-supplied `tx_proof` strings carried in the order op,
  verifies against a configured Monero block explorer (no view-key
  required since Part 108++).  See ADR-0019.
- BLURT fees are verified directly: the indexer sees the
  `transfer` op land on chain alongside the order op and matches
  amount + recipient.

### Avatars

Avatars are handled inside the `apps/web` frontend, not by a
separate service.  Users sign a profile-update op committing a
SHA-256 hash of their avatar to chain; nginx (or whichever
reverse proxy is in use) serves the avatar PNG/SVG/JPEG from a
static directory.  The hash commitment is verified browser-side
when the avatar renders — a malicious operator who swaps the
file at the static path can't fool an audit because the chain
record is the source of truth.

## Deployment

Single Ubuntu 24.04 host. All services as systemd units under `/opt/morphit/`,
each as an unprivileged user. Inter-service comms over localhost or
WireGuard. nginx reverse-proxies to the four public endpoints.

Hidden-service daemons (Tor, Lokinet, i2pd) run as unprivileged services,
each with their keys in root-owned, mode-0600 files. Keys generated on
operator hardware and copied to the server; never generated server-side.
