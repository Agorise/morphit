/**
 * Morphit chat — structured payload encode/decode (Phase F).
 *
 * Buyers and sellers exchange BTC/XMR receiving addresses (and
 * "funds sent" acknowledgments) inside encrypted chat messages.
 * The chat layer below this module treats the inner plaintext as
 * an opaque string — encryption, broadcast, and indexer storage
 * don't care about its shape.  This module is the structured
 * shape that rides inside the plaintext.
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
 *  without a network. */
export type ChatAssetTicker = 'btc' | 'xmr' | 'blurt' | 'usdt';

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
	 *  'bep20').  Undefined for single-network assets (btc, xmr,
	 *  blurt).  Per Part 121: USDT addresses on different
	 *  networks have INCOMPATIBLE formats — sending USDT-ERC20
	 *  to a TRC-20 address loses funds.  The network field
	 *  pins the receiving network so chat-side validation
	 *  catches mismatches and the explorer URL builder picks
	 *  the right template. */
	readonly network?: string;
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
	/** Part 121: sub-network for multi-network assets.  REQUIRED
	 *  when method === 'usdt'.  Lets the receiving client pick
	 *  the right per-network explorer URL when rendering the
	 *  txid as a clickable link. */
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

/** Dispatch by method. */
export function isValidAddress(method: ChatAssetTicker, addr: string): boolean {
	if (method === 'btc') return isValidBtcAddress(addr);
	if (method === 'xmr') return isValidXmrAddress(addr);
	if (method === 'blurt') return isValidBlurtAccount(addr);
	if (method === 'usdt') return isValidUsdtAddress(addr);
	return false;
}

/** Validate a txid. */
export function isValidTxid(method: ChatAssetTicker, txid: string): boolean {
	if (typeof txid !== 'string') return false;
	if (method === 'btc') return BTC_TXID_RE.test(txid);
	if (method === 'xmr') return XMR_TXID_RE.test(txid);
	if (method === 'blurt') return BLURT_TXID_RE.test(txid);
	if (method === 'usdt') return isValidUsdtTxid(txid);
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
	if (p.method !== 'btc' && p.method !== 'xmr' && p.method !== 'blurt') {
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
	return JSON.stringify(wire);
}

/** Encode a funds-sent payload. */
export function encodeFundsSentPayload(p: FundsSentPayload): string {
	if (p.v !== 1) throw new Error('payload: unsupported version');
	if (p.kind !== 'morphit_funds_sent') throw new Error('payload: wrong kind');
	if (p.method !== 'btc' && p.method !== 'xmr' && p.method !== 'blurt') {
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
		if (o.method !== 'btc' && o.method !== 'xmr' && o.method !== 'blurt')
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
		if (o.method !== 'btc' && o.method !== 'xmr' && o.method !== 'blurt')
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
	return { ...base, amount, orderPermlink, note, memo };
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
	return { ...base, amount, orderPermlink, note, memo };
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
		const qs = params.toString();
		return `bitcoin:${p.address}${qs ? `?${qs}` : ''}`;
	}
	if (p.method === 'xmr') {
		// XMR uses tx_amount per the official URI scheme.
		if (p.amount !== undefined) params.set('tx_amount', p.amount);
		const qs = params.toString();
		return `monero:${p.address}${qs ? `?${qs}` : ''}`;
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
