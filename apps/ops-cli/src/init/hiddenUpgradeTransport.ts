/**
 * hiddenUpgradeTransport — the real Tor/I2P `fetchTarball` for the hidden upgrade
 * (v1.16.1 stage 3b). Wraps the shared, dependency-free SOCKS core
 * (@morphit/hidden-transport) with undici's Agent/ProxyAgent to produce the
 * transport `fetchHiddenUpgrade` injects.
 *
 * FAIL-CLOSED: this fetcher routes ONLY `.onion` (Tor) and `.i2p` (i2pd) URLs.
 * A clearnet/other URL is refused outright — a hidden-only node must never reach
 * a release over the open internet, even by accident. Byte size is capped.
 */
import { Agent, ProxyAgent } from 'undici';
import {
	hiddenNetworkOf,
	parseHostPort,
	makeSocks5Connector,
	type HiddenServiceProxyConfig
} from '@morphit/hidden-transport';

/** Default cap: a Morphit release tarball is ~15–35 MB; 256 MB is generous
 *  headroom while still bounding a hostile/broken gateway. */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export interface HiddenTarballFetcherOptions {
	readonly proxy: HiddenServiceProxyConfig;
	readonly maxBytes?: number;
}

/**
 * Build a `fetchTarball(url, signal)` that streams a tarball over Tor/I2P. Returns
 * the bytes as a Uint8Array. Throws on: a non-hidden URL (fail-closed), HTTP
 * error, or an over-cap body. The caller (`fetchHiddenUpgrade`) SHA-verifies the
 * bytes and races several peers, so a slow/dead gateway is handled upstream.
 */
export function makeHiddenTarballFetcher(
	opts: HiddenTarballFetcherOptions
): (url: string, signal: AbortSignal) => Promise<Uint8Array> {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	return async (url: string, signal: AbortSignal): Promise<Uint8Array> => {
		const network = hiddenNetworkOf(url);
		let dispatcher: Agent | ProxyAgent;
		if (network === 'tor') {
			if (opts.proxy.torSocks.length === 0) throw new Error('hidden upgrade: Tor SOCKS proxy not configured');
			const { host, port } = parseHostPort(opts.proxy.torSocks, 9050);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici's
			// connect type doesn't model a custom SOCKS connector.
			dispatcher = new Agent({ connect: makeSocks5Connector(host, port) as any });
		} else if (network === 'i2p') {
			if (opts.proxy.i2pHttpProxy.length === 0) throw new Error('hidden upgrade: I2P HTTP proxy not configured');
			const { host, port } = parseHostPort(opts.proxy.i2pHttpProxy, 4444);
			dispatcher = new ProxyAgent(`http://${host}:${port}`);
		} else {
			// FAIL-CLOSED: never fetch a release over clearnet (or .loki) on the
			// hidden upgrade path — that would defeat the entire point.
			throw new Error(`hidden upgrade: refusing to fetch a non-hidden URL over the open internet: ${url}`);
		}

		// Own timeout (a big tarball over Tor/I2P is slow, but must not hang
		// forever) combined with the caller's abort (race-loss cancels losers).
		//
		// BOTH STAY ARMED UNTIL THE LAST BYTE (v1.18.0 review). They used to be
		// cleared the moment the response HEADERS arrived, so the body — tens of
		// megabytes over Tor or I2P, i.e. nearly all of the time — was read with
		// no timeout and deaf to the caller: a peer that sent headers and then
		// trickled or stalled held the upgrade forever, and a peer that lost the
		// race went on downloading the whole tarball in the background.
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(new Error('hidden upgrade: tarball fetch timeout')), 600_000);
		const onCallerAbort = (): void => ac.abort((signal as AbortSignal).reason);
		if (signal.aborted) onCallerAbort();
		else signal.addEventListener('abort', onCallerAbort);
		try {
			const res = await fetch(url, {
				signal: ac.signal,
				redirect: 'manual',
				headers: { 'user-agent': 'morphit-ops/hidden-upgrade' },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fetch's
				// lib.dom type omits undici's `dispatcher`.
				dispatcher
			} as any);
			if (!res.ok) {
				// Cancel the body first (v1.18.0 review, S1): the `finally` below
				// awaits dispatcher.close(), which waits for an unread body, so a
				// large error page from a peer would otherwise hang the upgrade.
				await res.body?.cancel().catch(() => undefined);
				throw new Error(`hidden upgrade: HTTP ${res.status} from ${url}`);
			}
			const reader = res.body?.getReader();
			if (!reader) throw new Error('hidden upgrade: empty response body');
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					total += value.byteLength;
					if (total > maxBytes) {
						await reader.cancel();
						throw new Error(`hidden upgrade: body exceeds ${maxBytes} bytes (aborting)`);
					}
					chunks.push(value);
				}
			}
			const out = new Uint8Array(total);
			let off = 0;
			for (const c of chunks) {
				out.set(c, off);
				off += c.byteLength;
			}
			return out;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener('abort', onCallerAbort);
			// Bounded: close() waits on anything left unread; destroy past a
			// short grace rather than hold the upgrade on a dead socket.
			let t: ReturnType<typeof setTimeout> | undefined;
			const late = await Promise.race([
				dispatcher.close().then(
					() => false,
					() => false
				),
				new Promise<boolean>((r) => {
					t = setTimeout(() => r(true), 5_000);
					t.unref?.();
				})
			]);
			if (t !== undefined) clearTimeout(t);
			if (late) await dispatcher.destroy().catch(() => undefined);
		}
	};
}
