# Morphit metadata-leak catalog

**Published openly so you can see exactly what Morphit does and does not reveal.**

Privacy is a spectrum. This document tells you the truth about every surface
of Morphit — what it leaks, what it doesn't, and how far we've gone to make
Monero and the other privacy coins as private and untraceable as the design
allows. It is honest, not reassuring-by-omission. Everything claimed here is
enforced by code and pinned by CI tests that fail the build if a change ever
weakens it.

One-line summary: **Morphit logs no IP, no analytics, no cookies, no email, no
phone, no KYC; your keys and chat plaintext never leave your device; and your
actual coin settlement never touches the chain Morphit coordinates on.** What
remains visible is the minimum a *public-orderbook, public-chain* marketplace
must expose — and we've stripped that to the bone.

---

## 1. What does NOT leak — and why

| Surface | Why it's safe |
|---|---|
| **Your identity** | No email, phone, SMS, KYC, or real name — ever. Accounts are pseudonymous Blurt keys. There is no central account database to subpoena or breach. |
| **Your trade settlement** | When you trade any coin, the coins move **peer-to-peer on that coin's own chain**, directly between the two wallets. That transfer is never broadcast to, stored on, or visible from the Blurt blockchain Morphit uses to coordinate. |
| **Your chat content** | Chat is end-to-end encrypted (X25519 + ChaCha20-Poly1305-IETF, fresh sender-ephemeral key per message; ADR-0015). Bodies are unreadable even to the indexer operator. Sender-side forward secrecy: a later posting-key leak does not expose past messages you sent. |
| **Your keys** | Private keys never leave your browser. The project could not decrypt your chats if a regulator demanded it. The operator's hot key is encrypted at rest (scrypt N=2^17 + AES-GCM). |
| **Your IP address** | Never logged, written to disk, transmitted, or retained anywhere. The relay uses the client IP only as an in-memory rate-limit bucket that is discarded when the window passes (`apps/relay/src/middleware/ip.ts`). |
| **Your behavior** | No Google Analytics, no Hotjar, no Facebook Pixel, no cookies, no third-party telemetry. Fonts and assets are self-hosted (no Google Fonts, no CDNs). The `order_views` table stores aggregate counts only — never per-viewer rows. |
| **Monero/privacy-coin view keys** | The XMR treasury **view key does not exist on any Morphit indexer** — it was removed entirely (no chain field, no API, no logs, no env var). Fee verification uses Monero's own selective-disclosure `tx_proof` instead (see section 3). |

**Federation is the meta-protection:** because anyone can run an indexer
(`morphit-ops init`, roughly 20 prompts), you can be the only party that sees your own
SSE traffic and point at your own Blurt RPC — removing the entire
server-stored and network-observable surface for your own users.

---

## 2. What DOES leak — and why

Everything below follows from one unavoidable fact: a **federated public
orderbook** has to be readable by every indexer, and "readable by every
indexer" means "readable by anyone." A centralized exchange hides these things
from the public — but only by collecting your ID, address, bank details, IPs,
and full history for itself. We chose the opposite trade.

### On-chain (anyone reading the Blurt blockchain)

- **The order you posted.** An order is an *advertisement*, so its side
  (buy/sell), asset, amount range, payment methods, and optional region are
  public — that is how a counterparty finds you. *What we stripped:* the order
  permlink is now an opaque random token (`order-...`), **not**
  `sell-xmr-usd-...`, so the asset name no longer appears in the permlink, order
  URLs, RSS feeds, or block explorers; the expiry timestamp is floored to the
  day so it can't fingerprint your exact posting moment; and **no IP, timezone,
  language, or browser fingerprint is ever attached** — what you typed in the
  form is all that goes on chain.
- **Chat envelopes.** Sender, recipient, block-time, and ciphertext length are
  visible for each message — but the content is encrypted and unreadable
  (ADR-0015). Ciphertext length is the minimum AEAD chunking allows.
- **Block-time correlation.** Two accounts posting within seconds of each other
  can be probabilistically linked. Inherent to any public timestamped log.
- *Take it further:* a fresh Blurt account per trade (free for new users) + Tor
  breaks cross-order and timing correlation.

### Network-observable (your ISP, or a server you connect to)

Bodies are TLS-encrypted; only connection metadata is visible (who, when, how
long, how much). The four hops are: the indexer SSE streams, the federation
health-probe between indexers, the Blurt RPC endpoints, and the CoinGecko
price API (a generic CORS `Origin` only — no personal data; price data is
display-only and not used for fee math). *Take it further:* run your own
indexer and RPC, or connect over Tor / I2P / Lokinet (all first-class
transports, not bolt-ons), and this category disappears.

### Server-stored (the indexer operator running your instance)

Which account pairs have paid a stranger-fee to chat; operator-written block
reasons (sanitized at intake and render); aggregate view counts. Federation
lets you choose who the operator is — including yourself.

### Client-stored & browser fingerprint (your own device)

localStorage order drafts (wiped on explicit lock), IndexedDB static-asset
cache (never user data), notification-permission state, and the standard
web-platform fingerprint surfaces (audio context, etc.) common to every
website and gated behind explicit opt-in where the browser allows.

---

## 3. Privacy coins — how far we've gone

Morphit treats **Monero (XMR), Zcash (ZEC), Pirate Chain (ARRR), Dash (DASH),
and Decred (DCR)** as first-class privacy assets and applies every on-chain
protection to all of them. The goal is simple: give the privacy-coin
communities nothing to criticize about trading on Morphit or about our use of
a public coordination chain.

**Protections that apply to every privacy coin automatically:**

- **Settlement is off-chain and peer-to-peer.** The actual coins never touch
  Blurt — only the public advertisement and the encrypted chat do.
- **Opaque order permlinks.** "xmr"/"zec"/"arrr" never appears in the
  permlink, URL, RSS feed, or explorer — only an `order-...` token.
- **Day-floored expiry + zero silent metadata.** No submit-moment timestamp,
  IP, timezone, language, or fingerprint on the order op.
- **Amount jitter, on by default.** Every shared receive amount gets a tiny
  random tail down to the coin's smallest unit (piconero for XMR;
  satoshi-scale for ZEC/ARRR/DASH/DCR), so the on-chain amount can't be matched
  to your posted order. (`jitterAmountForAsset` covers all 16 assets.)
- **Shielded-address-aware validation.** ZEC (`zs1` Sapling, `u1` Unified),
  ARRR (`zs1` shielded-only), Monero (stealth/subaddress) are all validated by
  shape without ever requiring or storing a viewing key.

**ZEC, ARRR, DASH, DCR are trade-only — their TxID never appears on Blurt at
all.** You can't pay Morphit's listing fee with them (the `fee_method` enum is
frozen at `blurt | btc | xmr`), and settlement is peer-to-peer, so there is no
point at which their transaction IDs are written to the public chain. For these
four, the on-chain story is *cleaner than Monero's*.

**Monero's single, optional, opt-out-able cross-chain touch.** XMR is one of
three assets (with BLURT and BTC) you *may* use to pay the ~$0.25 listing fee.
If you do, that fee payment's TxID is recorded in your order on Blurt so any
operator can verify it — **using Monero's native `tx_proof` selective
disclosure** (`get_tx_proof`), which proves "this txid paid this address this
amount" and nothing else. **No view key is involved, transmitted, or logged**
(the proof string is per-payment, single-use, and excluded from logs; the
explorer API's confusingly-named `viewkey=` parameter carries this proof, not a
key — see OPERATIONS section 12 / section 40.2). This is the *only* place an XMR
TxID touches Blurt, and it's a fee to a public address, never your trade. **Want
zero Monero-to-Blurt linkage? Pay the listing fee in BLURT** — it's the default
and half the price.

**Additional opt-in privacy tech we surface per coin** (on the `/privacy/{asset}`
pages): PayJoin/CoinJoin for BTC, CashFusion for BCH, MWEB for LTC, PrivateSend
for DASH, CoinShuffle++ for DCR, shielded pools for ZEC/ARRR.

---

## How Morphit compares

| Source | What they collect about you |
|---|---|
| Centralized exchange | Gov ID, address, bank info, login IPs, full trade history, withdrawal destinations, support-chat plaintext, device fingerprints |
| "DEX" with KYC | All of the above + the marketing word "decentralized" |
| Bisq desktop | Tor IP if Tor isn't running; full local trade DB; Tor bandwidth signature |
| Haveno desktop | Same as Bisq + Monero RPC traffic |
| **Morphit** | The public orderbook entries you posted; public chat envelopes (ciphertexts unreadable); aggregate view counts; localStorage drafts on your own device until you lock. **Zero IP logging, zero KYC, zero analytics.** |

---

## Provenance & change policy

This catalog began as the Audit 2026-05 metadata-leak enumeration and is
refreshed every audit cycle. It grows on disclosure, not on time — if you find
a leak surface it doesn't cover, open an issue at
`git.agorise.net/agorise/morphit`. The sealings applied so far include: opaque
order permlinks and day-floored expiry (cp175); chat/orderbook SSE buffer caps;
CoinGecko + federation-probe body caps; CSP `connect-src` allowlist at runtime
and build time; chat-route and backup-keys `noindex`; and the removal of the
XMR fee view key in favor of `tx_proof` verification.
