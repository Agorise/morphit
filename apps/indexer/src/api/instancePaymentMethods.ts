/**
 * Morphit indexer — /v1/instance/payment-methods endpoint
 * (Batch L / ADR-0021).
 *
 * Returns the active instance-additions for this Morphit
 * instance.  Public, no auth.  The frontend reads this on
 * app-boot to populate the picker's "Instance additions"
 * section.
 *
 * Response shape:
 *   {
 *     additions: [
 *       {
 *         key: "@instance:promptpay",   // ALREADY prefixed for storage
 *         name: "PromptPay",
 *         description: "Thai instant retail payments…",
 *         category: "online",
 *         url: "https://www.bot.or.th/en/our-roles/payment-systems/PromptPay.html"
 *       },
 *       ...
 *     ],
 *     generated_at: "2026-04-29T00:00:00.000Z"
 *   }
 *
 * Filtered to state='active' and ordered by category + name for
 * deterministic display.
 *
 * Performance: tiny result set (operators add a handful of
 * entries at most).  No pagination — would be premature.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import type { Config } from '$config/index';

interface InstanceMethodRow {
	key: string;
	name: string;
	description: string;
	category: string;
	url: string | null;
}

export interface InstancePaymentMethodEntry {
	readonly key: string;
	readonly name: string;
	readonly description: string;
	readonly category: 'crypto' | 'in_person' | 'online';
	readonly url: string | null;
}

export interface InstancePaymentMethodsResponse {
	readonly additions: readonly InstancePaymentMethodEntry[];
	readonly generated_at: string;
}

const INSTANCE_KEY_PREFIX = '@instance:';

export function instancePaymentMethodsRoute(db: Database, config: Config): Hono {
	const app = new Hono();

	app.get('/', async (c) => {
		const result = await db.query<InstanceMethodRow>(
			`SELECT key, name, description, category, url
			   FROM instance_payment_methods
			  WHERE operator = $1 AND state = 'active'
			  ORDER BY category, name`,
			// B3 fix — read THIS instance's operator's additions,
			// not the federation-wide release-signer's.
			[config.operatorAccountName]
		);

		const additions: InstancePaymentMethodEntry[] = result.rows.map((r) => ({
			// Frontend stores keys prefixed with @instance: — emit
			// the prefixed form so consumers don't have to remember
			// to add it.
			key: `${INSTANCE_KEY_PREFIX}${r.key}`,
			name: r.name,
			description: r.description,
			category: r.category as 'crypto' | 'in_person' | 'online',
			url: r.url
		}));

		const response: InstancePaymentMethodsResponse = {
			additions,
			generated_at: new Date().toISOString()
		};
		return c.json(response);
	});

	return app;
}
