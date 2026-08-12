#!/usr/bin/env tsx
/**
 * offline-account-lookup-smoke (cp709).
 *
 * The wizard's relay-account step looks the account up on Blurt to
 * catch typos.  On a deliberately-offline / air-gapped install there
 * is no internet — the lookup fails with a connectivity error, which
 * is EXPECTED (the wizard needs no network; the node self-verifies the
 * account the first time it comes online).  Before cp709 the operator
 * saw an alarming "⚠ Could not reach any Blurt RPC (fetch failed)"
 * that read like a setup failure.
 *
 * describeAccountLookupFailure now returns a calm ℹ message for the
 * no-connectivity case and keeps the specific ⚠ line for any other
 * error.  This smoke locks that:
 *   - the exact strings an offline install produces classify as
 *     offline (calm ℹ, no scary "⚠"), and
 *   - a genuine non-connectivity error keeps the ⚠ + the (sanitized)
 *     detail so a real misconfiguration stays visible.
 */

import { describeAccountLookupFailure } from '../src/init/steps.ts';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string): void {
	if (cond) {
		passed++;
	} else {
		failed++;
		console.error(`  ✗ ${label}`);
	}
}

const NAME = 'my-morphit-relay';

// The messages a real offline install actually produces.
const OFFLINE_MESSAGES = [
	'Could not reach any Blurt RPC endpoint.  Last error: fetch failed',
	'Could not reach any Blurt RPC endpoint.  Last error: getaddrinfo ENOTFOUND api.blurt.blog',
	'fetch failed',
	'connect ECONNREFUSED 127.0.0.1:443',
	'request to https://rpc.example timed out (ETIMEDOUT)',
	'network error'
];

for (const msg of OFFLINE_MESSAGES) {
	const d = describeAccountLookupFailure(NAME, msg);
	ok(d.offline === true, `offline-classified: ${msg}`);
	const joined = d.lines.join('\n');
	ok(!joined.includes('\u26a0'), `no scary ⚠ for offline: ${msg}`);
	ok(joined.includes('\u2139'), `calm ℹ present for offline: ${msg}`);
	ok(joined.includes('first time it comes online'), `reassurance present: ${msg}`);
	ok(joined.includes(`@${NAME}`), `names the account: ${msg}`);
}

// Genuine non-connectivity errors keep the specific ⚠ line.
const REAL_ERRORS = [
	'HTTP 500 from https://rpc.example',
	'RPC error: {"code":-32000,"message":"bad request"}'
];
for (const msg of REAL_ERRORS) {
	const d = describeAccountLookupFailure(NAME, msg);
	ok(d.offline === false, `non-offline-classified: ${msg}`);
	const joined = d.lines.join('\n');
	ok(joined.includes('\u26a0'), `keeps ⚠ for real error: ${msg}`);
	ok(joined.includes('Could not check'), `keeps specific line: ${msg}`);
}

// Dangerous non-SGR control bytes are stripped (SGR colour codes are
// intentionally preserved by sanitizeForTerm; a BEL / OSC title-set is
// not).  The raw message is attacker-influenceable RPC body text.
{
	const d = describeAccountLookupFailure(NAME, 'HTTP 500 \u0007\u001b]0;pwned\u0007 body');
	const joined = d.lines.join('\n');
	ok(!joined.includes('\u0007'), 'strips BEL control byte');
	ok(!joined.includes('\u001b]'), 'strips OSC escape introducer');
}

// The offline path must still let the operator proceed: it returns
// lines only (no throw), and the caller defaults "use anyway" to yes.
{
	const d = describeAccountLookupFailure(NAME, 'fetch failed');
	ok(d.lines.length >= 1, 'offline path yields printable lines');
}

console.log('');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('✗ offline-account-lookup smoke failed');
	process.exit(1);
}
console.log(`✓ all ${passed} offline-account-lookup scenarios pass`);
