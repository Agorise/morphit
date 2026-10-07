import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	LOCAL_IP_BLOCKS_KEY,
	bunkerwebSettingsProblems,
	countryListsInSettings,
	envValues,
	localIpBlockConf,
	planBunkerwebPrivacy
} from '../src/lib/bunkerwebPrivacy.ts';

// An Ansible box as v1.20.2 left it: the blacklist on, with the base
// group_vars' ASN list and an operator's own address blocks.
const OLD = `SERVER_NAME=trade.example.org
USE_BLACKLIST=yes
BLACKLIST_ASN=AS14061 AS24940 AS16276
BLACKLIST_IP=198.51.100.7 203.0.113.0/24 2001:db8::/32 not-an-address
`;

describe('turning BunkerWeb’s blacklist off keeps what can work from local data', () => {
	it('the listed addresses and networks become an nginx deny conf; the rest is named, not silently dropped', () => {
		const p = planBunkerwebPrivacy(OLD);
		const v = envValues(p.text);
		expect(v.get('USE_BLACKLIST')).toBe('no');
		expect(v.get(LOCAL_IP_BLOCKS_KEY)).toBe(
			'deny 198.51.100.7; deny 203.0.113.0/24; deny 2001:db8::/32;'
		);
		// the bad entry and the ASN list: one notice each
		expect(p.notices).toHaveLength(2);
	});
	it('a second run changes nothing (the deny conf is kept, nothing repeated)', () => {
		const once = planBunkerwebPrivacy(OLD).text;
		const twice = planBunkerwebPrivacy(once);
		expect(twice.text).toBe(once);
		expect(twice.changes).toEqual([]);
		expect(twice.notices).toEqual([]);
	});
	it('metrics (the last 100 blocked requests, with addresses and URLs) are turned off', () => {
		expect(envValues(planBunkerwebPrivacy('SERVER_NAME=x\n').text).get('USE_METRICS')).toBe('no');
	});
	it('reads addresses and networks strictly', () => {
		expect(localIpBlockConf('10.0.0.0/8 ::1 1.2.3.4/33 1.2.3.4/8/1 example.org')).toEqual({
			conf: 'deny 10.0.0.0/8; deny ::1;',
			skipped: ['1.2.3.4/33', '1.2.3.4/8/1', 'example.org']
		});
	});
});

// v1.21.1 — no Morphit instance turns visitors away by country: people behind
// national firewalls (China, Iran, North Korea, …) must be able to reach the
// instance of their choice. Country blocks an operator set are removed.
describe('country blocks are removed (no instance blocks by country)', () => {
	const BLOCKED = `SERVER_NAME=trade.example.org
BLACKLIST_COUNTRY=CN IR KP
export WHITELIST_COUNTRY="US CA"
trade.example.org_BLACKLIST_COUNTRY=RU
`;
	it('every country list is emptied, the global and the per-site ones, and each is named', () => {
		const p = planBunkerwebPrivacy(BLOCKED);
		const v = envValues(p.text);
		expect(v.get('BLACKLIST_COUNTRY')).toBe('');
		expect(v.get('WHITELIST_COUNTRY')).toBe('');
		expect(p.text).toMatch(/^trade\.example\.org_BLACKLIST_COUNTRY=$/m);
		expect(p.changes.filter((c) => /COUNTRY/.test(c))).toHaveLength(3);
		expect(p.want.get('BLACKLIST_COUNTRY')).toBe('');
		expect(p.want.get('WHITELIST_COUNTRY')).toBe('');
	});
	it('nothing to do when no country list is set; a second run changes nothing', () => {
		expect(
			planBunkerwebPrivacy('SERVER_NAME=x\nUSE_BLACKLIST=no\n').changes.filter((c) =>
				/COUNTRY/.test(c)
			)
		).toEqual([]);
		const once = planBunkerwebPrivacy(BLOCKED).text;
		expect(planBunkerwebPrivacy(once).changes).toEqual([]);
	});
	it('no notice says country blocks still work', () => {
		const p = planBunkerwebPrivacy('USE_BLACKLIST=yes\nBLACKLIST_ASN=AS1\n');
		expect(p.notices.join(' ')).not.toMatch(/country/i);
	});
});

describe('checking BunkerWeb runs with no country list', () => {
	it('finds global and per-site lists in the generated settings, wherever they came from', () => {
		const vars =
			'BLACKLIST_COUNTRY=\nWHITELIST_COUNTRY=\nshop.example.org_BLACKLIST_COUNTRY=CN IR\nUSE_DNSBL=no\n';
		expect(countryListsInSettings(vars)).toEqual(['shop.example.org_BLACKLIST_COUNTRY=CN IR']);
	});
	it('a list this heal does not manage never fails the check of its own changes (no endless roll-back)', () => {
		const vars = 'USE_DNSBL=no\nshop.example.org_BLACKLIST_COUNTRY=CN\n';
		expect(bunkerwebSettingsProblems(vars, new Map([['USE_DNSBL', 'no']]))).toEqual([]);
	});
	it('a per-site list emptied by the heal may be absent, with or without a dot in the site name', () => {
		expect(
			bunkerwebSettingsProblems(
				'BLACKLIST_COUNTRY=\n',
				new Map([
					['app_BLACKLIST_COUNTRY', ''],
					['shop.example.org_WHITELIST_COUNTRY', '']
				])
			)
		).toEqual([]);
		expect(bunkerwebSettingsProblems('X=1\n', new Map([['BLACKLIST_COUNTRY', '']]))).toEqual([
			"BunkerWeb's running settings do not show BLACKLIST_COUNTRY yet"
		]);
	});
	it('a per-site list emptied by the heal may be absent from the generated settings', () => {
		const p = planBunkerwebPrivacy(
			'trade.example.org_BLACKLIST_COUNTRY=RU\ntrade.example.org_BLACKLIST_COUNTRY=RU\n'
		);
		expect(p.want.get('trade.example.org_BLACKLIST_COUNTRY')).toBe('');
		expect(p.changes.filter((c) => /trade\.example\.org/.test(c))).toHaveLength(1);
		expect(
			bunkerwebSettingsProblems(
				'BLACKLIST_COUNTRY=\nWHITELIST_COUNTRY=\n',
				new Map([['trade.example.org_BLACKLIST_COUNTRY', '']])
			)
		).toEqual([]);
	});
	it('leaves comments and other keys alone', () => {
		const t = '#old.example_BLACKLIST_COUNTRY=CN\nFOO=a_BLACKLIST_COUNTRY=x\n';
		const p = planBunkerwebPrivacy(t);
		expect(p.text).toContain('#old.example_BLACKLIST_COUNTRY=CN');
		expect(p.text).toContain('FOO=a_BLACKLIST_COUNTRY=x');
		expect(p.changes.filter((c) => /country list/.test(c))).toEqual([]);
	});
});

// v1.21.1 review (D-6): Docker Compose also accepts `KEY = value`, `KEY: value`,
// `export` with several spaces, a ` # comment` after an unquoted value, keys
// that start with a digit or hold a `-`, and quoted values that run over
// several lines. The expectations below are what `docker compose config`
// (v5.5.1) printed for this exact file; the last block re-asks the real
// Compose when this machine has it.
const COMPOSE_FORMS = [
	'BLACKLIST_COUNTRY = CN',
	'WHITELIST_COUNTRY: US',
	'shop.example.org_BLACKLIST_COUNTRY: RU',
	'3dshop.example_BLACKLIST_COUNTRY=KP',
	'  export  a-b.example_WHITELIST_COUNTRY =  "FR DE"  ',
	'NOTE=CN # block',
	"QUOTED='CN IR'",
	"MULTI='a",
	"BLACKLIST_COUNTRY=XX'",
	'TABBED=CN\t# kept',
	'#old.example_BLACKLIST_COUNTRY=CN',
	''
].join('\n');
const COMPOSE_SAYS: Record<string, string> = {
	BLACKLIST_COUNTRY: 'CN',
	WHITELIST_COUNTRY: 'US',
	'shop.example.org_BLACKLIST_COUNTRY': 'RU',
	'3dshop.example_BLACKLIST_COUNTRY': 'KP',
	'a-b.example_WHITELIST_COUNTRY': 'FR DE',
	NOTE: 'CN',
	QUOTED: 'CN IR',
	MULTI: 'a\nBLACKLIST_COUNTRY=XX',
	TABBED: 'CN\t# kept'
};
const COUNTRY_KEYS = Object.keys(COMPOSE_SAYS).filter((k) => /COUNTRY$/.test(k));

describe('env-file lines are read the way Docker Compose reads them (D-6)', () => {
	it('every form Compose accepts gives the value Compose gives', () => {
		expect(Object.fromEntries(envValues(COMPOSE_FORMS))).toEqual(COMPOSE_SAYS);
	});
	it('every country list in those forms is emptied — and only real entries are rewritten', () => {
		const p = planBunkerwebPrivacy(COMPOSE_FORMS);
		const v = envValues(p.text);
		for (const k of COUNTRY_KEYS) expect(v.get(k), k).toBe('');
		for (const k of COUNTRY_KEYS) expect(p.want.get(k), k).toBe('');
		// the multi-line value and the commented line are not entries: untouched
		expect(v.get('MULTI')).toBe('a\nBLACKLIST_COUNTRY=XX');
		expect(p.text).toContain('#old.example_BLACKLIST_COUNTRY=CN');
		expect(p.text).toContain('  export  a-b.example_WHITELIST_COUNTRY=\n');
		// a second run finds nothing left
		expect(planBunkerwebPrivacy(p.text).changes.filter((c) => /ountr/.test(c))).toEqual([]);
	});
	const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
	it.skipIf(!compose)(
		'the real Docker Compose reads the file, and the planned one, the same way',
		() => {
			const dir = mkdtempSync(join(tmpdir(), 'bwenv-'));
			try {
				writeFileSync(
					join(dir, 'docker-compose.yml'),
					'services:\n  bunkerweb:\n    image: bunkerity/bunkerweb:1.5.10\n    env_file:\n      - ./bunkerweb.env\n'
				);
				const read = (text: string): Record<string, string> => {
					writeFileSync(join(dir, 'bunkerweb.env'), text);
					const r = spawnSync(
						'docker',
						['compose', '-f', join(dir, 'docker-compose.yml'), 'config', '--format', 'json'],
						{ encoding: 'utf8' }
					);
					expect(r.status, r.stderr).toBe(0);
					return JSON.parse(r.stdout).services.bunkerweb.environment as Record<string, string>;
				};
				expect(read(COMPOSE_FORMS)).toEqual(Object.fromEntries(envValues(COMPOSE_FORMS)));
				const planned = planBunkerwebPrivacy(COMPOSE_FORMS).text;
				const after = read(planned);
				expect(after).toEqual(Object.fromEntries(envValues(planned)));
				for (const k of COUNTRY_KEYS) expect(after[k], k).toBe('');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	);
});

// v1.21.1 review (I-2): the operator is told which countries are no longer
// turned away, for the global lists and each per-site one.
describe('each country change names the countries it unblocks (I-2)', () => {
	it('global and per-site lines name their countries; the lists end up empty', () => {
		const p = planBunkerwebPrivacy(
			'BLACKLIST_COUNTRY=CN IR\nWHITELIST_COUNTRY="US CA"\nshop.example.org_BLACKLIST_COUNTRY=RU\n'
		);
		const line = (k: string): string => p.changes.find((c) => c.includes(k)) ?? '';
		expect(line('(BLACKLIST_COUNTRY')).toMatch(/\bCN\b.*\bIR\b/);
		expect(line('(WHITELIST_COUNTRY')).toMatch(/\bUS\b.*\bCA\b/);
		expect(line('shop.example.org_BLACKLIST_COUNTRY')).toMatch(/\bRU\b/);
		expect(p.text).toMatch(/^BLACKLIST_COUNTRY=$/m);
		expect(p.text).toMatch(/^WHITELIST_COUNTRY=$/m);
		expect(p.text).toMatch(/^shop\.example\.org_BLACKLIST_COUNTRY=$/m);
	});
});
