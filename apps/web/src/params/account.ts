/**
 * SvelteKit route matcher: valid Blurt account name.
 *
 * Used in `routes/@[x+40][account=account]/` to ensure the profile
 * route only fires for strings that actually look like Blurt account
 * names. An invalid param returns false and SvelteKit renders a 404,
 * rather than us hitting the indexer with junk.
 *
 * The charset + length mirrors:
 *   - the indexer handler's ACCOUNT_NAME_RE
 *   - the broadcast op-builders' client-side check
 *   - Graphene's own account-name constraints
 *
 * Single source of truth for account-name shape would be nicer, but
 * this file runs at build/route-resolution time on the server too,
 * and the existing checks are embedded in modules that pull in heavy
 * deps. A three-line regex here is cheaper than refactoring.
 */

import type { ParamMatcher } from '@sveltejs/kit';

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

export const match: ParamMatcher = (param) => ACCOUNT_NAME_RE.test(param);
