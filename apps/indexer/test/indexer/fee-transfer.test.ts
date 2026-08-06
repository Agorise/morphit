import { describe, expect, it } from 'vitest';

import { parseBlurtAmount, parseMemoPermlink } from '$indexer/fee-transfer';

describe('parseBlurtAmount', () => {
	it('parses standard 3-decimal amounts', () => {
		expect(parseBlurtAmount('62.500 BLURT')).toBe(62.5);
		expect(parseBlurtAmount('1000.000 BLURT')).toBe(1000);
		expect(parseBlurtAmount('0.001 BLURT')).toBe(0.001);
	});

	it('parses integer amounts without decimals', () => {
		// Graphene usually formats with 3 decimals, but the regex
		// accepts integer forms too. Defensive parsing — if a client
		// sends "63 BLURT" instead of "63.000 BLURT", we still credit it.
		expect(parseBlurtAmount('63 BLURT')).toBe(63);
	});

	it('returns null on malformed input', () => {
		expect(parseBlurtAmount('')).toBeNull();
		expect(parseBlurtAmount('62.500')).toBeNull(); // no asset suffix
		expect(parseBlurtAmount('62.500 STEEM')).toBeNull(); // wrong asset
		expect(parseBlurtAmount('abc BLURT')).toBeNull();
		expect(parseBlurtAmount('-62.500 BLURT')).toBeNull(); // no negatives
		expect(parseBlurtAmount('62.500BLURT')).toBeNull(); // missing space
		expect(parseBlurtAmount(' 62.500 BLURT')).toBeNull(); // leading space
		expect(parseBlurtAmount('62.500 BLURT ')).toBeNull(); // trailing space
	});

	it('returns null on non-string input', () => {
		expect(parseBlurtAmount(62.5)).toBeNull();
		expect(parseBlurtAmount(null)).toBeNull();
		expect(parseBlurtAmount(undefined)).toBeNull();
		expect(parseBlurtAmount({ amount: '62.500 BLURT' })).toBeNull();
	});

	it('handles very large amounts without precision loss in the regex', () => {
		// JavaScript numbers lose int precision above 2^53, but regex
		// matches don't care; Number() handles up to 1.7e308. A whale
		// paying 1 million BLURT in fees is still a valid parse.
		expect(parseBlurtAmount('1000000.000 BLURT')).toBe(1_000_000);
	});
});

describe('parseMemoPermlink', () => {
	it('extracts permlink from well-formed memo', () => {
		expect(parseMemoPermlink('morphit-fee:sell-btc-usd-abc123')).toBe('sell-btc-usd-abc123');
		expect(parseMemoPermlink('morphit-fee:a')).toBe('a');
	});

	it('returns null on non-matching prefix', () => {
		expect(parseMemoPermlink('fee:sell-btc')).toBeNull();
		expect(parseMemoPermlink('Morphit-fee:foo')).toBeNull(); // wrong case
		expect(parseMemoPermlink('morphit-fees:foo')).toBeNull(); // extra s
	});

	it('returns null on empty or missing permlink', () => {
		expect(parseMemoPermlink('morphit-fee:')).toBeNull();
		expect(parseMemoPermlink('morphit-fee')).toBeNull();
	});

	it('rejects permlinks with invalid charset', () => {
		// Uppercase not allowed in permlinks.
		expect(parseMemoPermlink('morphit-fee:SELL-BTC')).toBeNull();
		// Underscores not in the permlink charset.
		expect(parseMemoPermlink('morphit-fee:sell_btc')).toBeNull();
		// Double dashes not allowed.
		expect(parseMemoPermlink('morphit-fee:sell--btc')).toBeNull();
		// Leading/trailing dashes not allowed.
		expect(parseMemoPermlink('morphit-fee:-sell-btc')).toBeNull();
		expect(parseMemoPermlink('morphit-fee:sell-btc-')).toBeNull();
	});

	it('returns null on non-string input', () => {
		expect(parseMemoPermlink(null)).toBeNull();
		expect(parseMemoPermlink(undefined)).toBeNull();
		expect(parseMemoPermlink(42)).toBeNull();
	});

	it('returns null on extra content after the permlink', () => {
		// Must match the full string — a prefix that starts right
		// but has junk after is NOT a valid morphit fee memo.
		expect(parseMemoPermlink('morphit-fee:sell-btc extra')).toBeNull();
		expect(parseMemoPermlink('morphit-fee:sell-btc\n')).toBeNull();
	});
});
