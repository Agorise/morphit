import { describe, expect, it } from 'vitest';
import {
	LOCAL_IP_BLOCKS_KEY,
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
