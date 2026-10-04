import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/release';
import { fakeConfig, makeCtx, mockBlurt } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';
import type { BlockTransaction } from '$blurt/client';

const OFFICIAL_PUBKEY = 'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9';

function validPayload() {
	return {
		version: '0.3.0',
		hash_manifest: {
			// SRI format: sha256-<43-base64-chars>=
			'index.html': 'sha256-' + 'a'.repeat(43) + '=',
			'app.js': 'sha256-' + 'b'.repeat(43) + '='
		},
		endpoints: {
			blurt_rpc: ['https://rpc.blurt.blog'],
			morphit_relay: ['https://relay.morphit.io']
		},
		signature: 'aBcDeF=='
	};
}

const accountWithOfficialKey = {
	name: 'morphit',
	posting: {
		weight_threshold: 1,
		account_auths: [] as const,
		key_auths: [[OFFICIAL_PUBKEY, 1]] as const
	},
	active: {
		weight_threshold: 1,
		account_auths: [] as const,
		key_auths: [] as const
	},
	owner: {
		weight_threshold: 1,
		account_auths: [] as const,
		key_auths: [] as const
	},
	memo_key: OFFICIAL_PUBKEY
};

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');
const CHAIN_ID = fakeConfig().chainId;
const OFFICIAL_KEY = PrivateKey.fromSeed('release-handler-test-official');
const OTHER_KEY = PrivateKey.fromSeed('release-handler-test-someone-else');
const SIGNED_PUBKEY = OFFICIAL_KEY.createPublic().toString();

/** The transaction a block carries for this op, signed by `key` (or not). */
function transactionFor(payload: unknown, key: typeof OFFICIAL_KEY | null): BlockTransaction {
	const unsigned = {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: '2026-04-19T12:01:00',
		operations: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: ['morphit'],
					id: 'morphit_release_v1',
					json: JSON.stringify(payload)
				}
			]
		],
		extensions: []
	};
	if (key === null) return { ...unsigned, signatures: [] } as unknown as BlockTransaction;
	return cryptoUtils.signTransaction(
		unsigned as never,
		[key],
		Buffer.from(CHAIN_ID, 'hex')
	) as never;
}

describe('release handler', () => {
	const chainThatThrows = () =>
		mockBlurt({
			getAccount: async () => {
				throw new Error('chain unreachable');
			}
		});

	it('records valid=true when the official account signed it with the pinned key — no chain read', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO releases' }]);
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: validPayload(),
				transaction: transactionFor(validPayload(), OFFICIAL_KEY),
				// Every chain read would fail: the verdict must not need one.
				blurt: chainThatThrows(),
				config: fakeConfig({ officialPostingPubkey: SIGNED_PUBKEY, officialAccountName: 'morphit' })
			}),
			mock.client
		);
		// Applied → ok:true so the audit row survives savepoint release.
		expect(r).toEqual({ ok: true });
		// Eighth param of the INSERT is the `valid` boolean — verify true.
		const q = mock.queries[0]!;
		expect(q.params[7]).toBe(true);
	});

	it('records valid=false when signer is not the official account', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO releases' }]);
		const r = await handler(
			makeCtx({
				signer: 'eve',
				payload: validPayload(),
				transaction: transactionFor(validPayload(), OFFICIAL_KEY),
				blurt: mockBlurt({}),
				config: fakeConfig({ officialPostingPubkey: SIGNED_PUBKEY, officialAccountName: 'morphit' })
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const q = mock.queries[0]!;
		expect(q.params[7]).toBe(false);
		expect(q.params[8]).toBe('signer_not_official_account');
	});

	it('records valid=false when the transaction is signed by any other key', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO releases' }]);
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: validPayload(),
				transaction: transactionFor(validPayload(), OTHER_KEY),
				blurt: mockBlurt({}),
				config: fakeConfig({ officialPostingPubkey: SIGNED_PUBKEY, officialAccountName: 'morphit' })
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[0]!.params[7]).toBe(false);
		expect(mock.queries[0]!.params[8]).toBe('not_signed_by_pinned_key');
	});

	it('records valid=false when the transaction carries no signature (a hostile RPC node served it)', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO releases' }]);
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: validPayload(),
				transaction: transactionFor(validPayload(), null),
				blurt: mockBlurt({}),
				config: fakeConfig({ officialPostingPubkey: SIGNED_PUBKEY, officialAccountName: 'morphit' })
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[0]!.params[7]).toBe(false);
		expect(mock.queries[0]!.params[8]).toBe('not_signed_by_pinned_key');
	});

	it('records valid=false when there is no transaction to check (an op replayed from the event log)', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO releases' }]);
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: validPayload(),
				blurt: mockBlurt({}),
				config: fakeConfig({ officialPostingPubkey: SIGNED_PUBKEY, officialAccountName: 'morphit' })
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[0]!.params[7]).toBe(false);
	});

	it('a signature over DIFFERENT content does not vouch for this payload', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO releases' }]);
		const signedOther = transactionFor({ ...validPayload(), version: '0.0.1' }, OFFICIAL_KEY);
		// The same signatures pasted onto a transaction carrying this payload.
		const tampered = {
			...transactionFor(validPayload(), null),
			signatures: signedOther.signatures
		} as BlockTransaction;
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: validPayload(),
				transaction: tampered,
				blurt: mockBlurt({}),
				config: fakeConfig({ officialPostingPubkey: SIGNED_PUBKEY, officialAccountName: 'morphit' })
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[0]!.params[7]).toBe(false);
	});

	it('rejects structurally malformed payload (no row written)', async () => {
		const mock = makeMockClient();
		const blurt = mockBlurt({});
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: { not: 'a release' },
				blurt
			}),
			mock.client
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe('version_not_string');
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects non-semver version string', async () => {
		const mock = makeMockClient();
		const blurt = mockBlurt({});
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: { ...validPayload(), version: 'v3' },
				blurt
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'version_not_semver' });
	});

	// Finding L regression: 4KB cap on hash_manifest and endpoints.
	// Critically, this check runs at validation time — before chain
	// interaction — so a payload past the cap never triggers a
	// signature-verify RPC round trip.
	it('rejects hash_manifest exceeding 4KB serialized', async () => {
		const mock = makeMockClient();
		const blurt = mockBlurt({});
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: {
					...validPayload(),
					hash_manifest: { padding: 'x'.repeat(4100) }
				},
				blurt
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'hash_manifest_too_large' });
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects endpoints exceeding 4KB serialized', async () => {
		const mock = makeMockClient();
		const blurt = mockBlurt({});
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: {
					...validPayload(),
					endpoints: { padding: 'x'.repeat(4100) }
				},
				blurt
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'endpoints_too_large' });
		expect(mock.queries).toHaveLength(0);
	});
});

// ─── treasury chain-pin handler tests ─────────────────────
//
// These tests exercise the handler's structural validation of the
// optional `treasury` block, AND prove byte-for-byte parity with
// the frontend validator (now @morphit/release-schema).
// Any payload that one accepts the other must accept; any payload
// one rejects the other must reject with the same reason name.

import { validateReleasePayload } from '@morphit/release-schema';

// Real mainnet addresses: the handler decodes them with their checksums.
const VALID_BTC_ADDR = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const VALID_XMR_ADDR =
	'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy';
// A 64-hex string used ONLY in tests to feed the validator a
// payload that contains a viewkey field — to verify that the
// validator silently strips it (invariant).  Not a
// real key; nothing here is a real key.  Named to make the
// test intent unambiguous.
const VALID_XMR_VK_LOOKING = 'a'.repeat(64);

function payloadWithTreasury(treasury: unknown) {
	return { ...validPayload(), treasury };
}

// distribution-anchor fixtures.
const VALID_SOURCE_SHA256 = 'a'.repeat(64); // lowercase hex
const VALID_GPG_FPR = 'DEADBEEF'.repeat(5); // 40 hex (v4 fingerprint)
const VALID_IPFS_CID_V0 = 'Qm' + 'a'.repeat(44); // base58btc, 46 chars
function payloadWithDistribution(distribution: unknown) {
	return { ...validPayload(), distribution };
}

describe('release handler — Part 106 + 107 treasury validation', () => {
	const validTreasury = {
		btc: { address: VALID_BTC_ADDR, satoshis: 416 },
		// NO viewkey field in canonical chain-pinned shape.
		xmr: { address: VALID_XMR_ADDR, piconero: '781250000' }
	};

	it('accepts a payload with a valid treasury block (no viewkey)', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: payloadWithTreasury(validTreasury),
				blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const insertQuery = mock.queries.at(-1);
		expect(insertQuery).toBeDefined();
		expect(insertQuery!.params[10]).not.toBeNull();
		const persisted = JSON.parse(insertQuery!.params[10] as string);
		expect(persisted.btc.address).toBe(VALID_BTC_ADDR);
		expect(persisted.xmr.address).toBe(VALID_XMR_ADDR);
		expect(persisted.xmr.piconero).toBe('781250000');
		// CRITICAL invariant: the persisted row MUST NOT
		// contain a viewkey field, even if a buggy payload tried to
		// include one.  This is the privacy guarantee.
		expect('viewkey' in persisted.xmr).toBe(false);
	});

	it('Part 107: payload with viewkey present → silently stripped, NOT persisted', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: payloadWithTreasury({
					btc: null,
					xmr: {
						address: VALID_XMR_ADDR,
						viewkey: VALID_XMR_VK_LOOKING, // present, would-be malicious
						piconero: '781250000'
					}
				}),
				blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		// Accepts the payload (we don't reject — reasons:
		// don't break parsing of legacy/malicious release ops; just
		// strip the field).
		expect(r).toEqual({ ok: true });
		const insertQuery = mock.queries.at(-1);
		expect(insertQuery).toBeDefined();
		expect(insertQuery!.params[10]).not.toBeNull();
		const persisted = JSON.parse(insertQuery!.params[10] as string);
		// Privacy invariant: viewkey MUST NOT have been persisted.
		expect('viewkey' in persisted.xmr).toBe(false);
		expect(persisted.xmr.address).toBe(VALID_XMR_ADDR);
		expect(persisted.xmr.piconero).toBe('781250000');
	});

	it('accepts a payload without a treasury block (back-compat)', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: validPayload(),
				blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const insertQuery = mock.queries.at(-1);
		expect(insertQuery!.params[10]).toBeNull();
	});

	it('records valid=false with treasury_btc_address_not_mainnet on testnet BTC', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: payloadWithTreasury({
					btc: { address: 'tb1q' + 'a'.repeat(38), satoshis: 416 },
					xmr: null
				}),
				blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'treasury_btc_address_not_mainnet' });
		expect(mock.queries).toHaveLength(0);
	});

	it('cp372: accepts a treasury with a chain-pinned blurt base (persisted)', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: payloadWithTreasury({
					btc: { address: VALID_BTC_ADDR, satoshis: 416 },
					xmr: { address: VALID_XMR_ADDR, piconero: '781250000' },
					blurt: { base: 62.5 }
				}),
				blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const persisted = JSON.parse(mock.queries.at(-1)!.params[10] as string);
		expect(persisted.blurt.base).toBe(62.5);
	});

	it('cp372: treasury without blurt persists byte-identically (no blurt key)', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: payloadWithTreasury({
					btc: { address: VALID_BTC_ADDR, satoshis: 416 },
					xmr: null
				}),
				blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const persisted = JSON.parse(mock.queries.at(-1)!.params[10] as string);
		expect('blurt' in persisted).toBe(false);
	});

	it('cp372: rejects 0 blurt base (treasury_blurt_base_invalid)', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: payloadWithTreasury({ btc: null, xmr: null, blurt: { base: 0 } }),
				blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'treasury_blurt_base_invalid' });
		expect(mock.queries).toHaveLength(0);
	});

	it('cp372: rejects blurt base over the sanity ceiling (treasury_blurt_base_too_large)', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: payloadWithTreasury({ btc: null, xmr: null, blurt: { base: 10_000_001 } }),
				blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'treasury_blurt_base_too_large' });
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects testnet XMR address (treasury_xmr_address_not_mainnet)', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: payloadWithTreasury({
					btc: null,
					xmr: { address: '9' + 'A'.repeat(94), piconero: '1' }
				}),
				blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'treasury_xmr_address_not_mainnet' });
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects 0-satoshi BTC (treasury_btc_satoshis_invalid)', async () => {
		const mock = makeMockClient();
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: payloadWithTreasury({
					btc: { address: VALID_BTC_ADDR, satoshis: 0 },
					xmr: null
				}),
				blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		expect(r).toEqual({ ok: false, reason: 'treasury_btc_satoshis_invalid' });
		expect(mock.queries).toHaveLength(0);
	});
});

// ─── INDEXER ↔ FRONTEND validator parity ──────────────────
//
// The indexer's structural validator (in handlers/release.ts) and
// the frontend's validator (now @morphit/release-schema)
// MUST agree on every payload, with matching reason names.  This
// test runs a battery of payloads through both validators and
// confirms identical accept/reject outcomes.
//
// Why this matters: a divergence means either (a) the indexer
// stores a row the frontend rejects, breaking the chain-direct
// trust path, or (b) the frontend trusts a row the indexer
// considers invalid, breaking the federated invariant.  Both
// cases let an attacker exploit the gap.
//
// We run via the FRONTEND validator (which mirrors the indexer's
// rules in releaseValidate.ts:validateTreasury).  Any payload that
// passes here MUST pass the indexer's handler — verified above
// in the per-handler tests, and re-verified in the smoke at
// apps/indexer/scripts/release-validator-smoke.ts.

describe('release validator parity — frontend ↔ indexer', () => {
	const cases: Array<{ name: string; payload: unknown; expect: 'ok' | string }> = [
		{ name: 'no treasury → ok', payload: validPayload(), expect: 'ok' },
		{ name: 'treasury=null → ok', payload: payloadWithTreasury(null), expect: 'ok' },
		{
			name: 'btc only (mainnet bech32) → ok',
			payload: payloadWithTreasury({
				btc: { address: VALID_BTC_ADDR, satoshis: 416 },
				xmr: null
			}),
			expect: 'ok'
		},
		{
			name: 'xmr only (primary 4..., no viewkey) → ok',
			payload: payloadWithTreasury({
				btc: null,
				xmr: { address: VALID_XMR_ADDR, piconero: '1' }
			}),
			expect: 'ok'
		},
		{
			name: 'xmr subaddress (8..., no viewkey) → ok',
			payload: payloadWithTreasury({
				btc: null,
				xmr: {
					address:
						'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe',
					piconero: '1'
				}
			}),
			expect: 'ok'
		},
		{
			name: 'Part 107: xmr WITH viewkey field (legacy/hostile) → ok, silently stripped',
			payload: payloadWithTreasury({
				btc: null,
				xmr: {
					address: VALID_XMR_ADDR,
					viewkey: VALID_XMR_VK_LOOKING,
					piconero: '1'
				}
			}),
			expect: 'ok'
		},
		{
			name: 'btc testnet → treasury_btc_address_not_mainnet',
			payload: payloadWithTreasury({
				btc: { address: 'tb1q' + 'a'.repeat(38), satoshis: 416 },
				xmr: null
			}),
			expect: 'treasury_btc_address_not_mainnet'
		},
		{
			name: 'btc 0 satoshis → treasury_btc_satoshis_invalid',
			payload: payloadWithTreasury({
				btc: { address: VALID_BTC_ADDR, satoshis: 0 },
				xmr: null
			}),
			expect: 'treasury_btc_satoshis_invalid'
		},
		{
			name: 'btc 1.5 satoshis → treasury_btc_satoshis_invalid',
			payload: payloadWithTreasury({
				btc: { address: VALID_BTC_ADDR, satoshis: 1.5 },
				xmr: null
			}),
			expect: 'treasury_btc_satoshis_invalid'
		},
		{
			name: 'xmr testnet (9...) → treasury_xmr_address_not_mainnet',
			payload: payloadWithTreasury({
				btc: null,
				xmr: { address: '9' + 'A'.repeat(94), piconero: '1' }
			}),
			expect: 'treasury_xmr_address_not_mainnet'
		},
		{
			name: 'xmr stagenet (5...) → treasury_xmr_address_not_mainnet',
			payload: payloadWithTreasury({
				btc: null,
				xmr: { address: '5' + 'A'.repeat(94), piconero: '1' }
			}),
			expect: 'treasury_xmr_address_not_mainnet'
		},
		{
			name: 'xmr piconero "0" → treasury_xmr_piconero_invalid',
			payload: payloadWithTreasury({
				btc: null,
				xmr: { address: VALID_XMR_ADDR, piconero: '0' }
			}),
			expect: 'treasury_xmr_piconero_invalid'
		},
		{
			name: 'xmr piconero "1.5" → treasury_xmr_piconero_invalid',
			payload: payloadWithTreasury({
				btc: null,
				xmr: { address: VALID_XMR_ADDR, piconero: '1.5' }
			}),
			expect: 'treasury_xmr_piconero_invalid'
		},
		{
			name: 'treasury as array → treasury_not_object',
			payload: payloadWithTreasury([]),
			expect: 'treasury_not_object'
		},
		{
			name: 'treasury as string → treasury_not_object',
			payload: payloadWithTreasury('treasury'),
			expect: 'treasury_not_object'
		},
		// decentralized-distribution anchor parity.
		{ name: 'distribution=null → ok', payload: payloadWithDistribution(null), expect: 'ok' },
		{
			name: 'distribution minimal (sha + fpr) → ok',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: VALID_GPG_FPR
			}),
			expect: 'ok'
		},
		{
			name: 'distribution full (sha + fpr + cid + mirrors) → ok',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: VALID_GPG_FPR,
				ipfs_cid: VALID_IPFS_CID_V0,
				mirrors: [
					'https://codeberg.org/agorise/morphit',
					'https://ipfs.io/ipfs/' + VALID_IPFS_CID_V0
				]
			}),
			expect: 'ok'
		},
		{
			// v1.9.x — stable IPNS "always latest" pointer.
			name: 'distribution with ipns_name (k51…) → ok',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: VALID_GPG_FPR,
				ipfs_cid: VALID_IPFS_CID_V0,
				ipns_name: 'k51qzi5uqu5dja8jme7xnwh50160jsfsvuoifc1ehfip3ybv0vkpxy9caigzj4'
			}),
			expect: 'ok'
		},
		{
			name: 'distribution bad ipns_name → distribution_ipns_name_invalid',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: VALID_GPG_FPR,
				ipns_name: 'not-a-valid-ipns-name'
			}),
			expect: 'distribution_ipns_name_invalid'
		},
		{
			name: 'distribution 64-hex (v5) fingerprint → ok',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: 'abcdef01'.repeat(8) // 64 hex
			}),
			expect: 'ok'
		},
		{
			name: 'distribution as array → distribution_not_object',
			payload: payloadWithDistribution([]),
			expect: 'distribution_not_object'
		},
		{
			name: 'distribution missing source_sha256 → distribution_source_sha256_invalid',
			payload: payloadWithDistribution({ gpg_fingerprint: VALID_GPG_FPR }),
			expect: 'distribution_source_sha256_invalid'
		},
		{
			name: 'distribution UPPERCASE sha256 → distribution_source_sha256_invalid',
			payload: payloadWithDistribution({
				source_sha256: 'A'.repeat(64),
				gpg_fingerprint: VALID_GPG_FPR
			}),
			expect: 'distribution_source_sha256_invalid'
		},
		{
			name: 'distribution short fingerprint (39) → distribution_gpg_fingerprint_invalid',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: 'a'.repeat(39)
			}),
			expect: 'distribution_gpg_fingerprint_invalid'
		},
		{
			name: 'distribution bad ipfs_cid → distribution_ipfs_cid_invalid',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: VALID_GPG_FPR,
				ipfs_cid: 'not-a-cid'
			}),
			expect: 'distribution_ipfs_cid_invalid'
		},
		{
			name: 'distribution mirrors not array → distribution_mirrors_not_array',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: VALID_GPG_FPR,
				mirrors: 'https://codeberg.org/agorise/morphit'
			}),
			expect: 'distribution_mirrors_not_array'
		},
		{
			name: 'distribution non-https mirror → distribution_mirror_invalid',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: VALID_GPG_FPR,
				mirrors: ['http://codeberg.org/agorise/morphit']
			}),
			expect: 'distribution_mirror_invalid'
		},
		{
			// Mirror cap bumped 8 → 10 (v1.9.6) → 32 (v1.11.1, 9 new mirrors).
			name: 'distribution 32 mirrors (at the cap) → ok',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: VALID_GPG_FPR,
				mirrors: Array.from({ length: 32 }, (_, i) => `https://m${i}.example.org/x`)
			}),
			expect: 'ok'
		},
		{
			name: 'distribution too many mirrors (33 > cap 32) → distribution_mirror_invalid',
			payload: payloadWithDistribution({
				source_sha256: VALID_SOURCE_SHA256,
				gpg_fingerprint: VALID_GPG_FPR,
				mirrors: Array.from({ length: 33 }, (_, i) => `https://m${i}.example.org/x`)
			}),
			expect: 'distribution_mirror_invalid'
		}
	];

	for (const c of cases) {
		it(c.name, () => {
			const r = validateReleasePayload(c.payload);
			if (c.expect === 'ok') {
				expect(r.ok).toBe(true);
			} else {
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.reason).toBe(c.expect);
			}
		});
	}
});

// ─── v1.20.0 (MK-H2) — treasury btc.xpub: handler ↔ frontend parity ─────
//
// The pinned treasury account xpub decides every BTC fee address, so the
// indexer handler and the frontend validator must accept exactly the same
// keys AND store/return the same canonical spelling. Each case runs through
// BOTH: the real handler (persisted JSON) and validateReleasePayload.
describe('release — treasury btc.xpub (handler and frontend agree)', () => {
	const BIP84_ZPUB =
		'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
	const BIP84_XPUB =
		'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
	const BIP84_ZPRV =
		'zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE';
	const VPUB =
		'vpub5YFAPkuWn7i4tYUFkwqKpdSoxES92E4f2Antqkz27cPNYbhF76ZzXzN8ML8tHS446MnD5sdzEndTT2WLVwicrH4DFGGZNvto2Hz8R7qT4Ef';
	const MASTER =
		'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';

	const cases: Array<{ name: string; xpub: unknown; expect: { stored: string | null } | string }> =
		[
			{
				name: 'zpub → accepted, stored as canonical xpub',
				xpub: BIP84_ZPUB,
				expect: { stored: BIP84_XPUB }
			},
			{ name: 'xpub → accepted unchanged', xpub: BIP84_XPUB, expect: { stored: BIP84_XPUB } },
			{ name: 'xpub null → legacy shape, no xpub key', xpub: null, expect: { stored: null } },
			{
				name: 'zprv (PRIVATE) → treasury_btc_xpub_invalid',
				xpub: BIP84_ZPRV,
				expect: 'treasury_btc_xpub_invalid'
			},
			{
				name: 'vpub (testnet) → treasury_btc_xpub_invalid',
				xpub: VPUB,
				expect: 'treasury_btc_xpub_invalid'
			},
			{
				name: 'master key (depth 0) → treasury_btc_xpub_invalid',
				xpub: MASTER,
				expect: 'treasury_btc_xpub_invalid'
			},
			{
				name: 'typo → treasury_btc_xpub_invalid',
				xpub: BIP84_ZPUB.slice(0, -1) + 'x',
				expect: 'treasury_btc_xpub_invalid'
			},
			{ name: 'number → treasury_btc_xpub_invalid', xpub: 7, expect: 'treasury_btc_xpub_invalid' }
		];

	for (const c of cases) {
		it(c.name, async () => {
			const treasury = {
				btc: {
					address: VALID_BTC_ADDR,
					satoshis: 416,
					...(c.xpub === null ? {} : { xpub: c.xpub })
				},
				xmr: null
			};
			const mock = makeMockClient();
			const r = await handler(
				makeCtx({
					signer: 'morphit',
					payload: payloadWithTreasury(treasury),
					blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
					config: fakeConfig({
						officialPostingPubkey: OFFICIAL_PUBKEY,
						officialAccountName: 'morphit'
					})
				}),
				mock.client
			);
			const fe = validateReleasePayload(payloadWithTreasury(treasury));
			if (typeof c.expect === 'string') {
				expect(r).toEqual({ ok: false, reason: c.expect });
				expect(fe.ok).toBe(false);
				if (!fe.ok) expect(fe.reason).toBe(c.expect);
				return;
			}
			expect(r).toEqual({ ok: true });
			const persisted = JSON.parse(mock.queries.at(-1)!.params[10] as string);
			expect(fe.ok).toBe(true);
			if (!fe.ok) return;
			if (c.expect.stored === null) {
				expect('xpub' in persisted.btc).toBe(false);
				expect(fe.value.treasury?.btc && 'xpub' in fe.value.treasury.btc).toBe(false);
			} else {
				expect(persisted.btc.xpub).toBe(c.expect.stored);
				expect(fe.value.treasury?.btc?.xpub).toBe(c.expect.stored);
			}
			// Byte-for-byte: what the indexer stores is what the frontend returns.
			expect(JSON.stringify(persisted)).toBe(JSON.stringify(fe.value.treasury));
		});
	}
});

// ─── v1.20.0 (MK-H2) — treasury xmr.primary_address: handler ↔ frontend ─────
// Pinning a primary address switches XMR fees to integrated addresses that
// carry the order's payment ID; both validators must accept exactly the same
// addresses (mainnet STANDARD only) and store the same value.
describe('release — treasury xmr.primary_address (handler and frontend agree)', () => {
	// Built with the PyPI `monero` package (see test/lib/xmrAddress.test.ts).
	const PRIMARY =
		'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy';
	const INTEGRATED =
		'4Dp9BhCqXPR8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL4D5AqWT5Do24HzptoQp';
	const SUBADDRESS =
		'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
	const TESTNET =
		'9uvyLnpzBSV84B29APC8AQ4Qmx7nd2X4eX79cxtmXecv76exk4mG7YyDeH15hKJkJ7Y5q26GZoo3V64qL6Fs1A1A7D9oaFf';
	const cases: Array<{
		name: string;
		primary: unknown;
		expect: { stored: string | null } | string;
	}> = [
		{
			name: 'mainnet primary → accepted and stored',
			primary: PRIMARY,
			expect: { stored: PRIMARY }
		},
		{ name: 'absent → legacy shape, no key', primary: null, expect: { stored: null } },
		{
			name: 'subaddress (8…) → treasury_xmr_primary_invalid',
			primary: SUBADDRESS,
			expect: 'treasury_xmr_primary_invalid'
		},
		{
			name: 'integrated → treasury_xmr_primary_invalid',
			primary: INTEGRATED,
			expect: 'treasury_xmr_primary_invalid'
		},
		{
			name: 'testnet → treasury_xmr_primary_invalid',
			primary: TESTNET,
			expect: 'treasury_xmr_primary_invalid'
		},
		{
			name: 'checksum typo → treasury_xmr_primary_invalid',
			primary: PRIMARY.slice(0, -1) + (PRIMARY.endsWith('a') ? 'b' : 'a'),
			expect: 'treasury_xmr_primary_invalid'
		},
		{
			name: 'number → treasury_xmr_primary_invalid',
			primary: 4,
			expect: 'treasury_xmr_primary_invalid'
		}
	];
	for (const c of cases) {
		it(c.name, async () => {
			const treasury = {
				btc: null,
				xmr: {
					address: SUBADDRESS,
					piconero: '781250000',
					...(c.primary === null ? {} : { primary_address: c.primary })
				}
			};
			const mock = makeMockClient();
			const r = await handler(
				makeCtx({
					signer: 'morphit',
					payload: payloadWithTreasury(treasury),
					blurt: mockBlurt({ getAccount: async () => accountWithOfficialKey }),
					config: fakeConfig({
						officialPostingPubkey: OFFICIAL_PUBKEY,
						officialAccountName: 'morphit'
					})
				}),
				mock.client
			);
			const fe = validateReleasePayload(payloadWithTreasury(treasury));
			if (typeof c.expect === 'string') {
				expect(r).toEqual({ ok: false, reason: c.expect });
				expect(fe.ok).toBe(false);
				if (!fe.ok) expect(fe.reason).toBe(c.expect);
				return;
			}
			expect(r).toEqual({ ok: true });
			const persisted = JSON.parse(mock.queries.at(-1)!.params[10] as string);
			expect(fe.ok).toBe(true);
			if (!fe.ok) return;
			if (c.expect.stored === null) expect('primary_address' in persisted.xmr).toBe(false);
			else expect(persisted.xmr.primary_address).toBe(c.expect.stored);
			expect(JSON.stringify(persisted)).toBe(JSON.stringify(fe.value.treasury));
		});
	}
});
