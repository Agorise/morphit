/**
 * Handler: morphit_settings_v1
 *
 * Stores a user's ENCRYPTED device-local settings (v1.5.0 settings-to-chain
 * mirroring): notification prefs + quiet hours, privacy toggles, syndication
 * targets, hidden accounts, and UI preferences. The client encrypts the whole
 * settings blob with a posting-key-derived key, so this handler only ever sees
 * opaque ciphertext — the indexer never learns the user's preferences or, in
 * particular, which accounts they've hidden.
 *
 * Payload: `{ v: 1, enc: <base64 ciphertext> }`. One row per account in
 * `user_settings`, full-replace, latest broadcast (by block) wins. This handler
 * is the ONLY place that writes user_settings. Same shape + contract as
 * morphit_chat_folders_v1.
 */
import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';

/** Upper bound on stored ciphertext. The plaintext is a handful of toggles plus
 *  the hidden-account list; even a few hundred hidden accounts is only a few KB.
 *  Cap at 64 KB: generous headroom while a malicious client can't bloat the row
 *  unbounded. */
const MAX_ENC_LEN = 64 * 1024;

/** base64 (ORIGINAL alphabet) shape — reject obvious garbage before storing. */
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) return { ok: false, reason: 'payload_not_object' };

	if (ctx.payload.v !== 1) return { ok: false, reason: 'version_unsupported' };

	const enc = ctx.payload.enc;
	if (typeof enc !== 'string' || enc.length === 0) {
		return { ok: false, reason: 'enc_not_string' };
	}
	if (enc.length > MAX_ENC_LEN) {
		return { ok: false, reason: 'enc_too_large' };
	}
	if (!BASE64_RE.test(enc)) {
		return { ok: false, reason: 'enc_not_base64' };
	}

	// Full-replace, latest-block-wins. A later broadcast supersedes an earlier
	// one; an out-of-order (older-block) op is a no-op but still ok:true — the
	// signer did nothing wrong, their update was simply superseded.
	await client.query(
		`INSERT INTO user_settings (
			account, enc, source_block_num, source_trx_id, updated_at
		) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (account) DO UPDATE SET
			enc = EXCLUDED.enc,
			source_block_num = EXCLUDED.source_block_num,
			source_trx_id = EXCLUDED.source_trx_id,
			updated_at = EXCLUDED.updated_at
		WHERE user_settings.source_block_num < EXCLUDED.source_block_num`,
		[ctx.signer, enc, ctx.blockNum, ctx.trxId, ctx.blockTime]
	);

	return { ok: true };
};

export default handle;
