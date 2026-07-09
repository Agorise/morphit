import { describe, expect, it, beforeAll } from 'vitest';
import { classifySecret, resolveActiveKey, type AccountAuthorityKeys } from './activeKeyUnlock';
import { masterPasswordPubKey, masterPasswordScalar } from './masterPassword';
import { rawPrivateKeyToWif } from './wif';
import { formatPublicKeyBLT, ensureSodium } from './keygen';
import * as secp256k1 from '@noble/secp256k1';

const ACCOUNT = 'kentest2';
const PASSWORD = 'P5KQZ0correcthorsebatterystaple';

/** Real keys, derived the same way Blurt derives them. No mocks in front of money. */
let activeWif: string;
let postingWif: string;
let ownerWif: string;
let strangerWif: string;
let auth: AccountAuthorityKeys;

const pubOf = async (scalar: Uint8Array) =>
	formatPublicKeyBLT(secp256k1.getPublicKey(scalar, true));

beforeAll(async () => {
	await ensureSodium();
	const a = (await masterPasswordScalar(ACCOUNT, 'active', PASSWORD))!;
	const p = (await masterPasswordScalar(ACCOUNT, 'posting', PASSWORD))!;
	const o = (await masterPasswordScalar(ACCOUNT, 'owner', PASSWORD))!;
	const s = (await masterPasswordScalar('someoneelse', 'active', PASSWORD))!;
	activeWif = await rawPrivateKeyToWif(a);
	postingWif = await rawPrivateKeyToWif(p);
	ownerWif = await rawPrivateKeyToWif(o);
	strangerWif = await rawPrivateKeyToWif(s);
	auth = {
		active: [await pubOf(a)],
		posting: [await pubOf(p)],
		owner: [await pubOf(o)]
	};
});

describe('classifySecret', () => {
	it('recognises a WIF by shape', async () => {
		expect(classifySecret(activeWif)).toBe('wif');
	});
	it('treats anything else as a candidate master password', () => {
		expect(classifySecret('hunter2')).toBe('master_password');
	});
	it('reports empty', () => {
		expect(classifySecret('   ')).toBe('empty');
	});
});

describe('resolveActiveKey — the gate in front of the money', () => {
	it('accepts the account\u2019s real Active key (WIF)', async () => {
		const r = await resolveActiveKey(ACCOUNT, activeWif, auth);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.source).toBe('wif');
	});

	it('accepts a pre-fork master password and derives the active key', async () => {
		const r = await resolveActiveKey(ACCOUNT, PASSWORD, auth);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.source).toBe('master_password');
	});

	// The three mistakes a real user actually makes:
	it('names the Posting key instead of failing at the chain', async () => {
		const r = await resolveActiveKey(ACCOUNT, postingWif, auth);
		expect(r).toEqual({ ok: false, reason: 'is_posting_key' });
	});

	it('REFUSES an Owner key — it has no business in a transfer flow', async () => {
		const r = await resolveActiveKey(ACCOUNT, ownerWif, auth);
		expect(r).toEqual({ ok: false, reason: 'is_owner_key' });
	});

	it('rejects a valid key belonging to a different account', async () => {
		const r = await resolveActiveKey(ACCOUNT, strangerWif, auth);
		expect(r).toEqual({ ok: false, reason: 'not_this_account' });
	});

	it('rejects a malformed WIF (bad checksum) rather than broadcasting garbage', async () => {
		const broken = activeWif.slice(0, -1) + (activeWif.endsWith('a') ? 'b' : 'a');
		const r = await resolveActiveKey(ACCOUNT, broken, auth);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(['invalid_wif', 'not_this_account']).toContain(r.reason);
	});

	it('rejects a wrong master password', async () => {
		const r = await resolveActiveKey(ACCOUNT, 'not-the-password', auth);
		expect(r).toEqual({ ok: false, reason: 'not_this_account' });
	});

	it('rejects empty input', async () => {
		expect(await resolveActiveKey(ACCOUNT, '', auth)).toEqual({ ok: false, reason: 'empty' });
	});

	it('an account whose active authority was rotated away from the master password is refused, not owner-signed', async () => {
		const rotated: AccountAuthorityKeys = { ...auth, active: ['BLT-someone-elses-key'] };
		const r = await resolveActiveKey(ACCOUNT, PASSWORD, rotated);
		expect(r).toEqual({ ok: false, reason: 'is_owner_key' });
	});

	it('never returns a scalar on failure', async () => {
		for (const bad of [postingWif, ownerWif, strangerWif, '', 'nope']) {
			const r = await resolveActiveKey(ACCOUNT, bad, auth);
			expect(r.ok).toBe(false);
			expect((r as Record<string, unknown>).scalar).toBeUndefined();
		}
	});
});
