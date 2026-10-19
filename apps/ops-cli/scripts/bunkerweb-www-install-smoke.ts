/**
 * bunkerweb-www-install-smoke (v1.21.11).
 *
 * What a fresh install gets for www.<domain>, rendered the way the playbook
 * renders it (Jinja2 with Ansible's trim_blocks, group_vars + the wizard's
 * vars), and read the way Docker Compose reads an env file:
 *  - a site's own domain (vigilante.trading): SERVER_NAME is the domain, then
 *    www; the single-quoted rule sends www to the domain; the certificate path
 *    names the domain; and the upgrade heal finds nothing to change in it;
 *  - a subdomain (morphit.timeapp.foundation): no www anywhere;
 *  - a v1.21.10 install, healed, reads like a fresh one;
 *  - the tls role asks for both names, then the domain alone if refused, under
 *    the domain's certificate name; the BunkerWeb role's renewal for an old
 *    certbot keeps every name (no -d list);
 *  - the install wizard's vars carry the www name only for a site's own domain.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAnsibleTasks, renderAnsibleTemplate, repoPath } from './ansible-template-render.ts';
import { envValues } from '../src/lib/bunkerwebPrivacy.ts';
import {
	planWwwEnv,
	WWW_REDIRECT_KEY,
	wwwAliasFor,
	wwwRedirectConf
} from '../src/lib/bunkerwebWww.ts';
import { buildAnsibleVars, type AnsibleInstallInputs } from '../src/init/ansibleVars.ts';

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

const TPL = 'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2';
const ONION = `${'a'.repeat(56)}.onion`;
const render = (domain: string): string =>
	renderAnsibleTemplate(TPL, {
		morphit_domain: domain,
		morphit_www_alias: wwwAliasFor(domain) ?? '',
		morphit_instance_tor_address: ONION
	});

/** The env as `docker compose config` reads it, when this machine has Compose
 *  (null otherwise; envValues follows Compose's rules and is checked always). */
function compose(text: string): Record<string, string> | null {
	const dir = mkdtempSync(join(tmpdir(), 'www-compose-'));
	try {
		writeFileSync(join(dir, 'bunkerweb.env'), text);
		writeFileSync(
			join(dir, 'compose.yml'),
			'services:\n  bunkerweb:\n    image: bunkerity/bunkerweb:1.5.10\n    env_file:\n      - ./bunkerweb.env\n'
		);
		const r = spawnSync(
			'docker',
			['compose', '-f', join(dir, 'compose.yml'), 'config', '--format', 'json'],
			{ encoding: 'utf8', timeout: 30_000 }
		);
		if (r.status !== 0 || r.error) return null;
		const e = JSON.parse(r.stdout).services.bunkerweb.environment as Record<string, string>;
		// `config` prints a literal $ as $$ (its output is a compose file).
		return Object.fromEntries(
			Object.entries(e).map(([k, v]) => [k, String(v).replace(/\$\$/g, '$')])
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log('\n── bunkerweb-www-install ───────────────────────────────\n');

// A site's own domain.
{
	const D = 'vigilante.trading';
	const W = 'www.vigilante.trading';
	const t = render(D);
	const v = envValues(t);
	check(
		'own domain: SERVER_NAME is the domain, then www (and the next line is intact)',
		v.get('SERVER_NAME') === `${D} ${W}` && v.get('SERVER_TYPE') === 'http',
		`${v.get('SERVER_NAME')} / ${v.get('SERVER_TYPE')}`
	);
	check(
		'own domain: the rule, single-quoted, sends www to https://<domain> with the same path',
		v.get(WWW_REDIRECT_KEY) === wwwRedirectConf(D) &&
			t.includes(`${WWW_REDIRECT_KEY}='if ($host = ${W}) { return 301 https://${D}$request_uri; }'`)
	);
	check(
		'own domain: the certificate files are the domain’s',
		v.get('CUSTOM_SSL_CERT') === `/etc/letsencrypt/live/${D}/fullchain.pem` &&
			v.get('CUSTOM_SSL_KEY') === `/etc/letsencrypt/live/${D}/privkey.pem`
	);
	check(
		'own domain: the upgrade heal finds nothing to change in a fresh install',
		planWwwEnv(t, { domain: D, alias: W }).changes.length === 0
	);
	const old = renderAnsibleTemplate(TPL, {
		morphit_domain: D,
		morphit_instance_tor_address: ONION
	});
	check(
		'a v1.21.10 install (no www var): the domain alone, no rule',
		envValues(old).get('SERVER_NAME') === D && !envValues(old).has(WWW_REDIRECT_KEY)
	);
	const healed = envValues(planWwwEnv(old, { domain: D, alias: W }).text);
	check(
		'a v1.21.10 install, healed, has what a fresh install has',
		healed.get('SERVER_NAME') === v.get('SERVER_NAME') &&
			healed.get(WWW_REDIRECT_KEY) === v.get(WWW_REDIRECT_KEY)
	);
	const c = compose(t);
	if (c !== null)
		check(
			'docker compose reads the same values ($host and $request_uri kept)',
			c.SERVER_NAME === v.get('SERVER_NAME') &&
				c[WWW_REDIRECT_KEY] === v.get(WWW_REDIRECT_KEY) &&
				c.CUSTOM_SSL_CERT === v.get('CUSTOM_SSL_CERT'),
			JSON.stringify([c.SERVER_NAME, c[WWW_REDIRECT_KEY], c.CUSTOM_SSL_CERT])
		);
	check(
		'the Onion-Location header names the onion with no $variable (BunkerWeb sends it as written)',
		v.get('CUSTOM_HEADER') === `Onion-Location: http://${ONION}`,
		v.get('CUSTOM_HEADER')
	);
}

// A subdomain.
{
	const D = 'morphit.timeapp.foundation';
	const t = render(D);
	const v = envValues(t);
	check(
		'subdomain: SERVER_NAME is the domain alone, no rule, no www anywhere',
		v.get('SERVER_NAME') === D &&
			!v.has(WWW_REDIRECT_KEY) &&
			!t
				.split('\n')
				.filter((l) => !/^\s*#/.test(l))
				.some((l) => l.includes('www.')),
		v.get('SERVER_NAME')
	);
}

// The tls role (a fresh box: no certificate yet, Let's Encrypt reachable,
// BunkerWeb on port 80).
{
	const tasks = (vars: Record<string, unknown>) =>
		renderAnsibleTasks('ops/ansible/roles/tls/tasks/main.yml', {
			morphit_repo_path: '/opt/morphit',
			tls_acme_email: 'ops@example.org',
			tls_certbot_server: 'https://acme-v02.api.letsencrypt.org/directory',
			tls_cert_stat: { stat: { exists: false } },
			tls_acme_probe: { status: 200 },
			tls_port80: { stdout: 'LISTEN 0 4096 0.0.0.0:80' },
			...vars
		});
	const cmd = (t: { task: Record<string, unknown> } | undefined) =>
		String((t?.task['ansible.builtin.command'] as { cmd?: string } | undefined)?.cmd ?? '')
			.replace(/\s+/g, ' ')
			.trim();
	const own = { morphit_domain: 'vigilante.trading', morphit_www_alias: 'www.vigilante.trading' };
	const first = tasks(own).find((t) => /^Request initial cert \(/.test(t.name));
	check(
		'tls role: the first request is for the domain alone, under its certificate name (a failure costs the domain one check)',
		first?.skip === false &&
			/--webroot --webroot-path \/opt\/morphit\/apps\/web\/build/.test(cmd(first)) &&
			/--cert-name vigilante\.trading -d vigilante\.trading$/.test(cmd(first)),
		cmd(first)
	);
	const wwwAfter = (rc: number) =>
		tasks({ ...own, tls_certbot_result: { rc } }).find((t) => /Add www/.test(t.name));
	check(
		'tls role: then www added to the same certificate — only once the domain has its own',
		wwwAfter(0)?.skip === false &&
			/--cert-name vigilante\.trading -d vigilante\.trading -d www\.vigilante\.trading$/.test(
				cmd(wwwAfter(0))
			) &&
			wwwAfter(1)?.skip === true,
		cmd(wwwAfter(0))
	);
	const sub = tasks({
		morphit_domain: 'morphit.timeapp.foundation',
		morphit_www_alias: '',
		tls_certbot_result: { rc: 0 }
	});
	const subFirst = sub.find((t) => /^Request initial cert \(/.test(t.name));
	check(
		'tls role, subdomain: one request for the domain, no www request',
		subFirst?.skip === false &&
			/-d morphit\.timeapp\.foundation$/.test(cmd(subFirst)) &&
			sub.find((t) => /Add www/.test(t.name))?.skip === true,
		cmd(subFirst)
	);
}

// The BunkerWeb role's renewal for certbot older than 2.3 (the command the
// task runs, read from the role with Python's YAML loader, as Ansible does).
{
	const r = spawnSync(
		'python3',
		[
			'-c',
			`import yaml,json,sys
for t in yaml.safe_load(open(sys.argv[1])):
    for b in (t.get('block') or []):
        if 'older than 2.3' in b.get('name',''):
            print(b['ansible.builtin.command']['cmd'])`,
			repoPath('ops/ansible/roles/bunkerweb/tasks/main.yml')
		],
		{ encoding: 'utf8' }
	);
	const c = (r.stdout ?? '').replace(/\s+/g, ' ').trim();
	check(
		'BunkerWeb role: the old-certbot renewal names the certificate, not a -d list (www kept)',
		/certbot certonly .*--cert-name \{\{ morphit_domain \}\}/.test(c) && !/ -d /.test(c),
		c || (r.stderr ?? '')
	);
}

// The install wizard's vars.
{
	const inputs = (over: Partial<AnsibleInstallInputs>): AnsibleInstallInputs =>
		({
			mode: 'vps',
			torOnly: false,
			domain: 'vigilante.trading',
			instanceName: 'Morphit Test',
			operatorAccount: 'opacct',
			operatorTag: 'optag',
			feesAccount: 'feesacct',
			keystorePath: '/etc/morphit/relay.keystore',
			indexerDbPassword: 'x'.repeat(32),
			acmeEmail: 'ops@example.org',
			...over
		}) as AnsibleInstallInputs;
	check(
		'vars: www for a site’s own domain, none for a subdomain or a tor-only node',
		buildAnsibleVars(inputs({})).morphit_www_alias === 'www.vigilante.trading' &&
			buildAnsibleVars(inputs({ domain: 'morphit.timeapp.foundation' })).morphit_www_alias === '' &&
			buildAnsibleVars(inputs({ torOnly: true, domain: '' })).morphit_www_alias === ''
	);
}

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} bunkerweb-www-install checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} bunkerweb-www-install checks failed`);
process.exit(1);
