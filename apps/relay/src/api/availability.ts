/**
 * Morphit relay — availability endpoint.
 *
 * Checks whether a proposed Blurt account name is both structurally
 * valid (per our policy) and unclaimed on-chain.
 *
 * Flow:
 *   1. Rate-limit by client IP.
 *   2. Parse body → lowercase + trim the name.
 *   3. Structural validation (cheap, no chain call).
 *   4. If structural passes, chain read.
 *   5. Merge both into one yes/no response.
 */

import type { Hono, Context } from 'hono';
import { z } from 'zod';

import type { BlurtClient } from '../blurt/client.ts';
import type { Limiter } from '../middleware/ratelimit.ts';
import { validateBlurtName } from '../policy/name.ts';
import { clientIp, canonicalBucketKey } from '../middleware/ip.ts';

const requestSchema = z
	.object({
		name: z.string().min(1).max(64)
	})
	.strict();

export function registerAvailabilityRoutes(app: Hono, blurt: BlurtClient, limiter: Limiter): void {
	app.post('/v1/account/availability', (c) => handle(c, blurt, limiter));
}

async function handle(c: Context, blurt: BlurtClient, limiter: Limiter): Promise<Response> {
	const ip = clientIp(c);
	// Bucket to /64 (IPv6) or /24 (IPv4) so an attacker controlling
	// a residential /48 or VPS /56 can't enumerate availability at
	// faster than per-bucket rate.  Each availability request is a
	// chain RPC the relay pays for in egress + RPC time; without
	// bucketing the relay's RPC budget could be drained by a
	// determined enumerator iterating through their /48's 65k /64s.
	// See canonicalBucketKey doc in middleware/ip.ts.
	const bucketKey = canonicalBucketKey(ip);
	if (!limiter.allow(bucketKey)) {
		return c.json(
			{
				status: 'rejected',
				code: 'rate_limited',
				message: 'Too many availability checks from this client. Try again in a minute.'
			},
			429
		);
	}

	let parsed: z.infer<typeof requestSchema>;
	try {
		const body = await c.req.json();
		const result = requestSchema.safeParse(body);
		if (!result.success) {
			return c.json(
				{
					status: 'rejected',
					code: 'malformed_request',
					message: 'Request body must be JSON with a single `name` string.'
				},
				400
			);
		}
		parsed = result.data;
	} catch {
		return c.json(
			{
				status: 'rejected',
				code: 'malformed_request',
				message: 'Request body must be valid JSON.'
			},
			400
		);
	}

	// Normalise. Blurt account names are always lowercase on-chain;
	// lowercasing here means "Sally" and "sally" give the same answer,
	// avoiding the UX trap of "available now, rejected on submit".
	const name = parsed.name.trim().toLowerCase();

	// Structural check first — cheap, catches pathological inputs
	// without burning a chain-read.
	const structural = validateBlurtName(name);
	if (structural !== 'ok') {
		return c.json({ name, available: false, reason: structural });
	}

	// Structurally valid → ask the chain.
	let existing;
	try {
		existing = await blurt.getAccount(name);
	} catch {
		return c.json(
			{
				status: 'rejected',
				code: 'chain_unavailable',
				message: 'Unable to reach Blurt to verify availability. Please try again.'
			},
			503
		);
	}

	if (existing) {
		return c.json({ name, available: false, reason: 'already_registered' });
	}
	return c.json({ name, available: true });
}
