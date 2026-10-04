/**
 * Morphit indexer — /v1/login-pairing endpoints (ADR-0022).
 *
 * Routes:
 *   POST /v1/login-pairing/:pid/deliver
 *   GET  /v1/login-pairing/:pid/wait     (SSE)
 *
 * The indexer is a dumb pipe between the user's phone (which has
 * just signed an encrypted pairing bundle) and their desktop
 * (which is waiting on the SSE stream for that bundle).  The
 * indexer cannot decrypt — the bundle is encrypted to the
 * desktop's ephemeral X25519 public key, which the indexer never
 * sees in plaintext form (only the base64 it forwards).  The
 * indexer cannot impersonate either party — the bundle is
 * signed by the user's posting key, which the indexer doesn't
 * have.
 *
 * What the indexer DOES do:
 *   - Holds an in-memory `pid → {bundleStr, exp, waiter}` map.
 *   - On `/wait`, opens an SSE connection and registers as the
 *     waiter for the pid, for at most 5 minutes. The entry lives
 *     only while that connection is open: a client that leaves
 *     takes its entry with it.
 *   - On `/deliver`, parses + size-checks the body and hands the
 *     bundle to the pid's waiter. A pid nobody is waiting on is
 *     refused (404): nothing is parked for a /wait that does not
 *     exist, so /deliver cannot fill the registry.
 *   - Janitor every 30s deletes expired entries.
 *   - Bounds: /wait is rate-limited per client and holds a stream
 *     slot (streamCaps.ts: per-client, shared-gateway and
 *     instance-wide caps), so one client cannot fill the registry
 *     and lock everyone out of QR sign-in.
 *
 * What the indexer does NOT do:
 *   - Verify signatures (the desktop does that).
 *   - Validate origin URLs (the desktop does that against its
 *     own `window.location.origin`).
 *   - Persist anything (a restart loses in-flight pairings;
 *     users retry).
 *
 * Who calls /deliver (v1.20.0): the phone's browser when the phone is
 * signed in on THIS instance (same origin), or — for a desktop on this
 * instance and a phone on ANOTHER federation instance — that instance's
 * indexer, forwarding on the phone's behalf (POST /v1/pairing/forward,
 * see pairingForward.ts).  Nothing here binds to the requester's IP or
 * Origin header, so a forwarded delivery is accepted exactly like a
 * direct one; the only per-address state is the resource-tier rate
 * limit, which then keys on the forwarding instance (or the shared
 * Tor/I2P gateway), never on the phone.
 *
 * Threat model:
 *   - The indexer learns: that a pairing happened at time T,
 *     bundle size N bytes (~1 KB always for a v1 pairing), and
 *     which IP delivered which IP fetched.  For a cross-instance
 *     pairing the delivering IP is the phone's INSTANCE, not the
 *     phone.
 *   - The indexer does NOT learn: account names, signatures,
 *     plaintext bundle contents, origin URLs.
 *   - A hostile indexer can DROP pairings (DoS — federated
 *     answer: switch operators) but cannot FORGE pairings
 *     (forging requires the user's posting key, which the
 *     indexer doesn't have).
 *   - An attacker who can guess a pid AND has the desktop's
 *     epk_priv can impersonate the desktop's `/wait`
 *     subscription.  But epk_priv is generated freshly on the
 *     desktop and never transmitted, so guessing it is
 *     equivalent to breaking X25519.
 *
 * Operator tunables (all in code, not env, because changing
 * them changes the cryptographic protocol semantics — env
 * tuning would let a hostile operator trivially weaken the
 * protocol):
 *   - PID_REGISTRY_MAX_ENTRIES: hard cap on simultaneous
 *     in-flight pairings.  Default 10000.
 *   - DELIVER_BODY_MAX_BYTES: max size of a delivery payload.
 *     Default 4096 (~1 KB needed; 4× tolerance).
 *   - JANITOR_INTERVAL_MS: how often to evict expired pids.
 *     Default 30 seconds.
 *   - PID_TTL_MAX_MS: max time a pid can sit in the registry.
 *     Default 5 minutes (matches QR_MAX_AGE_FUTURE_SECONDS in
 *     the frontend pairing module).
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { errorBody } from '$api/shared';
import { acquireStreamSlot, streamCapResponse } from '$api/streamCaps';
import { logger } from '$log';

const log = logger('login-pairing');

const PID_REGISTRY_MAX_ENTRIES = 10_000;
export const DELIVER_BODY_MAX_BYTES = 4096;
const JANITOR_INTERVAL_MS = 30_000;
const PID_TTL_MAX_MS = 5 * 60_000;
/** SSE keep-alive cadence for the /wait stream. A reverse proxy
 *  (BunkerWeb / nginx default `proxy_read_timeout` is 60s) closes an
 *  idle connection, which the desktop renders as "This code expired".
 *  An un-scanned QR's wait sends NO bytes for up to PID_TTL_MAX_MS, so
 *  we emit an SSE comment every 25s to keep the connection alive for
 *  the full 5-minute window. Matches the orderbook/chat stream cadence. */
const PAIRING_KEEPALIVE_INTERVAL_MS = 25_000;

/** PID format: 64 lowercase hex chars (SHA-256 output). */
export const PID_RE = /^[0-9a-f]{64}$/;

/** Per-pid registry entry.  Either a delivered bundle is
 *  parked (if the deliver came first), or a waiter callback
 *  is registered (if the wait came first), or both fields
 *  are filled momentarily as the deliver call hands off to
 *  the waiter.  The handoff completes by deleting the pid. */
interface PairingEntry {
	expMs: number;
	bundleJson: string | null;
	waiter: ((bundleJson: string) => void) | null;
}

export class PairingRegistry {
	private readonly entries = new Map<string, PairingEntry>();
	private janitor: NodeJS.Timeout | null = null;

	constructor() {
		this.janitor = setInterval(() => this.sweep(), JANITOR_INTERVAL_MS);
		this.janitor.unref?.();
	}

	close(): void {
		if (this.janitor !== null) {
			clearInterval(this.janitor);
			this.janitor = null;
		}
	}

	/** Phone-side delivery.  Returns:
	 *    - 'ok': bundle accepted (handed to the waiter, or parked
	 *      on the entry its /wait created until the callback is
	 *      installed).
	 *    - 'no_waiter': nobody is waiting on this pid; refused.
	 *    - 'already_delivered': this pid already has a parked
	 *      bundle from a prior call (single-shot enforcement).
	 */
	deliver(
		pid: string,
		bundleJson: string,
		nowMs: number
	): 'ok' | 'no_waiter' | 'already_delivered' {
		const entry = this.entries.get(pid);
		if (entry !== undefined) {
			// Pid is in registry — either as a parked bundle (if
			// deliver was already called) or a waiting subscriber
			// (if /wait got there first).
			if (entry.bundleJson !== null) {
				// Single-shot: do not overwrite a previously-
				// delivered bundle.  This prevents an attacker
				// from racing to deliver a forged bundle to a
				// pid the desktop has already seen.
				return 'already_delivered';
			}
			if (entry.waiter !== null) {
				// Waiter is subscribed — hand off immediately and
				// delete the entry.
				const w = entry.waiter;
				this.entries.delete(pid);
				w(bundleJson);
				return 'ok';
			}
			// No bundle, no waiter — entry is freshly created by
			// /wait but the SSE handler hasn't installed its
			// callback yet.  Park the bundle; the handler will
			// pick it up on its next tick.
			entry.bundleJson = bundleJson;
			return 'ok';
		}
		// Nobody is waiting on this pid: refuse rather than park. A
		// bundle parked for a /wait that may never come was the other
		// way to fill the registry.
		void nowMs;
		return 'no_waiter';
	}

	/** Desktop-side: register a waiter for `pid`.  If a bundle
	 *  was already delivered, returns it synchronously and
	 *  cleans up.  Otherwise creates an entry that the next
	 *  deliver call will hand off to.
	 *
	 *  Returns:
	 *    - { kind: 'immediate', bundleJson } if a bundle was
	 *      already parked.
	 *    - { kind: 'waiting', cancel } if waiting; caller MUST
	 *      install the actual callback via `setWaiter` before
	 *      yielding to the event loop.  (Two-phase to avoid a
	 *      race between registry insertion and callback wiring.)
	 *    - { kind: 'over_capacity' } at hard cap. */
	register(
		pid: string,
		nowMs: number
	): { kind: 'immediate'; bundleJson: string } | { kind: 'waiting' } | { kind: 'over_capacity' } {
		const entry = this.entries.get(pid);
		if (entry !== undefined) {
			// Pid already known.  If a bundle is parked, hand
			// over now.
			if (entry.bundleJson !== null) {
				const json = entry.bundleJson;
				this.entries.delete(pid);
				return { kind: 'immediate', bundleJson: json };
			}
			// Pid known but no bundle yet — must be a previous
			// /wait that's still active.  Reject the second
			// /wait so we don't double-subscribe.  Treated as
			// over-capacity for the user's sake.
			return { kind: 'over_capacity' };
		}
		if (this.entries.size >= PID_REGISTRY_MAX_ENTRIES) {
			return { kind: 'over_capacity' };
		}
		this.entries.set(pid, {
			expMs: nowMs + PID_TTL_MAX_MS,
			bundleJson: null,
			waiter: null
		});
		return { kind: 'waiting' };
	}

	/** Install a waiter callback after `register` returned
	 *  `waiting`.  Must be called before yielding to the event
	 *  loop, or a delivery may arrive with no waiter wired.
	 *
	 *  Edge case: if a deliver landed BETWEEN register() and
	 *  setWaiter(), the entry's bundleJson is now set.  We
	 *  fire the callback immediately and clean up. */
	setWaiter(
		pid: string,
		callback: (bundleJson: string) => void
	): 'installed' | 'fired_immediately' | 'gone' {
		const entry = this.entries.get(pid);
		if (entry === undefined) {
			// Pid was evicted by the janitor or by a successful
			// hand-off race — treat as expired.
			return 'gone';
		}
		if (entry.bundleJson !== null) {
			// Deliver landed between our two calls.  Fire now.
			const json = entry.bundleJson;
			this.entries.delete(pid);
			callback(json);
			return 'fired_immediately';
		}
		entry.waiter = callback;
		return 'installed';
	}

	/** Cancel a waiting subscription (the SSE client
	 *  disconnected, or its time ran out).  Removes the entry,
	 *  parked bundle included: an entry lives only while its
	 *  /wait does. A desktop that reconnects registers afresh. */
	cancelWait(pid: string): void {
		this.entries.delete(pid);
	}

	/** Remove expired entries.  Called periodically by the
	 *  janitor and also exposed for test-driven invocations. */
	sweep(nowMs: number = Date.now()): void {
		// Snapshot keys first so we can mutate during iteration.
		const expired: string[] = [];
		for (const [pid, entry] of this.entries) {
			if (entry.expMs <= nowMs) expired.push(pid);
		}
		for (const pid of expired) {
			const entry = this.entries.get(pid);
			if (entry?.waiter) {
				// Notify waiter their pairing expired so the SSE
				// connection can close cleanly.  We pass an
				// empty string to signal "no bundle" (the SSE
				// handler interprets empty as expired).
				try {
					entry.waiter('');
				} catch {
					// Best-effort — ignore.
				}
			}
			this.entries.delete(pid);
		}
	}

	/** Test/observability helper. */
	size(): number {
		return this.entries.size;
	}
}

// ─── Hono route ──────────────────────────────────────────────

export function loginPairingRoute(registry: PairingRegistry): Hono {
	const app = new Hono();

	// POST /:pid/deliver — phone delivers an encrypted bundle.
	app.post('/:pid/deliver', async (c) => {
		const pid = c.req.param('pid');
		if (!PID_RE.test(pid)) {
			return c.json(
				errorBody('bad_request', 'bad_pid: pid does not match expected SHA-256 hex shape'),
				400
			);
		}
		// Body size enforcement.  We read raw bytes because the
		// Content-Type is application/json and we want to cap
		// before parsing.
		const raw = await c.req.text();
		if (raw.length > DELIVER_BODY_MAX_BYTES) {
			return c.json(
				errorBody('bad_request', `body_too_large: max ${DELIVER_BODY_MAX_BYTES} bytes`),
				413
			);
		}
		// Validate JSON shape.  Detailed structural validation
		// happens on the desktop side; here we just confirm it's
		// parseable JSON with a `pid` field that matches the URL
		// (defense against pid-mismatch confusion).
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return c.json(errorBody('bad_request', 'malformed_json'), 400);
		}
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			(parsed as Record<string, unknown>).pid !== pid
		) {
			return c.json(errorBody('bad_request', 'pid_mismatch: body.pid does not equal URL pid'), 400);
		}
		const result = registry.deliver(pid, raw, Date.now());
		if (result === 'no_waiter') {
			return c.json(errorBody('not_found', 'no_pairing: nobody is waiting on this code'), 404);
		}
		if (result === 'already_delivered') {
			return c.json(errorBody('bad_request', 'already_delivered: pid has a parked bundle'), 409);
		}
		return c.json({ ok: true });
	});

	// GET /:pid/wait — desktop SSE-subscribes and receives the
	// bundle when it arrives.
	app.get('/:pid/wait', async (c) => {
		const pid = c.req.param('pid');
		if (!PID_RE.test(pid)) {
			return c.json(
				errorBody('bad_request', 'bad_pid: pid does not match expected SHA-256 hex shape'),
				400
			);
		}
		// A stream slot first: per client, per shared gateway and
		// instance-wide (streamCaps.ts). Without it one client could
		// hold every registry entry open.
		const release = acquireStreamSlot(c);
		if (release === null) return streamCapResponse(c);
		const reg = registry.register(pid, Date.now());
		if (reg.kind === 'over_capacity') {
			release();
			return c.json(errorBody('rate_limited', 'service_busy: pairing registry at capacity'), 503);
		}
		if (reg.kind === 'immediate') {
			// Fast path — bundle was already delivered.  Emit
			// once and close.
			return streamSSE(c, async (stream) => {
				try {
					await stream.writeSSE({
						event: 'bundle',
						data: reg.bundleJson
					});
				} finally {
					release();
				}
			});
		}
		// Waiting path — register a callback, then SSE-stream
		// until callback fires, the client leaves, or TTL expires.
		return streamSSE(c, async (stream) => {
			let resolved = false;
			let handedOff = false;
			let settle: (bundleJson: string) => void = () => undefined;
			// The client left: drop the entry and the slot now, not in
			// five minutes.
			stream.onAbort(() => {
				registry.cancelWait(pid);
				settle('');
			});
			// G: keep-alive. Without periodic bytes a reverse proxy
			// closes this idle connection at ~60s, and the desktop shows
			// "This code expired" even though the pairing is valid for the
			// full 5-minute window server-side. An SSE comment every 25s
			// keeps it open. Cleared in `finally` so it never outlives the
			// stream.
			const keepalive = setInterval(() => {
				void stream.write(': keepalive\n\n').catch(() => {});
			}, PAIRING_KEEPALIVE_INTERVAL_MS);
			try {
				const settled = new Promise<string>((resolve) => {
					settle = (v: string): void => {
						if (resolved) return;
						resolved = true;
						resolve(v);
					};
					if (stream.aborted) {
						registry.cancelWait(pid);
						settle('');
						return;
					}
					const installed = registry.setWaiter(pid, (bundleJson) => {
						if (resolved) return;
						resolved = true;
						resolve(bundleJson);
					});
					if (installed === 'fired_immediately') {
						// setWaiter handled the callback synchronously;
						// the resolver above already fired.  Nothing
						// else to do — the promise is settled.
					} else if (installed === 'gone') {
						if (!resolved) {
							resolved = true;
							resolve('');
						}
					}
					// Hard TTL fallback even if janitor doesn't fire.
					setTimeout(() => {
						if (!resolved) {
							resolved = true;
							registry.cancelWait(pid);
							resolve('');
						}
					}, PID_TTL_MAX_MS).unref?.();
				});
				const bundleJson = await settled;
				handedOff = bundleJson !== '';
				if (stream.aborted) return;
				if (bundleJson === '') {
					// Empty signals expired — close the stream
					// cleanly with a sentinel event.
					await stream.writeSSE({
						event: 'expired',
						data: '{}'
					});
				} else {
					await stream.writeSSE({
						event: 'bundle',
						data: bundleJson
					});
				}
			} finally {
				clearInterval(keepalive);
				// A delivered bundle already removed its entry; anything else
				// leaves nothing behind for this pid.
				if (!handedOff) registry.cancelWait(pid);
				release();
			}
		});
	});

	return app;
}
