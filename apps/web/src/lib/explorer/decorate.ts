/**
 * Morphit explorer — operation decoration (Batch K).
 *
 * Maps a chain operation to a friendly summary the explorer can
 * display.  For Morphit-specific custom_json ops, returns a
 * human-readable label and a brief description.  For unknown ops,
 * returns the raw op name and falls back to JSON display.
 *
 * Pure: no I/O, no DOM.  The label/description strings are i18n
 * keys; the explorer UI translates them.  This module just maps
 * "what kind of op is this" to "what to show".
 *
 * Why we don't render every Blurt op type natively: the long tail
 * (witness votes, escrow ops, vest deposits, account-recovery
 * flows, etc.) doesn't help Morphit users.  For those, the raw
 * JSON view + a "view this on blocks.blurtwallet.com" link is the
 * right escape hatch.
 */

import { OP_IDS } from '../net/config';

export type OpDecorationKind =
	/** Native chain op we render specially. */
	| 'transfer'
	| 'comment'
	| 'vote'
	| 'account_create'
	/** Morphit custom_json by op-id. */
	| 'morphit_profile'
	| 'morphit_order'
	| 'morphit_order_replace'
	| 'morphit_order_cancel'
	| 'morphit_order_complete'
	| 'morphit_feedback'
	| 'morphit_feedback_response'
	| 'morphit_chat'
	| 'morphit_chat_identity'
	| 'morphit_chat_read'
	| 'morphit_release'
	| 'morphit_fee_attest'
	| 'morphit_feature_bid'
	| 'morphit_operator_register'
	| 'morphit_block'
	| 'morphit_operator_block'
	| 'morphit_stranger_fee'
	/** Some other custom_json id. */
	| 'custom_json_unknown'
	/** Anything else (witness ops, vesting ops, escrow, etc.). */
	| 'native_unknown';

export interface OpDecoration {
	readonly kind: OpDecorationKind;
	/** i18n key suffix under `explorer.op.label.*`.  E.g.
	 *  "transfer" → looked up as "explorer.op.label.transfer". */
	readonly labelKey: string;
	/** True if the op is a Morphit-specific custom_json.  UI uses
	 *  this to decide whether to show a tinted background. */
	readonly isMorphitOp: boolean;
	/** cp397 — interpolation values for the templated labels
	 *  (transfer / vote / comment / account_create spell out the
	 *  accounts + amount involved, e.g. "@a sent 55 BLURT to @b").
	 *  Undefined for the static pill labels (Morphit ops, unknowns). */
	readonly values?: Readonly<Record<string, string>>;
}

/** Reverse-lookup: which OP_IDS value corresponds to which
 *  decoration kind.  Built once at module load. */
const OP_ID_TO_KIND: ReadonlyMap<string, OpDecorationKind> = new Map<string, OpDecorationKind>([
	[OP_IDS.profile, 'morphit_profile'],
	[OP_IDS.order, 'morphit_order'],
	[OP_IDS.orderReplace, 'morphit_order_replace'],
	[OP_IDS.orderCancel, 'morphit_order_cancel'],
	[OP_IDS.orderComplete, 'morphit_order_complete'],
	[OP_IDS.feedback, 'morphit_feedback'],
	[OP_IDS.feedbackResponse, 'morphit_feedback_response'],
	[OP_IDS.chatMessage, 'morphit_chat'],
	[OP_IDS.chatIdentity, 'morphit_chat_identity'],
	[OP_IDS.chatRead, 'morphit_chat_read'],
	[OP_IDS.releaseDiscovery, 'morphit_release'],
	[OP_IDS.feeAttest, 'morphit_fee_attest'],
	[OP_IDS.featureBid, 'morphit_feature_bid'],
	[OP_IDS.operatorRegister, 'morphit_operator_register'],
	[OP_IDS.block, 'morphit_block'],
	[OP_IDS.operatorBlock, 'morphit_operator_block'],
	[OP_IDS.strangerFee, 'morphit_stranger_fee']
]);

/** Account-creation native ops — all surface as "account created". */
const ACCOUNT_CREATE_OPS: ReadonlySet<string> = new Set([
	'account_create',
	'account_create_with_delegation',
	'create_claimed_account'
]);

/** Coerce an unknown op field to a string (empty when absent). */
function str(x: unknown): string {
	return typeof x === 'string' ? x : '';
}

/** Split a chain asset string ("55.000 BLURT") into a trimmed amount
 *  and its symbol, dropping trailing zeros for readability
 *  ("55.000 BLURT" → { amount: "55", asset: "BLURT" }). */
function splitAmount(raw: string): { amount: string; asset: string } {
	const parts = raw.trim().split(/\s+/);
	let amount = parts[0] ?? '';
	const asset = parts[1] ?? '';
	if (amount.includes('.')) amount = amount.replace(/0+$/, '').replace(/\.$/, '');
	return { amount, asset };
}

/** Decorate a chain op for the explorer view.  Caller passes the
 *  op tuple `[opName, opBody]` as it appears in
 *  `condenser_api.get_account_history` results.  Returns a
 *  decoration with the right i18n label key. */
export function decorateOp(opName: string, opBody: unknown): OpDecoration {
	if (typeof opName !== 'string') {
		return { kind: 'native_unknown', labelKey: 'native_unknown', isMorphitOp: false };
	}

	const body = (opBody && typeof opBody === 'object' ? opBody : {}) as Record<string, unknown>;

	if (opName === 'transfer') {
		const from = str(body.from);
		const to = str(body.to);
		const { amount, asset } = splitAmount(str(body.amount));
		const hasMemo = str(body.memo).trim() !== '';
		if (from && to && amount && asset) {
			return {
				kind: 'transfer',
				labelKey: hasMemo ? 'transfer_memo' : 'transfer',
				isMorphitOp: false,
				values: { from, to, amount, asset }
			};
		}
		return { kind: 'native_unknown', labelKey: 'native_unknown', isMorphitOp: false };
	}
	if (opName === 'comment') {
		const author = str(body.author);
		const parent = str(body.parent_author);
		if (author) {
			return parent
				? { kind: 'comment', labelKey: 'comment_reply', isMorphitOp: false, values: { author, parent } }
				: { kind: 'comment', labelKey: 'comment', isMorphitOp: false, values: { author } };
		}
		return { kind: 'native_unknown', labelKey: 'native_unknown', isMorphitOp: false };
	}
	if (opName === 'vote') {
		const voter = str(body.voter);
		const author = str(body.author);
		if (voter && author) {
			const down = Number(body.weight) < 0;
			return {
				kind: 'vote',
				labelKey: down ? 'vote_down' : 'vote',
				isMorphitOp: false,
				values: { voter, author }
			};
		}
		return { kind: 'native_unknown', labelKey: 'native_unknown', isMorphitOp: false };
	}
	if (ACCOUNT_CREATE_OPS.has(opName)) {
		const account = str(body.new_account_name);
		if (account) {
			return {
				kind: 'account_create',
				labelKey: 'account_create',
				isMorphitOp: false,
				values: { account }
			};
		}
		return { kind: 'native_unknown', labelKey: 'native_unknown', isMorphitOp: false };
	}

	if (opName === 'custom_json') {
		const id = typeof body.id === 'string' ? body.id : undefined;
		if (typeof id === 'string') {
			const kind = OP_ID_TO_KIND.get(id);
			if (kind) {
				// cp439: a release announcement surfaces its version in the pill
				// ("Release announcement: Morphit vX.Y.Z"). Falls back to the
				// plain label if the version can't be read.
				if (kind === 'morphit_release') {
					const version = releaseVersion(body.json);
					if (version !== null) {
						return {
							kind,
							labelKey: 'morphit_release_versioned',
							isMorphitOp: true,
							values: { version }
						};
					}
				}
				return { kind, labelKey: kind, isMorphitOp: true };
			}
		}
		return {
			kind: 'custom_json_unknown',
			labelKey: 'custom_json_unknown',
			isMorphitOp: false
		};
	}

	return { kind: 'native_unknown', labelKey: 'native_unknown', isMorphitOp: false };
}

/**
 * Pull the version string out of a `morphit_release` custom_json payload.
 *
 * The op's `json` field is the payload encoded as a STRING (raw wire form),
 * though some call paths hand back an already-parsed object — handle both.
 * Returns null on anything unexpected (missing / non-string / unparseable) so
 * the pill falls back to the plain "Release announcement" label rather than
 * showing a broken interpolation. Pure — JSON.parse only, no I/O.
 */
function releaseVersion(json: unknown): string | null {
	let payload: Record<string, unknown> | null = null;
	if (typeof json === 'string') {
		try {
			const parsed: unknown = JSON.parse(json);
			if (parsed !== null && typeof parsed === 'object') {
				payload = parsed as Record<string, unknown>;
			}
		} catch {
			return null;
		}
	} else if (json !== null && typeof json === 'object') {
		payload = json as Record<string, unknown>;
	}
	if (payload === null) return null;
	const v = payload.version;
	return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}
