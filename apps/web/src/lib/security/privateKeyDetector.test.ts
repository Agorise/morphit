// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { detectPrivateKeys, redactPrivateKeys, truncateKey } from './privateKeyDetector';

// ─── truncateKey ─────────────────────────────────────────────────

describe('truncateKey — 6+…+4 redaction shape', () => {
	it('produces first-6 + ellipsis + last-4 for long strings', () => {
		const key = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';
		const result = truncateKey(key);
		expect(result).toBe('5KQwrP…vFDe');
		// Sanity-check the shape.
		expect(result.startsWith(key.slice(0, 6))).toBe(true);
		expect(result.endsWith(key.slice(-4))).toBe(true);
		expect(result).toContain('…');
	});

	it('returns strings of 10 or fewer chars unchanged', () => {
		expect(truncateKey('short')).toBe('short');
		expect(truncateKey('exactly10!')).toBe('exactly10!');
		expect(truncateKey('')).toBe('');
	});

	it('truncates 11-char strings to the redacted form', () => {
		// 11 chars = just over the threshold.
		expect(truncateKey('12345678901')).toBe('123456…8901');
	});

	it('redaction never reveals the middle of the key', () => {
		const key = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';
		const redacted = truncateKey(key);
		// The middle 41 chars must not appear in the output.
		const middle = key.slice(6, -4);
		expect(redacted).not.toContain(middle);
	});
});

// ─── WIF detection (Blurt + BTC) ─────────────────────────────────

describe('detectPrivateKeys — WIF keys', () => {
	it('detects a Blurt-style 51-char WIF (prefix 5)', () => {
		const text =
			'here is my key: 5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe and more text';
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('wif');
		expect(matches[0]!.text).toBe('5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe');
	});

	it('detects a compressed BTC WIF starting with K', () => {
		const text = 'Kwr4xEjXCp5jZxXLKR1BkDKcGmHpHwPBuSqFv8HNgPnaGcCLLEeE';
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('wif');
	});

	it('detects a compressed BTC WIF starting with L', () => {
		const text = 'pssst Lwr4xEjXCp5jZxXLKR1BkDKcGmHpHwPBuSqFv8HNgPnaGcCLLEeE shhhh';
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('wif');
	});

	it('detects BTC testnet WIF starting with 9', () => {
		const text = '9wr4xEjXCp5jZxXLKR1BkDKcGmHpHwPBuSqFv8HNgPnaGcCLLEeE';
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('wif');
	});

	it('detects BTC testnet compressed WIF starting with c', () => {
		const text = 'cwr4xEjXCp5jZxXLKR1BkDKcGmHpHwPBuSqFv8HNgPnaGcCLLEeE';
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('wif');
	});

	it('does NOT match strings too short to be WIFs', () => {
		expect(detectPrivateKeys('5KQwrPbwdL')).toHaveLength(0);
		expect(detectPrivateKeys('short 5abc')).toHaveLength(0);
	});

	it('does NOT match strings too long to be WIFs', () => {
		// 53+ chars starting with 5 — outside the 51-52 window.
		const tooLong = '5' + 'K'.repeat(60);
		expect(detectPrivateKeys(tooLong)).toHaveLength(0);
	});

	it('does NOT match base58 containing 0 / O / I / l', () => {
		// 51 chars starting with 5, but containing excluded chars.
		const invalid = '50QwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe'; // 0 at pos 1
		expect(detectPrivateKeys(invalid)).toHaveLength(0);
	});

	it('does NOT match account names that happen to start with K', () => {
		// An account name is 3-16 lowercase alnum+hyphen starting
		// with a letter. "Kenny" is 5 chars — far below WIF length.
		expect(detectPrivateKeys('Kenny is trading today')).toHaveLength(0);
	});

	it('respects word boundaries — a WIF concatenated to more text is still detected', () => {
		// A WIF hyphenated to something else. Word-boundary at hyphen.
		const text = 'here-5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe-done';
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('wif');
	});
});

// ─── 64-char hex detection (XMR + raw privkey) ───────────────────

describe('detectPrivateKeys — 64-char hex keys', () => {
	it('detects an XMR-style 64 hex char private key (lowercase)', () => {
		const text =
			'spend key is 89de3c5e96f4f93a3d3a4ae6a1b0bcb5eaa9b1e0f76a27e44c5f12b7ab9c0d1e see';
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('hex_64');
		expect(matches[0]!.text.length).toBe(64);
	});

	it('detects 64-char hex in uppercase', () => {
		const text = '89DE3C5E96F4F93A3D3A4AE6A1B0BCB5EAA9B1E0F76A27E44C5F12B7AB9C0D1E';
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('hex_64');
	});

	it('detects 64-char hex in mixed case', () => {
		const text = '89De3c5E96f4F93A3d3a4Ae6a1B0bCb5eaa9b1e0F76a27E44c5f12B7aB9c0d1E';
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(1);
	});

	it('does NOT match 40-char hex (Blurt/BTC trx_id length)', () => {
		const text = 'trx abc123def456abc123def456abc123def456abcd followed';
		expect(detectPrivateKeys(text)).toHaveLength(0);
	});

	it('does NOT match an Ethereum address (0x + 40 hex)', () => {
		const text = '0x742d35Cc6635C0532925a3b844Bc9e7595f0BEbb';
		expect(detectPrivateKeys(text)).toHaveLength(0);
	});

	it('does NOT match 63 hex chars (one short)', () => {
		const sixtyThree = 'a'.repeat(63);
		expect(detectPrivateKeys(sixtyThree)).toHaveLength(0);
	});

	it('does NOT match 65 hex chars (one long)', () => {
		const sixtyFive = 'a'.repeat(65);
		expect(detectPrivateKeys(sixtyFive)).toHaveLength(0);
	});

	it('detects EACH 64-hex string when two are separated by whitespace', () => {
		const a = 'a'.repeat(64);
		const b = 'b'.repeat(64);
		const text = `${a} and ${b}`;
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(2);
		expect(matches.every((m) => m.kind === 'hex_64')).toBe(true);
	});

	it('does NOT match 128 concatenated hex chars as one hex_64', () => {
		// 128 hex chars with no word boundary = one big word of
		// 128 hex. Our \b[0-9a-fA-F]{64}\b anchors both ends to
		// word boundaries, so a 128-char run wouldn't match a
		// 64-substring of it.
		const oneTwentyEight = 'a'.repeat(128);
		expect(detectPrivateKeys(oneTwentyEight)).toHaveLength(0);
	});
});

// ─── BIP-39 mnemonic detection ──────────────────────────────────

describe('detectPrivateKeys — BIP-39 mnemonics', () => {
	// These are the canonical BIP-39 test vectors from the spec
	// (https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki).
	// Publishing them in a test file is safe because they've been
	// publicly documented as test vectors since 2014. No real
	// wallet should ever use them.

	const TEST_12_WORDS =
		'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
	const TEST_24_WORDS =
		'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';

	it('detects a 12-word BIP-39 mnemonic', () => {
		const matches = detectPrivateKeys(TEST_12_WORDS);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('mnemonic');
	});

	it('detects a 24-word BIP-39 mnemonic', () => {
		const matches = detectPrivateKeys(TEST_24_WORDS);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('mnemonic');
	});

	it('detects a mnemonic embedded in prose', () => {
		const text = `please help me recover: ${TEST_12_WORDS} thanks!`;
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('mnemonic');
	});

	it('does NOT match 11 consecutive BIP-39 words (below threshold)', () => {
		const elevenWords =
			'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
		expect(detectPrivateKeys(elevenWords)).toHaveLength(0);
	});

	it('does NOT match ordinary English prose', () => {
		// Even if SOME of these words happen to appear in the BIP-39
		// list, what matters for the detector is runs of 12+
		// consecutive matches. Ordinary sentences break any such
		// run with short glue words (the, is, a, of, to, in) that
		// are below the BIP-39 minimum word length of 3-4 chars.
		const prose =
			'The quick fox is a nice animal of the forest, is it not? I think so. We all agree.';
		expect(detectPrivateKeys(prose)).toHaveLength(0);
	});

	it('detects the mnemonic even when words are separated by punctuation', () => {
		// Our tokenizer breaks on non-alpha, so commas shouldn't
		// stop the run.
		const punctuated =
			'abandon, abandon, abandon, abandon, abandon, abandon, abandon, abandon, abandon, abandon, abandon, about';
		const matches = detectPrivateKeys(punctuated);
		expect(matches).toHaveLength(1);
		expect(matches[0]!.kind).toBe('mnemonic');
	});

	it('detects mnemonic with mixed-case input', () => {
		const mixed =
			'Abandon ABANDON abandon abandon abandon abandon abandon abandon abandon abandon abandon About';
		const matches = detectPrivateKeys(mixed);
		expect(matches).toHaveLength(1);
	});
});

// ─── Multiple matches + deduplication ────────────────────────────

describe('detectPrivateKeys — multiple matches', () => {
	it('detects a WIF AND a 64-hex key in the same string', () => {
		const wif = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';
		const hex = '89de3c5e96f4f93a3d3a4ae6a1b0bcb5eaa9b1e0f76a27e44c5f12b7ab9c0d1e';
		const text = `wif: ${wif} and xmr: ${hex}`;
		const matches = detectPrivateKeys(text);
		expect(matches).toHaveLength(2);
		const kinds = matches.map((m) => m.kind).sort();
		expect(kinds).toEqual(['hex_64', 'wif']);
	});

	it('returns matches sorted by start position', () => {
		const wif = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';
		const hex = '89de3c5e96f4f93a3d3a4ae6a1b0bcb5eaa9b1e0f76a27e44c5f12b7ab9c0d1e';
		const text = `${hex} then ${wif}`;
		const matches = detectPrivateKeys(text);
		expect(matches[0]!.start).toBeLessThan(matches[1]!.start);
	});
});

// ─── Edge cases ─────────────────────────────────────────────────

describe('detectPrivateKeys — edge cases', () => {
	it('returns empty array for empty string', () => {
		expect(detectPrivateKeys('')).toEqual([]);
	});

	it('returns empty array for whitespace-only input', () => {
		expect(detectPrivateKeys('   \n\t  ')).toEqual([]);
	});

	it('returns empty array for single character', () => {
		expect(detectPrivateKeys('5')).toEqual([]);
	});

	it('handles very long strings without hanging', () => {
		// Stress test: 100KB of random-ish text. Must complete in
		// reasonable time (< 1s) even though Node test env isn't a
		// performance benchmark.
		const bulk = 'the quick brown fox jumps over the lazy dog. '.repeat(2000);
		const start = Date.now();
		const matches = detectPrivateKeys(bulk);
		const elapsed = Date.now() - start;
		expect(matches).toEqual([]);
		expect(elapsed).toBeLessThan(1000);
	});
});

// ─── redactPrivateKeys ──────────────────────────────────────────

describe('redactPrivateKeys — end-to-end redaction', () => {
	it('returns input unchanged when no keys present', () => {
		const text = 'Hello Bob, meet me at the coffee shop at 3pm.';
		expect(redactPrivateKeys(text)).toBe(text);
	});

	it('redacts a WIF preserving surrounding text', () => {
		const text = 'send to 5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe please';
		const result = redactPrivateKeys(text);
		expect(result).toContain('send to ');
		expect(result).toContain(' please');
		expect(result).toContain('5KQwrP…vFDe');
		expect(result).not.toContain('5KQwrPbwdL6P'); // the full key is not present
	});

	it('redacts multiple keys in one string', () => {
		const wif = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';
		const hex = 'a'.repeat(64);
		const text = `wif: ${wif}, hex: ${hex}`;
		const result = redactPrivateKeys(text);
		expect(result).toContain('5KQwrP…vFDe');
		expect(result).toContain('aaaaaa…aaaa');
		expect(result).not.toContain(wif);
		expect(result).not.toContain(hex);
	});

	it('redacts a BIP-39 mnemonic', () => {
		const mnemonic =
			'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
		// The prefix must NOT be a BIP-39 word — otherwise the
		// detector correctly extends the run (e.g. "seed" IS a
		// BIP-39 word, so "seed: abandon..." is a 13-word match
		// whose truncation eats the colon and space).  "backup"
		// is not in the BIP-39 wordlist, so the run starts at
		// the first abandon.
		const text = `backup: ${mnemonic}`;
		const result = redactPrivateKeys(text);
		// The full mnemonic should not be in the output.
		expect(result).not.toContain(mnemonic);
		// But the truncated form (6+…+4) should be.  Mnemonic ends
		// in 'about', so last 4 chars are 'bout'.
		expect(result).toContain('abando…bout');
		// And the non-mnemonic prefix should be preserved verbatim.
		expect(result).toContain('backup: ');
	});

	it('preserves text ordering and structure around redactions', () => {
		const wif1 = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';
		const wif2 = 'Kwr4xEjXCp5jZxXLKR1BkDKcGmHpHwPBuSqFv8HNgPnaGcCLLEeE';
		const text = `first ${wif1} middle ${wif2} last`;
		const result = redactPrivateKeys(text);
		expect(result.startsWith('first ')).toBe(true);
		expect(result.endsWith(' last')).toBe(true);
		expect(result).toContain(' middle ');
	});

	it('is idempotent — redacting an already-redacted string does nothing', () => {
		const text = 'hello 5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe world';
		const once = redactPrivateKeys(text);
		const twice = redactPrivateKeys(once);
		expect(twice).toBe(once);
	});
});
