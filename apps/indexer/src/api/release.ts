/**
 * Morphit indexer — /v1/release endpoint.
 *
 * Latest verified release. The handler for morphit_release_v1 only
 * marks a row valid=true if its signer and signer's posting pubkey
 * both match the pinned trust anchor — this endpoint just surfaces
 * the newest such row.
 *
 * 404 if the table contains no valid releases (pre-launch state,
 * or the trust anchor is stale).
 *
 * **Treasury block (Part 106).**  When the most recent valid
 * release op carried a `treasury` field, we surface it here.
 * Frontend reads this to display the canonical BTC/XMR fee
 * address to users on the post-order page; every federated
 * indexer reads the same field and uses the chain-pinned
 * address for fee verification.  See docs/OPERATIONS.md §40.
 *
 * `treasury` is `null` in the response when:
 *   - The release op did not include a `treasury` field
 *     (pre-Part-106 releases, or operators who opted not to pin)
 *   - OR the field was structurally invalid (defense-in-depth;
 *     the handler validator should already have caught this)
 *
 * When non-null, shape:
 *   {
 *     btc: { address: string, satoshis: number } | null,
 *     xmr: { address: string, viewkey: string, piconero: string } | null
 *   }
 * Either chain may be null inside the object — operators can
 * pin one chain at a time during ramp-up.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody } from '$api/shared';

interface ReleaseRow {
	version: string;
	hash_manifest: unknown;
	endpoints: unknown;
	signer: string;
	source_trx_id: string;
	source_block_num: string;
	created_at: Date;
	treasury: unknown;
}

export function releaseRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		const result = await db.query<ReleaseRow>(
			`SELECT version, hash_manifest, endpoints, signer,
			        source_trx_id, source_block_num::text, created_at,
			        treasury
			 FROM releases
			 WHERE valid = true
			 ORDER BY created_at DESC
			 LIMIT 1`
		);
		if (result.rowCount === 0) {
			return c.json(errorBody('not_found', 'no valid release yet'), 404);
		}
		const r = result.rows[0]!;
		return c.json({
			version: r.version,
			hash_manifest: r.hash_manifest,
			endpoints: r.endpoints,
			signer: r.signer,
			source_trx_id: r.source_trx_id,
			source_block_num: parseInt(r.source_block_num, 10),
			created_at: r.created_at.toISOString(),
			// Part 106 — chain-pinned treasury addresses.  null when
			// the release op didn't carry a treasury block.  Frontend
			// renders the address with copy + QR when present;
			// operators verifying federation consistency can compare
			// this field across instances.
			//
			// Part 107 — defense-in-depth viewkey strip.  The handler
			// validateTreasury() already strips any `viewkey` field
			// before persisting, so r.treasury should never contain
			// one.  But we strip again here on the way out: belt-
			// and-suspenders against (a) hand-crafted DB writes that
			// bypassed the handler, (b) regression bugs in the
			// handler validator, (c) any future feature that touches
			// this column.  The privacy invariant — viewkey never
			// surfaces via API — is enforced at multiple layers.
			treasury: stripViewkey(r.treasury) ?? null
		});
	});

	return app;
}

/** Strip any `viewkey` field from a treasury JSONB blob.
 *  Defense-in-depth for Part 107.  Returns the input unchanged
 *  when null/undefined or when no viewkey is present. */
function stripViewkey(treasury: unknown): unknown {
	if (treasury === null || treasury === undefined) return treasury;
	if (typeof treasury !== 'object' || Array.isArray(treasury)) return treasury;
	const t = treasury as Record<string, unknown>;
	const xmr = t.xmr;
	if (xmr === null || xmr === undefined) return treasury;
	if (typeof xmr !== 'object' || Array.isArray(xmr)) return treasury;
	const xmrObj = xmr as Record<string, unknown>;
	if (!('viewkey' in xmrObj)) return treasury;
	// Has a viewkey — strip it.  Build a shallow copy so we don't
	// mutate the input (the row may be cached upstream).
	const cleanedXmr: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(xmrObj)) {
		if (k !== 'viewkey') cleanedXmr[k] = v;
	}
	return { ...t, xmr: cleanedXmr };
}
