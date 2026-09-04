/**
 * hiddenServiceFetch — indexer-side hidden-service JSON fetch.
 *
 * The transport CORE (SOCKS5 connector, wire helpers, network classifier, proxy
 * config) now lives in the dependency-free @morphit/hidden-transport package so
 * the indexer and the ops-cli hidden upgrade fetch share ONE copy (no drift on
 * security-critical code). This module re-exports that core unchanged — so every
 * existing `./hiddenServiceFetch` importer keeps working — and adds the
 * undici-based `fetchJsonViaHiddenService` (which stays here because it needs
 * undici's Agent/ProxyAgent, whereas the shared core is intentionally undici-free
 * for offline portability).
 */
import { Agent, ProxyAgent } from 'undici';
import {
	hiddenNetworkOf,
	parseHostPort,
	makeSocks5Connector,
	ProxyUnavailableError
} from '@morphit/hidden-transport';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';

// Re-export the shared transport core so existing importers are unchanged.
export {
	hiddenNetworkOf,
	parseHostPort,
	makeSocks5Connector,
	ProxyUnavailableError,
	hiddenServiceProxyConfigFromEnv,
	socks5Greeting,
	parseSocks5Greeting,
	socks5ConnectRequest,
	parseSocks5ConnectReply,
	HIDDEN_HANDSHAKE_TIMEOUT_MS
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

	let dispatcher: Agent | ProxyAgent;
	if (network === 'tor') {
		if (config.torSocks.length === 0) throw new ProxyUnavailableError('Tor SOCKS proxy not configured');
		const { host, port } = parseHostPort(config.torSocks, 9050);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici's
		// connect type doesn't model a custom SOCKS connector cleanly.
		dispatcher = new Agent({ connect: makeSocks5Connector(host, port) as any });
	} else if (network === 'i2p') {
		if (config.i2pHttpProxy.length === 0) throw new ProxyUnavailableError('I2P HTTP proxy not configured');
		const { host, port } = parseHostPort(config.i2pHttpProxy, 4444);
		dispatcher = new ProxyAgent(`http://${host}:${port}`);
	} else {
		// .loki — routed by the lokinet tun; a plain fetch resolves it.
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
		if (!res.ok) throw new Error(`hidden-service probe HTTP ${res.status}`);
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
	} finally {
		clearTimeout(timer);
		await dispatcher.close().catch(() => {});
	}
}
