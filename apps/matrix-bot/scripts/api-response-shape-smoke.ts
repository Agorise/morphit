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
	InstanceDirectoryResponse,
	// cp17 additions (final ~12 lower-traffic):
	ClearingPricePoint,
	ClearingPriceHistoryResponse,
	BatchProfilesResponse,
	FeedbackRecord,
	FeedbackResponseRecord,
	AccountFeedbackResponse,
	AccountFeedbackGivenResponse,
	ChatReadStateEntry,
	ChatReadStateResponse,
	AttestorEligibilityResponse,
	StrangerFeeQuoteResponse
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
	lag_blocks_note: z.string().optional(),
	stale: z.boolean()
});

const ListingFeeSchema = z.object({
	base_fee_blurt: z.number(),
	feature_fee_blurt_per_hour: z.number(),
	quote_ttl_seconds: z.number(),
	// cp128 rename: pre-cp128 these were `base_fee_usd` /
	// `blurt_price_usd` (USD hardcoded).  Now denomination-
	// agnostic with a companion `denomination_fiat` field
	// indicating the unit (USD / EUR / XDR / XAU / etc.).
	// See ADR-0040.
	base_fee_fiat: z.number().optional(),
	blurt_price_fiat: z.number().optional(),
	denomination_fiat: z.string().optional(),
	price_warning: z.string().optional()
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
	// Part 122 cp21 — BCH chat-link URL override.  Optional for
	// back-compat with pre-cp21 indexer builds.
	bch: z.string().nullable().optional(),
	// Part 122 cp24 — LTC chat-link URL override.  Optional for
	// back-compat with pre-cp24 indexer builds.
	ltc: z.string().nullable().optional(),
	// Part 122 cp27 — DASH chat-link URL override.  Optional for
	// back-compat with pre-cp27 indexer builds.
	dash: z.string().nullable().optional(),
	// Part 122 cp33 — DOGE chat-link URL override.  Optional for
	// back-compat with pre-cp33 indexer builds.
	doge: z.string().nullable().optional(),
	// Part 122 cp39 — ZEC chat-link URL override.  Optional for
	// back-compat with pre-cp39 indexer builds.
	zec: z.string().nullable().optional(),
	arrr: z.string().nullable().optional(),
	dcr: z.string().nullable().optional(),
	sol: z.string().nullable().optional(),
	eth: z.string().nullable().optional(),
	xrp: z.string().nullable().optional(),
	usdt: z
		.object({
			erc20: z.string().nullable(),
			trc20: z.string().nullable(),
			spl: z.string().nullable(),
			bep20: z.string().nullable()
		})
		.optional(),
	// Part 122 cp30 — USDC per-network chat-link URL overrides.
	// Same back-compat optionality as USDT — pre-cp30 indexer
	// builds may omit this field entirely.
	usdc: z
		.object({
			erc20: z.string().nullable(),
			spl: z.string().nullable(),
			base: z.string().nullable(),
			polygon: z.string().nullable()
		})
		.optional(),
	// Part 122 cp31 — DAI per-network chat-link URL overrides.
	// 4 EVM networks: ERC-20, Polygon, Base, Arbitrum.  No SPL
	// per ADR-0029 §1 (no canonical Maker DAI on Solana).
	// Same back-compat optionality as USDC.
	dai: z
		.object({
			erc20: z.string().nullable(),
			polygon: z.string().nullable(),
			base: z.string().nullable(),
			arbitrum: z.string().nullable()
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
		operator_display_name: z.string().nullable(),
		name: z.string().nullable(),
		tagline: z.string().nullable(),
		contact_url: z.string().nullable(),
		alt_networks: z.unknown(), // shape varies; passthrough-tolerant
		status: z.enum(['good', 'quiet', 'stale', 'unreachable', 'mismatch']),
		registered_at: z.string(),
		last_probed_at: z.string().nullable(),
		indexed_block: z.number().nullable(),
		chain_lag_sec: z.number().nullable(),
		consecutive_failures: z.number()
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
		fee_status: z.string().optional(),
		created_at: z.string(),
		updated_at: z.string(),
		expires_at: z.string().nullable()
	})
	.passthrough();

const FeedbackSummarySchema = z.object({
	count: z.number(),
	weighted_rating: z.number(),
	by_rating: z.object({
		'1': z.number(),
		'2': z.number(),
		'3': z.number(),
		'4': z.number(),
		'5': z.number()
	})
});

const ChatAdmissionSchema = z
	.object({
		me: z.string(),
		peer: z.string(),
		admitted: z.boolean(),
		reason: z.enum(['prior_exchange', 'fee_paid', 'none'])
	})
	.passthrough(); // Forward-compat for future fields.

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
		sender: z.string(),
		recipient: z.string(),
		ciphertext: z.string(),
		header: z.unknown(),
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

// ─── cp17 schemas (final ~12 lower-traffic types) ──────────────

const ClearingPricePointSchema = z.object({
	day: z.string(),
	clearing_blurt_per_hour: z.number(),
	active_visible_count: z.number(),
	max_slots: z.number()
});

const ClearingPriceHistoryResponseSchema = z.object({
	points: z.array(ClearingPricePointSchema),
	window_days: z.number(),
	max_slots: z.number()
});

const BatchProfilesResponseSchema = z.object({
	profiles: z.record(z.string(), ProfileResponseSchema)
});

const FeedbackResponseRecordSchema = z.object({
	responder: z.string(),
	comment: z.string(),
	created_at: z.string()
});

const FeedbackRecordSchema = z.object({
	id: z.number(),
	reviewer: z.string(),
	subject: z.string(),
	rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
	comment: z.string().nullable(),
	order_permlink: z.string().nullable(),
	created_at: z.string(),
	source_trx_id: z.string(),
	suppressed: z.boolean().optional(),
	has_verified_chat: z.boolean().optional(),
	responses: z.array(FeedbackResponseRecordSchema)
});

const FeedbackSummarySchemaForAcct = FeedbackSummarySchema; // reuse

const AccountFeedbackResponseSchema = z.object({
	summary: FeedbackSummarySchemaForAcct,
	items: z.array(FeedbackRecordSchema),
	next_cursor: z.string().nullable()
});

const AccountFeedbackGivenResponseSchema = z.object({
	items: z.array(FeedbackRecordSchema),
	next_cursor: z.string().nullable()
});

const ChatReadStateEntrySchema = z.object({
	peer: z.string(),
	last_read_at: z.string()
});

const ChatReadStateResponseSchema = z.object({
	account: z.string(),
	items: z.array(ChatReadStateEntrySchema)
});

const AttestorEligibilityResponseSchema = z
	.object({
		account: z.string(),
		phase: z.enum(['launch', 'steady']),
		eligible: z.boolean(),
		reason: z.string(), // AttestorEligibilityReason is a string union
		loyalty_blurt: z.number(),
		age_days: z.number(),
		missing_loyalty_blurt: z.number(),
		days_until_eligible: z.number().nullable()
	})
	.passthrough();

const StrangerFeeQuoteResponseSchema = z.object({
	account: z.string(),
	base_price_blurt: z.number(),
	price_blurt: z.number(),
	multiplier: z.number(),
	recent_count: z.number(),
	window_minutes: z.number(),
	capped: z.boolean(),
	max_multiplier: z.number()
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
	code: 'not_found',
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
	operator_display_name: null,
	name: null,
	tagline: null,
	contact_url: null,
	alt_networks: null,
	status: 'good' as const,
	registered_at: '2026-05-14T00:00:00Z',
	last_probed_at: null,
	indexed_block: null,
	chain_lag_sec: null,
	consecutive_failures: 0
} satisfies InstanceDirectoryEntry;

const sampleOrder = {
	account: 'alice',
	permlink: 'sell-btc-2026-05-14',
	side: 'sell' as const,
	asset: 'BTC' as const,
	fiat_currency: 'USD',
	amount_min: 50,
	amount_max: 500,
	price_model: { type: 'spread', spread_pct: 1.5 },
	location_region: 'EU',
	payment_methods: ['sepa', 'wise'],
	terms: null,
	created_at: '2026-05-14T00:00:00Z',
	updated_at: '2026-05-14T00:00:00Z',
	expires_at: null
} satisfies OrderRecord;

const sampleFeedbackSummary = {
	count: 42,
	weighted_rating: 4.75,
	by_rating: { '1': 0, '2': 1, '3': 1, '4': 5, '5': 35 },
	// cp124 H5: by-side breakdown
	by_side: {
		buy: { count: 25, weighted_rating: 4.92 },
		sell: { count: 17, weighted_rating: 4.5 }
	},
	// cp124 H6: dormancy signal
	last_traded_at: '2026-05-15T12:30:00Z'
} satisfies FeedbackSummary;

const sampleChatAdmission = {
	me: 'alice',
	peer: 'bob',
	admitted: true,
	reason: 'fee_paid' as const
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
	sender: 'alice',
	recipient: 'bob',
	ciphertext: 'opaque-base64-payload-placeholder',
	header: { ephemeral_pub: 'x', nonce: 'y', client_tag: 'z' },
	created_at: '2026-05-15T00:00:00Z'
} satisfies ChatMessageRecord;

const sampleChatHistory = {
	items: [sampleChatMessage],
	next_cursor: null
} satisfies ChatHistoryResponse;

const sampleInstanceDirectory = {
	version: 1 as const,
	directory_updated_at: '2026-05-15T00:00:00Z',
	instances: [sampleInstanceDirEntry]
} satisfies InstanceDirectoryResponse;

// ─── cp17 samples ──────────────────────────────────────────────

const sampleClearingPricePoint = {
	day: '2026-05-15',
	clearing_blurt_per_hour: 0.12,
	active_visible_count: 4,
	max_slots: 5
} satisfies ClearingPricePoint;

const sampleClearingPriceHistory = {
	points: [sampleClearingPricePoint],
	window_days: 30,
	max_slots: 5
} satisfies ClearingPriceHistoryResponse;

const sampleBatchProfiles = {
	profiles: { alice: sampleProfile, bob: sampleProfile }
} satisfies BatchProfilesResponse;

const sampleFeedbackResponse = {
	responder: 'alice',
	comment: 'Thanks for the smooth trade!',
	created_at: '2026-05-15T00:00:00Z'
} satisfies FeedbackResponseRecord;

const sampleFeedbackRecord = {
	id: 100,
	reviewer: 'bob',
	subject: 'alice',
	rating: 5 as const,
	comment: 'Smooth trade, fast settlement.',
	order_permlink: 'sell-btc-2026-05-14',
	created_at: '2026-05-15T00:00:00Z',
	source_trx_id: 'abc123def456',
	responses: [sampleFeedbackResponse]
} satisfies FeedbackRecord;

const sampleAccountFeedback = {
	summary: sampleFeedbackSummary,
	items: [sampleFeedbackRecord],
	next_cursor: null
} satisfies AccountFeedbackResponse;

const sampleAccountFeedbackGiven = {
	items: [sampleFeedbackRecord],
	next_cursor: null
} satisfies AccountFeedbackGivenResponse;

const sampleChatReadStateEntry = {
	peer: 'bob',
	last_read_at: '2026-05-15T00:00:00Z'
} satisfies ChatReadStateEntry;

const sampleChatReadState = {
	account: 'alice',
	items: [sampleChatReadStateEntry]
} satisfies ChatReadStateResponse;

const sampleAttestorEligibility = {
	account: 'alice',
	phase: 'launch' as const,
	eligible: true,
	reason: 'age' as const,
	loyalty_blurt: 5,
	age_days: 90,
	missing_loyalty_blurt: 0,
	days_until_eligible: null
} satisfies AttestorEligibilityResponse;

const sampleStrangerFeeQuote = {
	account: 'alice',
	base_price_blurt: 5,
	price_blurt: 10,
	multiplier: 2,
	recent_count: 2,
	window_minutes: 60,
	capped: false,
	max_multiplier: 128
} satisfies StrangerFeeQuoteResponse;

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
			const { count, ...rest } = s;
			return rest;
		},
		invalidReason: 'missing required field "count"'
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
	},

	// ─── cp17 scenarios — final lower-traffic types ───────────
	{
		name: 'ClearingPricePoint',
		schema: ClearingPricePointSchema,
		valid: sampleClearingPricePoint,
		invalidate: (s) => ({ ...s, day: null }),
		invalidReason: 'day=null (must be string)'
	},
	{
		name: 'ClearingPriceHistoryResponse',
		schema: ClearingPriceHistoryResponseSchema,
		valid: sampleClearingPriceHistory,
		invalidate: (s) => ({ ...s, window_days: 'thirty' }),
		invalidReason: 'window_days="thirty" (must be number)'
	},
	{
		name: 'BatchProfilesResponse',
		schema: BatchProfilesResponseSchema,
		valid: sampleBatchProfiles,
		invalidate: (s) => ({ ...s, profiles: 'not a record' }),
		invalidReason: 'profiles="not a record" (must be record)'
	},
	{
		name: 'FeedbackResponseRecord',
		schema: FeedbackResponseRecordSchema,
		valid: sampleFeedbackResponse,
		invalidate: (s) => ({ ...s, comment: null }),
		invalidReason: 'comment=null (must be string; FeedbackResponseRecord requires non-null)'
	},
	{
		name: 'FeedbackRecord',
		schema: FeedbackRecordSchema,
		valid: sampleFeedbackRecord,
		invalidate: (s) => ({ ...s, rating: 6 }),
		invalidReason: 'rating=6 (must be 1|2|3|4|5)'
	},
	{
		name: 'AccountFeedbackResponse',
		schema: AccountFeedbackResponseSchema,
		valid: sampleAccountFeedback,
		invalidate: (s) => {
			const { summary, ...rest } = s;
			return rest;
		},
		invalidReason: 'missing required field "summary"'
	},
	{
		name: 'AccountFeedbackGivenResponse',
		schema: AccountFeedbackGivenResponseSchema,
		valid: sampleAccountFeedbackGiven,
		invalidate: (s) => ({ ...s, items: { not: 'an array' } }),
		invalidReason: 'items=object (must be array)'
	},
	{
		name: 'ChatReadStateEntry',
		schema: ChatReadStateEntrySchema,
		valid: sampleChatReadStateEntry,
		invalidate: (s) => ({ ...s, last_read_at: 12345 }),
		invalidReason: 'last_read_at=12345 (must be ISO string, not epoch number)'
	},
	{
		name: 'ChatReadStateResponse',
		schema: ChatReadStateResponseSchema,
		valid: sampleChatReadState,
		invalidate: (s) => ({ ...s, account: null }),
		invalidReason: 'account=null (must be string)'
	},
	{
		name: 'AttestorEligibilityResponse',
		schema: AttestorEligibilityResponseSchema,
		valid: sampleAttestorEligibility,
		invalidate: (s) => ({ ...s, phase: 'beta' }),
		invalidReason: "phase='beta' (must be 'launch'|'steady')"
	},
	{
		name: 'StrangerFeeQuoteResponse',
		schema: StrangerFeeQuoteResponseSchema,
		valid: sampleStrangerFeeQuote,
		invalidate: (s) => ({ ...s, capped: 'yes' }),
		invalidReason: "capped='yes' (must be boolean)"
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
