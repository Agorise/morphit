# The Morphit Brag List

**Why a peer-to-peer fiat ↔ Bitcoin / Monero / Blurt / USDT / USDC / DAI / Bitcoin Cash / Litecoin / Dash / Dogecoin / Zcash / Pirate Chain / Decred / Solana / Ethereum / Ripple marketplace that's actually non-custodial, actually no-KYC, and actually federated beats every centralized exchange and every fake "DEX" that calls itself decentralized.**

A reference list of 300+ specific things Morphit does — privacy, security, decentralization, Monero-friendliness, anti-Sybil economics, operator independence — written for sharing, citing, and arguing with.

> Keywords: peer-to-peer crypto exchange, P2P Bitcoin marketplace, P2P Monero marketplace, P2P Bitcoin Cash marketplace, P2P Litecoin marketplace, P2P Dash marketplace, P2P Dogecoin marketplace, no-KYC exchange, non-custodial DEX, federated marketplace, Blurt, USDT P2P, USDC P2P, DAI P2P, BCH P2P, LTC P2P, DASH P2P, DOGE P2P, ZEC P2P, ARRR P2P, Pirate Chain, DCR P2P, Decred, Politeia, hybrid PoW PoS, CoinShuffle++, SOL P2P, Solana, Proof-of-History, high-throughput PoS, ETH P2P, Ethereum, The Merge, EIP-681, EIP-55, post-Merge PoS, Blockscout, XRP P2P, Ripple, XRPL, XRP Ledger, Federated Byzantine Agreement, FBA, destination tag, UNL, Unique Node List, XRPL reserves, Xaman, Xumm, Crossmark, livenet.xrpl.org, Zcash, zk-SNARKs, shielded transactions, Sapling, Orchard, Unified Address, shielded-by-default, MakerDAO, Circle USDC, Tether USDT, PrivateSend, CashAddr, Litecoin bech32, Litecoin MWEB, Dash PrivateSend, Dogecoin merge-mined, Monero subaddress, amount jitter, view key privacy, AGPL crypto exchange, censorship-resistant trading, Tor onion service, I2P b32 service, Lokinet, Nostr, GrapheneOS, F-Droid, Aptoide, decentralized orderbook, on-chain reputation, end-to-end encrypted chat, on-chain chat ciphertext, STRIDE threat model, reproducible build, multi-explorer attestation, mempool.space, xmrchain.net, blockchair.com, sock-puppet detection, Sybil-resistant, privacy guides, kycnot.me

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

3. **No email required. No phone number or SMS. No identity verification. No ID, no selfie, no proof of address. No "verified human" check.** That last bullet's not a joke — Morphit doesn't even check that you're a human; the rate limits and anti-spam are designed to make spam unprofitable rather than to gatekeep humanity.

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

19. **Deliberately NO Double Ratchet — and we'll defend the choice.** We evaluated the Signal-style Double Ratchet against Morphit's actual threat model and rejected it: the realistic compromise (your Blurt posting key leaks) lets the attacker re-derive every chat key you've ever held anyway, defeating forward secrecy regardless of how clever the ratchet is — and shipping the full protocol means a ~2 MB WASM crypto bundle that doubles first-load size on slow connections. Instead we ship per-message ECIES with sender-ephemeral keys wiped after one use, chain-anchored TOFU pinning that detects any peer key swap, and opt-in out-of-band fingerprint comparison. See `docs/adr/0015-chat-crypto.md` for the full tradeoff rationale.

20. **Opt-in out-of-band fingerprint verification ("Verify peer").** For users who want belt-and-suspenders MITM protection beyond the chain-anchored TOFU pin, the conversation menu has a "Verify peer" item that computes an 8-word fingerprint from your chat keys, derived locally with the PGP word list (deliberately NOT BIP39 — we don't want users mistaking it for a seed phrase). Compare with your counterparty by voice call or in person. Hidden by default; power users get "safety numbers" protection without imposing the friction on everyone.

21. **Private E2EE chat history is permanent and verifiable.** Stored on chain forever, signed, timestamped. The immutability matters for posterity (your trade record can never be deleted by a bankrupt operator), for legal recourse (an unredactable contemporaneous record is courtroom-grade), and for reputation integrity (counterparties can't quietly delete inconvenient threads to manipulate their feedback story).

22. **No Cloudflare.** The project deliberately rejects Cloudflare and similar centralized reverse-proxy services that intercept all user traffic at TLS termination.

23. **No Google Analytics, no Facebook Pixel, no Hotjar, no LogRocket.** No third-party trackers, full stop.

24. **No third-party CDN for fonts or scripts.** Everything self-hosted; your browser doesn't phone home to Google Fonts when you load a page.

25. **The frontend has a strict Content-Security-Policy.** No external scripts, no inline event handlers, no `eval`, no dynamic code paths.

26. **The relay only speaks to pre-configured Blurt RPC endpoints.** No SSRF. No "fetch a URL the user supplies" code paths.

27. **Scans your text for accidental private-key disclosure.** When you type into a chat or feedback box, Morphit scans the text for WIF keys, 64-character hex, and 12/24-word seed phrases. If detected, it warns you in red — and if you ignore the warning, it truncates the key client-side before the message leaves your device. Keep your private keys private!

28. **Profile fields don't require real names.** Use a handle, use anything — profiles are decoration over a cryptographic key "identity". Be as anonymous as you want to be.

29. **Sharing your public address goes through a privacy-aware modal.** Not just a copy-paste field — a flow that asks about subaddress preferences (XMR), amount-jitter (applied to every supported asset — BTC/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR/BLURT/SOL/ETH/XRP/XMR plus the stablecoins USDT/USDC/DAI; even XMR with its on-chain hidden amounts gets jitter because chat-shared amounts and centralized off-ramps both reveal the figure, and that's a separate linkability threat from the issuer-freeze concern the stablecoins already carry), client-side address-reuse detection (warns when you're about to share an address you've shared from this device before), and optional PayJoin (BIP-78) endpoint for BTC. Untraceability is the mission.

30. **Amount-jitter on every transparent chain.** Default ON. Adds a small random extra (≤999 satoshis for UTXO chains, ≤99 milliblurt for BLURT) so the "exact 0.00513924 BTC" giveaway becomes "approximately 0.00513924 BTC with a small random tail your buyer absorbs." Trivial cost; significant chain-analysis defeat.

31. **Client-side address-reuse warning.** When you paste or type a receive address you've previously shared from this device, the address-share modal surfaces an amber chip with the date of the prior share (and previous order permlink, if available). Pure localStorage — never transmitted to any Morphit server. Per-device limit: 200 entries (rolling buffer).

32. **PayJoin (BIP-78) support for BTC.** The address-share modal has an optional PayJoin endpoint field on the BTC tab. When the seller's wallet supports BIP-78 and pastes its endpoint URL there, Morphit relays it as the `pj=` parameter in the `bitcoin:` URI — buyer wallets that support PayJoin negotiate a cooperative transaction that breaks the common-input-ownership heuristic chain-analysis depends on. Wallets without PayJoin support ignore the parameter and fall back to a normal payment: zero footgun.

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

65. **Push subscriptions are proof-of-ownership protected.** Only the holder of your posting key can subscribe a device to receive your push notifications — the relay verifies a Blurt-account-keyed signature on the subscription op before storing it. So even if someone steals your push subscription endpoint URL, they can't subscribe their own device to your notifications. Same trust anchor as the rest of Morphit: your posting key.

66. **The brag list audits its own honesty.** A CI smoke walks `MORPHIT-BRAG-LIST.md` and asserts four invariants: the trailer count matches the actual number of entries, the trailer "Last updated" date is at least as fresh as the newest date cited in any entry, the ADR-range claim matches the actual range of ADRs on disk, and no two entries share a number. cp75 surfaced six prior numbering collisions (155, 156, 236–239) and an 11-entry trailer-count drift; all renumbered to 294–299 and the trailer corrected to 301. Future drift fails CI instead of accumulating.

67. **Test flakes get root-caused, not papered over.** When a relay test failed intermittently across the cp74 battery, the prior diagnosis blamed an "rpc timeout" — but the test's mock had no real timeout to bump. cp76 traced the actual flake to `apps/relay/test/killSwitch.test.ts` using a 1.5s real-time wait on a 1s polling interval, then replaced it with `vi.useFakeTimers()` for deterministic timing. A CI smoke now bans real-time `setTimeout` waits over 10 ms in any test file across 90 test files, so the next variant of the class fails the build instead of leaking through.

68. **Logger redacts secret-named fields by default.** The indexer's structured logger walks every context object before emit and replaces values whose key name matches a secret-suffix pattern (env-var styles like `*_KEY`/`*_PASSWORD`/`*_TOKEN`, camelCase suffixes like `apiKey`/`userPassword`/`authToken`, compounds like `privateKey`/`seedPhrase`) with `[REDACTED]` — recursively into nested objects, non-mutating to the caller's. Public-identifier keys (`publicKey`, `pubkey`, `*_PUBLIC_KEY`) are explicitly exempt and innocent words like `monkey` aren't false-flagged thanks to last-word tokenization. 20 unit tests in `apps/indexer/test/log.test.ts` lock the matcher behavior.
## 4. Real decentralization, not the marketing kind

69. **Federated orderbook over a public blockchain.** Orders live on the Blurt chain. Any operator running a Morphit indexer sees the same orderbook in real-time, and a buyer on one instance sees orders posted through any other instance — each operator's frontend is its own brand and URL, but the data layer is shared. Multiple indexers cross-verify each other.

70. **No central server to attack.** Take down a Morphit website and the federation continues; a buyer just opens another operator's URL.

71. **No central database to subpoena.** The orderbook isn't IN a database; it's ON the public Blurt chain. Subpoenas aren't a useful attack here.

72. **No single point of failure.** Operators come and go; the chain is permanent.

73. **Federation directory built into every instance.** Visit `/instances` on any Morphit URL and see a list of every other known instance, their alt-network addresses, and their health status.

74. **Reachable over Tor.** Onion services are first-class; instances commonly publish a `.onion` address alongside their public hostname.

75. **Reachable over I2P.** Instance directory tracks `.b32.i2p` addresses; the federation probe tries them.

76. **Reachable over Lokinet.** Same for `.loki` addresses. Different threat model than Tor; sometimes faster; an option, not the only path.

77. **Reachable over Nostr.** Operators can publish their pubkey as an alt-network channel for users who prefer that ecosystem.

78. **No registrar, no domain auth, no DNS dependency required.** A Morphit instance can run on `morphit.local`, on `.onion` only, on `.loki` only — DNS is a convenience, not a requirement.

79. **Anyone can run a node.** Pick a domain (or skip the domain), clone the repo, run the setup script, broadcast a `morphit_operator_register_v1` op. You're in the federation. No application, no permission, no central listing.

80. **Operators earn 90% of every BLURT-paid listing fee on their instance, paid in BLURT directly to their payout address — the other 10% goes to the project treasury (@morphit-fees).** BTC/XMR-paid listings fund the project treasury 100% — those don't generate operator revenue — but the BLURT-paid path is 50% cheaper for users (deliberate incentive), so most listings naturally choose BLURT, where operator revenue lives. Real revenue stream for serious operators on a $5-10/month VPS. No project skim on the operator's BLURT share.

81. **Operator instances are self-branded.** `acme.example.com` running Morphit looks like Acme Corp's marketplace, not like a generic affiliate page.

82. **Run on a Raspberry Pi.** Hardware requirements: 2 cores, 2 GB RAM, 20 GB SSD, 1 Mbit/s. A Pi 4 with a USB-3 SSD is sufficient for a community instance.

83. **Run on a spare laptop.** Closed-lid on a shelf with wired Ethernet works great. The laptop battery doubles as a UPS.

84. **Run on a $5/month VPS, or $0/month at home on residential internet** with Dynamic DNS. No static IP required; many operators host from home.

85. **No Blurt witness or full chain node required.** The indexer talks to public Blurt RPC endpoints over HTTPS.

86. **Indexer cross-verifies via multiple Blurt RPCs.** No single chain provider is a trust anchor.

87. **Wallet developers can embed Morphit's orderbook directly inside their wallet UI** — the same kind of integration Mycelium famously did with LocalBitcoins years ago. Morphit publishes a stable public REST + SSE API (`/v1/openapi.json` on any instance) covering the orderbook, profiles, feedback, and chat — federation-aware, so the wallet can point at any operator's instance or a self-hosted one. Any wallet supporting Morphit's 16 tradable assets can offer peer-to-peer trading without making users leave it. AGPL-3.0 like the rest of the project; integrators ship under their own license.

## 5. Non-custodial, honestly

88. **Morphit never holds your funds.** Period. There's no exchange wallet, no custodial pool, no deposit account. You trade peer-to-peer; the operator's relay never sees your private keys or your counterparty's funds.

89. **No escrow account.** No "we hold while the trade settles" pattern. Settlement is direct.

90. **No custody fees.** Because no custody.

91. **No "frozen account" mechanism.** Thanks to the Blurt blockchain, demonetization, censorship and user bans are impossible.

92. **No exchange-side hot wallet to be hacked.** Because no exchange-side wallet.

93. **No insolvency risk.** A bankrupt Morphit operator can't owe you BTC because they never had your BTC.

94. **No FTX failure mode.** No SBF holds the keys. There are no shared keys. There is no shared cold storage.

95. **The trade itself never appears on Morphit's books.** Your bank transfer goes from your bank to the seller's bank. The XMR moves directly from seller's wallet to buyer's wallet. Morphit cannot see, log, or intervene.

96. **You can audit the on-chain receipts.** Every fee paid, every listing posted, every feedback signed — provable on the Blurt blockchain, no Morphit cooperation required.

## 6. For Monero users specifically

97. **Monero is a first-class asset, not an afterthought.** Listed alongside Bitcoin and BLURT as the three core trading assets. Treated as a peer, not a curiosity.

98. **Morphit won't accept your view key.** Ever. For any reason. The Monero verification flow is explicitly designed to NOT require it.

99. **Morphit never proxies your XMR transactions.** They go directly between the two parties' wallets — Morphit doesn't even broadcast on your behalf.

100. **Amount randomization (jitter) defeats correlation attacks.** When you share your XMR address, Morphit can append cryptographic-RNG randomness to the trailing 6 decimals of the amount — up to ~0.000001 XMR (1 microXMR ≈ $0.0002 trivial cost) — so two "0.5 XMR" trades produce distinct on-chain amounts. Defeats the well-known view-key amount-correlation attack.

101. **Jitter uses `crypto.getRandomValues`, not `Math.random`.** Predictable PRNG would let observers correlate jitters across one user's trades. Morphit uses cryptographic-quality randomness.

102. **Jitter is asymmetric — round UP only.** Never underpays the seller. Verifier compares observed amount vs expected; underpayment fails. Costs the buyer at most 0.000001 XMR per trade.

103. **Subaddress nudge.** When you try to share a standard Monero address (starts with `4`), Morphit gently suggests using a subaddress (starts with `8`) instead. Standard addresses link every received payment to the same view key; "Stealth" subaddresses break that linkage. Not paternalistic — it's a soft nudge with a brief explanation.

104. **Multi-explorer attestation for XMR proofs — five independent explorers by default.** When verifying that a Monero payment landed, Morphit queries five Monero block explorers in parallel (xmrchain.net, localmonero.co/blocks, monerohash.com/explorer, exploremonero.com, moneroexplorer.org — all running the same `onion-monero-blockchain-explorer` reference codebase, but operated by independent parties) and rejects when responding explorers disagree on the proven amount. Operator-configurable to any compatible list, including self-hosted instances for maximum independence (see `OPERATIONS.md §40.4`). No single explorer can lie about a verification undetected.

105. **The "I sent the funds" flow includes XMR-specific tooling.** TxID copy-paste, view-key-handling explanations, integrated subaddress hints — Monero-aware throughout, not just "another asset on the dropdown."

106. **Monero-specific FAQ entries** in 10 locales explaining: how to find a TxID in GUI / Cake Wallet / Feather / monero-wallet-cli, why subaddresses matter, why Morphit won't accept your view key, how amount jitter protects you, and what the limits are.

107. **No "show us your wallet balance" prompt.** Ever. Other platforms ask. Morphit doesn't.

108. **No KYC trigger thresholds for Monero trades.** No "trades over $X require ID." No KYC at all, ever, regardless of trade size.

109. **Onion-only access works for Monero traders.** Several operators run `.onion`-only instances; you can trade XMR without your IP ever touching the clear net.

110. **Per-asset payment-method registry.** Operators can list which payment rails they support per asset, with operator-specific notes — reduces wasted DM exchanges asking "do you take Cash App for XMR?"

## 7. For Bitcoin users specifically

111. **Multi-explorer Bitcoin verification.** Morphit cross-checks Bitcoin payments against multiple explorers (Blockstream, mempool.space by default, operator-configurable) — no single explorer is a trust anchor.

112. **Bitcoin support is genuine.** Not a "we technically allow BTC" afterthought. The fee verifier, the explorer URL builder, the asset registry, the FAQ — all treat BTC as a primary asset.

113. **Lightning support is on the roadmap.** Currently on-chain BTC. Lightning integration is documented in `docs/PHASE-5-BACKLOG.md` for honest disclosure of where we are.

114. **No "Bitcoin only" tribalism.** Morphit serves BTC users without sneering at Monero users (and vice versa). The two communities trade with each other; the platform reflects that.

## 8. Reputation, trust, and chat that survives the platform

115. **Star ratings on chain, signed by both parties, immutable.** Every feedback row is a Blurt `morphit_feedback_v1` op signed by the reviewer. Edit-proof, delete-proof, fake-proof.

116. **Reputation can't be faked.** Your displayed star average is computed only from on-chain feedback rows whose `reviewer` signed the op AND whose feedback is tethered to a real on-chain order (not free-form). Self-signing isn't possible — the chain rejects ops without a valid signature from the reviewer's posting key — and the indexer further excludes (reviewer, subject) pairs flagged in `suspicious_reciprocity` (sock-puppet pattern) or `related_accounts` (linked-account heuristics). What's left, averaged and rounded to 2 decimals, is what the world sees.

117. **Recent feedback weighs more than ancient feedback.** Your published rating uses a 365-day exponential half-life — today's review counts 1.0×, a year-old review 0.5×, two-year-old 0.25×. A trader who turned bad can't dilute recent 1-stars with stale 5-stars; raw count stays visible separately so historical context isn't lost. Displayed to 2-decimal precision (4.74, not 4.7).

118. **Public verifiable reputation receipt.** Fetch `GET /v1/accounts/<account>/reputation-receipt` and you get every feedback row about that account (included AND excluded, with the reason for each exclusion), the decay weight applied to each row, and the formula used. Any reader with chain access can independently re-derive the published score — reputation is verify-against-chain, not trust-the-indexer.

119. **Positive feedback builds your reputation.** Every counterparty who rates you 4 or 5 stars after a real on-chain trade lifts your average. Keep in mind: if you want people to trade with you, your reputation is everything. New accounts show up with an `is_new_trader` flag (fewer than 4 ratings) — and counterparties may be wary of trading with someone whose reputation has yet to be established.

120. **Sock-puppet detection.** The indexer runs a `suspicious_reciprocity` heuristic that flags pairs who exclusively review each other. Suppressed feedback is excluded from the headline rating but visible in the raw history.

121. **Diversification-resistant concentration detector.** Catches reviewers who concentrate ≥80% of their reviews on a single high-star target over a 30-day window — including the smart attacker who reviewed a few throwaway third parties to evade the older sock-puppet detector's stricter mutual-only rule. Flagged feedback is excluded from the published rating but remains visible in raw history.

122. **Verified-chat badges.** Feedback rows get a "verified chat" badge if the reviewer-subject pair had a real-looking on-chain conversation BEFORE the review: at least 2 messages from each side (bidirectional, not one-shot), at least 15 minutes between first and last message, and the pair isn't flagged in suspicious-reciprocity. Defeats the "fake-trade-fake-review" pattern by requiring evidence of actual interaction.

123. **Side-of-trade breakdown + dormancy signal.** Your profile shows separate weighted ratings for buyer-side and seller-side trades — a trader great as buyer but careless as seller is visible to readers. A "Last traded: N ago" chip surfaces freshness (verified-fee order posted OR feedback received) so readers see if an account is dormant without changing the numeric score.

124. **Feedback responses are themselves on-chain.** When you reply to feedback you received, the response is signed and attached. No "edit out the bad review" pattern.

125. **Engagement counter** shows how many distinct accounts messaged the order owner about a specific order in the last 24 hours. Tells you if an order is alive or stale.

126. **Loyalty milestones** delegate progressively more BP (10/50/200/1000, totaling 1,260 BP) as you accumulate cumulative BLURT-fee spend. Real reward for sustained good-faith trading.

127. **Welcome bonus on first completed trade: 10 BLURT liquid + 10 BLURT Power (BP).** BP is your own vested, staked BLURT — not a delegation, not borrowed. You own it. Staking earns you curation rewards, empowers your upvotes, and earns you ~2% interest (APR).

128. **First-fee welcome BP** delegates 1 BP on your first BLURT-paid listing fee, separate from the welcome bonus. Small symbolic stake giving you a foot in the broader Blurt ecosystem.

129. **Reputation can't be migrated to a competitor's silo.** It's on a public chain. Your reputation is yours, portable across every Morphit instance. If you want to start using a different operator's frontend, your reputation comes with you.

130. **A built-in notifications system with inbox.** Three ambient channels (browser tab title prefix, favicon dot, PWA app-icon badge) never interrupt; three opt-in interactive channels (OS notifications, audio chime, mobile vibration) ask permission at the point of relevance instead of on page-load — roughly 3× the grant rate. Web Push delivers notifications even when the Morphit tab is closed or the phone is locked, using operator-generated VAPID keys (no external service). Settings → Notifications has the full toggle panel; the inbox is at `/notifications` with mark-read, dismiss, and per-channel preferences.
## 9. Anti-spam and anti-Sybil (without surveillance)

131. **Listing fees rise with abuse.** Sybil-tier multiplier scales: 4th order in 24h = 1×, 5th = 2×, 6th = 4×, 7th+ = 8×. Honest traders pay $0.12; spammers pay rapidly-growing tolls.

132. **Cold-message fees** discourage drive-by spam. First-time DM to someone you've never traded with costs ~$0.01 in BLURT, escalating with abuse history.

133. **Featured-slot bidding is auctioned, with anti-snipe protections and outbid alerts.** Top-of-orderbook placement requires outbidding, but minimum-hours floors prevent micro-bid sniping, bids go to the operator (no project skim), and a soft-close rule extends the deadline of any expiring top-5 bid when a new bidder triggers it in the last 5 minutes (capped at 6 extensions / 30 min). Bidders see their own recent bids inline with the bid form (status chips: Visible / Outranked / Expired / Order ended), so they know what to pay before pressing submit. When a new bid outranks yours, the displaced bidder gets a push notification with one-tap re-bid.

134. **Account creation costs the operator 100 BLURT per signup.** That's a real economic gate. Sybil farms attacking a Morphit instance must convince the operator's relay to spend real money on each puppet account, which the operator's daily-ceiling defenses cap.

135. **Per-IP signup spacing.** Multiple invite-token issuance from the same IP triggers an Altcha PoW challenge.

136. **`/v1/health` short-circuits signups when the relay is low on funds.** Drains stop before they become unbounded.

137. **Drainer has defense-in-depth.** Per-row caps (N BLURT max amount per queued transfer), savepoint isolation per op, idempotency guards.

138. **No invite is "verified by SMS / phone."** No carrier surveillance. The invite system uses cryptographic proof-of-work, not telecom data.

139. **No CAPTCHA from a third party.** Altcha is self-hosted, doesn't phone home, doesn't track.

## 10. Open source and transparent (with receipts)

140. **AGPL-3.0 licensed.** Every operator who modifies Morphit and runs it as a service must publish their modifications. The license is the strongest copyleft in common use; it's chosen deliberately to keep forks honest.

141. **Source code at git.agorise.net/agorise/morphit.** Self-hosted Forgejo (Git forge), not GitHub. The project's own infrastructure is decentralized too.

142. **37 ADRs** (Architectural Decision Records) documenting every major design choice, the alternatives considered, and the tradeoff rationale. Read them in `docs/adr/` — files numbered 0001 through 0038 with the 0016 slot intentionally reserved-but-unused (its planned work shipped as ADR-0022 instead). Topics include key custody (ADR-0010), chat reputation (ADR-0014), chat crypto (ADR-0015), YubiKey unlock (ADR-0017), release trust anchor (ADR-0019), QR pairing (ADR-0022), one ADR per tradable-asset addition (ADR-0023 through ADR-0036), cash-by-mail + shipment tracking (ADR-0037), and the reputation hardening campaign (ADR-0038).

143. **49 design and operations documents** in `docs/`. Architecture, operations runbook, security model, fees-and-rewards reference, threat model, metadata-leak catalog, integration test design, automation audit — all public.

144. **PHASE-3a-DESIGN.md, PHASE-3b-DESIGN.md, PHASE-5-PLAN.md** — phase-by-phase honest planning documents. What we're building, when, and what we're explicitly deferring.

145. **GRANDMA-FRIENDLY-INVESTIGATION.md.** A document specifically about UX accessibility for non-technical users, treating "can a non-crypto-native person actually use this" as a first-order engineering concern.

146. **METADATA-LEAK-CATALOG.md.** A full inventory of every place metadata could leak — and what we do or don't do about each. Honest disclosure of where we're imperfect.

147. **OPERATOR-TRUST-DESIGN.md.** Explicit threat model treating operators as untrusted by default. Users can verify what an operator is actually serving against the on-chain manifest.

148. **OPERATIONS.md** — full ongoing runbook for operators (currently 27 sections). Covers backups, RPC management, signup-drain defenses, fee-recipient accounts, release signing, and more.

149. **API.md** — a public, documented HTTP API contract. Stable shape, stable URLs, free, read-only — designed for block explorers, federation aggregators, third-party clients, academic research.

150. **FEES-AND-REWARDS.md.** Single-source-of-truth document for every monetary flow in Morphit, with line-number references back to the source code that defines each figure. Don't trust marketing — verify against the code.

151. **CHANGELOG kept in releases on Forgejo.** Every release notes what changed, what bugs were fixed, what's deprecated.

152. **No proprietary modules.** No "this part is closed-source for security reasons." Every byte of the running system is in the repo.

153. **No telemetry.** Not even crash reporting. The codebase doesn't phone home.

154. **No dependency on a single vendor.** Postgres, Node.js, nginx — all standard, all open-source, all easily replaceable.

155. **One-click media kit at `/morphit-mediakit.zip`.** A pre-built bundle with the current claims list and brand logos (mark + wordmark, both SVG) — served from every instance, not gated behind asking the project for assets. Press, integrators, and the community can grab everything they need to write about Morphit, integrate with it, or talk about it on a podcast without a back-and-forth permission dance. The bundle is regenerated and re-committed every time its source files change; a CI smoke fails the build if it goes stale.

156. **Signed-tag release pipeline with one-command operator upgrade.** Every release tag is GPG-signed by an authorized release-signer (public keys live in `.forgejo/release-signers/` so anyone can verify); CI runs `git verify-tag` before building the tarball, and `morphit-ops upgrade` re-verifies on the operator's side before extracting, with automatic rollback on failure. A `morphit-release-monitor` systemd sidecar polls Forgejo every 6 hours and DMs the operator via matrix-bot when a new release is available — no mailing list to subscribe to, no manual repo-checking needed. Full operator guide at `docs/UPGRADING.md`.

## 11. Internationalization done right

157. **10 locales shipped at v0.** English, Spanish, French, German, Italian, Polish, Russian, Persian/Farsi, Mandarin (Simplified), Cantonese (Traditional). Many platforms ship English-only and consider it "global."

158. **Right-to-left support for Persian.** Layout flips, numerals localize (Persian uses ۱۰ not 10), text flow respects RTL conventions.

159. **Persian numerals tracked separately.** The fee-reward smoke specifically validates Persian-numeral consistency, because "10 BLURT" and "۱۰ BLURT" don't share regex patterns.

160. **No US-centric defaults assumed.** Currency display, date formatting, payment method names — locale-aware.

161. **Translation isn't an afterthought.** Each locale has full FAQ entries (often 100+ entries), full UI strings, full error messages.

162. **Native-speaker QA pending across non-English locales.** The team is honest about which locales were originally digital-translator-assisted and ensuring native-speaker review as a real backlog item, not pretending all 10 locales are equally polished.

163. **Native ES/FR/DE translations for every per-asset surface.** Across 14 tradable cryptocurrencies, the per-asset FAQ entry (`what_is_<asset>`), the post-order asset-explainer tooltip, the address-format error, the address placeholder, the pill-title in chat, and the cheat-sheet section — every one of these has actual Spanish, French, and German translation pairs, not silent EN-fallback. 93 translation pairs added in cp54+cp55, with a registry-based policy-gate smoke that prevents future per-asset surfaces from skipping native-locale closure.

164. **Memory #29 native-locale policy is mechanically enforced.** A `per-asset-key-family-native-locale-floor-smoke` walks a registry of per-asset key families × 3 native locales (es/fr/de) × 16 tickers = 240 field-checks per CI run, refusing any value that's byte-identical to the EN baseline. EN-fallback smuggled into a native locale fails the build; new per-asset key families are one-line additions to the registry.

165. **Long-form FAQ + privacy-guide content translated to all 10 languages — mechanically enforced.** Memory #29 originally permitted EN-fallback for 6 community-translation backlog locales (it/pl/ru/fa/zh-CN/zh-HK); 13 batches across cp76-cp80 closed that backlog by translating every key with EN length ≥ 200 chars across all 6 locales. A cp80 smoke walks 293 long-form keys × 6 backlog locales = 1,758 translation pairs per CI run, refusing any byte-identical to EN. Future long-form content additions can't ship with English-only in the backlog locales.

166. **Every new asset ships its per-asset prose in all 10 locales — mechanically enforced.** When a ticker is added to `packages/asset-registry`, five mandatory i18n families must appear across every locale: the post-order asset explainer, the cheat-sheet entry, and three privacy-guide keys (one-line summary, intro body, and HTML meta description). A cp75 smoke walks the registry × families × locales = 800 key checks per CI run and fails if any one is missing; optional families like "caveats" (where some assets correctly have nothing to caveat) stay opt-in by design. New tickers can't slip through with prose in English only.

## 12. Pro-Monero culture, not just compatibility

167. **No Monero "lite" client logic.** Morphit does NOT try to interpret your Monero wallet. It's a coordination layer; your wallet is your wallet.

168. **Five independent Monero block explorers in the default config** (xmrchain.net, localmonero.co/blocks, monerohash.com/explorer, exploremonero.com, moneroexplorer.org) — operator-configurable to any list of compatible explorers, including self-hosted instances.

169. **Trade verification logic is per-asset.** Bitcoin uses one path (multi-explorer cross-check on UTXO confirmation), Monero uses another (TxID + amount-match against the recipient's expected, no view key required) — designed for each chain's actual privacy model.

170. **Privacy-respecting default for the XMR jitter toggle: ON.** A user has to deliberately turn jitter OFF if they want to send a round amount. Default is the privacy-preserving choice.

171. **Monero loadout in the asset registry includes piconero precision** (12 decimals). No truncation, no awkward display.

172. **No "Monero is risky / for criminals" UI text.** Anywhere. We trade XMR; we don't apologize for it.

173. **No Chainalysis, no on-chain analytics integration, no third-party "compliance" tooling.** Designs treat that as a leak surface, not a feature.

174. **Acknowledges privacy is a journey.** The METADATA-LEAK-CATALOG documents what we DON'T solve (e.g., the operator can see (but not log) an IP fetched a specific order list — solved by Tor users, not by Morphit alone). Honesty over PR.

175. **Documented in plain English: "Morphit cannot see this."** Throughout the chat-trade flow, the UI explicitly tells users which actions Morphit observes and which it doesn't. No false claims of total privacy where partial privacy is the truth.

176. **Pro-Monero stance in the welcome bonus.** New users with their first XMR trade get the same welcome bonus (10 BLURT liquid + 10 BLURT Power) as BLURT-fee payers, no second-class treatment.

## 13. Honest comparisons (CEX, fake DEX, P2P)

### vs. centralized exchanges (Binance, Coinbase, Kraken, etc.)

177. **No KYC.** They require government ID; Morphit asks for nothing.

178. **No deposits.** They custody your coins; Morphit never touches them.

179. **No frozen accounts.** They can freeze you; Morphit literally lacks the database table to track an account-freeze flag.

180. **No insolvency risk.** No exchange to go bankrupt. No custodial pool to lose. No "the bridge got hacked" headline applies to Morphit because there is no bridge — the relay never touches your funds.

181. **A smart contract custody escrow is still custody.** Funds sit in code controlled by someone (multisig, governance, admin keys). Morphit's funds NEVER sit anywhere — they go directly between the two parties.

182. **Morphit doesn't have admin keys.** Not in a multisig, not in a timelock, not anywhere.

183. **Smart contract bugs have rug-pulled billions.** Morphit's "smart contract" is the Blurt chain — a public ledger maintained by an independent nodes network that nobody can control.

184. **A "decentralized" exchange that depends on AWS isn't decentralized.** Morphit operators run on Pi 4s, mini-PCs, spare laptops, residential connections, and `.onion` services.

### vs. LocalBitcoins / Hodl Hodl / LocalCryptos / Bisq / Haveno / OM

185. **LocalBitcoins shut down.** Single-operator failure killed the platform. Morphit is federated; no single shutdown can do this.

186. **Hodl Hodl uses on-chain Bitcoin escrow.** That's better than CEX custody but still escrow. Morphit is fully no-escrow.

187. **Bisq has been hacked twice, user funds stolen. They require you to run their desktop app, a Tor node, and provide them with collateral.** Morphit runs in any browser, requires no collateral, and let's the user choose options like Tor, i2p, Lokinet, etc.

188. **Haveno/RetoSwap is Monero-only, non-PWA, not Grandma-friendly.** Morphit handles 16 tradable assets, ships as a PWA (no install on iOS, two taps on Android), and is built so non-crypto-native users can trade without reading 40 pages of docs. The Haveno/RetoSwap project does important work for Monero-only; Morphit complements it by being broader and easier.

189. **Haveno's 2-of-3 multisig escrow was exploited on May 20, 2026 for ~$2.7M.** A forged out-of-order arbitrator ACK message caused the Haveno client to update the arbitrator's node address mid-trade, letting attackers create a compromised multisig wallet before user funds were deposited; RetoSwap halted trading the same day (min client version raised to 2.0.0). Morphit's design has no arbitrator role, no multisig escrow, and no central coordination message Haveno's exploit relied on — so this attack class doesn't apply to our threat model. The tradeoff is real and stated honestly elsewhere on this list: Morphit users carry full self-custody and lean on signed on-chain reputation rather than an arbitrator's safety net.

190. **Some P2P platforms have admin "dispute resolution" that overrides users.** Morphit has no admin role; chat history is the dispute record, and it's signed and immutable.

## 14. What Morphit deliberately does NOT do

191. **No token sale.** No ICO. No IDO. No airdrops to manipulate "user count." There's no MORPHIT coin.

192. **No "premine."** The project earns by listing fees on its own instance, same as any other operator.

193. **No "governance token."** No proposals you don't care about; no votes you can't participate in.

194. **No "DAO."** Architectural decisions are made by the contributors; documented in ADRs; criticizable by anyone via the public issue tracker.

195. **No marketing partnerships with CEXes.** No referral codes. No yield-aggregator integrations.

196. **No "Pro" tier with extra features for paying customers.** The free Morphit IS Morphit.

197. **No "premium" customer support.** There's no standard support either — if you need help, ask on the operator's Matrix channel or read the FAQ. Honest.

198. **No NFT integration.** No "trade BTC for an ape JPEG."

199. **No leverage. No margin. No futures. No options.** Morphit is a spot fiat-crypto marketplace, full stop. Defi degens look elsewhere.

200. **No "AI assistant" trying to sell you a trade.** Just an orderbook.

201. **No app-store gatekeepers.** Morphit is a PWA — installs on Android via "Add to Home Screen," installs on iOS via Safari Share → Add to Home Screen. Apple App Store would reject a non-KYC P2P crypto app; we don't pretend otherwise.

## 15. Reach: every device, every network

202. **Progressive Web App** — installable as a standalone app on Android and iOS without going through Google Play or the Apple App Store.

203. **Service worker caches assets locally** — partial offline capability for previously-loaded pages and static content.

204. **Works in Tor Browser at maximum security level.** Service worker gracefully falls back to normal caching when service workers are disabled.

205. **F-Droid distribution path** for Android users who want a true open-source app store experience (placeholder; reproducible-build pipeline planned).

206. **Aptoide, APKMirror, APKPure listings** for Android users without Google Play.

207. **GrapheneOS callout** as the recommended privacy-first Android. No Google relationship required.

208. **iPhone PWA install instructions** in the `/download` page, in plain English, in 10 languages.

209. **No native Apple Store app planned.** Apple's guidelines forbid non-KYC P2P crypto apps; Morphit doesn't pretend otherwise. The PWA path is the lasting answer.

210. **Operator section on the `/download` page** shows the run-your-own-node path: source code, releases, setup walkthrough, supported systems, federation directory.

211. **RSS feeds for the orderbook** — real-time updates in your existing RSS reader. Asset-filtered, account-filtered, full-orderbook variants.

212. **SSE streams for the orderbook** — live deltas without polling.

213. **`no-js` graceful degradation.** The footer link advertises that the static parts of Morphit work without JavaScript, for users on Tor's max-security level or otherwise locked-down browsers.

214. **Public, free, documented HTTP API.** Anyone can build a block explorer, an aggregator, a CLI client, a price feed, a federation health monitor — without asking permission.

215. **API self-hosting recommended at scale.** If you're building something high-volume on the API, the recommended path is to run your own indexer ($5/month VPS) — no negotiation, no allowlist, no rate limits.

216. **Federation health visible to everyone.** `/instances` shows every known instance and its probe status. Aggregators and end users alike can monitor the federation in real time.

## 16. Built-in tools — block explorer, activity stats, payment QR codes

217. **Built-in block explorer at `/explorer`.** Search by Blurt account name, transaction ID, or block number — Morphit ships its own explorer so you don't have to trust a third-party block-explorer site (which sees your IP and search history). The explorer is served by the same indexer that powers the orderbook; same trust model, same operator, no extra service to inspect.

218. **Trading-activity dashboard at `/explorer/activity`.** Daily fee revenue, top-5 trading pairs, federation-wide order volume — all derived from public chain data, no analytics scripts. Useful for traders deciding which assets are liquid, and for operators showing prospective traders what the marketplace looks like at scale. Same data the project uses internally; nothing hidden.

219. **Cross-chain explorer links inside chat.** When a counterparty sends you a Bitcoin txid, the chat bubble auto-routes to mempool.space; Monero txid auto-routes to xmrchain.net (or the operator-configured XMR explorer); BLURT txid routes to the in-app `/explorer`. Click → confirm payment landed. No copy-paste-into-a-third-party-site dance.

220. **Display-payment QR codes for receiving addresses.** Share a receive address through the trade flow and Morphit can render it as a QR code on screen, using the right URI scheme per asset (BIP-21 for Bitcoin-family, official Monero URI, ZIP-321 for Zcash, Solana Pay, EIP-681 for EVM, XRPL URI, etc.). The buyer scans with their mobile wallet's camera. Works on `.onion` instances, works in Tor Browser, works without any third-party QR-image service — the QR library is lazy-loaded so users who never tap "Show QR" don't pay the bytes.

221. **Live BLURT staking APR display** in the balance card. Computed locally from chain DGP — no third-party endpoint, no CoinGecko, no fee-feed dependency. (Current chain inflation is 7.6% as of 2026-05-03; ~75% of new emission goes to BP holders pro-rata, so the real APR per staked BP unit varies with the vesting pool size.)

## 17. Trade anything — barter, cash, precious metals

222. **Curated registry of 40+ payment methods** organized by category: crypto (BTC ↔ XMR, etc.), bank rails (Zelle, Interac e-Transfer, SPEI, Oxxo Pay, SEPA), in-person, and operator-defined extras. Pickers fuzzy-match on the canonical 40-entry list to avoid the "did you mean Cash App or CashApp or Venmo or PayPal" dropdown soup.

223. **Barter for goods is a first-class payment method.** Trade crypto for a used bicycle, a vintage typewriter, or a haircut — the chat flow has "Goods or services" as a payment method alongside cash and bank transfer. Photos can be attached (chain-stored, signed). The seller and buyer negotiate; Morphit just provides the orderbook + chat + escrow-free settlement on the asset side.

224. **Cash + precious metals (gold/silver coins/bars)** also covered as in-person methods. Meet up, exchange, leave on-chain feedback. Morphit's role ends at "facilitating the introduction"; the actual exchange is between two humans.

225. **Cash by mail is its own payment method, with structured proof-of-shipment.** Distinct from "Cash in person" because the operational reality is different: you mail an envelope of paper currency to your counterparty across town or across the world. The chat composer has dedicated "Share mailing address" and "Record shipment" buttons that build structured payloads — recipient sees a 📬 address pill (copy-formatted button) and a 📦 shipped-via pill with a clickable "Track package" link. Both pills stay in end-to-end-encrypted chat only — never written to the indexer, never on-chain, never federation-readable.

226. **Top 20 worldwide carriers bundled with clickable tracking links.** The Record-Shipment modal includes a curated dropdown — USPS, UPS, FedEx, DHL Express, Royal Mail, La Poste, Deutsche Post, Poste Italiane, Correos, Poczta Polska, Pochta Rossii, China Post EMS, Hongkong Post, Japan Post, Australia Post, Canada Post, India Post, Iran Post, SF Express, Aramex — covering every supported locale's primary postal service. An "Other (specify carrier)" escape hatch lets users type any carrier name + tracking URL when their service isn't bundled. Tracking number is optional (not required) so users who chose untracked mail can still record the shipment.

227. **Operator-defined payment methods.** Per-instance, an operator can add region-specific payment rails their community uses (a local fintech app, a national bank-transfer system) without forking the codebase — the registry is operator-extensible.

## 18. Operator setup — even your grandma can run a node

228. **Beautiful CLI setup wizard.** The wizard walks new operators through everything: pre-flight system check, ELI5-friendly prompts for the basics (instance name, accounts, networks), review-and-confirm screen, write the config. End-to-end in about 15 minutes.

229. **Browser setup-wizard for live config tweaks.** Once your instance is up, visit `/admin/setup-wizard` on your domain to toggle which assets you list and to add or remove per-instance payment methods. The page emits the exact env-var line or CLI command — paste into `morphit.config.env` (then restart the indexer) or into your terminal (no restart). Read-only by design — never mutates your server, no auth-gating attack surface to maintain; full operator UX walkthrough in `docs/RUN-A-MORPHIT-NODE.md`.

230. **The system check tells you what's wrong, not just "ERROR".** Pre-flight verifies CPU, RAM, free disk, OS family, and network reachability — and if any check fails, you get a specific human-readable explanation of what to do next.

231. **One-command deployment.** Once the config is written, a single command brings up the indexer, relay, and database in one shot.

232. **Federation registration is one CLI broadcast.** After setup, a single chain op puts you in the federation directory globally — you show up on every other Morphit instance's `/instances` page within seconds.

233. **Operational runbook with concrete cron snippets.** `OPERATIONS.md` ships copy-pasteable cron snippets for the operational tasks that should be automated (weekly ACT minting, TLS certificate renewal monitoring). Set up once, the runbook walks you through verifying each.

234. **Sign in to a strange computer by scanning a QR with your phone.** Posting key never leaves the phone. Your phone shows a confirmation card with the website name so you can spot phishing like `morph1t.io` before tapping "Yes, that was me." See `docs/adr/0022-desktop-qr-pairing.md` for the full protocol and threat model.

235. **Adding new tradable assets is usually a single day's work.** The canonical asset list lives in one package (`packages/asset-registry/`); add an entry with the right flags (tradable, can-pay-fees, supported-networks), drop a logo, add per-asset translations, register the explorer URL templates. Pre-2026 the same change required edits at 32 separate sites; now it's contained. Currently shipped: 16 assets across BTC, XMR, BLURT, USDT/USDC/DAI (multi-network EVM stablecoins), BCH, LTC, DASH, DOGE (UTXO chains), ZEC, ARRR (shielded chains), DCR (hybrid PoW/PoS), SOL, ETH, XRP.

236. **Adding a new language is a single-array edit.** Drop a translation JSON, add the locale code to the supported array. The framework knows the difference between "shipped" and "in progress" — work-in-progress translations don't appear in the language switcher until they're done. Translator workflow is documented for native-speaker contributors.

237. **Witness fee alerts carry actionable delta information.** When Blurt's chain account-creation fee changes (the cost an operator's relay pays for each signup), the operator gets an alert with the old value, the new value, the percentage change, and the direction — not just "fee changed."

238. **Build from source, with reproducibility as a project goal.** Operators can build the frontend locally and verify the bytes match what the project published; the build emits a SHA-256 manifest of every served file, recorded on chain. No privileged build pipeline — every operator builds the same source.

239. **Operators publish two I2P addresses, both render.** Operators with both a long-form `.b32.i2p` (always-resolvable) AND a human-readable `.i2p` alias can publish both. The footer renders both as separate chips; the directory shows both for every operator that publishes them. Backwards-compatible with single-address operators.

240. **Discretionary bug bounty program.** Find a real security bug — privacy leak, signup-drain vulnerability, cryptographic flaw — disclose responsibly via `@agorise:matrix.org`, and the operator may compensate you in BTC, XMR, or BLURT at their discretion. No formal program scope, no rigid payout grid — the operator decides based on severity, novelty, and demonstrability. Honest framing: this isn't HackerOne, it's a thanks-with-money for genuinely good security research.

241. **Weekly automated warrant canary.** Every Monday at 00:00 UTC the canonical operator signs a short statement ("no warrants received this week") and broadcasts it as a chain op. If the signature stops appearing for two consecutive weeks, the chain itself surfaces the missing signal — no operator can be compelled to lie because the silence is the message. Federated instances run their own canaries on their own schedules.

242. **PGP keys link in the footer for canary verification.** Operators publish their release-signing keys as a downloadable `.asc` file. Anyone can import and verify operator-signed canaries and releases. Footer link translated to all 10 locales.

243. **Server hardening below the application layer is documented in copy-pasteable detail.** SSH, unattended security upgrades, kernel hardening, filesystem mount hardening, systemd unit isolation, Postgres SCRAM-SHA-256, encrypted backups, outbound egress allowlist, alerting — operators can apply as much or as little as fits their threat model. Recommended baseline highlighted explicitly.

244. **High-value account names get extra friction.** Short names, obvious brand names, common dictionary words, and enumeration patterns get classified at signup time and handled per the operator's policy. Three policy modes (strict / moderate / off) — operator's call. Legitimate year-suffix names (`bob-1990`, `crypto-noob-2026`) explicitly pass.

245. **Sequential signup pattern detection.** Patterns like `account001` / `account002` / `account003` get caught at signup time — operator-tunable, per-IP-bucket isolation so an attacker controlling multiple ranges still hits the threshold separately on each.

246. **Trusted-proxy IP allowlist with CIDR support.** Operators running behind a reverse proxy (BunkerWeb in Docker, multi-host nginx, etc.) can correctly preserve client IPs for rate limiting. Without this, a Dockerized reverse proxy would funnel every client through a single rate-limit bucket — one abuser exhausting the daily cap for everyone.

247. **Turnkey BunkerWeb deployment with cross-reference parity enforcement.** The morphit repo ships a tested BunkerWeb config at `ops/bunkerweb/` — docker-compose + env template with OWASP CRS paranoia 3, anti-`Referer: none` on the invite endpoint, real-IP forwarding wired correctly, and a pinned `172.20.0.0/16` Docker network CIDR. A CI smoke (cp61-O14) enforces that the Ansible default for `MORPHIT_RELAY_TRUSTED_PROXY_IPS` matches this CIDR — getting them out of sync (the cp61-D1 bug, fixed at cp61) silently breaks per-IP rate limiting. Operators copy + edit two values + `docker compose up -d` and have a WAF-fronted instance.

248. **Cross-document value-invariant CI gate, registry-driven.** When one value lives in multiple files (DB name, port, account, network name, CIDR) and one file drifts, the deploy breaks silently. The cp66 smoke generalizes cp61-O14 into a registry of invariants — each with a single source-of-truth file and a list of consumer files that must agree. Eleven ship at launch (postgres DB name, postgres user, postgres port, treasury fee-recipient default, indexer and relay BunkerWeb bind ports, bunkerweb_net network name, relay and indexer bare-metal listen-port defaults, matrix-bot healthcheck port, BunkerWeb network CIDR); adding new ones is data, not new runner code, and every drift is mutation-tested.

249. **Operator-doc section length is bounded by CI.** OPERATIONS.md, RUN-A-MORPHIT-NODE.md, PRE-LAUNCH-CHECKLIST.md and ADRs are detailed by design, but a section that grows past its per-doc threshold becomes a small book inside a larger book — search context balloons, readers lose place, edits get scary. The cp69 smoke flags newly-outsize sections so they get split into sub-runbooks instead of growing forever. Existing oversize sections are allow-listed with a documented plan to split.

250. **Ansible playbook idempotency is enforced by CI.** The README promises "re-running the playbook is a no-op when the system is in the desired state." Tasks using `command:`, `shell:`, or `raw:` execute arbitrary processes — Ansible can't tell whether they changed state, so they need an explicit guard (`creates:`, `removes:`, `changed_when:`, `when:`, `check_mode:`). The cp69 smoke walks every ansible task; an unguarded action surfaces in CI so the playbook stays trustworthy.

251. **Unit-test pass count is locked by CI.** The cp71 vitest-must-pass smoke runs `vitest --run` per workspace (indexer, relay, web — 1,344 tests across 3 workspaces) and asserts the pass count meets a baseline. Test-rot — handlers evolving without their tests being updated — used to go undetected for months. Now a drift incident surfaces immediately as a smoke failure, so handlers and their tests stay in lock-step.

252. **Untrusted-input parseInt is forbidden without a strict pre-check.** `parseInt('999000abc', 10) = 999000` silently accepts trailing garbage. When the input is operator-controlled or user-controlled (HTTP headers, query params, env vars), the partial parse can let malformed values past the validity check. The cp71 smoke greps the codebase for `parseInt`/`parseFloat` on plausibly-untrusted inputs and requires each to be preceded by `/^\d+$/.test(s)` or document-able as trusted in the allow-list.

253. **Every fetch() has a timeout.** Without an AbortController + setTimeout, a slow or hung remote endpoint blocks the calling code indefinitely — a UI in 'loading' forever, an ops-cli command that never exits. The cp71 smoke walks all .ts and .svelte source and verifies every fetch() call has a `signal:` from an AbortController nearby (or is allow-listed as a browser-managed exception). 14 unbounded fetches were caught and converted to use a centralized `fetchWithTimeout` helper at cp71 ship time.

254. **Every route's SEO metadata is locale-complete.** When a new route is added to `apps/web/src/lib/seo/routes.ts`, the matching `seo.<key>.title` and `seo.<key>.description` must exist in all 10 locales — or the route ships with empty meta tags in the locales that forgot. The cp74 smoke walks the route registry against every locale JSON and fails CI if any pair is missing. This caught cp73-D11 (missing `seo.privacy_index` in 10 locales) statically, so future routes can't slip through with English-only SEO.

255. **Squatter defense operator playbook.** A tactical runbook for operators concerned about name-squatting: env config, log monitoring, attacker-pattern recognition, weekly audit procedure, active-attack incident response, network-layer defenses, and a "diamond-hardened" preset for operators willing to accept moderately higher friction for maximum resistance.

256. **Comprehensive threat model with documented attack scenarios.** Every credible attacker behavior across the four primary attack surfaces (frontend, indexer, relay, Blurt chain) is enumerated as a STRIDE row, with the existing in-code mitigation named and cross-referenced. Residual risks stated honestly; open gaps flagged. Regenerated when meaningful new attack surface ships.

257. **Operator alerts to a private Matrix DM with three-tier routing.** A turnkey sidecar (`apps/matrix-bot/`) tails journalctl, classifies indexer + relay events into CRITICAL (immediate DM, no rate limit), WARN (1/hour per category), and INFO (daily 09:00 UTC digest, skipped on quiet days), and DMs the operator's private MXID end-to-end-encrypted. Branded TypeScript types prevent confusing the private MXID (`@user:server`) with a public room alias (`#room:server`) at compile time — security disclosures never accidentally route to a public channel. Comma-separate multiple MXIDs in `MORPHIT_MATRIX_BOT_ALERT_MXID` for vacation coverage.

258. **Resource alerts that read like advice, not alarms.** A POSIX-sh sidecar polls disk, memory, swap, CPU, and swap-thrashing every 5 minutes; alerts go through the matrix-bot in three tiers with ELI5 advice and the exact debug command ("free space NOW: `sudo journalctl --vacuum-time=7d`, `sudo apt clean`"). Sidecars exit silently on hosts without the things they monitor — safe to enable defensively across operator instances.

259. **Kernel-log monitoring catches what the resource monitor can't.** A separate sidecar scans the kernel ring buffer every 5 minutes for OOM-killer activations (with the victim process name and PID), kernel oopses and panics, hardware errors (MCE / EDAC / ATA), and morphit-service segfaults. The resource monitor sees memory pressure *building*; the kernel-log monitor sees what got killed when it broke. Cursor-based state means successive runs don't re-alert on old events.

260. **Disk health and RAID monitored before silent data loss.** SMART self-tests every 6 hours alert on imminent drive failure, reallocated/pending sectors, and high temperature with the exact `smartctl -a /dev/X` command to investigate. Linux software RAID (`/proc/mdstat`) is checked every 15 minutes for degraded or failed arrays. Sidecars exit silently on hosts without SMART/RAID — safe to enable defensively.

261. **The "alerting is silently failing" detector — and the silent TLS-renewal-failing detector too.** Most monitoring stacks miss two killer patterns: email alerting that broke silently (smarthost credentials rotated, TLS cert expired) and certbot renewals that stopped working months ago. Morphit's postfix-queue monitor alerts via the matrix-bot when mail queue depth or oldest-message age cross thresholds — alert still arrives when email is dead. The certbot monitor correlates cert expiry against the last successful renewal in `letsencrypt.log` and fires `renewal_stalled` long before the cert actually expires.

262. **OS health surfaced through the same channel as everything else.** Pending security updates (`apt list --upgradable` parsed for the `-security` suffix), systemd units in `failed` state (caught by the systemd-monitor since failed-to-start units emit no journal output journalctl-based alerting can route), journal disk growing toward gigabytes (catches "journal silently grew to 8 GB over six months"), and a daily trivy Docker-image CVE rescan against running containers — all DMed with the exact remediation command. Operators don't have to read every CVE advisory or check the motd.

263. **Docker Compose service health, including the silent-unhealthy state.** `docker compose ps --format json` is polled every 5 minutes; `service_unhealthy` fires when the container is running but its declared health-check is failing — the silent-degradation state most operators miss because `docker ps` still shows "up." Restart-loop detection covers services whose `restart: always` policy is masking a real bug.

264. **One-command Ansible deployment.** Fill in `group_vars/all.yml` (8 mandatory values: domain, operator account, posting key file, db creds, alert MXID), run `ansible-playbook playbook.yml`, and 25 minutes later you have a fully-configured Morphit instance with BunkerWeb WAF, systemd services, postgres, certbot TLS, matrix-bot alerts, and host monitoring. Idempotent — re-runs only change what drifted. The full playbook source is `ops/ansible/`.

265. **Native-language translations across every locale, not English fallbacks.** A systematic audit and translator pass closed real translation gaps — strings that had been silently shipping in English because earlier translator passes missed them. Now backed by a regression smoke that flags any same-as-English value outside a documented allow-list, so future translator drift fails CI rather than user-report time.

266. **Plain-language `/glossary` route.** "Trade-only," "trust score," "orderbook," "escrow-free," "federation" — defined in plain English with a one-sentence example each, not crypto-jargon. No need to keep a browser tab on Wikipedia open while learning Morphit. Linked from every page footer.

267. **In-context glossary tooltips.** A `<Term>` component surfaces glossary definitions on hover or tap, with a dotted-underline cue on first appearance per route. Restrained by design — callers opt-in word by word rather than auto-detecting across rendered text. Power users get the protection; everyone else sees clean reading flow.

268. **Onboarding copy softened — same custody truth, less doom-laden framing.** The seed-phrase confirmation reads as a commitment to action ("I'll keep these 12 words safe — I know they're the only way back into my account") rather than a legal disclaimer ("I understand losing this means everything is gone"). Same fact, friendlier voice, in all 10 locales.

269. **"Your fee-rejected order silently vanished" cliff closed.** When the relay rejects your listing fee for any reason (wrong amount, wrong fee_method, low operator balance, wrong recipient), you get a chat message explaining exactly which validation step failed and the corrective action. No more "I posted my order three hours ago and it never appeared" mystery.

270. **Chat composer surfaces a soft proofread reminder before accidentally-public chat goes out.** When you're typing what looks like a private message ("my address is...", "my real name is...", "my bank account is...") into a public chat channel, Morphit shows a soft amber banner: "This channel is public. Did you mean to DM?" One tap to keep typing, one tap to switch to DM. Doesn't block; just nudges.

271. **Printable seed-phrase backup card.** One click in the onboarding flow prints a paper-friendly backup card via the browser's native print dialog — no PDF library, no server round trip, no third-party dependency. Seed phrase never leaves the device. Pick paper or save-as-PDF; the rest of the page is hidden during print.

272. **First-post starter pack.** First-time posters see a green-tinted card with three safe-default tips (start small, 7-day expiry, pick payment methods you actually accept) and a deep link to the trade-walkthrough FAQ. Self-hides once the user has any prior posting experience. Privacy posture: client-side only.

273. **Centralized locale-aware number/date formatters.** Currency, percent, BLURT amount, count, and date helpers all read the active locale. A German user sees "1.234,56" where a US user sees "1,234.56" — no ad-hoc `.toFixed()` calls drifting across the codebase.

274. **Printable one-page cheat-sheet at `/cheat-sheet`.** A landscape A4 / US Letter sheet with the trade flow on the left, the chat-paste safety rules in the middle, and the per-asset quick-reference table on the right. Fold and put it on your desk; hand it to the grandma you're onboarding. Print-friendly CSS strips colors and reformats for a single black-and-white page.

275. **Identity-label policy enforced consistently.** Every place a user account name appears in the UI renders with its identicon, so brand-new Blurt accounts are visually distinguishable. Spoofing attempts like `@morph1t` vs `@morphit` are visually obvious, not just textually different. Backed by a regression smoke catching future raw-render drift at CI time.

276. **Onboarding back-button on the review stage that wipes the just-generated seed before returning to the path picker.** A confirmation modal warns the user they're discarding the 12 words; on confirm, the seed is wiped from memory and the form state resets. Three "discard the unsaved identity" code paths now use the same wipe pattern.

277. **`/post` remembers your fiat currency and region across sessions.** Stored in your browser, never sent to any server, never on chain. Clear the preference any time from `/settings`. A "Preferences" section lets you review what's saved.

278. **Route-transition focus management for screen-reader users.** Navigating from page to page moves focus to the main region on every real route change. Screen readers announce the page change; sighted users see no visual disruption. Heading hierarchy is audited and codified as a regression smoke so future drift fails CI.

279. **Static-source color-contrast smoke.** Every text/background color pairing across the frontend is checked against WCAG AA at the source level — 161 pairs across 96 Svelte files, zero below threshold.

280. **Treasury chain-pin closes a real fork-attack vector.** BTC/XMR fee addresses are signed by `@morphit` on chain via the existing release trust anchor. Every federated indexer prefers the chain-pinned address over its own configured value. A hostile fork can only divert fees on its own instance — every other federated indexer marks those orders unverified, and the divergence is itself a defection signal anyone scraping multiple instances can detect.

281. **No Morphit instance — not even canonical morphit.io — holds any user's funds.** Every trade settles peer-to-peer between the two parties' wallets. The operator runs an orderbook + chat relay + fee-collection account, not a custodial pool. If morphit.io shut down tomorrow, every order still settles via any other federated instance — your funds were never on morphit.io to begin with.

282. **Per-operator chat-link external explorer URLs.** When a counterparty sends a BTC or XMR transaction ID in chat, Morphit renders it as a clickable link that opens the transaction in an external block explorer. Operators who self-host their own explorers can override per-instance; everyone else inherits the bundled defaults. The override is per-operator (not per-user) — a user who wants different behavior chooses a different Morphit instance.

283. **Multi-explorer quorum gate on fee verifiers.** Operators can require N-of-M explorer agreement before accepting a fee verdict. Below the threshold, the verifier marks the order pending-external rather than accepting a degraded single-source result. Default is 1 (back-compat with smaller instances); operators with the full 5-explorer default list can set the threshold to 2 or 3 for genuine multi-source cross-check.

284. **Setup wizard configures explorer URLs with live health probes.** Each URL gets a ✓ / ⚠ / ✗ status indicator with latency on screen. Probes hit each explorer's standard health endpoint — no real transaction IDs or addresses sent. Non-blocking: operators can configure URLs that fail probes (might be configuring an explorer not yet online, or running offline).

285. **Per-operator listing fee USD target with live price recompute.** The operator picks a USD target (default $0.25), the wizard fetches live BTC/USD and XMR/USD prices, computes equivalent amounts, displays them, and asks for accept-or-override. Same step is reachable from the maintenance menu for ongoing tuning.

286. **Pre-launch + day-zero + week-one runbooks: three distinct documents, one continuous operator experience.** Pre-launch checklist → launch-day rehearsal + T-zero procedure + first-hour monitoring + rollback plan → week-one monitoring rolled up daily and weekly. Each doc has clear handoff to the next. Community operators get a wizard that configures the node and runbooks that tell them what to *do* with it.

287. **Federation cost attribution: each operator's relay pays only for ops that route through their own instance.** Before this fix, every federated indexer would have queued payouts on every op it saw — multiplying treasury spend by the federation count. Now each operator only pays the welcome bonus, refills, and loyalty BP for ops that name their instance tag. The operator getting the 90% fee reward is also the operator obligated for the consequences.

288. **Reputation attack-surface audit closed two real gaps.** Untethered "free" feedback citations are now rejected (fake-feedback targets require a real listing fee payment). Coordinated low-rating pile-on detection catches Sybil clusters depressing a real trader's reputation, with strict false-positive guards so a legitimate user reviewing multiple counterparties is never flagged. Flagged reviews stay visible on the subject's profile list but don't drive the numeric rating.

289. **QR-pair real sign-in: read-only desktop session.** Pairing your phone establishes a read-only session on the desktop — posting key stays on the phone, all writes route through the phone for signing. WhatsApp-Web mental model — phone is the source of truth, desktop is a window. A clear banner keeps you aware of session shape; "use your phone to sign this" affordances appear on every write surface (post an order, send a chat, leave feedback).

290. **Paired-readonly affordance gap sweep.** Every write call site explains why you need your phone, with deep links that preserve context (which order to edit, which peer to message). No more silent disappearances or misleading "session locked, unlock to continue" CTAs that paired users can't satisfy.

291. **Price-model picker on `/post/edit`.** Change your spread or flat price without cancelling and re-listing. Loses no engagement metrics, no fee status, no prior view counts. Defensively handles legacy and unknown shapes — never silently drops user intent.

292. **Persona walk-throughs as standing engineering discipline.** Three personas run end-to-end at the top of every major session: Bob (existing Blurt user), Sally (never owned crypto), Sally-as-operator (sets up her own node from any of the operator docs). Findings get fixed inline; locale parity across 10 languages holds throughout. Catches UX gaps no backlog list catches.

293. **Operator-doc audit pinned by regression smokes.** Every CLI command, every environment variable, every API field path, every install location named in the operator docs is sentinel-grep checked against the real code. When the docs and the code disagree, CI fails loudly before the operator copy-pastes from a doc that lies.

294. **USDT (Tether) peer-to-peer across four networks.** Trade USDT on Ethereum (ERC-20), Tron (TRC-20), Solana (SPL), or BNB Smart Chain (BEP-20) — peer to peer, non-custodial, no KYC. The most-traded stablecoin in the world, with the price stability active traders rely on. Trade-only on Morphit (listing fees stay BLURT/BTC/XMR per the frozen fee enum); operators can disable USDT on their instance with one env var if they prefer to specialize.

295. **No default USDT network — every USDT trade is an explicit network commit.** Cross-network sends are unrecoverable (USDT-ERC20 to a TRC-20 address loses the funds, period). Morphit's UI refuses to let the user default into that mistake: every USDT trade picks the network deliberately, every USDT address shared in chat carries a bold per-network header and a permanent per-message reminder of which chain it's for, and the post-order form won't submit until the network is chosen. Friction by design — the right kind of friction.

296. **Arbitrage between Morphit and exchanges is built for, not built against.** Morphit's listing fee is a fraction of a dollar; no taker fee, no withdrawal fee, no withdrawal limit. The price-model picker lets a trader run a thin-spread arbitrage strategy on their own listings (set `spread: 0.5%` and let the orderbook fill at-or-above CoinGecko mid). As liquidity grows, arbitrageurs pull the P2P prices into line with global market — good for everyone.

297. **Each instance's asset policy is visible up front.** Open `/about-this-instance` on any Morphit and you see which assets that operator accepts at a glance — green for "accepts everything," amber for "accepts most," red for "tight policy." No surprises after you've already posted an order.

298. **No flash of English content for non-English speakers.** Every page is prerendered per locale — `/de/orderbook` ships German bytes, `/fa/orderbook` ships Persian, `/zh-HK/orderbook` ships Traditional Chinese. No layout flicker, no client-side translation reload — what you see is what you get from the first byte.

299. **Bitcoin Cash (BCH) peer-to-peer.** Trade BCH on Morphit — bigger blocks and lower fees than BTC, transparent and decentralized with no issuer who can freeze addresses. Single mainnet, single CashAddr address format, no bridges. Trade-only on Morphit (listing fees stay BLURT/BTC/XMR per the frozen fee enum).

300. **Setup wizard handles trade-only-asset opt-out — no manual env editing.** Step 13 of `morphit-ops init` walks operators through each tradable asset and asks per-ticker whether to disable. Picks emit the right `MORPHIT_INDEXER_DISABLED_ASSETS=` line automatically. Grandma-friendly: zero shell editing for the most common operator-stance decision.

301. **Litecoin (LTC) peer-to-peer.** Trade LTC on Morphit — fast 2.5-minute blocks, low transaction fees, transparent and decentralized like Bitcoin with no central issuer. Three address formats accepted (legacy `L`, P2SH `M`/`3`, bech32 `ltc1`). Trade-only on Morphit (listing fees stay BLURT/BTC/XMR).

302. **Dash (DASH) peer-to-peer.** Trade DASH on Morphit — fast-confirmation Bitcoin-family chain with optional InstantSend (sub-second confirmations) and opt-in PrivateSend mixing via masternodes. Two address formats accepted (`X` legacy, `7` P2SH). Trade-only on Morphit (listing fees stay BLURT/BTC/XMR).

303. **USD Coin (USDC) peer-to-peer across four networks.** Trade USDC on Ethereum, Solana, Base, or Polygon — peer to peer, non-custodial, no KYC. Pick whichever network you and your counterparty both support; Morphit's network picker locks it in at post time so a cross-network send can't accidentally lose your funds. Honest disclosure: Circle (the issuer) can freeze any USDC address on demand — exactly why Morphit ships USDC as trade-only and never pays its own listing fees in it.

304. **Dai (DAI) peer-to-peer across four networks — the meaningfully-decentralized stablecoin.** Trade DAI on Ethereum, Polygon, Base, or Arbitrum — peer to peer, non-custodial, no KYC. Unlike USDT and USDC, DAI is not issued by a corporate entity — it's governed by MKR token-holders through on-chain votes, with no admin-freeze function on the token contract itself. Honest nuance: MakerDAO's Peg Stability Module holds USDC as collateral, so Circle's freeze power indirectly affects DAI redeemability — meaningful-but-not-perfect decentralization.

305. **Dogecoin (DOGE) peer-to-peer.** Trade DOGE peer to peer — non-custodial, no KYC. Fair-launched in 2013 with no premine after the first year, merge-mined with Litecoin since 2014 so DOGE inherits LTC's hashrate-security. Transparent base layer; wallet-side address rotation is the privacy lever — trade-only on Morphit.

306. **Zcash (ZEC) peer-to-peer with per-address privacy choice.** Trade ZEC peer to peer — non-custodial, no KYC. Two address families coexist on the same chain: transparent (`t1`/`t3`, publicly-visible like Bitcoin legacy) and shielded (`zs1` Sapling, `u1` Unified Address) that hide sender, recipient, and amount via zk-SNARKs. Pick the address type that fits each trade's privacy posture — trade-only on Morphit.

307. **Pirate Chain (ARRR) peer-to-peer with chain-level shielded transactions.** Trade ARRR peer to peer — non-custodial, no KYC. Pirate Chain runs only the Sapling zk-SNARK shielded pool, so every transfer hides sender, recipient, and amount by construction (no transparent address option at all). Single address format (`zs1` Sapling), trade-only on Morphit.

308. **Decred (DCR) peer-to-peer with hybrid PoW/PoS consensus and on-chain governance.** Trade DCR peer to peer — non-custodial, no KYC. Every block is mined by PoW miners AND voted on by 5 PoS ticket-holders, so neither group alone can change protocol rules. On-chain governance via Politeia lets stakeholders propose, debate, and ratify changes — trade-only on Morphit.

309. **Solana (SOL) peer-to-peer with delegated Proof-of-Stake and high-throughput PoH sequencing.** Trade SOL peer to peer — non-custodial, no KYC, no central freeze authority. Solana addresses look identical to USDT/USDC SPL token-account addresses, so the `asset` field on each order disambiguates — Morphit shows you which asset you're sending. Trade-only on Morphit.

310. **Ethereum (ETH) peer-to-peer with post-Merge Proof-of-Stake.** Trade ETH peer to peer — non-custodial, no KYC, no central freeze authority. EVM addresses look identical across ETH/USDT-ERC20/USDC-ERC20/DAI-ERC20/Base/Polygon/Arbitrum, so Morphit's `asset` + `network` fields disambiguate (and ENS names aren't resolved — no centralized RPC dependency). Trade-only on Morphit.

311. **Ripple (XRP) peer-to-peer with Federated Byzantine Agreement consensus.** Trade XRP peer to peer — non-custodial, no KYC. Native XRP cannot be frozen by any central authority (only IOU-token variants on XRPL can; native XRP cannot), and Morphit's post-flow surfaces the two XRPL gotchas — destination tags (required when sending to exchange-hosted addresses) and the 1-XRP base reserve (first receive needs ≥1 XRP). Trade-only on Morphit.

## How to verify any of the above

Every claim in this document is verifiable. The repository is at **git.agorise.net/agorise/morphit**. Specific anchors:

- **Smoke suite**: `bash scripts/run-smokes.sh` — runs several thousand self-checks across ~150 runners, triple-pulse stable
- **Audit log**: `docs/AUDIT-2026-05.md`
- **Architecture decisions**: `docs/adr/0001-*.md` through `docs/adr/0038-*.md` (37 ADRs; 0016 was retracted and the number isn't reused)
- **Fees and rewards**: `docs/FEES-AND-REWARDS.md` (line-cited to source)
- **Public API**: `docs/API.md`
- **Operator runbook**: `docs/OPERATIONS.md`
- **Security disclosure**: `docs/SECURITY.md` (Matrix-only)
- **Frontend integrity**: every page's served bundle hashes against the on-chain `morphit_release_v1` op
- **License**: `LICENSE` (AGPL-3.0)

Don't trust this list. Verify it. That's the whole point.

---

*311 specific selling points. None of them invented. All of them shipped, documented, or honestly disclosed as backlog. If you find one that isn't accurate, open an issue at git.agorise.net/agorise/morphit and we'll either fix the claim or fix the code. Last updated 2026-05-22.*
