/**
 * No ops-cli test may reach the internet (v1.21.4 CI, 2026-10-09).
 *
 * Five upgrade tests passed here and timed out in CI: their indexer.env was
 * written where the upgrade does not read it, so the upgrade fell back to the
 * real public Blurt nodes. In a sandbox without internet those fail at once;
 * on the CI runner they answered, slowly, with @morphit's real history, and
 * every test ran past its time limit. A test that passes only because the
 * network is down is not a test of the code.
 *
 * Every connection a test opens is checked: loopback, private networks
 * (RFC 1918, ULA, link-local) and unix sockets are allowed; anything else is
 * refused at once (as a dead host would be) and the test FAILS, naming the
 * host. Registered in vitest.config.ts (setupFiles).
 */
import net from 'node:net';
import { afterEach, expect } from 'vitest';

const attempts: string[] = [];

/** Loopback, private or link-local: not the internet. */
export function isLocalHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, '').toLowerCase();
	if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
	if (net.isIPv4(h))
		return (
			/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/.test(h) ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(h)
		);
	if (net.isIPv6(h)) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
	return false;
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
	const first = args[0];
	let host: string | undefined;
	let path: string | undefined;
	if (Array.isArray(first)) {
		const o = first[0] as { host?: string; path?: string } | undefined;
		host = o?.host;
		path = o?.path;
	} else if (first !== null && typeof first === 'object') {
		const o = first as { host?: string; path?: string };
		host = o.host;
		path = o.path;
	} else if (typeof first === 'number') host = typeof args[1] === 'string' ? args[1] : 'localhost';
	else if (typeof first === 'string') path = first;
	if (path === undefined && host !== undefined && !isLocalHost(host)) {
		attempts.push(host);
		const err = Object.assign(
			new Error(`test network guard: ${host} is on the internet, which tests never reach`),
			{ code: 'ENETUNREACH' }
		);
		process.nextTick(() => this.destroy(err));
		return this;
	}
	return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

afterEach(() => {
	const tried = [...new Set(attempts.splice(0))];
	expect(tried, 'this test tried to reach the internet').toEqual([]);
});
