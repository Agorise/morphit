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
			'If true, include instances whose health-probe has failed ' +
				'recently. Default false (only currently-reachable instances).'
		)
});

export type ListInstancesInput = z.infer<typeof ListInstancesInputSchema>;

interface InstancesResponse {
	rows: Array<Record<string, unknown>>;
}

export async function listInstances(input: ListInstancesInput): Promise<{
	instances: Array<Record<string, unknown>>;
	note: string;
}> {
	const url = buildV1Url('/instances', {
		include_offline: input.include_offline ? '1' : undefined
	});
	const res = await fetchJson<InstancesResponse>(url);

	// Trim each instance row to just the fields useful to an AI agent
	// (origin URL, operator tag, contact_url, declared region, last
	// healthy timestamp, supports_tor).  Drop the operator-internal
	// reconciliation metadata.
	const keep = new Set([
		'origin',
		'operator_tag',
		'operator_display_name',
		'contact_url',
		'declared_region',
		'last_healthy_at',
		'supports_tor',
		'tor_onion',
		'has_signup_acts',
		'declared_fiats'
	]);
	const instances = (res.rows || []).map((row) => {
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
			'(legal jurisdiction, terms of service, ACT-mint policy, etc.).'
	};
}
