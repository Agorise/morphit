/**
 * @morphit/release-schema — shared `morphit_release_v1` op schema +
 * validator.
 *
 * cp170 extracted this from `apps/web/src/lib/net/{release,
 * releaseValidate}.ts` into a standalone package so that BOTH the
 * frontend (apps/web) and the indexer (apps/indexer — its release
 * handler's parity test + its release-build / release-validator
 * scripts) import the validator from one canonical place, rather
 * than the indexer reaching across into apps/web source.
 *
 * Why the move: the indexer's release.test.ts proves byte-for-byte
 * parity between the indexer handler and this frontend validator
 * (Part 106/107 invariant).  When that test (run under vitest)
 * transformed the apps/web source file, vite auto-discovered
 * apps/web/tsconfig.json — which `extends ./.svelte-kit/tsconfig.json`,
 * a SvelteKit-generated file absent in the CI smoke job.  That broke
 * collection of all 30 release.test.ts tests in CI (the long-standing
 * "-30" baseline gap).  Living in a plain package with its own
 * tsconfig — no SvelteKit extends — removes the cross-app coupling
 * entirely, so the test collects everywhere without any sync step.
 *
 * The schema (types) and the validator are the SINGLE source of
 * truth; the indexer's own handler is the independent counterpart
 * that release.test.ts cross-checks against for parity.
 */

export type {
	ReleaseHashManifest,
	ReleaseEndpoints,
	ReleaseTreasuryBlock,
	ReleaseDistributionBlock,
	ReleasePayloadV1
} from './release.js';

export {
	validateReleasePayload,
	validateTreasury,
	validateDistribution
} from './releaseValidate.js';

export type {
	ReleaseValidateError,
	ReleaseValidateResult
} from './releaseValidate.js';

export { checkPinnedKeyInAuthority } from './releaseTrustAnchor.js';

// v1.20.0 (MK-H2) — per-order BTC fee addresses derived from the pinned
// treasury account xpub. One implementation for the validator, the indexer
// and the browser, so they agree byte-for-byte on every address.
export {
	parseAccountXpub,
	deriveBtcFeeAddress,
	deriveChildXpub,
	p2wpkhAddress,
	BTC_FEE_MAX_INDEX
} from './btcXpub.js';
export type { AccountXpub, XpubParseError } from './btcXpub.js';
export type { PubkeyAuthorityCheck } from './releaseTrustAnchor.js';

// v1.20.0 (MK-H2) — bound XMR fees: integrated address = pinned treasury
// primary address + a payment ID derived from the order (account/permlink).
export {
	moneroBase58Encode,
	moneroBase58Decode,
	parseXmrAddress,
	parseXmrPrimaryAddress,
	xmrFeePaymentId,
	xmrIntegratedAddress,
	xmrPrimaryFromIntegrated
} from './xmrAddress.js';
export type { XmrAddressParts, XmrAddressError, XmrPrimaryError } from './xmrAddress.js';
