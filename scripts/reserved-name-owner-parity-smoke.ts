#!/usr/bin/env tsx
/**
 * reserved-name-owner-parity — v1.8.10 (Ken, t.txt).
 *
 * THE BUG THIS EXISTS TO CATCH. `agorise` and `kencode` are reserved names, and
 * the impersonation guard is SUBSTRING-based with only a byte-equality escape.
 * So the rightful owner of those accounts could set their display name to
 * exactly `agorise` — and nothing else. Not `Agorise` (merely capitalised), not
 * `@agorise`, not `Ken @ Agorise`. Ken hit this on his own two accounts:
 * "if i successfully sign in with my @kencode or @agorise accounts, then i want
 * to be able to ... use one or both of those terms anywhere on the site".
 *
 * The fix exempts the SIGNER on their OWN reserved name. Impersonation means
 * claiming to be someone you are not, so the one account for which the claim is
 * true cannot be impersonating. The exemption is keyed on the chain-
 * authenticated signer (`extractSigner`), so it cannot be asserted by anyone
 * else, and it is scoped to the specific reserved name that signer holds.
 *
 * WHY PARITY MATTERS. The rule lives in TWO places by design — the indexer
 * enforces it against the chain-authenticated signer (the authority), and the
 * frontend mirrors it so the FORM does not reject something the chain would
 * accept. If the two drift, the user meets one of two bad outcomes: a form that
 * blocks a legal name, or a form that accepts a name the chain will reject
 * after they hit broadcast. Both were the status quo before this fix.
 *
 * Tamper tests (each must turn this red):
 *   - Drop `ownsReservedName` from either side → parity check fails.
 *   - Remove the exemption from the indexer's validate() → wiring check fails.
 *   - Let the exemption ignore the signer (always true) → the narrowness
 *     checks fail.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const WEB_CONF = join(REPO, 'apps/web/src/lib/crypto/confusables.ts');
const IDX_CONF = join(REPO, 'apps/indexer/src/indexer/confusables.ts');
const IDX_PROFILE = join(REPO, 'apps/indexer/src/indexer/handlers/profile.ts');
const WEB_PROFILE = join(REPO, 'apps/web/src/lib/crypto/profile.ts');
const SETTINGS = join(REPO, 'apps/web/src/routes/[lang]/settings/+page.svelte');

const read = (p: string): string => readFileSync(p, 'utf8');
const webConf = read(WEB_CONF);
const idxConf = read(IDX_CONF);
const idxProfile = read(IDX_PROFILE);
const webProfile = read(WEB_PROFILE);
const settings = read(SETTINGS);

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── reserved-name-owner-parity (v1.8.10) ──────────────\n');

/** The reserved list, extracted from a RESERVED_NAMES_RAW block. */
const reservedFrom = (src: string): string[] => {
	const block = /RESERVED_NAMES_RAW: readonly string\[\] = \[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
	return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
};

const webNames = reservedFrom(webConf);
const idxNames = reservedFrom(idxConf);
check('the frontend declares a reserved-name list', webNames.length > 0);
check('the indexer declares a reserved-name list', idxNames.length > 0);
check(
	`both lists are identical (${idxNames.length} names)`,
	webNames.length === idxNames.length && webNames.every((n, i) => n === idxNames[i]),
	`web=[${webNames.join(',')}] indexer=[${idxNames.join(',')}]`
);
check(
	"Ken's two accounts are in the list (the case that prompted this)",
	idxNames.includes('agorise') && idxNames.includes('kencode'),
	'if these ever leave the list the exemption is moot, but so is the guard'
);

// ─── both sides implement the exemption ──────────────────────────
for (const [label, src] of [
	['frontend', webConf],
	['indexer', idxConf]
] as const) {
	check(
		`the ${label} exports ownsReservedName`,
		/export function ownsReservedName\(signer: string, input: string\): boolean/.test(src),
		'without it the rightful owner is blocked from their own name'
	);
	const body =
		/export function ownsReservedName\([^)]*\): boolean \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
	check(
		`the ${label} exemption is keyed on the SIGNER, not the input alone`,
		/signer\.toLowerCase\(\)/.test(body) && /lower !== raw/.test(body),
		'an exemption that ignores who is asking would disable the guard for everyone'
	);
	check(
		`the ${label} exemption is scoped to the reserved name that signer holds`,
		/compileReservedRegex\(raw\)/.test(body),
		'@kencode must get no latitude on "morphit-fees"'
	);
}

// ─── the indexer actually USES it, against the chain-auth signer ─
check(
	'the indexer validator takes the signer',
	/function validate\(payload: unknown, signer: string\)/.test(idxProfile),
	'the check is worthless if the validator cannot see who signed'
);
check(
	'the indexer passes the CHAIN-AUTHENTICATED signer, not a payload field',
	/validate\(ctx\.payload, ctx\.signer\)/.test(idxProfile),
	'ctx.signer comes from extractSigner; anything from the payload is attacker-controlled'
);
check(
	'the indexer exempts the owner before rejecting for impersonation',
	/!ownsReservedName\(signer, trimmed\) && impersonatesReservedName\(trimmed\)/.test(idxProfile),
	'the guard must be skipped for the owner, not merely computed'
);

// ─── the frontend mirrors it so the form agrees with the chain ───
check(
	'the frontend validator accepts an optional signer',
	/export function validateDisplayName\(raw: string, signer\?: string\)/.test(webProfile),
	'callers that know the account must be able to say so'
);
check(
	'the frontend exempts the owner the same way',
	/ownsReservedName\(signer, s\)\) && impersonatesReservedName\(s\)/.test(webProfile),
	'a stricter form than the chain rejects names the chain would accept'
);
check(
	'an unknown/signed-out session still gets the STRICT behaviour',
	/signer !== undefined && ownsReservedName/.test(webProfile),
	'a missing signer must not be treated as "exempt"'
);
check(
	'the settings form passes the signed-in account',
	/validateDisplayName\(input, getUserBlurtAccount\(\) \?\? undefined\)/.test(settings),
	'without this the owner still sees the form reject their own name'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} reserved-name-owner-parity checks passed` : '✗ reserved-name-owner-parity FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
