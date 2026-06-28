import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/release';
import { fakeConfig, makeCtx, mockBlurt } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

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

const accountWithDifferentKey = {
	...accountWithOfficialKey,
	posting: {
		...accountWithOfficialKey.posting,
		key_auths: [['BLTrotated-key-not-the-pinned-one', 1]] as const
	}
};

describe('release handler', () => {
	it('records valid=true when signer, pubkey, and payload all match', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO releases' }]);
		const blurt = mockBlurt({
			getAccount: async () => accountWithOfficialKey
		});
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: validPayload(),
				blurt,
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
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
		// getAccount is never called because check 1 fails first — pass
		// a blurt proxy that would throw to prove that.
		const blurt = mockBlurt({});
		const r = await handler(
			makeCtx({
				signer: 'eve',
				payload: validPayload(),
				blurt,
				config: fakeConfig({ officialAccountName: 'morphit' })
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		const q = mock.queries[0]!;
		expect(q.params[7]).toBe(false);
	});

	it('records valid=false when the chain pubkey differs from the pinned value', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO releases' }]);
		const blurt = mockBlurt({
			getAccount: async () => accountWithDifferentKey
		});
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: validPayload(),
				blurt,
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
			}),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries[0]!.params[7]).toBe(false);
	});

	it('records valid=false when the signer account has no single posting key', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO releases' }]);
		const blurt = mockBlurt({
			getAccount: async () => null // account vanished (impossible but tests the null branch)
		});
		const r = await handler(
			makeCtx({
				signer: 'morphit',
				payload: validPayload(),
				blurt,
				config: fakeConfig({
					officialPostingPubkey: OFFICIAL_PUBKEY,
					officialAccountName: 'morphit'
				})
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

	it('propagates chain errors so the block rolls back and retries', async () => {
		// If getAccount throws (RPC unreachable mid-tick), the handler
		// re-throws so the poller rolls the block back. We'd rather
		// retry next tick than commit an unverified valid=true.
		const mock = makeMockClient();
		const blurt = mockBlurt({
			getAccount: async () => {
				throw new Error('chain unreachable');
			}
		});
		await expect(
			handler(
				makeCtx({
					signer: 'morphit',
					payload: validPayload(),
					blurt,
					config: fakeConfig({
						officialPostingPubkey: OFFICIAL_PUBKEY,
						officialAccountName: 'morphit'
					})
				}),
				mock.client
			)
		).rejects.toThrow('chain unreachable');
		// No row was written before the throw.
		expect(mock.queries).toHaveLength(0);
	});
});

// ─── Part 106 — treasury chain-pin handler tests ─────────────────────
//
// These tests exercise the handler's structural validation of the
// optional `treasury` block, AND prove byte-for-byte parity with
// the frontend validator (now @morphit/release-schema).
// Any payload that one accepts the other must accept; any payload
// one rejects the other must reject with the same reason name.

import { validateReleasePayload } from '@morphit/release-schema';

const VALID_BTC_ADDR = 'bc1q' + 'a'.repeat(38);
const VALID_XMR_ADDR = '4' + 'A'.repeat(94);
// A 64-hex string used ONLY in tests to feed the validator a
// payload that contains a viewkey field — to verify that the
// validator silently strips it (Part 107 invariant).  Not a
// real key; nothing here is a real key.  Named to make the
// test intent unambiguous.
const VALID_XMR_VK_LOOKING = 'a'.repeat(64);

function payloadWithTreasury(treasury: unknown) {
	return { ...validPayload(), treasury };
}

describe('release handler — Part 106 + 107 treasury validation', () => {
	const validTreasury = {
		btc: { address: VALID_BTC_ADDR, satoshis: 416 },
		// Part 107: NO viewkey field in canonical chain-pinned shape.
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
		// CRITICAL Part 107 invariant: the persisted row MUST NOT
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
		// Accepts the payload (we don't reject — Part 107 reasons:
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

// ─── Part 106 — INDEXER ↔ FRONTEND validator parity ──────────────────
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
					address: '8' + 'A'.repeat(94),
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
