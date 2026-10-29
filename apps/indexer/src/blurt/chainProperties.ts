/**
 * Morphit indexer — chain properties RPC wrapper.
 *
 * `condenser_api.get_chain_properties` returns the current
 * witness-set parameters. We only care about
 * `account_creation_fee` for now (ADR-0011 dynamic fee model),
 * but the function returns the full structure so callers can
 * extract additional fields later without a second RPC.
 *
 * The fee is serialized as a stringified asset ("100.000 BLURT").
 * We reuse parseBlurtAmount from fee-transfer.ts to extract the
 * numeric value — same parser, same tolerances.
 */

import type { BlurtClient } from '$blurt/client';
import { parseBlurtAmount } from '$indexer/fee-transfer';

/** What we care about from get_chain_properties. The RPC also
 *  returns maximum_block_size, account_subsidy_limit, etc.; we
 *  don't consume those today but preserve the raw response so
 *  future features can read them without another round-trip. */
export interface ChainProperties {
	readonly accountCreationFeeBlurt: number;
	/** The network fee every transaction pays from LIQUID BLURT: this much
	 *  per operation, plus `bandwidthKbytesFeeBlurt` per kB of the signed
	 *  transaction. null when the node did not send a parseable value. */
	readonly operationFlatFeeBlurt: number | null;
	readonly bandwidthKbytesFeeBlurt: number | null;
	readonly observedAt: Date;
	readonly raw: Record<string, unknown>;
}

/** Thrown when the RPC response doesn't contain a parseable
 *  account_creation_fee. Distinct from RPC-transport errors
 *  (which the BlurtClient raises) so callers can distinguish
 *  "node is down" from "node returned garbage". */
export class ChainPropertiesShapeError extends Error {
	constructor(message: string) {
		super(`get_chain_properties: ${message}`);
		this.name = 'ChainPropertiesShapeError';
	}
}

/** The most either network fee rate is taken to be (BLURT). Witnesses have
 *  set 0.050 / 0.200; this read comes from ONE RPC node, and a broken or
 *  hostile one naming "100000.000 BLURT" would, cached for a day, make every
 *  Feature form on the instance say the wallet is short (v1.21.17).
 *  Beyond it the value is dropped and the browser uses the chain's known
 *  values. */
export const NETWORK_FEE_MAX_BLURT = 1;

function plausibleNetworkFee(v: number | null): number | null {
	return v !== null && v >= 0 && v <= NETWORK_FEE_MAX_BLURT ? v : null;
}

/** Fetch the current chain properties. Rotates RPC nodes on
 *  transport failure (inherited from BlurtClient). Throws
 *  ChainPropertiesShapeError on malformed responses. */
export async function fetchChainProperties(blurt: BlurtClient): Promise<ChainProperties> {
	const raw = await blurt.callCondenser<Record<string, unknown>>('get_chain_properties', []);
	if (typeof raw !== 'object' || raw === null) {
		throw new ChainPropertiesShapeError('response is not an object');
	}

	const feeStr = raw.account_creation_fee;
	const parsed = parseBlurtAmount(feeStr);
	if (parsed === null) {
		throw new ChainPropertiesShapeError(
			`account_creation_fee not parseable: ${JSON.stringify(feeStr)}`
		);
	}

	return {
		accountCreationFeeBlurt: parsed,
		operationFlatFeeBlurt: plausibleNetworkFee(parseBlurtAmount(raw.operation_flat_fee)),
		bandwidthKbytesFeeBlurt: plausibleNetworkFee(parseBlurtAmount(raw.bandwidth_kbytes_fee)),
		observedAt: new Date(),
		raw
	};
}
