/**
 * Morphit — private-key detector.
 *
 * Scans user-entered text (chat, feedback, replies, etc.) for patterns
 * that look like private key material and returns the matches so the
 * UI can warn + redact.
 *
 * Policy:
 *   - Never allow a private key to be broadcast in a user-text field.
 *   - Warn the user the first time one is detected in a field.
 *   - If they submit anyway, auto-redact using truncateKey() before
 *     the payload leaves the client.
 *
 * Detected patterns:
 *   1. WIF-encoded private keys. Base58, length 51 (uncompressed,
 *      starts with `5`) or 52 (compressed, starts with `K`/`L`).
 *      Also matches BTC testnet variants (`9`/`c`). Covers:
 *        - Blurt active/owner/posting/memo keys
 *        - Bitcoin private keys
 *        - Any Graphene chain key (Steem, Hive, EOS-era clones)
 *
 *   2. 64-character lowercase hex strings. Covers:
 *        - Monero private spend key
 *        - Monero private view key
 *        - Raw ECDSA private keys (32 bytes hex-encoded)
 *        - Blurt keys as raw hex (less common; the WIF form is canonical)
 *
 *   3. BIP-39 mnemonics. Sequences of 12+ consecutive words where
 *      every word is in the BIP-39 English wordlist. Catches:
 *        - Blurt/Morphit seed phrases (12 words)
 *        - Bitcoin seeds (all standard lengths: 12/15/18/21/24)
 *        - Any BIP-39 hardware-wallet recovery phrase
 *
 * Known gaps (documented, not yet covered):
 *   - Monero's 25-word mnemonic uses a separate wordlist. Not bundled
 *     here; a user who pastes a Monero seed phrase in a text field
 *     would not be caught by the BIP-39 detector.
 *   - Base58-encoded strings that merely LOOK like WIFs but aren't
 *     (no checksum validation). This is intentional — a false
 *     positive here just truncates some other random base58 data
 *     that the user probably also shouldn't be pasting in plain text.
 *     Catastrophic false negatives (a real key slips through) are
 *     much worse than false positives (an invoice id gets redacted).
 */

import { wordlist } from '@scure/bip39/wordlists/english';

/** 6+…+4 redaction per project convention. Shows enough for the user
 *  to recognize which key was redacted without revealing the secret. */
export function truncateKey(key: string): string {
	if (key.length <= 10) return key;
	return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export type PrivateKeyMatchKind = 'wif' | 'hex_64' | 'mnemonic';

export interface PrivateKeyMatch {
	/** Character offset in the input where this match starts. */
	readonly start: number;
	/** Character offset one past the end of the match. */
	readonly end: number;
	/** The exact text matched. Passed through unchanged for
	 *  redaction display (the truncateKey of this text is what
	 *  shows to the user). */
	readonly text: string;
	/** What kind of private-key pattern was matched. */
	readonly kind: PrivateKeyMatchKind;
}

// ─── WIF detector ──────────────────────────────────────────────────

/** Base58 alphabet: no 0, O, I, l.  Chosen length window 51-52 to
 *  cover both uncompressed (51) and compressed (52) WIFs. Prefix
 *  class covers mainnet (5/K/L) and BTC testnet (9/c). */
const WIF_RE = /\b[59KLc][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;

// ─── Raw hex detector (64 chars) ────────────────────────────────────

/** 64-char hex: Monero private keys, raw secp256k1 private keys.
 *  Case-insensitive; enforced as word-bounded so arbitrary shorter
 *  hex doesn't match. */
const HEX_64_RE = /\b[0-9a-fA-F]{64}\b/g;

// ─── BIP-39 mnemonic detector ───────────────────────────────────────

/** Lazy-built Set of BIP-39 words, lowercase for comparison. The
 *  @scure/bip39 wordlist is already in the bundle (used by the
 *  onboarding keygen flow), so this adds no extra weight. */
let bip39Set: Set<string> | null = null;
function getBip39Set(): Set<string> {
	if (bip39Set === null) {
		bip39Set = new Set(wordlist);
	}
	return bip39Set;
}

/** Tokenize into candidate words + track their positions in the
 *  original string. Whitespace-split; also break on punctuation so
 *  a mnemonic appearing in "my seed is: word word word" tokenizes
 *  cleanly. */
interface TokenRef {
	readonly word: string; // lowercased
	readonly start: number; // original-string offset
	readonly end: number;
}

function tokenize(text: string): TokenRef[] {
	const tokens: TokenRef[] = [];
	// Match runs of letters (case-insensitive ASCII). BIP-39 English
	// words are all lowercase ASCII, so locale-awareness isn't
	// needed and would only add FP risk.
	const re = /[a-zA-Z]+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		tokens.push({
			word: m[0].toLowerCase(),
			start: m.index,
			end: m.index + m[0].length
		});
	}
	return tokens;
}

/** Minimum consecutive BIP-39 words to flag as a likely mnemonic.
 *  BIP-39 seeds are 12/15/18/21/24 words. We flag on 12+. Going
 *  lower would flood on English prose (common BIP-39 words like
 *  "love", "animal", "garden" appear in normal text). */
const MNEMONIC_MIN_WORDS = 12;

function detectMnemonics(text: string): PrivateKeyMatch[] {
	const set = getBip39Set();
	const tokens = tokenize(text);
	const matches: PrivateKeyMatch[] = [];

	// Find maximal runs of consecutive-in-wordlist tokens.
	let runStart = -1; // token index where the current run began
	for (let i = 0; i < tokens.length; i++) {
		const inWordlist = set.has(tokens[i]!.word);
		if (inWordlist) {
			if (runStart === -1) runStart = i;
		} else {
			if (runStart !== -1) {
				const runLen = i - runStart;
				if (runLen >= MNEMONIC_MIN_WORDS) {
					matches.push({
						start: tokens[runStart]!.start,
						end: tokens[i - 1]!.end,
						text: text.slice(tokens[runStart]!.start, tokens[i - 1]!.end),
						kind: 'mnemonic'
					});
				}
				runStart = -1;
			}
		}
	}
	// Handle the case where the string ends mid-run.
	if (runStart !== -1) {
		const runLen = tokens.length - runStart;
		if (runLen >= MNEMONIC_MIN_WORDS) {
			const last = tokens[tokens.length - 1]!;
			matches.push({
				start: tokens[runStart]!.start,
				end: last.end,
				text: text.slice(tokens[runStart]!.start, last.end),
				kind: 'mnemonic'
			});
		}
	}
	return matches;
}

// ─── Public API ─────────────────────────────────────────────────────

/** Scan `text` for any private-key-looking substring. Returns all
 *  matches sorted by start position, non-overlapping. If two
 *  detectors would match the same region (rare — WIF and hex are
 *  disjoint; mnemonic is words-only so disjoint from both), the
 *  earlier-starting match wins and the later is dropped. */
export function detectPrivateKeys(text: string): PrivateKeyMatch[] {
	const out: PrivateKeyMatch[] = [];

	for (const m of text.matchAll(WIF_RE)) {
		out.push({
			start: m.index,
			end: m.index + m[0].length,
			text: m[0],
			kind: 'wif'
		});
	}
	for (const m of text.matchAll(HEX_64_RE)) {
		out.push({
			start: m.index,
			end: m.index + m[0].length,
			text: m[0],
			kind: 'hex_64'
		});
	}
	for (const m of detectMnemonics(text)) {
		out.push(m);
	}

	// Sort + dedupe overlapping matches. Earlier start wins; on
	// tie, longer span wins.
	out.sort((a, b) => a.start - b.start || b.end - a.end - (b.start - a.start));
	const deduped: PrivateKeyMatch[] = [];
	let lastEnd = -1;
	for (const m of out) {
		if (m.start >= lastEnd) {
			deduped.push(m);
			lastEnd = m.end;
		}
	}
	return deduped;
}

/** Apply truncation to every detected match in `text`, preserving
 *  the surrounding characters unchanged. Use this on the payload
 *  before broadcast so that even if the UI highlight was ignored,
 *  nothing sensitive leaves the client. */
export function redactPrivateKeys(text: string): string {
	const matches = detectPrivateKeys(text);
	if (matches.length === 0) return text;
	const parts: string[] = [];
	let cursor = 0;
	for (const m of matches) {
		parts.push(text.slice(cursor, m.start));
		parts.push(truncateKey(m.text));
		cursor = m.end;
	}
	parts.push(text.slice(cursor));
	return parts.join('');
}
