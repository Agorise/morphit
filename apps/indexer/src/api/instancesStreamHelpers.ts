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

export interface InstanceDirectoryEntry {
	origin: string;
	operator_account: string;
	operator_tag: string | null;
	operator_display_name: string | null;
	name: string | null;
	tagline: string | null;
	contact_url: string | null;
	alt_networks: {
		tor: string | null;
		lokinet: string | null;
		i2p_b32: string | null;
		i2p_name: string | null;
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
	last_probe_status: string | null;
	registered_at_time: Date;
	last_probed_at: Date | null;
	cached_indexed_block: string | number | null;
	cached_chain_lag_sec: number | null;
	consecutive_failures: number;
}

/** Normalize alt_networks from the JSONB cache.  Pre-2026-05
 *  records stored just `{tor, lokinet, i2p, nostr}`; post-2026-05
 *  records store `{tor, lokinet, i2p_b32, i2p_name, nostr}`.
 *  This shim materializes the new shape for both, routing a
 *  legacy `i2p` value to either `i2p_b32` (suffix `.b32.i2p`) or
 *  `i2p_name` (any other `.i2p` suffix).  Old probes get re-cached
 *  the next time they succeed, so this code path goes cold once
 *  every instance has been re-probed (~10 min for `good`
 *  instances, up to a few hours for `stale`). */
function normalizeAltNetworks(raw: unknown): InstanceDirectoryEntry['alt_networks'] {
	if (raw === null || raw === undefined || typeof raw !== 'object') {
		return null;
	}
	const r = raw as Record<string, unknown>;
	const get = (k: string): string | null => {
		const v = r[k];
		return typeof v === 'string' && v.length > 0 ? v : null;
	};
	let i2pB32 = get('i2p_b32');
	let i2pName = get('i2p_name');
	const legacy = get('i2p');
	if (legacy !== null && i2pB32 === null && i2pName === null) {
		// Route legacy by suffix.
		if (legacy.toLowerCase().endsWith('.b32.i2p')) {
			i2pB32 = legacy;
		} else if (legacy.toLowerCase().endsWith('.i2p')) {
			i2pName = legacy;
		}
		// If neither suffix matches, drop the legacy value rather
		// than guess — better to show no link than a broken one.
	}
	return {
		tor: get('tor'),
		lokinet: get('lokinet'),
		i2p_b32: i2pB32,
		i2p_name: i2pName,
		i2p: null, // never re-emit legacy on the wire
		nostr: get('nostr')
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
		name: r.cached_name,
		tagline: r.cached_tagline,
		contact_url: r.cached_contact_url,
		alt_networks: normalizeAltNetworks(r.cached_alt_networks),
		status: r.last_probe_status ?? 'never',
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
		e.operator_tag
	]);
}

/** Format an SSE event frame.  Each event is `event: NAME\n
 *  data: JSON\n\n`.  No id field — we don't need replay because
 *  we always send a snapshot on reconnect. */
export function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
