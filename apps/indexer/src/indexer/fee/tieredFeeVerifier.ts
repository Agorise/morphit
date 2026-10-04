/**
 * Morphit indexer — a BTC / XMR fee verifier that asks its explorers in tiers.
 *
 * Tier 1 is the explorers that need no clearnet (onion, I2P, this box); the
 * last tier is every usable explorer. A tier's answer stands when it is a
 * verdict (`verified` / `rejected`; for an address, `paid` / `not_yet`); only
 * "no answer" (`pending_external` / `no_answer`) moves on to the next tier. So
 * a node that may use clearnet asks a clearnet explorer only when the onion
 * explorers could not settle the question, and a zero-clearnet node — whose
 * only tier is the onion one — never does.
 *
 * Each tier is a whole verifier with its own quorum: agreement is always among
 * the explorers of ONE tier. The last tier contains the first tier's explorers
 * too, so the full set's rules (quorum, the XMR lone-answer rule, "sources that
 * disagree are never settled by one of them") are exactly those of a verifier
 * over all of them; an earlier tier has the XMR lone-answer rule switched off
 * (its silence is not every other source's silence).
 */
import type { EndpointState } from '@morphit/rpc-pool';
import type {
	AddressPaymentResult,
	FeeClaim,
	FeeVerifier,
	FeeVerifyResult
} from '$indexer/fee/verifier';

/** A verifier one tier is made of. */
export interface FeeVerifierTier extends FeeVerifier {
	endpointSnapshot(): readonly EndpointState[];
	readonly currentAddress: string;
}

export class TieredFeeVerifier implements FeeVerifier {
	readonly name: string;
	readonly checkAddressPayment?: (
		address: string,
		expectedSats: number
	) => Promise<AddressPaymentResult>;

	constructor(private readonly tiers: readonly FeeVerifierTier[]) {
		if (tiers.length === 0) throw new Error('TieredFeeVerifier: at least one tier required');
		this.name = tiers[0]!.name;
		if (tiers.some((t) => t.checkAddressPayment !== undefined)) {
			this.checkAddressPayment = async (address, expectedSats) => {
				let last: AddressPaymentResult = { kind: 'no_answer', reason: 'no explorer' };
				for (const t of this.tiers) {
					if (t.checkAddressPayment === undefined) continue;
					last = await t.checkAddressPayment(address, expectedSats);
					if (last.kind !== 'no_answer') return last;
				}
				return last;
			};
		}
	}

	/** How many tiers (1 on a zero-clearnet node or an all-onion list). */
	get tierCount(): number {
		return this.tiers.length;
	}

	get currentAddress(): string {
		return this.tiers[0]!.currentAddress;
	}

	/** Per-explorer health, each explorer once (its first tier's view). */
	endpointSnapshot(): readonly EndpointState[] {
		const seen = new Set<string>();
		const out: EndpointState[] = [];
		for (const t of this.tiers) {
			for (const s of t.endpointSnapshot()) {
				if (seen.has(s.url)) continue;
				seen.add(s.url);
				out.push(s);
			}
		}
		return out;
	}

	async verify(claim: FeeClaim): Promise<FeeVerifyResult> {
		let last: FeeVerifyResult = { kind: 'pending_external', reason: 'no explorer' };
		for (const t of this.tiers) {
			last = await t.verify(claim);
			if (last.kind !== 'pending_external') return last;
		}
		return last;
	}
}
