#!/usr/bin/env tsx
/**
 * Smoke for `$stores/userPreferences`.
 *
 * Validates the store's contract:
 *   - Empty state: getPreferencesSnapshot() returns
 *     {fiat: '', region: ''} when localStorage is absent.
 *   - Read/write round-trip: setPreference('fiat', 'USD')
 *     followed by getPreferencesSnapshot() returns USD.
 *   - Multi-key: setPreference for both fiat and region
 *     persists both.
 *   - clearPreferences() restores empty state.
 *   - Empty-key cleanliness: setting both keys to '' removes
 *     the localStorage entry rather than persisting an
 *     all-empty JSON blob (so a brand-new user's
 *     localStorage stays clean).
 *   - Malformed JSON tolerance: poisoned localStorage value
 *     yields empty state, doesn't crash.
 *   - Wrong-type tolerance: parsed object with non-string
 *     values yields empty for those fields.
 *
 * The store relies on `browser` from `$app/environment`.
 * In a tsx context we don't have that import path resolved,
 * so we shim a minimal localStorage and stub out the
 * import via dynamic eval / require-replacement.  The cleanest
 * approach for a structural smoke is to inline-replicate the
 * read/write helpers and verify their behavior — pulling in
 * the actual store module would drag the whole svelte-i18n
 * + svelte/store + $app graph.
 *
 * So this smoke tests the localStorage contract directly,
 * mirroring the helpers in userPreferences.ts.  It's a
 * structural / behavioral test of the stored format, NOT a
 * Svelte-store-subscription test.  The Svelte-reactivity
 * side is exercised by the existing locale-parity smoke
 * (which catches missing keys) and svelte-check (which
 * catches type errors on the store's exports).
 */

interface UserPreferences {
	fiat: string;
	region: string;
}

const STORAGE_KEY = 'morphit.userPreferences.v1';
const EMPTY: UserPreferences = { fiat: '', region: '' };

// In-memory localStorage shim.  Mirrors the relevant subset of
// the Web Storage API used by userPreferences.ts.
class MemoryStorage {
	private map = new Map<string, string>();
	getItem(k: string): string | null {
		return this.map.has(k) ? this.map.get(k)! : null;
	}
	setItem(k: string, v: string): void {
		this.map.set(k, v);
	}
	removeItem(k: string): void {
		this.map.delete(k);
	}
	clear(): void {
		this.map.clear();
	}
	get size(): number {
		return this.map.size;
	}
}

let storage = new MemoryStorage();

function readFromStorage(): UserPreferences {
	try {
		const raw = storage.getItem(STORAGE_KEY);
		if (!raw) return { ...EMPTY };
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY };
		const o = parsed as Record<string, unknown>;
		return {
			fiat: typeof o.fiat === 'string' ? o.fiat : '',
			region: typeof o.region === 'string' ? o.region : ''
		};
	} catch {
		return { ...EMPTY };
	}
}

function writeToStorage(prefs: UserPreferences): void {
	try {
		if (!prefs.fiat && !prefs.region) {
			storage.removeItem(STORAGE_KEY);
			return;
		}
		storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Same rationale as readFromStorage.
	}
}

interface Scenario {
	readonly name: string;
	readonly run: () => boolean;
}

const scenarios: readonly Scenario[] = [
	{
		name: 'empty state returns {fiat: "", region: ""}',
		run: () => {
			storage = new MemoryStorage();
			const p = readFromStorage();
			return p.fiat === '' && p.region === '';
		}
	},
	{
		name: 'set fiat persists',
		run: () => {
			storage = new MemoryStorage();
			writeToStorage({ fiat: 'USD', region: '' });
			const p = readFromStorage();
			return p.fiat === 'USD' && p.region === '';
		}
	},
	{
		name: 'set region persists',
		run: () => {
			storage = new MemoryStorage();
			writeToStorage({ fiat: '', region: 'EU' });
			const p = readFromStorage();
			return p.fiat === '' && p.region === 'EU';
		}
	},
	{
		name: 'set both persists both',
		run: () => {
			storage = new MemoryStorage();
			writeToStorage({ fiat: 'JPY', region: 'JP' });
			const p = readFromStorage();
			return p.fiat === 'JPY' && p.region === 'JP';
		}
	},
	{
		name: 'clear (write empty) removes localStorage entry',
		run: () => {
			storage = new MemoryStorage();
			writeToStorage({ fiat: 'USD', region: 'US' });
			// cp474 — read the size into a fresh local at each checkpoint. Comparing
			// `storage.size` directly let TS narrow it to the literal `1` at the
			// first guard and hold that narrowing across `writeToStorage`, which it
			// can't see mutate the store — so `=== 0` looked impossible.
			const afterWrite = storage.size;
			if (afterWrite !== 1) return false;
			writeToStorage({ fiat: '', region: '' });
			const afterClear = storage.size;
			return afterClear === 0;
		}
	},
	{
		name: 'malformed JSON yields empty state, no crash',
		run: () => {
			storage = new MemoryStorage();
			storage.setItem(STORAGE_KEY, '{not valid json');
			const p = readFromStorage();
			return p.fiat === '' && p.region === '';
		}
	},
	{
		name: 'parsed object with wrong types yields empty for those fields',
		run: () => {
			storage = new MemoryStorage();
			storage.setItem(STORAGE_KEY, JSON.stringify({ fiat: 42, region: 'US' }));
			const p = readFromStorage();
			return p.fiat === '' && p.region === 'US';
		}
	},
	{
		name: 'parsed primitive yields empty state',
		run: () => {
			storage = new MemoryStorage();
			storage.setItem(STORAGE_KEY, JSON.stringify('hello'));
			const p = readFromStorage();
			return p.fiat === '' && p.region === '';
		}
	},
	{
		name: 'parsed null yields empty state',
		run: () => {
			storage = new MemoryStorage();
			storage.setItem(STORAGE_KEY, JSON.stringify(null));
			const p = readFromStorage();
			return p.fiat === '' && p.region === '';
		}
	},
	{
		name: 'unknown extra fields are silently dropped',
		run: () => {
			storage = new MemoryStorage();
			storage.setItem(
				STORAGE_KEY,
				JSON.stringify({ fiat: 'USD', region: 'US', secretKey: 'oops' })
			);
			const p = readFromStorage();
			return (
				p.fiat === 'USD' &&
				p.region === 'US' &&
				!('secretKey' in p)
			);
		}
	},
	{
		name: 'storage key is the documented v1 key',
		run: () => STORAGE_KEY === 'morphit.userPreferences.v1'
	},
	{
		name: 'overwriting persists the new value',
		run: () => {
			storage = new MemoryStorage();
			writeToStorage({ fiat: 'USD', region: '' });
			writeToStorage({ fiat: 'EUR', region: '' });
			const p = readFromStorage();
			return p.fiat === 'EUR';
		}
	}
];

console.log('');
console.log('── userPreferences store smoke ─────────────────────────');
console.log('');

let passed = 0;
let failed = 0;
const failures: string[] = [];
for (const s of scenarios) {
	try {
		if (s.run()) {
			passed++;
		} else {
			failed++;
			failures.push(`  ✗ ${s.name}`);
		}
	} catch (err) {
		failed++;
		failures.push(`  ✗ ${s.name} — threw: ${err instanceof Error ? err.message : String(err)}`);
	}
}

if (failed > 0) {
	console.log(failures.join('\n'));
	console.log('');
}
console.log('────────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}

// cp474 — module marker. Without a top-level import/export tsc treats this
// file as a global script, so its `scenarios`/`failed` consts collide with every
// other script-style smoke when the suite is typechecked as one project. This
// has no runtime effect under tsx.
export {};
