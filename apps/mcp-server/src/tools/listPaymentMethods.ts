/**
 * Tool: morphit_list_payment_methods
 *
 * Returns the configured instance's payment-method registry — the
 * canonical slug list an AI agent must use when calling
 * searchOrders with the payment_methods filter.
 *
 * Each instance is allowed to extend the registry with operator-
 * specific methods (Part 109+ instance-namespaced additions), so
 * this is per-instance, not a global enum.  An AI agent should
 * call this once per session and cache.
 */

import { z } from 'zod';
import { buildV1Url, fetchJson } from '../indexerClient.js';

export const LIST_PAYMENT_METHODS_DESCRIPTION =
	'List the payment-method slugs accepted by the configured Morphit ' +
	'instance. Use the returned slugs when calling morphit_search_orders ' +
	'with the payment_methods filter. Each instance has its own list ' +
	'(operators can extend with instance-specific methods).';

export const ListPaymentMethodsInputSchema = z.object({});

export type ListPaymentMethodsInput = z.infer<typeof ListPaymentMethodsInputSchema>;

interface PaymentMethodsResponse {
	rows: Array<{ slug: string; display_name?: string; category?: string }>;
}

export async function listPaymentMethods(
	_input: ListPaymentMethodsInput
): Promise<{
	payment_methods: Array<{ slug: string; display_name?: string; category?: string }>;
}> {
	const url = buildV1Url('/instance/payment-methods');
	const res = await fetchJson<PaymentMethodsResponse>(url);
	return { payment_methods: res.rows || [] };
}
