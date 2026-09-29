/**
 * v1.20.0 (V3-11) — the pure rule every node applies to text Postgres cannot
 * store. Deterministic, identity-preserving on clean input, and exact about
 * what counts as broken (a PAIRED surrogate is a real character).
 */
import { describe, expect, it } from 'vitest';
import {
	isPgSafeText,
	pgSafeBlock,
	pgSafeDeep,
	pgSafeParams,
	pgSafeText
} from '../../src/db/pgText';
import { contactUrlOrNull, textOrNull } from '../../src/indexer/instanceCacheSanitize';

describe('pgSafeText', () => {
	it('replaces NUL and unpaired surrogates with U+FFFD, and nothing else', () => {
		expect(pgSafeText('a\u0000b')).toBe('a\uFFFDb');
		expect(pgSafeText('\uD800x')).toBe('\uFFFDx');
		expect(pgSafeText('x\uDC00')).toBe('x\uFFFD');
		expect(pgSafeText('\uDC00\uD800')).toBe('\uFFFD\uFFFD'); // reversed pair = two strays
		expect(pgSafeText('😀')).toBe('😀');
		expect(pgSafeText('\u0001 é \\u0000')).toBe('\u0001 é \\u0000');
		expect(isPgSafeText('😀')).toBe(true);
		expect(isPgSafeText('\uD83D')).toBe(false);
	});
	it('returns the same string when clean', () => {
		const s = 'plain';
		expect(pgSafeText(s)).toBe(s);
	});
});

describe('pgSafeDeep', () => {
	it('returns the same reference when nothing needs changing', () => {
		const v = { a: ['x', { b: 1, c: null }], d: true };
		expect(pgSafeDeep(v)).toBe(v);
	});
	it('rewrites values and keys, keeps order, and never touches the input', () => {
		const v = JSON.parse('{"k\\u0000":["ok","\\ud800"],"n":1}') as Record<string, unknown>;
		const out = pgSafeDeep(v);
		expect(out).not.toBe(v);
		expect(Object.keys(out)).toEqual(['k\uFFFD', 'n']);
		expect(out).toEqual({ 'k\uFFFD': ['ok', '\uFFFD'], n: 1 });
		expect(Object.keys(v)[0]).toBe('k\u0000');
	});
	it('keeps a __proto__ key an own property, never the prototype', () => {
		const v = JSON.parse('{"__proto__":{"x":"\\u0000"}}') as Record<string, unknown>;
		const out = pgSafeDeep(v) as Record<string, unknown>;
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
	});
	it('is deterministic: the same input gives byte-identical output', () => {
		const raw = '{"a\\u0000":1,"a\\ufffd":2,"z":["\\udc00","\\u0000"]}';
		expect(JSON.stringify(pgSafeDeep(JSON.parse(raw)))).toBe(
			JSON.stringify(pgSafeDeep(JSON.parse(raw)))
		);
	});
});

describe('pgSafeBlock', () => {
	it('is the same object for a normal block, and a copy (input untouched) otherwise', () => {
		const clean = {
			timestamp: 't',
			transaction_ids: ['a'],
			transactions: [{ operations: [['transfer', { memo: 'm' }]] }]
		};
		expect(pgSafeBlock(clean)).toBe(clean);
		const dirty = {
			timestamp: 't',
			transaction_ids: ['a'],
			transactions: [{ operations: [['transfer', { memo: 'm\u0000' }]] }]
		};
		const out = pgSafeBlock(dirty);
		expect(out).not.toBe(dirty);
		expect(
			(out.transactions[0] as { operations: [string, { memo: string }][] }).operations[0]![1].memo
		).toBe('m\uFFFD');
		expect(dirty.transactions[0]!.operations[0]![1]).toEqual({ memo: 'm\u0000' });
		expect(out.transaction_ids).toBe(dirty.transaction_ids);
	});
});

describe('pgSafeParams', () => {
	it('fixes only what Postgres would refuse', () => {
		const p = [1, 'ok', null, new Date(0)];
		expect(pgSafeParams('SELECT $1, $2, $3, $4', p)).toBe(p);
		expect(pgSafeParams('INSERT … VALUES ($1)', ['a\u0000'])).toEqual(['a\uFFFD']);
		// A JSON escape in a TEXT parameter is ordinary text: untouched.
		expect(pgSafeParams('INSERT … VALUES ($1)', ['{"a":"\\u0000"}'])).toEqual(['{"a":"\\u0000"}']);
		// The same string bound to ::jsonb is re-serialised.
		expect(pgSafeParams('INSERT … VALUES ($1::jsonb)', ['{"a":"\\u0000"}'])).toEqual([
			'{"a":"\uFFFD"}'
		]);
		// Not JSON: left for Postgres to refuse, exactly as before.
		expect(pgSafeParams('VALUES ($1::jsonb)', ['{\\u0000'])).toEqual(['{\\u0000']);
	});
});

describe('peer directory fields (instanceCacheSanitize)', () => {
	it('a name or contact link holding NUL / an unpaired surrogate is dropped', () => {
		expect(textOrNull('Morphit\u0000NL', 64)).toBeNull();
		expect(textOrNull('Morphit \uD800', 64)).toBeNull();
		expect(textOrNull('Morphit 😀', 64)).toBe('Morphit 😀');
		expect(contactUrlOrNull('mailto:a@b.c\u0000')).toBeNull();
	});
});
