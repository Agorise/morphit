# The Morphit Brag List

**Why a peer-to-peer fiat ↔ Bitcoin / Monero / Blurt / USDT / USDC / DAI / Bitcoin Cash / Litecoin / Dash / Dogecoin / Zcash marketplace that's actually non-custodial, actually no-KYC, and actually federated beats every centralized exchange and every fake "DEX" that calls itself decentralized.**

A reference list of 250+ specific things Morphit does — privacy, security, decentralization, Monero-friendliness, anti-Sybil economics, operator independence — written for sharing, citing, and arguing with.

> Keywords: peer-to-peer crypto exchange, P2P Bitcoin marketplace, P2P Monero marketplace, P2P Bitcoin Cash marketplace, P2P Litecoin marketplace, P2P Dash marketplace, P2P Dogecoin marketplace, no-KYC exchange, non-custodial DEX, federated marketplace, Blurt, USDT P2P, USDC P2P, DAI P2P, BCH P2P, LTC P2P, DASH P2P, DOGE P2P, ZEC P2P, Zcash, zk-SNARKs, shielded transactions, Sapling, Orchard, Unified Address, MakerDAO, Circle USDC, Tether USDT, PrivateSend, CashAddr, Litecoin bech32, Litecoin MWEB, Dash PrivateSend, Dogecoin merge-mined, Monero subaddress, amount jitter, view key privacy, AGPL crypto exchange, censorship-resistant trading, Tor onion service, I2P b32 service, Lokinet, Nostr, GrapheneOS, F-Droid, Aptoide, decentralized orderbook, on-chain reputation, end-to-end encrypted chat, on-chain chat ciphertext, STRIDE threat model, reproducible build, multi-explorer attestation, mempool.space, xmrchain.net, blockchair.com, sock-puppet detection, Sybil-resistant, privacy guides, kycnot.me

---

## Table of Contents

1. [Free, fast, and friction-free](#1-free-fast-and-friction-free)
2. [Privacy by design (not by promise)](#2-privacy-by-design-not-by-promise)
3. [Security and audits — receipts, not slogans](#3-security-and-audits--receipts-not-slogans)
4. [Real decentralization, not the marketing kind](#4-real-decentralization-not-the-marketing-kind)
5. [Non-custodial, honestly](#5-non-custodial-honestly)
6. [For Monero users specifically](#6-for-monero-users-specifically)
7. [For Bitcoin users specifically](#7-for-bitcoin-users-specifically)
8. [Reputation, trust, and chat that survives the platform](#8-reputation-trust-and-chat-that-survives-the-platform)
9. [Anti-spam and anti-Sybil (without surveillance)](#9-anti-spam-and-anti-sybil-without-surveillance)
10. [Open source and transparent (with receipts)](#10-open-source-and-transparent-with-receipts)
11. [Internationalization done right](#11-internationalization-done-right)
12. [Pro-Monero culture, not just compatibility](#12-pro-monero-culture-not-just-compatibility)
13. [Honest comparisons (CEX, fake DEX, P2P)](#13-honest-comparisons-cex-fake-dex-p2p)
14. [What Morphit deliberately does NOT do](#14-what-morphit-deliberately-does-not-do)
15. [Reach: every device, every network](#15-reach-every-device-every-network)
16. [Built-in tools — block explorer, activity stats, payment QR codes](#16-built-in-tools--block-explorer-activity-stats-payment-qr-codes)
17. [Trade anything — barter, cash, precious metals](#17-trade-anything--barter-cash-precious-metals)
18. [Operator setup — even your grandma can run a node](#18-operator-setup--even-your-grandma-can-run-a-node)

---

## 1. Free, fast, and friction-free

1. **Signup is free to the user.** No credit card, no bank link, no fee, no deposit. The operator's relay account pre-mints Account Creation Tokens (ACTs) at ~100 BLURT each in a weekly batch ceremony, then consumes one ACT to create your account on-chain — so you join cost-free, and the operator's hot wallet is never sized to the daily signup rate. (See ADR-0010 §4 for the key-custody rationale.)
2. **No KYC, no ID, no selfie, no proof of address, no nothing.** You submit your cryptographic public keys and your desired username. That's the entire signup.
3. **No email required. No phone number or sms. No identity verification.** No "for legal reasons we need..." — none of it. The system literally cannot ask for those things because nowhere in the architecture is there a place to store them.
4. **Listing fee is roughly $0.12 per order.** A trade on a centralized exchange costs more in spread alone.
5. **Send a chat message to a stranger for ~$0.01.** Welcome to a marketplace where contacting a counterparty costs less than a stamp. Spammer/solicitor filters are also built-in.
6. **Three-second block confirmations.** New orders show up in the orderbook in three seconds — fast enough to prevent the eBay-style last-second sniping that plagues some other P2P platforms.
7. **No transaction-fee auctions.** No gas wars. No priority-fee arms races. Listing fees are flat (with a Sybil-tier multiplier for spammers, see §9).
8. **First buy of BLURT is free.** New users get a one-time waiver on their first listing fee, which puts real BLURT in their wallet so they can post and participate from day one.
9. **No deposits.** Nothing to "fund" before trading. You hold your own coins; you trade when you want.
10. **No withdrawal fees.** Because there's nothing to withdraw FROM. Trades settle peer-to-peer between you and the counterparty's wallets, not through an exchange custody account.

## 2. Privacy by design (not by promise)

11. **No cookies. No analytics. No logging.** The footer says it because it's true, not because the lawyers wrote it.
12. **We do not get, store, log, transmit, or otherwise touch your IP address.** Period. Zero. The relay extracts the client IP only as a rate-limit bucket key in memory; it's never written to disk, never logged, never sent anywhere, and the in-memory entry is discarded as soon as the rate-limit window passes. The source code (`apps/relay/src/middleware/ip.ts`) carries this as a binding contract — adding IP logging would require a security advisory and an ADR.
13. **We encourage VPN, Tor, Lokinet, and I2P access.** Anything that hides your IP from the server you're talking to is a good idea. Our anti-abuse defenses are deliberately designed not to punish privacy-conscious users — rate limits are coarse, easy to evade with a VPN rotation, and we accept more abuse rather than make privacy-conscious users feel unwelcome. The Tor `.onion`, I2P b32, and Lokinet endpoints are first-class citizens, not afterthoughts.
14. **No central key store.** Your Blurt private keys never leave your device. There's no key database for anyone — including a future-bankrupt operator — to leak.
15. **No session cookies.** No login state on the server. No session hijacking class of vulnerability because there are no sessions.
16. **No password reset emails.** Because there are no passwords stored. You hold your own keys; the project can't forget what it never knew.
17. **End-to-end encrypted (E2EE) chat.** Buyer-seller conversations are encrypted on your device, then stored on the Blurt chain as ciphertext. Not even the indexer can decrypt them.
18. **End-to-end encrypted (E2EE) chat uses per-message ECIES (X25519 + ChaCha20-Poly1305-IETF, libsodium primitives).** Each outbound message generates a fresh sender ephemeral key that's wiped after one use — that gives you sender-side forward secrecy: even if your posting key leaks later, an attacker cannot decrypt messages YOU sent in the past. We're honest about the tradeoff: the receiver's long-term chat key is stable until you rotate your posting key, so we don't claim per-message receiver-side forward secrecy. Full design + tradeoff rationale in `docs/adr/0015-chat-crypto.md` and the `forward_secrecy` FAQ entry.
19. **Deliberately NO Double Ratchet — and we'll defend the choice.** The Signal-style Double Ratchet protocol gets a lot of (deserved) press for forward secrecy and post-compromise security in messengers, but we evaluated it against Morphit's actual threat model and explicitly rejected it. Two reasons: **(a)** the realistic compromise scenario for a Morphit user is "your Blurt posting key leaks" (lost device, malware, weak passphrase) — and a posting-key leak lets the attacker re-derive every chat key you've ever held, which defeats forward secrecy and post-compromise security regardless of how clever the ratchet is; **(b)** shipping a full ratchet implementation means a ~2 MB WASM crypto bundle, which would more than double Morphit's first-load size and meaningfully hurt access on slow connections (mobile data, Tor, low-end hardware). What we ship instead is a layered defense designed for our actual threats: **per-message ECIES with a fresh sender-ephemeral key wiped after one use** (gives sender-side forward secrecy without the WASM overhead), **chain-anchored TOFU pinning** that detects any attempt to swap out a peer's chat key after first contact, and **opt-in out-of-band 8-word fingerprint comparison** that closes the first-contact MITM window for users who want belt-and-suspenders. Each layer is covered by smoke tests; each tradeoff is documented in `docs/adr/0015-chat-crypto.md`. This is what "secure messaging tuned to a specific threat model" looks like — not "use the most-marketed protocol regardless."
20. **Opt-in out-of-band fingerprint verification ("Verify peer").** For users who want belt-and-suspenders MITM protection beyond the chain-anchored TOFU pin, the conversation menu has a "Verify peer" item that computes an 8-word fingerprint from your chat keys, derived locally on your device with the PGP word list (deliberately NOT BIP39 — we don't want users mistaking it for a seed phrase). Compare with your counterparty via voice call or in person. Hidden by default, no badge, no nag, no telemetry — most users will never see it. Power users get the protection that the rest of secure-messaging research calls "safety numbers" without imposing the friction on everyone.
21. **Private E2EE chat history is permanent and verifiable.** Stored on chain forever, signed, timestamped. The immutability matters for posterity (your trade record can never be deleted by a bankrupt operator), for legal recourse (an unredactable contemporaneous record is courtroom-grade), and for reputation integrity (counterparties can't quietly delete inconvenient threads to manipulate their feedback story).
22. **No Cloudflare.** The project deliberately rejects Cloudflare and similar centralized reverse-proxy services that intercept all user traffic at TLS termination.
23. **No Google Analytics, no Facebook Pixel, no Hotjar, no LogRocket.** No third-party trackers, full stop.
24. **No third-party CDN for fonts or scripts.** Everything self-hosted; your browser doesn't phone home to Google Fonts when you load a page.
25. **The frontend has a strict Content-Security-Policy.** No external scripts, no inline event handlers, no `eval`, no dynamic code paths.
26. **The relay only speaks to pre-configured Blurt RPC endpoints.** No SSRF. No "fetch a URL the user supplies" code paths.
27. **Scans your text for accidental private-key disclosure.** When you type into a chat or feedback box, Morphit scans the text for WIF keys, 64-character hex, and 12/24-word seed phrases. If detected, it warns you in red. If you ignore the warning, it truncates the key client-side before it leaves your device. Keep your private keys private!
28. **Profile fields don't require real names.** Use a handle. Use anything. Profiles are decoration over a cryptographic key "identity". Be as anonymous as you want to be.
29. **Sharing your public address goes through a privacy-aware modal.** Not just a copy-paste field — a flow that asks about subaddress preferences (XMR), amount-jitter (every transparent asset: BTC/BCH/LTC/DASH/BLURT/XMR plus the centralized stablecoins USDT/USDC and the partly-decentralized stablecoin DAI where amount-correlation linkability is a separate, independent threat from the issuer-freeze concern those assets already carry), client-side address-reuse detection (warns when you're about to share an address you've shared from this device before), and optional PayJoin (BIP-78) endpoint for BTC. Untraceability is the mission.
30. **Amount-jitter on every transparent chain.** Shipped XMR-only in beta-alpha; cp26 extends to BTC, BCH, LTC, and BLURT; cp27 extends to DASH. Default ON. Adds a small random extra (≤ 999 satoshis for UTXO chains, ≤ 99 milliblurt for BLURT) to defeat amount-correlation between your order-book post and the on-chain transfer. The "exact 0.00513924 BTC" giveaway becomes "approximately 0.00513924 BTC, with a small random tail your buyer absorbs." Trivial cost; significant chain-analysis defeat.
31. **Client-side address-reuse warning.** When you paste or type a receive address you've previously shared from this device, the address-share modal surfaces an amber chip with the date of the prior share (and the previous order permlink, if available). **Pure localStorage — never transmitted to any Morphit server.** Server-side reuse tracking would be a privacy regression; on-device only is the right shape. Per-device limit: 200 entries (rolling buffer).
32. **PayJoin (BIP-78) support for BTC.** The address-share modal has an optional PayJoin endpoint field on the BTC tab. When the seller's wallet supports BIP-78 and pastes its endpoint URL there, Morphit relays it in the `bitcoin:` URI as the `pj=` parameter. Buyer wallets that support PayJoin negotiate a cooperative transaction with the seller — breaking the common-input-ownership heuristic that chain analysis depends on. Wallets without PayJoin support ignore the parameter and fall back to a normal payment: zero footgun. Morphit doesn't host the endpoint; sellers bring their own.
33. **Per-asset privacy guide pages.** `/privacy` (index) lists every Morphit-tradable asset with a one-line privacy summary, linking to per-asset deep-dives at `/privacy/{asset}`. Each guide covers fresh-address advice (asset-specific), opt-in privacy tech (MWEB for LTC, CashFusion for BCH, PrivateSend for DASH, CoinJoin + PayJoin for BTC), universal practices (Tor broadcast, coin control, avoiding KYC touchpoints), what NOT to do, and asset-specific caveats. Registry-driven — the next asset Morphit adds gets a guide automatically by populating one struct field.
34. **No wallet recommendations.** Even reputable wallets have been compromised or have had hidden flaws. The privacy guides describe protocol standards (MWEB, CashFusion, CoinJoin, PayJoin) by name and capability so users can find their own wallet — but Morphit deliberately does not endorse, recommend, or list specific wallet software. Your wallet, your responsibility.

## 3. Security and audits — receipts, not slogans

35. **Several thousand self-checking smoke scenarios across ~150 runners** ship with the source code. Run them yourself: `bash scripts/run-smokes.sh` (and triple-pulse it for flake filtering). They cover the indexer, relay, ops CLI, frontend bus, payments, federation probe, fee verification, chat encryption, and more.
36. **A running audit document** (`docs/AUDIT-2026-05.md`) — currently 20,000+ lines across 60+ numbered parts, organized by date and subsystem, listing every security review pass, every finding, every severity rating, every fix or accepted-risk rationale. Public, in the repo, anyone can read it. Plus per-batch audit files in `docs/audit/` (Batch I YubiKey unlock, Batch J release trust anchor, Batch K block explorer, Batch L payment methods).
37. **STRIDE threat-model methodology** applied per audit pass: Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege — a matrix run over every changed subsystem, with attack trees built from the most attractive entry points.
38. **Adversarial red-team narratives.** The audit doc names hypothetical attackers (a doxxing journalist, a federated phisher, a sanctions evader, a reputation-launderer) and walks through what each would actually do to the system. Defenses are designed against the playbook, not against generic "bad actors."
39. **AUTOMATION-AUDIT.md** — separate document covering the build pipeline, dependency hygiene, and supply-chain attack surface.
40. **REVISIT-LIST.md** — public list of every accepted-risk item or deferred fix, with full context. Nothing falls through the cracks; nothing is hidden in a private bug tracker.
41. **AUDIT-FINDINGS.md** — historical findings catalog, severity-tracked.
42. **PHASE-F-AUDIT.md, PHASE-G-PREP-AUDIT.md** — phase-specific deep-dive audit reports.
43. **Threat-model assumes the attacker has read every line of code.** The codebase is AGPL-3.0; this assumption is realistic, and designing for it is what makes the system actually safe.
44. **Reproducible builds.** Every release tarball can be rebuilt byte-for-byte from its tagged commit. The build script publishes a `verify.json` containing per-file SHA-256 hashes; the same manifest is recorded on the Blurt chain via a `morphit_release_v1` op.
45. **On-chain release attestation.** Every Morphit release's bundle hashes are broadcast to the Blurt blockchain. Your browser can verify that the page you're loading matches the manifest the project published — independent of the operator's word.
46. **Two independent verification paths**: (a) GPG signature on the source tarball, (b) on-chain hash manifest on the running bundle. If either is wrong, escalate; if both match, trust.
47. **SHA-256 + SHA-512 + GPG signatures** on every release, via the `release-sign.sh` script. Operators can verify that their downloaded source matches what the project published.
48. **No PHP, no WordPress, no XML-RPC, no OAuth, no Express middleware sprawl.** Whole vulnerability classes that plague other platforms simply don't apply here.
49. **No `eval`, no `Function()`, no dynamic-code paths anywhere.** The CSP enforces this; the codebase is clean.
50. **Strict CORS allowlists** on every API endpoint. No promiscuous `Access-Control-Allow-Origin: *`.
51. **64 KiB request body cap** on every endpoint. No "send us a 500 MB JSON and watch our server fall over" attacks.
52. **Per-IP rate limiting** at the indexer's middleware layer: 120 req/min for list endpoints, 600 req/min for single-record lookups, both operator-tunable. The IP is used as an in-memory bucket key only — never logged, never persisted.
53. **Schema-validated request bodies** via Zod with bounded field lengths. Malformed input never reaches handler code.
54. **No SQL string concatenation.** All queries are parameterized; SQL injection isn't a thing here.
55. **Constant-time comparisons** for invite tokens and HMAC verification, to defeat timing oracles.
56. **Signed, short-lived (10-minute) invite tokens.** A cryptographic hash of the requesting IP is included inside the signed token to prevent trivial cross-IP replay — but the IP itself is never logged or persisted; only the hash exists, only inside the token, only for the 10-minute TTL. After that the hash is gone with the token.
57. **Altcha proof-of-work challenge** on the Nth invite per user per day. Frictionless for honest users, expensive at scale for spammers.
58. **Global daily ceiling** on signups, configurable per operator. Caps worst-case Sybil drain regardless of how many IPs an attacker controls.
59. **Operator-balance scanner** alerts when the relay's BLURT balance approaches zero, so the operator can refill if desired before signups stall.
60. **Federation probe** auto-discovers other Morphit instances and tracks their health (good / quiet / stale / unreachable / mismatch / never).
61. **YubiKey unlock support** for the local key vault on supported browsers (ADR-0017).
62. **Optional secp256k1 key isolation** via local hardware token; private keys never enter the page's JavaScript heap when this mode is on.
63. **Matrix-only security disclosure channel** at `@agorise:matrix.org` — end-to-end encrypted (E2EE) by default, no email-in-cleartext disclosure path.

64. **Operator kill-switch for compromise scenarios.** A relay-side flag operators can flip if their instance is breached or hijacked — disables signups, blocks fee writes, and surfaces a banner instructing users to switch to a different Morphit instance. Combined with the federation probe (every instance discovers others automatically), a compromised operator can stop the bleeding while users keep trading on any other node within seconds. Code lives at `apps/relay/src/policy/killSwitch.ts`; runbook at `docs/BETA-INCIDENT-RUNBOOK.md`.

65. **Push subscriptions are proof-of-ownership protected.** Only the holder of your posting key can subscribe a device to receive your push notifications. The relay rejects subscribes without a valid signature over a canonical message binding three things: your account name, the specific browser-issued push endpoint, and a fresh timestamp. Captured signatures expire after 5 minutes and cannot be replayed against a different account or a different device. The contract is defended by a runtime cross-check smoke (11 scenarios at `apps/relay/scripts/canonical-message-cross-check-smoke.ts`) that exercises every documented rejection reason.

## 4. Real decentralization, not the marketing kind

66. **Federated orderbook over a public blockchain.** Orders live on the Blurt chain. Any operator running a Morphit indexer sees the same orderbook in real-time, and a buyer on one instance sees orders posted through any other instance — each operator's frontend is its own brand and URL, but the data layer is shared. Multiple indexers cross-verify each other.
67. **No central server to attack.** Take down a Morphit website and the federation continues; a buyer just opens another operator's URL.
68. **No central database to subpoena.** The orderbook isn't IN a database; it's ON the public Blurt chain. Subpoenas aren't a useful attack here.
69. **No single point of failure.** Operators come and go; the chain is permanent.
70. **Federation directory built into every instance.** Visit `/instances` on any Morphit URL and see a list of every other known instance, their alt-network addresses, and their health status.
71. **Reachable over Tor.** Onion services are first-class; instances commonly publish a `.onion` address alongside their public hostname.
72. **Reachable over I2P.** Instance directory tracks `.b32.i2p` addresses; the federation probe tries them.
73. **Reachable over Lokinet.** Same for `.loki` addresses. Different threat model than Tor; sometimes faster; an option, not the only path.
74. **Reachable over Nostr.** Operators can publish their pubkey as an alt-network channel for users who prefer that ecosystem.
75. **No registrar, no domain auth, no DNS dependency required.** A Morphit instance can run on `morphit.local`, on `.onion` only, on `.loki` only — DNS is a convenience, not a requirement.
76. **Anyone can run a node.** Pick a domain (or skip the domain), clone the repo, run the setup script, broadcast a `morphit_operator_register_v1` op. You're in the federation. No application, no permission, no central listing.
77. **Operators get 90% of BLURT-paid fees on their instance, paid immediately, per-order.** Real revenue model, automated on-chain split, operator-direct payment with no project skim. The relay queues a `transfer` op the same transaction the order op is indexed in; total wall-clock latency from user "Post" click to BLURT landing in the operator's wallet is typically 10-15 seconds. Not "we'll Venmo you next month" — closer to a card-processor's instant settlement, except non-custodial. (BTC/XMR fees go 100% to project treasury for ecosystem support documented in `docs/FEES-AND-REWARDS.md`.)
78. **Operator instances are self-branded.** `acme.example.com` running Morphit looks like Acme Corp's marketplace, not like a generic affiliate page.
79. **Run on a Raspberry Pi.** Hardware requirements: 2 cores, 2 GB RAM, 20 GB SSD, 1 Mbit/s. A Pi 4 with a USB-3 SSD is sufficient for a community instance.
80. **Run on a spare laptop.** Closed-lid on a shelf with wired Ethernet works great. The laptop battery doubles as a UPS.
81. **Run on a $5/month VPS, or $0/month at home on residential internet** with Dynamic DNS. No static IP required; many operators host from home.
82. **No Blurt witness or full chain node required.** The indexer talks to public Blurt RPC endpoints over HTTPS.
83. **Indexer cross-verifies via multiple Blurt RPCs.** No single chain provider is a trust anchor.

## 5. Non-custodial, honestly

84. **Morphit never holds your funds. Period.** The actual buyer-seller trade — fiat going one way, crypto the other — happens directly between the two parties' wallets. Morphit is a bulletin board, not a bank. No deposits to fund, no balances to withdraw.
85. **No escrow account.** No "we hold while the trade settles" pattern. Settlement is direct.
86. **No custody fees.** Because no custody.
87. **No "frozen account" mechanism.** Thanks to the Blurt blockchain, demonetization, censorship and user bans are impossible.
88. **No exchange-side hot wallet to be hacked.** Because no exchange-side wallet.
89. **No insolvency risk.** A bankrupt Morphit operator can't owe you BTC because they never had your BTC.
90. **No FTX failure mode.** No SBF holds the keys. There are no shared keys. There is no shared cold storage.
91. **The trade itself never appears on Morphit's books.** Your bank transfer goes from your bank to the seller's bank. The XMR moves directly from seller's wallet to buyer's wallet. Morphit cannot see, log, or intervene.
92. **You can audit the on-chain receipts.** Every fee paid, every listing posted, every feedback signed — provable on the Blurt blockchain, no Morphit cooperation required.

## 6. For Monero users specifically

93. **Monero is a first-class asset, not an afterthought.** Listed alongside Bitcoin and BLURT as the three core trading assets. Treated as a peer, not a curiosity.
94. **Morphit won't accept your view key.** Ever. For any reason. The Monero verification flow is explicitly designed to NOT require it.
95. **Morphit never proxies your XMR transactions.** They go directly between the two parties' wallets — Morphit doesn't even broadcast on your behalf.
96. **Amount randomization (jitter) defeats correlation attacks.** When you share your XMR address, Morphit can append cryptographic-RNG randomness to the trailing 6 decimals of the amount — up to ~0.000001 XMR (1 microXMR ≈ $0.0002 trivial cost) — so two "0.5 XMR" trades produce distinct on-chain amounts. Defeats the well-known view-key amount-correlation attack.
97. **Jitter uses `crypto.getRandomValues`, not `Math.random`.** Predictable PRNG would let observers correlate jitters across one user's trades. Morphit uses cryptographic-quality randomness.
98. **Jitter is asymmetric — round UP only.** Never underpays the seller. Verifier compares observed amount vs expected; underpayment fails. Costs the buyer at most 0.000001 XMR per trade.
99. **Subaddress nudge.** When you try to share a standard Monero address (starts with `4`), Morphit gently suggests using a subaddress (starts with `8`) instead. Standard addresses link every received payment to the same view key; "Stealth" subaddresses break that linkage. Not paternalistic — it's a soft nudge with a brief explanation.
100. **Multi-explorer attestation for XMR proofs — five independent explorers by default.** When verifying that a Monero payment landed, Morphit queries five Monero block explorers in parallel (xmrchain.net, localmonero.co/blocks, monerohash.com/explorer, exploremonero.com, moneroexplorer.org — all running the same `onion-monero-blockchain-explorer` reference codebase, but operated by independent parties) and rejects when responding explorers disagree on the proven amount. Operator-configurable to any compatible list, including self-hosted instances for maximum independence (see `OPERATIONS.md §40.4`). No single explorer can lie about a verification undetected.
101. **The "I sent the funds" flow includes XMR-specific tooling.** TxID copy-paste, view-key-handling explanations, integrated subaddress hints — Monero-aware throughout, not just "another asset on the dropdown."
102. **Monero-specific FAQ entries** in 10 locales explaining: how to find a TxID in GUI / Cake Wallet / Feather / monero-wallet-cli, why subaddresses matter, why Morphit won't accept your view key, how amount jitter protects you, and what the limits are.
103. **No "show us your wallet balance" prompt.** Ever. Other platforms ask. Morphit doesn't.
104. **No KYC trigger thresholds for Monero trades.** No "trades over $X require ID." No KYC at all, ever, regardless of trade size.
105. **Onion-only access works for Monero traders.** Several operators run `.onion`-only instances; you can trade XMR without your IP ever touching the clear net.
106. **Per-asset payment-method registry.** Operators can list which payment rails they support per asset, with operator-specific notes — reduces wasted DM exchanges asking "do you take Cash App for XMR?"

## 7. For Bitcoin users specifically

107. **Multi-explorer Bitcoin verification.** Morphit cross-checks Bitcoin payments against multiple explorers (Blockstream, mempool.space by default, operator-configurable) — no single explorer is a trust anchor.
108. **Bitcoin support is genuine.** Not a "we technically allow BTC" afterthought. The fee verifier, the explorer URL builder, the asset registry, the FAQ — all treat BTC as a primary asset.
109. **Lightning support is on the roadmap.** Currently on-chain BTC. Lightning integration is documented in `docs/PHASE-5-BACKLOG.md` for honest disclosure of where we are.
110. **No "Bitcoin only" tribalism.** Morphit serves BTC users without sneering at Monero users (and vice versa). The two communities trade with each other; the platform reflects that.

## 8. Reputation, trust, and chat that survives the platform

111. **Star ratings on chain, signed by both parties, immutable.** Every feedback row is a Blurt `morphit_feedback_v1` op signed by the reviewer. Edit-proof, delete-proof, fake-proof.
112. **Reputation can't be faked.** Your displayed star average is computed only from on-chain feedback rows whose `reviewer` signed the op AND whose feedback is tethered to a real on-chain order (not free-form). Self-signing isn't possible — the chain rejects ops without a valid signature from the reviewer's posting key — and the indexer further excludes (reviewer, subject) pairs flagged in `suspicious_reciprocity` (sock-puppet pattern) or `related_accounts` (linked-account heuristics). What's left, averaged and rounded to 2 decimals, is what the world sees.
113. **Positive feedback builds your reputation.** Every counterparty who rates you 4 or 5 stars after a real on-chain trade lifts your average. Keep in mind: if you want people to trade with you, your reputation is everything. New accounts show up with an `is_new_trader` flag (fewer than 4 ratings) — and counterparties may be wary of trading with someone whose reputation has yet to be established.
114. **Sock-puppet detection.** The indexer runs a `suspicious_reciprocity` heuristic that flags pairs who exclusively review each other. Suppressed feedback is excluded from the headline rating but visible in the raw history.
115. **Verified-chat badges.** Feedback rows get a "verified chat" badge if the reviewer-subject pair had a real-looking on-chain conversation BEFORE the review: at least 2 messages from each side (bidirectional, not one-shot), at least 15 minutes between first and last message, and the pair isn't flagged in suspicious-reciprocity. Defeats the "fake-trade-fake-review" pattern by requiring evidence of actual interaction.
116. **Feedback responses are themselves on-chain.** When you reply to feedback you received, the response is signed and attached. No "edit out the bad review" pattern.
117. **Engagement counter** shows how many distinct accounts messaged the order owner about a specific order in the last 24 hours. Tells you if an order is alive or stale.
118. **Loyalty milestones** delegate progressively more BP (10/50/200/1000, totaling 1,260 BP) as you accumulate cumulative BLURT-fee spend. Real reward for sustained good-faith trading.
119. **Welcome bonus on first completed trade: 10 BLURT liquid + 10 BLURT Power (BP).** BP is your own vested, staked BLURT — not a delegation, not borrowed. You own it. Staking earns you curation rewards, empowers your upvotes, and earns you ~2% interest (APR).
120. **First-fee welcome BP** delegates 1 BP on your first BLURT-paid listing fee, separate from the welcome bonus. Small symbolic stake giving you a foot in the broader Blurt ecosystem.
121. **Reputation can't be migrated to a competitor's silo.** It's on a public chain. Your reputation is yours, portable across every Morphit instance. If you want to start using a different operator's frontend, your reputation comes with you.

122. **A built-in notifications system with inbox.** Three ambient channels that never interrupt — the browser tab title gets prefixed with the unread count, the favicon gets a colored dot painted over it, and installed PWAs get an OS-level app-icon badge. Three opt-in interactive channels (OS notifications, audio chime, mobile vibration) configurable at Settings → Notifications, with permission requested at the point of relevance instead of on page-load — roughly 3× the grant rate. Web Push delivers notifications even when the Morphit tab is closed or the phone is locked — operators run their own VAPID keypair (`scripts/generate-vapid-keys.sh`) and payloads are E2E encrypted per RFC 8291; users pick self-hosted / standard / off in Settings. Three event categories (order, feedback, chat) toggleable independently, so a trader can be loud about offers and silent about chat noise. A chat inbox with Messages and Requests tabs keeps active threads separate from cold inbound contacts.

## 9. Anti-spam and anti-Sybil (without surveillance)

123. **Listing fees rise with abuse.** Sybil-tier multiplier scales: 4th order in 24h = 1×, 5th = 2×, 6th = 4×, 7th+ = 8×. Honest traders pay $0.12; spammers pay rapidly-growing tolls.
124. **Cold-message fees** discourage drive-by spam. First-time DM to someone you've never traded with costs ~$0.01 in BLURT, escalating with abuse history.
125. **Featured-slot bidding is auctioned, with anti-snipe protections and outbid alerts.** Top-of-orderbook placement requires outbidding — but minimum-hours floors prevent micro-bid sniping, bids are paid to the operator (not to a project skim), AND a soft-close anti-snipe rule extends the deadline of any expiring top-5 bid when a new bidder triggers it within the last 5 minutes (capped at 6 extensions / 30 min to prevent indefinite auction-drag). Bidders see their own recent bids inline with the bid form (status chips: Visible / Outranked / Expired / Order ended; an "Extended ×N" chip surfaces when anti-snipe has applied), so they know what to pay before pressing submit. When a new bid pushes someone out of the top-5 visible set, the displaced bidder gets a push notification — they paid for a slot and just lost visibility, so they should know.
126. **Account creation costs the operator 100 BLURT per signup.** That's a real economic gate. Sybil farms attacking a Morphit instance must convince the operator's relay to spend real money on each puppet account, which the operator's daily-ceiling defenses cap.
127. **Per-IP signup spacing.** Multiple invite-token issuance from the same IP triggers an Altcha PoW challenge.
128. **`/v1/health` short-circuits signups when the relay is low on funds.** Drains stop before they become unbounded.
129. **Drainer has defense-in-depth.** Per-row caps (N BLURT max amount per queued transfer), savepoint isolation per op, idempotency guards.
130. **No invite is "verified by SMS / phone."** No carrier surveillance. The invite system uses cryptographic proof-of-work, not telecom data.
131. **No CAPTCHA from a third party.** Altcha is self-hosted, doesn't phone home, doesn't track.

## 10. Open source and transparent (with receipts)

132. **AGPL-3.0 licensed.** Every operator who modifies Morphit and runs it as a service must publish their modifications. The license is the strongest copyleft in common use; it's chosen deliberately to keep forks honest.
133. **Source code at git.agorise.net/agorise/morphit.** Self-hosted Forgejo (Git forge), not GitHub. The project's own infrastructure is decentralized too.
134. **30 ADRs** (Architectural Decision Records) documenting every major design choice, the alternatives considered, and the tradeoff rationale. Read them in `docs/adr/` — files numbered 0001 through 0031 with the 0016 slot intentionally reserved-but-unused (its planned work shipped as ADR-0022 instead). Examples: ADR-0010 key custody, ADR-0014 chat and counterparty reputation, ADR-0015 chat crypto, ADR-0017 YubiKey unlock, ADR-0019 release trust anchor, ADR-0022 desktop QR pairing, ADR-0023 USDT multi-network, ADR-0024 BCH trade-only addition, ADR-0025 LTC trade-only addition, ADR-0026 transparent-chain privacy framework, ADR-0027 DASH trade-only addition, ADR-0028 USDC multi-network trade-only addition, ADR-0029 DAI multi-network trade-only addition, ADR-0030 DOGE trade-only addition, ADR-0031 ZEC trade-only addition with per-address privacy choice.
135. **49 design and operations documents** in `docs/`. Architecture, operations runbook, security model, fees-and-rewards reference, threat model, metadata-leak catalog, integration test design, automation audit — all public.
136. **PHASE-3a-DESIGN.md, PHASE-3b-DESIGN.md, PHASE-5-PLAN.md** — phase-by-phase honest planning documents. What we're building, when, and what we're explicitly deferring.
137. **GRANDMA-FRIENDLY-INVESTIGATION.md.** A document specifically about UX accessibility for non-technical users, treating "can a non-crypto-native person actually use this" as a first-order engineering concern.
138. **METADATA-LEAK-CATALOG.md.** A full inventory of every place metadata could leak — and what we do or don't do about each. Honest disclosure of where we're imperfect.
139. **OPERATOR-TRUST-DESIGN.md.** Explicit threat model treating operators as untrusted by default. Users can verify what an operator is actually serving against the on-chain manifest.
140. **OPERATIONS.md** — full ongoing runbook for operators (currently 27 sections). Covers backups, RPC management, signup-drain defenses, fee-recipient accounts, release signing, and more.
141. **API.md** — a public, documented HTTP API contract. Stable shape, stable URLs, free, read-only — designed for block explorers, federation aggregators, third-party clients, academic research.
142. **FEES-AND-REWARDS.md.** Single-source-of-truth document for every monetary flow in Morphit, with line-number references back to the source code that defines each figure. Don't trust marketing — verify against the code.
143. **CHANGELOG kept in releases on Forgejo.** Every release notes what changed, what bugs were fixed, what's deprecated.
144. **No proprietary modules.** No "this part is closed-source for security reasons." Every byte of the running system is in the repo.
145. **No telemetry.** Not even crash reporting. The codebase doesn't phone home.
146. **No dependency on a single vendor.** Postgres, Node.js, nginx — all standard, all open-source, all easily replaceable.
147. **One-click media kit at `/morphit-mediakit.zip`.** A pre-built bundle with the current claims list and brand logos (mark + wordmark, both SVG) — served from every instance, not gated behind asking the project for assets. Press, integrators, and the community can grab everything they need to write about Morphit, integrate with it, or talk about it on a podcast without a back-and-forth permission dance. The bundle is regenerated and re-committed every time its source files change; a CI smoke fails the build if it goes stale.

148. **Signed-tag release pipeline with one-command operator upgrade.** Every release tag is GPG-signed by an authorized release-signer (public keys live in `.forgejo/release-signers/` so anyone can verify); CI runs `git verify-tag` before building the tarball, and `morphit-ops upgrade` re-verifies on the operator's side before extracting, with automatic rollback on failure. A `morphit-release-monitor` systemd sidecar polls Forgejo every 6 hours and DMs the operator via matrix-bot when a new release is available — no mailing list to subscribe to, no manual repo-checking needed. Full operator guide at `docs/UPGRADING.md`.

## 11. Internationalization done right

149. **10 locales shipped at v0.** English, Spanish, French, German, Italian, Polish, Russian, Persian/Farsi, Mandarin (Simplified), Cantonese (Traditional). Many platforms ship English-only and consider it "global."
150. **Right-to-left support for Persian.** Layout flips, numerals localize (Persian uses ۱۰ not 10), text flow respects RTL conventions.
151. **Persian numerals tracked separately.** The fee-reward smoke specifically validates Persian-numeral consistency, because "10 BLURT" and "۱۰ BLURT" don't share regex patterns.
152. **No US-centric defaults assumed.** Currency display, date formatting, payment method names — locale-aware.
153. **Translation isn't an afterthought.** Each locale has full FAQ entries (often 100+ entries), full UI strings, full error messages.
154. **Native-speaker QA pending across non-English locales.** The team is honest about which locales were originally digital-translator-assisted and ensuring native-speaker review as a real backlog item, not pretending all 10 locales are equally polished.

## 12. Pro-Monero culture, not just compatibility

155. **No Monero "lite" client logic.** Morphit does NOT try to interpret your Monero wallet. It's a coordination layer; your wallet is your wallet.
156. **Five independent Monero block explorers in the default config** (xmrchain.net, localmonero.co/blocks, monerohash.com/explorer, exploremonero.com, moneroexplorer.org) — operator-configurable to any list of compatible explorers, including self-hosted instances.
157. **Trade verification logic is per-asset.** Bitcoin uses one path (multi-explorer cross-check on UTXO confirmation), Monero uses another (TxID + amount-match against the recipient's expected, no view key required) — designed for each chain's actual privacy model.
158. **Privacy-respecting default for the XMR jitter toggle: ON.** A user has to deliberately turn jitter OFF if they want to send a round amount. Default is the privacy-preserving choice.
159. **Monero loadout in the asset registry includes piconero precision** (12 decimals). No truncation, no awkward display.
160. **No "Monero is risky / for criminals" UI text.** Anywhere. We trade XMR; we don't apologize for it.
161. **No Chainalysis, no on-chain analytics integration, no third-party "compliance" tooling.** Designs treat that as a leak surface, not a feature.
162. **Acknowledges privacy is a journey.** The METADATA-LEAK-CATALOG documents what we DON'T solve (e.g., the operator can see (but not log) an IP fetched a specific order list — solved by Tor users, not by Morphit alone). Honesty over PR.
163. **Documented in plain English: "Morphit cannot see this."** Throughout the chat-trade flow, the UI explicitly tells users which actions Morphit observes and which it doesn't. No false claims of total privacy where partial privacy is the truth.
164. **Pro-Monero stance in the welcome bonus.** New users with their first XMR trade get the same welcome bonus (10 BLURT liquid + 10 BLURT Power) as BLURT-fee payers, no second-class treatment.

## 13. Honest comparisons (CEX, fake DEX, P2P)

### vs. centralized exchanges (Binance, Coinbase, Kraken, etc.)

165. **No KYC.** They require government ID; Morphit asks for nothing.
166. **No deposits.** They custody your coins; Morphit never touches them.
167. **No frozen accounts.** They can freeze you; Morphit literally lacks the database table to track an account-freeze flag.
168. **No insolvency risk.** They've all had bankruptcies (FTX, Mt. Gox, Celsius, etc.); Morphit has nothing to be insolvent ABOUT.

### vs. fake "DEX" platforms that hold funds in smart contracts

169. **A smart contract custody escrow is still custody.** Funds sit in code controlled by someone (multisig, governance, admin keys). Morphit's funds NEVER sit anywhere — they go directly between the two parties.
170. **Morphit doesn't have admin keys.** Not in a multisig, not in a timelock, not anywhere.
171. **Smart contract bugs have rug-pulled billions.** Morphit's "smart contract" is the Blurt chain — a public ledger maintained by an independent nodes network that nobody can control.
172. **A "decentralized" exchange that depends on AWS isn't decentralized.** Morphit operators run on Pi 4s, mini-PCs, spare laptops, residential connections, and `.onion` services.

### vs. LocalBitcoins / Hodl Hodl / LocalCryptos / Bisq / Haveno / OM

173. **LocalBitcoins shut down.** Single-operator failure killed the platform. Morphit is federated; no single shutdown can do this.
174. **Hodl Hodl uses on-chain Bitcoin escrow.** That's better than CEX custody but still escrow. Morphit is fully no-escrow.
175. **Bisq has been hacked twice, user funds stolen. They require you to run their desktop app, a Tor node, and provide them with collateral.** Morphit runs in any browser, requires no collateral, and let's the user choose options like Tor, i2p, Lokinet, etc.
176. **Haveno/RetoSwap is Monero-only, non-PWA, not Grandma-friendly, requires you to run a node, and trust them with a required security deposit. Platform relies on unbonded, uncapped, non-random, trusted arbitrators with multisig. Arbiters and taker bots can collude for a "rug pull".** Morphit is super lightweight and trades BTC, XMR, BLURT, USDT (across four networks), USDC (across four networks), DAI (across four networks), BCH, LTC, DASH, DOGE, and ZEC out of the box; same multi-node federation, same orderbook, same reputation, zero third-party trust. New assets added as the community asks for them — the asset-registry pattern means days, not months.
177. **Some P2P platforms have admin "dispute resolution" that overrides users.** Morphit has no admin role; chat history is the dispute record, and it's signed and immutable.

## 14. What Morphit deliberately does NOT do

178. **No token sale.** No ICO. No IDO. No airdrops to manipulate "user count." There's no MORPHIT coin.
179. **No "premine."** The project earns by listing fees on its own instance, same as any other operator.
180. **No "governance token."** No proposals you don't care about; no votes you can't participate in.
181. **No "DAO."** Architectural decisions are made by the contributors; documented in ADRs; criticizable by anyone via the public issue tracker.
182. **No marketing partnerships with CEXes.** No referral codes. No yield-aggregator integrations.
183. **No "Pro" tier with extra features for paying customers.** The free Morphit IS Morphit.
184. **No "premium" customer support.** There's no standard support either — if you need help, ask on the operator's Matrix channel or read the FAQ. Honest.
185. **No NFT integration.** No "trade BTC for an ape JPEG."
186. **No leverage. No margin. No futures. No options.** Morphit is a spot fiat-crypto marketplace, full stop. Defi degens look elsewhere.
187. **No "AI assistant" trying to sell you a trade.** Just an orderbook.
188. **No app-store gatekeepers.** Morphit is a PWA — installs on Android via "Add to Home Screen," installs on iOS via Safari Share → Add to Home Screen. Apple App Store would reject a non-KYC P2P crypto app; we don't pretend otherwise.

## 15. Reach: every device, every network

189. **Progressive Web App** — installable as a standalone app on Android and iOS without going through Google Play or the Apple App Store.
190. **Service worker caches assets locally** — partial offline capability for previously-loaded pages and static content.
191. **Works in Tor Browser at maximum security level.** Service worker gracefully falls back to normal caching when service workers are disabled.
192. **F-Droid distribution path** for Android users who want a true open-source app store experience (placeholder; reproducible-build pipeline planned).
193. **Aptoide, APKMirror, APKPure listings** for Android users without Google Play.
194. **GrapheneOS callout** as the recommended privacy-first Android. No Google relationship required.
195. **iPhone PWA install instructions** in the `/download` page, in plain English, in 10 languages.
196. **No native Apple Store app planned.** Apple's guidelines forbid non-KYC P2P crypto apps; Morphit doesn't pretend otherwise. The PWA path is the lasting answer.
197. **Operator section on the `/download` page** shows the run-your-own-node path: source code, releases, setup walkthrough, supported systems, federation directory.
198. **RSS feeds for the orderbook** — real-time updates in your existing RSS reader. Asset-filtered, account-filtered, full-orderbook variants.
199. **SSE streams for the orderbook** — live deltas without polling.
200. **`no-js` graceful degradation.** The footer link advertises that the static parts of Morphit work without JavaScript, for users on Tor's max-security level or otherwise locked-down browsers.
201. **Public, free, documented HTTP API.** Anyone can build a block explorer, an aggregator, a CLI client, a price feed, a federation health monitor — without asking permission.
202. **API self-hosting recommended at scale.** If you're building something high-volume on the API, the recommended path is to run your own indexer ($5/month VPS) — no negotiation, no allowlist, no rate limits.
203. **Federation health visible to everyone.** `/instances` shows every known instance and its probe status. Aggregators and end users alike can monitor the federation in real time.

## 16. Built-in tools — block explorer, activity stats, payment QR codes

204. **Built-in block explorer at `/explorer`.** Search by Blurt account name, transaction ID, or block number — Morphit ships its own explorer so you don't have to trust a third-party block-explorer site (which sees your IP and search history). The explorer is served by the same indexer that powers the orderbook; same trust model, same operator, no extra service to inspect.
205. **Trading-activity dashboard at `/explorer/activity`.** Volume by asset over 7-day, 30-day, and 90-day windows (BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC — and any other asset traded on the instance). Live listings histogram. Updates every 30 seconds. Useful for traders gauging market activity; useful for academics studying P2P-marketplace economics; useful for anyone who wants the raw numbers without a CoinGecko-style intermediary.
206. **Cross-chain explorer links inside chat.** When a counterparty sends you a Bitcoin txid, the chat bubble auto-routes to mempool.space; Monero txid auto-routes to xmrchain.net (or the operator-configured XMR explorer); BLURT txid routes to the in-app `/explorer`. Click → confirm payment landed. No copy-paste-into-a-third-party-site dance.
207. **Display-payment QR codes for receiving addresses.** When you share a BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, or ZEC receive address through the trade flow, Morphit can render it as a QR code on screen (BIP-21 for Bitcoin, official URI scheme for Monero, native-network formats for USDT/USDC/DAI, CashAddr URI for Bitcoin Cash, litecoin: BIP-21-derivative URI for Litecoin, dash: BIP-21-derivative URI for Dash, dogecoin: BIP-21-derivative URI for Dogecoin, zcash: ZIP-321 URI for Zcash). The buyer scans with their mobile wallet's camera. Works on `.onion` instances, works in Tor Browser, works without any third-party QR-image service. The QR library is lazy-loaded — users who never tap "Show QR" don't pay the bytes.
208. **Live BLURT staking APR display** in the balance card. Computed locally from chain DGP — no third-party endpoint, no CoinGecko, no fee-feed dependency. (Current chain inflation is 7.6% as of 2026-05-03; ~75% of new emission goes to BP holders pro-rata, so the real APR per staked BP unit varies with the vesting pool size.)

## 17. Trade anything — barter, cash, precious metals

209. **Curated registry of 40+ payment methods** organized by category: crypto (BTC ↔ XMR, etc.), bank rails (Zelle, Interac e-Transfer, SPEI, Oxxo Pay, SEPA), in-person, and operator-defined extras. Pickers fuzzy-match on the canonical 40-entry list to avoid the "did you mean Cash App or CashApp or Venmo or PayPal" dropdown soup.
210. **Barter for goods is a first-class payment method.** Trade BTC for orange trees, XMR for raw garlic, BLURT for a used bicycle, USDT for fresh-pressed olive oil, USDC for sourdough starter, DAI for a workshop tool-set, BCH for a farm-share, LTC for a hand-built fence, DASH for hand-rolled candles, DOGE for a vintage bicycle frame, ZEC for an heirloom seed swap. The order's free-form `terms` field carries the specifics — Morphit doesn't try to be the eBay-of-everything, but barter as a trading rail is fully supported and treated like any other in-person payment method.
211. **Cash + precious metals (gold/silver coins/bars)** also covered as in-person methods. Meet up, exchange, leave on-chain feedback. Morphit's role ends at "facilitating the introduction"; the actual exchange is between two humans.
212. **Operator-defined payment methods.** Per-instance, an operator can add region-specific payment rails their community uses (a local fintech app, a national bank-transfer system) without forking the codebase — the registry is operator-extensible.

## 18. Operator setup — even your grandma can run a node

213. **Beautiful CLI setup wizard.** The wizard walks new operators through everything: pre-flight system check, ELI5-friendly prompts for the basics (instance name, accounts, networks), review-and-confirm screen, write the config. End-to-end in about 15 minutes.

214. **The system check tells you what's wrong, not just "ERROR".** Pre-flight verifies CPU, RAM, free disk, OS family, and network reachability — and if any check fails, you get a specific human-readable explanation of what to do next.

215. **One-command deployment.** Once the config is written, a single command brings up the indexer, relay, and database in one shot.

216. **Federation registration is one CLI broadcast.** After setup, a single chain op puts you in the federation directory globally — you show up on every other Morphit instance's `/instances` page within seconds.

217. **Operational runbook with concrete cron snippets.** `OPERATIONS.md` ships copy-pasteable cron snippets for the operational tasks that should be automated (weekly ACT minting, TLS certificate renewal monitoring). Set up once, the runbook walks you through verifying each.

218. **Sign in to a strange computer by scanning a QR with your phone.** Posting key never leaves the phone. Your phone shows a confirmation card with the website name so you can spot phishing like `morph1t.io` before tapping "Yes, that was me." See `docs/adr/0022-desktop-qr-pairing.md` for the full protocol and threat model.

219. **Adding new tradable assets is usually a single day's work, not a year-long refactor.** The canonical asset list lives in one package (`packages/asset-registry/`). Add an entry with the right flags (tradable, can-pay-fees, supported-networks), drop a logo, add translations for the privacy/network copy if needed, register the explorer URL templates. Pre-2026 the same change required edits at 32 separate sites; now it's contained. Currently shipped: BTC, XMR, BLURT (the coordination chain), USDT across four networks (ERC-20, TRC-20, SPL, BEP-20), USDC across four networks (ERC-20, SPL, Base, Polygon), DAI across four EVM networks (ERC-20, Polygon, Base, Arbitrum), BCH (Bitcoin Cash, single-network mainnet), LTC (Litecoin, single-network mainnet, all four address formats), DASH (Dash, single-network mainnet, X/7 address forms, opt-in PrivateSend mixing), and DOGE (Dogecoin, single-network mainnet, D/9/A address forms, merge-mined with Litecoin since 2014), and ZEC (Zcash, single-network mainnet, all four address forms — t1/t3 transparent and zs1/u1 shielded via zk-SNARKs). When the community asks for the next one, that's the workflow.

220. **Adding a new language is a single-array edit.** Drop a translation JSON, add the locale code to the supported array. The framework knows the difference between "shipped" and "in progress" — work-in-progress translations don't appear in the language switcher until they're done. Translator workflow is documented for native-speaker contributors.

221. **Witness fee alerts carry actionable delta information.** When Blurt's chain account-creation fee changes (the cost an operator's relay pays for each signup), the operator gets an alert with the old value, the new value, the percentage change, and the direction — not just "fee changed."

222. **Build from source, with reproducibility as a project goal.** Operators can build the frontend locally and verify the bytes match what the project published; the build emits a SHA-256 manifest of every served file, recorded on chain. No privileged build pipeline — every operator builds the same source.

223. **Operators publish two I2P addresses, both render.** Operators with both a long-form `.b32.i2p` (always-resolvable) AND a human-readable `.i2p` alias can publish both. The footer renders both as separate chips; the directory shows both for every operator that publishes them. Backwards-compatible with single-address operators.

224. **Discretionary bug bounty program.** Documented scope, severity guidance, no-NDA / no-exclusive-disclosure stance, no third-party broker. Reward is discretionary BLURT or BTC, scaled to severity and report quality. Hall of fame credit available even when payment isn't. Pragmatic posture for a bootstrapped project — no fixed dollar tiers we can't honor.

225. **Weekly automated warrant canary.** `/canary.txt` declares the operator has not received an NSL / FISA / gag-order / backdoor demand. PGP-signed by the operator. Three independent freshness proofs (Blurt + Bitcoin chain heads, a news headline) prove it wasn't pre-generated. Stale window is 14 days — past that, the frontend banner instructs users to switch operators. Operator setup is one cron line.

226. **PGP keys link in the footer for canary verification.** Operators publish their release-signing keys as a downloadable `.asc` file. Anyone can import and verify operator-signed canaries and releases. Footer link translated to all 10 locales.

227. **Server hardening below the application layer is documented in copy-pasteable detail.** SSH, unattended security upgrades, kernel hardening, filesystem mount hardening, systemd unit isolation, Postgres SCRAM-SHA-256, encrypted backups, outbound egress allowlist, alerting — operators can apply as much or as little as fits their threat model. Recommended baseline highlighted explicitly.

228. **High-value account names get extra friction.** Short names, obvious brand names, common dictionary words, and enumeration patterns get classified at signup time and handled per the operator's policy. Three policy modes (strict / moderate / off) — operator's call. Legitimate year-suffix names (`bob-1990`, `crypto-noob-2026`) explicitly pass.

229. **Sequential signup pattern detection.** Patterns like `account001` / `account002` / `account003` get caught at signup time — operator-tunable, per-IP-bucket isolation so an attacker controlling multiple ranges still hits the threshold separately on each.

230. **Trusted-proxy IP allowlist with CIDR support.** Operators running behind a reverse proxy (BunkerWeb in Docker, multi-host nginx, etc.) can correctly preserve client IPs for rate limiting. Without this, a Dockerized reverse proxy would funnel every client through a single rate-limit bucket — one abuser exhausting the daily cap for everyone.

231. **Turnkey BunkerWeb deployment in the box.** The morphit repo ships a tested-shape BunkerWeb config at `ops/bunkerweb/` — docker-compose + env template with OWASP CRS paranoia 3, anti-`Referer: none` rule on the invite endpoint, real-IP forwarding wired correctly to the relay's trusted-proxy chain, and a pinned `172.20.0.0/16` Docker network CIDR so operators can hard-code `MORPHIT_RELAY_TRUSTED_PROXY_IPS` without re-inspecting after rebuilds.  Same shipping pattern as `ops/nginx/`, `ops/systemd/`, `ops/postgres/init.sql`.  Operators copy + edit two values + `docker compose up -d` and have a WAF-fronted instance.  Operations runbook covers the trusted-proxy CIDR plumbing for four common topologies (single-host, Docker-compose alongside, separate-host BunkerWeb, BunkerWeb-in-front-of-nginx), compatibility against the kernel/systemd hardening, and tuning advice for signup endpoints.  Documents when NOT to add BunkerWeb too — small private instances, Tor-only, resource-constrained VPS.

232. **Squatter defense operator playbook.** A tactical runbook for operators concerned about name-squatting: env config, log monitoring, attacker-pattern recognition, weekly audit procedure, active-attack incident response, network-layer defenses, and a "diamond-hardened" preset for operators willing to accept moderately higher friction for maximum resistance.

233. **Comprehensive threat model with documented attack scenarios.** Every credible attacker behavior across the four primary attack surfaces (frontend, indexer, relay, Blurt chain) is enumerated as a STRIDE row, with the existing in-code mitigation named and cross-referenced. Residual risks stated honestly; open gaps flagged. Regenerated when meaningful new attack surface ships.

234. **Operator alerts to a private Matrix DM with three-tier routing.** A turnkey sidecar (`apps/matrix-bot/`) tails journalctl, classifies indexer + relay events into CRITICAL (immediate DM, no rate limit), WARN (1/hour per category), and INFO (daily 09:00 UTC digest, skipped on quiet days), and DMs the operator's private MXID end-to-end-encrypted. Branded TypeScript types prevent confusing the private MXID (`@user:server`) with a public room alias (`#room:server`) at compile time — security disclosures never accidentally route to a public channel. Comma-separate multiple MXIDs in `MORPHIT_MATRIX_BOT_ALERT_MXID` for vacation coverage.

235. **Resource alerts that read like advice, not alarms.** A POSIX-sh sidecar polls `/proc/meminfo`, `df`, `loadavg`, and `/proc/vmstat` every 5 minutes and routes disk / memory / swap / CPU / swap-thrashing thresholds through the matrix-bot in three tiers. Each DM ships ELI5 advice with the exact debug command: a disk-critical alert says "free space NOW: `sudo journalctl --vacuum-time=7d`, `sudo apt clean`"; a swap-thrashing alert says "the system is spending most of its time moving memory between RAM and swap — `ps aux --sort=-%mem | head -10`." A separate sweep enumerates ALL writable mounts (`df --output=target,pcent,fstype`, skipping pseudo-filesystems) so Docker volumes filling, runaway tmpfs, and bind-mounts the operator-configured paths don't cover get caught too. All thresholds env-tunable.

236. **Kernel-log monitoring catches what the resource monitor can't.** A separate sidecar scans the kernel ring buffer every 5 minutes for OOM-killer activations (with the victim process name and PID), kernel oopses and panics, hardware errors (MCE / EDAC / ATA), and morphit-service segfaults. The resource monitor sees memory pressure *building*; the kernel-log monitor sees what got killed when it broke. Cursor-based state means successive runs don't re-alert on old events.

237. **Disk health and RAID monitored before silent data loss.** SMART self-tests every 6 hours alert on imminent drive failure, reallocated/pending sectors, and high temperature with the exact `smartctl -a /dev/X` command to investigate further. The SCT thermal log (`smartctl -l scttempsts`) gets scraped too — surfaces drives that hit WARN+ range at least once in their lifetime even if cool right now, and drives whose own firmware has incremented its over-temperature counter. Linux software RAID (`/proc/mdstat`) is checked every 15 minutes for degraded or failed arrays. Sidecars exit silently on hosts without SMART/RAID — safe to enable defensively in the Ansible playbook.

238. **The "alerting is silently failing" detector — and the silent TLS-renewal-failing detector too.** Most monitoring stacks miss two killer patterns: email alerting that silently broke (smarthost credentials rotated, TLS cert expired — emails pile up in postfix and the operator hears nothing) and certbot renewals that silently stopped working months ago. Morphit's postfix-queue monitor alerts when mail queue depth or oldest-message age cross thresholds, routed through the matrix-bot (not email — so the alert still arrives when email is dead). The certbot monitor correlates cert expiry against the last successful renewal in `letsencrypt.log` and fires `renewal_stalled` CRITICAL long before the cert actually breaks the site.

239. **OS health surfaced through the same channel as everything else.** Pending security updates (`apt list --upgradable` parsed for the `-security` suffix), systemd units in `failed` state (caught by the systemd-monitor since failed-to-start units emit no journal output journalctl-based alerting can route), journal disk growing toward gigabytes (catches "journal silently grew to 8 GB over six months"), and a daily trivy Docker-image CVE rescan against running containers — all DMed with the exact remediation command. Operators don't have to read every CVE advisory or check the motd.

240. **Docker Compose service health, including the silent-unhealthy state.** `docker compose ps --format json` is polled every 5 minutes; `service_unhealthy` fires when the container is running but its declared health-check is failing — the silent-degradation state most operators miss because `docker ps` still shows "up." Restart-loop detection covers services whose `restart: always` policy is masking a real bug.

241. **One-command Ansible deployment.** `ops/ansible/` ships a tested playbook for fresh Ubuntu 24.04: base hardening, TLS, Postgres, Morphit services, BunkerWeb, plus opt-in roles for every monitoring sidecar above (all default `enable_*: false`). Secrets live in `ansible-vault`-encrypted vault. `ansible-playbook --tags monitors` adds monitoring to an already-deployed instance without touching the rest. The matrix-bot role explicitly checks for the compiled better-sqlite3 native binding after install and fails with a copy-pastable recovery command if it's missing — catches a deploy-box-firewall failure that would otherwise crash the bot on first boot.

242. **Native-language translations across every locale, not English fallbacks.** A systematic audit and translator pass closed real translation gaps — strings that had been silently shipping in English because earlier translator passes missed them. Now backed by a regression smoke that flags any same-as-English value outside a documented allow-list, so future translator drift fails CI rather than user-report time.

243. **Plain-language `/glossary` route.** 21 jargon terms (active key, federation, indexer, listing fee, network fee, operator, permlink, seed phrase, etc.) defined in plain English. Each term anchor-linked so callers can deep-link from any page. Translated into all 10 locales.

244. **In-context glossary tooltips.** A `<Term>` component surfaces glossary definitions on hover or tap, with a dotted-underline cue on first appearance per route. Restrained by design — callers opt-in word by word rather than auto-detecting across rendered text. Power users get the protection; everyone else sees clean reading flow.

245. **Onboarding copy softened — same custody truth, less doom-laden framing.** The seed-phrase confirmation reads as a commitment to action ("I'll keep these 12 words safe — I know they're the only way back into my account") rather than a legal disclaimer ("I understand losing this means everything is gone"). Same fact, friendlier voice, in all 10 locales.

246. **"Your fee-rejected order silently vanished" cliff closed.** When a Morphit listing fee fails to verify (chain reorg, etc.), the order disappears from the public orderbook. The orderbook now shows a "Posted an order but don't see it? Check fee status →" breadcrumb so a user who navigated away can find their listing's status without concluding Morphit ate their fee.

247. **Chat composer surfaces a soft proofread reminder before account numbers go on chain forever.** When a user types a string that looks like an IBAN, payment card, routing/account number, or SWIFT/BIC code, a one-time-per-session reminder appears above the textarea: "Permanent. Account numbers in chat go on the Blurt chain forever. Proofread carefully before sending." Doesn't block, doesn't redact (account numbers in chat are legitimate — that's how trade partners share where to send fiat). Just nudges before the typo becomes permanent.

248. **Printable seed-phrase backup card.** One click in the onboarding flow prints a paper-friendly backup card via the browser's native print dialog — no PDF library, no server round trip, no third-party dependency. Seed phrase never leaves the device. Pick paper or save-as-PDF; the rest of the page is hidden during print.

249. **First-post starter pack.** First-time posters see a green-tinted card with three safe-default tips (start small, 7-day expiry, pick payment methods you actually accept) and a deep link to the trade-walkthrough FAQ. Self-hides once the user has any prior posting experience. Privacy posture: client-side only.

250. **Centralized locale-aware number/date formatters.** Currency, percent, BLURT amount, count, and date helpers all read the active locale. A German user sees "1.234,56" where a US user sees "1,234.56" — no ad-hoc `.toFixed()` calls drifting across the codebase.

251. **Printable one-page cheat-sheet at `/cheat-sheet`.** Covers the four concept-pairs that everyone confuses (account vs seed vs password; listing fee vs network fee vs trade payment; the supported tradable assets at a glance; "if something goes wrong" recovery flows). Print or save as PDF. Translated to all 10 locales. Pure static content — no user data loaded, no PDF library.

252. **Identity-label policy enforced consistently.** Every place a user account name appears in the UI renders with its identicon, so brand-new Blurt accounts are visually distinguishable. Spoofing attempts like `@morph1t` vs `@morphit` are visually obvious, not just textually different. Backed by a regression smoke catching future raw-render drift at CI time.

253. **Onboarding back-button on the review stage that wipes the just-generated seed before returning to the path picker.** A confirmation modal warns the user they're discarding the 12 words; on confirm, the seed is wiped from memory and the form state resets. Three "discard the unsaved identity" code paths now use the same wipe pattern.

254. **`/post` remembers your fiat currency and region across sessions.** Stored in your browser, never sent to any server, never on chain. Clear the preference any time from `/settings`. A "Preferences" section lets you review what's saved.

255. **Route-transition focus management for screen-reader users.** Navigating from page to page moves focus to the main region on every real route change. Screen readers announce the page change; sighted users see no visual disruption. Heading hierarchy is audited and codified as a regression smoke so future drift fails CI.

256. **Static-source color-contrast smoke.** Every text/background color pairing across the frontend is checked against WCAG AA at the source level — 161 pairs across 96 Svelte files, zero below threshold.

257. **Treasury chain-pin closes a real fork-attack vector.** BTC/XMR fee addresses are signed by `@morphit` on chain via the existing release trust anchor. Every federated indexer prefers the chain-pinned address over its own configured value. A hostile fork can only divert fees on its own instance — every other federated indexer marks those orders unverified, and the divergence is itself a defection signal anyone scraping multiple instances can detect.

258. **No Morphit instance — not even canonical morphit.io — holds any verification secret for Monero fees.** Every instance verifies every XMR payment independently using user-generated per-payment proofs (`OutProofV2…`). The proof reveals exactly one payment — not your other payments, not your wallet balance, not your other addresses, nothing about future payments. You hold the only verification secret involved (your tx_key, in your own wallet, never published). This is the strongest privacy + decentralization posture we know how to build for Monero on a federated marketplace.

259. **Per-operator chat-link external explorer URLs.** When a counterparty sends a BTC or XMR transaction ID in chat, Morphit renders it as a clickable link that opens the transaction in an external block explorer. Operators who self-host their own explorers can override per-instance; everyone else inherits the bundled defaults. The override is per-operator (not per-user) — a user who wants different behavior chooses a different Morphit instance.

260. **Multi-explorer quorum gate on fee verifiers.** Operators can require N-of-M explorer agreement before accepting a fee verdict. Below the threshold, the verifier marks the order pending-external rather than accepting a degraded single-source result. Default is 1 (back-compat with smaller instances); operators with the full 5-explorer default list can set the threshold to 2 or 3 for genuine multi-source cross-check.

261. **Setup wizard configures explorer URLs with live health probes.** Each URL gets a ✓ / ⚠ / ✗ status indicator with latency on screen. Probes hit each explorer's standard health endpoint — no real transaction IDs or addresses sent. Non-blocking: operators can configure URLs that fail probes (might be configuring an explorer not yet online, or running offline).

262. **Per-operator listing fee USD target with live price recompute.** The operator picks a USD target (default $0.25), the wizard fetches live BTC/USD and XMR/USD prices, computes equivalent amounts, displays them, and asks for accept-or-override. Same step is reachable from the maintenance menu for ongoing tuning.

263. **Pre-launch + day-zero + week-one runbooks: three distinct documents, one continuous operator experience.** Pre-launch checklist → launch-day rehearsal + T-zero procedure + first-hour monitoring + rollback plan → week-one monitoring rolled up daily and weekly. Each doc has clear handoff to the next. Community operators get a wizard that configures the node and runbooks that tell them what to *do* with it.

264. **Federation cost attribution: each operator's relay pays only for ops that route through their own instance.** Before this fix, every federated indexer would have queued payouts on every op it saw — multiplying treasury spend by the federation count. Now each operator only pays the welcome bonus, refills, and loyalty BP for ops that name their instance tag. The operator getting the 90% fee reward is also the operator obligated for the consequences.

265. **Reputation attack-surface audit closed two real gaps.** Untethered "free" feedback citations are now rejected (fake-feedback targets require a real listing fee payment). Coordinated low-rating pile-on detection catches Sybil clusters depressing a real trader's reputation, with strict false-positive guards so a legitimate user reviewing multiple counterparties is never flagged. Flagged reviews stay visible on the subject's profile list but don't drive the numeric rating.

266. **QR-pair real sign-in: read-only desktop session.** Pairing your phone establishes a read-only session on the desktop — posting key stays on the phone, all writes route through the phone for signing. WhatsApp-Web mental model — phone is the source of truth, desktop is a window. A clear banner keeps you aware of session shape; "use your phone to sign this" affordances appear on every write surface (post an order, send a chat, leave feedback).

267. **Paired-readonly affordance gap sweep.** Every write call site explains why you need your phone, with deep links that preserve context (which order to edit, which peer to message). No more silent disappearances or misleading "session locked, unlock to continue" CTAs that paired users can't satisfy.

268. **Price-model picker on `/post/edit`.** Change your spread or flat price without cancelling and re-listing. Loses no engagement metrics, no fee status, no prior view counts. Defensively handles legacy and unknown shapes — never silently drops user intent.

269. **Persona walk-throughs as standing engineering discipline.** Three personas run end-to-end at the top of every major session: Bob (existing Blurt user), Sally (never owned crypto), Sally-as-operator (sets up her own node from any of the operator docs). Findings get fixed inline; locale parity across 10 languages holds throughout. Catches UX gaps no backlog list catches.

270. **Operator-doc audit pinned by regression smokes.** Every CLI command, every environment variable, every API field path, every install location named in the operator docs is sentinel-grep checked against the real code. When the docs and the code disagree, CI fails loudly before the operator copy-pastes from a doc that lies.

271. **USDT (Tether) peer-to-peer across four networks.** Trade USDT on Ethereum (ERC-20), Tron (TRC-20), Solana (SPL), or BNB Smart Chain (BEP-20) — peer to peer, non-custodial, no KYC, no central matching engine. The most-traded stablecoin in the world, with the price stability that active traders rely on, now available P2P on Morphit. Listing fees stay BLURT, BTC, or XMR (the fee-method wire format is invariant); USDT is a tradable asset, not a fee currency. Operators choose whether to enable USDT on their instance — disabled with one env var if they prefer to specialize in privacy or decentralization-focused assets only; the wider federated marketplace keeps trading regardless.

272. **No default USDT network — every USDT trade is an explicit network commit.** Cross-network sends are unrecoverable (USDT-ERC20 to a TRC-20 address loses the funds, period). Morphit's UI refuses to let the user default into that mistake: every USDT trade picks the network deliberately, every USDT address shared in chat carries a bold per-network header and a permanent per-message reminder of which chain it's for, and the post-order form won't submit until the network is chosen. Friction by design — the right kind of friction.

273. **Arbitrage between Morphit and centralized/decentralized exchanges is built for, not built against.** Morphit's listing fee is a fraction of a dollar; there's no taker fee, no withdrawal fee on the trade itself, no withdrawal limit, no withdrawal cooldown. Spreads between Morphit's P2P prices and exchange order books are visible to anyone watching, and the price-model picker lets a trader run a thin-spread arbitrage strategy on their own listings (set `spread: 0.5%` and let the orderbook fill at-or-above CoinGecko mid). As Morphit liquidity grows, arbitrageurs naturally pull the P2P prices into line with global market — which is good for everyone trading on the marketplace.

274. **Each instance's asset policy is visible up front.** Open `/about-this-instance` on any Morphit instance and you see exactly which tradable assets that operator has chosen to accept new orders for — emerald "None — accepts every tradable asset" for the default-everything case, or a clear list of operator-disabled tickers (e.g. "USDT") for instances that have specialized. Federation stays intact regardless: peer instances' orders still appear in your orderbook read-only, so a disabled-USDT instance still lets users see USDT trades happening elsewhere on the network. New assets ship default-ON instance-wide; operators opt out per-asset via one environment variable. The point: a user picking a Morphit instance can self-select based on whether the operator's stance matches their preferences — privacy-pure operators may disable USDT, pragmatic operators leave it on, and both serve real audiences. The `/run-a-node` page surfaces the same policy explainer so prospective operators understand the degree of freedom they have before they spin up.

275. **No flash of English content for non-English speakers.** Every page is prerendered once per supported locale — `/de/orderbook` ships pre-rendered German bytes, `/fa/orderbook` ships pre-rendered Persian, `/zh-HK/orderbook` ships pre-rendered Traditional Chinese, and so on. A first-time visitor's browser language preference (Accept-Language) is detected by a tiny inline script at the bare `/` URL and the browser is redirected to the matching prefix within one animation frame. The user never sees English text "flash" and re-render into their language — by the time the first paint happens, the page is already in the right language. Search engines index each locale URL separately so a Polish search query lands on `/pl/orderbook` not `/orderbook?lang=pl`. The language switcher updates the URL prefix (it's a real navigation, not a client-side string swap) so sharing a page link preserves the language for the recipient. The canonical list of indexable routes per locale is whatever `apps/web/src/lib/seo/routes.ts` declares (currently 18, lighting up new routes the moment they're registered); the sitemap re-derives URL count from that registry so the prerendered set tracks the source automatically.

276. **Bitcoin Cash (BCH) peer-to-peer.** Trade Bitcoin Cash on Morphit — bigger blocks, lower per-transaction fees than BTC, transparent and decentralized like BTC with no issuer who can freeze addresses. Single-network mainnet (no cross-network footguns the way USDT has). Address validator accepts both CashAddr (the modern BCH format, with or without the `bitcoincash:` prefix) and legacy P2PKH/P2SH addresses (which most BCH wallets still emit and accept), so users paste whatever format their wallet gives them and the form just works. Like USDT, BCH is trade-only on Morphit — listing fees stay BLURT/BTC/XMR (the fee-method wire format is invariant per Memory #23). Operators can disable BCH per-instance via `MORPHIT_INDEXER_DISABLED_ASSETS="BCH"`; the wider federated marketplace keeps trading BCH regardless of any single operator's stance.

277. **Setup wizard handles trade-only-asset opt-out — no manual env-file editing.** The `morphit-ops init` wizard, step 13 "Trade-only asset policy", walks operators through every shipped trade-only asset (USDT, BCH, LTC, DASH, plus any future Category-B addition) and asks per-ticker whether to enable it. Default is enabled for each (so the privacy-and-decentralization-first canonical posture still ships everything on). Pick "n" at any prompt and the wizard emits the correct `MORPHIT_INDEXER_DISABLED_ASSETS=` line into morphit.config.env automatically — alphabetized for diff-friendly env files. Iterates the canonical asset registry filtered to `canBeTraded && !canPayListingFee`, so future trade-only assets surface in the wizard without per-asset wizard code. Re-run the wizard to change your mind; the operator-stance UX matches the brag-#269 "your instance, your asset policy" promise without expecting operators to know which env var to edit.

278. **Litecoin (LTC) peer-to-peer.** Trade Litecoin on Morphit — fast 2.5-minute blocks, low transaction fees, transparent and decentralized like Bitcoin with no central issuer who can freeze addresses. Single-network mainnet, same low-footgun shape as BCH. Address validator accepts all four LTC address forms: legacy P2PKH (L…, unambiguous with Bitcoin's 1… form since LTC chose a distinct prefix), modern P2SH (M…, introduced 2017 to disambiguate from Bitcoin's 3… form), deprecated-but-still-valid P2SH (3…), and bech32/bech32m SegWit (ltc1q… and ltc1p… for taproot). Users paste whatever address their wallet emits and the form accepts it; recipient wallet does chain-binding on the receiving end. Like USDT and BCH, LTC is trade-only on Morphit — listing fees stay BLURT/BTC/XMR (the fee-method wire format is invariant per Memory #23). Operators can disable LTC per-instance via `MORPHIT_INDEXER_DISABLED_ASSETS="LTC"`; the wider federated marketplace keeps trading LTC regardless of any single operator's stance.


279. **Dash (DASH) peer-to-peer.** Trade Dash on Morphit — fast-confirmation Bitcoin-family chain with optional InstantSend (sub-second confirmations) and masternode-coordinated PrivateSend mixing for opt-in privacy. Transparent at the base layer like BTC, fully decentralized; no central issuer who can freeze addresses. Single-network mainnet, same low-footgun shape as BCH/LTC. Address validator accepts both DASH formats — `X…` P2PKH (most common, 34 chars, base58) and `7…` P2SH (multisig, 34 chars, base58); the receiving wallet does chain-binding. Like USDT/BCH/LTC, DASH is trade-only on Morphit — listing fees stay BLURT/BTC/XMR (the fee-method wire format is invariant per Memory #23). PrivateSend is wallet-side: users who want stronger privacy pre-mix in their Dash wallet before sharing the address on Morphit. Operators can disable DASH per-instance via `MORPHIT_INDEXER_DISABLED_ASSETS="DASH"`; the wider federated marketplace keeps trading DASH regardless of any single operator's stance.


280. **USD Coin (USDC) peer-to-peer across four networks.** Trade USDC on Ethereum (ERC-20), Solana (SPL), Base, or Polygon — peer to peer, non-custodial, no KYC, no central matching engine. The second-most-traded stablecoin globally, with the price stability that active traders rely on, now available P2P on Morphit. Same Category-B shape as USDT: listing fees stay BLURT/BTC/XMR (the fee-method wire format is invariant per Memory #23); USDC is a tradable asset, not a fee currency. We document Circle's freeze power honestly in the per-asset privacy guide — that's a real consideration USDC users should know about. Three of the four supported networks (ERC-20, Base, Polygon) share the EVM `0x[40 hex]` address shape, so the network discriminator is REQUIRED on every USDC trade and surfaced loudly in the picker UI; sending USDC-Polygon to the same address on Ethereum loses the funds to the Polygon chain. BEP-20 USDC on BNB Chain is intentionally NOT supported — that variant is Binance-Peg (a Binance-custodial wrapper of Circle's USDC, stacking two custodians instead of one) and uses 18-decimal precision where every other USDC network uses 6, both of which would violate Morphit's design priorities; ADR-0028 documents the decline rationale and the non-breaking add path if Circle ever issues natively on BSC. Amount-jitter is enabled for USDC (and retroactively for USDT) — the centralization concern doesn't refute the SEPARATE amount-correlation linkability threat that jitter defends against. Operators can disable USDC per-instance via `MORPHIT_INDEXER_DISABLED_ASSETS="USDC"` if they prefer to keep only privacy-preserving or decentralized assets; the federated marketplace keeps trading USDC regardless of any single operator's stance.

281. **Dai (DAI) peer-to-peer across four networks — the meaningfully-more-decentralized stablecoin option.** Trade DAI on Ethereum (ERC-20), Polygon, Base, or Arbitrum One — peer to peer, non-custodial, no KYC, no central matching engine. Unlike USDT and USDC, DAI is not issued by a single corporate entity: it's issued by the MakerDAO protocol and governed by MKR token holders through on-chain votes. The Dai token contract has **no admin-controlled freeze function** — MakerDAO cannot blacklist your address and stop transfers, the way Tether or Circle can on their stablecoins. That's a real decentralization advantage we want users to know about. Honest nuance: since 2020, MakerDAO's Peg Stability Module holds USDC as collateral to dampen peg deviations, so Circle's freeze power over USDC transitively affects DAI redemption mechanics; and MakerDAO governance could theoretically deploy a contract upgrade. Per ADR-0029 §2, DAI gets a distinct `dai_partly_centralized` privacy-warning class — NOT lumped with USDT/USDC's `*_centralized` — that gives DAI credit for the contract-level decentralization while being honest about the PSM/USDC backing dependency. All four supported DAI networks share the EVM `0x[40 hex]` address shape (highest cross-network address-confusion surface on Morphit), so the network discriminator is REQUIRED on every DAI trade with the strongest cross-network warning of any picker in the app. SPL, TRC-20, and BEP-20 DAI are intentionally NOT supported — those variants are wrapped/bridged (Wormhole, Allbridge, Binance-Peg) rather than Maker-native, and adding them would defeat the decentralization rationale that distinguishes DAI from USDT/USDC. ADR-0029 §1 documents the network-set rationale. Amount-jitter is enabled for DAI alongside USDT and USDC — the (partly-)centralization concern doesn't refute the SEPARATE amount-correlation linkability threat. Operators can disable DAI per-instance via `MORPHIT_INDEXER_DISABLED_ASSETS="DAI"`; the federated marketplace keeps trading DAI regardless of any single operator's stance. Listing fees stay BLURT/BTC/XMR (Memory #23 invariant); DAI is a tradable asset, not a fee currency.

282. **Dogecoin (DOGE) peer-to-peer.** Trade DOGE peer to peer — non-custodial, no KYC, no central matching engine. Fair-launched in 2013 with no premine after the first year, merge-mined with Litecoin since 2014 (auxiliary proof-of-work) so DOGE inherits Litecoin's hashrate security without competing for it. No foundation-controlled supply, no issuer who can freeze your addresses, no central authority over the chain. Same Category-B shape as the other trade-only assets: listing fees stay BLURT/BTC/XMR (Memory #23 invariant). Single-network mainnet with three address forms (D… P2PKH, 9… or A… P2SH); no bech32 because Dogecoin Core has not activated segwit. Honest privacy posture documented in the per-asset guide: DOGE has no native privacy upgrade — no PrivateSend equivalent, no confidential transactions — and we tell users plainly: every DOGE receive address you publish can be linked to its on-chain history forever, so use a fresh HD-derived address per trade (your wallet usually does this automatically). Operators can disable DOGE per-instance via `MORPHIT_INDEXER_DISABLED_ASSETS="DOGE"`; the federated marketplace keeps trading DOGE regardless of any single operator's stance. ADR-0030 documents the bundled explorer choice (blockchair.com/dogecoin, chosen from a 9-explorer survey).

283. **Zcash (ZEC) peer-to-peer with per-address privacy choice.** Trade ZEC peer to peer — non-custodial, no KYC, no central matching engine. Zcash launched in 2016 as the first practical deployment of zero-knowledge proofs (zk-SNARKs) in a cryptocurrency. The chain supports two address families that coexist on the same protocol: transparent (`t1`/`t3`, base58, like Bitcoin's legacy addresses) where amounts and parties are publicly visible, and shielded (`zs1` Sapling, `u1` Unified Address bundling Orchard receivers) where sender, recipient, and amount are hidden on chain via zero-knowledge proofs. Per-trade, you and your counterparty pick the address type that matches the trade's posture — both are first-class on the protocol and Morphit accepts all four address shapes through one validator. Same Category-B shape as the other trade-only assets: listing fees stay BLURT/BTC/XMR (Memory #23 invariant). The bundled chat-link explorer is `mainnet.zcashexplorer.app`, chosen from a 7-explorer survey for being community-run, project-aligned, and free of third-party tracking. Operators can disable ZEC per-instance via `MORPHIT_INDEXER_DISABLED_ASSETS="ZEC"`; the federated marketplace keeps trading ZEC regardless of any single operator's stance. ADR-0031 documents the addition rationale, the explorer survey, and the universal no-favoritism principle adopted at cp39: Morphit never ranks privacy approaches across assets or implies one privacy coin is "the most private" — each chain gets respectful framing without comparative claims.


## How to verify any of the above

Every claim in this document is verifiable. The repository is at **git.agorise.net/agorise/morphit**. Specific anchors:

- **Smoke suite**: `bash scripts/run-smokes.sh` — runs several thousand self-checks across ~150 runners, triple-pulse stable
- **Audit log**: `docs/AUDIT-2026-05.md`
- **Architecture decisions**: `docs/adr/0001-*.md` through `docs/adr/0031-*.md`
- **Fees and rewards**: `docs/FEES-AND-REWARDS.md` (line-cited to source)
- **Public API**: `docs/API.md`
- **Operator runbook**: `docs/OPERATIONS.md`
- **Security disclosure**: `docs/SECURITY.md` (Matrix-only)
- **Frontend integrity**: every page's served bundle hashes against the on-chain `morphit_release_v1` op
- **License**: `LICENSE` (AGPL-3.0)

Don't trust this list. Verify it. That's the whole point.

---

*283 specific selling points. None of them invented. All of them shipped, documented, or honestly disclosed as backlog. If you find one that isn't accurate, open an issue at git.agorise.net/agorise/morphit and we'll either fix the claim or fix the code. Last updated 2026-05-19.*
