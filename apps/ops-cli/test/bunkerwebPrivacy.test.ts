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
