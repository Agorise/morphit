/**
 * v1.20.0 (MK-H2) — checking the treasury BTC xpub the maintainer pastes in, before it
 * goes anywhere near a release op.
 *
 * Used by the release-op builder (apps/indexer/scripts/release-build-payload.ts)
 * and the one-time setter (apps/indexer/scripts/set-treasury-btc-xpub.ts), both
 * run on the maintainer's laptop. The crypto is the shared parser in
 * @morphit/release-schema (the same one every indexer and browser uses); this
 * module only turns its verdict into a plain-words instruction and derives the
 * first receive addresses so the maintainer can compare them with the wallet's
 * "Addresses" tab before anything is broadcast.
 */
import {
	deriveBtcFeeAddress,
	parseAccountXpub,
	type XpubParseError
} from '@morphit/release-schema';

export type TreasuryXpubCheck =
	| {
			readonly ok: true;
			/** Canonical spelling that goes on chain. */
			readonly xpub: string;
			/** The same key as Electrum/Sparrow show it for a native segwit wallet. */
			readonly zpub: string;
			/** Short public id of the key (first 4 bytes of HASH160(pubkey), hex). */
			readonly keyId: string;
			/** Receive addresses #0, #1, #2 — must match the wallet's Addresses tab. */
			readonly receive: readonly string[];
	  }
	| { readonly ok: false; readonly reason: XpubParseError; readonly message: string };

const MESSAGES: Record<XpubParseError, string> = {
	xpub_is_private:
		'STOP: that is a PRIVATE key (it starts with xprv / zprv / yprv / tprv / vprv). ' +
		'Anyone who sees it can spend the treasury. Do not paste it anywhere, and consider it exposed ' +
		'if it was ever saved or shared. In Sparrow: Settings → Keystores → right-click the long key in ' +
		'the "xpub / zpub" field → Copy xpub (a PUBLIC key).',
	xpub_testnet:
		'That is a TESTNET key (tpub / upub / vpub). The treasury is on Bitcoin mainnet: open the ' +
		'mainnet wallet in Sparrow and copy its xpub.',
	xpub_wrong_script_type:
		'That key is for a different wallet type (ypub = nested segwit, or a multisig key). Morphit fee ' +
		'addresses are native segwit (bc1q…, BIP84): use a single-signature "Native Segwit (P2WPKH)" ' +
		'wallet in Sparrow and copy its xpub.',
	xpub_not_account_level:
		"That is not the wallet's ACCOUNT key. Copy the key Sparrow shows under Settings → Keystores " +
		"(where Derivation reads m/84'/0'/0'), not a master key or a single address key.",
	xpub_bad_checksum:
		'That key has a typo (its checksum does not match). Copy it again from the wallet.',
	xpub_bad_length: 'That does not decode to an extended public key. Copy the whole key again.',
	xpub_unknown_version:
		"That is not a Bitcoin xpub / zpub. Copy the xpub from Sparrow's Keystores section.",
	xpub_bad_key: 'That key is damaged (not a valid public key). Copy it again from the wallet.',
	xpub_not_string: 'Paste the whole key (111 characters, starting with "xpub" or "zpub").'
};

export function checkTreasuryXpubInput(raw: string): TreasuryXpubCheck {
	const parsed = parseAccountXpub(raw);
	if (!parsed.ok) return { ok: false, reason: parsed.reason, message: MESSAGES[parsed.reason] };
	const v = parsed.value;
	return {
		ok: true,
		xpub: v.xpub,
		zpub: v.zpub,
		keyId: v.keyId,
		receive: [0, 1, 2].map((i) => deriveBtcFeeAddress(v, i))
	};
}
