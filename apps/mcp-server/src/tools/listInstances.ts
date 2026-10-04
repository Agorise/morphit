/**
 * Tool: morphit_list_instances
 *
 * Returns the federation directory — all Morphit instances the
 * configured indexer knows about.  Lets an AI agent switch
 * instances (e.g., the user's preferred operator) or surface
 * jurisdictional alternatives.
 */

import { z } from 'zod';
import { buildV1Url, fetchJson } from '../indexerClient.js';

export const LIST_INSTANCES_DESCRIPTION =
	'List known Morphit instances (federation directory). Morphit is ' +
	'federated — each instance is an independent operator running the ' +
	'open-source Morphit stack, sharing the same on-chain orderbook. ' +
	'Use this to surface jurisdictional alternatives to the user, or ' +
	'to find a Tor-hosted instance for privacy-sensitive queries.';

export const ListInstancesInputSchema = z.object({
	include_offline: z
		.boolean()
		.optional()
		.describe(
			'If true, include instances the configured instance could not ' +
				'reach on its last probe (unreachable, stale, mismatched, never ' +
				'probed). Default false: only instances last seen working.'
		)
});

export type ListInstancesInput = z.infer<typeof ListInstancesInputSchema>;

/** /v1/instances (apps/indexer/src/api/instances.ts). It used to be read as
 *  `rows`, a key the indexer never sends, so this tool always answered []. */
interface InstancesResponse {
	instances?: Array<Record<string, unknown>>;
}

/** Probe statuses meaning "answered on its last probe". */
const REACHABLE_STATUSES: ReadonlySet<unknown> = new Set(['good', 'quiet', 'syncing']);

export async function listInstances(input: ListInstancesInput): Promise<{
	instances: Array<Record<string, unknown>>;
	note: string;
}> {
	const res = await fetchJson<InstancesResponse>(buildV1Url('/instances'));

	// Trim each instance to what an AI agent can use: where it is (clearnet
	// origin and its Tor/I2P addresses), who runs it, how to reach them, and
	// whether it is up. Probe counters and block heights are dropped.
	const keep = new Set([
		'origin',
		'name',
		'tagline',
		'operator_tag',
		'operator_display_name',
		'contact_url',
		'alt_networks',
		'clearnet_eliminated',
		'status',
		'last_probed_at'
	]);
	const rows = (res.instances ?? []).filter(
		(row) => input.include_offline === true || REACHABLE_STATUSES.has(row['status'])
	);
	const instances = rows.map((row) => {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(row)) {
			if (keep.has(k)) out[k] = v;
		}
		return out;
	});

	return {
		instances,
		note:
			'Switch to a different instance by changing MORPHIT_MCP_INSTANCE_URL ' +
			'in your MCP client config, or by visiting that instance\'s web UI ' +
			'directly. All instances share the same on-chain orderbook so the ' +
			'listings you see are identical — what changes is the operator ' +
			'(legal jurisdiction, terms of service, whether it pays for new ' +
			'accounts, etc.).'
	};
}
