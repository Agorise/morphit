/**
 * The service worker's side of the reload stash: a key is handed out once,
 * only while fresh, and a stash opens only with its own key.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { sodium, ensureSodium } from '$crypto/sodium';
import {
	RELOAD_STASH_MAX_AGE_MS,
	ReloadStashKeys,
	openStash,
	parseStashRecord,
	sealStash
} from './reloadStash';

beforeAll(async () => {
	await ensureSodium();
});

const ID = 'ab'.repeat(16);
const key = (): Uint8Array => new Uint8Array(32).fill(7);

describe('the key holder', () => {
	it('hands a key out once', () => {
		const k = new ReloadStashKeys();
		k.put(ID, key(), 1_000);
		expect(Array.from(k.take(ID, 1_500) ?? [])).toEqual(Array.from(key()));
		expect(k.take(ID, 1_600)).toBeNull();
	});
	it('forgets a key after 30 s', () => {
		const k = new ReloadStashKeys();
		k.put(ID, key(), 1_000);
		expect(k.take(ID, 1_000 + RELOAD_STASH_MAX_AGE_MS + 1)).toBeNull();
		expect(k.size).toBe(0);
	});
	it('ignores a malformed id or key', () => {
		const k = new ReloadStashKeys();
		k.put('x', key(), 1);
		k.put(ID, new Uint8Array(16), 1);
		k.put(ID, 'not bytes', 1);
		expect(k.size).toBe(0);
	});
});

describe('sealing', () => {
	it('opens with its own key only; the record carries no plaintext', () => {
		const plain = new TextEncoder().encode('{"secret":"posting key bytes"}');
		const { record, key: k } = sealStash(sodium, plain, 5);
		const raw = JSON.stringify(record);
		expect(raw).not.toContain('posting key bytes');
		const parsed = parseStashRecord(raw)!;
		expect(new TextDecoder().decode(openStash(sodium, parsed, k)!)).toBe(
			'{"secret":"posting key bytes"}'
		);
		expect(openStash(sodium, parsed, new Uint8Array(32))).toBeNull();
	});
	it('a plaintext record of an older build does not parse', () => {
		expect(parseStashRecord(JSON.stringify({ at: 1, live: {}, envelope: {} }))).toBeNull();
	});
});
