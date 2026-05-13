import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the identity store BEFORE the module under test is
// imported, because the helper does `import { identity }` at
// the top level and captures the reference.
const mockStoreState = {
	current: { state: 'unlocked', live: {}, envelope: { data: 'fake' } } as {
		state: string;
		live: unknown;
		envelope: unknown;
	}
};

vi.mock('$stores/identity', () => ({
	identity: {
		subscribe: (fn: (v: unknown) => void) => {
			fn(mockStoreState.current);
			return () => {};
		}
	}
}));

// Mock useActiveKey so we can control what it does per-test.
const useActiveKeyMock = vi.fn();
vi.mock('$crypto/keystore', () => {
	// runWithActiveKey imports BOTH useActiveKey and KeystoreError
	// from this module — the helper does `if (err instanceof
	// KeystoreError)` to classify password errors.  The mock must
	// export a class compatible with `instanceof` so that branch
	// reachable code in the tests below.  Test cases that need to
	// surface a KeystoreError throw `new KeystoreError(kind, msg)`
	// from the useActiveKey callback.
	class KeystoreError extends Error {
		readonly kind: string;
		constructor(kind: string, message: string) {
			super(message);
			this.name = 'KeystoreError';
			this.kind = kind;
		}
	}
	return {
		useActiveKey: (env: unknown, pw: string, cb: (k: Uint8Array) => Promise<unknown>) =>
			useActiveKeyMock(env, pw, cb),
		KeystoreError
	};
});

// The module under test MUST be imported after the mocks are
// installed. A dynamic import would be cleaner, but vitest's
// hoisting of vi.mock is designed so top-level imports work
// as long as the vi.mock calls precede them at the lexical
// level within the file.
import { runWithActiveKey } from './runWithActiveKey';

describe('runWithActiveKey', () => {
	beforeEach(() => {
		useActiveKeyMock.mockReset();
		mockStoreState.current = {
			state: 'unlocked',
			live: { posting: { privateKey: new Uint8Array(32) } },
			envelope: { data: 'fake' }
		};
	});

	it('returns password_empty when the password is an empty string', async () => {
		const r = await runWithActiveKey('', async () => 'never-called');
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('unreachable');
		expect(r.kind).toBe('password_empty');
		expect(useActiveKeyMock).not.toHaveBeenCalled();
	});

	it('returns locked when identity store is not unlocked', async () => {
		mockStoreState.current = { state: 'locked' } as unknown as typeof mockStoreState.current;
		const r = await runWithActiveKey('pw', async () => 'never-called');
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('unreachable');
		expect(r.kind).toBe('locked');
		expect(useActiveKeyMock).not.toHaveBeenCalled();
	});

	it('returns ok with the callback value on success', async () => {
		useActiveKeyMock.mockImplementation(async (_env, _pw, cb) => cb(new Uint8Array(32)));
		const r = await runWithActiveKey('pw', async () => {
			return { trx_id: 'abc', permlink: 'foo' };
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error('unreachable');
		expect(r.value).toEqual({ trx_id: 'abc', permlink: 'foo' });
	});

	it('classifies KeystoreError(bad_password) as bad_password', async () => {
		// Audit 2026-05 finding 1-4: classification uses
		// KeystoreError.kind, not string-matching on Error.message.
		// Tests must throw KeystoreError, not generic Error.
		const { KeystoreError } = await import('$crypto/keystore');
		useActiveKeyMock.mockRejectedValue(
			new KeystoreError('bad_password', 'Invalid password supplied')
		);
		const r = await runWithActiveKey('wrong', async () => 'never-reached');
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('unreachable');
		expect(r.kind).toBe('bad_password');
	});

	it('classifies KeystoreError(envelope_corrupt) as broadcast (non-retryable)', async () => {
		// Per Audit 2026-05 finding 1-4: envelope_corrupt is
		// non-retryable so it goes to 'broadcast' (generic) — UI
		// shows the underlying message rather than telling the user
		// to retry the password (which won't help).
		const { KeystoreError } = await import('$crypto/keystore');
		useActiveKeyMock.mockRejectedValue(
			new KeystoreError('envelope_corrupt', 'Failed to decrypt envelope')
		);
		const r = await runWithActiveKey('wrong', async () => 'never-reached');
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('unreachable');
		expect(r.kind).toBe('broadcast');
	});

	it('classifies non-password callback throws as broadcast', async () => {
		const broadcastErr = new Error('Network unreachable');
		// useActiveKey runs the callback; the callback throws.
		useActiveKeyMock.mockImplementation(async (_env, _pw, cb) => cb(new Uint8Array(32)));
		const r = await runWithActiveKey('pw', async () => {
			throw broadcastErr;
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('unreachable');
		expect(r.kind).toBe('broadcast');
		expect(r.cause).toBe(broadcastErr);
	});

	it('classifies non-Error throws as broadcast', async () => {
		useActiveKeyMock.mockRejectedValue('some string error');
		const r = await runWithActiveKey('pw', async () => 'never');
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('unreachable');
		expect(r.kind).toBe('broadcast');
	});

	it('classifies KeystoreError(identity_mismatch) as identity_mismatch', async () => {
		// M6 audit defense: cross-tab envelope replacement plant.
		// useJitKey throws KeystoreError('identity_mismatch') when
		// the constant-time pubkey pin fails — this should surface
		// as a distinct kind from bad_password so the UI can show
		// the right message ("a different identity is unlocked in
		// another tab" vs. "wrong password, try again").
		const { KeystoreError } = await import('$crypto/keystore');
		useActiveKeyMock.mockRejectedValue(new KeystoreError('identity_mismatch', 'pubkey pin failed'));
		const r = await runWithActiveKey('pw', async () => 'never');
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error('unreachable');
		expect(r.kind).toBe('identity_mismatch');
	});
});
