/**
 * The test network guard (test/setup/noInternet.ts) judges a connection by
 * the address it goes to (v1.21.4 CI, 2026-10-09: its first version judged by
 * name and refused CI's database, the service container `postgres`).
 */
import { describe, expect, it } from 'vitest';
import { guardVerdict, isLocalAddress } from './setup/noInternet.ts';

describe('the test network guard', () => {
	it("allows a container name that resolves to a private address (CI's `postgres`)", () => {
		expect(guardVerdict('postgres', ['172.18.0.2'])).toBe('allow');
		expect(guardVerdict('postgres', ['127.0.0.1'])).toBe('allow');
		expect(guardVerdict('db', null)).toBe('allow');
	});

	it('refuses a name that resolves to a public address (the real Blurt nodes)', () => {
		expect(guardVerdict('rpc.blurt.blog', ['1.1.1.1'])).toBe('refuse');
		expect(guardVerdict('mixed.example', ['10.0.0.1', '8.8.8.8'])).toBe('refuse');
	});

	it('refuses an internet-style name even where it does not resolve (a sandbox without DNS)', () => {
		expect(guardVerdict('rpc.example.invalid', null)).toBe('refuse');
		expect(guardVerdict('box.internal', null)).toBe('allow');
	});

	it('addresses: loopback, private and link-local are local; public ones are not', () => {
		for (const a of [
			'127.0.0.1',
			'10.1.2.3',
			'172.16.0.1',
			'192.168.1.1',
			'169.254.1.1',
			'::1',
			'fd00::1',
			'::ffff:127.0.0.1'
		])
			expect(isLocalAddress(a), a).toBe(true);
		for (const a of ['8.8.8.8', '172.32.0.1', '2606:4700::1', '::ffff:8.8.8.8'])
			expect(isLocalAddress(a), a).toBe(false);
		expect(guardVerdict('8.8.8.8', null)).toBe('refuse');
	});
});
