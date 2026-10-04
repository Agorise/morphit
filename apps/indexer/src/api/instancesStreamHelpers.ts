/**
 * Morphit indexer — instances-stream pure helpers.
 *
 * Extracted out of instancesStream.ts so they're testable in
 * environments where the @hono runtime isn't installed (the
 * tsx smoke runner).  The Hono SSE wiring stays in
 * instancesStream.ts; this file is platform-independent
 * pure functions.
 *
 * Also home to the canonical InstanceDirectoryEntry type
 * (re-exported by instances.ts for the public API contract)
 * — the type's natural home is alongside the function that
 * produces it.  Avoids a circular import between instances.ts
 * and this module.
 */

import {
	altNetworksFromUntrusted,
	contactUrlOrNull,
	textOrNull,
	CACHED_NAME_MAX,
	CACHED_TAGLINE_MAX
} from '$indexer/instanceCacheSanitize';

/** The reasons `federationProbe.persistListedNotProbed` records beside a
 *  `good` it did not verify (kept in step with chatFastFederation's copy). */
const LISTED_NOT_PROBED_REASONS: ReadonlySet<string> = new Set([
	'hidden_service_not_network_probed',
	'clearnet_peer_not_probed_hidden_only'
]);

export interface InstanceDirectoryEntry {
	origin: string;
	operator_account: string;
	operator_tag: string | null;
	operator_display_name: string | null;
	name: string | null;
	tagline: string | null;
	contact_url: string | null;
	/** v1.16.1 — the peer proved zero clearnet use (drives the strong label). */
	clearnet_eliminated: boolean;
	alt_networks: {
		tor: string | null;
		lokinet: string | null;
		i2p_b32: string | null;
		i2p_name: string | null;
		ens: string | null;
		i2p: string | null; // deprecated; see InstanceDirectoryEntry
		nostr: string | null;
	} | null;
	status: string;
	registered_at: string; // ISO8601
	last_probed_at: string | null; // ISO8601 or null
	indexed_block: number | null;
	chain_lag_sec: number | null;
	consecutive_failures: number;
}

export interface DirectoryRow {
	origin: string;
	operator_account: string;
	operator_tag: string | null;
	operator_display_name: string | null;
	cached_name: string | null;
	cached_tagline: string | null;
	cached_contact_url: string | null;
	cached_alt_networks: unknown | null;
	/** v1.15.3 — the operator's ON-CHAIN-published addresses (operators.reg_alt_networks).
	 *  Fallback for the pills when a censored node has never been successfully probed. */
	reg_alt_networks?: unknown | null;
	last_probe_status: string | null;
	/** Read so a 'good' the probe did not verify is not shown as good (E14). */
	last_probe_error?: string | null;
	registered_at_time: Date;
	last_probed_at: Date | null;
	cached_indexed_block: string | number | null;
	cached_chain_lag_sec: number | null;
	cached_clearnet_eliminated?: boolean | null;
	consecutive_failures: number;
}

/** Normalize alt_networks from the JSONB cache or the on-chain registration.
 *  Pre-2026-05 records stored just `{tor, lokinet, i2p, nostr}`; the legacy
 *  `i2p` value is routed to `i2p_b32` or `i2p_name` by shape. Since v1.20.0
 *  (E7) EVERY value is re-checked against its network's shape on the way out
 *  (instanceCacheSanitize): the cache holds what a PEER said about itself, and
 *  rows cached before the probe validated anything are cleaned here without
 *  waiting for a re-probe. */
function normalizeAltNetworks(raw: unknown): InstanceDirectoryEntry['alt_networks'] {
	const a = altNetworksFromUntrusted(raw);
	if (a === null) return null;
	return { ...a, i2p: null }; // never re-emit legacy on the wire
}

/** v1.15.3 — merge the probe-cached alt_networks with the operator's ON-CHAIN
 *  published ones. v1.20.0 (E7): the ON-CHAIN value wins per field. It is the
 *  one the operator SIGNED; the cached one is whatever the origin answered, and
 *  letting it win meant a peer's own /v1/instance could repoint the "Tor" pill
 *  of a signed registration. The cache still fills fields the registration does
 *  not carry (nostr) or left empty. */
function mergeAltNetworks(
	cached: InstanceDirectoryEntry['alt_networks'],
	reg: InstanceDirectoryEntry['alt_networks']
): InstanceDirectoryEntry['alt_networks'] {
	if (cached === null && reg === null) return null;
	const empty = { tor: null, lokinet: null, i2p_b32: null, i2p_name: null, ens: null, i2p: null, nostr: null } as const;
	const c = cached ?? empty;
	const g = reg ?? empty;
	return {
		tor: g.tor ?? c.tor,
		lokinet: g.lokinet ?? c.lokinet,
		i2p_b32: g.i2p_b32 ?? c.i2p_b32,
		i2p_name: g.i2p_name ?? c.i2p_name,
		ens: g.ens ?? c.ens,
		i2p: null,
		nostr: g.nostr ?? c.nostr
	};
}

/** Render one DB row as an InstanceDirectoryEntry — same shape
 *  as the /v1/instances endpoint returns.  Kept identical here
 *  so subscribers can apply diff events directly to whatever
 *  they got from the snapshot event. */
export function rowToEntry(r: DirectoryRow): InstanceDirectoryEntry {
	return {
		origin: r.origin,
		operator_account: r.operator_account,
		operator_tag: r.operator_tag,
		operator_display_name: r.operator_display_name,
		// Re-checked on the way out (E7): see instanceCacheSanitize.
		name: textOrNull(r.cached_name, CACHED_NAME_MAX),
		tagline: textOrNull(r.cached_tagline, CACHED_TAGLINE_MAX),
		contact_url: contactUrlOrNull(r.cached_contact_url),
		clearnet_eliminated: r.cached_clearnet_eliminated ?? false,
		alt_networks: mergeAltNetworks(
			normalizeAltNetworks(r.cached_alt_networks),
			normalizeAltNetworks(r.reg_alt_networks ?? null)
		),
		// A peer LISTED without a probe (this node's proxy for it was down, or
		// it is clearnet-only and this node hidden-only) is stored 'good' so it
		// stays in the directory — but nothing verified it, and telling a user
		// "Good" about it was a claim nobody had checked (v1.20.0, E14). Shown
		// as not-yet-checked instead.
		status:
			r.last_probe_status === 'good' &&
			r.last_probe_error !== undefined &&
			r.last_probe_error !== null &&
			LISTED_NOT_PROBED_REASONS.has(r.last_probe_error)
				? 'never'
				: (r.last_probe_status ?? 'never'),
		registered_at: r.registered_at_time.toISOString(),
		last_probed_at: r.last_probed_at !== null ? r.last_probed_at.toISOString() : null,
		indexed_block: r.cached_indexed_block !== null ? Number(r.cached_indexed_block) : null,
		chain_lag_sec: r.cached_chain_lag_sec,
		consecutive_failures: r.consecutive_failures
	};
}

/** Lightweight signature for change detection.  Two rows compare
 *  equal iff the user-visible fields match.
 *
 *  Includes everything the /instances page renders.  Excludes
 *  `consecutive_failures` (internal probe metric, not displayed).
 *
 *  We DO include last_probed_at because the UI shows
 *  "Last probed: <date>" — without it in the signature, those
 *  timestamps would never update without a page refresh, which
 *  defeats the "real-time" UX promise.
 *
 *  We DO include operator_display_name and operator_tag because
 *  a future morphit_operator_update_v1 op will change them
 *  without touching other fields; UI surfaces them, so signature
 *  must reflect.
 *
 *  Cost: each successful re-probe (every 10min for healthy peers)
 *  bumps last_probed_at, which changes the signature, which
 *  emits an instance_updated event per subscriber.  At ≤200
 *  instances probed at 10min cadence that's <25 events/min —
 *  well below a perception/bandwidth concern. */
export function rowSignature(e: InstanceDirectoryEntry): string {
	// P7-12 audit fix: JSON.stringify on a tuple makes field
	// boundaries unambiguous regardless of content.  Pipe-joined
	// would collide on rows whose user-visible content aligned
	// across field boundaries (e.g. name='A | B', tagline='C'
	// vs name='A', tagline=' B|C').
	return JSON.stringify([
		e.status,
		e.name,
		e.tagline,
		e.contact_url,
		e.indexed_block,
		e.chain_lag_sec,
		e.alt_networks,
		e.last_probed_at,
		e.operator_display_name,
		e.operator_tag,
		// Without it, a badge that changed never reached an open directory.
		e.clearnet_eliminated
	]);
}

/** Format an SSE event frame.  Each event is `event: NAME\n
 *  data: JSON\n\n`.  No id field — we don't need replay because
 *  we always send a snapshot on reconnect. */
export function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
