/**
 * Morphit indexer — the federation chat push to a CLEARNET peer, resolved and
 * pinned (v1.20.0 fix wave, S7).
 *
 * WHAT WAS WRONG. The chat fan-out POSTed to a peer's registered clearnet
 * origin with the global fetch: the system resolver's answer, whatever it was,
 * was dialled. Registration refuses private address LITERALS and names dressed
 * as them, but a NAME can resolve anywhere — so a registered
 * `https://rebind.example:6379` whose DNS answered 127.0.0.1 had this indexer
 * open a TCP connection and send a TLS ClientHello to its own loopback port
 * 6379 for every chat message it relayed (measured: 1,611 bytes delivered to a
 * local listener). Blind — TLS verification stops any request body — but an
 * internal-network connection primitive on a timer every user drives. The
 * probe's `fetchJson` never had this hole: it resolves, refuses if ANY answer
 * is non-public, and pins the connection to the address it checked.
 *
 * NOW the push takes the same path: one definition of "public"
 * (@morphit/net-defense via `resolveAndValidatePublicIp`), the connection
 * pinned to the validated address so a second lookup cannot land elsewhere,
 * HTTPS only, redirects not followed, the reply read bounded. The pinned agent
 * is cached per host for a few minutes, so a busy peer keeps one warm
 * connection instead of paying a DNS lookup and a handshake per message.
 *
 * A refused address is the PEER's failure (its registration points somewhere
 * it must not), never a local fault that could take a network off the list.
 */
import type { Agent } from 'undici';
import { clearnetRefused } from '@morphit/hidden-transport/router';
import { resolveAndValidatePublicIp, buildPinnedAgent } from '$indexer/federationProbe';
import { readCappedText } from '$indexer/hiddenServicePool';

/** How long a validated pin is reused before the name is resolved again. */
export const PIN_TTL_MS = 5 * 60 * 1000;
const PIN_MAX = 200;

type Lookup = Parameters<typeof resolveAndValidatePublicIp>[1];

const pins = new Map<string, { agent: Agent; at: number }>();

async function pinnedAgentFor(
	host: string,
	lookup: Lookup | undefined,
	now: number
): Promise<Agent> {
	const hit = pins.get(host);
	if (hit !== undefined && now - hit.at < PIN_TTL_MS) return hit.agent;
	if (hit !== undefined) {
		pins.delete(host);
		void hit.agent.close().catch(() => undefined);
	}
	const { address, family } = await resolveAndValidatePublicIp(host, lookup);
	const agent = buildPinnedAgent(host, address, family);
	pins.set(host, { agent, at: now });
	while (pins.size > PIN_MAX) {
		const oldest = pins.keys().next().value;
		if (oldest === undefined) break;
		const gone = pins.get(oldest);
		pins.delete(oldest);
		void gone?.agent.close().catch(() => undefined);
	}
	return agent;
}

/**
 * POST JSON to a clearnet peer. Signature matches `DispatchDeps.postClearnet`.
 * Throws on a refused address (non-https, hidden-only node, or any resolved
 * address non-public) before any connection is made.
 */
export async function postClearnetPinned(
	url: string,
	body: unknown,
	timeoutMs: number,
	deps: {
		readonly lookup?: Lookup;
		/** Who is asking, for the peer's logs. Defaults to the chat push's name;
		 *  the pairing forward (pairingForward.ts) names itself. */
		readonly userAgent?: string;
	} = {}
): Promise<{ status: number; body: string }> {
	const u = new URL(url);
	if (u.protocol !== 'https:') throw new Error(`refusing non-https clearnet peer ${u.origin}`);
	// Never on a hidden-only node: this carries its own transport, which the
	// fail-closed router would not see (F30). The peer list never offers a
	// clearnet address there; this is the second lock.
	if (clearnetRefused()) throw new Error(`clearnet refused on a hidden-only node: ${u.origin}`);
	const agent = await pinnedAgentFor(u.hostname.toLowerCase(), deps.lookup, Date.now());
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				// The same name the hidden-transport push uses.
				'user-agent': deps.userAgent ?? 'morphit-indexer/federation-chat-fast'
			},
			body: JSON.stringify(body),
			redirect: 'manual',
			signal: ctrl.signal,
			// @ts-expect-error — undici's `dispatcher` is not in the DOM fetch type.
			dispatcher: agent
		});
		return { status: res.status, body: await readCappedText(res) };
	} finally {
		clearTimeout(timer);
	}
}

/** Close every pinned agent. Shutdown and tests. */
export async function closePinnedClearnet(): Promise<void> {
	const all = [...pins.values()];
	pins.clear();
	await Promise.all(all.map((p) => p.agent.destroy().catch(() => undefined)));
}
