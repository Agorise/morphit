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
 * Every connection a test opens is checked by the ADDRESS it goes to, not the
 * name: loopback, private networks (RFC 1918, ULA, link-local) and unix
 * sockets are allowed — CI's database is the service container `postgres`, a
 * name that resolves to a private address (the first version of this guard
 * judged by name and refused it). A name that resolves to a public address,
 * or an internet-style name (with a dot) that does not resolve at all, is
 * refused at once and the test FAILS, naming the host. Registered in
 * vitest.config.ts (setupFiles).
 */
import dns from 'node:dns';
import net from 'node:net';
import { afterEach, expect } from 'vitest';

const attempts: string[] = [];

/** A loopback, private or link-local ADDRESS (or a local name). PURE. */
export function isLocalAddress(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, '').toLowerCase();
	if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
	if (net.isIPv4(h))
		return (
			/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/.test(h) ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(h)
		);
	if (net.isIPv6(h)) {
		const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)?.[1];
		if (v4 !== undefined) return isLocalAddress(v4);
		return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
	}
	return false;
}

/** What the guard does with a connection to `host`, given what it resolved
 *  to (`null`: it did not resolve). PURE. */
export function guardVerdict(host: string, resolved: readonly string[] | null): 'allow' | 'refuse' {
	if (net.isIP(host.replace(/^\[|\]$/g, '')) !== 0 || host === 'localhost')
		return isLocalAddress(host) ? 'allow' : 'refuse';
	if (resolved === null) {
		// An internet-style name that does not resolve was still an attempt to
		// reach the internet (a sandbox without DNS must not hide it); a
		// single-label name (a container, `postgres`) or a local suffix is not.
		const local = !host.includes('.') || /\.(localhost|local|internal|lan|home\.arpa)$/i.test(host);
		return local ? 'allow' : 'refuse';
	}
	return resolved.length > 0 && resolved.every(isLocalAddress) ? 'allow' : 'refuse';
}

const refusal = (host: string): Error =>
	Object.assign(
		new Error(`test network guard: ${host} is on the internet, which tests never reach`),
		{
			code: 'ENETUNREACH'
		}
	);

type LookupCb = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;

/** dns.lookup, then the guard on the addresses it gave. */
function guardedLookup(hostname: string, options: unknown, cb?: unknown): void {
	const callback = (typeof options === 'function' ? options : cb) as LookupCb;
	const opts = typeof options === 'function' ? {} : options;
	dns.lookup(
		hostname,
		opts as dns.LookupOptions,
		((err: NodeJS.ErrnoException | null, address: unknown, family?: number) => {
			const list =
				err !== null
					? null
					: Array.isArray(address)
						? (address as Array<{ address: string }>).map((a) => a.address)
						: [String(address)];
			if (guardVerdict(hostname, list) === 'refuse') {
				attempts.push(hostname);
				callback(err ?? refusal(hostname));
				return;
			}
			callback(err, address, family);
		}) as never
	);
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
	let a = args;
	// connect(port[, host][, cb]) → the options form, so a lookup can be set.
	if (typeof a[0] === 'number' || (typeof a[0] === 'string' && /^\d+$/.test(a[0]))) {
		const host = typeof a[1] === 'string' ? a[1] : 'localhost';
		const cb = a.find((x) => typeof x === 'function');
		a = [{ port: Number(a[0]), host }, ...(cb ? [cb] : [])];
	}
	const first = Array.isArray(a[0]) ? (a[0][0] as Record<string, unknown>) : a[0];
	if (first !== null && typeof first === 'object') {
		const o = first as { host?: string; path?: string; lookup?: unknown };
		if (o.path === undefined && typeof o.host === 'string') {
			const host = o.host;
			if (net.isIP(host.replace(/^\[|\]$/g, '')) !== 0 || host === 'localhost') {
				if (guardVerdict(host, null) === 'refuse') {
					attempts.push(host);
					process.nextTick(() => this.destroy(refusal(host)));
					return this;
				}
			} else if (o.lookup === undefined) {
				const withLookup = { ...o, lookup: guardedLookup };
				a = Array.isArray(a[0])
					? [[withLookup, ...a[0].slice(1)], ...a.slice(1)]
					: [withLookup, ...a.slice(1)];
			}
		}
	}
	return (realConnect as (...x: unknown[]) => net.Socket).apply(this, a);
} as typeof net.Socket.prototype.connect;

afterEach(() => {
	const tried = [...new Set(attempts.splice(0))];
	expect(tried, 'this test tried to reach the internet').toEqual([]);
});
