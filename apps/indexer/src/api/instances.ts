/**
 * Morphit indexer — /v1/instances endpoint (Phase D.5).
 *
 * Dynamic federation directory.  Replaces the static
 * known-instances.json.  Reads the known_instances table
 * (populated via chain replay of operator-register ops) joined
 * against operators (for tag + display_name).  Each row reflects
 * the most recent probe by the FederationProbeScheduler.
 *
 * Query parameters:
 *   ?status=good   — only instances currently classified 'good'.
 *                    Other valid values: quiet, stale, unreachable,
 *                    mismatch, never.  Omit to return all.
 *
 * Cache-Control: public, max-age=60.  Probe results refresh every
 * 10min for healthy instances; a 1-min CDN cache is plenty.
 *
 * Bootstrapping: on a fresh indexer the table is empty until
 * chain replay surfaces operator registrations.  Response in
 * that window: { instances: [], directory_updated_at: <now> }
 * — clients render an empty-state message.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import {
	rowToEntry,
	type DirectoryRow,
	type InstanceDirectoryEntry
} from '$api/instancesStreamHelpers';

// Re-export the entry type so existing importers
// (`$api/instances`) continue to work unchanged.
export type { InstanceDirectoryEntry };

export interface InstanceDirectoryResponse {
	version: 1;
	directory_updated_at: string; // ISO8601
	instances: readonly InstanceDirectoryEntry[];
}

const VALID_STATUS_FILTERS = new Set([
	'good',
	'quiet',
	'stale',
	'unreachable',
	'mismatch',
	'never'
]);

export function instancesRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		const statusFilter = c.req.query('status');
		const useFilter = statusFilter !== undefined && VALID_STATUS_FILTERS.has(statusFilter);
		const filterClause = useFilter ? `WHERE ki.last_probe_status = $1` : '';
		const params: unknown[] = useFilter ? [statusFilter] : [];

		const result = await db.query<DirectoryRow>(
			`SELECT
				ki.origin,
				ki.operator_account,
				op.tag                AS operator_tag,
				op.display_name       AS operator_display_name,
				ki.cached_name,
				ki.cached_tagline,
				ki.cached_contact_url,
				ki.cached_alt_networks,
				ki.last_probe_status,
				ki.registered_at_time,
				ki.last_probed_at,
				ki.cached_indexed_block,
				ki.cached_chain_lag_sec,
				ki.consecutive_failures
			 FROM known_instances ki
			 LEFT JOIN operators op ON op.account = ki.operator_account
			 ${filterClause}
			 ORDER BY
			   CASE ki.last_probe_status
			     WHEN 'good' THEN 1
			     WHEN 'quiet' THEN 2
			     WHEN 'stale' THEN 3
			     WHEN 'mismatch' THEN 4
			     WHEN 'unreachable' THEN 5
			     WHEN 'never' THEN 6
			     ELSE 7
			   END,
			   ki.registered_at_time DESC`,
			params
		);

		// Use the helper's row→entry mapper so any future field
		// changes get picked up by both REST and SSE in lockstep.
		// (F-24 audit fix.)
		const instances: InstanceDirectoryEntry[] = result.rows.map(rowToEntry);

		const body: InstanceDirectoryResponse = {
			version: 1,
			directory_updated_at: new Date().toISOString(),
			instances
		};
		c.header('Cache-Control', 'public, max-age=60');
		return c.json(body);
	});

	return app;
}
