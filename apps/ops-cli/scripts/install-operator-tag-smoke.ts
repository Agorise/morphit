/**
 * install-operator-tag smoke (review B1).
 *
 * The guided install must never bake a reserved / invalid operator tag as the
 * earnings tag. Defaulting it to the relay ACCOUNT name drifted a reinstall onto
 * `morphit-relay`, which the on-chain register rejects (tag_reserved) so the
 * relay attributed NO earnings — a silent, doomed install. Two behaviours are
 * pinned, against the REAL functions (not a source regex):
 *   1. validateInstallInputs REJECTS a reserved / look-alike / malformed tag.
 *   2. resolveOperatorTag never RETURNS a reserved tag — it derives a valid one
 *      from the domain (or a neutral placeholder), so the common case installs
 *      with a working tag.
 */
import {
	validateInstallInputs,
	resolveOperatorTag,
	type AnsibleInstallInputs
} from '../src/init/ansibleVars.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}`);
	}
};

const base = (over: Partial<AnsibleInstallInputs>): AnsibleInstallInputs => ({
	mode: 'vps',
	torOnly: false,
	domain: 'trade.example.com',
	instanceName: 'Example Market',
	operatorAccount: 'alice',
	operatorTag: 'trade.example.com',
	acmeEmail: 'a@b.co',
	autoRegister: false,
	indexerDbPassword: 'x'.repeat(24),
	feesAccount: 'alice',
	keystorePath: '/etc/morphit/keystore.json',
	...over
});

const has = (inp: AnsibleInstallInputs, needle: string): boolean =>
	validateInstallInputs(inp).some((p) => p.toLowerCase().includes(needle));

// 1. A clean tag passes.
check('valid domain tag passes validation', validateInstallInputs(base({})).length === 0);
// 2. The exact drift value is rejected.
check(
	'reserved relay account name is rejected as a tag',
	has(base({ operatorTag: 'morphit-relay' }), 'operator tag')
);
check('bare reserved brand rejected', has(base({ operatorTag: 'morphit' }), 'operator tag'));
check('look-alike (morphit-io) rejected', has(base({ operatorTag: 'morphit-io' }), 'operator tag'));
check('bad charset rejected', has(base({ operatorTag: 'My Tag!' }), 'operator tag'));
check('empty tag rejected', has(base({ operatorTag: '' }), 'operator tag'));

// 3. resolveOperatorTag never yields a reserved tag.
check(
	'resolve replaces the reserved relay name with the ordinary domain',
	resolveOperatorTag('morphit-relay', 'trade.example.com') === 'trade.example.com'
);
check(
	'resolve keeps a valid proposal',
	resolveOperatorTag('trade.example.com', 'trade.example.com') === 'trade.example.com'
);
check(
	'resolve of reserved + no domain → neutral placeholder, still valid',
	(() => {
		const t = resolveOperatorTag('morphit-relay', '');
		return t === 'independent-node' && validateInstallInputs(base({ operatorTag: t })).length === 0;
	})()
);
// Even a domain that itself LOOKS reserved (morphit.io) must not yield a reserved
// tag — it falls back to the neutral placeholder, and the operator sets the real
// tag with `morphit-ops edit` → register (the canonical box owns the name on-chain).
check(
	'resolve output is never reserved (morphit-relay in, morphit.io domain)',
	validateInstallInputs(base({ operatorTag: resolveOperatorTag('morphit-relay', 'morphit.io') }))
		.length === 0
);

console.log(
	fail === 0
		? `✓ all ${pass} install-operator-tag checks hold`
		: `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
