# Morphit metadata-leak catalog

**Published openly so you can see exactly what Morphit does and does not reveal.**

Privacy is a spectrum. This document lists every surface of Morphit — what it
reveals, to whom, and what you can do about it. It is honest, not
reassuring-by-omission: where a public chain or a server necessarily sees
something, it says so. Many of these properties are checked by smoke tests;
not every line is.

One-line summary: **no analytics, no cookies, no email, no phone, no KYC, no
access logs; your keys and chat plaintext never leave your device; your IP is
held in memory only, for rate limiting.** What remains visible is what a
*public-orderbook, public-chain* marketplace exposes — and that is more than
just the orders: who chats with whom and about which order, read receipts,
blocks and reviews are public too. The tables below list all of it.

---

## 1. What does NOT leak — and why

| Surface | Why it's safe |
|---|---|
| **Your identity** | No email, phone, SMS, KYC, or real name — ever. Accounts are pseudonymous Blurt keys. There is no central account database to subpoena or breach. |
| **Your chat content** | End-to-end encrypted (X25519 + ChaCha20-Poly1305-IETF, a fresh sender ephemeral key per message, sender authentication; `docs/CHAT-CRYPTO.md`). Bodies are unreadable to the indexer operator and to chain observers. **There is no forward secrecy:** your chat key, derived from your posting key, decrypts every message you ever received, so a later posting-key leak exposes them. |
| **Your keys** | Private keys never leave your browser. The project could not decrypt your chats if a regulator demanded it. (The relay's own hot key is encrypted at rest with scrypt N=2^17 + AES-256-GCM, its passphrase sealed to the host — a full disk image opens it.) |
| **Your behaviour** | No Google Analytics, no Hotjar, no Facebook Pixel, no cookies, no third-party telemetry. Fonts and assets are self-hosted (no Google Fonts, no CDNs). |
| **Monero view keys** | No view key exists anywhere in Morphit — no chain field, no API, no env var. XMR fees are proven with the payment's own transaction key (section 3). |

**Federation is the meta-protection:** anyone can run an instance
(`morphit-ops init`, roughly 23 prompts), so you can be the only party that
sees your own server-side metadata.

---

## 2. What DOES leak — and to whom

### On the public chain (anyone reading the Blurt blockchain, forever)

| What | Details |
|---|---|
| **Your orders** | Side, asset, amount range, price model, payment methods, optional region, terms and expiry (floored to the day; the block itself still shows when you posted). Also the **language** you picked in the form (defaults to your interface language) and the **operator tag** of the instance you posted from. The permlink is an opaque `order-…` token, so the asset is not in URLs or feeds. |
| **Listing-fee payments** | A BLURT fee is two public transfers (90% to the operator's fees account, 10% to the treasury) with the memo `morphit-fee:<permlink>`, linking your account to the order and the instance. A **BTC fee** puts the BTC txid in the order op, publicly linking your Blurt account to that Bitcoin payment and its inputs. An **XMR fee** puts the txid and its **tx key** in the order op; someone who also knows your wallet address can use it to find that payment's change output. Pay in BLURT for no cross-chain link. |
| **Chat envelopes** | Sender, recipient, block time, ciphertext size, and — when the conversation is about an order — **that order's permlink, in plaintext** (the indexer needs it for the free-reply rule). |
| **Read receipts** | `morphit_chat_read_v1` is plaintext: whom you read, up to what time, and which order thread. Anyone can see when you read a conversation. |
| **Stranger fee** | Messaging someone you have no thread with costs a fee whose transfer memo is `morphit-stranger:<recipient>`, publicly naming whom you are about to contact. |
| **Blocks** | Block and unblock ops are public: anyone can see whom you blocked. |
| **Feedback** | Ratings, comments and replies are plaintext, signed, permanent; an order-bound review names the order, publicly linking the two accounts to that trade. |
| **Completed orders** | The seller's "complete" op may name the counterparty, publicly linking the two accounts. |
| **Featured-slot bids and attestations** | Feature bids (with their fee transfer) and fee attestations are public ops naming the order and the accounts. |
| **Profile** | Display name, avatar (a data URI), and preferred languages. |
| **Encrypted records** | Your chat folders (Starred/Archived) and synced settings are stored as ciphertext: anyone sees that and when you updated them, and roughly how big they are, not what they contain. Your chat identity op publishes your chat public key. |
| **Trade settlement — BLURT only** | Trades in other coins settle on that coin's own chain, not on Blurt. A **BLURT** trade's payment is an ordinary public Blurt transfer, with the memo the seller asked for. |
| **Timing** | Two accounts acting within seconds of each other can be probabilistically linked. Inherent to any public timestamped log. |

*Take it further:* a fresh account per trade, Tor or I2P, and paying fees in
BLURT break most cross-order and cross-chain linking — but not the chat
metadata above.

### To the instance you use (its operator)

| What | Details |
|---|---|
| **Your IP address** | Seen like any website sees it, unless you use the `.onion` or `.i2p` address. The indexer and relay keep it **in memory only**, for rate limiting: minutes for indexer reads, up to 1 hour for the relay's signup and push limits, up to 24 hours for the daily signup limit (as the /24 or /64 network). It is never written to disk or logged; the shipped web servers keep no access log. (A rare critical nginx error line can still name a client.) |
| **What you read and send** | Every chain read and broadcast goes through the operator's own indexer (`/v1/chain/condenser`, `/v1/broadcast`), so the operator sees which accounts, orders and blocks your browser asks about, and your signed transactions before the chain does. |
| **Push subscription** | If you turn on push notifications, the relay stores your account, your browser's push endpoint URL and keys, one of the 10 UI locales and your muted categories (no IP, no user-agent). That links your account to a browser vendor's push channel, in the operator's database and backups (push rows are left out of backups). |
| **Order views** | Viewing an order adds to a public, unauthenticated count (`{count}` only; no times, no viewer). |
| **Operator-side records** | Operator blocks and their reasons, moderation records, and aggregate counters. |
| **The app itself** | The operator serves the code your browser runs. A hostile operator can serve code that steals keys as you type them; the in-page integrity check runs from that same code. Pick operators you trust, or run your own. |

### To other parties on the network

| Who | What |
|---|---|
| **One public Blurt RPC node** | Your browser's one third-party request: the release check, at most once a day per build (2 requests to 1 node, each possibly preceded by a CORS preflight; one more if the release is old; a second node only if the first fails, serves something that does not verify, or names another version). Each node sees your IP on clearnet, `Origin` (including a hidden instance's address on a plain-http page), `User-Agent` and `Accept-Language`. On a `.onion` page only onion nodes are used, on an `.i2p` page only I2P nodes. |
| **Your browser's push service** | With push on, Google, Mozilla, Apple or Microsoft deliver the encrypted notification and see when you get one. |
| **Other instances (fast chat)** | Before your message is in a block, your instance may push it over Tor to instances a probe has verified; they learn the signed message (all public on chain seconds later) a few seconds early, not which instance sent it. |
| **Your ISP / network observer** | Connection metadata to your instance (who, when, how much). Use Tor or I2P to remove it. |
| **External price sources** | None from your browser: prices are fetched server-side by the indexer. |

### On your own device

| What | Details |
|---|---|
| **Encrypted keystore** | Your keys, encrypted under your password (Argon2id + XSalsa20-Poly1305). |
| **Reload hand-off** | With Remember me on, a reload stashes a ciphertext in `sessionStorage`; its key lives only in the service worker's memory, for 30 seconds. |
| **Order drafts** | Form drafts in `localStorage`, plain text (private keys redacted), kept up to 14 days; locking does not wipe them. |
| **Address-reuse history** | One-way tags only: HMAC-SHA256(per-install salt, asset ‖ address), truncated — never the address, a date or an order. |
| **Other local state** | Account name, display name, language, notification-permission state, cached static assets; for a signed-in account, chat read state, recent chat partners and a profile cache (kept in the tab only for a "just this session" sign-in; nothing about profiles is cached while logged out). Sign Out clears it in every open tab. |

---

## 3. Privacy coins — how far we've gone

Morphit treats **Monero (XMR), Zcash (ZEC), Pirate Chain (ARRR), Dash (DASH),
and Decred (DCR)** as privacy-relevant assets and applies these protections to
all of them:

- **Settlement is off the Blurt chain and peer-to-peer.** The coins move on
  their own chain, wallet to wallet.
- **Opaque order permlinks.** "xmr"/"zec"/"arrr" never appears in the
  permlink, URL, RSS feed, or explorer — only an `order-…` token.
- **Day-floored expiry.** No submit-moment timestamp in the order body (the
  block time is still public).
- **Amount jitter, on by default.** Every shared receive amount gets a small
  random tail down to the coin's smallest unit, so the on-chain amount can't be
  matched to your posted order.
- **Shielded-address-aware validation.** ZEC (`zs1` Sapling, `u1` Unified),
  ARRR (`zs1`), Monero (standard `4…` and subaddresses `8…`) are validated by
  shape without ever requiring or storing a viewing key.

**ZEC, ARRR, DASH and DCR are trade-only** — you can't pay the listing fee
with them (the fee methods are `blurt | btc | xmr`), so their transaction IDs
are never written to the Blurt chain by Morphit.

**Monero's one optional cross-chain touch.** If you pay the listing fee in
XMR, the fee's txid and tx key go into your public order op, so any operator
can verify it (the explorers' `viewkey=` parameter carries this tx key — see
OPERATIONS §40.13). Caveat: someone who also knows your wallet address can use
it to find that payment's change output, so pay from an address you have not
shared — or **pay in BLURT** for zero Monero-to-Blurt linkage. Every instance
asks onion explorers first, over Tor on a fresh circuit per request, so an
onion explorer does not learn which server is checking; a zero-clearnet
instance asks only those (OPERATIONS §40.4a).

**Opt-in privacy tech we surface per coin** (on the `/privacy/{asset}` pages):
PayJoin/CoinJoin for BTC, CashFusion for BCH, MWEB for LTC, PrivateSend for
DASH, CoinShuffle++ for DCR, shielded pools for ZEC/ARRR.

---

## How Morphit compares

| Source | What they collect about you |
|---|---|
| Centralized exchange | Gov ID, address, bank info, login IPs, full trade history, withdrawal destinations, support-chat plaintext, device fingerprints |
| "DEX" with KYC | All of the above + the marketing word "decentralized" |
| Bisq desktop | Tor IP if Tor isn't running; full local trade DB; Tor bandwidth signature |
| Haveno desktop | Same as Bisq + Monero RPC traffic |
| **Morphit** | Public orders, reviews, blocks and chat metadata (who, when, which order, read receipts) on chain; your IP in the operator's memory for at most 24 hours; your push endpoint if you enable push. **No KYC, no analytics, no access logs.** |

---

## Provenance & change policy

This catalog began as the Audit 2026-05 metadata-leak enumeration and was
completed in the 2026-10 audit (read receipts, order permlinks in chat,
stranger-fee memos, blocks, feedback and completion linkage, order language
and operator tag, BTC/XMR fee data, encrypted records, push subscriptions,
address history, IP retention, drafts, fast chat). If you find a surface it
doesn't cover, report it — privately, as `SECURITY.md` describes, if it is
exploitable; otherwise in the public room `#agorise:matrix.org`.
