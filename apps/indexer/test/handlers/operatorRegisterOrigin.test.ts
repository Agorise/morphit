/**
 * operatorRegister — origin scheme policy (v1.11.0, hidden-service nodes).
 *
 * Clearnet origins must be https. Tor/I2P/Lokinet hidden-service origins are
 * http:// (encryption is at the network layer) and must be ACCEPTED so a node
 * with no clearnet domain can advertise itself to the federated directory.
 * Everything else (http on clearnet, junk hosts) stays rejected, and all the
 * existing SSRF guards remain in force.
 */
import { describe, it, expect } from 'vitest';
import { validate } from '$indexer/handlers/operatorRegister';

const base = { tag: 'alice', display_name: 'Alice Market' };
const reason = (r: ReturnType<typeof validate>): string | null =>
	'reason' in r ? r.reason : null;
const origin = (r: ReturnType<typeof validate>): string | null =>
	'reason' in r ? null : r.origin;

// A real 56-char v3 onion (morphitlat's, from the live node).
const ONION = 'uecm7rzkz2zek6wefgth2qsuhbynlwdtx6b45y65tzde6ulror6ccpqd.onion';

describe('operatorRegister origin — clearnet still https-only', () => {
	it('accepts an https clearnet origin', () => {
		const r = validate({ ...base, origin: 'https://morphit.example' });
		expect(reason(r)).toBeNull();
		expect(origin(r)).toBe('https://morphit.example');
	});
	it('rejects http on a clearnet host', () => {
		expect(reason(validate({ ...base, origin: 'http://morphit.example' }))).toBe('origin_bad_scheme');
	});
	it('rejects a non-http(s) scheme', () => {
		expect(reason(validate({ ...base, origin: 'ftp://morphit.example' }))).toBe('origin_bad_scheme');
	});
});

describe('operatorRegister origin — hidden services accept http', () => {
	it('accepts an http Tor v3 onion origin', () => {
		const r = validate({ ...base, origin: `http://${ONION}` });
		expect(reason(r)).toBeNull();
		expect(origin(r)).toBe(`http://${ONION}`);
	});
	it('accepts an http I2P .b32.i2p origin', () => {
		const addr = `http://${'a'.repeat(52)}.b32.i2p`;
		expect(reason(validate({ ...base, origin: addr }))).toBeNull();
	});
	it('accepts an http named I2P .i2p origin', () => {
		expect(reason(validate({ ...base, origin: 'http://morphit.i2p' }))).toBeNull();
	});
	it('accepts an http Lokinet .loki origin', () => {
		expect(reason(validate({ ...base, origin: 'http://morphit.loki' }))).toBeNull();
	});
	it('rejects a malformed onion (wrong length) on http', () => {
		// v2-length / truncated onion is not a valid v3 host → not a hidden
		// service → http rejected.
		expect(reason(validate({ ...base, origin: 'http://short.onion' }))).toBe('origin_bad_scheme');
	});
	it('still accepts an https onion (TLS-fronted, rare but legal)', () => {
		expect(reason(validate({ ...base, origin: `https://${ONION}` }))).toBeNull();
	});
});

describe('operatorRegister origin — SSRF guards unaffected by the relaxation', () => {
	it('still rejects http loopback (not a hidden service)', () => {
		expect(reason(validate({ ...base, origin: 'http://127.0.0.1' }))).toBe('origin_bad_scheme');
	});
	it('still rejects https RFC1918 private', () => {
		expect(reason(validate({ ...base, origin: 'https://10.1.2.3' }))).toBe('origin_private');
	});
	it('still rejects a path on an onion origin', () => {
		expect(reason(validate({ ...base, origin: `http://${ONION}/v1/health` }))).toBe('origin_has_path');
	});
});
