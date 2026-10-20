// @vitest-environment node
/**
 * Posting-key pins (and the own-published record) across a Lock (v1.21.13): sealed with the account's posting
 * key, nothing readable left behind, restored on unlock by that account only.
 * Node environment (libsodium refuses jsdom's Uint8Array), with a small
 * in-memory stand-in for the browser's localStorage.
 */
import { beforeAll, describe, expect, it } from 'vitest';

class MemStorage {
	#m = new Map<string, string>();
	get length(): number {
		return this.#m.size;
	}
	key(i: number): string | null {
		return [...this.#m.keys()][i] ?? null;
	}
	getItem(k: string): string | null {
		return this.#m.get(k) ?? null;
	}
	setItem(k: string, v: string): void {
		this.#m.set(k, String(v));
	}
	removeItem(k: string): void {
		this.#m.delete(k);
	}
	clear(): void {
		this.#m.clear();
	}
	keys(): string[] {
		return [...this.#m.keys()];
	}
}
const store = new MemStorage();

let pin: typeof import('./pubPin');
beforeAll(async () => {
	(globalThis as unknown as { window: unknown }).window = {
		localStorage: store,
		sessionStorage: new MemStorage()
	};
	pin = await import('./pubPin');
});

const K1 = 'Aj' + 'A'.repeat(42);
const K2 = 'Az' + 'B'.repeat(42);
const K3 = 'Ax' + 'C'.repeat(42);

describe('posting-key pins across a Lock', () => {
	it('sealed on Lock (nothing readable left), restored on unlock by the same account only', async () => {
		await pin.resolvePostingKeyPin('bob', [K1]);
		await pin.resolvePostingKeyPin('cyd', [K2]);
		await pin.resolvePostingKeyPin('cyd', [K3]).catch(() => undefined); // a pending change
		pin.recordOwnPublished('anna', 'PUB');
		const mine = new Uint8Array(32).fill(7);
		const other = new Uint8Array(32).fill(8);
		await pin.sealPinsForLock(mine);
		expect(pin.pinnedPostingFor('bob')).toEqual([]);
		expect(pin.pendingPostingKeyChange('cyd')).toBeNull();
		expect(pin.ownPublishedRecord('anna')).toBeNull();
		expect(
			store
				.keys()
				.some((k) => k.startsWith('morphit.chat.posting_pin') || k === 'morphit.chat.own_published')
		).toBe(false);
		expect(await pin.unsealPins(other)).toBe(false);
		expect(pin.pinnedPostingFor('bob')).toEqual([]);
		expect(await pin.unsealPins(mine)).toBe(true);
		expect(pin.pinnedPostingFor('bob')).toEqual([K1]);
		expect(pin.pinnedPostingFor('cyd')).toEqual([K2]);
		expect(pin.pendingPostingKeyChange('cyd')).toEqual([K3]);
		expect(pin.ownPublishedRecord('anna')).toBe('PUB');
	});
});
