// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mock safeLocal for the Node test environment ────────────────
//
// The real safeLocal wraps window.localStorage, which doesn't exist
// in Node. We replace it with a plain Map-backed stand-in that
// matches the same contract. This is hoisted before the import of
// the module under test via `vi.mock`.

const memStore = new Map<string, string>();
let storageAvailable = true;
let storageThrowsOnSet = false;

vi.mock('$utils/safeStorage', () => ({
	safeLocal: {
		get: (k: string) => memStore.get(k) ?? null,
		set: (k: string, v: string) => {
			if (!storageAvailable) return false;
			if (storageThrowsOnSet) return false;
			memStore.set(k, v);
			return true;
		},
		remove: (k: string) => {
			memStore.delete(k);
			return true;
		},
		available: () => storageAvailable
	}
}));

// Import AFTER the mock is set up.
import {
	saveDraft,
	loadDraft,
	loadDraftWithMeta,
	clearDraft,
	clearDraftsMatching,
	draftsAvailable,
	redactValue
} from './index';

beforeEach(() => {
	memStore.clear();
	storageAvailable = true;
	storageThrowsOnSet = false;
});

// ─── redactValue (exported helper) ───────────────────────────────

describe('redactValue — structural private-key redaction', () => {
	const FAKE_WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';
	const TRUNCATED_WIF = '5KQwrP…vFDe';

	it('redacts a top-level string', () => {
		expect(redactValue(`key: ${FAKE_WIF}`)).toBe(`key: ${TRUNCATED_WIF}`);
	});

	it('redacts strings nested in an object', () => {
		const input = { terms: `leak: ${FAKE_WIF}`, region: 'SF' };
		const out = redactValue(input);
		expect(out.terms).toBe(`leak: ${TRUNCATED_WIF}`);
		expect(out.region).toBe('SF');
	});

	it('redacts strings nested in an array', () => {
		const input = ['Zelle', `PayPal ${FAKE_WIF}`, 'CashApp'];
		const out = redactValue(input);
		expect(out).toEqual(['Zelle', `PayPal ${TRUNCATED_WIF}`, 'CashApp']);
	});

	it('redacts strings nested in arrays within objects', () => {
		const input = {
			paymentMethods: ['Zelle', `Wise ${FAKE_WIF}`],
			terms: 'meet at cafe'
		};
		const out = redactValue(input);
		expect(out.paymentMethods[1]).toBe(`Wise ${TRUNCATED_WIF}`);
		expect(out.paymentMethods[0]).toBe('Zelle');
		expect(out.terms).toBe('meet at cafe');
	});

	it('passes numbers, booleans, null, undefined through unchanged', () => {
		expect(redactValue(42)).toBe(42);
		expect(redactValue(true)).toBe(true);
		expect(redactValue(null)).toBeNull();
		expect(redactValue(undefined)).toBeUndefined();
	});

	it('handles deeply nested structure', () => {
		const input = {
			level1: {
				level2: {
					payload: `nested key: ${FAKE_WIF}`
				}
			}
		};
		const out = redactValue(input);
		expect(out.level1.level2.payload).toBe(`nested key: ${TRUNCATED_WIF}`);
	});

	it('returns a NEW object (does not mutate the input)', () => {
		const input = { terms: `leak: ${FAKE_WIF}` };
		const out = redactValue(input);
		expect(input.terms).toBe(`leak: ${FAKE_WIF}`); // original unchanged
		expect(out.terms).not.toBe(input.terms);
	});
});

// ─── Round-trip save/load ────────────────────────────────────────

describe('saveDraft + loadDraft — round trip', () => {
	it('returns exactly the saved value for a simple object', () => {
		const draft = { side: 'buy', asset: 'BTC', amount: 100 };
		expect(saveDraft('post.test', draft)).toBe(true);
		const loaded = loadDraft<typeof draft>('post.test');
		expect(loaded).toEqual(draft);
	});

	it('returns null for a key that was never saved', () => {
		expect(loadDraft('nothing-here')).toBeNull();
	});

	it('preserves nested arrays and objects', () => {
		const draft = {
			paymentMethods: ['Zelle', 'CashApp'],
			priceModel: { kind: 'spread', percent: 1 }
		};
		expect(saveDraft('post.nested', draft)).toBe(true);
		expect(loadDraft('post.nested')).toEqual(draft);
	});

	it('preserves null and empty values', () => {
		const draft = { terms: null, region: '', amountMax: null };
		expect(saveDraft('post.nulls', draft)).toBe(true);
		expect(loadDraft('post.nulls')).toEqual(draft);
	});
});

// ─── Redaction on save ───────────────────────────────────────────

describe('saveDraft — redaction at the storage boundary', () => {
	const FAKE_WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';

	it('redacts a WIF in a top-level string field', () => {
		saveDraft('post.red1', { terms: `key: ${FAKE_WIF}` });
		const loaded = loadDraft<{ terms: string }>('post.red1');
		expect(loaded).not.toBeNull();
		expect(loaded!.terms).not.toContain(FAKE_WIF);
		expect(loaded!.terms).toContain('5KQwrP…vFDe');
	});

	it('redacts a WIF in an array element (payment method chips)', () => {
		saveDraft('post.red2', {
			paymentMethods: ['Zelle', `PayPal ${FAKE_WIF}`]
		});
		const loaded = loadDraft<{ paymentMethods: string[] }>('post.red2');
		expect(loaded!.paymentMethods[1]).not.toContain(FAKE_WIF);
		expect(loaded!.paymentMethods[0]).toBe('Zelle');
	});

	it('guarantees the raw storage blob does NOT contain the key', () => {
		// Even if someone read the backing storage directly (e.g.
		// via DevTools), the key should not be recoverable.
		saveDraft('post.red3', { terms: `secret: ${FAKE_WIF}` });
		const raw = memStore.get('morphit.draft.post.red3');
		expect(raw).toBeDefined();
		expect(raw!).not.toContain(FAKE_WIF);
	});
});

// ─── TTL expiry ──────────────────────────────────────────────────

describe('loadDraft — TTL expiry', () => {
	it('returns null for an expired draft AND clears the slot', () => {
		// Save with a very short TTL.
		saveDraft('post.ttl1', { x: 1 }, 10); // 10 ms
		// Fast-forward.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 1000);
		try {
			expect(loadDraft('post.ttl1')).toBeNull();
			// Slot should be cleared so a subsequent write doesn't
			// carry the expired value forward.
			expect(memStore.has('morphit.draft.post.ttl1')).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('still returns the draft just before TTL expires', () => {
		const ttl = 60 * 1000; // 60 s
		saveDraft('post.ttl2', { x: 2 }, ttl);
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + ttl - 1000); // 59 s later
		try {
			expect(loadDraft('post.ttl2')).toEqual({ x: 2 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('uses the default TTL when none is specified', () => {
		saveDraft('post.ttl3', { x: 3 });
		// Default is 14 days — should still be valid after 13 days.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 13 * 24 * 60 * 60 * 1000);
		try {
			expect(loadDraft('post.ttl3')).toEqual({ x: 3 });
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── Corrupt + wrong-version payloads ───────────────────────────

describe('loadDraft — robustness', () => {
	it('returns null and clears the slot on corrupt JSON', () => {
		memStore.set('morphit.draft.bogus1', 'not-json{');
		expect(loadDraft('bogus1')).toBeNull();
		expect(memStore.has('morphit.draft.bogus1')).toBe(false);
	});

	it('returns null and clears the slot on wrong-version envelope', () => {
		memStore.set(
			'morphit.draft.oldver',
			JSON.stringify({ v: 999, exp: Date.now() + 10000, value: { x: 1 } })
		);
		expect(loadDraft('oldver')).toBeNull();
		expect(memStore.has('morphit.draft.oldver')).toBe(false);
	});

	it('returns null for an envelope missing required fields', () => {
		memStore.set('morphit.draft.partial', JSON.stringify({ foo: 'bar' }));
		expect(loadDraft('partial')).toBeNull();
		expect(memStore.has('morphit.draft.partial')).toBe(false);
	});

	it('returns null for an envelope with non-numeric exp', () => {
		memStore.set(
			'morphit.draft.badexp',
			JSON.stringify({ v: 1, exp: 'yesterday', value: { x: 1 } })
		);
		expect(loadDraft('badexp')).toBeNull();
	});
});

// ─── clearDraft ──────────────────────────────────────────────────

describe('clearDraft', () => {
	it('removes a saved draft', () => {
		saveDraft('to-clear', { x: 1 });
		expect(loadDraft('to-clear')).toEqual({ x: 1 });
		clearDraft('to-clear');
		expect(loadDraft('to-clear')).toBeNull();
	});

	it('is a no-op on a key with no saved draft', () => {
		// Should not throw; silently succeeds.
		expect(() => clearDraft('never-saved')).not.toThrow();
	});
});

// ─── Storage unavailable ────────────────────────────────────────

describe('storage unavailable — graceful degradation', () => {
	it('saveDraft returns false when storage is unavailable', () => {
		storageAvailable = false;
		expect(saveDraft('any', { x: 1 })).toBe(false);
	});

	it('loadDraft returns null when storage is unavailable', () => {
		storageAvailable = false;
		expect(loadDraft('any')).toBeNull();
	});

	it('draftsAvailable reflects the storage state', () => {
		storageAvailable = true;
		expect(draftsAvailable()).toBe(true);
		storageAvailable = false;
		expect(draftsAvailable()).toBe(false);
	});
});

// ─── loadDraftWithMeta — for restore banners ────────────────────

describe('loadDraftWithMeta — savedAt metadata', () => {
	it('returns value + savedAt for a fresh save', () => {
		const before = Date.now();
		saveDraft('meta.fresh', { x: 1 });
		const after = Date.now();
		const result = loadDraftWithMeta<{ x: number }>('meta.fresh');
		expect(result).not.toBeNull();
		expect(result!.value).toEqual({ x: 1 });
		expect(result!.meta.savedAt).toBeGreaterThanOrEqual(before);
		expect(result!.meta.savedAt).toBeLessThanOrEqual(after);
	});

	it('returns null for a missing key', () => {
		expect(loadDraftWithMeta('not-there')).toBeNull();
	});

	it('returns null for an expired draft (same as loadDraft)', () => {
		saveDraft('meta.ttl', { x: 1 }, 10);
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 1000);
		try {
			expect(loadDraftWithMeta('meta.ttl')).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('tolerates an old-schema envelope (no savedAt field)', () => {
		// Simulate a draft saved by a previous version of the code
		// that didn't yet include savedAt. The helper should still
		// return the value and provide a fallback meta.
		memStore.set(
			'morphit.draft.meta.legacy',
			JSON.stringify({
				v: 1,
				exp: Date.now() + 60000,
				value: { x: 5 }
			})
		);
		const result = loadDraftWithMeta<{ x: number }>('meta.legacy');
		expect(result).not.toBeNull();
		expect(result!.value).toEqual({ x: 5 });
		// savedAt should be a valid timestamp (fallback to now).
		expect(typeof result!.meta.savedAt).toBe('number');
		expect(result!.meta.savedAt).toBeGreaterThan(0);
	});

	it('clears the slot on corrupt JSON', () => {
		memStore.set('morphit.draft.meta.corrupt', 'not-json{');
		expect(loadDraftWithMeta('meta.corrupt')).toBeNull();
		expect(memStore.has('morphit.draft.meta.corrupt')).toBe(false);
	});
});

// ─── savedAt is written by saveDraft ────────────────────────────

describe('saveDraft — envelope shape', () => {
	it('includes a savedAt timestamp in the raw envelope', () => {
		const before = Date.now();
		saveDraft('env.shape', { x: 1 });
		const after = Date.now();
		const raw = memStore.get('morphit.draft.env.shape');
		expect(raw).toBeDefined();
		const env = JSON.parse(raw!);
		expect(env.v).toBe(1);
		expect(typeof env.savedAt).toBe('number');
		expect(env.savedAt).toBeGreaterThanOrEqual(before);
		expect(env.savedAt).toBeLessThanOrEqual(after);
		expect(env.exp).toBeGreaterThan(env.savedAt);
	});
});

// ─── clearDraftsMatching ───────────────────────────────────────
//
// clearDraftsMatching reaches through to window.localStorage
// directly for the key iterator — that API isn't exposed by
// safeLocal. To test it we stub window.localStorage with a Map-
// backed iterator that mirrors the shape it expects (length,
// key(i), removeItem).

describe('clearDraftsMatching — prefix enumeration', () => {
	let originalWindow: unknown;

	beforeEach(() => {
		originalWindow = (globalThis as { window?: unknown }).window;
		const ls = {
			get length() {
				return memStore.size;
			},
			key(i: number): string | null {
				const keys = Array.from(memStore.keys());
				return keys[i] ?? null;
			},
			getItem(k: string): string | null {
				return memStore.get(k) ?? null;
			},
			setItem(k: string, v: string): void {
				memStore.set(k, v);
			},
			removeItem(k: string): void {
				memStore.delete(k);
			},
			clear(): void {
				memStore.clear();
			}
		};
		(globalThis as { window?: unknown }).window = { localStorage: ls };
	});

	afterEach(() => {
		(globalThis as { window?: unknown }).window = originalWindow;
	});

	it('clears every draft under the given prefix', () => {
		saveDraft('feedback.orderA', { rating: 5 });
		saveDraft('feedback.orderB', { rating: 4 });
		saveDraft('feedback.orderC', { rating: 3 });
		const removed = clearDraftsMatching('feedback');
		expect(removed).toBe(3);
		expect(loadDraft('feedback.orderA')).toBeNull();
		expect(loadDraft('feedback.orderB')).toBeNull();
		expect(loadDraft('feedback.orderC')).toBeNull();
	});

	it('does NOT clear drafts in a sibling namespace (trailing-dot boundary)', () => {
		// Critical correctness property: clearing 'feedback' must not
		// touch 'feedback_response' entries, or the user's in-progress
		// feedback replies vanish unexpectedly.
		saveDraft('feedback.orderA', { rating: 5 });
		saveDraft('feedback_response.trx_1', { comment: 'thanks' });
		saveDraft('feedback_response.trx_2', { comment: 'great' });
		const removed = clearDraftsMatching('feedback');
		expect(removed).toBe(1);
		expect(loadDraft('feedback.orderA')).toBeNull();
		expect(loadDraft('feedback_response.trx_1')).toEqual({ comment: 'thanks' });
		expect(loadDraft('feedback_response.trx_2')).toEqual({ comment: 'great' });
	});

	it('leaves non-draft localStorage keys alone', () => {
		// Keys outside morphit.draft.* are sacred — e.g. keystore,
		// account name, endpoint list. clearDraftsMatching must never
		// touch them.
		memStore.set('morphit.blurtAccount', 'alice');
		memStore.set('morphit.rpcEndpoints', 'some-endpoints-blob');
		memStore.set('some_other_key', 'unrelated');
		saveDraft('feedback.orderA', { rating: 5 });

		const removed = clearDraftsMatching('feedback');
		expect(removed).toBe(1);
		expect(memStore.get('morphit.blurtAccount')).toBe('alice');
		expect(memStore.get('morphit.rpcEndpoints')).toBe('some-endpoints-blob');
		expect(memStore.get('some_other_key')).toBe('unrelated');
	});

	it('returns 0 and no-ops when no drafts match', () => {
		saveDraft('post.compose', { title: 'hello' });
		const removed = clearDraftsMatching('feedback');
		expect(removed).toBe(0);
		// The unrelated draft is untouched.
		expect(loadDraft('post.compose')).toEqual({ title: 'hello' });
	});

	it('returns 0 when storage is unavailable', () => {
		storageAvailable = false;
		const removed = clearDraftsMatching('feedback');
		expect(removed).toBe(0);
	});
});
