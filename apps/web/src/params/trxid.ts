/**
 * SvelteKit route matcher: Blurt transaction id (40 hex chars).
 *
 * Used in `routes/explorer/tx/[id=trxid]/`.
 */

import type { ParamMatcher } from '@sveltejs/kit';

const TRXID_RE = /^[0-9a-f]{40}$/;

export const match: ParamMatcher = (param) => TRXID_RE.test(param);
