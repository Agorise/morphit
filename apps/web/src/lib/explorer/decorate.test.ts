import { describe, it, expect } from 'vitest';
import { decorateOp } from './decorate';
import { OP_IDS } from '../net/config';

const releaseOp = (json: unknown) => ({
	required_auths: [],
	required_posting_auths: ['morphit'],
	id: OP_IDS.releaseDiscovery,
	json
});

describe('decorateOp — release announcement version (cp439)', () => {
	it('surfaces the version from a string-encoded payload', () => {
		const dec = decorateOp('custom_json', releaseOp(JSON.stringify({ version: '1.1.0' })));
		expect(dec.kind).toBe('morphit_release');
		expect(dec.labelKey).toBe('morphit_release_versioned');
		expect(dec.values).toEqual({ version: '1.1.0' });
	});

	it('surfaces the version from an already-parsed payload object', () => {
		const dec = decorateOp('custom_json', releaseOp({ version: '2.0.3' }));
		expect(dec.labelKey).toBe('morphit_release_versioned');
		expect(dec.values).toEqual({ version: '2.0.3' });
	});

	it('falls back to the plain label when the version is missing', () => {
		const dec = decorateOp('custom_json', releaseOp(JSON.stringify({ hash_manifest: {} })));
		expect(dec.kind).toBe('morphit_release');
		expect(dec.labelKey).toBe('morphit_release');
		expect(dec.values).toBeUndefined();
	});

	it('falls back to the plain label when the json is unparseable', () => {
		const dec = decorateOp('custom_json', releaseOp('not json at all'));
		expect(dec.labelKey).toBe('morphit_release');
		expect(dec.values).toBeUndefined();
	});

	it('ignores a non-string version', () => {
		const dec = decorateOp('custom_json', releaseOp(JSON.stringify({ version: 110 })));
		expect(dec.labelKey).toBe('morphit_release');
	});

	it('leaves other Morphit custom_json ops untouched', () => {
		const dec = decorateOp('custom_json', { id: OP_IDS.chatMessage, json: '{}' });
		expect(dec.kind).toBe('morphit_chat');
		expect(dec.labelKey).toBe('morphit_chat');
		expect(dec.values).toBeUndefined();
	});
});
