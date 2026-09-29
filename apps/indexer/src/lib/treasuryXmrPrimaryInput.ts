/**
 * v1.20.0 (MK-H2) — checking the treasury Monero PRIMARY address the maintainer pastes
 * in, before it goes anywhere near a release op.
 *
 * Used by the release-op builder (apps/indexer/scripts/release-build-payload.ts)
 * and the one-time setter (apps/indexer/scripts/set-treasury-xmr-primary.ts),
 * both run on the maintainer's laptop. Once pinned, every XMR fee is paid to an
 * integrated address built on this address, so it must be the wallet's MAIN
 * address (`4…`): an integrated address cannot be built on a subaddress
 * (`8…`). The check also prints one sample integrated address so the maintainer can
 * compare it with what his own wallet makes for the same payment ID
 * (`integrated_address <payment id>` in monero-wallet-cli) — the end-to-end
 * proof that the address encoding here matches Monero's.
 */
import { ed25519 } from '@noble/curves/ed25519';
import {
	parseXmrPrimaryAddress,
	xmrFeePaymentId,
	xmrIntegratedAddress,
	type XmrPrimaryError
} from '@morphit/release-schema';

/** The order the sample integrated address is made for. Fixed, so the
 *  sample is the same every time and in the docs' checklist. */
export const XMR_SAMPLE_ORDER = { account: 'morphit', permlink: 'treasury-check' } as const;

export type TreasuryXmrPrimaryCheck =
	| {
			readonly ok: true;
			readonly address: string;
			/** Public view key (64 hex): what decrypts the payment IDs, with each payer's tx key. */
			readonly viewPub: string;
			/** Public spend key (64 hex). */
			readonly spendPub: string;
			readonly sample: { readonly paymentId: string; readonly integrated: string };
	  }
	| {
			readonly ok: false;
			readonly reason: XmrPrimaryError | 'xmr_primary_bad_key';
			readonly message: string;
	  };

const MESSAGES: Record<XmrPrimaryError | 'xmr_primary_bad_key', string> = {
	xmr_primary_is_subaddress:
		'That is a SUBADDRESS (it starts with 8). Integrated addresses can only be built on the ' +
		"wallet's MAIN address, which starts with 4 and is 95 characters long (in monero-wallet-cli, " +
		'the `address` command with no arguments shows it as address #0).',
	xmr_primary_is_integrated:
		"That is an INTEGRATED address (106 characters). Paste the wallet's MAIN address instead: it " +
		'starts with 4 and is 95 characters long.',
	xmr_primary_wrong_network:
		'That address is for the Monero TESTNET or STAGENET. The treasury is on Monero mainnet: open ' +
		'the mainnet wallet and copy its main address (starts with 4).',
	xmr_address_bad_checksum:
		'That address has a typo (its checksum does not match). Copy it again from the wallet.',
	xmr_address_bad_encoding:
		'That is not a Monero address. The main address is 95 characters and starts with 4; copy it again.',
	xmr_address_unknown_prefix:
		'That is not a Monero address (unknown network prefix). Copy the main address again.',
	xmr_address_not_string: 'Paste the whole main address (95 characters, starting with 4).',
	xmr_primary_bad_key:
		'That address does not hold valid Monero keys. Copy it again from the wallet.'
};

function isPoint(hex: string): boolean {
	try {
		ed25519.ExtendedPoint.fromHex(hex);
		return true;
	} catch {
		return false;
	}
}

export function checkTreasuryXmrPrimaryInput(raw: string): TreasuryXmrPrimaryCheck {
	const p = parseXmrPrimaryAddress(raw);
	if (!p.ok) return { ok: false, reason: p.reason, message: MESSAGES[p.reason] };
	if (!isPoint(p.value.spendPub) || !isPoint(p.value.viewPub)) {
		return { ok: false, reason: 'xmr_primary_bad_key', message: MESSAGES.xmr_primary_bad_key };
	}
	const paymentId = xmrFeePaymentId(XMR_SAMPLE_ORDER.account, XMR_SAMPLE_ORDER.permlink);
	return {
		ok: true,
		address: p.value.address,
		viewPub: p.value.viewPub,
		spendPub: p.value.spendPub,
		sample: { paymentId, integrated: xmrIntegratedAddress(p.value.address, paymentId) }
	};
}
