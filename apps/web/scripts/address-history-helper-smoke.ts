#!/usr/bin/env tsx
/**
 * address-history-helper-smoke.
 *
 * The address-reuse history behind the address-share modal's "you shared
 * this address before" warning, run end to end against an in-memory
 * localStorage. The history keeps salted HMAC tags, never the addresses,
 * and an older build's plaintext record is converted and deleted.
 * Unit coverage: src/lib/privacy/addressHistory.test.ts.
 */

// A module (top-level await below), not a global script.
export {};

// Node has no DOM: a Map-backed localStorage with the surface the module uses.
class MemStorage {
	private data = new Map<string, string>();
	getItem(k: string): string | null {
		return this.data.has(k) ? this.data.get(k)! : null;
	}
	setItem(k: string, v: string): void {
		this.data.set(k, v);
	}
	removeItem(k: string): void {
		this.data.delete(k);
	}
	clear(): void {
		this.data.clear();
	}
	get length(): number {
		return this.data.size;
	}
	key(i: number): string | null {
		return [...this.data.keys()][i] ?? null;
	}
	dump(): string {
		return [...this.data.values()].join('\n');
	}
}
const storage = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = storage;

const {
	ADDRESS_HISTORY_KEY,
	LEGACY_ADDRESS_HISTORY_KEY,
	addressHistoryCount,
	clearAddressHistory,
	recordAddressShare,
	shareAddress,
	wasSharedBefore
} = await import('../src/lib/privacy/addressHistory');

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failed++;
	}
}

console.log('\n── address-history-helper smoke ──────────────────────\n');

const BTC = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const XMR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

storage.clear();
check('empty history on first load', addressHistoryCount() === 0);
check('nothing was shared before on an empty history', !(await wasSharedBefore('BTC', BTC)));

await recordAddressShare('BTC', BTC);
check('a recorded address is recognised', await wasSharedBefore('BTC', BTC));
check('the asset is part of the identity (same string, other asset → not shared)', !(await wasSharedBefore('XMR', BTC)));
check('another address is not recognised', !(await wasSharedBefore('BTC', `${BTC}x`)));
check('storage holds no plaintext address', !storage.dump().includes(BTC), storage.dump());

await recordAddressShare('BTC', BTC);
check('recording the same address twice keeps one entry', addressHistoryCount() === 1);

for (let i = 0; i < 205; i++) await recordAddressShare('BTC', `addr-${i}`);
check('the history is bounded at 200 entries', addressHistoryCount() === 200, String(addressHistoryCount()));
check('the oldest entries are the ones dropped', !(await wasSharedBefore('BTC', BTC)) && (await wasSharedBefore('BTC', 'addr-204')));

clearAddressHistory();
check('clear forgets everything', addressHistoryCount() === 0 && storage.getItem(ADDRESS_HISTORY_KEY) === null);

// A share that fails is not a reuse: the retry must not warn.
let threw = false;
try {
	await shareAddress('XMR', XMR, async () => {
		throw new Error('network down');
	});
} catch {
	threw = true;
}
check('a failed send rethrows', threw);
check('…and the address is not remembered', !(await wasSharedBefore('XMR', XMR)));
await shareAddress('XMR', XMR, async () => {});
await new Promise((r) => setTimeout(r, 50));
check('a successful send is remembered', await wasSharedBefore('XMR', XMR));

// Older builds kept addresses, times and order ids in plaintext.
storage.clear();
storage.setItem(
	LEGACY_ADDRESS_HISTORY_KEY,
	JSON.stringify({
		entries: [{ asset: 'BTC', address: BTC, sharedAt: '2026-05-17T20:00:00Z', orderPermlink: 'o-1' }]
	})
);
check('a legacy plaintext address is still recognised', await wasSharedBefore('BTC', BTC));
check('…and the plaintext record is deleted', storage.getItem(LEGACY_ADDRESS_HISTORY_KEY) === null);
check('…with nothing readable left behind', !storage.dump().includes(BTC) && !storage.dump().includes('o-1'));

console.log('');
if (failed > 0) {
	console.error(`✗ ${failed} of ${passed + failed} address-history-helper checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${passed} address-history-helper checks passed`);
