import { describe, expect, it, beforeAll } from 'vitest';
import { classifySecret, resolveActiveKey, type AccountAuthorityKeys } from './activeKeyUnlock';
import { rawPrivateKeyToWif } from './wif';
import { formatPublicKeyBLT, ensureSodium } from './keygen';
import * as secp256k1 from '@noble/secp256k1';

const ACCOUNT = 'kentest2';

/**
 * Real secp256k1 keys — no mocks in front of the money. Generated randomly
 * (NOT derived from any account-wide secret): Morphit's unlock flow accepts an
 * Active-key WIF and nothing else, so all we need is four valid keypairs whose
 * public keys become the account's on-chain authorities.
 */
let activeWif: string;
let postingWif: string;
let ownerWif: string;
let strangerWif: string;
let auth: AccountAuthorityKeys;

const pubOf = async (scalar: Uint8Array) =>
	formatPublicKeyBLT(secp256k1.getPublicKey(scalar, true));

beforeAll(async () => {
	await ensureSodium();
	const a = secp256k1.utils.randomPrivateKey();
	const p = secp256k1.utils.randomPrivateKey();
	const o = secp256k1.utils.randomPrivateKey();
	const s = secp256k1.utils.randomPrivateKey();
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
	it('treats anything that is NOT a WIF as not_wif (never an account-wide secret)', () => {
		expect(classifySecret('hunter2')).toBe('not_wif');
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

	// SECURITY (Ken): Morphit NEVER accepts an account-wide secret that could
	// derive every role's key (owner included). A non-WIF string is refused
	// outright as invalid — it is never tried as anything else.
	it('REFUSES a non-WIF secret outright (invalid_wif) — never derives keys from a password', async () => {
		const r = await resolveActiveKey(ACCOUNT, 'some account-wide secret phrase', auth);
		expect(r).toEqual({ ok: false, reason: 'invalid_wif' });
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

	it('rejects empty input', async () => {
		expect(await resolveActiveKey(ACCOUNT, '', auth)).toEqual({ ok: false, reason: 'empty' });
	});

	it('never returns a scalar on failure', async () => {
		for (const bad of [postingWif, ownerWif, strangerWif, '', 'nope']) {
			const r = await resolveActiveKey(ACCOUNT, bad, auth);
			expect(r.ok).toBe(false);
			expect((r as Record<string, unknown>).scalar).toBeUndefined();
		}
	});
});
