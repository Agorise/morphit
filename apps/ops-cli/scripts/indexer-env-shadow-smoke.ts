/**
 * indexer-env-shadow-smoke.
 *
 * /etc/morphit/indexer.env is read after morphit.config.env, so any key it
 * sets wins. Rendered from the real template with group_vars: a default
 * install must not set the asset / payment-method policy there (an empty line
 * silently undid the operator's choice in morphit.config.env). A value set in
 * group_vars reaches the indexer through morphit.config.env, where
 * `morphit-ops edit` keeps it.
 */
import { parseEnvText, renderAnsibleTemplate } from './ansible-template-render.ts';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};
const TPL = 'ops/ansible/roles/morphit/templates/indexer.env.j2';
const KEYS = ['MORPHIT_INDEXER_DISABLED_ASSETS', 'MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS'];
const plain = parseEnvText(renderAnsibleTemplate(TPL));
for (const k of KEYS)
	check(
		`a default install does not set ${k} in indexer.env`,
		!plain.has(k),
		`${k}=${plain.get(k)}`
	);
const vars = {
	morphit_indexer_disabled_assets: 'USDT',
	morphit_indexer_disabled_payment_methods: 'barter_goods'
};
const set = parseEnvText(renderAnsibleTemplate(TPL, vars));
check(
	'values set in group_vars are not written to indexer.env either',
	KEYS.every((k) => !set.has(k))
);
const cfg = parseEnvText(
	renderAnsibleTemplate('ops/ansible/roles/morphit/templates/morphit.config.env.j2', vars)
);
check(
	'they reach the indexer through morphit.config.env (the file `morphit-ops edit` writes)',
	cfg.get(KEYS[0]!) === 'USDT' && cfg.get(KEYS[1]!) === 'barter_goods',
	JSON.stringify([cfg.get(KEYS[0]!), cfg.get(KEYS[1]!)])
);
const cfgPlain = parseEnvText(
	renderAnsibleTemplate('ops/ansible/roles/morphit/templates/morphit.config.env.j2')
);
check(
	'unset in group_vars: morphit.config.env does not set them (no empty line)',
	KEYS.every((k) => !cfgPlain.has(k))
);
console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} indexer-env-shadow checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} indexer-env-shadow checks failed`);
process.exit(1);
