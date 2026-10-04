/**
 * bunkerweb-privacy-settings-smoke.
 *
 * What a fresh BunkerWeb node really runs with — the Ansible template RENDERED
 * with the wizard's variables, and the manual example as an operator copies it
 * — read the way BunkerWeb 1.5.10 reads it: a key that is absent takes
 * BunkerWeb's default (the table in src/lib/bunkerwebPrivacy.ts, from the
 * 1.5.10 sources; this smoke also checks that 1.5.10 is the version pinned).
 *
 * Fails when any feature that sends something about a visitor off the box is
 * effectively on (BunkerNet, DNSBL, the reverse-DNS black/white/grey lists,
 * the anonymous report), when anti-bot is third-party or on a live path, when
 * the two files disagree on a security-relevant setting, or when the manual
 * compose lacks what the template's compose has for the scheduler and the
 * hidden services (Docker socket, Let's Encrypt mount, 127.0.0.1:8090).
 */
import { readFileSync } from 'node:fs';
import {
	BUNKERWEB_PRIVACY_SETTINGS,
	effectiveSetting,
	planBunkerwebPrivacy
} from '../src/lib/bunkerwebPrivacy.ts';
import { parseEnvText, renderAnsibleTemplate, repoPath } from './ansible-template-render.ts';

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

const wizard = {
	morphit_domain: 'trade.example.org',
	morphit_instance_tor_address: 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz234567.onion'
};
const files: Array<[string, string]> = [
	[
		'Ansible template (rendered)',
		renderAnsibleTemplate('ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2', wizard)
	],
	['manual example', readFileSync(repoPath('ops/bunkerweb/bunkerweb.env.example'), 'utf8')]
];

// ── the defaults table applies to the pinned image ──────────────────────
const gv = readFileSync(repoPath('ops/ansible/group_vars/all.yml'), 'utf8');
const manualCompose = readFileSync(repoPath('ops/bunkerweb/docker-compose.yml'), 'utf8');
check(
	'the BunkerWeb image pinned in group_vars and the manual compose is 1.5.10 (the defaults table)',
	/^bunkerweb_image:\s*bunkerity\/bunkerweb:1\.5\.10\b/m.test(gv) &&
		/^bunkerweb_scheduler_image:\s*bunkerity\/bunkerweb-scheduler:1\.5\.10\b/m.test(gv) &&
		[...manualCompose.matchAll(/image:\s*bunkerity\/bunkerweb(?:-scheduler)?:(\S+)/g)].every((m) =>
			/^1\.5\.10\b/.test(m[1]!)
		)
);

for (const [label, text] of files) {
	const env = parseEnvText(text);
	for (const s of BUNKERWEB_PRIVACY_SETTINGS)
		check(
			`${label}: ${s.key} is effectively ${s.value}`,
			effectiveSetting(env, s.key) === s.value,
			`BunkerWeb would run ${s.key}=${effectiveSetting(env, s.key)}`
		);
	check(
		`${label}: the heal has nothing to change (a fresh install = a healed one)`,
		planBunkerwebPrivacy(text).changes.length === 0,
		planBunkerwebPrivacy(text).changes.join('; ')
	);
	const antibot = effectiveSetting(env, 'USE_ANTIBOT');
	check(`${label}: no site-wide anti-bot challenge`, antibot === 'no', `USE_ANTIBOT=${antibot}`);
	check(
		`${label}: no ASN block (it needs the blacklist plugin and turns away VPN users)`,
		!env.has('BLACKLIST_ASN')
	);
	check(
		`${label}: no setting BunkerWeb 1.5.10 does not have (USE_BLOCK_REFERRER_NONE, BUNKERWEB_INSTANCES)`,
		!env.has('USE_BLOCK_REFERRER_NONE') &&
			!env.has('BLOCK_REFERRER_NONE_URL') &&
			!env.has('BUNKERWEB_INSTANCES')
	);
}

// ── the manual example says what the template says, where it matters ───
const SECURITY_KEYS = [
	'USE_REAL_IP',
	'API_WHITELIST_IP',
	'REVERSE_PROXY_HOST',
	'USE_MODSECURITY',
	'USE_MODSECURITY_CRS',
	'MODSECURITY_CRS_VERSION',
	'CUSTOM_CONF_MODSEC_morphit_json_api_off',
	'MAX_CLIENT_SIZE',
	'USE_LIMIT_REQ',
	'LIMIT_REQ_URL_1',
	'LIMIT_REQ_RATE_1',
	'LIMIT_REQ_URL_2',
	'LIMIT_REQ_RATE_2',
	'USE_BAD_BEHAVIOR',
	'BAD_BEHAVIOR_STATUS_CODES',
	'BAD_BEHAVIOR_THRESHOLD',
	'BAD_BEHAVIOR_COUNT_TIME',
	'BAD_BEHAVIOR_BAN_TIME',
	'DISABLE_DEFAULT_SERVER',
	'SERVER_TOKENS',
	'USE_ANTIBOT',
	'CONTENT_SECURITY_POLICY',
	'REFERRER_POLICY',
	'X_FRAME_OPTIONS',
	'PERMISSIONS_POLICY',
	'LOG_FORMAT',
	...BUNKERWEB_PRIVACY_SETTINGS.map((s) => s.key)
];
{
	const a = parseEnvText(files[0]![1]);
	const b = parseEnvText(files[1]![1]);
	for (const k of SECURITY_KEYS)
		check(
			`manual example = template: ${k}`,
			a.get(k) === b.get(k),
			`template ${a.get(k) ?? '(unset)'} vs example ${b.get(k) ?? '(unset)'}`
		);
}

// ── the manual compose has what the template's compose has ──────────────
const templateCompose = renderAnsibleTemplate(
	'ops/ansible/roles/bunkerweb/templates/docker-compose.yml.j2',
	{ ...wizard, bunkerweb_docker_gid: '999', morphit_repo_path: '/opt/morphit' }
);
const serviceBlock = (text: string, name: string): string =>
	new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z_-]+:\\n|\\n[A-Za-z]|$)`).exec(
		text
	)?.[1] ?? '';
for (const [label, text] of [
	['template compose', templateCompose],
	['manual compose', manualCompose]
] as const) {
	const sched = serviceBlock(text, 'bunkerweb-scheduler');
	check(
		`${label}: the scheduler mounts the Docker socket read-only (BunkerWeb 1.5 finds the instance through it)`,
		/- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/.test(sched) && /group_add:/.test(sched)
	);
	check(
		`${label}: the scheduler mounts the Let's Encrypt certificates read-only`,
		/- \/etc\/letsencrypt:\/etc\/letsencrypt:ro/.test(sched)
	);
	check(
		`${label}: the frontend is published on loopback only, for the Tor and I2P services`,
		/- "127\.0\.0\.1:(?:\{\{[^}]*\}\}|8090):80"/.test(text) &&
			!/^\s*- "(?:0\.0\.0\.0:)?\d+:80"$/m.test(serviceBlock(text, 'frontend'))
	);
}

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} bunkerweb-privacy-settings checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} bunkerweb-privacy-settings checks failed`);
process.exit(1);
