/**
 * The upgrade puts back the firewall rules that let the web containers reach
 * the relay, the indexer, the IPFS gateway and the MCP.
 *
 * 2026-10-12, a fresh VPS: the install's SSH safety revert had emptied the
 * firewall. Every /v1 call from the site hung (the containers could not reach
 * the host's indexer), and the federation showed the node as "Clearnet
 * blocked". An upgrade did not notice. Now it does, on the install's own
 * layout (the bunkerweb_net network), adding only what is missing.
 */
import { describe, expect, it } from 'vitest';
import {
	bridgeHealRun,
	bridgeSubnet,
	healBridgeFirewall,
	selfHealSteps
} from '../src/commands/upgrade.ts';

const ACTIVE_EMPTY = 'Status: active\n';
const ACTIVE_FULL = [
	'Status: active',
	'',
	'To                         Action      From',
	'--                         ------      ----',
	'8080/tcp                   ALLOW       172.20.0.0/16',
	'8081/tcp                   ALLOW       172.20.0.0/16',
	'8082/tcp                   ALLOW       172.20.0.0/16',
	'8124/tcp                   ALLOW       172.20.0.0/16',
	''
].join('\n');

function sim(o: {
	status: string;
	subnet?: string | null;
	ipfs?: boolean;
	mcp?: boolean;
	/** ufw accepts the command but the rule never shows up. */
	ufwIgnores?: boolean;
}) {
	const calls: string[] = [];
	let status = o.status;
	const run = (cmd: string, args: readonly string[]) => {
		calls.push(`${cmd} ${args.join(' ')}`);
		if (cmd === 'sh') return { status: 0, stdout: '' };
		if (cmd === 'docker')
			return o.subnet === null
				? { status: 1, stdout: 'Error: No such network: bunkerweb_net' }
				: { status: 0, stdout: `${o.subnet ?? '172.20.0.0/16'}\n` };
		if (cmd === 'ufw' && args[0] === 'status') return { status: 0, stdout: status };
		if (cmd === 'ufw' && args[0] === 'allow') {
			// `ufw allow from <subnet> to any port <p> proto tcp`: args[6] is the port.
			if (!o.ufwIgnores) status += `${args[6]}/tcp                   ALLOW       ${args[2]}\n`;
			return { status: 0, stdout: 'Rule added' };
		}
		return { status: 0, stdout: '' };
	};
	const out: string[] = [];
	healBridgeFirewall({
		run,
		ipfsGateway: () => o.ipfs ?? true,
		mcpRunning: () => o.mcp ?? true,
		info: (m) => void out.push(m),
		warn: (m) => void out.push(`WARN ${m}`)
	});
	return { calls, out: out.join('\n') };
}

describe('the bridge firewall heal', () => {
	it('an emptied firewall gets each missing rule back, from the network’s own subnet, and says so', () => {
		const { calls, out } = sim({ status: ACTIVE_EMPTY });
		for (const p of ['8080', '8081', '8082', '8124'])
			expect(calls).toContain(`ufw allow from 172.20.0.0/16 to any port ${p} proto tcp`);
		expect(out).toMatch(/can reach this box.s services again/);
		expect(out).not.toMatch(/WARN/);
	});

	it('a rule that does not show up afterwards is reported, with the command', () => {
		const { out } = sim({ status: ACTIVE_EMPTY, ufwIgnores: true });
		expect(out).toMatch(/^WARN /);
		expect(out).toContain('sudo ufw allow from 172.20.0.0/16 to any port 8081 proto tcp');
	});

	it('a rule for the port from ANOTHER source does not count', () => {
		const other = ACTIVE_FULL.replace(/172\.20\.0\.0\/16/g, '10.9.0.0/16');
		const { calls } = sim({ status: other });
		expect(calls).toContain('ufw allow from 172.20.0.0/16 to any port 8080 proto tcp');
	});

	it('a rule with a comment (as the install writes them) counts', () => {
		const commented = ACTIVE_FULL.replace(/(172\.20\.0\.0\/16)/g, '$1              # morphit');
		const { calls } = sim({ status: commented });
		expect(calls.some((c) => c.startsWith('ufw allow'))).toBe(false);
	});

	it('a firewall that already has them is left alone', () => {
		const { calls } = sim({ status: ACTIVE_FULL });
		expect(calls.some((c) => c.startsWith('ufw allow'))).toBe(false);
	});

	it('the IPFS gateway and MCP rules only where those run', () => {
		const { calls } = sim({ status: ACTIVE_EMPTY, ipfs: false, mcp: false });
		expect(calls.some((c) => /port 8082|port 8124/.test(c))).toBe(false);
		expect(calls).toContain('ufw allow from 172.20.0.0/16 to any port 8081 proto tcp');
	});

	it('nothing on a box without the install’s web network (a hand-made stack), or with the firewall off', () => {
		expect(
			sim({ status: ACTIVE_EMPTY, subnet: null }).calls.some((c) => c.startsWith('ufw allow'))
		).toBe(false);
		expect(sim({ status: 'Status: inactive\n' }).calls.some((c) => c.startsWith('ufw allow'))).toBe(
			false
		);
	});

	it('a subnet that is not a private IPv4 range is never put into a rule', () => {
		for (const subnet of [
			'0.0.0.0/0; ufw disable',
			'0.0.0.0/0',
			// Public ranges (addresses from the reviewed fixture list).
			'1.1.1.1/1',
			'8.8.8.8/24',
			'172.32.0.1/8'
		]) {
			const { calls } = sim({ status: ACTIVE_EMPTY, subnet });
			expect(
				calls.some((c) => c.startsWith('ufw allow')),
				subnet
			).toBe(false);
		}
	});

	it('a dual-stack network: its IPv4 subnet is used', () => {
		expect(bridgeSubnet('fd00:dead:beef::/64 172.20.0.0/16 ')).toBe('172.20.0.0/16');
		const { calls } = sim({ status: ACTIVE_EMPTY, subnet: 'fd00:dead:beef::/64 172.20.0.0/16' });
		expect(calls).toContain('ufw allow from 172.20.0.0/16 to any port 8080 proto tcp');
	});

	it('reads ufw in English whatever the system language', () => {
		expect(bridgeHealRun('sh', ['-c', 'printf %s "$LC_ALL"']).stdout).toBe('C');
	});

	it('runs in the upgrade\u2019s self-heal phase', () => {
		expect(selfHealSteps().map(([n]) => n)).toContain('the web containers\u2019 firewall heal');
	});
});
