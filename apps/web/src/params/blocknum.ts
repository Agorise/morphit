/**
 * SvelteKit route matcher: positive integer block number.
 *
 * Used in `routes/explorer/block/[num=blocknum]/` so the route
 * only fires for numeric inputs.  Anything else returns 404
 * rather than hitting RPC with garbage.
 */

import type { ParamMatcher } from '@sveltejs/kit';

const POSITIVE_INT_RE = /^[1-9][0-9]{0,18}$/;

export const match: ParamMatcher = (param) => POSITIVE_INT_RE.test(param);
