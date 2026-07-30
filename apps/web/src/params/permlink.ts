/**
 * SvelteKit route matcher: Blurt-style permlink.
 *
 * Used in `routes/@[x+40][account=account]/[permlink=permlink]/` so
 * the order-detail route only fires for strings that look like real
 * Morphit permlinks. An invalid param 404s.
 *
 * The charset matches:
 *   - the indexer handler's PERMLINK_RE
 *   - the client-side makeOrderPermlink charset in payload.ts
 *
 * Length cap of 32 mirrors the indexer's permlink_bad_length check.
 */

import type { ParamMatcher } from '@sveltejs/kit';

const PERMLINK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const match: ParamMatcher = (param) =>
	param.length >= 1 && param.length <= 32 && PERMLINK_RE.test(param);
