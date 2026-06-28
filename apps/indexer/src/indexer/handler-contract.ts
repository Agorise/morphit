/**
 * Morphit indexer — handler contract.
 *
 * Every op handler exports a default function satisfying this
 * contract. The dispatcher wraps each call, so handlers can focus
 * on "given a validated payload, mutate materialised state."
 *
 *   OpContext is what the handler receives
 *   HandlerResult is what the handler returns
 *
 * Handlers:
 *   - MUST NOT throw for expected rejection reasons (malformed
 *     payload, missing target row, etc.) — return `{ ok: false,
 *     reason }` instead. The dispatcher marks the op rejected in
 *     the event log and continues with the next op in the block.
 *   - MAY throw for unexpected conditions (a bug, an
 *     unanticipated payload shape that slips past the manual
 *     narrowing). The dispatcher catches the throw per-op, rolls
 *     back to THAT op's savepoint, logs the op rejected with
 *     reason `handler_threw:<msg>`, and continues with the next
 *     op — so a single throwing op can NOT wedge the block. The
 *     only path that rolls back the whole block + retries is a
 *     failure that ALSO breaks the dispatcher's own rollback /
 *     event-log queries (a lost DB connection, or an
 *     already-aborted transaction); that propagates out and the
 *     poller retries the block on the next iteration.
 *   - Receive the transaction-scoped client. All queries inside
 *     the handler MUST use that client (not the pool) so they
 *     partake in the block's atomicity.
 *   - MAY read from the chain via `ctx.blurt` — rare; only the
 *     release handler currently does. Keep chain reads minimal;
 *     they block the poller.
 */

import type pg from 'pg';

import type { BlurtClient, ChainOperation } from '$blurt/client';
import type { Config } from '$config';
import type { FeeVerifier } from '$indexer/fee/verifier';

/** Every op the dispatcher sees, decorated with the metadata the
 *  handler needs. Payload is `unknown` — the handler narrows it
 *  with its own zod schema or manual checks. */
export interface OpContext {
	readonly blockNum: number;
	readonly trxInBlock: number;
	readonly opInTrx: number;
	readonly blockTime: Date;
	readonly trxId: string;
	readonly signer: string;
	/** The parsed payload from the custom_json's `json` field. */
	readonly payload: unknown;
	/** All operations in the same transaction as this op, in
	 *  original order. Used by handlers that need to correlate
	 *  with a sibling op — e.g. the order handler finds the
	 *  matching transfer op (the fee payment) per ADR-0009 §1.
	 *
	 *  Handlers SHOULD NOT use this to reach into sibling ops
	 *  belonging to other morphit handlers (order + feedback in
	 *  the same trx, for example); savepoint isolation makes
	 *  that fragile. It's here for correlating with non-morphit
	 *  Blurt ops like `transfer`. */
	readonly siblingOps: readonly ChainOperation[];
	/** Blurt read-only client for handlers that need to verify
	 *  chain state (e.g. release handler checking the pinned
	 *  account's current posting pubkey). */
	readonly blurt: BlurtClient;
	/** The indexer's configuration. Handlers read trust-anchor
	 *  values from here. */
	readonly config: Config;
	/** ADR-0011 sub-phase 4b: fee verifiers keyed by method
	 *  name. The order handler consults feeVerifiers.btc and
	 *  feeVerifiers.xmr when validating those fee methods;
	 *  undefined means the operator hasn't configured that
	 *  method (e.g. no BTC fee address set), in which case the
	 *  handler rejects the op. */
	readonly feeVerifiers: {
		readonly btc?: FeeVerifier;
		readonly xmr?: FeeVerifier;
	};

	/** Part 106 — canonical expected fee amounts for BTC/XMR
	 *  orders.  Sourced via the same chain-pin > env precedence
	 *  as feeVerifiers above (TreasurySource).  When chain-pinned,
	 *  these are authoritative across the federation; when only
	 *  env is available (bootstrap, or the operator hasn't yet
	 *  broadcast a treasury-bearing release op), these come from
	 *  config and the indexer's verification still works locally
	 *  but a federated peer with the chain-pin will use the
	 *  pinned value.
	 *
	 *  Undefined for the chain when no value is available (env
	 *  empty AND no chain-pin) — the order handler treats that
	 *  the same as feeVerifier undefined, rejecting cleanly with
	 *  `fee_amount_not_configured_<method>`.
	 *
	 *  Why this is on OpContext rather than the order handler
	 *  reaching into config directly: pre-Part-106 the handler
	 *  used `ctx.config.btcFeeSatoshis` / `ctx.config.xmrFeePiconero`
	 *  unconditionally.  Part 106 turned the addresses into a
	 *  chain-pinned value but left the amounts on env until the
	 *  audit-deep pass caught the gap.  Routing both through
	 *  OpContext makes "expected amount" inherit the same
	 *  resolution semantics as "expected address" so a hostile
	 *  fork can't underprice their fees on env to skim accepting
	 *  underpaid txids. */
	readonly feeAmounts: {
		readonly btcSatoshis?: number;
		readonly xmrPiconero?: bigint;
		/** cp372 — chain-pinned BLURT fee base (tier-1, pre-multiplier),
		 *  resolved chain-pin > env.  The order handler multiplies by the
		 *  Sybil tier and accepts ± FEE_PRICE_TOLERANCE.  Routing it here
		 *  (rather than reading config.feeBaseBlurt directly) gives the
		 *  BLURT floor the same chain-pinned determinism as BTC/XMR, so a
		 *  hostile fork can't quietly run a different floor.  Undefined →
		 *  the handler falls back to its own config read (Plan B). */
		readonly blurtBase?: number;
	};

	/** FX-aware first-order floor.  The "$1 USD-equivalent" first-buy
	 *  minimum compares amount_min — which is denominated in the
	 *  order's `fiat_currency` (AUD, EUR, …) — against
	 *  FIRST_ORDER_MIN_USD.  This converts that fiat amount to USD so
	 *  the floor is correct for ANY currency, not just USD.
	 *
	 *  Returns null when the currency can't be converted (FX feed
	 *  disabled AND the currency isn't USD, or a genuinely-unknown
	 *  currency the static table doesn't cover).  The order handler
	 *  treats null conservatively — see order.ts.  Backed by the
	 *  indexer's FX source (which itself falls back to a static rate
	 *  table during an outage), or a USD-only identity when the
	 *  operator has disabled the FX feed.  Server-side only; no
	 *  per-user query ever leaves the box. */
	readonly fiatToUsd: (amount: number, fiat: string) => number | null;

	/** Phase E — post-commit notification hook.  Handlers call
	 *  this to flag an orderId whose orderbook-relevant state
	 *  changed (created, cancelled, replaced, fee-verified).
	 *  The dispatcher buffers these and emits them on the
	 *  orderbook event bus AFTER the block transaction commits,
	 *  so SSE subscribers don't see phantom events from rolled-
	 *  back ops.  Idempotent: emitting the same orderId twice
	 *  in a single block is safe — the dispatcher's per-block
	 *  Set collapses duplicates before emission, and the bus
	 *  itself dispatches each emit once to each subscriber.
	 *
	 *  No-op outside Phase E handlers — orderbook handlers call
	 *  it on their happy paths; everyone else ignores it. */
	readonly recordOrderbookChange: (orderId: string) => void;

	/** Phase E.5 — post-commit notification hook for new chat
	 *  messages.  The chat handler calls this after a successful
	 *  INSERT, passing the canonical pair (LEAST/GREATEST of
	 *  sender + recipient) plus the inserted message id.  The
	 *  dispatcher buffers these and emits them on the chat event
	 *  bus AFTER the block transaction commits, so SSE
	 *  subscribers don't see phantom events from rolled-back ops.
	 *
	 *  Separate from recordOrderbookChange because the payload
	 *  shape differs (ChatEvent carries sender/recipient/id;
	 *  orderbook carries just orderId) and because handler
	 *  authors should be explicit about which channel they're
	 *  flagging — a typo'd recordOrderbookChange in a chat
	 *  handler would silently misroute events.
	 *
	 *  No-op outside the chat handler. */
	readonly recordChatChange: (ev: {
		readonly lo: string;
		readonly hi: string;
		readonly messageId: number;
	}) => void;
}

/** Return `{ ok: true }` to apply state changes. Return `{ ok: false,
 *  reason }` to reject this op and lodge the reason in the event log.
 *  The `reason` field is a stable machine-readable slug (no spaces,
 *  lowercase) — the HTTP API never surfaces it, but operators grepping
 *  the event log will rely on these slugs. */
export type HandlerResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The handler function signature. */
export type Handler = (ctx: OpContext, client: pg.PoolClient) => Promise<HandlerResult>;
