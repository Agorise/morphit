#!/usr/bin/env tsx
/**
 * sse-stream-shape-smoke — validates the Server-Sent Events
 * wire-format shapes for the three streaming endpoints:
 *   - /v1/orderbook/stream  (orderbookStream.ts)
 *   - /v1/instances/stream  (instancesStream.ts)
 *   - /v1/chat/:a/:b/stream (chatStream.ts)
 *
 * Each stream emits multiple event types (typically a `snapshot`
 * on connect, then incremental `*_added` / `*_upserted` / etc.
 * events as data changes).  Each event's `data:` payload has a
 * specific JSON shape the frontend's EventSource handler parses.
 *
 * Same pattern as api-response-shape-smoke (cp15):
 *   1. zod schema for each event-type payload
 *   2. sample literal with `satisfies` cross-check against the
 *      canonical TS interface where one exists in
 *      @morphit/indexer-client
 *   3. negative-test invalidator
 *
 * Why this matters: SSE consumers are LIVE.  A wire-format
 * drift between server emit and client parse breaks every
 * connected user simultaneously, with no graceful "ask user to
 * refresh" affordance.  Validating the shapes locks the contract
 * at CI time.
 */

import { z } from 'zod';
import type {
	OrderRecord,
	InstanceDirectoryEntry,
	ChatMessageRecord
} from '@morphit/indexer-client';

// ─── Reusable sub-schemas ──────────────────────────────────────
// Match the schemas in api-response-shape-smoke; .passthrough()
// on optional-field-heavy objects to keep snapshot fixtures
// forward-compatible as new fields land.

const OrderRecordSchema = z
	.object({
		account: z.string(),
		permlink: z.string(),
		side: z.enum(['buy', 'sell']),
		asset: z.string(),
		fiat_currency: z.string(),
		amount_min: z.number().nullable(),
		amount_max: z.number().nullable(),
		price_model: z.unknown(),
		location_region: z.string().nullable(),
		payment_methods: z.array(z.string()),
		terms: z.string().nullable(),
		status: z.enum(['live', 'cancelled', 'expired']).optional(),
		fee_status: z.string().optional(),
		created_at: z.string(),
		updated_at: z.string(),
		expires_at: z.string().nullable()
	})
	.passthrough();

const InstanceDirectoryEntrySchema = z
	.object({
		origin: z.string(),
		operator_account: z.string(),
		operator_tag: z.string().nullable(),
		operator_display_name: z.string().nullable(),
		name: z.string().nullable(),
		tagline: z.string().nullable(),
		contact_url: z.string().nullable(),
		alt_networks: z.unknown(),
		status: z.enum(['good', 'quiet', 'stale', 'unreachable', 'mismatch']),
		registered_at: z.string(),
		last_probed_at: z.string().nullable(),
		indexed_block: z.number().nullable(),
		chain_lag_sec: z.number().nullable(),
		consecutive_failures: z.number()
	})
	.passthrough();

const ChatMessageRecordSchema = z
	.object({
		id: z.number(),
		sender: z.string(),
		recipient: z.string(),
		ciphertext: z.string(),
		header: z.unknown(),
		created_at: z.string()
	})
	.passthrough();

// ─── Event-payload schemas per stream ───────────────────────────

// /v1/orderbook/stream events:
const OrderbookSnapshotSchema = z.object({
	items: z.array(OrderRecordSchema),
	indexed_block: z.number()
});

const OrderbookOrderUpsertedSchema = OrderRecordSchema;

const OrderbookOrderRemovedSchema = z.object({
	account: z.string(),
	permlink: z.string()
});

// /v1/instances/stream events:
const InstancesSnapshotSchema = z.object({
	version: z.number(),
	directory_updated_at: z.string(),
	instances: z.array(InstanceDirectoryEntrySchema)
});

const InstancesAddedSchema = InstanceDirectoryEntrySchema;
const InstancesUpdatedSchema = InstanceDirectoryEntrySchema;
const InstancesRemovedSchema = z.object({
	origin: z.string()
});

// /v1/chat/:a/:b/stream events:
const ChatSnapshotSchema = z.object({
	items: z.array(ChatMessageRecordSchema),
	indexed_block: z.number()
});

const ChatMessageAppendedSchema = ChatMessageRecordSchema;

// ─── Sample payloads (TS-type-cross-check) ─────────────────────

const sampleOrderRecord = {
	account: 'alice',
	permlink: 'sell-btc-2026-05-15',
	side: 'sell' as const,
	asset: 'BTC' as const,
	fiat_currency: 'USD',
	amount_min: 50,
	amount_max: 500,
	price_model: { type: 'spread', spread_pct: 1.5 },
	location_region: 'EU',
	payment_methods: ['sepa', 'wise'],
	terms: null,
	created_at: '2026-05-15T00:00:00Z',
	updated_at: '2026-05-15T00:00:00Z',
	expires_at: null
} satisfies OrderRecord;

const sampleInstance = {
	origin: 'https://morphit.io',
	operator_account: 'morphit',
	operator_tag: null,
	operator_display_name: null,
	name: null,
	tagline: null,
	contact_url: null,
	alt_networks: null,
	status: 'good' as const,
	registered_at: '2026-05-15T00:00:00Z',
	last_probed_at: null,
	indexed_block: null,
	chain_lag_sec: null,
	consecutive_failures: 0
} satisfies InstanceDirectoryEntry;

const sampleChatMessage = {
	id: 100,
	sender: 'alice',
	recipient: 'bob',
	ciphertext: 'opaque-base64-payload-placeholder',
	header: { ephemeral_pub: 'x', nonce: 'y', client_tag: 'z' },
	created_at: '2026-05-15T00:00:00Z'
} satisfies ChatMessageRecord;

// ─── Scenarios ─────────────────────────────────────────────────
interface Scenario {
	readonly stream: 'orderbook' | 'instances' | 'chat';
	readonly event: string;
	readonly schema: z.ZodTypeAny;
	readonly valid: unknown;
	readonly invalidate: (sample: any) => unknown;
	readonly invalidReason: string;
}

const scenarios: Scenario[] = [
	// ─── orderbookStream ──
	{
		stream: 'orderbook',
		event: 'snapshot',
		schema: OrderbookSnapshotSchema,
		valid: { items: [sampleOrderRecord], indexed_block: 12345 },
		invalidate: (s) => ({ ...s, indexed_block: 'abc' }),
		invalidReason: 'indexed_block="abc" (must be number)'
	},
	{
		stream: 'orderbook',
		event: 'order_upserted',
		schema: OrderbookOrderUpsertedSchema,
		valid: sampleOrderRecord,
		invalidate: (s) => ({ ...s, side: 'flip' }),
		invalidReason: "side='flip' (must be 'buy'|'sell')"
	},
	{
		stream: 'orderbook',
		event: 'order_removed',
		schema: OrderbookOrderRemovedSchema,
		valid: { account: 'alice', permlink: 'sell-btc-2026-05-15' },
		invalidate: (s) => {
			const { account, ...rest } = s;
			return rest;
		},
		invalidReason: 'missing required field "account"'
	},

	// ─── instancesStream ──
	{
		stream: 'instances',
		event: 'snapshot',
		schema: InstancesSnapshotSchema,
		valid: {
			version: 1,
			directory_updated_at: '2026-05-15T00:00:00Z',
			instances: [sampleInstance]
		},
		invalidate: (s) => ({ ...s, version: '1' }),
		invalidReason: 'version="1" (must be number)'
	},
	{
		stream: 'instances',
		event: 'instance_added',
		schema: InstancesAddedSchema,
		valid: sampleInstance,
		invalidate: (s) => ({ ...s, origin: 12 }),
		invalidReason: 'origin=12 (must be string)'
	},
	{
		stream: 'instances',
		event: 'instance_updated',
		schema: InstancesUpdatedSchema,
		valid: sampleInstance,
		invalidate: (s) => ({ ...s, registered_at: null }),
		invalidReason: 'registered_at=null (must be string)'
	},
	{
		stream: 'instances',
		event: 'instance_removed',
		schema: InstancesRemovedSchema,
		valid: { origin: 'https://morphit.io' },
		invalidate: (s) => {
			const { origin, ...rest } = s;
			return rest;
		},
		invalidReason: 'missing required field "origin"'
	},

	// ─── chatStream ──
	{
		stream: 'chat',
		event: 'snapshot',
		schema: ChatSnapshotSchema,
		valid: { items: [sampleChatMessage], indexed_block: 12345 },
		invalidate: (s) => ({ ...s, items: 'not an array' }),
		invalidReason: 'items="not an array" (must be array)'
	},
	{
		stream: 'chat',
		event: 'message_appended',
		schema: ChatMessageAppendedSchema,
		valid: sampleChatMessage,
		invalidate: (s) => ({ ...s, id: 'one hundred' }),
		invalidReason: "id='one hundred' (must be number)"
	}
];

// ─── Run scenarios ─────────────────────────────────────────────
console.log(
	`sse-stream-shape smoke: ${scenarios.length * 2} checks ` +
		`across ${new Set(scenarios.map((s) => s.stream)).size} streams\n`
);
let failed = 0;
for (const s of scenarios) {
	const validResult = s.schema.safeParse(s.valid);
	if (validResult.success) {
		console.log(`  ✓ ${s.stream}/${s.event} valid sample parses`);
	} else {
		const issues = validResult.error.issues
			.map((i) => `${i.path.join('.')}: ${i.message}`)
			.join('; ');
		console.log(`  ✗ ${s.stream}/${s.event} valid sample FAILED: ${issues}`);
		failed++;
	}

	const invalidSample = s.invalidate(s.valid as Record<string, unknown>);
	const invalidResult = s.schema.safeParse(invalidSample);
	if (!invalidResult.success) {
		console.log(`  ✓ ${s.stream}/${s.event} rejects ${s.invalidReason}`);
	} else {
		console.log(
			`  ✗ ${s.stream}/${s.event} should have rejected ${s.invalidReason}`
		);
		failed++;
	}
}

console.log('');
if (failed === 0) {
	console.log(`✓ all ${scenarios.length * 2} sse-stream-shape checks hold`);
	process.exit(0);
}
console.error(`✗ ${failed} failed, ${scenarios.length * 2 - failed} passed`);
process.exit(1);
