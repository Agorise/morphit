import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/settings';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

// A short, valid-looking base64 blob for the happy path.
const ENC = 'q83vASNFZ4mrze8BI0VniYABAgMEBQ==';

describe('settings handler (morphit_settings_v1)', () => {
	it('rejects a non-object payload', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: 'nope' as unknown }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'payload_not_object' });
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects an unsupported version', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: { v: 2, enc: ENC } }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'version_unsupported' });
	});

	it('rejects a missing / non-string enc', async () => {
		const mock = makeMockClient();
		expect(await handler(makeCtx({ payload: { v: 1 } }), mock.client)).toEqual({
			ok: false,
			reason: 'enc_not_string'
		});
		expect(await handler(makeCtx({ payload: { v: 1, enc: 123 } }), mock.client)).toEqual({
			ok: false,
			reason: 'enc_not_string'
		});
		expect(await handler(makeCtx({ payload: { v: 1, enc: '' } }), mock.client)).toEqual({
			ok: false,
			reason: 'enc_not_string'
		});
	});

	it('rejects an over-large enc (bloat guard, 64 KB cap)', async () => {
		const mock = makeMockClient();
		const huge = 'A'.repeat(64 * 1024 + 1);
		const r = await handler(makeCtx({ payload: { v: 1, enc: huge } }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'enc_too_large' });
		expect(mock.queries).toHaveLength(0);
	});

	it('rejects non-base64 enc', async () => {
		const mock = makeMockClient();
		const r = await handler(makeCtx({ payload: { v: 1, enc: 'not base64 {{' } }), mock.client);
		expect(r).toEqual({ ok: false, reason: 'enc_not_base64' });
	});

	it('stores a valid encrypted blob (latest-by-block upsert into user_settings)', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO user_settings', rowCount: 1 }]);
		const r = await handler(
			makeCtx({ signer: 'alice', payload: { v: 1, enc: ENC } }),
			mock.client
		);
		expect(r).toEqual({ ok: true });
		expect(mock.queries).toHaveLength(1);
		// The signer keys the row (account = signer); the blob is stored opaque.
		expect(mock.queries[0]!.params).toContain('alice');
		expect(mock.queries[0]!.params).toContain(ENC);
	});
});
