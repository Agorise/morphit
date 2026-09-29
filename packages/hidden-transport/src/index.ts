/**
 * @morphit/hidden-transport — dependency-free hidden-network transport core.
 *
 * The SOCKS5 connector + wire helpers + network classifier + proxy config,
 * extracted so BOTH the indexer's hidden-service fetch and the ops-cli hidden
 * upgrade fetch use ONE copy (no drift on security-critical code). Pure
 * `node:net` + Buffers — NO external dependency — so it bundles into the
 * release tarball and installs/upgrades fully offline (USB-stick distribution).
 *
 * The undici `Agent`/`ProxyAgent` wrapping stays in each consumer (they already
 * carry undici); this package is intentionally undici-free so it stays maximally
 * portable and offline-safe.
 */
import net from 'node:net';
import { isNonPublicIpLiteral } from '@morphit/net-defense';

/** Per-connect handshake timeout. */
export const HIDDEN_HANDSHAKE_TIMEOUT_MS = 20_000;

export interface HiddenServiceProxyConfig {
	/** Tor SOCKS5 proxy `host:port` (for `.onion`). Empty disables onion. */
	readonly torSocks: string;
	/** i2pd HTTP proxy `host:port` (for `.i2p`/`.b32.i2p`). Empty disables I2P. */
	readonly i2pHttpProxy: string;
	/**
	 * Whether this node runs Lokinet. Absent means NO (v1.18.0 review, S3).
	 *
	 * Lokinet has no proxy: a `.loki` name is resolved by the system resolver
	 * and routed by lokinet's tun. On a box that does not run lokinet — every
	 * box the installer builds, since it installs none — that resolver is the
	 * ISP's. Resolving `localhost.loki` once a minute, and every peer's `.loki`
	 * name on every warm-up and message, sent those names to it in the clear:
	 * a tor-only home server announcing to its ISP that it runs Morphit, and
	 * whom it talks to. So `.loki` is dialled, probed and resolved ONLY where
	 * the operator runs lokinet.
	 */
	readonly lokinet?: boolean;
}

/**
 * Does this node run Lokinet? `MORPHIT_INDEXER_LOKINET` decides when set
 * (`on`/`off`, also `1`/`0`, `true`/`false`, `yes`/`no`); unset or `auto`, it is
 * on exactly when the operator publishes a `.loki` address of their own
 * (`MORPHIT_INSTANCE_LOKINET_ADDRESS`) — publishing one is running one.
 */
export function lokinetEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.MORPHIT_INDEXER_LOKINET ?? '').trim().toLowerCase();
	if (['1', 'on', 'true', 'yes'].includes(v)) return true;
	if (['0', 'off', 'false', 'no'].includes(v)) return false;
	return (env.MORPHIT_INSTANCE_LOKINET_ADDRESS ?? '').trim().length > 0;
}

/** Is Lokinet enabled in this config? Absent is no — see the field. */
export function lokinetEnabled(config: HiddenServiceProxyConfig): boolean {
	return config.lokinet === true;
}

/** Read the proxy config from the environment (defaults match a standard
 *  co-located Tor + i2pd install; the same daemons the indexer uses). */
export function hiddenServiceProxyConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env
): HiddenServiceProxyConfig {
	return {
		torSocks: (env.MORPHIT_INDEXER_TOR_SOCKS ?? '127.0.0.1:9050').trim(),
		i2pHttpProxy: (env.MORPHIT_INDEXER_I2P_HTTP_PROXY ?? '127.0.0.1:4444').trim(),
		lokinet: lokinetEnabledFromEnv(env)
	};
}

// ─── which network a URL belongs to ──────────────────────────────

export type HiddenNetwork = 'tor' | 'i2p' | 'loki' | null;

/** Classify a bare HOST (no scheme) into a hidden-service network, or null for
 *  clearnet. Used to validate operator-published instance addresses (which are
 *  bare `.onion`/`.b32.i2p` hosts, not URLs). Same strictness as the URL path:
 *  a v3 onion is exactly 56 base32 chars. PURE. */
export function hiddenHostNetworkOf(host: string): HiddenNetwork {
	const h = host.trim().toLowerCase();
	if (/^[a-z2-7]{56}\.onion$/.test(h)) return 'tor';
	if (h.endsWith('.i2p')) return 'i2p';
	if (h.endsWith('.loki')) return 'loki';
	return null;
}

/** Classify a URL's host into a hidden-service network, or null for clearnet. */
export function hiddenNetworkOf(url: string): HiddenNetwork {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
	return hiddenHostNetworkOf(host);
}

// ─── is a host an ADDRESS on this box's own networks? ─────────────
//
// (v1.18.0 deep-deep, C1) The router used to decide "local, not clearnet" by
// matching the TEXT of a host against `10.`, `127.`, `192.168.`, `172.16-31.`
// and `169.254.`. A DNS NAME such as `10.attacker.example` matched, so a
// hidden-only node handed it to the plain agent: a system-resolver query for
// the attacker's name, then a TCP connection from the node's own address. Only
// an IP LITERAL can be local; a name is resolved by somebody else's DNS and can
// point anywhere. Every "is this local?" decision now goes through these
// helpers, which parse the address (`net.isIP` + `BlockList`, which also
// matches IPv4-mapped IPv6 in both `::ffff:1.2.3.4` and `::ffff:102:304` form).

function blockListOf(v4: [string, number][], v6: [string, number][]): net.BlockList {
	const b = new net.BlockList();
	for (const [a, p] of v4) b.addSubnet(a, p, 'ipv4');
	for (const [a, p] of v6) b.addSubnet(a, p, 'ipv6');
	return b;
}

/** Loopback, RFC 1918, link-local, IPv6 ULA and link-local: the box itself and
 *  its private LAN/docker networks. */
const LOCAL_V4: [string, number][] = [
	['127.0.0.0', 8],
	['10.0.0.0', 8],
	['172.16.0.0', 12],
	['192.168.0.0', 16],
	['169.254.0.0', 16]
];
const LOCAL_V6: [string, number][] = [
	['::1', 128],
	['fc00::', 7],
	['fe80::', 10]
];
const LOCAL_ADDRESSES = blockListOf(LOCAL_V4, LOCAL_V6);

function bareHost(host: string): string {
	return host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '');
}

/** Is `host` an IP LITERAL in a loopback / private / link-local range? A name
 *  is never local here, whatever it looks like. PURE. */
export function isLocalAddressLiteral(host: string): boolean {
	const h = bareHost(host);
	const fam = net.isIP(h);
	if (fam === 0) return false;
	return LOCAL_ADDRESSES.check(h, fam === 4 ? 'ipv4' : 'ipv6');
}

/** Is `host` an IP LITERAL that is not a public unicast address? PURE.
 *  v1.20.0 fix wave (D13): delegates to the ONE non-public set in
 *  @morphit/net-defense (loopback, RFC 1918, link-local, 0/8, CGNAT,
 *  benchmarking, multicast, reserved, ULA, site-local, NAT64, 6to4, Teredo,
 *  IPv4-compatible and IPv4-mapped in any form). It used to keep its own list,
 *  which disagreed with the probe-time check. */
export function isNonPublicAddressLiteral(host: string): boolean {
	return isNonPublicIpLiteral(bareHost(host));
}

/** Local = a local address literal, or exactly `localhost`. PURE. */
export function isLocalHost(host: string): boolean {
	return bareHost(host) === 'localhost' || isLocalAddressLiteral(host);
}

/**
 * Does a DNS NAME dress itself as a non-public address — leading numeric labels
 * that spell a private/loopback/link-local prefix (`10.x.example`,
 * `192.168.x.example`, `10.0.0.1.nip.io`)? Such a name can only be meant to be
 * mistaken for an address by somebody's prefix check. An apex of two labels
 * (`10.tv`) is left alone: it is a real registrable name, and nothing reads it
 * as an address. IP literals return false — ask {@link isNonPublicAddressLiteral}.
 * PURE.
 */
export function nameMimicsNonPublicAddress(host: string): boolean {
	const h = bareHost(host).replace(/\.$/, '');
	if (h.length === 0 || net.isIP(h) !== 0) return false;
	const labels = h.split('.');
	if (labels.length <= 2) return false;
	const octets: string[] = [];
	for (const l of labels) {
		if (octets.length === 4 || !/^\d{1,3}$/.test(l) || Number(l) > 255) break;
		octets.push(String(Number(l)));
	}
	if (octets.length === 0) return false;
	// The numeric labels must ALONE decide it: the range is non-public whatever
	// the missing octets are, i.e. both the lowest (…0) and highest (…255)
	// completion are non-public. Zero-padding alone made `192.example.org`
	// (→ 192.0.0.0, inside the non-public 192.0.0.0/24) look like an address
	// once that /24 joined the set (v1.20.0 fix wave 2).
	const low = [...octets];
	const high = [...octets];
	while (low.length < 4) low.push('0');
	while (high.length < 4) high.push('255');
	return isNonPublicAddressLiteral(low.join('.')) && isNonPublicAddressLiteral(high.join('.'));
}

// ─── when a Blurt RPC endpoint list means "hidden-only" ──────────
//
// ONE home for this rule. The relay decides from it whether to refuse clearnet
// and drop Web Push; `morphit-ops upgrade` decides from it whether an existing
// node's relay needs bringing into line with its hidden-only indexer. Two
// readings of "hidden-only" would let the upgrade declare a relay fixed that
// the relay itself does not consider hidden-only.

/** A `.onion` / `.i2p` endpoint is SELF-AUTHENTICATING: the network provides
 *  the encryption and the address is the public key, so it is served over plain
 *  `http://`. Accept `http://` ONLY for those hosts. PURE. */
export function isHiddenServiceOrigin(o: string): boolean {
	if (!o.startsWith('http://')) return false;
	try {
		const h = new URL(o).hostname.toLowerCase();
		return h.endsWith('.onion') || h.endsWith('.i2p');
	} catch {
		return false;
	}
}

/** Hidden-only: at least one endpoint across both lists, and every one of them
 *  a hidden service. Onions listed in a CLEARNET knob count as hidden — that
 *  knob has always accepted `http://` hidden entries. PURE. */
export function isHiddenOnlyEndpointSet(
	clearnetList: readonly string[],
	hiddenList: readonly string[]
): boolean {
	const all = [...clearnetList, ...hiddenList];
	return all.length > 0 && all.every((ep) => isHiddenServiceOrigin(ep));
}

// ─── SOCKS5 wire helpers (pure — unit-tested without a socket) ────

/** SOCKS5 greeting: version 5, one method, "no authentication". */
export function socks5Greeting(): Buffer {
	return Buffer.from([0x05, 0x01, 0x00]);
}

/** Parse the server's greeting reply. Valid = `[0x05, 0x00]` (no-auth chosen). */
export function parseSocks5Greeting(reply: Buffer): { ok: boolean; error?: string } {
	if (reply.length < 2) return { ok: false, error: 'short greeting reply' };
	if (reply[0] !== 0x05) return { ok: false, error: `bad version 0x${reply[0]?.toString(16)}` };
	if (reply[1] !== 0x00) return { ok: false, error: 'proxy requires authentication' };
	return { ok: true };
}

/** SOCKS5 CONNECT request to `host:port` using ATYP=domain (Tor resolves the
 *  .onion itself — we never resolve it locally). */
export function socks5ConnectRequest(host: string, port: number): Buffer {
	const h = Buffer.from(host, 'ascii');
	if (h.length > 255) throw new Error('socks5: hostname too long');
	const buf = Buffer.alloc(4 + 1 + h.length + 2);
	buf[0] = 0x05; // version
	buf[1] = 0x01; // CONNECT
	buf[2] = 0x00; // reserved
	buf[3] = 0x03; // ATYP = domain name
	buf[4] = h.length;
	h.copy(buf, 5);
	buf.writeUInt16BE(port, 5 + h.length);
	return buf;
}

const SOCKS5_REPLY: Record<number, string> = {
	0x00: 'succeeded',
	0x01: 'general failure',
	0x02: 'connection not allowed',
	0x03: 'network unreachable',
	0x04: 'host unreachable',
	0x05: 'connection refused',
	0x06: 'ttl expired',
	0x07: 'command not supported',
	0x08: 'address type not supported'
};

/** Parse the CONNECT reply. rep byte 0x00 = success; anything else = the target
 *  (the .onion) is unreachable — NOT a proxy fault. */
export function parseSocks5ConnectReply(reply: Buffer): { ok: boolean; error?: string } {
	if (reply.length < 2) return { ok: false, error: 'short connect reply' };
	if (reply[0] !== 0x05) return { ok: false, error: `bad version 0x${reply[0]?.toString(16)}` };
	const rep = reply[1] ?? 0xff;
	if (rep === 0x00) return { ok: true };
	return { ok: false, error: SOCKS5_REPLY[rep] ?? `reply 0x${rep.toString(16)}` };
}

/** Marker on errors that mean the PROXY itself is unreachable (Tor down / wrong
 *  port) rather than the target onion — the scheduler uses this to avoid
 *  penalising a healthy peer for our own daemon being offline. */
/**
 * Whether a local transport fault, once established as possibly OURS, is
 * evidence about the NETWORK or only about the one address that produced it.
 *
 * `conclusive` means the error names our own end and no peer could have caused
 * it: our connector could not reach our proxy, or the refused connection
 * carries our configured proxy's address and port.
 *
 * `ambiguous` means the same shape is produced by a peer's address being wrong.
 * A Lokinet DNS miss carries THEIR name; a refused CONNECT carries a status
 * whose meaning differs per router. One of those is evidence about an address;
 * two distinct ones are evidence about the router.
 */
export type LocalFaultConfidence = 'conclusive' | 'ambiguous';

export class ProxyUnavailableError extends Error {
	/** Set when this marker was built by {@link asLocalTransportFault}, which
	 *  classifies while the ORIGINAL error is still in hand. Undefined on one
	 *  raised directly (a blanked config, a test seam); a consumer then falls
	 *  back to what the network alone implies. */
	confidence?: LocalFaultConfidence;
}

/**
 * The local HTTP proxy ANSWERED a `CONNECT` and refused it.
 *
 * Distinct from {@link ProxyUnavailableError} because the proxy is running and
 * talking to us — what failed is the tunnel it was asked to open, and the
 * status is the only thing that says why. It is kept as a NUMBER rather than
 * recovered from prose, which is the whole reason the CONNECT connector below
 * exists: undici's `ProxyAgent` reports a refused tunnel as `UND_ERR_ABORTED`
 * with the status inside the message ("Proxy response (403) !== 200 when HTTP
 * Tunneling"), and `UND_ERR_ABORTED` is also what an ordinary request abort
 * produces. There is nothing in that shape a decision can rest on.
 *
 * WHOSE FAULT IT IS CANNOT BE READ FROM ONE OF THESE, and no attempt is made.
 * A router configured to refuse CONNECT outright (the Java router's
 * `i2ptunnel.httpclient.allowInternalSSL=false` does exactly that, port 80
 * included despite the name) refuses every destination — ours. A router that
 * cannot resolve or reach one destination refuses that one — theirs. Both
 * answer with a status, and which status means which is a per-router detail
 * nobody here has verified against a live Java router. So the status is
 * CARRIED, not interpreted, and the ambiguity is settled the way Lokinet's is:
 * by corroboration across distinct addresses.
 */
export class ProxyConnectRejectedError extends Error {
	readonly status: number;
	constructor(status: number, detail: string) {
		// The reason phrase is the PROXY's text, and it ends up in this error's
		// message, which becomes a `recentFailures[].reason` on /v1/health. That
		// list is bounded to twenty entries but each entry's string was not, and
		// the header this came from is allowed up to 64 KB — so a proxy with a
		// verbose or broken reason phrase could put a megabyte of its own text
		// into an operator endpoint. A real HTTP reason phrase is a few words.
		// Bounded here rather than at the endpoint because this is where the
		// untrusted text enters, and the same principle the intake is built on:
		// bound it in the dimension the other side controls.
		super(`proxy refused CONNECT with ${status}: ${detail.slice(0, MAX_REASON_PHRASE)}`);
		this.status = status;
	}
}

/** Longest proxy reason phrase kept. RFC 9110 gives no limit and real ones are
 *  a few words; this is generous for anything meaningful and small enough that
 *  twenty of them cannot bloat a health response. */
const MAX_REASON_PHRASE = 200;

// ─── SOCKS5 undici connector ─────────────────────────────────────

export function parseHostPort(hp: string, fallbackPort: number): { host: string; port: number } {
	const i = hp.lastIndexOf(':');
	if (i === -1) return { host: hp, port: fallbackPort };
	return { host: hp.slice(0, i), port: Number(hp.slice(i + 1)) || fallbackPort };
}

// ─── "was that our fault or theirs?" ─────────────────────────────

/**
 * Walk an error's `cause` chain, outermost first.
 *
 * `fetch()` does not propagate the error a connector threw — it reports
 * `TypeError: fetch failed` and hangs the real reason off `cause`. So an
 * `err instanceof ProxyUnavailableError` at a fetch boundary is ALWAYS false,
 * however carefully the connector raised one, and a caller written that way
 * silently takes the branch it was trying to avoid. Everything below walks.
 *
 * Bounded and cycle-safe: an error chain is attacker-adjacent (a peer's
 * response can influence what undici raises), and an unbounded walk over a
 * self-referential `cause` is an infinite loop in the failure path.
 */
export function causeChain(err: unknown, maxDepth = 8): unknown[] {
	const out: unknown[] = [];
	const seen = new Set<unknown>();
	let cur: unknown = err;
	while (cur !== null && cur !== undefined && out.length < maxDepth && !seen.has(cur)) {
		seen.add(cur);
		out.push(cur);
		cur = (cur as { cause?: unknown }).cause;
	}
	return out;
}

/** Socket-level codes that mean a connection attempt never completed. */
const CONNECT_FAILURE_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ETIMEDOUT',
	'EADDRNOTAVAIL',
	'EPIPE'
]);

/** getaddrinfo outcomes that mean a NAME did not resolve. */
const RESOLVE_FAILURE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);

// ─── is OUR lokinet alive? ───────────────────────────────────────

/**
 * The one `.loki` name that is good by construction: lokinet answers
 * `localhost.loki` with this node's own address. It comes from no peer's chain
 * record, so it resolving says something about OUR router and resolver path
 * and nothing about anyone else.
 *
 * This is the signal the Lokinet corroboration rule was written without. Its
 * design note says a direct probe "was considered and rejected: the only honest
 * one is resolving a name known to be good, and we have none". This is one.
 * Verified against lokinet's own documented usage (`host -t cname
 * localhost.loki 127.3.2.1` returns the node's address) and lokinet issue #226,
 * which added it for exactly this purpose.
 */
export const LOKINET_SELF_NAME = 'localhost.loki';

/** What the last liveness check found: true = our lokinet resolved its own
 *  name; false = it did not; null = never checked. Process-wide, like the
 *  router's clearnet policy — it describes this box, not any peer. */
let lokinetLive: boolean | null = null;

/** Record the result of resolving {@link LOKINET_SELF_NAME}. */
export function noteLokinetLiveness(live: boolean | null): void {
	lokinetLive = live;
}

/** The last recorded result, or null if never checked. */
export function lokinetLiveness(): boolean | null {
	return lokinetLive;
}

/**
 * Did this push fail because OUR OWN transport for `network` is unusable,
 * rather than because the peer is down?
 *
 * The distinction decides who gets blamed and what happens next. A peer that
 * is genuinely unreachable should be recorded as unreachable. A peer we could
 * not reach because our own Tor daemon is not running is a peer we know nothing
 * about — and, if it published a clearnet address too, a peer we should simply
 * dial the other way instead.
 *
 * Each network answers differently, and each shape below was read off a real
 * error object rather than reasoned about:
 *
 *   tor  — the SOCKS connector raises {@link ProxyUnavailableError} for a
 *          socket error or a refused greeting, and a PLAIN Error for a SOCKS
 *          reply code (`onion unreachable via Tor: host unreachable`). That
 *          split is already exactly the question being asked, so the marker
 *          class is the whole answer. It arrives wrapped, hence `causeChain`.
 *
 *   i2p  — undici's `ProxyAgent` dials the HTTP proxy itself and raises a bare
 *          `Error` with `code`/`address`/`port` set. There is no marker class
 *          to find, so the address is matched against the CONFIGURED proxy
 *          endpoint. That is exact rather than heuristic: once the connection
 *          to i2pd is up, a dead I2P destination comes back as an HTTP status
 *          from i2pd, never as a connect error to 127.0.0.1:4444.
 *
 *   loki — there is no proxy at all; lokinet answers `.loki` names on its own
 *          tun. So "lokinet is not running here" surfaces as the name failing
 *          to resolve. Gated on the network being `loki`, so an ordinary
 *          clearnet DNS failure can never be read as a local transport fault.
 *
 * Returns false for a clearnet URL under every circumstance: clearnet has no
 * local transport that can be missing.
 */
export function isLocalTransportFault(
	err: unknown,
	network: HiddenNetwork,
	config: HiddenServiceProxyConfig
): boolean {
	if (network === null) return false;
	const chain = causeChain(err);

	// Raised directly by the dispatcher when the operator BLANKED the setting,
	// and by the SOCKS connector when the daemon refused the socket. Either way
	// it is ours, on whichever network raised it.
	if (chain.some((e) => e instanceof ProxyUnavailableError)) return true;

	if (network === 'i2p') {
		// The proxy answered and refused the tunnel. Possibly ours (a router
		// configured to refuse CONNECT refuses every destination), possibly
		// theirs (one it cannot resolve or reach) — see
		// ProxyConnectRejectedError. Ambiguous, never ignored.
		if (chain.some((e) => e instanceof ProxyConnectRejectedError)) return true;
		const { host, port } = parseHostPort(config.i2pHttpProxy, 4444);
		return chain.some((e) => {
			const c = e as { code?: unknown; address?: unknown; port?: unknown };
			if (typeof c.code !== 'string' || !CONNECT_FAILURE_CODES.has(c.code)) return false;
			return c.address === host && c.port === port;
		});
	}

	if (network === 'loki') {
		// OUR lokinet just answered its own name, so the resolver path works: a
		// peer's `.loki` failing to resolve is that peer's record, not our end.
		// This is what lets a dead `.loki` name be blamed on its owner — and stop
		// holding a fan-out slot — without reintroducing F2, since the moment our
		// router is actually gone the check fails and every miss is ours again.
		if (lokinetLive === true) return false;
		return chain.some((e) => {
			const c = e as { code?: unknown; syscall?: unknown };
			return (
				typeof c.code === 'string' &&
				RESOLVE_FAILURE_CODES.has(c.code) &&
				(c.syscall === undefined || c.syscall === 'getaddrinfo')
			);
		});
	}

	return false;
}

/**
 * Is {@link ProxyUnavailableError} anywhere in this error's chain?
 *
 * The check every CONSUMER should use. `instanceof` on its own is wrong at any
 * boundary a `fetch()` sits behind, and every consumer sits behind one — so the
 * safe form is given a name rather than left to be rediscovered correctly at
 * each call site. It was not rediscovered correctly at the last three.
 *
 * Pairs with {@link asLocalTransportFault}, which is what makes the marker
 * reliable enough for this to be the only check a consumer needs: the two
 * transport entry points normalise a local fault on ANY of the three networks
 * into this class, so a consumer no longer has to know which network it was
 * talking to or what that network's failure looks like.
 */
export function isProxyUnavailable(err: unknown): boolean {
	return causeChain(err).some((e) => e instanceof ProxyUnavailableError);
}

/**
 * Normalise a local transport fault into {@link ProxyUnavailableError}.
 *
 * Called by the transport entry points — the only code that knows BOTH which
 * network was dialled and how this instance is configured to reach it, which
 * is exactly what {@link isLocalTransportFault} needs and what no consumer
 * further up has. Past this point the marker class is trustworthy on all three
 * networks, so a caller can ask one question instead of three.
 *
 * The original error is kept as `cause`, so nothing an operator would want to
 * read is lost — the wrapper adds a verdict, it does not replace the evidence.
 * An error that is ALREADY the marker is returned untouched rather than
 * double-wrapped.
 */
/**
 * Given an error already established as a local fault, does it name OUR end?
 *
 * Read off the ERROR rather than off the network, because the two do not line
 * up: I2P produces a conclusive shape (a refused connection to our configured
 * proxy address) AND an ambiguous one (a refused CONNECT, whose status means
 * different things on i2pd and the Java router). The network is only a
 * fallback, for a marker raised without a classification.
 */
export function localFaultConfidence(
	err: unknown,
	network: HiddenNetwork
): LocalFaultConfidence {
	const chain = causeChain(err);
	// 1. A marker built by asLocalTransportFault already carries the answer,
	//    computed while the original error was still in hand. Past that point
	//    the wrapper looks the same whatever produced it, so re-deriving here
	//    would discard the only moment the distinction was visible.
	for (const e of chain) {
		if (e instanceof ProxyUnavailableError && e.confidence !== undefined) return e.confidence;
	}
	// 2. A refused CONNECT is ambiguous whatever else is true of the chain: the
	//    proxy is up and talking, and the status alone cannot say whether it
	//    refuses every destination (ours) or only this one (theirs).
	if (chain.some((e) => e instanceof ProxyConnectRejectedError)) return 'ambiguous';
	// 3. Otherwise the network decides — the FALLBACK, not the rule. Tor and I2P
	//    are reached through a connector of ours that raises only when OUR proxy
	//    failed; Lokinet has no proxy at all, and its local fault is a DNS miss
	//    carrying the peer's own name.
	//    With the liveness check in hand, Lokinet stops being ambiguous: our
	//    router failing to resolve its OWN name is conclusive about our end.
	if (network === 'loki') return lokinetLive === false ? 'conclusive' : 'ambiguous';
	return 'conclusive';
}

export function asLocalTransportFault(
	err: unknown,
	network: HiddenNetwork,
	config: HiddenServiceProxyConfig
): unknown {
	if (err instanceof ProxyUnavailableError) return err;
	if (!isLocalTransportFault(err, network, config)) return err;
	const detail = err instanceof Error ? err.message : String(err);
	const wrapped = new ProxyUnavailableError(`local ${network} transport unavailable: ${detail}`, {
		cause: err
	});
	// Classified HERE, where the original error is still available.
	wrapped.confidence = localFaultConfidence(err, network);
	return wrapped;
}

/** Build an undici `connect` function that tunnels to the requested origin via a
 *  SOCKS5 proxy. undici calls this with the TARGET host/port (the onion); we
 *  hand back a socket already tunneled to it. Returned as a plain function so
 *  this module needs no undici dependency (the consumer casts it into
 *  `new Agent({ connect })`). */
/**
 * Put bytes that arrived with the proxy's reply back in front of the tunnelled
 * conversation, so the consumer's HTTP parser reads them first.
 *
 * PAUSED FIRST (v1.18.0 review). The socket is in flowing mode here — the
 * handshake read it with a 'data' listener — and `unshift` on a flowing stream
 * with no 'data' listener left emits the chunk into nobody: measured, the bytes
 * were simply gone, with undici's 'readable'-style reader and with a 'data' one
 * alike. The comment beside the old `unshift` said dropping them "would silently
 * truncate a response"; it was doing exactly that. Pausing keeps them buffered
 * until the consumer attaches, and resuming on the next tick restores flowing
 * mode for a 'data' consumer (for a 'readable' one, resume is a no-op).
 */
function handBack(sock: net.Socket, rest: Buffer): void {
	if (rest.length === 0) return;
	sock.pause();
	sock.unshift(rest);
	process.nextTick(() => sock.resume());
}

/**
 * An `https:` URL was handed to a hidden-network connector (v1.20.0 fix wave 2,
 * S9). The connectors return a PLAIN socket — hidden networks encrypt and
 * authenticate end to end, so their URLs are `http://` — and a missing port
 * defaults to 80. Dialling an `https://<host>.onion` URL therefore used to
 * speak plaintext HTTP to port 80: not what the URL says, and silently. It is
 * now refused before the proxy is contacted. Write the endpoint as
 * `http://<host>:<port>`.
 */
export class HiddenHttpsUnsupportedError extends Error {
	constructor(readonly host: string) {
		super(
			`refusing https:// for hidden-network host ${host}: Tor/I2P carry plain HTTP (the network ` +
				`encrypts and authenticates), so use http://${host}:<port> instead`
		);
		this.name = 'HiddenHttpsUnsupportedError';
	}
}

export function makeSocks5Connector(socksHost: string, socksPort: number) {
	return (
		opts: { hostname: string; port: number | string; protocol?: string },
		cb: (err: Error | null, socket: net.Socket | null) => void
	): void => {
		if (opts.protocol === 'https:') {
			cb(new HiddenHttpsUnsupportedError(opts.hostname), null);
			return;
		}
		const targetHost = opts.hostname;
		const targetPort = typeof opts.port === 'string' ? Number(opts.port) || 80 : opts.port || 80;
		const sock = net.connect({ host: socksHost, port: socksPort });
		let stage: 'greet' | 'connect' = 'greet';
		let acc = Buffer.alloc(0);
		// SETTLED EXACTLY ONCE (v1.18.0 review, S8), as the CONNECT connector
		// below already was. Our 'error' listener outlives the handshake, so a
		// socket error on an idle pooled tunnel used to call undici's connect
		// callback a SECOND time, long after it had been handed the socket.
		let settled = false;
		const fail = (err: Error): void => {
			if (settled) return;
			settled = true;
			sock.destroy();
			cb(err, null);
		};
		/** A failure while only OUR proxy is involved names our end, not the
		 *  peer (F2's class): during the greeting nothing has been asked about
		 *  the target yet. */
		const ourEnd = (why: string): Error =>
			stage === 'greet'
				? new ProxyUnavailableError(`SOCKS proxy ${socksHost}:${socksPort} ${why}`)
				: new Error(`onion unreachable via Tor: ${why}`);
		sock.once('error', (err) =>
			fail(
				// The ORIGINAL error is kept as `cause`: the verdict is an addition,
				// never a replacement. An operator reading a log needs the
				// ECONNREFUSED and its address, not our paraphrase of it.
				new ProxyUnavailableError(
					`SOCKS proxy ${socksHost}:${socksPort} unreachable: ${err.message}`,
					{ cause: err }
				)
			)
		);
		sock.setTimeout(HIDDEN_HANDSHAKE_TIMEOUT_MS, () =>
			fail(stage === 'greet' ? ourEnd('did not answer the greeting in time') : new Error('SOCKS handshake timeout'))
		);
		// A close before the handshake finished is a fact NOW, not after the
		// handshake timeout: without this it waited the full twenty seconds.
		const onEarlyClose = (): void => fail(ourEnd('closed the connection during the handshake'));
		sock.once('close', onEarlyClose);
		sock.once('connect', () => sock.write(socks5Greeting()));
		sock.on('data', (chunk: Buffer) => {
			if (settled) return;
			acc = Buffer.concat([acc, chunk]);
			if (stage === 'greet') {
				if (acc.length < 2) return;
				const g = parseSocks5Greeting(acc);
				if (!g.ok) return fail(new ProxyUnavailableError(`SOCKS greeting: ${g.error}`));
				acc = acc.subarray(2);
				stage = 'connect';
				sock.write(socks5ConnectRequest(targetHost, targetPort));
				if (acc.length === 0) return;
			}
			// connect stage. The reply's length depends on the address type it
			// carries (RFC 1928 §6): IPv4 10, IPv6 22, a domain 7 + its length.
			// Tor answers with IPv4, but a reply split or sized otherwise must not
			// leave its tail in front of the HTTP response undici is about to read.
			if (acc.length < 5) return;
			if (acc[1] !== 0x00) {
				const r = parseSocks5ConnectReply(acc);
				return fail(new Error(`onion unreachable via Tor: ${r.error ?? 'refused'}`));
			}
			const atyp = acc[3];
			const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 7 + (acc[4] ?? 0) : -1;
			if (need < 0) return fail(new Error(`onion unreachable via Tor: bad address type 0x${(atyp ?? 0).toString(16)}`));
			if (acc.length < need) return;
			const r = parseSocks5ConnectReply(acc.subarray(0, need));
			if (!r.ok) return fail(new Error(`onion unreachable via Tor: ${r.error}`));
			settled = true;
			// Tunnel established. Detach our handshake handlers and hand the raw
			// socket to undici for the HTTP exchange; anything after the reply
			// belongs to that exchange.
			const rest = acc.subarray(need);
			sock.removeAllListeners('data');
			sock.removeAllListeners('timeout');
			sock.removeListener('close', onEarlyClose);
			sock.setTimeout(0);
			handBack(sock, rest);
			cb(null, sock);
		});
	};
}

/** Build an undici `connect` function that tunnels to the requested origin via
 *  an HTTP proxy's `CONNECT` method — the I2P counterpart of
 *  {@link makeSocks5Connector}, written for the same reason: a hand-rolled
 *  handshake is the only way the failure arrives as something a decision can be
 *  made from. i2pd accepts `CONNECT host:port` on any port including 80
 *  (libi2pd_client/HTTPProxy.cpp — no port whitelist) and the Java router has
 *  supported CONNECT since 0.9.11. */
export function makeHttpConnectConnector(proxyHost: string, proxyPort: number) {
	return (
		opts: { hostname: string; port: number | string; protocol?: string },
		cb: (err: Error | null, socket: net.Socket | null) => void
	): void => {
		// Same rule as the SOCKS connector: no silent https → plaintext :80.
		if (opts.protocol === 'https:') {
			cb(new HiddenHttpsUnsupportedError(opts.hostname), null);
			return;
		}
		const targetHost = opts.hostname;
		const targetPort = typeof opts.port === 'string' ? Number(opts.port) || 80 : opts.port || 80;
		const authority = `${targetHost}:${targetPort}`;
		const sock = net.connect({ host: proxyHost, port: proxyPort });
		let acc = Buffer.alloc(0);
		let settled = false;
		const fail = (err: Error): void => {
			if (settled) return;
			settled = true;
			sock.destroy();
			cb(err, null);
		};
		sock.once('error', (err) =>
			fail(
				// The ORIGINAL error is kept as `cause` — see the note in the SOCKS
				// connector above.
				new ProxyUnavailableError(
					`HTTP proxy ${proxyHost}:${proxyPort} unreachable: ${err.message}`,
					{ cause: err }
				)
			)
		);
		sock.setTimeout(HIDDEN_HANDSHAKE_TIMEOUT_MS, () => fail(new Error('CONNECT handshake timeout')));
		// (v1.18.0 deep-deep, M1) A proxy that closes before answering the
		// CONNECT — i2pd restarting, or shedding load — is OUR end failing, and a
		// fact NOW. Without this listener nothing settled at all: destroying the
		// socket also cleared its handshake timer, so undici's connect callback
		// was never called, the pooled I2P route (one connection per origin)
		// stayed "connecting" for good, and every later push queued behind it
		// and died as a caller timeout blamed on the peer, until a restart. The
		// SOCKS connector above got this listener in S10; this one was missed.
		const onEarlyClose = (): void =>
			fail(
				new ProxyUnavailableError(
					`HTTP proxy ${proxyHost}:${proxyPort} closed the connection during the CONNECT handshake`
				)
			);
		sock.once('close', onEarlyClose);
		sock.once('connect', () => {
			sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
		});
		sock.on('data', (chunk: Buffer) => {
			if (settled) return;
			acc = Buffer.concat([acc, chunk]);
			const end = acc.indexOf('\r\n\r\n');
			if (end === -1) {
				// A proxy answering with an unbounded header block is not one to
				// keep reading from.
				if (acc.length > 64 * 1024) fail(new Error('CONNECT response header too large'));
				return;
			}
			const header = acc.subarray(0, end).toString('latin1');
			const statusLine = header.split('\r\n', 1)[0] ?? '';
			const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
			if (m === null) {
				return fail(
					new ProxyUnavailableError(`proxy sent a malformed CONNECT reply: ${statusLine}`)
				);
			}
			const status = Number(m[1]);
			if (status < 200 || status > 299) {
				return fail(new ProxyConnectRejectedError(status, (m[2] ?? '').trim() || statusLine));
			}
			settled = true;
			// Bytes the proxy sent AFTER the blank line belong to the tunnelled
			// conversation. Dropping them would silently truncate a response that
			// arrived in the same TCP segment as the CONNECT reply.
			const rest = acc.subarray(end + 4);
			sock.removeAllListeners('data');
			sock.removeAllListeners('timeout');
			sock.removeListener('close', onEarlyClose);
			sock.setTimeout(0);
			handBack(sock, rest);
			cb(null, sock);
		});
	};
}
