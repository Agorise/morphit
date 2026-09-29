/**
 * Morphit — where the phone sends a signed pairing bundle (ADR-0022, v1.20.0).
 *
 * SAME INSTANCE (the QR's relay is this page's own indexer): POST straight to
 * `/v1/login-pairing/:pid/deliver`, exactly as it always has.
 *
 * ANOTHER FEDERATION INSTANCE: the page cannot reach it — its CSP `connect-src`
 * is 'self' plus the RPC nodes, the other indexer's CORS refuses a cross-origin
 * POST, and on an .onion or .i2p page a clearnet origin is not reachable at all
 * (nor the reverse). So the phone hands the bundle to its OWN indexer (same
 * origin) at `POST /v1/pairing/forward`, which carries it to that instance if,
 * and only if, it is in the Morphit directory. The other instance sees this
 * instance, never the phone.
 *
 * Before the confirmation card is shown the phone asks its own indexer whether
 * the QR's instance is in the directory at all (`GET /v1/pairing/target`), so a
 * QR from somewhere unknown is refused calmly instead of after the user has
 * already said yes.
 *
 * The QR's `origin` (the site shown on the card) and `relay` (where the desktop
 * waits) must be the same place for a cross-instance QR: that is how every
 * Morphit desktop builds it, and it means the directory check is made against
 * the very name the user is asked to approve.
 */

import { fetchWithTimeout } from '$net/fetchWithTimeout';
import type { DeliveryPayload, PairingQrPayload } from './desktopPairing';

/** A forward may cross a cold Tor circuit or I2P tunnel at the far end. The
 *  indexer gives up on its own well before this. */
export const FORWARD_TIMEOUT_MS = 90_000;

export type PairingRoute =
	| { readonly kind: 'same_instance'; readonly deliverUrl: string }
	| { readonly kind: 'cross_instance'; readonly target: string }
	/** A foreign QR whose relay is not the site it names. */
	| { readonly kind: 'not_in_directory' };

function originOf(url: string): string | null {
	try {
		return new URL(url).origin.toLowerCase();
	} catch {
		return null;
	}
}

/** Decide how a validated QR's bundle travels, given this page's own indexer
 *  base (`resolveOrigin(MORPHIT_INDEXER_ORIGIN)`). Pure. */
export function pairingRouteFor(qr: PairingQrPayload, ownIndexerBase: string): PairingRoute {
	const relay = originOf(qr.relay);
	const own = originOf(ownIndexerBase);
	if (relay !== null && relay === own) {
		return {
			kind: 'same_instance',
			deliverUrl: new URL(
				`/v1/login-pairing/${encodeURIComponent(qr.pid)}/deliver`,
				qr.relay
			).toString()
		};
	}
	const site = originOf(qr.origin);
	if (relay === null || site === null || relay !== site) return { kind: 'not_in_directory' };
	return { kind: 'cross_instance', target: site };
}

type Fetch = (input: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

/** Is this QR's instance in the directory? Asked of the phone's own indexer. */
export async function checkPairingTarget(
	target: string,
	ownIndexerBase: string,
	fetchImpl: Fetch = fetchWithTimeout
): Promise<'known' | 'unknown' | 'error'> {
	try {
		const url = new URL(
			`/v1/pairing/target?origin=${encodeURIComponent(target)}`,
			ownIndexerBase
		).toString();
		const res = await fetchImpl(url, { method: 'GET' });
		if (res.status === 400) return 'unknown';
		if (!res.ok) return 'error';
		const body = (await res.json()) as { known?: unknown };
		return body.known === true ? 'known' : 'unknown';
	} catch {
		return 'error';
	}
}

export type DeliveryOutcome = 'delivered' | 'not_in_directory' | 'failed';

/** Send the bundle the right way for this QR. Never throws. */
export async function deliverPairingBundle(args: {
	readonly qr: PairingQrPayload;
	readonly delivery: DeliveryPayload;
	readonly ownIndexerBase: string;
	readonly fetchImpl?: Fetch;
}): Promise<DeliveryOutcome> {
	const fetchImpl = args.fetchImpl ?? fetchWithTimeout;
	const route = pairingRouteFor(args.qr, args.ownIndexerBase);
	if (route.kind === 'not_in_directory') return 'not_in_directory';
	try {
		if (route.kind === 'same_instance') {
			// Unchanged from before v1.20.0: the page's own indexer, directly.
			const resp = await fetchImpl(route.deliverUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(args.delivery)
			});
			return resp.ok ? 'delivered' : 'failed';
		}
		const resp = await fetchImpl(
			new URL('/v1/pairing/forward', args.ownIndexerBase).toString(),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					target: route.target,
					pid: args.qr.pid,
					delivery: args.delivery
				})
			},
			FORWARD_TIMEOUT_MS
		);
		if (resp.ok) return 'delivered';
		if (resp.status === 404) {
			const body = (await resp.json().catch(() => null)) as { reason?: unknown } | null;
			if (body?.reason === 'unknown_instance') return 'not_in_directory';
		}
		return 'failed';
	} catch {
		return 'failed';
	}
}
