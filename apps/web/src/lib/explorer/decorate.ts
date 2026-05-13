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
	/** Morphit custom_json by op-id. */
	| 'morphit_profile'
	| 'morphit_order'
	| 'morphit_order_replace'
	| 'morphit_order_cancel'
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
}

/** Reverse-lookup: which OP_IDS value corresponds to which
 *  decoration kind.  Built once at module load. */
const OP_ID_TO_KIND: ReadonlyMap<string, OpDecorationKind> = new Map<string, OpDecorationKind>([
	[OP_IDS.profile, 'morphit_profile'],
	[OP_IDS.order, 'morphit_order'],
	[OP_IDS.orderReplace, 'morphit_order_replace'],
	[OP_IDS.orderCancel, 'morphit_order_cancel'],
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

/** Decorate a chain op for the explorer view.  Caller passes the
 *  op tuple `[opName, opBody]` as it appears in
 *  `condenser_api.get_account_history` results.  Returns a
 *  decoration with the right i18n label key. */
export function decorateOp(opName: string, opBody: unknown): OpDecoration {
	if (typeof opName !== 'string') {
		return { kind: 'native_unknown', labelKey: 'native_unknown', isMorphitOp: false };
	}

	if (opName === 'transfer') {
		return { kind: 'transfer', labelKey: 'transfer', isMorphitOp: false };
	}
	if (opName === 'comment') {
		return { kind: 'comment', labelKey: 'comment', isMorphitOp: false };
	}
	if (opName === 'vote') {
		return { kind: 'vote', labelKey: 'vote', isMorphitOp: false };
	}

	if (opName === 'custom_json') {
		const body = opBody as Record<string, unknown> | null;
		const id = body && typeof body === 'object' ? body.id : undefined;
		if (typeof id === 'string') {
			const kind = OP_ID_TO_KIND.get(id);
			if (kind) {
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
