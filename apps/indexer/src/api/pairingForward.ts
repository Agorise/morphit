/**
 * Morphit indexer — cross-instance QR sign-in, forwarded (v1.20.0).
 *
 * Routes (mounted at /v1/pairing):
 *   GET  /target?origin=<origin>   is this origin a federation instance?
 *   POST /forward                  deliver a pairing bundle to that instance
 *
 * THE PROBLEM. ADR-0022 lets a desktop on instance A show a sign-in QR that a
 * phone signed in on instance B scans and approves. The phone then has to hand
 * its encrypted bundle to A's indexer (`POST /v1/login-pairing/:pid/deliver`),
 * where A's desktop is waiting. The phone's page used to POST it there
 * directly, cross-origin, and that never worked:
 *   - B's Content-Security-Policy `connect-src` names only 'self' and the RPC
 *     nodes, so the browser refused the request before it left the phone;
 *   - A's indexer answers a cross-origin preflight with GET/OPTIONS only
 *     (middleware/cors.ts), so even a widened CSP would have been refused;
 *   - a phone on B's .onion (Tor Browser) cannot reach a clearnet A without
 *     leaving Tor, and a phone on clearnet cannot reach an .onion A at all.
 * Widening `connect-src` to "every instance in the federation" is not a list
 * a static header can hold, and it would put the phone's IP in A's logs.
 *
 * THE DESIGN. The phone talks only to its OWN instance (same origin, covered by
 * 'self'), and B's indexer carries the bundle to A the way it already carries
 * federated chat: over A's hidden address when A published one, over the
 * resolve-and-pin clearnet path otherwise, never over clearnet from a
 * hidden-only node. A sees B, never the phone.
 *
 * WHAT MAKES THIS NOT AN OPEN PROXY. Every one of these is enforced below and
 * exercised in test/api/pairingForward.test.ts:
 *   - The target must be a REGISTERED federation instance: its origin, or one
 *     of the hidden addresses its operator published on chain, must be in
 *     `known_instances` / `operators` (rows the probe marked `mismatch` —
 *     someone else's site behind the registration — are excluded, as the
 *     chat fan-out excludes them). An unknown origin is refused before any
 *     network activity, with `reason: 'unknown_instance'`.
 *   - What is dialled is the INSTANCE'S REGISTERED addresses, not the string
 *     the phone sent, and only ONE path on it: `/v1/login-pairing/<pid>/deliver`
 *     with `pid` checked to be 64 hex characters. The target itself must be a
 *     bare origin (no path, query, fragment or credentials).
 *   - The body must be exactly a v1 delivery payload (fixed keys, base64
 *     fields of the sizes the protocol produces), under 4 KiB, and it is
 *     re-serialised from the validated fields — nothing else is carried.
 *   - Clearnet goes through `postClearnetPinned`: https only, every resolved
 *     address must be public, the connection pinned to the checked address,
 *     redirects NOT followed (a 3xx is a failure, reported as such), the reply
 *     read bounded. Hidden addresses go through the pooled hidden transport,
 *     also `redirect: 'manual'`, also bounded.
 *   - Timeouts per attempt and an overall deadline; a per-client rate limit
 *     (the `list` tier, in main.ts) plus, here, a per-target bucket, an
 *     instance-wide bucket and layered in-flight caps (per target, a small
 *     pool for targets the probe has not verified, and global — see
 *     FORWARDS_IN_FLIGHT_MAX), so B cannot be used to hammer A and one silent
 *     A cannot starve every other user's sign-in.
 *   - Only the reply's STATUS is used; nothing A says is passed back.
 *
 * THE SAME INSTANCE. A phone whose own instance IS the target (for example the
 * phone on B's clearnet name and the desktop on B's .onion) is delivered
 * straight into this indexer's pairing registry — no network. A phone and
 * desktop on the very same origin never reach this route at all: the phone
 * posts to `/v1/login-pairing/:pid/deliver` exactly as it always has.
 *
 * PRIVACY. Nothing here logs an address, a pid or a target. The phone's IP
 * reaches only its own instance. B learns what A's desktop and B's phone were
 * doing at that moment only in the sense that B already serves the phone.
 */

import { Hono, type Context } from 'hono';
import type { HiddenServiceProxyConfig } from '@morphit/hidden-transport';
import {
	hiddenHostNetworkOf,
	hiddenNetworkOf,
	isProxyUnavailable
} from '@morphit/hidden-transport';
import { clearnetRefused } from '@morphit/hidden-transport/router';

import { errorBody } from '$api/shared';
import { DELIVER_BODY_MAX_BYTES, PID_RE } from '$api/loginPairing';
import {
	addressesOf,
	fastPeerFromRow,
	peerRank,
	rankDirectoryPeers,
	type DirectoryPeerRow,
	type FastFederationDb,
	type FastPeerAddress
} from '$indexer/chatFastFederation';
import { postJsonViaHiddenService } from '$indexer/hiddenServicePool';
import { postClearnetPinned } from '$indexer/pinnedClearnetPost';
import { logger } from '$log';

const log = logger('pairing-forward');

/** The whole forward request — the proxies' `/v1/` body cap is 4k too. */
export const FORWARD_BODY_MAX_BYTES = 4096;
/** Longest origin string accepted as a target. */
const TARGET_MAX_CHARS = 255;
/** Base64 (standard, padded) of the fixed-size fields in a v1 delivery. */
const B64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;
const B64_12_BYTES = /^[A-Za-z0-9+/]{16}$/;
const B64_ANY = /^[A-Za-z0-9+/]+={0,2}$/;
/** A v1 envelope is ~0.6 KB; its sealed base64 well under this. */
const CIPHERTEXT_MAX_CHARS = 3000;

/** Per attempt. A cold Tor circuit or I2P tunnel takes tens of seconds. */
export const HIDDEN_TIMEOUT_MS = 45_000;
export const CLEARNET_TIMEOUT_MS = 10_000;
/** The whole forward, every attempt included, ends within this. */
const OVERALL_DEADLINE_MS = 60_000;

/** Forwards to ONE instance per minute, and in all. Pairing is a human
 *  pointing a phone at a screen: a few a minute is a busy instance. */
export const FORWARDS_PER_TARGET_PER_MIN = 20;
export const FORWARDS_GLOBAL_PER_MIN = 600;
/**
 * At once — and this is where a slow target does its damage, so the cap is
 * layered (v1.20.0 wave 2, verifier V4). A forward to an instance that never
 * answers holds its slot for the whole attempt; with one flat cap of eight,
 * eight requests a minute at a registered-but-silent instance held every slot
 * and every other user's cross-instance sign-in got 429 — under every per-client
 * and per-target rate limit, and over Tor all visitors share one client key.
 *
 *   - PER TARGET: one instance holds at most two slots, whatever it does;
 *   - UNVERIFIED targets (the probe last found them unreachable or stale, or has
 *     never verified them — the tiers anyone can manufacture by registering)
 *     share a small pool of their own and get short timeouts;
 *   - the global cap is sized so that only many DISTINCT instances that the
 *     probe finds healthy, and that then stall, could fill it.
 */
export const FORWARDS_IN_FLIGHT_MAX = 32;
export const FORWARDS_PER_TARGET_IN_FLIGHT = 2;
export const FORWARDS_UNVERIFIED_IN_FLIGHT = 4;
/** Budgets for an unverified target: fail fast rather than hold a slot. */
export const UNVERIFIED_HIDDEN_TIMEOUT_MS = 15_000;
export const UNVERIFIED_CLEARNET_TIMEOUT_MS = 5_000;
const UNVERIFIED_DEADLINE_MS = 20_000;
const WINDOW_MS = 60_000;

const USER_AGENT = 'morphit-indexer/pairing-forward';

/** Every alt-network key that names an address the forward may DIAL. The same
 *  set the chat fan-out uses; `ens` is a name, not a transport. */
const DIALABLE_ALT_KEYS = ['tor', 'i2p_b32', 'i2p_name', 'lokinet'] as const;

// ─── Target parsing ─────────────────────────────────────────────

export interface PairingTarget {
	/** `scheme://host[:port]`, lowercased. */
	readonly origin: string;
	/** Hostname, lowercased. */
	readonly host: string;
	/** A Tor / I2P / Lokinet host. */
	readonly hidden: boolean;
}

/**
 * A target is a BARE ORIGIN and nothing else: `https://` for clearnet, `http://`
 * or `https://` for a hidden host, no credentials, no path beyond `/`, no query,
 * no fragment. The raw string must already BE that origin (a trailing `/` is
 * tolerated), so nothing the URL parser would quietly normalise away — a path,
 * a backslash, an `@` — can ride through.
 */
export function parsePairingTarget(raw: unknown): PairingTarget | null {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > TARGET_MAX_CHARS) return null;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (u.username !== '' || u.password !== '') return null;
	if (u.pathname !== '/' || u.search !== '' || u.hash !== '') return null;
	const host = u.hostname.toLowerCase();
	if (host.length === 0) return null;
	const origin = u.origin.toLowerCase();
	if (raw.toLowerCase().replace(/\/$/, '') !== origin) return null;
	const hidden = hiddenHostNetworkOf(host) !== null;
	if (u.protocol === 'https:') return { origin, host, hidden };
	if (u.protocol === 'http:' && hidden) return { origin, host, hidden };
	return null;
}

// ─── This instance's own addresses ──────────────────────────────

export interface SelfAddresses {
	readonly origins: ReadonlySet<string>;
	readonly hiddenHosts: ReadonlySet<string>;
}

/** Build the set of addresses that mean THIS instance, from config values that
 *  may be origins or bare hosts (the `MORPHIT_INSTANCE_*_ADDRESS` values are
 *  usually bare). Junk is ignored. */
export function selfPairingAddresses(
	values: readonly (string | null | undefined)[]
): SelfAddresses {
	const origins = new Set<string>();
	const hiddenHosts = new Set<string>();
	for (const v of values) {
		if (typeof v !== 'string') continue;
		const t = v.trim();
		if (t.length === 0) continue;
		let u: URL;
		try {
			u = new URL(t.includes('://') ? t : `http://${t}`);
		} catch {
			continue;
		}
		const host = u.hostname.toLowerCase();
		if (host.length === 0) continue;
		if (hiddenHostNetworkOf(host) !== null) hiddenHosts.add(host);
		else if (t.includes('://')) origins.add(u.origin.toLowerCase());
	}
	return { origins, hiddenHosts };
}

function isSelf(target: PairingTarget, self: SelfAddresses): boolean {
	return target.hidden ? self.hiddenHosts.has(target.host) : self.origins.has(target.origin);
}

// ─── Directory lookup ───────────────────────────────────────────

/** Bare lowercase hostname of a registered address (origin or bare host). */
function hostOf(value: string): string | null {
	try {
		const u = new URL(value.includes('://') ? value : `http://${value}`);
		return u.hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}

function rowOriginTarget(row: DirectoryPeerRow): PairingTarget | null {
	try {
		const u = new URL(row.origin);
		const host = u.hostname.toLowerCase();
		return { origin: u.origin.toLowerCase(), host, hidden: hiddenHostNetworkOf(host) !== null };
	} catch {
		return null;
	}
}

/** Does this directory row name the target — as its registered origin, or (for
 *  a hidden target) as one of the hidden addresses its operator published? */
function rowNamesTarget(row: DirectoryPeerRow, target: PairingTarget): 'origin' | 'alt' | null {
	const own = rowOriginTarget(row);
	if (own !== null) {
		if (target.hidden ? own.hidden && own.host === target.host : own.origin === target.origin) {
			// A clearnet registration is only ever dialled over https.
			if (target.hidden || row.origin.toLowerCase().startsWith('https://')) return 'origin';
		}
	}
	if (!target.hidden) return null;
	const alt = row.reg_alt_networks ?? null;
	if (alt === null) return null;
	for (const key of DIALABLE_ALT_KEYS) {
		const v = alt[key];
		if (typeof v !== 'string' || v.length === 0) continue;
		if (hostOf(v) === target.host) return 'alt';
	}
	return null;
}

export type ResolvedTarget =
	| { readonly kind: 'self' }
	| {
			readonly kind: 'peer';
			/** The instance's identity (its registered origin), for the rate bucket. */
			readonly key: string;
			/** Where to dial, preferred first — the chat fan-out's own ordering. */
			readonly addresses: readonly FastPeerAddress[];
			/** Did the probe last find it answering (the chat fan-out's healthy
			 *  tiers, `clearnet_blocked` included)? Unverified targets get the
			 *  small in-flight pool and short timeouts. */
			readonly healthy: boolean;
	  }
	| { readonly kind: 'unknown' };

/**
 * Is `target` this instance, a registered federation instance, or neither?
 *
 * Several rows can name the same hidden host (anyone can publish any string as
 * an alt address). A row whose REGISTERED ORIGIN is the target wins over rows
 * that merely list it; within a tier the chat fan-out's ranking decides, and a
 * hidden address the phone named is dialled before anything else in the row.
 * The SQL matches hosts EXACTLY (never a substring), so no number of look-alike
 * registrations can crowd the real row out of the LIMIT.
 */
export async function resolvePairingTarget(
	db: FastFederationDb,
	target: PairingTarget,
	self: SelfAddresses,
	proxies: HiddenServiceProxyConfig
): Promise<ResolvedTarget> {
	if (isSelf(target, self)) return { kind: 'self' };
	const r = await db.query<DirectoryPeerRow>(
		`SELECT ki.origin, o.reg_alt_networks,
		        ki.last_probe_status, ki.last_probed_at, ki.registered_at_time,
		        ki.last_probe_error
		   FROM known_instances ki
		   LEFT JOIN operators o ON o.account = ki.operator_account
		  WHERE (ki.last_probe_status IS NULL OR ki.last_probe_status <> 'mismatch')
		    AND (lower(substring(ki.origin from '^[A-Za-z]+://([^/:]+)')) = $1
		         OR EXISTS (
		              SELECT 1
		                FROM jsonb_each_text(COALESCE(o.reg_alt_networks, '{}'::jsonb)) e
		               WHERE e.key IN ('tor', 'i2p_b32', 'i2p_name', 'lokinet')
		                 AND lower(substring(e.value from '^(?:[A-Za-z]+://)?([^/:]+)')) = $1))
		  LIMIT 50`,
		[target.host]
	);
	const byOrigin: DirectoryPeerRow[] = [];
	const byAlt: DirectoryPeerRow[] = [];
	for (const row of r.rows) {
		const how = rowNamesTarget(row, target);
		if (how === 'origin') byOrigin.push(row);
		else if (how === 'alt') byAlt.push(row);
	}
	const pick = rankDirectoryPeers(byOrigin.length > 0 ? byOrigin : byAlt)[0];
	if (pick === undefined) return { kind: 'unknown' };
	// Our own registration, reached by an address the env does not list.
	const own = rowOriginTarget(pick);
	if (own !== null && isSelf(own, self)) return { kind: 'self' };
	const peer = fastPeerFromRow(pick, proxies);
	let addresses = addressesOf(peer);
	// Named by one of its published hidden addresses: dial THAT address first.
	// Nobody can stop another registration from listing the same onion as its
	// own alt, so when the pick is such a row its other addresses (its own
	// origin, its own onion) must not come ahead of the one the phone named.
	if (target.hidden && byOrigin.length === 0) {
		const named = addresses.filter((a) => hostOf(a.origin) === target.host);
		addresses = [...named, ...addresses.filter((a) => hostOf(a.origin) !== target.host)];
	}
	return {
		kind: 'peer',
		key: own?.origin ?? pick.origin.toLowerCase(),
		addresses,
		healthy: peerRank(pick.last_probe_status, pick.last_probe_error) <= peerRank('clearnet_blocked')
	};
}

// ─── Body validation ────────────────────────────────────────────

export interface ForwardRequest {
	readonly target: PairingTarget;
	readonly pid: string;
	/** The delivery payload, re-serialised from the validated fields only. */
	readonly deliveryJson: string;
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
	const got = Object.keys(o).sort();
	return got.length === keys.length && got.every((k, i) => k === keys[i]);
}

/** Parse a forward body, or say why not. */
export function parseForwardBody(
	raw: string
): { ok: true; req: ForwardRequest } | { ok: false; reason: string } {
	if (Buffer.byteLength(raw, 'utf8') > FORWARD_BODY_MAX_BYTES) {
		return { ok: false, reason: 'body_too_large' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: 'malformed_json' };
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reason: 'malformed_body' };
	}
	const p = parsed as Record<string, unknown>;
	if (!exactKeys(p, ['delivery', 'pid', 'target'])) return { ok: false, reason: 'malformed_body' };
	const target = parsePairingTarget(p.target);
	if (target === null) return { ok: false, reason: 'bad_target' };
	if (typeof p.pid !== 'string' || !PID_RE.test(p.pid)) return { ok: false, reason: 'bad_pid' };
	const d = p.delivery;
	if (typeof d !== 'object' || d === null || Array.isArray(d)) {
		return { ok: false, reason: 'bad_delivery' };
	}
	const dr = d as Record<string, unknown>;
	if (
		!exactKeys(dr, ['ciphertext', 'ephemeral_pub', 'nonce', 'pid', 'v']) ||
		dr.v !== 1 ||
		dr.pid !== p.pid ||
		typeof dr.ephemeral_pub !== 'string' ||
		!B64_32_BYTES.test(dr.ephemeral_pub) ||
		typeof dr.nonce !== 'string' ||
		!B64_12_BYTES.test(dr.nonce) ||
		typeof dr.ciphertext !== 'string' ||
		dr.ciphertext.length > CIPHERTEXT_MAX_CHARS ||
		dr.ciphertext.length % 4 !== 0 ||
		!B64_ANY.test(dr.ciphertext)
	) {
		return { ok: false, reason: 'bad_delivery' };
	}
	const deliveryJson = JSON.stringify({
		v: 1,
		pid: p.pid,
		ephemeral_pub: dr.ephemeral_pub,
		nonce: dr.nonce,
		ciphertext: dr.ciphertext
	});
	if (deliveryJson.length > DELIVER_BODY_MAX_BYTES) return { ok: false, reason: 'body_too_large' };
	return { ok: true, req: { target, pid: p.pid, deliveryJson } };
}

// ─── Budgets ────────────────────────────────────────────────────

export interface ForwardLimits {
	readonly perTargetPerMin: number;
	readonly globalPerMin: number;
	readonly inFlightMax: number;
	readonly perTargetInFlightMax: number;
	readonly unverifiedInFlightMax: number;
}

export class ForwardBudget {
	private readonly perTarget = new Map<string, number[]>();
	private global: number[] = [];
	private inFlight = 0;
	private unverifiedInFlight = 0;
	private readonly inFlightByTarget = new Map<string, number>();
	private readonly limits: ForwardLimits;

	constructor(limits: Partial<ForwardLimits> = {}) {
		this.limits = {
			perTargetPerMin: limits.perTargetPerMin ?? FORWARDS_PER_TARGET_PER_MIN,
			globalPerMin: limits.globalPerMin ?? FORWARDS_GLOBAL_PER_MIN,
			inFlightMax: limits.inFlightMax ?? FORWARDS_IN_FLIGHT_MAX,
			perTargetInFlightMax: limits.perTargetInFlightMax ?? FORWARDS_PER_TARGET_IN_FLIGHT,
			unverifiedInFlightMax: limits.unverifiedInFlightMax ?? FORWARDS_UNVERIFIED_IN_FLIGHT
		};
	}

	/** Reserve one forward to `key`, or say which limit is full. Every `ok`
	 *  must be paired with exactly one `release(key, healthy)`. */
	take(
		key: string,
		now: number,
		healthy: boolean
	): 'ok' | 'target' | 'global' | 'in_flight' | 'target_in_flight' | 'unverified_in_flight' {
		const cutoff = now - WINDOW_MS;
		this.global = this.global.filter((t) => t > cutoff);
		for (const [k, ts] of this.perTarget) {
			const live = ts.filter((t) => t > cutoff);
			if (live.length === 0) this.perTarget.delete(k);
			else this.perTarget.set(k, live);
		}
		// The narrowest limits first, so a slow target is refused by its OWN cap
		// and never reaches (or holds) the shared ones.
		if ((this.inFlightByTarget.get(key) ?? 0) >= this.limits.perTargetInFlightMax) {
			return 'target_in_flight';
		}
		if (!healthy && this.unverifiedInFlight >= this.limits.unverifiedInFlightMax) {
			return 'unverified_in_flight';
		}
		if (this.inFlight >= this.limits.inFlightMax) return 'in_flight';
		const mine = this.perTarget.get(key) ?? [];
		if (mine.length >= this.limits.perTargetPerMin) return 'target';
		if (this.global.length >= this.limits.globalPerMin) return 'global';
		mine.push(now);
		this.perTarget.set(key, mine);
		this.global.push(now);
		this.inFlight++;
		if (!healthy) this.unverifiedInFlight++;
		this.inFlightByTarget.set(key, (this.inFlightByTarget.get(key) ?? 0) + 1);
		return 'ok';
	}

	release(key: string, healthy: boolean): void {
		if (this.inFlight > 0) this.inFlight--;
		if (!healthy && this.unverifiedInFlight > 0) this.unverifiedInFlight--;
		const n = (this.inFlightByTarget.get(key) ?? 0) - 1;
		if (n > 0) this.inFlightByTarget.set(key, n);
		else this.inFlightByTarget.delete(key);
	}
}

// ─── Dialling ───────────────────────────────────────────────────

type PostClearnet = (
	url: string,
	body: unknown,
	timeoutMs: number
) => Promise<{ status: number; body: string }>;
type PostHidden = (
	url: string,
	body: unknown,
	proxies: HiddenServiceProxyConfig,
	timeoutMs: number
) => Promise<{ status: number; body: string }>;

export type DialOutcome =
	| { readonly kind: 'answered'; readonly status: number }
	| { readonly kind: 'unreachable' };

/**
 * Deliver to the first address that ANSWERS, trying the next one only when the
 * failure was OUR transport's (no Tor daemon, i2pd down) — the chat fan-out's
 * rule (chatFastFederation `sendBatchToPeer`). A peer that answered, however
 * unhappily, has been reached; one that could not be reached over its hidden
 * address is not re-tried over clearnet, so publishing an onion keeps meaning
 * what the operator meant by it.
 *
 * Never on clearnet from a hidden-only node: such an address is skipped before
 * any dial, and an address the directory marks hidden but that is not a hidden
 * URL (the hidden-only placeholder in `fastPeerFromRow`) is skipped too.
 */
export async function dialPairingDeliver(
	addresses: readonly FastPeerAddress[],
	pid: string,
	deliveryJson: string,
	deps: {
		readonly proxies: HiddenServiceProxyConfig;
		readonly postClearnet: PostClearnet;
		readonly postHidden: PostHidden;
		readonly hiddenTimeoutMs: number;
		readonly clearnetTimeoutMs: number;
		readonly now: () => number;
		/** Whole-forward bound; default OVERALL_DEADLINE_MS. */
		readonly deadlineMs?: number;
	}
): Promise<DialOutcome> {
	if (!PID_RE.test(pid)) return { kind: 'unreachable' };
	const body: unknown = JSON.parse(deliveryJson);
	const deadline = deps.now() + (deps.deadlineMs ?? OVERALL_DEADLINE_MS);
	for (const addr of addresses) {
		// Each attempt gets its own budget, cut to what is left of the overall
		// one, so the phone (which waits FORWARD_TIMEOUT_MS = 90 s) always hears
		// back from us rather than timing out first.
		const left = deadline - deps.now();
		if (left <= 0) break;
		const hiddenUrl = hiddenNetworkOf(addr.origin) !== null;
		if (addr.hidden && !hiddenUrl) continue;
		if (!addr.hidden && clearnetRefused()) continue;
		// The ONE path. `new URL` with a root-absolute path discards any path
		// on the registered origin.
		const url = new URL(`/v1/login-pairing/${pid}/deliver`, addr.origin).toString();
		try {
			const res = addr.hidden
				? await deps.postHidden(url, body, deps.proxies, Math.min(deps.hiddenTimeoutMs, left))
				: await deps.postClearnet(url, body, Math.min(deps.clearnetTimeoutMs, left));
			return { kind: 'answered', status: res.status };
		} catch (err) {
			if (isProxyUnavailable(err)) {
				log.info('pairing_forward_local_transport_fault', {
					network: hiddenNetworkOf(addr.origin) ?? 'clearnet'
				});
				continue;
			}
			log.info('pairing_forward_unreachable', {
				network: hiddenNetworkOf(addr.origin) ?? 'clearnet'
			});
			return { kind: 'unreachable' };
		}
	}
	return { kind: 'unreachable' };
}

// ─── Route ──────────────────────────────────────────────────────

export interface PairingForwardDeps {
	readonly db: FastFederationDb;
	readonly self: SelfAddresses;
	readonly proxies: HiddenServiceProxyConfig;
	/** This indexer's own pairing registry (`PairingRegistry.deliver`). */
	readonly deliverLocal: (
		pid: string,
		bundleJson: string,
		nowMs: number
	) => 'ok' | 'over_capacity' | 'already_delivered';
	readonly postClearnet?: PostClearnet;
	readonly postHidden?: PostHidden;
	readonly hiddenTimeoutMs?: number;
	readonly clearnetTimeoutMs?: number;
	readonly budget?: ForwardBudget;
	readonly now?: () => number;
}

function fail(c: Context, status: 400 | 404 | 409 | 413 | 429 | 502 | 503, reason: string) {
	const code =
		status === 404
			? 'not_found'
			: status === 429 || status === 503
				? 'rate_limited'
				: status === 502
					? 'internal'
					: 'bad_request';
	return c.json({ ...errorBody(code, reason), reason }, status);
}

export function pairingForwardRoute(deps: PairingForwardDeps): Hono {
	const app = new Hono();
	const now = deps.now ?? Date.now;
	const budget = deps.budget ?? new ForwardBudget();
	const postClearnet: PostClearnet =
		deps.postClearnet ??
		((url, body, timeoutMs) => postClearnetPinned(url, body, timeoutMs, { userAgent: USER_AGENT }));
	const postHidden: PostHidden =
		deps.postHidden ??
		((url, body, proxies, timeoutMs) =>
			postJsonViaHiddenService(url, body, proxies, timeoutMs, { 'user-agent': USER_AGENT }));

	app.use('*', async (c, next) => {
		await next();
		c.header('cache-control', 'no-store');
	});

	// Preflight for the phone's confirmation card: is this QR from an instance
	// in the directory? No network activity beyond our own database.
	app.get('/target', async (c) => {
		const target = parsePairingTarget(c.req.query('origin'));
		if (target === null) return fail(c, 400, 'bad_target');
		const resolved = await resolvePairingTarget(deps.db, target, deps.self, deps.proxies);
		return c.json({ status: 'ok', known: resolved.kind !== 'unknown' });
	});

	app.post('/forward', async (c) => {
		const raw = await c.req.text();
		const parsed = parseForwardBody(raw);
		if (parsed.ok === false) {
			return fail(c, parsed.reason === 'body_too_large' ? 413 : 400, parsed.reason);
		}
		const { target, pid, deliveryJson } = parsed.req;

		const resolved = await resolvePairingTarget(deps.db, target, deps.self, deps.proxies);
		if (resolved.kind === 'unknown') return fail(c, 404, 'unknown_instance');

		if (resolved.kind === 'self') {
			const r = deps.deliverLocal(pid, deliveryJson, now());
			if (r === 'already_delivered') return fail(c, 409, 'already_delivered');
			if (r === 'over_capacity') return fail(c, 503, 'target_busy');
			return c.json({ ok: true });
		}

		const { key, healthy } = resolved;
		const slot = budget.take(key, now(), healthy);
		if (slot !== 'ok') {
			c.header('retry-after', '60');
			return fail(c, 429, 'forward_rate_limited');
		}
		try {
			const out = await dialPairingDeliver(resolved.addresses, pid, deliveryJson, {
				proxies: deps.proxies,
				postClearnet,
				postHidden,
				// An instance the probe could not reach fails fast: short attempts,
				// short overall, so it cannot sit on a slot for a minute.
				hiddenTimeoutMs: healthy
					? (deps.hiddenTimeoutMs ?? HIDDEN_TIMEOUT_MS)
					: Math.min(deps.hiddenTimeoutMs ?? HIDDEN_TIMEOUT_MS, UNVERIFIED_HIDDEN_TIMEOUT_MS),
				clearnetTimeoutMs: healthy
					? (deps.clearnetTimeoutMs ?? CLEARNET_TIMEOUT_MS)
					: Math.min(deps.clearnetTimeoutMs ?? CLEARNET_TIMEOUT_MS, UNVERIFIED_CLEARNET_TIMEOUT_MS),
				deadlineMs: healthy ? OVERALL_DEADLINE_MS : UNVERIFIED_DEADLINE_MS,
				now
			});
			if (out.kind === 'unreachable') return fail(c, 502, 'target_unreachable');
			const s = out.status;
			if (s >= 200 && s < 300) return c.json({ ok: true });
			if (s === 409) return fail(c, 409, 'already_delivered');
			if (s >= 300 && s < 400) return fail(c, 502, 'target_redirect_refused');
			if (s === 429 || s === 503) return fail(c, 503, 'target_busy');
			return fail(c, 502, 'target_rejected');
		} finally {
			budget.release(key, healthy);
		}
	});

	return app;
}
