import { describe, it, expect } from 'vitest';
import {
	generateIdentity,
	generateFullIdentity,
	importFullIdentityFromSeed,
	toLiveIdentity,
	formatPublicKey,
	mnemonicForBackup,
	wipeIdentity,
	wipeLiveIdentity,
	wipeFullIdentity,
	KEY_ROLES,
	LIVE_ROLES,
	JIT_ROLES
} from './keygen';
import {
	encryptIdentity,
	decryptIdentity,
	envelopeToBlob,
	blobToEnvelope,
	useActiveKeyForPasswordChange,
	useOwnerKey,
	validateSimpleEnvelope,
	KeystoreError
} from './keystore';
import { identiconSvg, identiconDataUri } from './identicon';
import { fingerprint, formatIdentity, validateDisplayName } from './profile';
import { formatPublicKeyBLT } from './keygen';

describe('keygen — full identity', () => {
	it('produces a four-role identity with 16-byte (12-word) seed entropy', async () => {
		const full = await generateFullIdentity();
		// Post-K1.2: seed stored as 16 bytes of BIP-39 entropy
		// (encodes a 12-word mnemonic).  Display via
		// mnemonicForBackup if needed.
		expect(full.seedBytes).toBeInstanceOf(Uint8Array);
		expect(full.seedBytes!.length).toBe(16);
		for (const role of KEY_ROLES) {
			expect(full.keys[role]!.privateKey).toBeInstanceOf(Uint8Array);
			expect(full.keys[role]!.publicKey).toBeInstanceOf(Uint8Array);
			expect(full.keys[role]!.privateKey.length).toBeGreaterThan(0);
		}
	});

	it('derives distinct keys per role', async () => {
		const full = await generateFullIdentity();
		const pubs = KEY_ROLES.map((r) => formatPublicKey(full.keys[r]!.publicKey));
		expect(new Set(pubs).size).toBe(KEY_ROLES.length);
	});

	it('produces secp256k1-shaped keys: 33-byte compressed pubkey, 32-byte scalar', async () => {
		// Guards against a regression to Ed25519 (32-byte pubkey, 64-byte
		// secret) or any other curve choice. See ADR-0007.
		const full = await generateFullIdentity();
		for (const role of KEY_ROLES) {
			expect(full.keys[role]!.publicKey.length, `pub ${role}`).toBe(33);
			expect(full.keys[role]!.privateKey.length, `priv ${role}`).toBe(32);
			// Compressed secp256k1 points start with 0x02 or 0x03 (the
			// y-coordinate parity prefix). Uncompressed would start 0x04.
			const firstByte = full.keys[role]!.publicKey[0];
			expect(firstByte === 0x02 || firstByte === 0x03, `pub ${role} prefix`).toBe(true);
		}
	});

	it('re-derives the same keys from the same seed', async () => {
		// Must be a real BIP-39-valid mnemonic — random 12-word
		// strings from the wordlist won't pass the checksum.  This
		// is the canonical "all-zero entropy" test vector.
		const seed =
			'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
		const id1 = await importFullIdentityFromSeed(seed);
		const id2 = await importFullIdentityFromSeed(seed);
		for (const role of KEY_ROLES) {
			expect(formatPublicKey(id1.keys[role]!.publicKey)).toBe(
				formatPublicKey(id2.keys[role]!.publicKey)
			);
		}
	});

	it('rejects seeds that are not 12 words', async () => {
		await expect(importFullIdentityFromSeed('only three words here')).rejects.toThrow();
	});
});

describe('keygen — live identity invariant', () => {
	it('LIVE_ROLES and JIT_ROLES partition KEY_ROLES exactly', () => {
		const combined = new Set([...LIVE_ROLES, ...JIT_ROLES]);
		expect(combined.size).toBe(KEY_ROLES.length);
		for (const r of KEY_ROLES) expect(combined.has(r)).toBe(true);
	});

	it('toLiveIdentity zeroes owner and active private keys in the source', async () => {
		const full = await generateFullIdentity();
		const ownerPrivBefore = [...full.keys.owner!.privateKey];
		const activePrivBefore = [...full.keys.active!.privateKey];

		const live = toLiveIdentity(full);

		// Private keys in the SOURCE are now zeroed.
		expect([...full.keys.owner!.privateKey].every((b) => b === 0)).toBe(true);
		expect([...full.keys.active!.privateKey].every((b) => b === 0)).toBe(true);
		// Sanity: they weren't zero before.
		expect(ownerPrivBefore.some((b) => b !== 0)).toBe(true);
		expect(activePrivBefore.some((b) => b !== 0)).toBe(true);

		// LiveIdentity carries only posting + memo privates.
		expect(live.posting.privateKey.length).toBeGreaterThan(0);
		expect(live.memo!.privateKey.length).toBeGreaterThan(0);
		expect('privateKey' in live).toBe(false);
		// Public keys for owner/active are exposed for display.
		expect(live.ownerPublicKey!.length).toBeGreaterThan(0);
		expect(live.activePublicKey!.length).toBeGreaterThan(0);
	});

	it('generateIdentity returns a snapshot that is safe to encrypt', async () => {
		const { full, live } = await generateIdentity();

		// `full` is a snapshot with all four privates intact (so it can be
		// encrypted into the keystore).
		for (const role of KEY_ROLES) {
			expect(full.keys[role]!.privateKey.length).toBeGreaterThan(0);
			expect([...full.keys[role]!.privateKey].some((b) => b !== 0)).toBe(true);
		}

		// `live` carries only posting + memo privates.
		expect(live.posting.privateKey.length).toBeGreaterThan(0);
		expect(live.memo!.privateKey.length).toBeGreaterThan(0);

		// The live posting/memo public keys match what's in full.
		expect(formatPublicKey(live.posting.publicKey)).toBe(
			formatPublicKey(full.keys.posting.publicKey)
		);
		expect(formatPublicKey(live.memo!.publicKey)).toBe(formatPublicKey(full.keys.memo!.publicKey));
	});
});

describe('keystore — basic round-trip', () => {
	it('round-trips identity through password encryption', async () => {
		const full = await generateFullIdentity();
		const originalSeedBytes = new Uint8Array(full.seedBytes!);
		const originalPub = formatPublicKey(full.keys.posting.publicKey);
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');
		const restored = await decryptIdentity(env, 'correct-horse-battery-staple');
		expect(Array.from(restored.seedBytes!)).toEqual(Array.from(originalSeedBytes));
		expect(formatPublicKey(restored.keys.posting.publicKey)).toBe(originalPub);
	});

	it('throws on wrong password', async () => {
		const full = await generateFullIdentity();
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');
		await expect(decryptIdentity(env, 'wrong-password')).rejects.toThrow();
	});

	it('blob → envelope round-trips', async () => {
		const full = await generateFullIdentity();
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');
		const blob = envelopeToBlob(env);
		const parsed = await blobToEnvelope(blob);
		expect(parsed.ciphertext).toBe(env.ciphertext);
	});

	it('rejects too-short passwords on encrypt', async () => {
		const full = await generateFullIdentity();
		await expect(encryptIdentity(full, 'short')).rejects.toThrow();
	});

	it('enforces the 10-character minimum (boundary check)', async () => {
		// 9 characters — must reject.  This locks in the post-audit
		// floor; if a future commit lowers the keystore minimum
		// back to 8, this test surfaces the regression.  The
		// matching UI-level rule (10 chars OR 12+3-class) lives in
		// passwordStrength.ts; the keystore is the backstop.
		const full = await generateFullIdentity();
		await expect(encryptIdentity(full, 'a'.repeat(9))).rejects.toThrow();
		// 10 characters — must accept (no class requirement at this
		// layer; class enforcement is the UI's job).
		const env = await encryptIdentity(full, 'a'.repeat(10));
		expect(env.scheme).toBe('simple-passphrase');
	});

	// ─── K1.1 — defensive guard on stored kdfParams ────────────
	//
	// The decrypt path uses argonParams() (libsodium INTERACTIVE)
	// regardless of what's in the envelope, so today the
	// envelope's kdfParams are an audit aid only.  But the field
	// is unauthenticated — a tampered envelope can claim any
	// values.  decryptIdentity now refuses envelopes whose
	// claimed params are below safe minimums, so a future code
	// change that "honored what's in the envelope" wouldn't
	// silently accept ops=1 mem=8K from an attacker.

	it('K1.1: rejects envelope with implausibly low opslimit', async () => {
		const full = await generateFullIdentity();
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');
		const tampered = {
			...env,
			kdfParams: { opslimit: 0, memlimit: env.kdfParams.memlimit }
		};
		await expect(decryptIdentity(tampered, 'correct-horse-battery-staple')).rejects.toThrow(
			/unsafe KDF/
		);
	});

	it('K1.1: rejects envelope with implausibly low memlimit', async () => {
		const full = await generateFullIdentity();
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');
		const tampered = {
			...env,
			kdfParams: { opslimit: env.kdfParams.opslimit, memlimit: 8 * 1024 }
		};
		await expect(decryptIdentity(tampered, 'correct-horse-battery-staple')).rejects.toThrow(
			/unsafe KDF/
		);
	});

	it('K1.1: rejects envelope with missing kdfParams object', async () => {
		const full = await generateFullIdentity();
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');
		const tampered = { ...env, kdfParams: undefined as unknown as typeof env.kdfParams };
		await expect(decryptIdentity(tampered, 'correct-horse-battery-staple')).rejects.toThrow(
			/unsafe KDF/
		);
	});

	it('K1.1: accepts envelope with normal libsodium INTERACTIVE params', async () => {
		// Sanity: legitimate envelopes encrypted with the standard
		// path always pass the floor.  Confirms the floors aren't
		// so high that they reject honest output.
		const full = await generateFullIdentity();
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');
		const restored = await decryptIdentity(env, 'correct-horse-battery-staple');
		expect(Array.from(restored.seedBytes!)).toEqual(Array.from(full.seedBytes!));
	});

	// ─── K1.4 — keyfile size cap ───────────────────────────────

	it('K1.4: rejects oversized keyfile import', async () => {
		// Construct a 100KB blob and try to import.  Real envelopes
		// are ~1KB; the cap is 64KB so this is well over.
		const huge = 'a'.repeat(100 * 1024);
		const blob = new Blob([huge], { type: 'application/json' });
		await expect(blobToEnvelope(blob)).rejects.toThrow(/too large/);
	});

	it('K1.4: accepts normal-sized keyfile', async () => {
		// Real envelope is well under the cap; sanity check that
		// the cap isn't so tight that legitimate keyfiles fail.
		const full = await generateFullIdentity();
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');
		const blob = envelopeToBlob(env);
		// Confirm blob is well under the 64KB cap so the test is
		// actually exercising the happy path.
		expect(blob.size).toBeLessThan(64 * 1024);
		const parsed = await blobToEnvelope(blob);
		expect(parsed.ciphertext).toBe(env.ciphertext);
	});

	// ─── K1.2 — seed-as-bytes refactor ─────────────────────────
	//
	// Pre-fix: FullIdentity carried `seed: string` (the BIP-39
	// mnemonic).  JS strings can't be sodium.memzero'd so the
	// mnemonic survived in the heap until GC reclaimed it.  Post-
	// fix: FullIdentity carries `seedBytes: Uint8Array` (the raw
	// 16- or 32-byte BIP-39 entropy), which CAN be zeroed.
	// mnemonicForBackup() reconstructs the mnemonic on demand for
	// display.

	it('K1.2: mnemonicForBackup round-trips through seedBytes', async () => {
		// Generate, derive mnemonic for display, import that
		// mnemonic back, confirm we get the same seedBytes.
		const full = await generateFullIdentity();
		const mnemonic = mnemonicForBackup(full);
		expect(mnemonic.split(' ')).toHaveLength(12);
		const reimported = await importFullIdentityFromSeed(mnemonic);
		expect(Array.from(reimported.seedBytes!)).toEqual(Array.from(full.seedBytes!));
		// Same keys derived too — the entropy → keys pipeline is
		// deterministic.
		for (const role of KEY_ROLES) {
			expect(formatPublicKey(reimported.keys[role]!.publicKey)).toBe(
				formatPublicKey(full.keys[role]!.publicKey)
			);
		}
	});

	it('K1.2: wipeFullIdentity zeros seedBytes', async () => {
		const full = await generateFullIdentity();
		// Confirm there's actual entropy in the bytes (not all
		// zeros pre-wipe).
		const preWipeNonZero = full.seedBytes!.some((b) => b !== 0);
		expect(preWipeNonZero).toBe(true);
		wipeFullIdentity(full);
		// All bytes should be 0 after wipe.
		const postWipeAllZero = full.seedBytes!.every((b) => b === 0);
		expect(postWipeAllZero).toBe(true);
	});
});

describe('keystore — JIT unlock', () => {
	it('useActiveKey hands the right private key to the callback, then wipes it', async () => {
		const full = await generateFullIdentity();
		const originalActive = new Uint8Array(full.keys.active!.privateKey);
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');

		let seenInsideCallback: Uint8Array | null = null;
		const result = await useActiveKeyForPasswordChange(
			env,
			'correct-horse-battery-staple',
			async (activePriv) => {
				seenInsideCallback = activePriv;
				// Must match what we derived originally.
				expect(Array.from(activePriv)).toEqual(Array.from(originalActive));
				// Private must be non-zero inside the callback.
				expect(Array.from(activePriv).some((b) => b !== 0)).toBe(true);
				return 'signed!';
			}
		);

		expect(result).toBe('signed!');
		// After the callback returns, the bytes handed in are zeroed.
		expect(seenInsideCallback).not.toBeNull();
		expect(Array.from(seenInsideCallback!).every((b) => b === 0)).toBe(true);
	});

	it('useActiveKey wipes the key even if the callback throws', async () => {
		const full = await generateFullIdentity();
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');

		let seen: Uint8Array | null = null;
		await expect(
			useActiveKeyForPasswordChange(env, 'correct-horse-battery-staple', async (activePriv) => {
				seen = activePriv;
				throw new Error('boom');
			})
		).rejects.toThrow('boom');

		expect(seen).not.toBeNull();
		expect(Array.from(seen!).every((b) => b === 0)).toBe(true);
	});

	it('useActiveKey throws on wrong password and does not call the callback', async () => {
		const full = await generateFullIdentity();
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');

		let called = false;
		await expect(
			useActiveKeyForPasswordChange(env, 'wrong-password', async () => {
				called = true;
				return 0;
			})
		).rejects.toThrow();

		expect(called).toBe(false);
	});

	it('useOwnerKey works the same way for owner', async () => {
		const full = await generateFullIdentity();
		const originalOwner = new Uint8Array(full.keys.owner!.privateKey);
		const env = await encryptIdentity(full, 'correct-horse-battery-staple');

		const result = await useOwnerKey(
			env,
			'correct-horse-battery-staple',
			async (ownerPriv) => {
				expect(Array.from(ownerPriv)).toEqual(Array.from(originalOwner));
				return 'ok';
			},
			full.keys.posting.publicKey
		);

		expect(result).toBe('ok');
	});
});

describe('profile — fingerprints & validation', () => {
	it('fingerprint uses BLT prefix with 6 head + 4 tail', () => {
		const pk = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
		const fp = fingerprint(pk);
		expect(fp.startsWith('BLT')).toBe(true);
		expect(fp.includes('…')).toBe(true);
		const [head, tail] = fp.slice(3).split('…');
		expect(head).toHaveLength(6);
		expect(tail).toHaveLength(4);
	});

	it('formatPublicKeyBLT returns the canonical BLT-base58check key (async, lazy dblurt)', async () => {
		// cp165: fullPublicKey was removed.  The async
		// formatPublicKeyBLT is the canonical formatter; it
		// dynamically imports dblurt so the 2 MB chunk doesn't
		// land on the first-paint graph of every authenticated
		// page.  Input must be a real 33-byte compressed key.
		// Use the chain-distinguishable generator zero-scalar
		// edge case isn't valid for secp256k1, so use a derived
		// real key.
		const seed = new Uint8Array(32);
		for (let i = 0; i < 32; i++) seed[i] = (i + 1) & 0xff;
		const secp256k1 = await import('@noble/secp256k1');
		const pub = secp256k1.getPublicKey(seed, true);
		const blt = await formatPublicKeyBLT(pub);
		expect(blt.startsWith('BLT')).toBe(true);
		// canonical Blurt key string: BLT prefix + base58check body,
		// typically ~50 characters total
		expect(blt.length).toBeGreaterThan(40);
	});

	it('formatIdentity returns name and fingerprint (no eager `full` field — cp165 lazy-load)', () => {
		const pk = new Uint8Array(32).fill(0xab);
		const f = formatIdentity('Sally Doe', pk);
		expect(f.name).toBe('Sally Doe');
		expect(f.fingerprint.startsWith('BLT')).toBe(true);
		// cp165 byte-budget: the `full` field was removed because it
		// required dblurt (2 MB chunk) at first paint.  Consumers
		// that need the canonical full key call formatPublicKeyBLT
		// directly (async).  See IdentityLabel.svelte for the
		// lazy-resolve-on-hover pattern.
		expect((f as { full?: string }).full).toBeUndefined();
	});

	it('validates display names: accepts reasonable input', () => {
		const ok = validateDisplayName('Sally Doe');
		expect(ok.ok).toBe(true);
		expect(ok.cleaned).toBe('Sally Doe');
	});

	it('validates display names: rejects control chars', () => {
		const bad = validateDisplayName('Sally\u0007Doe');
		expect(bad.ok).toBe(false);
		expect(bad.reasonKey).toContain('control_char');
	});

	it('validates display names: rejects bidi overrides', () => {
		const bad = validateDisplayName('Sally\u202eDoe');
		expect(bad.ok).toBe(false);
		expect(bad.reasonKey).toContain('invisible_char');
	});

	it('validates display names: collapses internal whitespace', () => {
		const v = validateDisplayName('  Sally    Doe  ');
		expect(v.ok).toBe(true);
		expect(v.cleaned).toBe('Sally Doe');
	});

	// Finding K option (b) — leading-@ rejection.
	// @-prefixed display names mimic account handles and enable
	// impersonation in contexts where the identicon isn't surfaced
	// (SERP snippets, OS notifications, terse screen readers).
	it('validates display names: rejects leading ASCII @', () => {
		const bad = validateDisplayName('@morphit-fees');
		expect(bad.ok).toBe(false);
		expect(bad.reasonKey).toContain('leading_at');
	});

	it('validates display names: rejects leading fullwidth ＠', () => {
		// U+FF20 FULLWIDTH COMMERCIAL AT — visual confusable for @
		// in most fonts. Bypassing the ASCII check by substituting
		// this character must not work.
		const bad = validateDisplayName('\uff20morphit-fees');
		expect(bad.ok).toBe(false);
		expect(bad.reasonKey).toContain('leading_at');
	});

	it('validates display names: accepts @ in the middle', () => {
		// "Sally @ Coffee Shop" is a legitimate pattern — it reads
		// as an at-location marker, not as the user's own handle.
		const ok = validateDisplayName('Sally @ Coffee Shop');
		expect(ok.ok).toBe(true);
	});

	it('validates display names: leading whitespace before @ does not bypass', () => {
		// The validator trims before the leading-char check, so
		// "  @foo" is still rejected.
		const bad = validateDisplayName('  @morphit');
		expect(bad.ok).toBe(false);
		expect(bad.reasonKey).toContain('leading_at');
	});
});

describe('identicon', () => {
	it('produces deterministic SVG from input bytes', () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const svg1 = identiconSvg(bytes, 64);
		const svg2 = identiconSvg(bytes, 64);
		expect(svg1).toBe(svg2);
		expect(svg1.startsWith('<svg')).toBe(true);
	});

	it('produces different SVGs for different inputs', () => {
		const a = identiconSvg(new Uint8Array([1, 2, 3]), 64);
		const b = identiconSvg(new Uint8Array([9, 8, 7]), 64);
		expect(a).not.toBe(b);
	});

	it('returns a base64 data URI suitable for <img src>', () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const uri = identiconDataUri(bytes, 48);
		// Base64 (not percent-encoded): renders consistently in <img>
		// across every engine, notably WebKit/Safari where the
		// percent-encoded `image/svg+xml,` form is unreliable. Still a
		// `data:` URI, covered by the `img-src ... data:` CSP directive.
		expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
		// The base64 payload must decode back to exactly the SVG markup.
		const b64 = uri.slice('data:image/svg+xml;base64,'.length);
		const decoded = Buffer.from(b64, 'base64').toString('utf-8');
		expect(decoded).toBe(identiconSvg(bytes, 48));
		expect(decoded.startsWith('<svg')).toBe(true);
	});
});

describe('wipeIdentity', () => {
	it('zeroes FullIdentity key bytes in place', async () => {
		const full = await generateFullIdentity();
		const pkBefore = [...full.keys.posting.privateKey];
		wipeFullIdentity(full);
		const pkAfter = [...full.keys.posting.privateKey];
		expect(pkAfter.every((b) => b === 0)).toBe(true);
		expect(pkBefore.some((b) => b !== 0)).toBe(true);
	});

	it('zeroes LiveIdentity key bytes in place', async () => {
		const { live } = await generateIdentity();
		const pkBefore = [...live.posting.privateKey];
		wipeLiveIdentity(live);
		const pkAfter = [...live.posting.privateKey];
		expect(pkAfter.every((b) => b === 0)).toBe(true);
		expect(pkBefore.some((b) => b !== 0)).toBe(true);
	});

	it('the polymorphic wipeIdentity accepts either shape', async () => {
		const full = await generateFullIdentity();
		expect(() => wipeIdentity(full)).not.toThrow();
	});
});

// ─── Audit 2026-05 Part 1 regressions ───────────────────────────────

describe('audit 2026-05 finding 1-1 — validateSimpleEnvelope', () => {
	it('accepts a real envelope round-trip', async () => {
		const id = await generateFullIdentity();
		const env = await encryptIdentity(id, 'correct horse battery staple');
		expect(() => validateSimpleEnvelope(env)).not.toThrow();
	});

	it('rejects envelope with wrong scheme', async () => {
		const id = await generateFullIdentity();
		const env = await encryptIdentity(id, 'correct horse battery staple');
		const bad = { ...env, scheme: 'layered-cek' as const };
		expect(() => validateSimpleEnvelope(bad as never)).toThrow(/Wrong scheme/);
	});

	it('rejects envelope with v != 1', async () => {
		const id = await generateFullIdentity();
		const env = await encryptIdentity(id, 'correct horse battery staple');
		const bad = { ...env, v: 2 as never };
		expect(() => validateSimpleEnvelope(bad)).toThrow(/version/);
	});

	it('rejects envelope with non-string salt', async () => {
		const id = await generateFullIdentity();
		const env = await encryptIdentity(id, 'correct horse battery staple');
		const bad = { ...env, salt: 12345 as unknown as string };
		expect(() => validateSimpleEnvelope(bad)).toThrow(/salt/);
	});

	it('rejects envelope with empty-string nonce', async () => {
		const id = await generateFullIdentity();
		const env = await encryptIdentity(id, 'correct horse battery staple');
		const bad = { ...env, nonce: '' };
		expect(() => validateSimpleEnvelope(bad)).toThrow(/nonce/);
	});

	it('rejects envelope with non-finite createdAt', async () => {
		const id = await generateFullIdentity();
		const env = await encryptIdentity(id, 'correct horse battery staple');
		const bad = { ...env, createdAt: NaN };
		expect(() => validateSimpleEnvelope(bad)).toThrow(/createdAt/);
	});

	it('rejects envelope with weak KDF params', async () => {
		const id = await generateFullIdentity();
		const env = await encryptIdentity(id, 'correct horse battery staple');
		const bad = { ...env, kdfParams: { opslimit: 1, memlimit: 8192 } };
		expect(() => validateSimpleEnvelope(bad)).toThrow(/KDF/);
	});
});

describe('audit 2026-05 finding 1-4 — KeystoreError typed dispatch', () => {
	it('decryptIdentity throws KeystoreError kind=bad_password on wrong password', async () => {
		const id = await generateFullIdentity();
		const env = await encryptIdentity(id, 'right-password');
		await expect(decryptIdentity(env, 'wrong-password')).rejects.toMatchObject({
			name: 'KeystoreError',
			kind: 'bad_password'
		});
	});

	it('KeystoreError instanceof Error and exposes kind', () => {
		const e = new KeystoreError('unsupported', 'test');
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe('KeystoreError');
		expect(e.kind).toBe('unsupported');
	});

	it('KeystoreError kind enumerates all expected values', () => {
		const kinds = [
			'bad_password',
			'envelope_corrupt',
			'identity_mismatch',
			'no_passphrase_wrap',
			'unsupported'
		] as const;
		for (const k of kinds) {
			const e = new KeystoreError(k, 'msg');
			expect(e.kind).toBe(k);
		}
	});
});
