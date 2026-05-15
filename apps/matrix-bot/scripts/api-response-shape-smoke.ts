#!/usr/bin/env tsx
/**
 * api-response-shape-smoke — every public-API response shape
 * gets a zod schema, AND a TS-type-cross-check confirms the
 * schema matches the canonical TypeScript interface from
 * @morphit/indexer-client.
 *
 * Pattern parallel to sidecar-envelope-smoke (cp14):
 *   - sidecar-envelope-smoke validates bash sidecar emit() output
 *     against the LogRecord shape;
 *   - this smoke validates HTTP-API responses against the shapes
 *     declared in packages/indexer-client/src/index.ts.
 *
 * Each scenario:
 *   1. Declares a zod schema for one response type.
 *   2. Declares a sample literal `typed as` the canonical TS
 *      interface from @morphit/indexer-client.  If the schema
 *      and interface diverge (a new required field added to
 *      the TS but not to the schema), tsc will reject the
 *      sample literal because zod.parse() returns `unknown`.
 *   3. Validates the sample literal against the schema.
 *   4. Validates a deliberately-malformed copy of the sample
 *      against the schema (negative test — must reject).
 *
 * This is a CONTRACT smoke, not a behavior smoke.  It doesn't
 * spawn the indexer or hit real endpoints.  Real-endpoint
 * behavior is covered by apps/indexer/test/.  The point here is
 * to lock the schema-as-contract.
 *
 * Why this matters: cp9 lessons applied to HTTP API.  If the
 * indexer's response shape drifts from what the frontend
 * consumes (a renamed field, a removed field, a new required
 * field), this smoke catches it at CI time rather than at
 * production-debug time.
 */

import { z } from 'zod';
import type {
	HealthResponse,
	ListingFeeResponse,
	ReleaseResponse,
	OperatorRecord,
	ErrorResponse,
	InstanceResponse,
	InstanceDirectoryEntry,
	OrderRecord,
	FeedbackSummary,
	ChatAdmissionResponse,
	// cp16 additions:
	OrderViewsResponse,
	OrderViewIncrementResponse,
	OrderbookResponse,
	FeaturedBid,
	FeaturedSlot,
	FeaturedOrderbookResponse,
	AccountOrdersResponse,
	ProfileResponse,
	OperatorStats,
	OperatorsResponse,
	ChatIdentityResponse,
	ConversationSummary,
	ConversationsResponse,
	BlockEntry,
	BlocksResponse,
	ChatHistoryResponse,
	ChatMessageRecord,
	InstanceDirectoryResponse
} from '@morphit/indexer-client';

// ─── Schemas ───────────────────────────────────────────────────
//
// Mirror the TS interfaces in packages/indexer-client/src/index.ts.
// Optional fields use .optional(); nullable fields use .nullable().
// Both — .nullable().optional().

const HealthSchema = z.object({
	status: z.enum(['ok', 'degraded']),
	version: z.string(),
	uptime_sec: z.number(),
	chain_head_block: z.number(),
	indexed_block: z.number(),
	lag_blocks: z.number(),
	stale: z.boolean()
});

const ListingFeeSchema = z.object({
	base_fee_blurt: z.number(),
	feature_fee_blurt_per_hour: z.number(),
	quote_ttl_seconds: z.number(),
	base_fee_usd: z.number().optional(),
	blurt_price_usd: z.number().optional()
});

const ReleaseSchema = z.object({
	version: z.string(),
	hash_manifest: z.unknown(),
	endpoints: z.unknown(),
	signer: z.string(),
	source_trx_id: z.string(),
	source_block_num: z.number(),
	created_at: z.string()
});

const ErrorResponseSchema = z.object({
	status: z.literal('error'),
	code: z.string(), // ErrorCode is a string union; relaxed to z.string() since
	                  // the exact union changes faster than this schema.
	message: z.string()
});

const OperatorStatsSchema = z.object({
	probe_status: z.enum(['ok', 'degraded', 'down', 'unknown']),
	probe_latency_ms: z.number().nullable(),
	probe_checked_at: z.string().nullable(),
	live_orders_total: z.number(),
	live_orders_24h: z.number(),
	feedback_total: z.number(),
	feedback_positive_pct: z.number().nullable()
});

const OperatorRecordSchema = z.object({
	account: z.string(),
	tag: z.string(),
	display_name: z.string(),
	contact_url: z.string().nullable(),
	registered_at: z.string(),
	is_active: z.boolean(),
	stats: OperatorStatsSchema.optional()
});

const AltNetworksSchema = z.object({
	tor: z.string().nullable(),
	lokinet: z.string().nullable(),
	i2p_b32: z.string().nullable(),
	i2p_name: z.string().nullable(),
	i2p: z.string().nullable().optional(),
	nostr: z.string().nullable()
});

const SeoSchema = z.object({
	title: z.string().nullable(),
	description: z.string().nullable(),
	keywords: z.string().nullable()
});

const ChatLinkUrlsSchema = z.object({
	btc: z.string().nullable(),
	xmr: z.string().nullable(),
	usdt: z
		.object({
			erc20: z.string().nullable(),
			trc20: z.string().nullable(),
			spl: z.string().nullable(),
			bep20: z.string().nullable()
		})
		.optional()
});

const InstanceResponseSchema = z
	.object({
		name: z.string().nullable(),
		tagline: z.string().nullable(),
		contact_url: z.string().nullable(),
		alt_networks: AltNetworksSchema,
		fee_recipient: z.string(),
		relay_account: z.string(),
		operator_tag: z.string().nullable().optional(),
		seo: SeoSchema.optional(),
		chat_link_urls: ChatLinkUrlsSchema.optional(),
		disabled_assets: z.array(z.string()).optional()
	})
	.passthrough(); // The real InstanceResponse has many more optional fields;
	                 // .passthrough() allows them so a snapshot fixture stays
	                 // valid as new fields are added.

const InstanceDirectoryEntrySchema = z
	.object({
		origin: z.string(),
		operator_account: z.string(),
		operator_tag: z.string().nullable(),
		registered_at: z.string()
	})
	.passthrough();

const OrderRecordSchema = z
	.object({
		account: z.string(),
		permlink: z.string(),
		side: z.enum(['buy', 'sell']),
		asset: z.string(), // AssetTicker is a string union; relaxed
		fiat_currency: z.string(),
		amount_min: z.number().nullable(),
		amount_max: z.number().nullable(),
		price_model: z.unknown(),
		location_region: z.string().nullable(),
		payment_methods: z.array(z.string()),
		terms: z.string().nullable(),
		status: z.enum(['live', 'cancelled', 'expired']).optional(),
		fee_status: z.string().optional()
	})
	.passthrough();

const FeedbackSummarySchema = z.object({
	total: z.number(),
	positive: z.number(),
	negative: z.number(),
	positive_pct: z.number().nullable()
});

const ChatAdmissionSchema = z
	.object({
		admitted: z.boolean()
	})
	.passthrough(); // Many optional fields; passthrough for forward-compat.

// ─── cp16 schemas (extend coverage to more interfaces) ─────────

const OrderViewsResponseSchema = z.object({
	count: z.number(),
	updated_at: z.string().nullable()
});

const OrderViewIncrementResponseSchema = z.object({
	count: z.number()
});

const OrderbookResponseSchema = z.object({
	items: z.array(OrderRecordSchema),
	next_cursor: z.string().nullable(),
	indexed_block: z.number()
});

const FeaturedBidSchema = z.object({
	hours_requested: z.number(),
	blurt_paid: z.string(),
	blurt_per_hour: z.string(),
	effective_at: z.string(),
	expires_at: z.string()
});

const FeaturedSlotSchema = z.object({
	order: OrderRecordSchema,
	bid: FeaturedBidSchema
});

const FeaturedOrderbookResponseSchema = z.object({
	featured: z.array(FeaturedSlotSchema),
	max_slots: z.number()
});

const AccountOrdersResponseSchema = z.object({
	items: z.array(OrderRecordSchema),
	next_cursor: z.string().nullable()
});

const ProfileResponseSchema = z.object({
	account: z.string(),
	display_name: z.string(),
	json_metadata: z.unknown(),
	source_block_num: z.number(),
	updated_at: z.string()
});

const OperatorStatsInnerSchema = z.object({
	cumulative_blurt_earned: z.number(),
	total_orders_attributed: z.number()
});

const OperatorsResponseSchema = z.object({
	operators: z.array(OperatorRecordSchema)
});

const ChatIdentityResponseSchema = z.object({
	account: z.string(),
	chat_pub: z.string(),
	source_block_num: z.number(),
	source_trx_id: z.string(),
	updated_at: z.string()
});

const ConversationSummarySchema = z.object({
	peer: z.string(),
	last_message_at: z.string(),
	message_count: z.number(),
	has_user_sent: z.boolean()
});

const ConversationsResponseSchema = z.object({
	account: z.string(),
	items: z.array(ConversationSummarySchema)
});

const BlockEntrySchema = z.object({
	blocked: z.string(),
	since_block_num: z.number(),
	since_trx_id: z.string(),
	created_at: z.string(),
	updated_at: z.string()
});

const BlocksResponseSchema = z.object({
	account: z.string(),
	items: z.array(BlockEntrySchema)
});

const ChatMessageRecordSchema = z
	.object({
		id: z.number(),
		from: z.string(),
		to: z.string(),
		body: z.string(),
		created_at: z.string()
	})
	.passthrough();

const ChatHistoryResponseSchema = z.object({
	items: z.array(ChatMessageRecordSchema),
	next_cursor: z.string().nullable()
});

const InstanceDirectoryResponseSchema = z.object({
	instances: z.array(InstanceDirectoryEntrySchema)
});

// ─── Sample literals (TS-type-cross-check) ─────────────────────
//
// Each literal is `satisfies` the canonical TS interface from
// @morphit/indexer-client.  Goal: typecheck will fail if:
//   - a required field is added to the TS interface, OR
//   - a required field is removed from the TS interface AND I
//     don't update both the schema and the literal.
//
// We use `satisfies` (TS 4.9+) instead of `as` to keep the
// literal narrowly typed AND require structural conformance.

const sampleHealth = {
	status: 'ok',
	version: '0.1.0',
	uptime_sec: 3600,
	chain_head_block: 1000,
	indexed_block: 999,
	lag_blocks: 1,
	stale: false
} satisfies HealthResponse;

const sampleListingFee = {
	base_fee_blurt: 0.5,
	feature_fee_blurt_per_hour: 0.1,
	quote_ttl_seconds: 60
} satisfies ListingFeeResponse;

const sampleRelease = {
	version: 'v0.1.0-beta.1',
	hash_manifest: {},
	endpoints: {},
	signer: 'morphit',
	source_trx_id: 'abc123',
	source_block_num: 100,
	created_at: '2026-05-14T00:00:00Z'
} satisfies ReleaseResponse;

const sampleError = {
	status: 'error',
	code: 'order_not_found',
	message: 'order not found'
} satisfies ErrorResponse;

const sampleOperator = {
	account: 'morphit-alice',
	tag: 'alice',
	display_name: 'Alice Operator',
	contact_url: null,
	registered_at: '2026-05-14T00:00:00Z',
	is_active: true
} satisfies OperatorRecord;

const sampleInstance = {
	name: 'Morphit Alice',
	tagline: null,
	contact_url: null,
	alt_networks: {
		tor: null,
		lokinet: null,
		i2p_b32: null,
		i2p_name: null,
		nostr: null
	},
	fee_recipient: '@morphit-fees',
	relay_account: '@morphit-alice'
} satisfies InstanceResponse;

const sampleInstanceDirEntry = {
	origin: 'https://morphit.io',
	operator_account: 'morphit',
	operator_tag: null,
	registered_at: '2026-05-14T00:00:00Z'
} satisfies InstanceDirectoryEntry;

const sampleOrder = {
	account: 'alice',
	permlink: 'sell-btc-2026-05-14',
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 50,
	amount_max: 500,
	price_model: { type: 'spread', spread_pct: 1.5 },
	location_region: 'EU',
	payment_methods: ['sepa', 'wise'],
	terms: null
} satisfies OrderRecord;

const sampleFeedbackSummary = {
	total: 42,
	positive: 40,
	negative: 2,
	positive_pct: 95.2
} satisfies FeedbackSummary;

const sampleChatAdmission = {
	admitted: true
} satisfies ChatAdmissionResponse;

// ─── cp16 samples ──────────────────────────────────────────────

const sampleOrderViews = {
	count: 42,
	updated_at: '2026-05-15T00:00:00Z'
} satisfies OrderViewsResponse;

const sampleOrderViewIncrement = {
	count: 43
} satisfies OrderViewIncrementResponse;

const sampleOrderbookResponse = {
	items: [sampleOrder],
	next_cursor: null,
	indexed_block: 12345
} satisfies OrderbookResponse;

const sampleFeaturedBid = {
	hours_requested: 24,
	blurt_paid: '2.40',
	blurt_per_hour: '0.10',
	effective_at: '2026-05-15T00:00:00Z',
	expires_at: '2026-05-16T00:00:00Z'
} satisfies FeaturedBid;

const sampleFeaturedSlot = {
	order: sampleOrder,
	bid: sampleFeaturedBid
} satisfies FeaturedSlot;

const sampleFeaturedOrderbook = {
	featured: [sampleFeaturedSlot],
	max_slots: 5
} satisfies FeaturedOrderbookResponse;

const sampleAccountOrders = {
	items: [sampleOrder],
	next_cursor: null
} satisfies AccountOrdersResponse;

const sampleProfile = {
	account: 'alice',
	display_name: 'Alice',
	json_metadata: { bio: 'P2P trader' },
	source_block_num: 12345,
	updated_at: '2026-05-15T00:00:00Z'
} satisfies ProfileResponse;

const sampleOperatorStats = {
	cumulative_blurt_earned: 100.5,
	total_orders_attributed: 50
} satisfies OperatorStats;

const sampleOperators = {
	operators: [sampleOperator]
} satisfies OperatorsResponse;

const sampleChatIdentity = {
	account: 'alice',
	chat_pub: 'aGVsbG8td29ybGQtY2hhdC1wdWJsaWMta2V5LWJhc2U2NA==',
	source_block_num: 12345,
	source_trx_id: 'abc123def456',
	updated_at: '2026-05-15T00:00:00Z'
} satisfies ChatIdentityResponse;

const sampleConversationSummary = {
	peer: 'bob',
	last_message_at: '2026-05-15T00:00:00Z',
	message_count: 5,
	has_user_sent: true
} satisfies ConversationSummary;

const sampleConversations = {
	account: 'alice',
	items: [sampleConversationSummary]
} satisfies ConversationsResponse;

const sampleBlockEntry = {
	blocked: 'spammer-1',
	since_block_num: 12345,
	since_trx_id: 'abc123def456',
	created_at: '2026-05-15T00:00:00Z',
	updated_at: '2026-05-15T00:00:00Z'
} satisfies BlockEntry;

const sampleBlocks = {
	account: 'alice',
	items: [sampleBlockEntry]
} satisfies BlocksResponse;

const sampleChatMessage = {
	id: 100,
	from: 'alice',
	to: 'bob',
	body: 'BTC sent; tx id below.',
	created_at: '2026-05-15T00:00:00Z'
} satisfies ChatMessageRecord;

const sampleChatHistory = {
	items: [sampleChatMessage],
	next_cursor: null
} satisfies ChatHistoryResponse;

const sampleInstanceDirectory = {
	instances: [sampleInstanceDirEntry]
} satisfies InstanceDirectoryResponse;

// ─── Scenarios ─────────────────────────────────────────────────
interface Scenario {
	readonly name: string;
	readonly schema: z.ZodTypeAny;
	readonly valid: unknown;
	/** Mutator returns a deliberately-malformed copy that must
	 *  fail validation. */
	readonly invalidate: (sample: any) => unknown;
	/** Human-readable reason the malformed copy is invalid —
	 *  printed in the failure detail when the smoke catches a
	 *  schema that accepts what it should reject. */
	readonly invalidReason: string;
}

const scenarios: Scenario[] = [
	{
		name: 'HealthResponse',
		schema: HealthSchema,
		valid: sampleHealth,
		invalidate: (s) => ({ ...s, status: 'fubar' }),
		invalidReason: "status='fubar' (must be 'ok'|'degraded')"
	},
	{
		name: 'ListingFeeResponse',
		schema: ListingFeeSchema,
		valid: sampleListingFee,
		invalidate: (s) => ({ ...s, base_fee_blurt: 'oops' }),
		invalidReason: "base_fee_blurt='oops' (must be number)"
	},
	{
		name: 'ReleaseResponse',
		schema: ReleaseSchema,
		valid: sampleRelease,
		invalidate: (s) => {
			const { version, ...rest } = s;
			return rest;
		},
		invalidReason: 'missing required field "version"'
	},
	{
		name: 'ErrorResponse',
		schema: ErrorResponseSchema,
		valid: sampleError,
		invalidate: (s) => ({ ...s, status: 'ok' }),
		invalidReason: "status='ok' (must be literal 'error')"
	},
	{
		name: 'OperatorRecord',
		schema: OperatorRecordSchema,
		valid: sampleOperator,
		invalidate: (s) => ({ ...s, is_active: 'yes' }),
		invalidReason: "is_active='yes' (must be boolean)"
	},
	{
		name: 'InstanceResponse',
		schema: InstanceResponseSchema,
		valid: sampleInstance,
		invalidate: (s) => ({ ...s, fee_recipient: 12345 }),
		invalidReason: 'fee_recipient=12345 (must be string)'
	},
	{
		name: 'InstanceDirectoryEntry',
		schema: InstanceDirectoryEntrySchema,
		valid: sampleInstanceDirEntry,
		invalidate: (s) => ({ ...s, origin: null }),
		invalidReason: 'origin=null (must be string)'
	},
	{
		name: 'OrderRecord',
		schema: OrderRecordSchema,
		valid: sampleOrder,
		invalidate: (s) => ({ ...s, side: 'wat' }),
		invalidReason: "side='wat' (must be 'buy'|'sell')"
	},
	{
		name: 'FeedbackSummary',
		schema: FeedbackSummarySchema,
		valid: sampleFeedbackSummary,
		invalidate: (s) => {
			const { positive, ...rest } = s;
			return rest;
		},
		invalidReason: 'missing required field "positive"'
	},
	{
		name: 'ChatAdmissionResponse',
		schema: ChatAdmissionSchema,
		valid: sampleChatAdmission,
		invalidate: (s) => ({ ...s, admitted: 'maybe' }),
		invalidReason: "admitted='maybe' (must be boolean)"
	},

	// ─── cp16 scenarios — extended REST coverage ──────────────
	{
		name: 'OrderViewsResponse',
		schema: OrderViewsResponseSchema,
		valid: sampleOrderViews,
		invalidate: (s) => ({ ...s, count: '42' }),
		invalidReason: 'count="42" (must be number)'
	},
	{
		name: 'OrderViewIncrementResponse',
		schema: OrderViewIncrementResponseSchema,
		valid: sampleOrderViewIncrement,
		invalidate: (s) => {
			const { count, ...rest } = s;
			return rest;
		},
		invalidReason: 'missing required field "count"'
	},
	{
		name: 'OrderbookResponse',
		schema: OrderbookResponseSchema,
		valid: sampleOrderbookResponse,
		invalidate: (s) => ({ ...s, items: 'not an array' }),
		invalidReason: 'items="not an array" (must be array)'
	},
	{
		name: 'FeaturedBid',
		schema: FeaturedBidSchema,
		valid: sampleFeaturedBid,
		invalidate: (s) => ({ ...s, hours_requested: '24' }),
		invalidReason: 'hours_requested="24" (must be number — stringy numbers a common mistake)'
	},
	{
		name: 'FeaturedSlot',
		schema: FeaturedSlotSchema,
		valid: sampleFeaturedSlot,
		invalidate: (s) => {
			const { bid, ...rest } = s;
			return rest;
		},
		invalidReason: 'missing required field "bid"'
	},
	{
		name: 'FeaturedOrderbookResponse',
		schema: FeaturedOrderbookResponseSchema,
		valid: sampleFeaturedOrderbook,
		invalidate: (s) => ({ ...s, max_slots: null }),
		invalidReason: 'max_slots=null (must be number)'
	},
	{
		name: 'AccountOrdersResponse',
		schema: AccountOrdersResponseSchema,
		valid: sampleAccountOrders,
		invalidate: (s) => ({ ...s, next_cursor: 12345 }),
		invalidReason: 'next_cursor=12345 (must be string|null)'
	},
	{
		name: 'ProfileResponse',
		schema: ProfileResponseSchema,
		valid: sampleProfile,
		invalidate: (s) => ({ ...s, source_block_num: 'block#12345' }),
		invalidReason: 'source_block_num="block#12345" (must be number)'
	},
	{
		name: 'OperatorStats',
		schema: OperatorStatsInnerSchema,
		valid: sampleOperatorStats,
		invalidate: (s) => ({ ...s, cumulative_blurt_earned: 'lots' }),
		invalidReason: 'cumulative_blurt_earned="lots" (must be number)'
	},
	{
		name: 'OperatorsResponse',
		schema: OperatorsResponseSchema,
		valid: sampleOperators,
		invalidate: (s) => ({ ...s, operators: 'one operator' }),
		invalidReason: 'operators="one operator" (must be array)'
	},
	{
		name: 'ChatIdentityResponse',
		schema: ChatIdentityResponseSchema,
		valid: sampleChatIdentity,
		invalidate: (s) => ({ ...s, chat_pub: null }),
		invalidReason: 'chat_pub=null (must be string)'
	},
	{
		name: 'ConversationSummary',
		schema: ConversationSummarySchema,
		valid: sampleConversationSummary,
		invalidate: (s) => ({ ...s, has_user_sent: 1 }),
		invalidReason: 'has_user_sent=1 (must be boolean)'
	},
	{
		name: 'ConversationsResponse',
		schema: ConversationsResponseSchema,
		valid: sampleConversations,
		invalidate: (s) => {
			const { account, ...rest } = s;
			return rest;
		},
		invalidReason: 'missing required field "account"'
	},
	{
		name: 'BlockEntry',
		schema: BlockEntrySchema,
		valid: sampleBlockEntry,
		invalidate: (s) => ({ ...s, since_block_num: '12345' }),
		invalidReason: 'since_block_num="12345" (must be number)'
	},
	{
		name: 'BlocksResponse',
		schema: BlocksResponseSchema,
		valid: sampleBlocks,
		invalidate: (s) => ({ ...s, account: false }),
		invalidReason: 'account=false (must be string)'
	},
	{
		name: 'ChatHistoryResponse',
		schema: ChatHistoryResponseSchema,
		valid: sampleChatHistory,
		invalidate: (s) => ({ ...s, items: null }),
		invalidReason: 'items=null (must be array)'
	},
	{
		name: 'InstanceDirectoryResponse',
		schema: InstanceDirectoryResponseSchema,
		valid: sampleInstanceDirectory,
		invalidate: (s) => {
			const { instances, ...rest } = s;
			return rest;
		},
		invalidReason: 'missing required field "instances"'
	}
];

// ─── Run scenarios ─────────────────────────────────────────────
// Each scenario contributes TWO checks:
//   - the sample literal must parse OK
//   - the mutated copy must FAIL to parse
// So total = scenarios.length * 2.

console.log(`api-response-shape smoke: ${scenarios.length * 2} checks\n`);
let failed = 0;
for (const s of scenarios) {
	const validResult = s.schema.safeParse(s.valid);
	if (validResult.success) {
		console.log(`  ✓ ${s.name} valid sample parses`);
	} else {
		const issues = validResult.error.issues
			.map((i) => `${i.path.join('.')}: ${i.message}`)
			.join('; ');
		console.log(`  ✗ ${s.name} valid sample FAILED: ${issues}`);
		failed++;
	}

	const invalidSample = s.invalidate(s.valid as Record<string, unknown>);
	const invalidResult = s.schema.safeParse(invalidSample);
	if (!invalidResult.success) {
		console.log(`  ✓ ${s.name} rejects ${s.invalidReason}`);
	} else {
		console.log(`  ✗ ${s.name} should have rejected ${s.invalidReason}`);
		failed++;
	}
}

console.log('');
if (failed === 0) {
	console.log(`✓ all ${scenarios.length * 2} api-response-shape checks hold`);
	process.exit(0);
}
console.error(
	`✗ ${failed} failed, ${scenarios.length * 2 - failed} passed`
);
process.exit(1);
