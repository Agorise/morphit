/**
 * v1.20.0 review (F-9): on a plain-HTTP I2P address (`http://….b32.i2p` in
 * Firefox with an I2P proxy) the page is not a "secure context", so the
 * browser removes crypto.subtle, navigator.clipboard and service workers.
 * Morphit used them unguarded: an authenticator code at unlock crashed with a
 * TypeError (shown as a generic error after the password had worked), copy
 * buttons threw, and "About this instance" computed forever. These tests pin
 * the calm, specific behaviour instead. (Reproduced in Chromium on an
 * http://*.b32.i2p host: isSecureContext false, crypto.subtle undefined.)
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { webCryptoAvailable, copyText, isInsecureContext } from './secureContext';
import { verifyTotpOrBackup } from '$crypto/keystoreTotp';
import { KeystoreError } from '$crypto/keystore';
import { generatePlaintextCodes, hashCodesForStorage } from '$lib/auth/backupCodes';
import { ensureSodium } from '$crypto/sodium';
import type { Identity } from '$crypto/keygen';

/** Remove crypto.subtle the way an insecure context does. */
function dropSubtle(): void {
	vi.stubGlobal('crypto', {
		getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto)
	});
}

describe('secure-context feature detection', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('webCryptoAvailable() follows crypto.subtle', () => {
		expect(webCryptoAvailable()).toBe(true);
		dropSubtle();
		expect(webCryptoAvailable()).toBe(false);
	});

	it('isInsecureContext() is true only when the browser says so', () => {
		expect(isInsecureContext()).toBe(false); // no window (node)
		vi.stubGlobal('window', { isSecureContext: false });
		expect(isInsecureContext()).toBe(true);
		vi.stubGlobal('window', { isSecureContext: true });
		expect(isInsecureContext()).toBe(false);
	});

	it('copyText() reports false instead of throwing when the clipboard is gone', async () => {
		vi.stubGlobal('navigator', {});
		await expect(copyText('x')).resolves.toBe(false);
		const writeText = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', { clipboard: { writeText } });
		await expect(copyText('x')).resolves.toBe(true);
		expect(writeText).toHaveBeenCalledWith('x');
	});
});

describe('2FA unlock without crypto.subtle (plain-HTTP I2P)', () => {
	let identity: Identity;
	let codes: string[];
	beforeAll(async () => {
		await ensureSodium();
		codes = generatePlaintextCodes();
		identity = {
			totpSecret: new Uint8Array(20).fill(3),
			totpBackupCodes: await hashCodesForStorage(codes)
		} as unknown as Identity;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("an authenticator code fails with the specific 'totp_unavailable', not a TypeError", async () => {
		dropSubtle();
		const err = await verifyTotpOrBackup(identity, '123456').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(KeystoreError);
		expect((err as KeystoreError).kind).toBe('totp_unavailable');
	});

	it('a backup code still unlocks there (it does not need crypto.subtle)', async () => {
		dropSubtle();
		const r = await verifyTotpOrBackup(identity, codes[0]!);
		expect(r.kind).toBe('backup_redeemed');
	});
});
