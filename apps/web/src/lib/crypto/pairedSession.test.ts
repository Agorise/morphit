// @vitest-environment jsdom
/**
 * pairedSession.test.ts — unit tests for the paired-readonly session
 * persistence module (ADR-0022 QR-pair, Option A).
 *
 * Coverage:
 *   - readPairedSession / writePairedSession / clearPairedSession
 *     round-trip and idempotency.
 *   - hasPairedSession reflects on-disk state.
 *   - Validator rejects malformed records:
 *       * Wrong version (v: 2)
 *       * Missing fields
 *       * Account names violating the Blurt regex
 *       * Chat pubkey outside length bounds
 *       * Pairing ID outside length bounds
 *       * pairedAt: negative, NaN, far-future
 *       * Non-object, non-string, etc.
 *   - Corrupt JSON in storage returns null (no throw).
 *   - safeStorage refusal (Private Mode simulation) degrades gracefully:
 *     write returns false, read returns null.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
	readPairedSession,
	writePairedSession,
	clearPairedSession,
	hasPairedSession,
	PAIRED_SESSION_STORAGE_KEY,
	type PairedSession
} from './pairedSession';

const VALID: PairedSession = {
	v: 1,
	account: 'alice',
	chatPubkey: 'STM5jZtLoV8YbxCxr4imnbWn61zMB24wwonpnVhfXRmv7j6fk3HVH',
	pairingId: 'pid-abc-123-456-789',
	pairedAt: Math.floor(Date.now() / 1000)
};

function clearStorage(): void {
	if (typeof window !== 'undefined' && window.localStorage) {
		window.localStorage.clear();
	}
}

describe('pairedSession — round trip', () => {
	beforeEach(clearStorage);

	it('read returns null when nothing is persisted', () => {
		expect(readPairedSession()).toBeNull();
		expect(hasPairedSession()).toBe(false);
	});

	it('write then read recovers an identical record', () => {
		const ok = writePairedSession(VALID);
		expect(ok).toBe(true);
		const got = readPairedSession();
		expect(got).toEqual(VALID);
		expect(hasPairedSession()).toBe(true);
	});

	it('write is idempotent — overwrites previous record', () => {
		writePairedSession(VALID);
		const updated: PairedSession = { ...VALID, account: 'bob' };
		writePairedSession(updated);
		expect(readPairedSession()).toEqual(updated);
	});

	it('clear removes the record', () => {
		writePairedSession(VALID);
		clearPairedSession();
		expect(readPairedSession()).toBeNull();
		expect(hasPairedSession()).toBe(false);
	});

	it('clear is idempotent — no-op when nothing persisted', () => {
		expect(() => clearPairedSession()).not.toThrow();
		expect(readPairedSession()).toBeNull();
	});
});

describe('pairedSession — validator rejects malformed records', () => {
	beforeEach(clearStorage);

	function writeRaw(value: unknown): void {
		// Bypass our typed API to inject raw JSON the way a hostile
		// same-origin tab might.  Tests then prove readPairedSession
		// safely returns null without throwing.
		window.localStorage.setItem(PAIRED_SESSION_STORAGE_KEY, JSON.stringify(value));
	}

	it('rejects wrong version', () => {
		writeRaw({ ...VALID, v: 2 });
		expect(readPairedSession()).toBeNull();
	});

	it('rejects missing account', () => {
		const broken = { v: 1, chatPubkey: VALID.chatPubkey, pairingId: VALID.pairingId, pairedAt: VALID.pairedAt };
		writeRaw(broken);
		expect(readPairedSession()).toBeNull();
	});

	it('rejects account starting with digit (Blurt regex violation)', () => {
		writeRaw({ ...VALID, account: '1alice' });
		expect(readPairedSession()).toBeNull();
	});

	it('rejects uppercase in account', () => {
		writeRaw({ ...VALID, account: 'Alice' });
		expect(readPairedSession()).toBeNull();
	});

	it('rejects account too long', () => {
		writeRaw({ ...VALID, account: 'a'.repeat(20) });
		expect(readPairedSession()).toBeNull();
	});

	it('rejects chatPubkey too short', () => {
		writeRaw({ ...VALID, chatPubkey: 'short' });
		expect(readPairedSession()).toBeNull();
	});

	it('rejects chatPubkey too long', () => {
		writeRaw({ ...VALID, chatPubkey: 'x'.repeat(5000) });
		expect(readPairedSession()).toBeNull();
	});

	it('rejects pairingId too short', () => {
		writeRaw({ ...VALID, pairingId: 'tiny' });
		expect(readPairedSession()).toBeNull();
	});

	it('rejects negative pairedAt', () => {
		writeRaw({ ...VALID, pairedAt: -1 });
		expect(readPairedSession()).toBeNull();
	});

	it('rejects far-future pairedAt (more than 24h ahead)', () => {
		writeRaw({ ...VALID, pairedAt: Math.floor(Date.now() / 1000) + 100 * 86400 });
		expect(readPairedSession()).toBeNull();
	});

	it('rejects NaN pairedAt', () => {
		writeRaw({ ...VALID, pairedAt: Number.NaN });
		expect(readPairedSession()).toBeNull();
	});

	it('rejects non-object record', () => {
		writeRaw('plain string');
		expect(readPairedSession()).toBeNull();
	});

	it('rejects null record', () => {
		writeRaw(null);
		expect(readPairedSession()).toBeNull();
	});

	it('rejects corrupt JSON (no throw)', () => {
		// Direct raw write, bypassing JSON.stringify, to simulate disk
		// corruption or a tab writing garbage.
		window.localStorage.setItem(PAIRED_SESSION_STORAGE_KEY, '{not valid json');
		expect(() => readPairedSession()).not.toThrow();
		expect(readPairedSession()).toBeNull();
	});
});

describe('pairedSession — storage refusal (Private Mode simulation)', () => {
	beforeEach(clearStorage);

	it('write returns false when storage refuses (Private Mode)', () => {
		// JSDOM doesn't allow direct setItem replacement on its
		// localStorage instance, so we install a fault-injecting
		// Storage that throws on writes — the way Safari Private Mode
		// or quota-exceeded would in production.  Restore the original
		// before exit so other tests aren't affected.
		const originalDesc = Object.getOwnPropertyDescriptor(window, 'localStorage');
		const refusing: Storage = {
			getItem: () => null,
			setItem: (_k: string, _v: string): void => {
				throw new DOMException('QuotaExceededError', 'QuotaExceededError');
			},
			removeItem: () => {
				/* no-op */
			},
			clear: () => {
				/* no-op */
			},
			key: () => null,
			length: 0
		};
		try {
			Object.defineProperty(window, 'localStorage', {
				configurable: true,
				value: refusing
			});
			// safeStorage caches availability after first probe.  We
			// can't easily reach in to clear that cache from a test,
			// but in production, when a write fails it invalidates the
			// cache itself (set() sets #cachedAvailable = null on
			// throw).  So the first call may report "true" if a prior
			// probe succeeded against the real storage — that means
			// safeLocal.set tries the write, catches the throw, and
			// returns false.  Either way the final boolean is false.
			const result = writePairedSession(VALID);
			expect(result).toBe(false);
		} finally {
			if (originalDesc) {
				Object.defineProperty(window, 'localStorage', originalDesc);
			}
		}
	});

	it('read returns null when storage refuses', () => {
		const originalDesc = Object.getOwnPropertyDescriptor(window, 'localStorage');
		const refusing: Storage = {
			getItem: (): string | null => {
				throw new DOMException('SecurityError', 'SecurityError');
			},
			setItem: () => {
				/* no-op */
			},
			removeItem: () => {
				/* no-op */
			},
			clear: () => {
				/* no-op */
			},
			key: () => null,
			length: 0
		};
		try {
			Object.defineProperty(window, 'localStorage', {
				configurable: true,
				value: refusing
			});
			expect(readPairedSession()).toBeNull();
		} finally {
			if (originalDesc) {
				Object.defineProperty(window, 'localStorage', originalDesc);
			}
		}
	});
});
