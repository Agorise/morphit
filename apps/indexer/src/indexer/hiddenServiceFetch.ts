/**
 * hiddenServiceFetch — indexer-side hidden-service JSON fetch.
 *
 * The transport CORE (SOCKS5 connector, wire helpers, network classifier, proxy
 * config) now lives in the dependency-free @morphit/hidden-transport package so
 * the indexer and the ops-cli hidden upgrade fetch share ONE copy (no drift on
 * security-critical code). This module re-exports that core unchanged — so every
 * existing `./hiddenServiceFetch` importer keeps working — and adds the
 * undici-based `fetchJsonViaHiddenService` (which stays here because it needs
 * undici's Agent, whereas the shared core is intentionally undici-free
 * for offline portability).
 */
import { Agent } from 'undici';
import {
	hiddenNetworkOf,
	parseHostPort,
	makeSocks5Connector,
	makeHttpConnectConnector,
	ProxyUnavailableError,
	asLocalTransportFault,
	lokinetEnabled
} from '@morphit/hidden-transport';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';

// Re-export the shared transport core so existing importers are unchanged.
export {
	hiddenNetworkOf,
	hiddenHostNetworkOf,
	parseHostPort,
	makeSocks5Connector,
	makeHttpConnectConnector,
	ProxyUnavailableError,
	ProxyConnectRejectedError,
	localFaultConfidence,
	hiddenServiceProxyConfigFromEnv,
	socks5Greeting,
	parseSocks5Greeting,
	socks5ConnectRequest,
	parseSocks5ConnectReply,
	HIDDEN_HANDSHAKE_TIMEOUT_MS,
	causeChain,
	isLocalTransportFault,
	isProxyUnavailable,
	asLocalTransportFault
} from '@morphit/hidden-transport';
export type { HiddenServiceProxyConfig, HiddenNetwork } from '@morphit/hidden-transport';

/** Max probe-response body — same cap the clearnet path uses. */
const MAX_BYTES = 256 * 1024;
/** Per-fetch timeout. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Fetch JSON from a hidden-service URL through the appropriate proxy. Throws
 *  {@link ProxyUnavailableError} when the local Tor/i2pd proxy is down (so the
 *  caller can decline to penalise the peer), and a normal Error when the target
 *  itself is unreachable or misbehaves. */
export async function fetchJsonViaHiddenService<T>(
	url: string,
	config: HiddenServiceProxyConfig,
	timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
	const network = hiddenNetworkOf(url);
	if (network === null) throw new Error(`not a hidden-service URL: ${url}`);

	let dispatcher: Agent;
	if (network === 'tor') {
		if (config.torSocks.length === 0)
			throw new ProxyUnavailableError('Tor SOCKS proxy not configured');
		const { host, port } = parseHostPort(config.torSocks, 9050);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici's
		// connect type doesn't model a custom SOCKS connector cleanly.
		dispatcher = new Agent({ connect: makeSocks5Connector(host, port) as any });
	} else if (network === 'i2p') {
		if (config.i2pHttpProxy.length === 0)
			throw new ProxyUnavailableError('I2P HTTP proxy not configured');
		const { host, port } = parseHostPort(config.i2pHttpProxy, 4444);
		// The same CONNECT connector the chat pool and the routing dispatcher
		// use. This decision had THREE homes — here, the pool, and the router —
		// and fixing fewer than all of them would leave the probe and the sender
		// disagreeing about whether a refused CONNECT is the peer's fault.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici's
		// connect type doesn't model a custom tunnelling connector cleanly.
		dispatcher = new Agent({ connect: makeHttpConnectConnector(host, port) as any });
	} else {
		// .loki — routed by the lokinet tun; a plain fetch resolves it. Only
		// where lokinet runs (v1.18.0 review, S3): elsewhere the resolver is the
		// ISP's, and asking it is the leak. "Not configured" lists the peer
		// without penalising it, exactly as a blanked Tor setting does.
		if (!lokinetEnabled(config))
			throw new ProxyUnavailableError('Lokinet is not enabled on this node');
		dispatcher = new Agent();
	}

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			redirect: 'manual',
			headers: { accept: 'application/json', 'user-agent': 'morphit-indexer/hidden-service-probe' },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fetch's
			// lib.dom type omits undici's `dispatcher`.
			dispatcher
		} as any);
		if (!res.ok) {
			// CANCEL THE BODY BEFORE THROWING (v1.18.0 review, S1). The
			// `finally` below awaits `dispatcher.close()`, and undici's close
			// waits for every response body to be consumed. An error page larger
			// than the socket buffers — 128 KB was enough — was never read, so
			// close() never resolved, the probe never settled, and the scan that
			// awaited it stayed "in flight" for the life of the process: one
			// hidden peer returning a big 404 stopped federation probing for the
			// whole node until restart.
			await res.body?.cancel().catch(() => undefined);
			throw new Error(`hidden-service probe HTTP ${res.status}`);
		}
		const reader = res.body?.getReader();
		if (!reader) throw new Error('hidden-service probe: no body');
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				total += value.byteLength;
				if (total > MAX_BYTES) {
					await reader.cancel();
					throw new Error('hidden-service probe: body too large');
				}
				chunks.push(value);
			}
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
	} catch (err) {
		// See the matching note in hiddenServicePool.postJsonViaHiddenService.
		// The probe's whole "never penalise a healthy peer for our Tor being
		// offline" rule depends on this class arriving intact; before this, the
		// rule was unreachable on Tor and had never existed at all on I2P or
		// Lokinet, so a local daemon being down wrote `unreachable` across the
		// directory for peers that were fine.
		throw asLocalTransportFault(err, network, config);
	} finally {
		clearTimeout(timer);
		// Bounded as well as drained: a close that still does not finish — a
		// body some path forgot to consume, a peer holding the socket — must
		// not hold the caller. Past the deadline the dispatcher is destroyed.
		await closeWithin(dispatcher, CLOSE_DEADLINE_MS);
	}
}

/** How long a probe's own dispatcher may take to close before it is destroyed. */
const CLOSE_DEADLINE_MS = 5_000;

async function closeWithin(dispatcher: Agent, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = await Promise.race([
		dispatcher.close().then(
			() => false,
			() => false
		),
		new Promise<boolean>((r) => {
			timer = setTimeout(() => r(true), ms);
			timer.unref?.();
		})
	]);
	if (timer !== undefined) clearTimeout(timer);
	if (late) await dispatcher.destroy().catch(() => undefined);
}
