/**
 * ansible-vars-smoke.ts (cp600) — pins the PURE wizard↔Ansible bridge
 * (apps/ops-cli/src/init/ansibleVars.ts).  The actual `ansible-playbook` run is
 * Beelink-validated, but the var MAPPING + the local-run argv + the DB-password
 * generation must stay correct — a wrong var name or a missing `enable_ddns`
 * silently breaks a grandma install deep into the playbook.
 */
import {
	randomSecret,
	validateInstallInputs,
	buildAnsibleVars,
	renderVarsFile,
	buildAnsiblePlaybookArgv,
	type AnsibleInstallInputs
} from '../apps/ops-cli/src/init/ansibleVars.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

console.log('\u2500\u2500 ansible-vars smoke (cp600) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

const home: AnsibleInstallInputs = {
	mode: 'home',
	domain: 'trade.example.com',
	operatorAccount: 'my-operator',
	operatorTag: 'myoperator',
	feesAccount: 'my-operator',
	keystorePath: '/etc/morphit/relay.keystore',
	acmeEmail: 'me@example.com',
	indexerDbPassword: randomSecret(),
	relayDbPassword: randomSecret(),
	ddnsUpdateUrl: 'https://njal.la/update/?h=trade.example.com&k=KEY&a={ip}'
};
const vps: AnsibleInstallInputs = {
	mode: 'vps',
	domain: 'trade.example.com',
	operatorAccount: 'my-operator',
	operatorTag: 'myoperator',
	feesAccount: 'my-operator',
	keystorePath: '/etc/morphit/relay.keystore',
	acmeEmail: 'me@example.com',
	indexerDbPassword: randomSecret(),
	relayDbPassword: randomSecret()
};

// ── randomSecret ──────────────────────────────────────────────────
check('randomSecret has >= 256 bits of entropy (>= 43 chars; default 48B ~ 64 chars)', randomSecret().length >= 43);
check('randomSecret is URL/shell-safe (base64url charset)', /^[A-Za-z0-9_-]+$/.test(randomSecret()));
check('randomSecret is unique per call', randomSecret() !== randomSecret());

// ── validateInstallInputs ─────────────────────────────────────────
check('valid home inputs → no problems', validateInstallInputs(home).length === 0);
check('valid vps inputs → no problems', validateInstallInputs(vps).length === 0);
check('home WITHOUT a {ip} DDNS url → flagged', validateInstallInputs({ ...home, ddnsUpdateUrl: 'https://njal.la/update?a=1.2.3.4' }).length > 0);
check('a URL passed as domain → flagged (bare domain required)', validateInstallInputs({ ...home, domain: 'https://trade.example.com' }).some((p) => /domain/.test(p)));
check('bad operator account → flagged', validateInstallInputs({ ...home, operatorAccount: 'Bad_Name!' }).some((p) => /operatorAccount/.test(p)));
check('missing email → flagged', validateInstallInputs({ ...home, acmeEmail: 'nope' }).some((p) => /email/i.test(p)));
check('short DB password → flagged', validateInstallInputs({ ...home, indexerDbPassword: 'short' }).some((p) => /DB password/.test(p)));
check('SAME password for both DBs → flagged (must be unique)', validateInstallInputs({ ...home, relayDbPassword: home.indexerDbPassword }).some((p) => /DIFFERENT/i.test(p)));
check('relative keystore path → flagged (must be absolute)', validateInstallInputs({ ...home, keystorePath: 'relay.keystore' }).some((p) => /absolute/i.test(p)));
check('bad fees account → flagged', validateInstallInputs({ ...home, feesAccount: 'Bad_Fees!' }).some((p) => /feesAccount/.test(p)));

// ── buildAnsibleVars: the home/VPS difference ─────────────────────
const hv = buildAnsibleVars(home);
const vv = buildAnsibleVars(vps);
check('home enables DDNS + carries the update URL', hv.enable_ddns === true && hv.morphit_ddns_update_url === home.ddnsUpdateUrl);
check('vps disables DDNS + carries NO update URL', vv.enable_ddns === false && !('morphit_ddns_update_url' in vv));
check('BOTH get the full stack (enable_tls + enable_bunkerweb true)', hv.enable_tls === true && hv.enable_bunkerweb === true && vv.enable_bunkerweb === true);
check('maps domain/operator/tag/acme correctly', hv.morphit_domain === 'trade.example.com' && hv.morphit_operator_account === 'my-operator' && hv.morphit_operator_tag === 'myoperator' && hv.tls_acme_email === 'me@example.com');
check('maps fees account -> morphit_fee_recipient', hv.morphit_fee_recipient === 'my-operator');
check('maps keystore path -> morphit_relay_keystore_path', hv.morphit_relay_keystore_path === '/etc/morphit/relay.keystore');
check('passes DB secrets as vault_ vars', typeof hv.vault_postgres_indexer_password === 'string' && typeof hv.vault_postgres_relay_password === 'string');
check('defaults repo ref to main; honors an override (morphit_repo_ref — matches the playbook)', (buildAnsibleVars(home).morphit_repo_ref === 'main') && (buildAnsibleVars({ ...home, gitRef: 'v1.9.7' }).morphit_repo_ref === 'v1.9.7'));
check('BunkerWeb can be turned off explicitly', buildAnsibleVars({ ...vps, enableBunkerweb: false }).enable_bunkerweb === false);

// ── renderVarsFile: valid + parseable ─────────────────────────────
const rendered = renderVarsFile(hv);
let parsed: Record<string, unknown> | null = null;
try {
	parsed = JSON.parse(rendered);
} catch {
	parsed = null;
}
check('renderVarsFile emits parseable JSON (valid YAML for -e @file)', parsed !== null && parsed.morphit_domain === 'trade.example.com');
check('rendered file ends with a newline', rendered.endsWith('\n'));

// ── buildAnsiblePlaybookArgv: LOCAL run ───────────────────────────
const argv = buildAnsiblePlaybookArgv({ playbookPath: '/opt/morphit/ops/ansible/playbook.yml', varsFilePath: '/run/morphit-install-vars.json' });
check('argv runs against localhost with a LOCAL connection (no SSH)', argv.includes('localhost,') && argv[argv.indexOf('-c') + 1] === 'local');
check('argv points at the playbook + the -e @varsfile', argv.includes('/opt/morphit/ops/ansible/playbook.yml') && argv.includes('@/run/morphit-install-vars.json'));
check('argv adds --check only when requested', !argv.includes('--check') && buildAnsiblePlaybookArgv({ playbookPath: 'p', varsFilePath: 'v', check: true }).includes('--check'));

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} ansible-vars checks passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failed} of ${passed + failed} ansible-vars checks failed`);
	process.exit(1);
}
