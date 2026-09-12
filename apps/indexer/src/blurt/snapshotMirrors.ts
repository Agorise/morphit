/**
 * apps/indexer/src/blurt/snapshotMirrors.ts
 *
 * Where a fresh node FETCHES the federation indexer snapshot from.
 *
 * The snapshot itself is anchored once, on-chain, by @morphit (indexer_snapshot_v1
 * — see indexerSnapshotOp.ts). This module decides which COPIES of those bytes to
 * try, and in what order. It is deliberately pure: no fetching, no fs, no chain —
 * just list-building, so every ordering rule is unit-testable.
 *
 * WHY MIRRORS AT ALL
 * Before this, the source list was `forgejo_url` plus a handful of public clearnet
 * IPFS gateways. That is fatal for the nodes we most want to exist: a zero-clearnet
 * (Tor/I2P-only) instance cannot reach ANY of them, so fast-sync — the whole reason
 * a new node is live in minutes instead of days — was clearnet-only in practice.
 * It also made morphit.io a single point of failure for every new instance.
 *
 * THE MODEL: one signer, many mirrors.
 * Trust comes from the on-chain SHA-256 that @morphit signed, and the caller proves
 * every downloaded byte against it. So WHICH copy answered is purely a speed and
 * reachability question, never a trust question — a hostile mirror is caught by
 * arithmetic, not by reputation. That means we can safely fan out to every peer
 * instance, and prefer whichever is closest.
 *
 * ORDERING (fastest + most private first):
 *   1. This box's own kubo gateway, if it runs one — loopback, no network at all.
 *   2. Federation peers on the transport we ALREADY speak. A Tor-only node asks
 *      .onion peers over its existing SOCKS circuit; it never opens a clearnet
 *      socket, so it leaks nothing by fast-syncing.
 *   3. The signed https mirror (forgejo_url).
 *   4. Public IPFS gateways.
 *
 * On a hidden-only node steps 3 and 4 are OMITTED ENTIRELY — fail-closed, the same
 * discipline the hidden release upgrade already follows. A zero-clearnet box must
 * never quietly reach for a clearnet gateway just because the private path was slow.
 */

/** A federation peer's hidden addresses, as the directory / chain reports them. */
export interface PeerHiddenAddresses {
	readonly tor?: string | null;
	readonly i2p_b32?: string | null;
}

export interface SnapshotSourceInputs {
	/** CID of the snapshot tarball, from the signed on-chain op. */
	readonly cid: string;
	/** Optional signed https mirror from the op (clearnet). */
	readonly forgejoUrl?: string | null;
	/** Federation peers that may be re-serving the CID over a hidden transport. */
	readonly peers: readonly PeerHiddenAddresses[];
	/** Public clearnet IPFS gateways (base URLs, no trailing slash). */
	readonly publicGateways: readonly string[];
	/** This box's own kubo gateway base, when it runs one (e.g. http://127.0.0.1:8082). */
	readonly localGateway?: string | null;
	/** True when this node has no clearnet: clearnet sources are omitted, not just deprioritised. */
	readonly hiddenOnly: boolean;
}

export interface SnapshotSource {
	/** Full URL to fetch. */
	readonly url: string;
	/** How this source is reached — drives which proxy the fetcher must use. */
	readonly transport: 'local' | 'tor' | 'i2p' | 'clearnet';
	/** Short human label for progress output ("Tor peer abcd…", "ipfs.io"). */
	readonly label: string;
}

const stripSlash = (s: string): string => s.trim().replace(/\/+$/, '');

/** Tor v3 onion, exactly 56 base32 chars. Anything else is not addressable. */
const ONION_RE = /^[a-z2-7]{56}\.onion$/;
/** I2P base32 destination, 52 chars + .b32.i2p. */
const I2P_B32_RE = /^[a-z2-7]{52}\.b32\.i2p$/;

/** Shorten a hidden host for log output — full 56-char onions wreck a terminal. */
export function shortHiddenLabel(host: string): string {
	const net = host.endsWith('.onion') ? 'Tor' : 'I2P';
	return `${net} peer ${host.slice(0, 8)}…`;
}

/**
 * Build the ordered list of places to try for `cid`.
 *
 * Every entry points at the SAME bytes, which the caller proves against the
 * on-chain sha256 — so this function only has to get the ORDER right, and is
 * free to be generous about how many mirrors it lists.
 *
 * Duplicates are removed (peers are commonly listed under both their directory
 * row and their on-chain registration), preserving first-seen order.
 */
export function buildSnapshotSources(input: SnapshotSourceInputs): SnapshotSource[] {
	const out: SnapshotSource[] = [];
	const seen = new Set<string>();
	const push = (s: SnapshotSource): void => {
		if (seen.has(s.url)) return;
		seen.add(s.url);
		out.push(s);
	};

	const path = `/ipfs/${input.cid}`;

	// 1. Our own gateway: loopback, instant, and it may already hold the bytes
	//    from a previous mirror run. Costs nothing to try first.
	if (input.localGateway && input.localGateway.trim() !== '') {
		push({ url: `${stripSlash(input.localGateway)}${path}`, transport: 'local', label: 'local gateway' });
	}

	// 2. Federation peers over hidden transports. These come first among network
	//    sources for EVERY node, not just hidden-only ones: they are peer-to-peer,
	//    they spread the load off morphit.io, and they keep working when clearnet
	//    access to the canonical box is blocked. Tor before I2P — I2P tunnels are
	//    slow to warm up, so they are the better fallback than the better opener.
	for (const p of input.peers) {
		const tor = (p.tor ?? '').trim().toLowerCase();
		if (ONION_RE.test(tor)) {
			push({ url: `http://${tor}${path}`, transport: 'tor', label: shortHiddenLabel(tor) });
		}
	}
	for (const p of input.peers) {
		const i2p = (p.i2p_b32 ?? '').trim().toLowerCase();
		if (I2P_B32_RE.test(i2p)) {
			push({ url: `http://${i2p}${path}`, transport: 'i2p', label: shortHiddenLabel(i2p) });
		}
	}

	// 3 + 4. Clearnet. A hidden-only node stops here: omitting these is the whole
	//        point — a zero-clearnet box must fail closed and fall back to a full
	//        replay rather than silently deanonymise itself to finish faster.
	if (input.hiddenOnly) return out;

	const forgejo = (input.forgejoUrl ?? '').trim();
	if (/^https:\/\//i.test(forgejo)) {
		push({ url: forgejo, transport: 'clearnet', label: 'https mirror' });
	}
	for (const g of input.publicGateways) {
		const base = stripSlash(g);
		if (base === '') continue;
		let label = base;
		try {
			label = new URL(base).hostname;
		} catch {
			/* keep the raw base as the label */
		}
		push({ url: `${base}${path}`, transport: 'clearnet', label });
	}

	return out;
}

/**
 * True when the node can reach at least one source. A hidden-only node with no
 * peer addresses yet has nowhere private to fetch from, and the caller must say
 * so plainly and fall back to a full replay rather than fail obscurely.
 */
export function hasUsableSource(sources: readonly SnapshotSource[]): boolean {
	return sources.length > 0;
}

/** The frozen op id that carries an operator's on-chain registration. */
export const OPERATOR_REGISTER_OP_ID = 'morphit_operator_register_v1';

/**
 * Pull hidden addresses out of `morphit_operator_register_v1` ops in a raw
 * condenser get_account_history result. PURE + fail-closed: anything malformed
 * is skipped, never thrown on (a volunteer RPC can return almost any shape).
 *
 * This exists to solve fast-sync's chicken-and-egg. A brand-new node has no
 * indexer, so it cannot ask /v1/instances who its peers are — but it CAN read
 * the chain over its baked-in hidden RPC pool, and it is already reading exactly
 * one account's history to find the snapshot op. That same history contains that
 * account's own registration, including the .onion / .b32.i2p it advertises. So
 * a zero-clearnet newcomer gets a private mirror for free, with no extra RPC
 * call and no address baked into the source tree to go stale.
 *
 * Later entries win: a re-registration is an upsert, so the NEWEST address for
 * an account is the one to use.
 */
export function extractPeerAddressesFromHistory(history: unknown): PeerHiddenAddresses[] {
	if (!Array.isArray(history)) return [];
	const byAccount = new Map<string, PeerHiddenAddresses>();

	for (const entry of history) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const body = entry[1];
		if (!body || typeof body !== 'object') continue;
		const op = (body as Record<string, unknown>).op;
		if (!Array.isArray(op) || op.length < 2) continue;
		if (op[0] !== 'custom_json') continue;
		const cj = op[1];
		if (!cj || typeof cj !== 'object') continue;
		const c = cj as Record<string, unknown>;
		if (c.id !== OPERATOR_REGISTER_OP_ID) continue;

		const auths = Array.isArray(c.required_posting_auths) ? c.required_posting_auths : [];
		const account = auths.find((a): a is string => typeof a === 'string' && a.trim() !== '');
		if (account === undefined) continue;

		if (typeof c.json !== 'string') continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(c.json);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== 'object') continue;
		const alt = (parsed as Record<string, unknown>).alt_addresses;
		if (!alt || typeof alt !== 'object') continue;
		const a = alt as Record<string, unknown>;
		const tor = typeof a.tor === 'string' ? a.tor.trim().toLowerCase() : null;
		const i2p = typeof a.i2p_b32 === 'string' ? a.i2p_b32.trim().toLowerCase() : null;
		if (!tor && !i2p) continue;

		byAccount.set(account.toLowerCase(), {
			tor: tor && ONION_RE.test(tor) ? tor : null,
			i2p_b32: i2p && I2P_B32_RE.test(i2p) ? i2p : null
		});
	}

	return [...byAccount.values()].filter((p) => p.tor !== null || p.i2p_b32 !== null);
}
