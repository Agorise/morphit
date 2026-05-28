/**
 * Morphit — native Blurt `comment` op broadcaster.
 *
 * Unlike every other op Morphit broadcasts (which use `custom_json`
 * with a Morphit-specific op id), this op uses Blurt's native
 * `comment` operation. Comments / blog posts are a first-class
 * chain concept in Graphene-lineage chains (Steem, Hive, Blurt);
 * the app/frontend layer (blurt.blog / blurt.media) picks up any
 * comment_operation with matching author+permlink and renders it.
 *
 * Used exclusively by the ADR Q3 syndication publish flow: after
 * a user's order fills and they choose "Publish announcement,"
 * this helper signs a root-level post to the @morphit category
 * on the user's own behalf. Morphit the project signs NOTHING
 * here — the signature is the user's own posting key.
 *
 * ─── Shape of a Blurt comment_operation ─────────────────────────
 *
 * Tuple form (what Client.signTransaction consumes):
 *
 *   ['comment', {
 *     parent_author: string,    // "" for a root post; author of
 *                               //   the parent for a reply
 *     parent_permlink: string,  // category (first tag) for a root
 *                               //   post; parent's permlink for a reply
 *     author: string,           // the post author
 *     permlink: string,         // must be unique per (author)
 *                               //   otherwise chain reads it as an
 *                               //   EDIT of the existing post
 *     title: string,            // post title (root only; empty for
 *                               //   replies)
 *     body: string,             // markdown body
 *     json_metadata: string     // JSON-stringified metadata blob:
 *                               //   tags, app, format, etc.
 *   }]
 *
 * Per Blurt conventions (confirmed against the @beblurt/dblurt
 * type docs and the welcome-page documentation on blurt.blog):
 *   - Categories are plain tag strings, NOT hivemind `hive-NNNNNN`
 *     synthetic account names (that's a Hive concept, not Blurt's
 *     current scheme).
 *   - The first tag in json_metadata.tags typically matches
 *     parent_permlink; the chain uses parent_permlink for the
 *     category, but apps often use tags[0] as display category.
 *     Kept consistent here.
 *   - json_metadata format is an app-specific convention. We
 *     include { app, format, tags } at a minimum.
 *
 * ─── Unique-permlink discipline ─────────────────────────────────
 *
 * Comments with a previously-used permlink are interpreted as
 * EDITS by the chain, not new posts. For the syndication
 * announcement, callers MUST derive a deterministic, unique
 * permlink from the order's permlink (e.g. `morphit-announce-${orderPermlink}`).
 * That way:
 *   - A double-click that tries to re-broadcast the same
 *     announcement produces either (a) an accepted edit (no-op if
 *     body is identical) or (b) a rejected duplicate-trx — either
 *     way, no second post appears.
 *   - The syndicate-ack op's trx_id later records the broadcast's
 *     trx_id; if the post is later edited by the user, the ack
 *     still points at the original publish.
 */

import type {
	PrivateKey,
	Client,
	Transaction,
	SignedTransaction,
	Operation
} from '@beblurt/dblurt';

import { getBlurtClient } from '$blurt/client';
import type { LiveIdentity } from '$crypto/keygen';
import { getUserBlurtAccount, BroadcastError } from '$blurt/ops/profile';
import { redactPrivateKeys } from '$lib/security/privateKeyDetector';

// cp165 byte-budget: dblurt is type-only at module scope.  Runtime
// values (PrivateKey, Client) load dynamically inside the broadcast
// function so the 2 MB dblurt chunk stays out of the eager-load
// graph for routes that transitively reach this file
// (syndication/publish.ts → /post + LeaveFeedbackForm on /my/orders).

/** Convert a raw 32-byte secp256k1 scalar to a dblurt PrivateKey.
 *  Same helper shape as sign.ts (kept local to this module to
 *  avoid a cross-module import of a private conversion).
 *  Cast via unknown — see sign.ts for rationale.
 *  cp165: async + dynamic dblurt import. */
async function rawToPrivateKey(raw: Uint8Array): Promise<PrivateKey> {
	const { PrivateKey: PK } = await import('@beblurt/dblurt');
	return new PK(raw as unknown as Buffer);
}

/** Sign a transaction with a PrivateKey via dblurt's broadcast helper.
 *  See sign.ts for the rationale — `Client.signTransaction` does not
 *  exist as a static method; the actual API is
 *  `client.broadcast.sign(tx, key)` on a dblurt Client INSTANCE.
 *  Morphit's local BlurtClient wrapper doesn't expose dblurt's
 *  broadcast helper, so we instantiate a throwaway Client whose
 *  endpoint is never contacted (broadcast.sign is pure crypto).
 *  Local copy to keep this module self-contained per the
 *  duplication note in the helper above.
 *  cp165: async + dynamic dblurt import. */
let _signingClient: Client | null = null;
async function signTransactionWithKey(
	tx: Transaction,
	key: PrivateKey
): Promise<SignedTransaction> {
	if (_signingClient === null) {
		const { Client: ClientCtor } = await import('@beblurt/dblurt');
		_signingClient = new ClientCtor(['https://signing-only.invalid']);
	}
	return _signingClient.broadcast.sign(tx, key);
}

/** Derive ref_block_num, ref_block_prefix, and expiration from the
 *  chain head. Duplicates the helper in sign.ts rather than
 *  importing it so this module is self-contained for the syndication
 *  flow — comment ops are narrow enough in scope that a small
 *  amount of duplication is cheaper than opening an internal export
 *  surface on sign.ts. */
async function getRefBlockInfo(): Promise<{
	ref_block_num: number;
	ref_block_prefix: number;
	expiration: string;
}> {
	const client = getBlurtClient();
	const props = await client.getDynamicGlobalProperties();
	const blockNum = props.head_block_number;
	const blockId = props.head_block_id;
	const ref_block_num = blockNum & 0xffff;
	const prefixHex = blockId.slice(8, 16);
	const ref_block_prefix =
		(parseInt(prefixHex.slice(0, 2), 16) |
			(parseInt(prefixHex.slice(2, 4), 16) << 8) |
			(parseInt(prefixHex.slice(4, 6), 16) << 16) |
			(parseInt(prefixHex.slice(6, 8), 16) << 24)) >>>
		0;
	const head = new Date(props.time + 'Z').getTime();
	const expiration = new Date(head + 60_000).toISOString().slice(0, -5);
	return { ref_block_num, ref_block_prefix, expiration };
}

// ─── Public API ─────────────────────────────────────────────────

/** Input to broadcastComment. Restricted to root-post semantics
 *  (parent_author == "") because that's the only use case Morphit
 *  has for native comments; we're not building a general-purpose
 *  comment client. */
export interface CommentPayload {
	/** Primary tag / category. Becomes parent_permlink on the wire.
	 *  For Morphit announcements this is always `morphit`. */
	readonly primaryTag: string;
	/** All tags to include in json_metadata.tags. Should include
	 *  primaryTag as the first element. 1..5 tags total per Blurt
	 *  conventions. */
	readonly tags: readonly string[];
	/** Permlink — must be unique per author. Caller's responsibility
	 *  to generate a deterministic permlink from upstream context
	 *  (see module doc-comment: `morphit-announce-${orderPermlink}`
	 *  is the convention). Must match Blurt's permlink charset:
	 *  lowercase alphanumeric + dashes, no leading/trailing dash,
	 *  no consecutive dashes. */
	readonly permlink: string;
	/** Post title. Empty string is allowed by the chain but
	 *  produces a bad UX on blurt.blog; callers should provide one. */
	readonly title: string;
	/** Markdown body. */
	readonly body: string;
	/** Additional metadata merged into json_metadata alongside tags
	 *  and the app marker. Opaque to the chain; used by frontends.
	 *  Optional. */
	readonly extraMetadata?: Record<string, unknown>;
}

/** App marker. Appears in json_metadata.app so viewers on blurt.blog
 *  can see where a post originated. The format "name/version" is
 *  the Steem/Hive/Blurt convention. */
const APP_MARKER = 'morphit/0.1.0';

/** Blurt permlink charset check. Mirrors the indexer's PERMLINK_RE
 *  for a consistent fail-fast. */
const PERMLINK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Broadcast a native Blurt comment. Returns the block_num and
 * trx_id from `condenser_api.broadcast_transaction_synchronous`.
 *
 * @param live     Session LiveIdentity. The posting private key is
 *                 read from here; never leaves the browser.
 * @param payload  The comment payload (see CommentPayload).
 *
 * Throws BroadcastError if the session has no Blurt account
 * registered yet (which shouldn't happen in the syndication flow,
 * since you can't have a filled order without a registered
 * account — but we check anyway for defence-in-depth).
 *
 * Throws Error if the permlink is malformed; comes before any
 * chain call so callers get a fast, actionable failure rather
 * than a cryptic chain rejection.
 */
/** Pure op-builder for a Blurt comment operation. Returns the
 *  [kind, fields] Operation tuple ready for inclusion in a
 *  transaction, with redaction applied to free-text (title,
 *  body). Takes `account` as an explicit parameter — the
 *  broadcast wrapper supplies it from getUserBlurtAccount().
 *
 *  Extracted from `broadcastComment` so redaction behavior is
 *  testable as a pure function. Permlink validation stays in
 *  the wrapper (it's pre-flight, not body-building).
 */
export function buildCommentOperation(payload: CommentPayload, account: string): Operation {
	// Assemble json_metadata. The shape is a convention not a
	// protocol rule, but matching what blurt.blog emits produces
	// the cleanest rendering when a reader opens the post.
	const jsonMetadata: Record<string, unknown> = {
		app: APP_MARKER,
		format: 'markdown',
		tags: payload.tags,
		...(payload.extraMetadata ?? {})
	};

	return [
		'comment',
		{
			parent_author: '',
			parent_permlink: payload.primaryTag,
			author: account,
			permlink: payload.permlink,
			// Silent private-key redaction on free-text fields,
			// same chokepoint pattern as buildOrderPayload +
			// buildProfileBody. Syndication templates compose
			// title/body from trusted sources today, but the
			// chokepoint discipline ensures no comment op ever
			// leaves this module carrying unredacted key material.
			title: redactPrivateKeys(payload.title),
			body: redactPrivateKeys(payload.body),
			json_metadata: JSON.stringify(jsonMetadata)
		}
	];
}

export async function broadcastComment(
	live: LiveIdentity,
	payload: CommentPayload
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered.');
	}

	// Fail-fast permlink validation. A malformed permlink would be
	// rejected by the chain anyway, but the error surfaces would be
	// buried in a condenser_api failure rather than a clean
	// client-side error.
	if (payload.permlink.length < 1 || payload.permlink.length > 256) {
		throw new Error('permlink_bad_length');
	}
	if (!PERMLINK_RE.test(payload.permlink)) {
		throw new Error('permlink_bad_chars');
	}

	const op = buildCommentOperation(payload, account);

	const client = getBlurtClient();
	const { ref_block_num, ref_block_prefix, expiration } = await getRefBlockInfo();

	const tx: Transaction = {
		ref_block_num,
		ref_block_prefix,
		expiration,
		operations: [op],
		extensions: []
	};

	const postingKey = await rawToPrivateKey(live.posting.privateKey);
	const signed: SignedTransaction = await signTransactionWithKey(tx, postingKey);

	const result = await client.call<{ block_num: number; trx_id: string }>(
		'condenser_api.broadcast_transaction_synchronous',
		[signed]
	);
	return result;
}

/** Deterministic permlink for a syndication announcement. Used
 *  across the publish flow so retries are safe: the second attempt
 *  either produces an accepted edit or a duplicate-trx rejection,
 *  not a fresh duplicate post.
 *
 *  The prefix `morphit-announce-` is human-readable in the user's
 *  own post list and on blurt.blog. The suffix is the order's
 *  permlink (already a valid Blurt permlink), so the concatenation
 *  is guaranteed valid. Total length bounded by: 17 prefix chars
 *  + up to 32 order permlink chars = up to 49 chars, well under
 *  the 256-char cap. */
export function announcementPermlinkFor(orderPermlink: string): string {
	return `morphit-announce-${orderPermlink}`;
}
