/**
 * Tool: morphit_list_payment_methods
 *
 * Returns the configured instance's OWN payment-method additions
 * (`@instance:…` keys) from /v1/instance/payment-methods, plus the
 * methods this instance has switched off.
 *
 * The built-in registry (cash, bank transfer, …) lives in the web app and is
 * not served by the indexer, so it is not listed here; the orderbook filter
 * matches built-in methods by their registry key, and listings carry those
 * keys in `payment_methods`, which is where an agent learns them. This tool
 * used to read `rows`, a key the endpoint never sends, and so always
 * answered an empty list.
 */

import { z } from 'zod';
import { buildV1Url, fetchJson } from '../indexerClient.js';

export const LIST_PAYMENT_METHODS_DESCRIPTION =
	'List the payment methods this Morphit instance added on top of the ' +
	'built-in set (their slugs work in morphit_search_orders ' +
	'payment_methods), and the built-in methods it has switched off. ' +
	'Built-in method slugs appear in search results\' payment_methods.';

export const ListPaymentMethodsInputSchema = z.object({});

export type ListPaymentMethodsInput = z.infer<typeof ListPaymentMethodsInputSchema>;

/** /v1/instance/payment-methods (apps/indexer/src/api/instancePaymentMethods.ts). */
interface PaymentMethodsResponse {
	additions?: Array<{ key?: unknown; name?: unknown; category?: unknown; description?: unknown }>;
}

/** The instance's switched-off methods, from /v1/instance. */
interface InstanceResponse {
	disabled_payment_methods?: unknown;
}

export async function listPaymentMethods(_input: ListPaymentMethodsInput): Promise<{
	payment_methods: Array<{ slug: string; display_name?: string; category?: string; description?: string }>;
	disabled_payment_methods: string[];
}> {
	const res = await fetchJson<PaymentMethodsResponse>(buildV1Url('/instance/payment-methods'));
	const payment_methods = (res.additions ?? [])
		.filter((a) => typeof a.key === 'string' && a.key !== '')
		.map((a) => ({
			slug: a.key as string,
			...(typeof a.name === 'string' ? { display_name: a.name } : {}),
			...(typeof a.category === 'string' ? { category: a.category } : {}),
			...(typeof a.description === 'string' ? { description: a.description } : {})
		}));
	let disabled: string[] = [];
	try {
		const inst = await fetchJson<InstanceResponse>(buildV1Url('/instance'));
		if (Array.isArray(inst.disabled_payment_methods)) {
			disabled = inst.disabled_payment_methods.filter((m): m is string => typeof m === 'string');
		}
	} catch {
		// The additions are the answer; the disabled list is a bonus.
	}
	return { payment_methods, disabled_payment_methods: disabled };
}
