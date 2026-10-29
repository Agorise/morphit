/**
 * Morphit indexer — building the BTC / XMR fee verifiers a node runs.
 *
 * From the explorers externalFeeAvailability allows: tier 1 = those that need
 * no clearnet (onion, I2P, this box), last tier = all of them
 * (fee/tieredFeeVerifier.ts). Tier 1 is only built when it holds enough
 * distinct OPERATORS (feeSources.ts explorerOperatorOf) to meet the quorum on
 * its own and there is a wider tier after it; the last tier's quorum is the
 * configured one, lowered to its explorer count in URLs (the config already
 * refuses an explicit quorum larger than the list). The verifiers count
 * agreement by operator, so lowering by URLs — never by operators — is what
 * keeps one operator's onion + I2P pair from making a quorum of two alone:
 * such a tier can never agree, and stays pending / unavailable.
 *
 * A list with any hidden-service explorer gets SOURCE_HIDDEN_REQUEST_TIMEOUT_MS
 * per request (an onion answer took up to ~40 s when measured); a
 * clearnet-only list keeps the old short timeouts. All of it runs in the
 * background re-check (fee/externalFeeRecheck.ts), never in a request.
 */
import { BitcoinExplorerFeeVerifier } from './bitcoinExplorerVerifier';
import { MoneroProofFeeVerifier } from './moneroProofVerifier';
import { TieredFeeVerifier } from './tieredFeeVerifier';
import type { ExternalFeeAvailability } from './externalFeeAvailability';
import { isClearnetSource, SOURCE_HIDDEN_REQUEST_TIMEOUT_MS } from '$indexer/sourceFetch';
import { explorerOperatorOf } from '@morphit/operator-config/fee-sources';

const urlOf = (spec: string): string => spec.trim().replace(/^(raw-tx|node)\+/, '');
/** Does the list hold a hidden-service (or local) explorer? It then gets
 *  SOURCE_HIDDEN_REQUEST_TIMEOUT_MS per request. Also used by the trade
 *  payment check (fee/paymentCheck.ts), which builds its tiers the same way. */
export const anyHidden = (urls: readonly string[]): boolean =>
	urls.some((u) => !isClearnetSource(urlOf(u)));

/** The explorer lists to build tiers from, first to last. PURE. */
export function feeVerifierTiers(
	availability: ExternalFeeAvailability,
	quorum: number
): (readonly string[])[] {
	const all = availability.explorerUrls;
	const first = availability.firstTierUrls;
	const operators = new Set(first.map(explorerOperatorOf)).size;
	if (first.length > 0 && first.length < all.length && operators >= quorum) return [first, all];
	return [all];
}

export function buildBtcFeeVerifier(
	address: string,
	availability: ExternalFeeAvailability,
	quorum: number,
	fetchImpl: typeof fetch
): TieredFeeVerifier {
	return new TieredFeeVerifier(
		feeVerifierTiers(availability, quorum).map(
			(urls) =>
				new BitcoinExplorerFeeVerifier(
					{
						feeAddress: address,
						explorerUrls: urls,
						minConfirmations: 1,
						requestTimeoutMs: anyHidden(urls) ? SOURCE_HIDDEN_REQUEST_TIMEOUT_MS : 5_000,
						minSuccessfulResponses: Math.min(quorum, urls.length)
					},
					fetchImpl
				)
		)
	);
}

export function buildXmrFeeVerifier(
	address: string,
	availability: ExternalFeeAvailability,
	quorum: number,
	fetchImpl: typeof fetch
): TieredFeeVerifier {
	const tiers = feeVerifierTiers(availability, quorum);
	return new TieredFeeVerifier(
		tiers.map(
			(urls, i) =>
				new MoneroProofFeeVerifier(
					{
						feeAddress: address,
						explorerUrls: urls,
						minConfirmations: 1,
						requestTimeoutMs: anyHidden(urls) ? SOURCE_HIDDEN_REQUEST_TIMEOUT_MS : 10_000,
						minSuccessfulResponses: Math.min(quorum, urls.length),
						// Only the last tier may accept one source's answer alone.
						...(i < tiers.length - 1 ? { loneAnswerAfterMs: Number.POSITIVE_INFINITY } : {})
					},
					fetchImpl
				)
		)
	);
}
