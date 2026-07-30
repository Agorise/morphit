#!/usr/bin/env tsx
/**
 * paired-readonly-lifecycle-smoke (ADR-0022 QR-pair, Option A, Part 114).
 *
 * Validates the persisted paired-readonly session lifecycle outside
 * the Svelte runtime:
 *
 *   - Validator accepts known-good records
 *   - Validator rejects every documented malformed shape
 *   - Round-trip: write → read → identical
 *   - Idempotent overwrite
 *   - Clear → null read
 *   - hasPairedSession matches read non-null
 *
 * The vitest suite at src/lib/crypto/pairedSession.test.ts covers
 * the same surface; this smoke gives us a smoke-pulse harness
 * checkpoint that fits the existing run-smokes.sh pipeline (same
 * place desktop-pairing-crypto-smoke and login-pairing-registry-
 * smoke sit) so paired-readonly persistence is part of every
 * pre-release pulse run.
 *
 * Importantly, the smoke runs under tsx in node — no jsdom, no
 * SvelteKit.  We provide a minimal in-process localStorage shim
 * so the safeStorage layer believes it's in a browser; the rest
 * is pure data validation.
 */

// Minimal in-process localStorage shim.  Installed BEFORE the
// imports below so safeStorage.available() picks it up on first
// probe.  We can't import the real safeStorage and patch it after
// because availability is cached on first call.
const shimStore = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
	getItem(k: string): string | null {
		return shimStore.get(k) ?? null;
	},
	setItem(k: string, v: string): void {
		shimStore.set(k, v);
	},
	removeItem(k: string): void {
		shimStore.delete(k);
	},
	clear(): void {
		shimStore.clear();
	},
	key(i: number): string | null {
		const keys = Array.from(shimStore.keys());
		return keys[i] ?? null;
	},
	get length(): number {
		return shimStore.size;
	}
} as unknown as Storage;

// The safeStorage module checks for the `window` global.  Build
// one out of the shim so its `getRaw()` accepts it.
(globalThis as { window?: typeof globalThis }).window = globalThis as typeof globalThis;

import {
	readPairedSession,
	writePairedSession,
	clearPairedSession,
	hasPairedSession,
	PAIRED_SESSION_STORAGE_KEY,
	type PairedSession
} from '../src/lib/crypto/pairedSession.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function expect(actual: unknown, expected: unknown, label = ''): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label ? label + ': ' : ''}expected ${e}, got ${a}`);
	}
}

function clearAll(): void {
	shimStore.clear();
}

const VALID: PairedSession = {
	v: 1,
	account: 'alice',
	chatPubkey: 'STM5jZtLoV8YbxCxr4imnbWn61zMB24wwonpnVhfXRmv7j6fk3HVH',
	pairingId: 'pid-lifecycle-smoke-12345',
	pairedAt: Math.floor(Date.now() / 1000)
};

console.log('paired-readonly-lifecycle-smoke:');

scenario('initial state — read returns null, hasPairedSession false', () => {
	clearAll();
	expect(readPairedSession(), null);
	expect(hasPairedSession(), false);
});

scenario('write then read recovers identical record', () => {
	clearAll();
	const ok = writePairedSession(VALID);
	expect(ok, true);
	expect(readPairedSession(), VALID);
	expect(hasPairedSession(), true);
});

scenario('write idempotent — overwrites previous record', () => {
	clearAll();
	writePairedSession(VALID);
	const updated: PairedSession = { ...VALID, account: 'bob' };
	writePairedSession(updated);
	expect(readPairedSession(), updated);
});

scenario('clear removes record (idempotent)', () => {
	clearAll();
	writePairedSession(VALID);
	clearPairedSession();
	expect(readPairedSession(), null);
	expect(hasPairedSession(), false);
	// Idempotent re-clear.
	clearPairedSession();
	expect(readPairedSession(), null);
});

scenario('validator rejects wrong version', () => {
	clearAll();
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, JSON.stringify({ ...VALID, v: 2 }));
	expect(readPairedSession(), null);
});

scenario('validator rejects account starting with digit', () => {
	clearAll();
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, JSON.stringify({ ...VALID, account: '1alice' }));
	expect(readPairedSession(), null);
});

scenario('validator rejects uppercase in account', () => {
	clearAll();
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, JSON.stringify({ ...VALID, account: 'Alice' }));
	expect(readPairedSession(), null);
});

scenario('validator rejects account too long', () => {
	clearAll();
	shimStore.set(
		PAIRED_SESSION_STORAGE_KEY,
		JSON.stringify({ ...VALID, account: 'a'.repeat(20) })
	);
	expect(readPairedSession(), null);
});

scenario('validator rejects chatPubkey too short', () => {
	clearAll();
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, JSON.stringify({ ...VALID, chatPubkey: 'short' }));
	expect(readPairedSession(), null);
});

scenario('validator rejects chatPubkey too long (DoS guard)', () => {
	clearAll();
	shimStore.set(
		PAIRED_SESSION_STORAGE_KEY,
		JSON.stringify({ ...VALID, chatPubkey: 'x'.repeat(5000) })
	);
	expect(readPairedSession(), null);
});

scenario('validator rejects pairingId too short', () => {
	clearAll();
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, JSON.stringify({ ...VALID, pairingId: 'tiny' }));
	expect(readPairedSession(), null);
});

scenario('validator rejects negative pairedAt', () => {
	clearAll();
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, JSON.stringify({ ...VALID, pairedAt: -1 }));
	expect(readPairedSession(), null);
});

scenario('validator rejects far-future pairedAt', () => {
	clearAll();
	const farFuture = Math.floor(Date.now() / 1000) + 100 * 86400;
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, JSON.stringify({ ...VALID, pairedAt: farFuture }));
	expect(readPairedSession(), null);
});

scenario('validator rejects NaN pairedAt', () => {
	clearAll();
	// JSON.stringify({pairedAt: NaN}) produces "null" for the value,
	// which the validator catches via typeof check.
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, '{"v":1,"account":"alice","chatPubkey":"STM5jZtLoV8YbxCxr4imnbWn61zMB24wwonpnVhfXRmv7j6fk3HVH","pairingId":"pid-12345678","pairedAt":null}');
	expect(readPairedSession(), null);
});

scenario('validator rejects non-object record (string)', () => {
	clearAll();
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, JSON.stringify('plain string'));
	expect(readPairedSession(), null);
});

scenario('validator rejects null record', () => {
	clearAll();
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, 'null');
	expect(readPairedSession(), null);
});

scenario('validator rejects corrupt JSON without throwing', () => {
	clearAll();
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, '{not valid json');
	let threw = false;
	let result: unknown = 'sentinel';
	try {
		result = readPairedSession();
	} catch {
		threw = true;
	}
	expect(threw, false);
	expect(result, null);
});

scenario('validator rejects missing required fields', () => {
	clearAll();
	const missing = { v: 1, account: 'alice' };
	shimStore.set(PAIRED_SESSION_STORAGE_KEY, JSON.stringify(missing));
	expect(readPairedSession(), null);
});

console.log('');
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
