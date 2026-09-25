/**
 * isLocalTransportFault — "was that our transport, or their instance?"
 *
 * This is the question the federation gets wrong in the most expensive
 * direction. Blame the peer for our own dead Tor daemon and the directory
 * fills up with `unreachable` rows for instances that are perfectly healthy;
 * blame ourselves for a peer that is genuinely down and we keep a route open
 * to nothing.
 *
 * TWO LAYERS ON PURPOSE.
 *
 * The `describe('real errors')` block below makes actual connections to a
 * closed local port and asserts on WHATEVER undici raises. It is the layer
 * that matters, because the bug this function was written to fix was not a
 * logic error — it was a correct-looking `err instanceof ProxyUnavailableError`
 * written against an error shape that fetch() does not produce. No hand-built
 * fixture would have caught that, since a hand-built fixture is built from the
 * same wrong belief as the code. Only a real error can contradict it.
 *
 * The hand-built block then pins the parts a real error cannot reach on demand
 * — a proxy on a DIFFERENT address, a cyclic cause chain — where constructing
 * the shape is the only way to get it.
 */
import { describe, it, expect } from 'vitest';
import {
	isLocalTransportFault,
	causeChain,
	ProxyUnavailableError,
	ProxyConnectRejectedError,
	isProxyUnavailable,
	localFaultConfidence,
	type HiddenServiceProxyConfig
} from '@morphit/hidden-transport';
import { postJsonViaHiddenService, dispatcherFor } from '$indexer/hiddenServicePool';
import { fetchJsonViaHiddenService } from '$indexer/hiddenServiceFetch';

/** Port 1 is reserved and never listening, so a connect to it is refused
 *  immediately — no timeout, no network, no flake. */
const DEAD: HiddenServiceProxyConfig = { torSocks: '127.0.0.1:1', i2pHttpProxy: '127.0.0.1:1' };
const BLANK: HiddenServiceProxyConfig = { torSocks: '', i2pHttpProxy: '' };

const ONION = `http://${'a'.repeat(56)}.onion`;
const I2P = `http://${'b'.repeat(52)}.b32.i2p`;
const LOKI = 'http://peer-that-does-not-resolve.loki';

async function errorFrom(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (err) {
		return err;
	}
	throw new Error('expected the call to fail, and it did not');
}

describe('real errors from a dead local proxy', () => {
	it('classifies a refused Tor SOCKS port as OUR fault', async () => {
		const err = await errorFrom(() => postJsonViaHiddenService(ONION, { a: 1 }, DEAD, 3_000));
		expect(isLocalTransportFault(err, 'tor', DEAD)).toBe(true);
	});

	it('classifies a refused I2P HTTP proxy port as OUR fault', async () => {
		const err = await errorFrom(() => postJsonViaHiddenService(I2P, { a: 1 }, DEAD, 3_000));
		expect(isLocalTransportFault(err, 'i2p', DEAD)).toBe(true);
	});

	it('classifies an unresolvable .loki name as OUR fault (no lokinet tun)', async () => {
		const err = await errorFrom(() => postJsonViaHiddenService(LOKI, { a: 1 }, DEAD, 3_000));
		expect(isLocalTransportFault(err, 'loki', DEAD)).toBe(true);
	});

	it('classifies a blanked Tor setting as OUR fault', async () => {
		const err = await errorFrom(() => postJsonViaHiddenService(ONION, { a: 1 }, BLANK, 3_000));
		expect(isLocalTransportFault(err, 'tor', BLANK)).toBe(true);
	});

	/**
	 * THE REGRESSION TEST FOR THE BUG THAT PROMPTED ALL OF THIS.
	 *
	 * federationProbe asked `err instanceof ProxyUnavailableError` at a fetch
	 * boundary and documented that branch as its protection against blaming a
	 * healthy peer for our own dead Tor. The branch could never be taken.
	 *
	 * This goes through RAW undici — no entry point, no normalisation — because
	 * the fact being pinned belongs to `fetch()`, not to us. Asserting it via
	 * our own wrapper would only prove our wrapper works, and would quietly stop
	 * testing anything the day someone removed the wrapper. This keeps failing
	 * until fetch itself changes.
	 */
	it('fetch() wraps a connector error, so instanceof at that boundary is false', async () => {
		const dispatcher = dispatcherFor(ONION, DEAD);
		const err = await errorFrom(() =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fetch(ONION, { method: 'GET', dispatcher } as any)
		);
		expect(err instanceof ProxyUnavailableError).toBe(false);
		expect(causeChain(err).some((e) => e instanceof ProxyUnavailableError)).toBe(true);
		expect(isLocalTransportFault(err, 'tor', DEAD)).toBe(true);
	});

	/**
	 * ...and the contract that makes one check enough for every consumer: past
	 * either transport entry point, the marker class is present directly. A
	 * consumer that still gets this wrong with `instanceof` is now merely
	 * fragile rather than broken, and `isProxyUnavailable` is right either way.
	 */
	it('both entry points normalise a local fault into the marker class', async () => {
		const viaPost = await errorFrom(() => postJsonViaHiddenService(I2P, { a: 1 }, DEAD, 3_000));
		expect(viaPost instanceof ProxyUnavailableError).toBe(true);
		expect(isProxyUnavailable(viaPost)).toBe(true);

		const viaFetch = await errorFrom(() =>
			fetchJsonViaHiddenService(`${ONION}/v1/instance`, DEAD, 3_000)
		);
		expect(viaFetch instanceof ProxyUnavailableError).toBe(true);
		expect(isProxyUnavailable(viaFetch)).toBe(true);
	});

	/** The evidence survives the verdict: wrapping must not eat the original. */
	it('keeps the underlying error as the cause', async () => {
		const err = await errorFrom(() => postJsonViaHiddenService(I2P, { a: 1 }, DEAD, 3_000));
		const chain = causeChain(err);
		expect(chain.length).toBeGreaterThan(1);
		expect(chain.some((e) => (e as { code?: string }).code === 'ECONNREFUSED')).toBe(true);
	});

	/** A PEER failure must pass through untouched — no marker, no blame shifted
	 *  onto our own transport. Nothing is listening on the clearnet port either,
	 *  but this is a clearnet URL, so there is no local transport to implicate. */
	it('does not wrap a failure on a clearnet origin', async () => {
		const err = await errorFrom(() => fetch('http://127.0.0.1:1/v1/health'));
		expect(isProxyUnavailable(err)).toBe(false);
	});
});

describe('shapes a live socket cannot produce on demand', () => {
	it('does not blame us when the I2P connect failure is to a DIFFERENT address', () => {
		// i2pd is up on 4444 and answered; something further out refused. That is
		// not our transport being missing, and treating it as such would park the
		// whole I2P network on a cooldown because one peer misbehaved.
		const inner = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:8080'), {
			code: 'ECONNREFUSED',
			address: '10.0.0.9',
			port: 8080
		});
		const err = new TypeError('fetch failed', { cause: inner });
		expect(
			isLocalTransportFault(err, 'i2p', { torSocks: '', i2pHttpProxy: '127.0.0.1:4444' })
		).toBe(false);
	});

	it('blames us when the I2P connect failure IS the configured proxy', () => {
		const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4444'), {
			code: 'ECONNREFUSED',
			address: '127.0.0.1',
			port: 4444
		});
		const err = new TypeError('fetch failed', { cause: inner });
		expect(
			isLocalTransportFault(err, 'i2p', { torSocks: '', i2pHttpProxy: '127.0.0.1:4444' })
		).toBe(true);
	});

	it('honours the default I2P port when the setting names a bare host', () => {
		const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4444'), {
			code: 'ECONNREFUSED',
			address: '127.0.0.1',
			port: 4444
		});
		const err = new TypeError('fetch failed', { cause: inner });
		expect(isLocalTransportFault(err, 'i2p', { torSocks: '', i2pHttpProxy: '127.0.0.1' })).toBe(
			true
		);
	});

	it('never blames our transport for a CLEARNET failure', () => {
		const inner = Object.assign(new Error('getaddrinfo ENOTFOUND example.test'), {
			code: 'ENOTFOUND',
			syscall: 'getaddrinfo'
		});
		const err = new TypeError('fetch failed', { cause: inner });
		// Same error, same DNS code — clearnet has no local transport to be missing.
		expect(isLocalTransportFault(err, null, DEAD)).toBe(false);
		// ...and the identical shape IS ours when the target was a .loki name.
		expect(isLocalTransportFault(err, 'loki', DEAD)).toBe(true);
	});

	/**
	 * The clearnet short-circuit is load-bearing, not decoration.
	 *
	 * A caller holds ONE list of peers and some of them are clearnet. If a
	 * ProxyUnavailableError ever reaches this function alongside a clearnet
	 * target — a misrouted error, a caller that reused a variable, a future
	 * transport that raises the marker for its own reasons — answering "yes,
	 * ours" would park CLEARNET on a reachability cooldown, which is the one
	 * network that cannot have a local daemon missing. Answering `false`
	 * before looking at the chain is what makes that unreachable.
	 */
	it('refuses to blame clearnet even when the chain carries the proxy marker', () => {
		const err = new TypeError('fetch failed', {
			cause: new ProxyUnavailableError('Tor SOCKS proxy not configured')
		});
		expect(isLocalTransportFault(err, null, DEAD)).toBe(false);
		// Same error, non-null network: now it is ours.
		expect(isLocalTransportFault(err, 'tor', DEAD)).toBe(true);
	});

	/**
	 * A name-resolution failure is the LOKINET signal specifically, and must not
	 * leak to the other two networks. Tor never resolves an onion locally (the
	 * SOCKS proxy does it, which is the entire reason ATYP=domain is used), and
	 * I2P names are resolved by i2pd past a proxy connection that already
	 * succeeded. So a bare getaddrinfo failure on either of those is something
	 * we do not understand, and "we do not understand it" must not be recorded
	 * as "our transport is down" — that would take the network offline for a
	 * cooldown on the strength of a guess.
	 */
	it('does not treat a DNS failure on a tor push as our transport being down', () => {
		const inner = Object.assign(new Error('getaddrinfo ENOTFOUND something'), {
			code: 'ENOTFOUND',
			syscall: 'getaddrinfo'
		});
		const err = new TypeError('fetch failed', { cause: inner });
		expect(isLocalTransportFault(err, 'tor', DEAD)).toBe(false);
		expect(isLocalTransportFault(err, 'i2p', DEAD)).toBe(false);
		expect(isLocalTransportFault(err, 'loki', DEAD)).toBe(true);
	});

	it('does not blame us for a SOCKS reply code — that is the onion being down', () => {
		// makeSocks5Connector raises a PLAIN Error for a non-zero SOCKS reply,
		// precisely so this case stays the peer's.
		const inner = new Error('onion unreachable via Tor: host unreachable');
		const err = new TypeError('fetch failed', { cause: inner });
		expect(isLocalTransportFault(err, 'tor', DEAD)).toBe(false);
	});

	it('terminates on a self-referential cause chain', () => {
		const a: Error & { cause?: unknown } = new Error('a');
		const b: Error & { cause?: unknown } = new Error('b');
		a.cause = b;
		b.cause = a;
		expect(causeChain(a)).toHaveLength(2);
		expect(isLocalTransportFault(a, 'tor', DEAD)).toBe(false);
	});

	it('stops walking at the depth bound', () => {
		let err: Error & { cause?: unknown } = new Error('deepest');
		for (let i = 0; i < 40; i++) err = Object.assign(new Error(`l${i}`), { cause: err });
		expect(causeChain(err)).toHaveLength(8);
		expect(causeChain(err, 3)).toHaveLength(3);
	});

	it('finds a ProxyUnavailableError buried deeper than the top cause', () => {
		const deep = new ProxyUnavailableError('SOCKS proxy unreachable');
		const mid = Object.assign(new Error('mid'), { cause: deep });
		const err = new TypeError('fetch failed', { cause: mid });
		expect(isLocalTransportFault(err, 'tor', DEAD)).toBe(true);
	});

	/**
	 * EVERY code in each set, not just the one that is easy to produce.
	 *
	 * A mutation battery on an earlier draft showed why: deleting `EAI_AGAIN`,
	 * or five of the seven connect codes, changed nothing any test could see.
	 * A code sitting in a `Set` that no test reaches is not a defence — it is a
	 * comment that happens to compile, and the next person to tidy the list has
	 * no way to learn they broke something. So the sets are enumerated here and
	 * every member is exercised.
	 *
	 * EAI_AGAIN in particular is the one that matters operationally: it is what
	 * a resolver returns while it is still coming up, which is exactly the
	 * window after a reboot when lokinet's tun has not finished registering.
	 */
	const CONNECT_CODES = [
		'ECONNREFUSED',
		'ECONNRESET',
		'EHOSTUNREACH',
		'ENETUNREACH',
		'ETIMEDOUT',
		'EADDRNOTAVAIL',
		'EPIPE'
	];
	it.each(CONNECT_CODES)('treats a %s to the configured i2p proxy as ours', (code) => {
		const inner = Object.assign(new Error(`connect ${code} 127.0.0.1:4444`), {
			code,
			address: '127.0.0.1',
			port: 4444
		});
		const err = new TypeError('fetch failed', { cause: inner });
		expect(
			isLocalTransportFault(err, 'i2p', { torSocks: '', i2pHttpProxy: '127.0.0.1:4444' })
		).toBe(true);
	});

	const RESOLVE_CODES = ['ENOTFOUND', 'EAI_AGAIN'];
	it.each(RESOLVE_CODES)('treats a %s on a .loki name as ours', (code) => {
		const inner = Object.assign(new Error(`getaddrinfo ${code} peer.loki`), {
			code,
			syscall: 'getaddrinfo'
		});
		const err = new TypeError('fetch failed', { cause: inner });
		expect(isLocalTransportFault(err, 'loki', DEAD)).toBe(true);
	});

	it('ignores a socket code that is not in either set', () => {
		const inner = Object.assign(new Error('connect EACCES 127.0.0.1:4444'), {
			code: 'EACCES',
			address: '127.0.0.1',
			port: 4444
		});
		const err = new TypeError('fetch failed', { cause: inner });
		expect(
			isLocalTransportFault(err, 'i2p', { torSocks: '', i2pHttpProxy: '127.0.0.1:4444' })
		).toBe(false);
	});

	it('is not fooled by a non-Error thrown value', () => {
		expect(isLocalTransportFault('boom', 'tor', DEAD)).toBe(false);
		expect(isLocalTransportFault(null, 'i2p', DEAD)).toBe(false);
		expect(isLocalTransportFault(undefined, 'loki', DEAD)).toBe(false);
	});
});

/**
 * A PROXY THAT ANSWERS AND REFUSES — the case nothing could see before.
 *
 * The Java I2P router's `i2ptunnel.httpclient.allowInternalSSL=false` refuses
 * `CONNECT` to in-network destinations outright, port 80 included despite the
 * setting's name. That refusal is not a connect failure: the proxy is running,
 * accepts the TCP connection, and answers with an HTTP status. Under undici's
 * `ProxyAgent` it arrived as `UND_ERR_ABORTED` with the status readable only
 * inside the message prose — and `UND_ERR_ABORTED` is also what an ordinary
 * request abort produces, so there was nothing in the shape to decide on. It
 * was recorded as the PEER's failure, and an operator whose router refuses
 * CONNECT had federated chat over I2P dead with no signal anywhere.
 *
 * These drive a REAL proxy that refuses a REAL CONNECT, for the reason given
 * at the top of this file: the previous bug of this exact kind was a
 * correct-looking check written against an error shape the library does not
 * produce, and only a real error can contradict a wrong belief.
 */
describe('a proxy that answers CONNECT and refuses it', () => {
	/** A proxy that accepts the connection and refuses every tunnel. */
	async function refusingProxy(
		status: number
	): Promise<{ config: HiddenServiceProxyConfig; close: () => Promise<void> }> {
		const { createServer } = await import('node:http');
		const server = createServer((_req, res) => res.writeHead(400).end());
		server.on('connect', (_req, socket) => {
			socket.write(`HTTP/1.1 ${status} Refused\r\ncontent-length: 0\r\n\r\n`);
			socket.end();
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as { port: number }).port;
		return {
			config: { torSocks: '', i2pHttpProxy: `127.0.0.1:${port}` },
			close: () => new Promise<void>((r) => server.close(() => r()))
		};
	}

	it('is recognised as possibly ours, not silently blamed on the peer', async () => {
		const { config, close } = await refusingProxy(403);
		try {
			const err = await errorFrom(() => postJsonViaHiddenService(I2P, { a: 1 }, config, 3_000));
			expect(
				isProxyUnavailable(err),
				'a refused tunnel used to be recorded as the peer refusing the message'
			).toBe(true);
		} finally {
			await close();
		}
	});

	it('carries the status as a NUMBER rather than buried in prose', async () => {
		const { config, close } = await refusingProxy(403);
		try {
			const err = await errorFrom(() => postJsonViaHiddenService(I2P, { a: 1 }, config, 3_000));
			const rejection = causeChain(err).find((e) => e instanceof ProxyConnectRejectedError) as
				| ProxyConnectRejectedError
				| undefined;
			expect(rejection, 'the refusal must survive as its own typed error').toBeDefined();
			expect(rejection?.status, 'the status is the only thing that says why').toBe(403);
		} finally {
			await close();
		}
	});

	/**
	 * AND IT IS NOT TREATED AS CONCLUSIVE. A router that refuses CONNECT by
	 * policy refuses every destination, which is ours; a router that cannot
	 * reach one destination refuses that one, which is theirs. Both answer with
	 * a status, and which status means which is a per-router detail nobody has
	 * verified against a live Java router. Guessing would be exactly the
	 * resemblance-based reasoning that produced the bug this file exists for,
	 * so the ambiguity is resolved by corroboration instead.
	 */
	it.each([403, 405, 501, 504])('a %d refusal is ambiguous, never conclusive', async (status) => {
		const { config, close } = await refusingProxy(status);
		try {
			const err = await errorFrom(() => postJsonViaHiddenService(I2P, { a: 1 }, config, 3_000));
			expect(localFaultConfidence(err, 'i2p')).toBe('ambiguous');
		} finally {
			await close();
		}
	});

	/** ...while a proxy that is not there at all still IS conclusive: nothing a
	 *  peer publishes can refuse a connection to 127.0.0.1. */
	it('a proxy that is not listening stays conclusive', async () => {
		const err = await errorFrom(() => postJsonViaHiddenService(I2P, { a: 1 }, DEAD, 3_000));
		expect(localFaultConfidence(err, 'i2p')).toBe('conclusive');
	});

	/**
	 * THE PROBE PATH TOO, which is a different module and was a different copy
	 * of this decision. `fetchJsonViaHiddenService` built its own `ProxyAgent`,
	 * as did the routing dispatcher — three homes for one rule. Fixing the chat
	 * pool alone would have left an operator whose router refuses CONNECT with
	 * `unreachable` written across every I2P peer in the directory, which is the
	 * exact directory damage the local-fault rule exists to prevent.
	 */
	it('the PROBE also declines to blame the peer for a refused CONNECT', async () => {
		const { config, close } = await refusingProxy(403);
		try {
			const err = await errorFrom(() =>
				fetchJsonViaHiddenService(`${I2P}/v1/instance`, config, 3_000)
			);
			expect(
				isProxyUnavailable(err),
				'the probe must not record a healthy peer as unreachable because OUR router refuses tunnels'
			).toBe(true);
			expect(localFaultConfidence(err, 'i2p')).toBe('ambiguous');
		} finally {
			await close();
		}
	});

	/**
	 * The proxy's own text is bounded before it can travel.
	 *
	 * The reason phrase ends up in this error's message, which becomes a
	 * `recentFailures[].reason` on /v1/health. That list is capped at twenty
	 * ENTRIES; each entry's string was not capped at all, and the CONNECT header
	 * it comes from is allowed 64 KB — so a proxy with a broken or verbose
	 * reason phrase could put megabytes of its own text into an operator
	 * endpoint. Hardening rather than a bug (the proxy is the operator's own
	 * local daemon), but it is untrusted-by-construction input crossing into a
	 * response, and the rest of this subsystem bounds those.
	 */
	it('a vast reason phrase from the proxy is truncated, not carried whole', async () => {
		const { createServer } = await import('node:http');
		const huge = 'A'.repeat(40_000);
		const server = createServer((_req, res) => res.writeHead(400).end());
		server.on('connect', (_req, socket) => {
			socket.write(`HTTP/1.1 502 ${huge}\r\ncontent-length: 0\r\n\r\n`);
			socket.end();
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as { port: number }).port;
		try {
			const config: HiddenServiceProxyConfig = {
				torSocks: '',
				i2pHttpProxy: `127.0.0.1:${port}`
			};
			const err = await errorFrom(() => postJsonViaHiddenService(I2P, { a: 1 }, config, 3_000));
			const rejection = causeChain(err).find(
				(e) => e instanceof ProxyConnectRejectedError
			) as ProxyConnectRejectedError | undefined;
			expect(rejection?.status, 'the status still survives').toBe(502);
			expect(
				rejection?.message.length,
				'twenty of these sit in /v1/health; the proxy does not get to choose how big they are'
			).toBeLessThan(400);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	/** The verdict is fixed at the entry point, where the original error is
	 *  still in hand — after that the wrapper looks the same whatever made it. */
	it('the verdict rides on the marker rather than being re-derived', async () => {
		const { config, close } = await refusingProxy(403);
		try {
			const err = await errorFrom(() => postJsonViaHiddenService(I2P, { a: 1 }, config, 3_000));
			expect((err as ProxyUnavailableError).confidence).toBe('ambiguous');
		} finally {
			await close();
		}
	});
});
