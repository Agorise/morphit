/**
 * Morphit chat — structured payload encode/decode (Phase F).
 *
 * Buyers and sellers exchange receiving addresses for the traded
 * asset (BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC) and "funds sent"
 * acknowledgments inside encrypted chat messages.  The chat layer
 * below this module treats the inner plaintext as an opaque
 * string — encryption, broadcast, and indexer storage don't care
 * about its shape.  This module is the structured shape that
 * rides inside the plaintext.
 *
 * ─── Wire format ───────────────────────────────────────────────
 *
 * Inside the encrypted plaintext, structured messages are JSON.
 * Plain-text user messages stay as-is — the renderer attempts
 * JSON.parse and falls back to plaintext rendering when parse
 * fails or the parsed object doesn't shape-match.
 *
 * Address handoff:
 *   {
 *     "v": 1,
 *     "kind": "morphit_addr",
 *     "method": "btc" | "xmr",
 *     "address": string,
 *     "amount"?: string,         // e.g. "0.005"
 *     "order_permlink"?: string, // pin to a specific trade
 *     "note"?: string            // optional free-text, ≤100 chars
 *   }
 *
 * Funds-sent acknowledgment:
 *   {
 *     "v": 1,
 *     "kind": "morphit_funds_sent",
 *     "method": "btc" | "xmr",
 *     "txid": string,
 *     "amount"?: string,
 *     "order_permlink"?: string,
 *     "note"?: string
 *   }
 *
 * ─── Validation philosophy ────────────────────────────────────
 *
 * We do CHEAP SHAPE checks here: regex against known address
 * formats, length bounds, charset.  We do NOT verify
 * checksums (Base58Check for BTC P2PKH/P2SH, bech32 for SegWit,
 * monero crypto-checksum for XMR).  Reasons:
 *
 *   1. Bundle size.  bitcoinjs-lib + monero-js add ~300kB to
 *      the chat chunk on top of libsodium's ~250kB; we already
 *      lazy-load chat to keep the inbox tiny, so doubling its
 *      chunk would walk back the Phase E.5 wins.
 *
 *   2. Defense in depth elsewhere.  When the recipient eventually
 *      sends actual funds to the address, their wallet does the
 *      checksum verify.  A typo'd address there is a wallet
 *      rejection, not a lost transaction.
 *
 *   3. Layer of protection still present.  The cheap shape check
 *      catches the most likely class of error (paste went wrong,
 *      truncated address, mistyped prefix) before the message
 *      leaves the sender's composer.  Catastrophic typos that
 *      pass our shape check would also pass any user's eyeball
 *      check — the regex is approximately as good as a human
 *      glance.
 *
 * ─── Versioning ───────────────────────────────────────────────
 *
 * `v: 1` is the only currently-defined version.  Future schema
 * changes (new fields, new kinds) bump v.  Decoders MUST
 * gracefully handle v > known: render as plaintext fallback so
 * older clients don't crash on newer messages.  We expose the
 * `decodePayload` return type with this distinction so callers
 * can render appropriately.
 */

/** cp30-DD-DD SEC-3 — per-network address/txid cross-validators
 *  imported from the canonical networks module.  Used by the
 *  decoder to defend against hostile peers sending a mismatched
 *  `network` + `address` combination (asset-wide shape passes
 *  but per-network shape fails).  networks.ts has no imports
 *  itself, so no circular-dep risk. */
import {
	validateUsdtAddress,
	validateUsdtTxid,
	validateUsdcAddress,
	validateUsdcTxid,
	validateDaiAddress,
	validateDaiTxid,
	type UsdtNetwork,
	type UsdcNetwork,
	type DaiNetwork
} from '$lib/assets/networks';

const MAX_NOTE_LEN = 100;
const MAX_AMOUNT_LEN = 32; // "1234567890.123456789" is plenty

/** BTC mainnet address regexes. Cheap shape check only — no
 *  checksum verify (see module header). */
// P2PKH: starts with 1, length 26-35, base58 alphabet (no 0,O,I,l).
const BTC_P2PKH_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
// P2SH: starts with 3, same charset.
const BTC_P2SH_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/;
// Bech32 (SegWit v0+v1): bc1, lowercase letters + digits except
// 1, b, i, o.  v0 = 42 chars total, v1 (taproot) = 62 chars total.
const BTC_BECH32_RE = /^bc1[023456789acdefghjklmnpqrstuvwxyz]{6,87}$/;

/** XMR mainnet address regexes. */
// Standard: starts with 4, base58 alphabet, exactly 95 chars.
const XMR_STANDARD_RE = /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/;
// Subaddress: starts with 8, exactly 95 chars.
const XMR_SUBADDRESS_RE = /^8[0-9A-B][1-9A-HJ-NP-Za-km-z]{93}$/;
// Integrated address: starts with 4, exactly 106 chars.  Includes
// 8-byte payment ID encoded in the address.  The network byte for
// integrated mainnet (19) differs from standard mainnet (18), so
// the 2nd-char constraint of standard addresses ([0-9AB]) doesn't
// hold here — real integrated addresses begin with patterns like
// `4L`, `4Lj`, etc.  Just require length + base58 alphabet.
const XMR_INTEGRATED_RE = /^4[1-9A-HJ-NP-Za-km-z]{105}$/;

/** BTC txid: 64 lowercase hex chars (sha256d of the transaction). */
const BTC_TXID_RE = /^[0-9a-f]{64}$/;
/** XMR txid: 64 lowercase hex chars (Keccak-256 of tx data). */
const XMR_TXID_RE = /^[0-9a-f]{64}$/;
/** BLURT txid: 40 lowercase hex chars (Steem/Hive convention —
 *  truncated SHA-256 of the serialized transaction). */
const BLURT_TXID_RE = /^[0-9a-f]{40}$/;

/** BCH mainnet address regexes (Part 122 cp21 BCH addition).
 *  Accept both CashAddr (modern BCH standard) and legacy P2PKH/
 *  P2SH (still emitted by some BCH wallets).  See the canonical
 *  registry's BCH addressShape doc-comment for full rationale. */
// CashAddr WITH `bitcoincash:` prefix: 12-char prefix + 42-char
// body (q or p start + 41 lowercase base32 chars).
const BCH_CASHADDR_PREFIXED_RE = /^bitcoincash:[qp][a-z0-9]{41}$/;
// CashAddr WITHOUT prefix: same 42-char body alone.  Most modern
// BCH wallets emit this form by default.
const BCH_CASHADDR_BARE_RE = /^[qp][a-z0-9]{41}$/;
// Legacy P2PKH: starts with 1, 26-35 chars total (same shape as
// BTC legacy — chain history before the 2017 fork shares it).
const BCH_LEGACY_P2PKH_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
// Legacy P2SH: starts with 3, same charset.
const BCH_LEGACY_P2SH_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/;

/** BCH txid: 64 lowercase hex chars (sha256d of the transaction —
 *  same hash function as BTC). */
const BCH_TXID_RE = /^[0-9a-f]{64}$/;

/** LTC address regexes (Part 122 cp24).
 *  LTC has three address-shape eras:
 *  (1) Legacy P2PKH starting with `L` (unambiguous with BTC's `1`).
 *  (2) Legacy P2SH — two variants: modern `M`-prefix (introduced
 *      2017 to disambiguate) and deprecated `3`-prefix (still
 *      valid on the LTC chain; BTC-shape ambiguous — see
 *      ADR-0025 §4 for the accepted tradeoff matching ADR-0024 §4
 *      for BCH).  Recipient wallet does chain-binding on receive.
 *  (3) Bech32 / Bech32m with `ltc1` prefix (segwit + taproot).
 *  Permissive shape check — not a checksum. */
const LTC_LEGACY_P2PKH_RE = /^L[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const LTC_LEGACY_P2SH_M_RE = /^M[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const LTC_LEGACY_P2SH_3_RE = /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const LTC_BECH32_RE = /^ltc1[02-9ac-hj-np-z]{6,87}$/;

/** LTC txid: 64 lowercase hex chars (sha256d, same as BTC/BCH). */
const LTC_TXID_RE = /^[0-9a-f]{64}$/;

/** DASH address regex (cp27).  Two formats coexist on the chain:
 *
 *  (1) P2PKH — starts with `X`, base58, 34 chars total.  Most
 *      DASH addresses in the wild use this form.
 *  (2) P2SH — starts with `7`, base58, 34 chars total.  Multisig
 *      and smart-contract addresses; rarer in P2P trading flow.
 *
 *  Both share the same length and base58 alphabet — the version
 *  byte distinguishes them.  Dash deliberately chose `X`/`7`
 *  prefixes to be unambiguous with BTC's `1`/`3` (no cross-chain
 *  mis-send shape collision).  There's no bech32-equivalent
 *  native to Dash — the chain stayed on base58 throughout its
 *  evolution.
 *
 *  Permissive shape check — not a checksum (recipient wallet
 *  does chain-binding on receive). */
const DASH_P2PKH_RE = /^X[1-9A-HJ-NP-Za-km-z]{33}$/;
const DASH_P2SH_RE = /^7[1-9A-HJ-NP-Za-km-z]{33}$/;

/** DASH txid: 64 lowercase hex chars (sha256d, same as BTC family). */
const DASH_TXID_RE = /^[0-9a-f]{64}$/;


/** DOGE address (cp33 — Part 122).  Two formats:
 *  - P2PKH (overwhelmingly common): `D` + 33 base58 chars
 *    (version byte 0x1E).
 *  - P2SH (multi-sig, rare on DOGE): `9` or `A` + 33 base58 chars
 *    (version byte 0x16).
 *  No bech32 — Dogecoin Core has not activated segwit as of
 *  2026-05; the chain stayed on pre-segwit legacy semantics.
 *  Permissive shape check — not a checksum (recipient wallet
 *  does chain-binding on receive). */
const DOGE_P2PKH_RE = /^D[1-9A-HJ-NP-Za-km-z]{33}$/;
const DOGE_P2SH_RE = /^[9A][1-9A-HJ-NP-Za-km-z]{33}$/;

/** DOGE txid: 64 lowercase hex chars (sha256d, same as BTC family). */
const DOGE_TXID_RE = /^[0-9a-f]{64}$/;

/** ZEC address (cp39 — Part 122).  Four formats coexist:
 *
 *  - t1 (transparent P2PKH): base58, `t1` prefix + 33 base58 chars
 *    = 35 chars total.  Looks like a Bitcoin legacy address.
 *  - t3 (transparent P2SH, multi-sig): base58, `t3` prefix + 33
 *    base58 chars = 35 chars total.
 *  - zs1 (Sapling shielded): bech32, `zs1` prefix + 75 bech32
 *    data chars = 78 chars total.  Uses zero-knowledge proofs to
 *    hide sender/recipient/amount.
 *  - u1 (Unified Address, bundles Orchard receivers + optional
 *    Sapling/transparent): bech32m, `u1` prefix + variable
 *    length, typically 90–300 chars depending on what's bundled.
 *
 *  Per-address privacy: senders and receivers pick the address
 *  type that matches their preferred posture.  All four are
 *  first-class on the protocol.  Permissive shape check;
 *  chain-binding happens on the receiving wallet side.
 *
 *  Bech32 alphabet excludes `1`, `b`, `i`, `o` to avoid visual
 *  ambiguity (we use [02-9ac-hj-np-z] for the bech32 data
 *  portion, matching the LTC MWEB pattern).
 */
const ZEC_T_RE = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;
const ZEC_ZS_RE = /^zs1[02-9ac-hj-np-z]{75}$/;
const ZEC_U_RE = /^u1[02-9ac-hj-np-z]{30,300}$/;

/** ZEC txid: 64 lowercase hex chars.  Both transparent and
 *  shielded transactions surface a 64-char hex txid on chain;
 *  shielded inputs/outputs are hidden inside the tx but the
 *  txid itself is canonical and shareable. */
const ZEC_TXID_RE = /^[0-9a-f]{64}$/;


/** BLURT "address" is actually a Blurt account name — the
 *  recipient field in a transfer op.  Uses the same canonical
 *  account-name regex as the rest of Morphit (post chat-audit
 *  C-19 fix): lowercase letter start, lowercase + digit + dot
 *  + dash interior, 3..16 chars, dots allowed for multi-segment
 *  names.  The chain enforces stricter rules (no consecutive
 *  dots etc.) but the user's wallet does the final validation
 *  when they actually send. */
const BLURT_ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;

/** Order permlink: matches the orderbook's permlink shape — a
 *  Blurt permlink, lowercase alphanumeric + dash, 3..256 chars.
 *  Bounded so payloads can't sneak large strings into the
 *  256-codepoint plaintext budget via this field. */
const ORDER_PERMLINK_RE = /^[a-z0-9][a-z0-9-]{2,255}$/;

/** BLURT payment memo (Phase F.4).
 *
 *  When the seller shares a BLURT address, an opaque random
 *  token is auto-generated and pinned to the address payload.
 *  The buyer's wallet uses it as the on-chain transfer memo,
 *  letting the seller match incoming transfers to specific
 *  trades — even when multiple unrelated transfers land in the
 *  same account around the same time.
 *
 *  Crucially, the memo is NOT the order permlink — that would
 *  leak trade identity to anyone scraping the public chain.
 *  The token is opaque (random base32-ish), only meaningful
 *  inside the encrypted chat where both parties saw it.
 *
 *  Format: lowercase alphanumeric, 6..32 chars.  We GENERATE
 *  8-char tokens (40 bits entropy, negligible collision risk
 *  at expected scale) but accept anything in the range so
 *  pasted/legacy/future-format memos all decode.
 *
 *  Lowercase-only is intentional: mobile keyboards
 *  autocapitalize, and chain memo strings are case-sensitive.
 *  Lowercase eliminates a class of "looked right, paid wrong
 *  memo" UX failures. */
const MEMO_RE = /^[a-z0-9]{6,32}$/;
/** Generated-memo length.  See MEMO_RE comment for rationale. */
const GENERATED_MEMO_LEN = 8;

/** Amount string: positive number with optional decimal, no
 *  units (the method tells us the unit).  Bounded. */
const AMOUNT_RE = /^\d{1,12}(?:\.\d{1,12})?$/;

/** Add cryptographic-RNG jitter to the trailing 6 decimals of a
 *  Monero amount, raising the amount slightly to defeat amount-
 *  correlation attacks on the public Monero chain.
 *
 *  Why this exists: even though Monero hides sender/receiver via
 *  ring signatures, the transferred amount is encrypted but
 *  bit-identical to whoever knows the view key (recipient + audit
 *  trail observers).  When the same exact amount appears in two
 *  rings (Eve→Alice, Alice→Eve), the matching value lets a
 *  passive observer correlate the two rings.  See
 *  openmonero.com/knowledge/how-bad-actors-try-to-track-monero
 *  for the canonical writeup of this class of attack.
 *
 *  Defense: instead of sending exactly 0.5 XMR, send
 *  0.500000847261 XMR — the leading digits still convey the
 *  trade amount in human-readable form, but the trailing 6
 *  decimals are random per transaction, so two "0.5 XMR" trades
 *  are distinct on-chain.
 *
 *  Constraints:
 *    - Round UP only (jitter is non-negative).  Never underpay
 *      the seller; the verifier is observed-amount-vs-expected
 *      and treats underpayment as a fail (see
 *      apps/indexer/src/indexer/fee/moneroExplorerVerifier.ts).
 *      Asymmetric jitter means a "0.5" trade pays at most an
 *      extra 999_999 piconeros ≈ 0.000001 XMR ≈ trivial cost.
 *    - 12-decimal precision matches XMR's piconero granularity.
 *      Amounts smaller than 1 piconero (10^-12 XMR) cannot be
 *      represented on-chain, so jitter is in piconero units.
 *    - We use crypto.getRandomValues, not Math.random — the
 *      latter's predictable PRNG state could let an observer
 *      correlate jitters across a single user's transactions.
 *    - Idempotent ON the input string + RNG state.  Caller must
 *      memoize per-trade so the same trade always gets the same
 *      jittered amount on both sides (seller share, buyer echo,
 *      seller verify).  We don't memoize internally because the
 *      caller's lifetime model (Svelte component) is the right
 *      place.
 *
 *  Returns a normalized string at 12-decimal precision.  Throws
 *  on malformed input. */
export function jitterMoneroAmount(base: string): string {
	if (!AMOUNT_RE.test(base)) {
		throw new Error('jitterMoneroAmount: invalid base amount');
	}
	// Parse base into integer-piconero representation (bigint).
	// 1 XMR = 10^12 piconero.
	const [whole = '0', frac = ''] = base.split('.');
	const fracPadded = (frac + '000000000000').slice(0, 12);
	const basePico = BigInt(whole) * 1_000_000_000_000n + BigInt(fracPadded);

	// Generate 6 random bytes, fold into 0..(10^6 - 1) — i.e., up
	// to 999_999 piconero of jitter ≈ 1 microXMR maximum.
	// Using 6 bytes (24 bits, max 16M) and modulo 10^6 is fine —
	// the modulo bias is negligible (16M / 10^6 ≈ 16.7 buckets,
	// last bucket slightly underrepresented but not in any way
	// observable to an attacker; we're not generating
	// cryptographic keys, we're just spreading values).
	const buf = new Uint8Array(6);
	crypto.getRandomValues(buf);
	let r = 0;
	for (const b of buf) r = r * 256 + b;
	const jitterPico = BigInt(r % 1_000_000);
	const totalPico = basePico + jitterPico;

	// Format back to "W.FFFFFFFFFFFF" with 12-decimal precision.
	const wholeOut = totalPico / 1_000_000_000_000n;
	const fracOut = totalPico % 1_000_000_000_000n;
	const fracStr = fracOut.toString().padStart(12, '0');
	return `${wholeOut.toString()}.${fracStr}`;
}

/** Part 122 cp30/cp31 — Amount-jitter for stablecoin chains
 *  (USDT, USDC, DAI).  Same defense as jitterUtxoAmount +
 *  jitterMoneroAmount but calibrated to 6-decimal stablecoin
 *  precision.  DAI uses 18-decimal underlying token math; the
 *  jitter clamps to display precision so the user-visible
 *  effect is uniform across all three stablecoins.
 *
 *  Why this exists for stablecoins: even though USDT and USDC
 *  carry separate centralization concerns (Circle/Tether can
 *  freeze addresses on regulatory request — documented in their
 *  per-asset privacy guides), and DAI carries the more-nuanced
 *  PSM/USDC backing dependency + MKR governance upgradeability
 *  path documented in its own guide, the SEPARATE amount-
 *  correlation linkability attack still applies to all three.
 *  An observer with knowledge of an off-platform agreed price
 *  ("I'm buying $5,000 of DAI for $5,000 cash") can correlate
 *  the on-chain transfer with the agreement by matching the
 *  exact amount.  Adding 0-999 micro-stablecoin of jitter —
 *  about a tenth of a US cent maximum — breaks the exact-match
 *  correlation without imposing any meaningful cost.  All
 *  threats are real and independent; jitter addresses one of
 *  them.
 *
 *  Pre-cp30 this function didn't exist and stablecoins fell
 *  through `jitterAmountForAsset` to a pass-through (`return
 *  base`).  That was the wrong call — the original rationale
 *  ("USDT's privacy issue is centralization not amount-
 *  correlation; jitter doesn't address Tether freezes") was an
 *  incomplete argument; the absence of jitter benefit on the
 *  freeze threat doesn't refute the jitter benefit on the
 *  correlation threat.  Cp30 fixed the gap.
 *
 *  Jitter range: up to 999 micro-units of the stablecoin (6
 *  decimals).  At a 1:1 USD peg that's $0.000001 to $0.000999 —
 *  effectively a sub-cent rounding, less than the gas fee on
 *  any of the supported chains.
 *
 *  Same caveats as the UTXO and XMR versions: round-UP-only
 *  (never underpay), CSPRNG-derived (not Math.random), the
 *  caller is responsible for caching so seller-share, buyer-
 *  echo, and seller-verify all see the same value. */
export function jitterStablecoinAmount(base: string): string {
	if (!AMOUNT_RE.test(base)) {
		throw new Error('jitterStablecoinAmount: invalid base amount');
	}
	// Parse base into integer-microunit representation (bigint).
	// 1 USDT/USDC = 10^6 micro-units on every supported network.
	// DAI uses 18-decimal token math underneath, but the jitter
	// clamps to 6-decimal display precision so the user-visible
	// effect is uniform across all three stablecoins (about $0.001
	// maximum jitter regardless of which one).
	const [whole = '0', frac = ''] = base.split('.');
	const fracPadded = (frac + '000000').slice(0, 6);
	const baseMicro = BigInt(whole) * 1_000_000n + BigInt(fracPadded);

	// Generate 2 random bytes, fold into 0..(1000 - 1).  Modulo
	// bias is negligible at this scale.
	const buf = new Uint8Array(2);
	crypto.getRandomValues(buf);
	const r = (buf[0] << 8) | buf[1];
	const jitterMicro = BigInt(r % 1000);
	const totalMicro = baseMicro + jitterMicro;

	// Format back to "W.FFFFFF" with 6-decimal precision.
	const wholeOut = totalMicro / 1_000_000n;
	const fracOut = totalMicro % 1_000_000n;
	const fracStr = fracOut.toString().padStart(6, '0');
	return `${wholeOut.toString()}.${fracStr}`;
}

/** Part 122 cp26 — Amount-jitter for transparent UTXO chains
 *  (BTC, BCH, LTC).  Same defense as jitterMoneroAmount but
 *  calibrated to satoshi precision (8 decimals).
 *
 *  Why this exists for transparent chains: every order Morphit
 *  posts has an exact amount derived from the fiat-amount +
 *  market-price calculation.  When that exact amount appears on
 *  the public chain a few minutes after the order was posted,
 *  any chain observer can trivially correlate the order to the
 *  on-chain payment — defeating much of the privacy buyers/
 *  sellers might otherwise have.  Adding small random jitter to
 *  the on-chain amount breaks that exact-match correlation.
 *
 *  Jitter range: up to 999 satoshis.  At cp26-era prices that's
 *  ~$0.50 for BTC, ~$0.005 for BCH, ~$0.001 for LTC — small
 *  enough to be an implicit tip the seller absorbs, large enough
 *  to fully decorrelate against amount-matching heuristics.
 *
 *  Same caveats as the XMR version: round-UP-only (never
 *  underpay), CSPRNG-derived (not Math.random), idempotent on
 *  caller-side memoization (component lifetime is the right
 *  place to cache so seller-share/buyer-echo/seller-verify all
 *  see the same value). */
export function jitterUtxoAmount(base: string): string {
	if (!AMOUNT_RE.test(base)) {
		throw new Error('jitterUtxoAmount: invalid base amount');
	}
	// Parse base into integer-satoshi representation (bigint).
	// 1 BTC/BCH/LTC = 10^8 satoshi (litoshi for LTC, same scale).
	const [whole = '0', frac = ''] = base.split('.');
	const fracPadded = (frac + '00000000').slice(0, 8);
	const baseSat = BigInt(whole) * 100_000_000n + BigInt(fracPadded);

	// Generate 2 random bytes, fold into 0..(1000 - 1).  Modulo
	// bias is negligible at this scale.
	const buf = new Uint8Array(2);
	crypto.getRandomValues(buf);
	const r = (buf[0] << 8) | buf[1];
	const jitterSat = BigInt(r % 1000);
	const totalSat = baseSat + jitterSat;

	// Format back to "W.FFFFFFFF" with 8-decimal precision.
	const wholeOut = totalSat / 100_000_000n;
	const fracOut = totalSat % 100_000_000n;
	const fracStr = fracOut.toString().padStart(8, '0');
	return `${wholeOut.toString()}.${fracStr}`;
}

/** Part 122 cp26 — Amount-jitter for BLURT.  BLURT is 3-decimal
 *  precision (milliblurt smallest unit), account-based not UTXO,
 *  and Morphit's coordination layer — every order, message, and
 *  fee is on the public Blurt chain.  Amount-correlation between
 *  the orderbook and the on-chain transfer is therefore the
 *  highest of any Morphit-supported asset.
 *
 *  Jitter range: up to 99 milliblurt.  At cp26 BLURT prices
 *  that's a fraction of a US cent — within ordinary chain-fee
 *  noise. */
export function jitterBlurtAmount(base: string): string {
	if (!AMOUNT_RE.test(base)) {
		throw new Error('jitterBlurtAmount: invalid base amount');
	}
	const [whole = '0', frac = ''] = base.split('.');
	const fracPadded = (frac + '000').slice(0, 3);
	const baseMilli = BigInt(whole) * 1000n + BigInt(fracPadded);

	const buf = new Uint8Array(1);
	crypto.getRandomValues(buf);
	const jitterMilli = BigInt(buf[0] % 100);
	const totalMilli = baseMilli + jitterMilli;

	const wholeOut = totalMilli / 1000n;
	const fracOut = totalMilli % 1000n;
	const fracStr = fracOut.toString().padStart(3, '0');
	return `${wholeOut.toString()}.${fracStr}`;
}

/** Part 122 cp26 — Asset-aware amount-jitter dispatcher.  Returns
 *  a jittered amount appropriate for the asset's smallest-unit
 *  precision.  Every tradable asset is jitter-eligible as of cp30
 *  (cp26 had originally excluded USDT under a "centralization is
 *  the issue, not amount-correlation" rationale; cp30 ADR-0028
 *  Decision 2 reversed this on the grounds that those are
 *  SEPARATE threats and amount-jitter addresses one of them.
 *  See jitterStablecoinAmount for full rationale).  Unknown
 *  future assets return the input unchanged for forward-compat. */
export function jitterAmountForAsset(
	asset: ChatAssetTicker,
	base: string
): string {
	if (asset === 'xmr') return jitterMoneroAmount(base);
	if (asset === 'btc' || asset === 'bch' || asset === 'ltc' || asset === 'dash' || asset === 'doge' || asset === 'zec') {
		return jitterUtxoAmount(base);
	}
	if (asset === 'blurt') return jitterBlurtAmount(base);
	if (asset === 'usdt' || asset === 'usdc' || asset === 'dai') {
		// Part 122 cp30/cp31 — stablecoins get jitter too.  The
		// centralization threat (Circle/Tether freeze power for
		// USDT/USDC; DAI's PSM/USDC backing dependency + MKR
		// governance for DAI) is real and documented in
		// /privacy/{usdt,usdc,dai}, but it doesn't refute the
		// SEPARATE amount-correlation linkability threat that
		// jitter addresses.  6-decimal display precision, 0-999
		// micro-unit range — see jitterStablecoinAmount for the
		// full rationale.  Same routine handles DAI (18-decimal
		// underlying) because the jitter clamps to display
		// precision, not token-native decimals.
		return jitterStablecoinAmount(base);
	}
	return base;
}

/** Phase F.5 audit fix (F-1) — forbidden-char check for the
 *  `note` field.  Rejects:
 *
 *    - C0 control chars (U+0000..U+001F) — including \r, \n, \t.
 *      Notes are single-line; control chars in rendered text can
 *      hide content from view.
 *    - DEL (U+007F).
 *    - Bidi formatting controls — U+202A..U+202E (legacy LRE/
 *      RLE/PDF/LRO/RLO) and U+2066..U+2069 (modern LRI/RLI/FSI/
 *      PDI).  These reorder text visually; an attacker can craft
 *      a note that displays one thing and copies as another.
 *
 *  Allowed: legitimate scripts in any language, combining marks,
 *  ZWJ/ZWNJ (used in many scripts legitimately), emoji.
 *
 *  This list is INTENTIONALLY narrower than the order-handler's
 *  `FORBIDDEN_TEXT_CHARS` (which also rejects C1 controls,
 *  ZWJ/ZWNJ, BOM).  The order-handler's stricter rule applies
 *  to `location_region`, `payment_methods`, and `terms` where
 *  there's no legitimate use for ZWJ and the fields are short
 *  metadata.  The chat `note` is free-text where users writing
 *  in scripts like Devanagari and Arabic genuinely need ZWJ to
 *  form correct ligatures.  The narrower list was a deliberate
 *  Phase F.5 decision; do not "harmonize" the two without
 *  re-auditing what each field is for.  Part 75 over-broadened
 *  this list and got caught by `chat-payload-smoke.ts`'s
 *  "ZWJ allowed" scenario (smoke is enforcement of the audit
 *  decision; respect it).
 *
 *  Used both on encode (reject malformed input) and decode
 *  (treat malformed wire as non-Morphit → plaintext fallback). */
function noteHasForbiddenChars(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code <= 0x1f) return true;
		if (code === 0x7f) return true;
		if (code >= 0x202a && code <= 0x202e) return true;
		if (code >= 0x2066 && code <= 0x2069) return true;
	}
	return false;
}

/** Asset ticker as used in CHAT PAYLOADS (lowercase wire
 *  format).  Parallels the uppercase `AssetTicker` in the
 *  canonical asset registry (`@morphit/asset-registry`), but
 *  this is the spelling that appears on chat custom_json ops
 *  (`{kind: 'morphit_addr', method: 'btc', ...}`).  Renamed
 *  from `PaymentMethod` in Part 121 because the old name was
 *  misleading — it suggested a fiat payment rail (PayPal,
 *  Zelle, etc.) when it's actually the crypto asset for an
 *  address-share or funds-sent chat message.  The fiat
 *  payment-method registry lives in `lib/payments/registry.ts`
 *  and uses `PaymentMethodEntry`.
 *
 *  Part 121 USDT addition: 'usdt' is multi-network.  When
 *  method === 'usdt', the `network` field on AddressPayload
 *  and FundsSentPayload is REQUIRED (one of 'erc20', 'trc20',
 *  'spl', 'bep20').  The decoder rejects USDT payloads
 *  without a network.
 *
 *  Part 122 cp21 BCH addition: 'bch' is single-network (mainnet
 *  only).  No network field required.  Addresses come in CashAddr
 *  or legacy formats — see BCH_*_RE constants.
 *
 *  Part 122 cp30 USDC addition: 'usdc' is multi-network like
 *  USDT.  When method === 'usdc', the `network` field is
 *  REQUIRED (one of 'erc20', 'spl', 'base', 'polygon').  Note
 *  ERC-20, Base, and Polygon all share the EVM 0x[40 hex]
 *  address shape; the network discriminator is what tells the
 *  sender which chain to broadcast on.  No TRC-20 (Circle
 *  doesn't issue on Tron) and no BEP-20 in this initial set
 *  (see ADR-0028). */
export type ChatAssetTicker = 'btc' | 'xmr' | 'blurt' | 'usdt' | 'usdc' | 'dai' | 'bch' | 'ltc' | 'dash' | 'doge' | 'zec';

export interface AddressPayload {
	readonly v: 1;
	readonly kind: 'morphit_addr';
	readonly method: ChatAssetTicker;
	readonly address: string;
	readonly amount?: string;
	readonly orderPermlink?: string;
	readonly note?: string;
	/** BLURT payment memo — opaque random token the buyer's
	 *  wallet must include as the on-chain transfer memo so the
	 *  seller can match the incoming transfer to this trade.
	 *  See MEMO_RE doc for shape + rationale.  BLURT-only by
	 *  convention; the wire format permits the field on any
	 *  method for forward-compat. */
	readonly memo?: string;
	/** Sub-network identifier for multi-network assets.  REQUIRED
	 *  when method === 'usdt' (one of 'erc20'|'trc20'|'spl'|
	 *  'bep20'), when method === 'usdc' (one of 'erc20'|'spl'|
	 *  'base'|'polygon'), and when method === 'dai' (one of
	 *  'erc20'|'polygon'|'base'|'arbitrum').  Undefined for
	 *  single-network assets (btc, xmr, blurt, bch, ltc, dash,
	 *  doge).
	 *  Per Part 121/cp30/cp31: USDT, USDC, and DAI addresses on
	 *  different network families have INCOMPATIBLE formats —
	 *  sending USDT-ERC20 to a TRC-20 address loses funds; sending
	 *  USDC-Solana to an EVM 0x address loses funds.  The network
	 *  field pins the receiving network so chat-side validation
	 *  catches mismatches and the explorer URL builder picks the
	 *  right template.  Note that within USDC, ERC-20 / Base /
	 *  Polygon all share the EVM 0x[40 hex] shape — so this field
	 *  is the ONLY thing telling the sender which chain to
	 *  broadcast on for cross-EVM-USDC sends.  And ALL FOUR DAI
	 *  networks (ERC-20, Polygon, Base, Arbitrum) share that same
	 *  EVM shape — DAI is the highest cross-network address-
	 *  confusion surface on Morphit. */
	readonly network?: string;
	/** cp26 — Optional PayJoin (BIP-78) endpoint URL.  When set
	 *  AND `method === 'btc'`, the generated bitcoin: URI gains
	 *  a `pj=<encoded>` parameter pointing to the seller's
	 *  PayJoin endpoint.  A PayJoin-capable buyer wallet POSTs a
	 *  PSBT to this endpoint, the seller's wallet returns a
	 *  modified PSBT with both parties' inputs co-mingled, the
	 *  buyer signs and broadcasts — defeating the common-input-
	 *  ownership heuristic that links coins to a single owner.
	 *
	 *  Wallets without PayJoin support ignore the `pj=` parameter
	 *  and fall back to a normal payment.  Zero downside for
	 *  unsupported wallets; real privacy win when both sides
	 *  support BIP-78.
	 *
	 *  Morphit's role is URI relay only — we don't run the
	 *  PayJoin endpoint.  The seller's wallet (or self-hosted
	 *  BTCPayServer / equivalent) supplies the URL.
	 *
	 *  Wire-format note: BIP-78 expects HTTPS or .onion endpoints.
	 *  Frontend encoder doesn't enforce — we trust the seller's
	 *  wallet/operator to supply a sane URL.  Validation happens
	 *  client-side via URL parser. */
	readonly payjoinEndpoint?: string;
}

export interface FundsSentPayload {
	readonly v: 1;
	readonly kind: 'morphit_funds_sent';
	readonly method: ChatAssetTicker;
	readonly txid: string;
	readonly amount?: string;
	readonly orderPermlink?: string;
	readonly note?: string;
	/** Phase F.4 — BLURT payment memo the buyer claims to have
	 *  used.  Lets the seller verify against the chain: the
	 *  on-chain transfer's memo should match this AND should
	 *  match what the seller originally requested in their
	 *  AddressPayload.memo. */
	readonly memo?: string;
	/** Part 121 / cp30: sub-network for multi-network assets.
	 *  REQUIRED when method === 'usdt' or method === 'usdc'.
	 *  Lets the receiving client pick the right per-network
	 *  explorer URL when rendering the txid as a clickable
	 *  link. */
	readonly network?: string;
}

export type StructuredPayload = AddressPayload | FundsSentPayload;

/** Result of decoding plaintext.  Either a recognized structured
 *  payload, an unknown future version we should render as
 *  plaintext, an unknown future KIND at the current version
 *  (Phase F.5 audit fix F-2 — distinguishes "old client doesn't
 *  recognize this new payload type" from generic plaintext), or
 *  plain user text. */
export type DecodeResult =
	| { readonly kind: 'address'; readonly payload: AddressPayload }
	| { readonly kind: 'funds_sent'; readonly payload: FundsSentPayload }
	| { readonly kind: 'unknown_version'; readonly version: number }
	| { readonly kind: 'unknown_kind'; readonly name: string }
	| { readonly kind: 'plaintext' };

/** Validate a BTC address shape.  No checksum verify. */
export function isValidBtcAddress(s: string): boolean {
	if (typeof s !== 'string') return false;
	return BTC_P2PKH_RE.test(s) || BTC_P2SH_RE.test(s) || BTC_BECH32_RE.test(s);
}

/** Validate an XMR address shape.  No checksum verify. */
export function isValidXmrAddress(s: string): boolean {
	if (typeof s !== 'string') return false;
	return XMR_STANDARD_RE.test(s) || XMR_SUBADDRESS_RE.test(s) || XMR_INTEGRATED_RE.test(s);
}

/** Validate a BLURT account name (the "address" for BLURT
 *  transfers).  Uses the canonical account regex; multi-segment
 *  names with dots are accepted. */
export function isValidBlurtAccount(s: string): boolean {
	if (typeof s !== 'string') return false;
	return BLURT_ACCOUNT_RE.test(s);
}

/** Validate a USDT address shape.  This is the ANY-NETWORK
 *  check — matches a plausibly-valid address on ERC-20, BEP-20
 *  (both EVM, same shape), TRC-20, or SPL.  For per-network
 *  validation (the network-pinned check the address-share
 *  modal does), use `validateUsdtAddress(network, address)`
 *  from `$lib/assets/networks`. */
export function isValidUsdtAddress(s: string): boolean {
	if (typeof s !== 'string') return false;
	// ERC-20 / BEP-20: 0x + 40 hex
	if (/^0x[a-fA-F0-9]{40}$/.test(s)) return true;
	// TRC-20: T + 33 base58
	if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) return true;
	// SPL: base58 32-44 chars
	if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return true;
	return false;
}

/** Validate a USDT txid shape across all supported networks.
 *  Per-network validation lives in `validateUsdtTxid` in
 *  `$lib/assets/networks`. */
export function isValidUsdtTxid(s: string): boolean {
	if (typeof s !== 'string') return false;
	// EVM (ERC-20, BEP-20): 0x + 64 hex, or 64 hex without prefix
	if (/^(0x)?[a-fA-F0-9]{64}$/.test(s)) return true;
	// SPL: base58 87-88 chars
	if (/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(s)) return true;
	return false;
}

/** Validate a USDC address shape across all supported networks
 *  (ERC-20, SPL, Base, Polygon — Part 122 cp30).  Permissive
 *  check used by the form-level "is this even plausibly an
 *  address" gate.  For per-network pinning (the address-share
 *  modal's network-aware check), use `validateUsdcAddress(network,
 *  address)` from `$lib/assets/networks`.
 *
 *  Note ERC-20, Base, and Polygon all share the EVM 0x[40 hex]
 *  shape — the network picker, not this validator, is what
 *  disambiguates them at form time. */
export function isValidUsdcAddress(s: string): boolean {
	if (typeof s !== 'string') return false;
	// EVM (ERC-20, Base, Polygon): 0x + 40 hex
	if (/^0x[a-fA-F0-9]{40}$/.test(s)) return true;
	// SPL: base58 32-44 chars
	if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return true;
	return false;
}

/** Validate a USDC txid shape across all supported networks.
 *  Per-network validation lives in `validateUsdcTxid` in
 *  `$lib/assets/networks`. */
export function isValidUsdcTxid(s: string): boolean {
	if (typeof s !== 'string') return false;
	// EVM (ERC-20, Base, Polygon): 0x + 64 hex, or 64 hex without prefix
	if (/^(0x)?[a-fA-F0-9]{64}$/.test(s)) return true;
	// SPL: base58 64-90 chars (Solana signatures are typically 87-88)
	if (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s)) return true;
	return false;
}

/** Validate a DAI address shape across all supported networks
 *  (ERC-20, Polygon, Base, Arbitrum — Part 122 cp31).  ALL FOUR
 *  networks use the EVM 0x[40 hex] format, so this is just the
 *  EVM-address shape.  Per-network validation (which doesn't
 *  actually disambiguate the SHAPE here, but does pin which
 *  chain the picker locked in) lives in `validateDaiAddress` in
 *  `$lib/assets/networks`.  See ADR-0029 §3 — DAI has the
 *  highest cross-network address-confusion surface of any asset
 *  on Morphit because all 4 networks are visually identical. */
export function isValidDaiAddress(s: string): boolean {
	if (typeof s !== 'string') return false;
	return /^0x[a-fA-F0-9]{40}$/.test(s);
}

/** Validate a DAI txid shape across all supported networks.
 *  All four are EVM-family (32-byte hash, displayed as 64 hex
 *  with optional 0x prefix).  Per-network validation lives in
 *  `validateDaiTxid` in `$lib/assets/networks`. */
export function isValidDaiTxid(s: string): boolean {
	if (typeof s !== 'string') return false;
	return /^(0x)?[a-fA-F0-9]{64}$/.test(s);
}

/** Validate a BCH address shape (Part 122 cp21).  Accepts both
 *  CashAddr (with or without `bitcoincash:` prefix) and legacy
 *  P2PKH/P2SH formats — most modern BCH wallets emit CashAddr,
 *  but many still accept and display legacy.  Permissive shape
 *  check; the receiving wallet does checksum validation. */
export function isValidBchAddress(s: string): boolean {
	if (typeof s !== 'string') return false;
	return (
		BCH_CASHADDR_PREFIXED_RE.test(s) ||
		BCH_CASHADDR_BARE_RE.test(s) ||
		BCH_LEGACY_P2PKH_RE.test(s) ||
		BCH_LEGACY_P2SH_RE.test(s)
	);
}

/** Validate a BCH txid shape.  Same 64-char lowercase hex
 *  format as BTC (sha256d of the transaction). */
export function isValidBchTxid(s: string): boolean {
	if (typeof s !== 'string') return false;
	return BCH_TXID_RE.test(s);
}

/** Validate an LTC address shape (Part 122 cp24).  Accepts the
 *  four current LTC formats: legacy P2PKH (`L...`), modern P2SH
 *  (`M...`), deprecated P2SH (`3...` — BTC-shape ambiguous per
 *  ADR-0025 §4), and bech32/bech32m (`ltc1...`).  Permissive
 *  shape check; the receiving wallet does checksum and
 *  chain-binding validation. */
export function isValidLtcAddress(s: string): boolean {
	if (typeof s !== 'string') return false;
	return (
		LTC_LEGACY_P2PKH_RE.test(s) ||
		LTC_LEGACY_P2SH_M_RE.test(s) ||
		LTC_LEGACY_P2SH_3_RE.test(s) ||
		LTC_BECH32_RE.test(s)
	);
}

/** Validate an LTC txid shape.  Same 64-char lowercase hex
 *  format as BTC (sha256d of the transaction). */
export function isValidLtcTxid(s: string): boolean {
	if (typeof s !== 'string') return false;
	return LTC_TXID_RE.test(s);
}

/** Validate a DASH address shape (cp27).  Accepts both
 *  P2PKH (`X...`, 34 chars) and P2SH (`7...`, 34 chars).
 *  Permissive shape check; the receiving wallet does
 *  checksum and chain-binding validation.  Dash deliberately
 *  chose prefixes that don't collide with BTC's `1`/`3`. */
export function isValidDashAddress(s: string): boolean {
	if (typeof s !== 'string') return false;
	return DASH_P2PKH_RE.test(s) || DASH_P2SH_RE.test(s);
}

/** Validate a DASH txid shape.  Same 64-char lowercase hex
 *  format as the rest of the BTC family. */
export function isValidDashTxid(s: string): boolean {
	if (typeof s !== 'string') return false;
	return DASH_TXID_RE.test(s);
}

/** Validate a DOGE address shape (cp33 — Part 122).  Accepts both
 *  P2PKH (`D...`, 34 chars) and P2SH (`9.../A...`, 34 chars).
 *  Permissive shape check; the receiving wallet does checksum
 *  and chain-binding validation.  Dogecoin has no bech32/segwit
 *  support as of 2026-05; only legacy base58 addresses exist. */
export function isValidDogeAddress(s: string): boolean {
	if (typeof s !== 'string') return false;
	return DOGE_P2PKH_RE.test(s) || DOGE_P2SH_RE.test(s);
}

/** Validate a DOGE txid shape.  Same 64-char lowercase hex
 *  format as the rest of the BTC family. */
export function isValidDogeTxid(s: string): boolean {
	if (typeof s !== 'string') return false;
	return DOGE_TXID_RE.test(s);
}

/** Validate a ZEC address shape (cp39 — Part 122).  Accepts all
 *  four formats: t1/t3 transparent (base58), zs1 Sapling shielded
 *  (bech32, exactly 78 chars), u1 Unified Address (bech32m,
 *  variable length).  See ZEC_T_RE / ZEC_ZS_RE / ZEC_U_RE
 *  docblocks above for the per-format rationale. */
export function isValidZecAddress(s: string): boolean {
	if (typeof s !== 'string') return false;
	return ZEC_T_RE.test(s) || ZEC_ZS_RE.test(s) || ZEC_U_RE.test(s);
}

/** Validate a ZEC txid shape.  Same 64-char lowercase hex
 *  for both transparent and shielded transactions — the
 *  shielded inputs/outputs are hidden inside the tx, but
 *  the txid itself is canonical and shareable. */
export function isValidZecTxid(s: string): boolean {
	if (typeof s !== 'string') return false;
	return ZEC_TXID_RE.test(s);
}

/** Dispatch by method. */
export function isValidAddress(method: ChatAssetTicker, addr: string): boolean {
	if (method === 'btc') return isValidBtcAddress(addr);
	if (method === 'xmr') return isValidXmrAddress(addr);
	if (method === 'blurt') return isValidBlurtAccount(addr);
	if (method === 'usdt') return isValidUsdtAddress(addr);
	if (method === 'usdc') return isValidUsdcAddress(addr);
	if (method === 'dai') return isValidDaiAddress(addr);
	if (method === 'bch') return isValidBchAddress(addr);
	if (method === 'ltc') return isValidLtcAddress(addr);
	if (method === 'dash') return isValidDashAddress(addr);
	if (method === 'doge') return isValidDogeAddress(addr);
	if (method === 'zec') return isValidZecAddress(addr);
	return false;
}

/** Validate a txid. */
export function isValidTxid(method: ChatAssetTicker, txid: string): boolean {
	if (typeof txid !== 'string') return false;
	if (method === 'btc') return BTC_TXID_RE.test(txid);
	if (method === 'xmr') return XMR_TXID_RE.test(txid);
	if (method === 'blurt') return BLURT_TXID_RE.test(txid);
	if (method === 'usdt') return isValidUsdtTxid(txid);
	if (method === 'usdc') return isValidUsdcTxid(txid);
	if (method === 'dai') return isValidDaiTxid(txid);
	if (method === 'bch') return isValidBchTxid(txid);
	if (method === 'ltc') return isValidLtcTxid(txid);
	if (method === 'dash') return isValidDashTxid(txid);
	if (method === 'doge') return isValidDogeTxid(txid);
	if (method === 'zec') return isValidZecTxid(txid);
	return false;
}

/** Encode an address-handoff payload as a JSON string ready to
 *  be encrypted.  Throws if any field fails validation —
 *  callers should validate at the UI layer before invoking
 *  this so they can surface inline errors instead of crashing.
 *
 *  Field naming: the WIRE format uses `order_permlink` (snake
 *  case, matching the rest of Morphit's on-chain payload
 *  convention).  The TS interface uses camelCase.  This
 *  function maps. */
export function encodeAddressPayload(p: AddressPayload): string {
	if (p.v !== 1) throw new Error('payload: unsupported version');
	if (p.kind !== 'morphit_addr') throw new Error('payload: wrong kind');
	if (
		p.method !== 'btc' &&
		p.method !== 'xmr' &&
		p.method !== 'blurt' &&
		p.method !== 'usdt' &&
		p.method !== 'usdc' &&
		p.method !== 'dai' &&
		p.method !== 'bch' &&
		p.method !== 'ltc' &&
		p.method !== 'dash' &&
		p.method !== 'doge' &&
		p.method !== 'zec'
	) {
		throw new Error('payload: invalid method');
	}
	if (!isValidAddress(p.method, p.address)) {
		throw new Error('payload: invalid address shape');
	}
	if (p.amount !== undefined && p.amount !== '' && !AMOUNT_RE.test(p.amount)) {
		throw new Error('payload: invalid amount');
	}
	if (
		p.orderPermlink !== undefined &&
		p.orderPermlink !== '' &&
		!ORDER_PERMLINK_RE.test(p.orderPermlink)
	) {
		throw new Error('payload: invalid order_permlink');
	}
	if (p.note !== undefined && p.note !== '') {
		if (p.note.length > MAX_NOTE_LEN) {
			throw new Error('payload: note too long');
		}
		if (noteHasForbiddenChars(p.note)) {
			// Phase F.5 audit fix (F-1).
			throw new Error('payload: note contains forbidden characters');
		}
	}
	if (p.memo !== undefined && p.memo !== '') {
		// Phase F.5 audit fix (F-3) — memo is BLURT-only.
		if (p.method !== 'blurt') {
			throw new Error('payload: memo is only valid for blurt method');
		}
		if (!MEMO_RE.test(p.memo)) {
			throw new Error('payload: invalid memo');
		}
	}

	// Phase F.5 audit fix (F-8) — normalize BLURT amount to 3
	// decimals matching the chain's storage precision.  The
	// seller might type more decimals (the wire format permits
	// up to 12), but the buyer's wallet will broadcast with 3
	// via formatBlurtAmount.  If we don't normalize on encode,
	// the verifier later compares the seller's high-precision
	// expectation against the chain's 3-decimal reality and
	// flags false mismatch on the 4th decimal.
	//
	// Round UP (Math.ceil) for symmetry with formatBlurtAmount —
	// sellers get slightly overpaid rather than slightly
	// underpaid.
	const normalizedAmount =
		p.amount !== undefined && p.method === 'blurt'
			? `${(Math.ceil(parseFloat(p.amount) * 1000) / 1000).toFixed(3)}`
			: p.amount;

	const wire: Record<string, unknown> = {
		v: 1,
		kind: 'morphit_addr',
		method: p.method,
		address: p.address
	};
	// Phase F.5 audit fix (F-6) — treat empty-string optionals as
	// "field absent" so the wire format doesn't waste plaintext
	// budget on `note: ""`, etc.  Saves ~11 chars per omitted
	// field (`,"note":""`) in encrypted payload size.
	if (normalizedAmount !== undefined && normalizedAmount !== '') wire.amount = normalizedAmount;
	if (p.orderPermlink !== undefined && p.orderPermlink !== '')
		wire.order_permlink = p.orderPermlink;
	if (p.note !== undefined && p.note !== '') wire.note = p.note;
	if (p.memo !== undefined && p.memo !== '') wire.memo = p.memo;
	// cp26 inline-fix — pre-existing cp3 latent bug: USDT
	// `network` field was on the AddressPayload interface but
	// the encoder dropped it from the wire shape, breaking
	// USDT cross-network display in ChatMessage on the receiving
	// side.  Fixed here as it's the same pattern as the
	// adjacent payjoin_endpoint addition.  Now USDT addresses
	// shared via chat carry the network identifier through to
	// the receiver, which is what cp3's design intended.
	//
	// cp30-DD-DD SEC-6 — symmetric encoder-side defense-in-depth
	// matching the decoder's SEC-3 fix.  Without these checks, a
	// buggy caller could pass `{method:'usdc', network:'erc20',
	// address:'<spl-base58>'}` and the encoder would emit a wire
	// message the receiver decoder would then reject (cf. SEC-3) —
	// the sender thinking they sent something valid.  Catching at
	// the encoder produces a clearer developer-time error.  TS
	// types enforce this at compile time but `as`-cast escape
	// hatches in callers can bypass; encoder is the runtime gate.
	//
	// cp30-DD-DD CODE-1 — symmetric to decoder: refuse to emit a
	// multi-network message without the network field.  Closes the
	// missing-required-field hole at both encode and decode.
	if (
		(p.method === 'usdt' || p.method === 'usdc' || p.method === 'dai') &&
		(p.network === undefined || p.network === '')
	) {
		throw new Error(`payload: network field is REQUIRED for method='${p.method}'`);
	}
	if (p.network !== undefined && p.network !== '') {
		if (p.method === 'usdt') {
			const validUsdtNets = new Set(['erc20', 'trc20', 'spl', 'bep20']);
			if (!validUsdtNets.has(p.network)) {
				throw new Error(`payload: invalid network '${p.network}' for USDT`);
			}
			if (!validateUsdtAddress(p.network as UsdtNetwork, p.address)) {
				throw new Error(`payload: address shape does not match USDT network '${p.network}'`);
			}
		} else if (p.method === 'usdc') {
			const validUsdcNets = new Set(['erc20', 'spl', 'base', 'polygon']);
			if (!validUsdcNets.has(p.network)) {
				throw new Error(`payload: invalid network '${p.network}' for USDC`);
			}
			if (!validateUsdcAddress(p.network as UsdcNetwork, p.address)) {
				throw new Error(`payload: address shape does not match USDC network '${p.network}'`);
			}
		} else if (p.method === 'dai') {
			// Part 122 cp31 — DAI 4 networks per ADR-0029 §1.
			// All EVM-family; per-network address validation enforced
			// by validateDaiAddress (each network has its own pinned
			// regex even though they all share the EVM shape — this
			// is the cross-network-mis-send hardening per cp30-DD-DD
			// SEC-3 / SEC-6 pattern).
			const validDaiNets = new Set(['erc20', 'polygon', 'base', 'arbitrum']);
			if (!validDaiNets.has(p.network)) {
				throw new Error(`payload: invalid network '${p.network}' for DAI`);
			}
			if (!validateDaiAddress(p.network as DaiNetwork, p.address)) {
				throw new Error(`payload: address shape does not match DAI network '${p.network}'`);
			}
		} else {
			// Single-network method shipping a `network` value is
			// always a caller bug — refuse rather than silently
			// emit a malformed wire-format message.
			throw new Error(`payload: network field is only valid for multi-network methods (got method='${p.method}')`);
		}
		wire.network = p.network;
	}
	// cp26 — PayJoin (BIP-78) endpoint URL.  BTC-only; the
	// encoder enforces method='btc' as defense-in-depth (UI
	// already gates the input field to BTC).  Wire-format field
	// name uses snake_case `payjoin_endpoint` to match the
	// existing convention (order_permlink, etc.).
	if (p.payjoinEndpoint !== undefined && p.payjoinEndpoint !== '') {
		if (p.method !== 'btc') {
			throw new Error('payload: payjoin_endpoint is only valid for btc method');
		}
		// Sanity check: must parse as a URL.  PayJoin endpoints
		// per BIP-78 should be HTTPS or .onion; we don't enforce
		// either at the encoder level (operator may run a
		// privately-trusted plain-HTTP endpoint on a LAN) but
		// rejecting unparseable strings catches obvious typos.
		try {
			// eslint-disable-next-line no-new
			new URL(p.payjoinEndpoint);
		} catch {
			throw new Error('payload: invalid payjoin_endpoint URL');
		}
		wire.payjoin_endpoint = p.payjoinEndpoint;
	}
	return JSON.stringify(wire);
}

/** Encode a funds-sent payload. */
export function encodeFundsSentPayload(p: FundsSentPayload): string {
	if (p.v !== 1) throw new Error('payload: unsupported version');
	if (p.kind !== 'morphit_funds_sent') throw new Error('payload: wrong kind');
	if (
		p.method !== 'btc' &&
		p.method !== 'xmr' &&
		p.method !== 'blurt' &&
		p.method !== 'usdt' &&
		p.method !== 'usdc' &&
		p.method !== 'dai' &&
		p.method !== 'bch' &&
		p.method !== 'ltc' &&
		p.method !== 'dash' &&
		p.method !== 'doge' &&
		p.method !== 'zec'
	) {
		throw new Error('payload: invalid method');
	}
	if (!isValidTxid(p.method, p.txid)) {
		throw new Error('payload: invalid txid shape');
	}
	if (p.amount !== undefined && p.amount !== '' && !AMOUNT_RE.test(p.amount)) {
		throw new Error('payload: invalid amount');
	}
	if (
		p.orderPermlink !== undefined &&
		p.orderPermlink !== '' &&
		!ORDER_PERMLINK_RE.test(p.orderPermlink)
	) {
		throw new Error('payload: invalid order_permlink');
	}
	if (p.note !== undefined && p.note !== '') {
		if (p.note.length > MAX_NOTE_LEN) {
			throw new Error('payload: note too long');
		}
		if (noteHasForbiddenChars(p.note)) {
			// Phase F.5 audit fix (F-1).
			throw new Error('payload: note contains forbidden characters');
		}
	}
	if (p.memo !== undefined && p.memo !== '') {
		// Phase F.5 audit fix (F-3) — memo is BLURT-only.
		if (p.method !== 'blurt') {
			throw new Error('payload: memo is only valid for blurt method');
		}
		if (!MEMO_RE.test(p.memo)) {
			throw new Error('payload: invalid memo');
		}
	}

	// Phase F.5 audit fix (F-8) — same normalization as
	// encodeAddressPayload.  The buyer's echoed amount should
	// match the chain's 3-decimal precision since that's what
	// the chain transfer actually carries.
	const normalizedAmount =
		p.amount !== undefined && p.method === 'blurt'
			? `${(Math.ceil(parseFloat(p.amount) * 1000) / 1000).toFixed(3)}`
			: p.amount;

	const wire: Record<string, unknown> = {
		v: 1,
		kind: 'morphit_funds_sent',
		method: p.method,
		txid: p.txid
	};
	// F-6: skip empty-string optionals.
	if (normalizedAmount !== undefined && normalizedAmount !== '') wire.amount = normalizedAmount;
	if (p.orderPermlink !== undefined && p.orderPermlink !== '')
		wire.order_permlink = p.orderPermlink;
	if (p.note !== undefined && p.note !== '') wire.note = p.note;
	if (p.memo !== undefined && p.memo !== '') wire.memo = p.memo;
	// cp26 inline-fix — same cp3 latent bug as encodeAddressPayload:
	// FundsSent USDT messages were dropping the network field on
	// the wire, breaking the per-network explorer-link rendering
	// in ChatMessage.  Fixed symmetrically here.
	//
	// cp30-DD-DD SEC-6 — symmetric encoder-side per-network txid
	// validation matching the decoder's SEC-3 fix.  Same posture as
	// encodeAddressPayload: a buggy caller passing mismatched
	// method/network/txid produces a clear developer-time error
	// rather than a silent wire-format message that the receiver
	// then discards.
	//
	// cp30-DD-DD CODE-1 — symmetric to decoder: refuse to emit a
	// multi-network funds_sent message without the network field.
	if (
		(p.method === 'usdt' || p.method === 'usdc' || p.method === 'dai') &&
		(p.network === undefined || p.network === '')
	) {
		throw new Error(`payload: network field is REQUIRED for funds_sent method='${p.method}'`);
	}
	if (p.network !== undefined && p.network !== '') {
		if (p.method === 'usdt') {
			const validUsdtNets = new Set(['erc20', 'trc20', 'spl', 'bep20']);
			if (!validUsdtNets.has(p.network)) {
				throw new Error(`payload: invalid network '${p.network}' for USDT funds_sent`);
			}
			if (!validateUsdtTxid(p.network as UsdtNetwork, p.txid)) {
				throw new Error(`payload: txid shape does not match USDT network '${p.network}'`);
			}
		} else if (p.method === 'usdc') {
			const validUsdcNets = new Set(['erc20', 'spl', 'base', 'polygon']);
			if (!validUsdcNets.has(p.network)) {
				throw new Error(`payload: invalid network '${p.network}' for USDC funds_sent`);
			}
			if (!validateUsdcTxid(p.network as UsdcNetwork, p.txid)) {
				throw new Error(`payload: txid shape does not match USDC network '${p.network}'`);
			}
		} else if (p.method === 'dai') {
			// Part 122 cp31 — DAI 4 networks.
			const validDaiNets = new Set(['erc20', 'polygon', 'base', 'arbitrum']);
			if (!validDaiNets.has(p.network)) {
				throw new Error(`payload: invalid network '${p.network}' for DAI funds_sent`);
			}
			if (!validateDaiTxid(p.network as DaiNetwork, p.txid)) {
				throw new Error(`payload: txid shape does not match DAI network '${p.network}'`);
			}
		} else {
			throw new Error(`payload: network field is only valid for multi-network methods (got method='${p.method}')`);
		}
		wire.network = p.network;
	}
	return JSON.stringify(wire);
}

/** Decode a plaintext string into a structured payload, an
 *  unknown-version marker, or a plaintext fallback.  Never
 *  throws — caller can rely on the result tag.
 *
 *  The fallback to plaintext is critical: if a user types a
 *  message that happens to start with `{`, JSON.parse might
 *  succeed but the shape check will fail; we render as
 *  plaintext.  Conversely, a future v:2 message we don't
 *  understand renders as `unknown_version` so the UI can show
 *  "this message uses a newer protocol — please update" rather
 *  than the raw JSON. */
export function decodePayload(plaintext: string): DecodeResult {
	if (typeof plaintext !== 'string') return { kind: 'plaintext' };
	const trimmed = plaintext.trim();
	if (!trimmed.startsWith('{')) return { kind: 'plaintext' };

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { kind: 'plaintext' };
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { kind: 'plaintext' };
	}
	const o = parsed as Record<string, unknown>;
	// Version check.
	if (typeof o.v !== 'number') return { kind: 'plaintext' };
	if (o.v !== 1) return { kind: 'unknown_version', version: o.v };

	if (o.kind === 'morphit_addr') {
		if (typeof o.method !== 'string') return { kind: 'plaintext' };
		if (
			o.method !== 'btc' &&
			o.method !== 'xmr' &&
			o.method !== 'blurt' &&
			o.method !== 'usdt' &&
			o.method !== 'usdc' &&
			o.method !== 'dai' &&
			o.method !== 'bch' &&
			o.method !== 'ltc' &&
			o.method !== 'dash' &&
			o.method !== 'doge' &&
			o.method !== 'zec'
		)
			return { kind: 'plaintext' };
		if (typeof o.address !== 'string') return { kind: 'plaintext' };
		if (!isValidAddress(o.method, o.address)) return { kind: 'plaintext' };
		const payload: AddressPayload = {
			v: 1,
			kind: 'morphit_addr',
			method: o.method,
			address: o.address
		};
		const result = optionalFieldsAddress(payload, o);
		if (result === null) return { kind: 'plaintext' };
		return { kind: 'address', payload: result };
	}

	if (o.kind === 'morphit_funds_sent') {
		if (typeof o.method !== 'string') return { kind: 'plaintext' };
		if (
			o.method !== 'btc' &&
			o.method !== 'xmr' &&
			o.method !== 'blurt' &&
			o.method !== 'usdt' &&
			o.method !== 'usdc' &&
			o.method !== 'dai' &&
			o.method !== 'bch' &&
			o.method !== 'ltc' &&
			o.method !== 'dash' &&
			o.method !== 'doge' &&
			o.method !== 'zec'
		)
			return { kind: 'plaintext' };
		if (typeof o.txid !== 'string') return { kind: 'plaintext' };
		if (!isValidTxid(o.method, o.txid)) return { kind: 'plaintext' };
		const payload: FundsSentPayload = {
			v: 1,
			kind: 'morphit_funds_sent',
			method: o.method,
			txid: o.txid
		};
		const result = optionalFieldsFundsSent(payload, o);
		if (result === null) return { kind: 'plaintext' };
		return { kind: 'funds_sent', payload: result };
	}

	// Phase F.5 audit fix (F-2) — known version (v:1) but unknown
	// kind.  Likely a future protocol addition (e.g.
	// morphit_dispute) that this client doesn't recognize.  Surface
	// as unknown_kind so the UI can show "old client, please
	// update" rather than rendering raw JSON.
	if (typeof o.kind === 'string' && o.kind.startsWith('morphit_')) {
		return { kind: 'unknown_kind', name: o.kind };
	}

	return { kind: 'plaintext' };
}

function optionalFieldsAddress(
	base: AddressPayload,
	o: Record<string, unknown>
): AddressPayload | null {
	// Phase F.5 audit fix (F-5) — `Object.hasOwn(o, k)` instead of
	// `k in o`.  The `in` operator walks the prototype chain; if
	// the input object inherited from something with `amount`,
	// `note`, etc. on its prototype (unlikely but possible with
	// untrusted data), we'd see a phantom field.  Defense in depth.
	let amount: string | undefined;
	let orderPermlink: string | undefined;
	let note: string | undefined;
	if (Object.hasOwn(o, 'amount')) {
		if (typeof o.amount !== 'string' || !AMOUNT_RE.test(o.amount)) return null;
		amount = o.amount;
	}
	if (Object.hasOwn(o, 'order_permlink')) {
		if (typeof o.order_permlink !== 'string' || !ORDER_PERMLINK_RE.test(o.order_permlink)) {
			return null;
		}
		orderPermlink = o.order_permlink;
	}
	if (Object.hasOwn(o, 'note')) {
		if (typeof o.note !== 'string' || o.note.length > MAX_NOTE_LEN) return null;
		// F-1: reject control chars / bidi overrides.
		if (noteHasForbiddenChars(o.note)) return null;
		note = o.note;
	}
	let memo: string | undefined;
	if (Object.hasOwn(o, 'memo')) {
		if (typeof o.memo !== 'string' || !MEMO_RE.test(o.memo)) return null;
		// Phase F.5 audit fix (F-3) — memo is BLURT-only.
		if (base.method !== 'blurt') return null;
		memo = o.memo;
	}
	// cp26 inline-fix — pre-existing cp3 latent bug: USDT
	// `network` field was being dropped on the wire.  Decoder
	// now reads it back when present.  Multi-network assets
	// (USDT + USDC) ride a `network` discriminator on the wire;
	// other methods carrying a `network` field is malformed.
	//
	// cp30-DD-DD CODE-1 — multi-network methods now REQUIRE the
	// network field (per ADR-0023 + ADR-0028).  Before this fix,
	// a wire-format message `{method:'usdc', address:'0xabc'}`
	// without `network` was accepted; downstream UI rendered the
	// address pill without the network chip, leaving the buyer
	// uncertain which chain to send on.  Reject at the trust gate.
	let network: string | undefined;
	if (
		(base.method === 'usdt' || base.method === 'usdc' || base.method === 'dai') &&
		!Object.hasOwn(o, 'network')
	) {
		return null;
	}
	if (Object.hasOwn(o, 'network')) {
		if (typeof o.network !== 'string' || o.network.length === 0) return null;
		// USDT/USDC/DAI must have one of their supported networks;
		// other methods must not carry the field.  Defense in
		// depth: the wire format permits the field on any
		// method for forward-compat, but we reject network
		// values that don't make sense for the method-asset
		// pairing.
		if (base.method === 'usdt') {
			if (
				o.network !== 'erc20' &&
				o.network !== 'trc20' &&
				o.network !== 'spl' &&
				o.network !== 'bep20'
			) {
				return null;
			}
			// cp30-DD-DD SEC-3 — cross-check address shape against
			// the decoded network.  Without this, a hostile peer
			// could send `{method:'usdt', network:'spl', address:
			// '0xevmformatstring...'}` and the asset-wide check
			// `isValidUsdtAddress` would accept it (any USDT-shape).
			// Downstream UI would display the address under the
			// claimed network's label, potentially confusing the
			// buyer into routing funds incorrectly.  Per-network
			// validation closes the gap; same trust-gate
			// posture as the cp30-DD-11 latent-since-cp3 lesson.
			if (!validateUsdtAddress(o.network as UsdtNetwork, base.address)) {
				return null;
			}
			network = o.network;
		} else if (base.method === 'usdc') {
			// Part 122 cp30: USDC's four shipped networks.  No
			// TRC-20 (Circle doesn't issue on Tron); no BEP-20
			// in this initial set.
			if (
				o.network !== 'erc20' &&
				o.network !== 'spl' &&
				o.network !== 'base' &&
				o.network !== 'polygon'
			) {
				return null;
			}
			// cp30-DD-DD SEC-3 — cross-check USDC address shape
			// against the decoded network.  Critical here because
			// ERC-20, Base, and Polygon all share the EVM 0x[40
			// hex] format; a hostile peer could mislabel an SPL
			// base58 address as `network:'erc20'` (or vice versa)
			// and the asset-wide `isValidUsdcAddress` would accept
			// it because the asset-wide regex is the UNION of
			// per-network shapes.
			if (!validateUsdcAddress(o.network as UsdcNetwork, base.address)) {
				return null;
			}
			network = o.network;
		} else if (base.method === 'dai') {
			// Part 122 cp31: DAI's four shipped networks.  All four
			// are EVM-family (ERC-20, Polygon, Base, Arbitrum); no
			// SPL/TRC-20/BEP-20 per ADR-0029 §1 (no canonical
			// Maker-issued native DAI on those chains).
			if (
				o.network !== 'erc20' &&
				o.network !== 'polygon' &&
				o.network !== 'base' &&
				o.network !== 'arbitrum'
			) {
				return null;
			}
			// cp30-DD-DD SEC-3 pattern — cross-check address shape
			// against the decoded network.  For DAI this is the
			// HIGHEST-RISK class of mismatch because ALL FOUR
			// networks share the EVM 0x[40 hex] format — a hostile
			// peer can't be caught by simple shape inspection alone.
			// But validateDaiAddress's per-network regex also enforces
			// that DAI cannot ship a non-EVM shape under any DAI
			// network value, so an SPL-format address paired with
			// `network:'erc20'` would still fail this check via the
			// network-pinned EVM regex.
			if (!validateDaiAddress(o.network as DaiNetwork, base.address)) {
				return null;
			}
			network = o.network;
		} else {
			// Single-network method with a network field — refuse
			// the payload rather than silently drop, since a wallet
			// might key off it incorrectly.
			return null;
		}
	}
	// cp26 — PayJoin endpoint URL.  BTC-only.
	let payjoinEndpoint: string | undefined;
	if (Object.hasOwn(o, 'payjoin_endpoint')) {
		if (typeof o.payjoin_endpoint !== 'string' || o.payjoin_endpoint.length === 0) {
			return null;
		}
		if (base.method !== 'btc') return null;
		try {
			// eslint-disable-next-line no-new
			new URL(o.payjoin_endpoint);
		} catch {
			return null;
		}
		payjoinEndpoint = o.payjoin_endpoint;
	}
	return { ...base, amount, orderPermlink, note, memo, network, payjoinEndpoint };
}

function optionalFieldsFundsSent(
	base: FundsSentPayload,
	o: Record<string, unknown>
): FundsSentPayload | null {
	let amount: string | undefined;
	let orderPermlink: string | undefined;
	let note: string | undefined;
	if (Object.hasOwn(o, 'amount')) {
		if (typeof o.amount !== 'string' || !AMOUNT_RE.test(o.amount)) return null;
		amount = o.amount;
	}
	if (Object.hasOwn(o, 'order_permlink')) {
		if (typeof o.order_permlink !== 'string' || !ORDER_PERMLINK_RE.test(o.order_permlink)) {
			return null;
		}
		orderPermlink = o.order_permlink;
	}
	if (Object.hasOwn(o, 'note')) {
		if (typeof o.note !== 'string' || o.note.length > MAX_NOTE_LEN) return null;
		// F-1: reject control chars / bidi overrides.
		if (noteHasForbiddenChars(o.note)) return null;
		note = o.note;
	}
	let memo: string | undefined;
	if (Object.hasOwn(o, 'memo')) {
		if (typeof o.memo !== 'string' || !MEMO_RE.test(o.memo)) return null;
		// Phase F.5 audit fix (F-3) — memo is BLURT-only.
		if (base.method !== 'blurt') return null;
		memo = o.memo;
	}
	// cp26 inline-fix — symmetric to optionalFieldsAddress.
	// Multi-network assets (USDT + USDC) ride a `network`
	// discriminator on the wire that needs to round-trip through
	// FundsSent payloads too.
	//
	// cp30-DD-DD CODE-1 — multi-network methods REQUIRE network
	// field (same posture as optionalFieldsAddress).  A funds-sent
	// message without network gives the seller no way to pick the
	// right explorer.
	let network: string | undefined;
	if (
		(base.method === 'usdt' || base.method === 'usdc' || base.method === 'dai') &&
		!Object.hasOwn(o, 'network')
	) {
		return null;
	}
	if (Object.hasOwn(o, 'network')) {
		if (typeof o.network !== 'string' || o.network.length === 0) return null;
		if (base.method === 'usdt') {
			if (
				o.network !== 'erc20' &&
				o.network !== 'trc20' &&
				o.network !== 'spl' &&
				o.network !== 'bep20'
			) {
				return null;
			}
			// cp30-DD-DD SEC-3 — cross-check txid shape against the
			// decoded network.  Same defense-in-depth as the
			// AddressPayload path; without this, a hostile peer could
			// send `{method:'usdt', network:'erc20', txid:'<spl-txid>'}`
			// and the asset-wide `isValidUsdtTxid` would accept it,
			// causing the UI to render a misleading explorer link.
			if (!validateUsdtTxid(o.network as UsdtNetwork, base.txid)) {
				return null;
			}
			network = o.network;
		} else if (base.method === 'usdc') {
			if (
				o.network !== 'erc20' &&
				o.network !== 'spl' &&
				o.network !== 'base' &&
				o.network !== 'polygon'
			) {
				return null;
			}
			// cp30-DD-DD SEC-3 — same cross-check on USDC.  Critical
			// because ERC-20/Base/Polygon share the EVM 0x[64 hex]
			// txid shape; only the network field disambiguates which
			// explorer to link.
			if (!validateUsdcTxid(o.network as UsdcNetwork, base.txid)) {
				return null;
			}
			network = o.network;
		} else if (base.method === 'dai') {
			// Part 122 cp31 — DAI four shipped networks.  All
			// EVM-family (no SPL/TRC-20/BEP-20 per ADR-0029 §1).
			if (
				o.network !== 'erc20' &&
				o.network !== 'polygon' &&
				o.network !== 'base' &&
				o.network !== 'arbitrum'
			) {
				return null;
			}
			// cp30-DD-DD SEC-3 — same cross-check on DAI.  ALL FOUR
			// networks share the EVM 0x[64 hex] txid shape; only
			// the network field disambiguates which explorer to
			// link.  Without this, a hostile peer could mislabel an
			// Arbitrum txid as `network:'polygon'` and the UI would
			// render a Polygonscan link that 404s.
			if (!validateDaiTxid(o.network as DaiNetwork, base.txid)) {
				return null;
			}
			network = o.network;
		} else {
			return null;
		}
	}
	return { ...base, amount, orderPermlink, note, memo, network };
}

/** Build a wallet-recognized payment URI for a payload.  Used
 *  to render QR codes and (future) "open in wallet" deep links.
 *
 *  Per-method conventions:
 *
 *  - BTC: BIP-21 (`bitcoin:<address>?amount=X`).  Universally
 *    supported across mobile wallets.  Amount is in BTC, not
 *    satoshis.
 *
 *  - XMR: official Monero URI scheme (`monero:<address>?tx_amount=X`).
 *    Per the URI scheme spec, the amount param is `tx_amount`,
 *    not `amount` — Monero historically used different naming
 *    than BIP-21, and modern wallets follow the spec.
 *
 *  - BLURT: bare account name with no URI scheme.  There is no
 *    widely-deployed `blurt:` URI scheme; Steem-family mobile
 *    wallets (Keychain, Beem, etc.) accept the bare account
 *    name and the user fills in the rest manually.  Memo is
 *    omitted from the QR — the chain transfer's memo is a
 *    separate concern (privacy-affecting; we don't want to
 *    auto-pre-fill something sensitive).
 *
 *  No order_permlink, note, or any Morphit-specific metadata
 *  goes into the QR — the QR's only job is to get the
 *  recipient's wallet to the "send to address" screen with the
 *  right amount.  Everything else stays inside the chat. */
export function buildPaymentUri(p: AddressPayload): string {
	const params = new URLSearchParams();
	if (p.method === 'btc') {
		if (p.amount !== undefined) params.set('amount', p.amount);
		// cp26 — PayJoin (BIP-78) endpoint propagation.  BTC-only
		// at present; the BIP doesn't apply to non-Bitcoin chains.
		// Buyer wallets that support PayJoin will detect the pj=
		// parameter and switch to the BIP-78 PSBT exchange flow;
		// non-PayJoin wallets ignore the param and fall back to a
		// normal payment.  Zero footgun.
		if (
			p.payjoinEndpoint !== undefined &&
			p.payjoinEndpoint.trim().length > 0
		) {
			params.set('pj', p.payjoinEndpoint.trim());
		}
		const qs = params.toString();
		return `bitcoin:${p.address}${qs ? `?${qs}` : ''}`;
	}
	if (p.method === 'xmr') {
		// XMR uses tx_amount per the official URI scheme.
		if (p.amount !== undefined) params.set('tx_amount', p.amount);
		const qs = params.toString();
		return `monero:${p.address}${qs ? `?${qs}` : ''}`;
	}
	if (p.method === 'bch') {
		// Bitcoin Cash uses the `bitcoincash:` URI scheme per the
		// CashAddr spec (BIP-21 derivative for BCH).  If the
		// address is already in `bitcoincash:` prefixed form, use
		// it verbatim; if bare (CashAddr without prefix, or legacy
		// 1.../3...), wrap with the scheme.  Most BCH wallets
		// accept both forms.  `amount` parameter follows BIP-21
		// conventions (decimal BCH).
		if (p.amount !== undefined) params.set('amount', p.amount);
		const qs = params.toString();
		const addr = p.address.startsWith('bitcoincash:')
			? p.address
			: `bitcoincash:${p.address}`;
		return `${addr}${qs ? `?${qs}` : ''}`;
	}
	if (p.method === 'ltc') {
		// Litecoin uses the `litecoin:` URI scheme — BIP-21
		// conformant (same shape as BTC's `bitcoin:` scheme since
		// the LTC fork preserved Bitcoin's URI conventions).
		// `amount` parameter is decimal LTC, BIP-21 standard.
		// LTC addresses don't need prefix-wrapping like CashAddr
		// — every modern format (L.../M.../3.../ltc1...) is
		// unambiguous within the LTC URI scheme.
		if (p.amount !== undefined) params.set('amount', p.amount);
		const qs = params.toString();
		return `litecoin:${p.address}${qs ? `?${qs}` : ''}`;
	}
	if (p.method === 'dash') {
		// Dash uses the `dash:` URI scheme — BIP-21 conformant
		// (cp27).  Same shape as BTC's `bitcoin:` scheme; Dash
		// inherited Bitcoin's URI conventions from the fork.
		// `amount` parameter is decimal DASH, BIP-21 standard.
		// DASH addresses are unambiguous within the URI scheme
		// (X-prefix P2PKH and 7-prefix P2SH; no bech32-equivalent).
		// Reference: https://docs.dash.org/projects/core/en/stable/docs/api/remote-procedure-call.html
		if (p.amount !== undefined) params.set('amount', p.amount);
		const qs = params.toString();
		return `dash:${p.address}${qs ? `?${qs}` : ''}`;
	}
	if (p.method === 'doge') {
		// Dogecoin uses the `dogecoin:` URI scheme — BIP-21
		// conformant (cp33 — Part 122).  Same shape as BTC's
		// `bitcoin:` scheme; Dogecoin inherited Bitcoin's URI
		// conventions from the 2013 Litecoin fork (which itself
		// inherited from Bitcoin).  `amount` parameter is
		// decimal DOGE, BIP-21 standard.  DOGE addresses are
		// unambiguous within the URI scheme (D-prefix P2PKH and
		// 9/A-prefix P2SH; no bech32-equivalent because segwit
		// has never activated on Dogecoin).
		// Reference: https://github.com/dogecoin/dogecoin (the
		// `dogecoin:` URI is documented in Dogecoin Core
		// wallet/qt source).
		if (p.amount !== undefined) params.set('amount', p.amount);
		const qs = params.toString();
		return `dogecoin:${p.address}${qs ? `?${qs}` : ''}`;
	}
	if (p.method === 'zec') {
		// Zcash uses the `zcash:` URI scheme — ZIP-321 conformant
		// (cp39 — Part 122).  Same BIP-21-style shape as BTC's
		// `bitcoin:` scheme with `amount` as decimal ZEC.  ZEC
		// addresses are unambiguous within the URI scheme: t1/t3
		// prefixes are base58 (transparent), zs1 is bech32
		// (Sapling shielded), u1 is bech32m (Unified Address).
		// All four are valid wallet-recognizable shapes.
		// Reference: https://zips.z.cash/zip-0321 (Payment Request
		// URI specification).
		if (p.amount !== undefined) params.set('amount', p.amount);
		const qs = params.toString();
		return `zcash:${p.address}${qs ? `?${qs}` : ''}`;
	}
	if (p.method === 'blurt') {
		// No URI scheme; bare account name.  Mobile wallets that
		// support Steem-family chains pre-fill the recipient.
		return p.address;
	}
	// Exhaustiveness — TS already enforces but be safe at runtime.
	return p.address;
}

/** Validate a memo string against the canonical shape.  Used
 *  by the encoder, decoder, and (Phase F.4) the on-chain
 *  verifier when comparing the seller's expected memo against
 *  the buyer's claimed memo and the actual transfer's memo. */
export function isValidMemo(s: string): boolean {
	if (typeof s !== 'string') return false;
	return MEMO_RE.test(s);
}

/** Generate a fresh BLURT payment memo.  Cryptographically
 *  random (Web Crypto), 8 chars from a confusable-free
 *  alphabet (32 chars: lowercase letters minus l/o + digits 2-9
 *  minus 0/1).  ~40 bits of entropy.
 *
 *  Why CSPRNG, not Math.random: to defeat a pre-image
 *  attacker who could otherwise pre-compute a memo and front-
 *  run a trade — they'd send the seller a small payment with
 *  the predicted memo, corrupting the seller's accounting
 *  (legitimate buyer's later transfer with the same memo
 *  arrives at an account that already has a "matched" entry).
 *  CSPRNG output is unguessable; the attack collapses.
 *
 *  Why drop l/o/0/1 from the alphabet: read-aloud safety —
 *  if a user dictates the memo over a phone call, "el" / "oh"
 *  / "zero" / "one" are commonly misheard.
 *
 *  Returns the memo as a string; throws if Web Crypto is
 *  unavailable (extremely rare; old browsers we don't
 *  support). */
export function generateBlurtMemo(): string {
	const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 chars
	if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
		throw new Error('generateBlurtMemo: Web Crypto not available');
	}
	const bytes = new Uint8Array(GENERATED_MEMO_LEN);
	crypto.getRandomValues(bytes);
	let out = '';
	for (let i = 0; i < GENERATED_MEMO_LEN; i++) {
		// Modulo 32 with a 32-char alphabet — power-of-two means
		// no modulo bias.  bytes[i] is 0..255, & 0x1f gives 0..31.
		out += alphabet[(bytes[i] as number) & 0x1f];
	}
	return out;
}

/** Exported constants — UI layer occasionally wants the cap. */
export const PAYLOAD_CONSTANTS = {
	MAX_NOTE_LEN,
	MAX_AMOUNT_LEN,
	GENERATED_MEMO_LEN
} as const;
