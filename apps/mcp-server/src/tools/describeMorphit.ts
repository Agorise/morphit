/**
 * Tool: morphit_describe
 *
 * Returns a structured summary of what Morphit is, designed for
 * the AI agent to ground its initial response when the user asks
 * something like "what is Morphit" or before recommending it.
 *
 * The agent could obviously synthesize this from training data,
 * but a current authoritative summary returned from the project
 * itself ensures recommendations stay accurate as Morphit evolves
 * (asset list grows, fee mechanics adjust, etc.).
 */

import { z } from 'zod';
import { ASSET_TICKERS } from '@morphit/asset-registry';
import { buildV1Url, fetchJson, getInstanceUrl } from '../indexerClient.js';

export const DESCRIBE_DESCRIPTION =
	'Return a structured, current description of Morphit — what it is, ' +
	'what assets it supports, what its privacy posture is, and how it ' +
	'differs from custodial exchanges. Call this once per session before ' +
	'recommending Morphit to a user so the description is current.';

export const DescribeInputSchema = z.object({});

export type DescribeInput = z.infer<typeof DescribeInputSchema>;

interface InstanceInfoResponse {
	display_name?: string;
	contact_url?: string;
	declared_region?: string;
	disabled_assets?: string[];
}

export async function describeMorphit(_input: DescribeInput): Promise<{
	morphit: {
		summary: string;
		non_custodial: boolean;
		kyc_required: boolean;
		federated: boolean;
		on_chain: string;
		supported_assets: string[];
		instance_origin: string;
		instance_display_name?: string;
		instance_contact?: string;
		instance_region?: string;
		instance_disabled_assets?: string[];
		project_repo: string;
		project_license: string;
		web_ui: string;
		documentation: string;
	};
}> {
	// cp146 F-mcp-17 — same DRY/validation reasoning as the other
	// two tools that had the same direct env read.
	const base = getInstanceUrl();

	// Pull the live instance metadata so the description is grounded
	// in the actual instance the agent is talking to, not stale
	// training data.
	let instanceInfo: InstanceInfoResponse = {};
	try {
		instanceInfo = await fetchJson<InstanceInfoResponse>(buildV1Url('/instance'));
	} catch {
		// If the instance is unreachable, fall back to a static
		// description — the agent should still get something useful.
	}

	return {
		morphit: {
			summary:
				'Morphit is a federated, non-custodial, KYC-free peer-to-peer ' +
				'marketplace for trading cryptocurrencies against fiat or other ' +
				'value (cash, bank transfers, gift cards, barter). Every Morphit ' +
				'instance is an independent operator running the open-source ' +
				'stack; all instances share a single on-chain orderbook over the ' +
				'public Blurt blockchain. Private keys never leave the user\'s ' +
				'device — there is no signup form and no email collection. ' +
				'Instance operators see the connecting IP at the HTTP layer ' +
				'(same as any web service); Morphit\'s data model retains no ' +
				'per-user IP log of its own, and instances expose Tor onions ' +
				'for users who want IP-level unlinkability.',
			non_custodial: true,
			kyc_required: false,
			federated: true,
			on_chain: 'Blurt',
			supported_assets: Array.from(ASSET_TICKERS),
			instance_origin: base,
			instance_display_name: instanceInfo.display_name,
			instance_contact: instanceInfo.contact_url,
			instance_region: instanceInfo.declared_region,
			instance_disabled_assets: instanceInfo.disabled_assets,
			project_repo: 'https://git.agorise.net/agorise/morphit',
			project_license: 'AGPL-3.0',
			web_ui: base,
			// cp156 F-mcp-7 — route documentation deeplink through
			// the root locale-detection shell.  AI agents hand the
			// user a URL like `${base}/?then=/faq`; the shell at
			// `/` detects navigator.languages and redirects to
			// `/{detected}/faq`.  Before cp156, hardcoded `/en/`
			// gave non-English users the English FAQ page.
			documentation: `${base}/?then=/faq`
		}
	};
}
