/**
 * Is OUR end of each hidden network alive — asked directly, at boot and every
 * minute, instead of learned from a failed message.
 *
 * WHY. The fast path learned that a local daemon was down in exactly one way:
 * a push over it failing. That costs a wasted round per network after every
 * restart on a box whose daemon is absent, and on Lokinet it cost much more.
 * Lokinet has no proxy, so "our router is down" and "that peer's `.loki` name is
 * dead" arrive as the same `getaddrinfo ENOTFOUND`. The probe therefore could
 * not blame a dead Lokinet-only peer without risking F2 (writing `unreachable`
 * across healthy peers because OUR router stopped), so such a peer kept its
 * `never`/`quiet` status and one of the forty fan-out slots, indefinitely.
 *
 * Each network has an honest local signal:
 *   - Tor / I2P: does OUR proxy accept a connection? A refused connection to
 *     127.0.0.1:9050 is about this box and nothing else.
 *   - Lokinet: does `localhost.loki` resolve? Lokinet answers it with this
 *     node's own address; it is the one `.loki` name no peer supplied.
 *
 * What it does with the answers:
 *   - a network whose local end is down is marked down for the fan-out at once
 *     (rather than after a failed message), so peer lists are built without it;
 *   - Lokinet's answer is recorded process-wide (`noteLokinetLiveness`), where
 *     the transport classifier reads it: with our router alive, a peer's `.loki`
 *     miss is the PEER's failure, so the probe can finally record it — and with
 *     our router down, every miss is conclusively ours.
 *
 * A proxy ACCEPTING a connection is not treated as proof the network works —
 * the daemon can be up with no circuits — so a live proxy clears nothing. Only
 * a dead one is acted on. Success is still learned the way it always was: from
 * a warm-up or a message that got through.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import {
	LOKINET_SELF_NAME,
	lokinetEnabled,
	noteLokinetLiveness,
	parseHostPort,
	type HiddenNetwork,
	type HiddenServiceProxyConfig
} from '@morphit/hidden-transport';

/** One check's budget. Local: a live daemon answers in microseconds, a dead
 *  one refuses at once. The ceiling is only for a wedged resolver. */
export const LIVENESS_TIMEOUT_MS = 3_000;

export interface LocalTransportState {
	/** null = this node does not run it (the operator blanked the setting). */
	readonly tor: boolean | null;
	readonly i2p: boolean | null;
	/** null = this node does not run lokinet, so its liveness is not asked —
	 *  asking means a DNS query to the system resolver (v1.18.0 review, S3). */
	readonly loki: boolean | null;
}

export interface LivenessDeps {
	/** Resolve a name; resolves on success, rejects on a miss. */
	readonly lookup?: (host: string) => Promise<unknown>;
	/** Does host:port accept a TCP connection? */
	readonly connects?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

/** Does host:port accept a TCP connection within the budget? Never throws. */
export function tcpConnects(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = net.connect({ host, port });
		let settled = false;
		const done = (up: boolean): void => {
			if (settled) return;
			settled = true;
			sock.destroy();
			resolve(up);
		};
		sock.setTimeout(timeoutMs, () => done(false));
		sock.once('connect', () => done(true));
		sock.once('error', () => done(false));
	});
}

/** Resolve with a ceiling, so a wedged resolver reads as "not alive". */
async function resolves(
	lookup: (host: string) => Promise<unknown>,
	host: string,
	timeoutMs: number
): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			lookup(host).then(() => true),
			new Promise<boolean>((r) => {
				timer = setTimeout(() => r(false), timeoutMs);
				timer.unref?.();
			})
		]);
	} catch {
		return false;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Check all three networks' local ends. Records Lokinet's answer process-wide
 * and returns every answer; the caller decides what to mark down.
 */
export async function checkLocalTransports(
	proxies: HiddenServiceProxyConfig,
	deps: LivenessDeps = {}
): Promise<LocalTransportState> {
	const lookup = deps.lookup ?? ((h: string) => dnsLookup(h));
	const connects = deps.connects ?? tcpConnects;
	const proxyUp = async (hp: string, fallback: number): Promise<boolean | null> => {
		if (hp.length === 0) return null; // "I do not run this daemon"
		const { host, port } = parseHostPort(hp, fallback);
		return connects(host, port, LIVENESS_TIMEOUT_MS);
	};
	const [tor, i2p, loki] = await Promise.all([
		proxyUp(proxies.torSocks, 9050),
		proxyUp(proxies.i2pHttpProxy, 4444),
		// Only where lokinet runs. `localhost.loki` resolved by the system
		// resolver of a box without lokinet is a query to the ISP, once a minute,
		// naming the software — the leak S3 closes.
		lokinetEnabled(proxies)
			? resolves(lookup, LOKINET_SELF_NAME, LIVENESS_TIMEOUT_MS)
			: Promise.resolve(null)
	]);
	noteLokinetLiveness(loki);
	return { tor, i2p, loki };
}

/** The networks a state says are down at OUR end. A daemon the operator does
 *  not run (null) is left to the proxy-config rule that already covers it. */
export function networksDownIn(state: LocalTransportState): Exclude<HiddenNetwork, null>[] {
	const out: Exclude<HiddenNetwork, null>[] = [];
	if (state.tor === false) out.push('tor');
	if (state.i2p === false) out.push('i2p');
	if (state.loki === false) out.push('loki');
	return out;
}
