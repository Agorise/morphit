/**
 * The fast chat paths (head tailer, and the federation intake, which calls the
 * same locateChatOp) must be a strict SUBSET of what the durable dispatcher
 * stores. The dispatcher refuses a NUL or an unpaired surrogate always, and
 * from the consensus activation time (2026-11-01) U+FFFE / U+FFFF and a payload
 * nested deeper than MAX_PAYLOAD_DEPTH. A message the fast path showed live
 * (and pushed) that the durable pass then refuses appears, notifies, and is
 * never stored. The fast path applies the strictest form at all times.
 */
import { describe, expect, it } from 'vitest';
import { locateChatOp, FAST_PATH_MAX_PAYLOAD_DEPTH } from '../../src/indexer/headTailer';
import { MAX_PAYLOAD_DEPTH } from '../../src/indexer/dispatcher';

function chatOp(header: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: ['alice'],
			id: 'morphit_chat_v1',
			json: JSON.stringify({ recipient: 'bob', ciphertext: 'QUJD', header, ...extra })
		}
	] as never;
}

function nested(depth: number): unknown {
	let v: unknown = 'x';
	for (let i = 0; i < depth; i++) v = { a: v };
	return v;
}

describe('locateChatOp: never emits what the durable dispatcher refuses', () => {
	it('a normal message is located', () => {
		expect(locateChatOp(chatOp({ client_tag: 't1' }))).not.toBeNull();
	});
	it.each([
		['U+FFFF in a header value', { client_tag: 't1', note: 'x￿' }],
		['U+FFFE in a header key', { client_tag: 't1', ['k￾']: 1 }],
		['NUL in a header value', { client_tag: 't1', note: 'x\u0000' }],
		['an unpaired surrogate', { client_tag: 't1', note: 'x\uD800' }],
		['nesting past the cap', { client_tag: 't1', deep: nested(MAX_PAYLOAD_DEPTH + 2) }]
	])('%s: skipped', (_label, header) => {
		expect(locateChatOp(chatOp(header as Record<string, unknown>))).toBeNull();
	});
	it('the fast-path depth cap is the dispatcher cap', () => {
		expect(FAST_PATH_MAX_PAYLOAD_DEPTH).toBe(MAX_PAYLOAD_DEPTH);
	});
});
