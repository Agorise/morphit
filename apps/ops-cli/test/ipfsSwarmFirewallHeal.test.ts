/**
 * The IPFS swarm port 4001 must be opened on BOTH tcp and udp for a CLEARNET
 * IPFS host on upgrade (review B7) — a template-only Ansible fix never reaches
 * an installed node. Verified by observing ufw's state, not exit codes; a
 * hidden-only node keeps 4001 closed.
 */
import { describe, it, expect } from 'vitest';
import { healIpfsSwarmFirewall, ufwAllows4001Both } from '../src/commands/upgrade.ts';

describe('ufwAllows4001Both', () => {
	it('bare 4001 rule (both protos) → true', () => {
		expect(ufwAllows4001Both('To  Action  From\n4001  ALLOW  Anywhere')).toBe(true);
	});
	it('only 4001/tcp → false (udp missing)', () => {
		expect(ufwAllows4001Both('22/tcp ALLOW Anywhere\n4001/tcp ALLOW Anywhere')).toBe(false);
	});
	it('a DENY rule on 4001 is NOT an allow (wave 4)', () => {
		expect(ufwAllows4001Both('Status: active\n\nTo Action From\n4001 DENY Anywhere\n')).toBe(false);
	});
	it('4001/tcp AND 4001/udp → true', () => {
		expect(ufwAllows4001Both('4001/tcp ALLOW Anywhere\n4001/udp ALLOW Anywhere')).toBe(true);
	});
});

function harness(opts: {
	hidden: boolean;
	kubo: boolean;
	startsOpen?: boolean;
	inactive?: boolean;
}) {
	const calls: string[] = [];
	const said: string[] = [];
	const warned: string[] = [];
	let open = opts.startsOpen ?? false;
	const status = (): string =>
		opts.inactive
			? 'Status: inactive\n'
			: open
				? 'Status: active\n\nTo Action From\n4001/tcp ALLOW Anywhere\n4001/udp ALLOW Anywhere'
				: 'Status: active\n\nTo Action From\n22/tcp ALLOW Anywhere';
	const run = (cmd: string, args: readonly string[]) => {
		const line = `${cmd} ${args.join(' ')}`;
		calls.push(line);
		if (cmd === 'sh') return { status: 0, stdout: '' }; // command -v ufw
		if (cmd === 'ufw' && args[0] === 'status') return { status: 0, stdout: status() };
		if (cmd === 'ufw' && args[0] === 'allow') {
			if (args[1] === '4001/tcp' || args[1] === '4001/udp') {
				// only both together flip it open
				if (calls.includes('ufw allow 4001/tcp') && calls.includes('ufw allow 4001/udp'))
					open = true;
			}
			return { status: 0, stdout: '' };
		}
		return { status: 0, stdout: '' };
	};
	healIpfsSwarmFirewall({
		kuboPresent: () => opts.kubo,
		hiddenOnly: () => opts.hidden,
		run,
		info: (m) => said.push(m),
		warn: (m) => warned.push(m)
	});
	return Object.assign(calls, { said, warned });
}

describe('healIpfsSwarmFirewall', () => {
	it('clearnet IPFS host: opens BOTH 4001/tcp and 4001/udp', () => {
		const calls = harness({ hidden: false, kubo: true });
		expect(calls).toContain('ufw allow 4001/tcp');
		expect(calls).toContain('ufw allow 4001/udp');
	});
	it('hidden-only node: never opens 4001', () => {
		const calls = harness({ hidden: true, kubo: true });
		expect(calls.some((c) => c.startsWith('ufw allow 4001'))).toBe(false);
	});
	it('no Kubo: does nothing', () => {
		const calls = harness({ hidden: false, kubo: false });
		expect(calls.length).toBe(0);
	});
	it('ufw INACTIVE: nothing to open, no warning — one calm line (wave 4)', () => {
		const calls = harness({ hidden: false, kubo: true, inactive: true });
		expect(calls.some((c) => c.startsWith('ufw allow'))).toBe(false);
		expect(calls.warned).toEqual([]);
		expect(calls.said.length).toBe(1);
	});
	it('already open (both): no redundant allow', () => {
		const calls = harness({ hidden: false, kubo: true, startsOpen: true });
		expect(calls.some((c) => c.startsWith('ufw allow'))).toBe(false);
	});
});
