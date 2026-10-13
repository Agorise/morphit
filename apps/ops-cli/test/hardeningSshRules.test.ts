/**
 * The hardening role's SSH firewall rules (ops/ansible/roles/hardening/tasks/ufw.yml).
 *
 * Before v1.21.7 the role always ran `ufw allow 22` and `ufw limit 22`:
 *  - on a box whose firewall was already on with the operator's own SSH rules
 *    (an office IP, a VPN interface, SSH over Tor only), that opened SSH to the
 *    whole internet (review, 2026-10-12);
 *  - on a box whose sshd listens on 2222, the firewall it then enabled locked
 *    the operator out.
 * Now the run sets SSH rules only when the firewall was off (or let everything
 * in) before it, on the port(s) sshd really listens on.
 *
 * The detection script is taken from the role and EXECUTED with stand-in ufw,
 * sshd and systemctl; the decision is run by ansible-playbook itself when it is
 * installed (CI has it).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { SSHD_T } from './fixtures/sshdT.ts';

const ROLE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../ops/ansible/roles/hardening/tasks/ufw.yml'
);
type Task = Record<string, unknown> & { name: string };
const tasks = YAML.parse(readFileSync(ROLE, 'utf8')) as Task[];
const byName = (prefix: string): Task => {
	const t = tasks.find((x) => x.name.startsWith(prefix));
	if (!t) throw new Error(`no task "${prefix}…" in ufw.yml`);
	return t;
};

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Run the role's detection script with stand-ins on PATH. */
function detect(o: { ufw: 'active' | 'inactive'; sshdT: string; socket: string }): string {
	const root = mkdtempSync(join(tmpdir(), 'ufw-detect-'));
	roots.push(root);
	const bin = join(root, 'bin');
	mkdirSync(bin);
	const stub = (name: string, body: string): void =>
		writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	stub('ufw', `echo "Status: ${o.ufw}"`);
	// As the real one: `sshd -T` fails while /run/sshd is missing (a
	// socket-activated Ubuntu box before its first SSH connection).
	const made = join(root, 'run-sshd-made');
	stub(
		'sshd',
		`[ -f '${made}' ] || { echo 'Missing privilege separation directory: /run/sshd' >&2; exit 255; }\n` +
			`printf '%b' ${JSON.stringify(o.sshdT)}`
	);
	stub('systemctl', `printf '%b' ${JSON.stringify(o.socket)}`);
	stub('mkdir', `[ "$2" = /run/sshd ] && touch '${made}'\nexit 0`);
	const shell = (byName('Read the firewall state')['ansible.builtin.shell'] as string).trim();
	const r = spawnSync('/bin/bash', ['-c', shell], {
		encoding: 'utf8',
		env: { PATH: `${bin}:/usr/bin:/bin` }
	});
	expect(r.status, r.stderr).toBe(0);
	return r.stdout.trim();
}

describe('what the role reads before it changes the firewall', () => {
	it('a fresh box: firewall off, sshd on 22', () => {
		expect(detect({ ufw: 'inactive', sshdT: 'port 22\nx 1\n', socket: '' })).toMatch(
			/^active=no policy=\w+ ports=22 ?$/
		);
	});
	it('sshd on 2222 (its config), or set on the ssh.socket', () => {
		expect(detect({ ufw: 'inactive', sshdT: 'port 2222\n', socket: '' })).toMatch(/ports=2222 ?$/);
		expect(detect({ ufw: 'inactive', sshdT: '', socket: 'Listen=[::]:2222 (Stream)\n' })).toMatch(
			/ports=2222 ?$/
		);
	});
	it('a firewall already on', () => {
		expect(detect({ ufw: 'active', sshdT: 'port 22\n', socket: '' })).toMatch(/^active=yes /);
	});
	it('nothing known: 22', () => {
		expect(detect({ ufw: 'inactive', sshdT: '', socket: '' })).toMatch(/ports=22$/);
	});
	it('where a real sshd listens: a ListenAddress port, not its "port" line (v1.21.7)', () => {
		const ports = (sshdT: string, socket = ''): string =>
			detect({ ufw: 'inactive', sshdT, socket })
				.replace(/^.*ports=/, '')
				.trim();
		// Before: 22 — opened, while sshd listened on 2222 only: locked out.
		expect(ports(SSHD_T.listenWithPort)).toBe('2222');
		expect(ports(SSHD_T.twoPorts)).toBe('22 2222');
		expect(ports(SSHD_T.mixed)).toBe('2200 2222');
		expect(ports(SSHD_T.stock)).toBe('22');
		expect(ports(SSHD_T.oneAddress)).toBe('2222');
		expect(ports(SSHD_T.rdomain)).toBe('2222');
		// Loopback only (SSH over Tor): no port to open at all, socket or not.
		expect(ports(SSHD_T.loopbackOnly)).toBe('none');
		expect(ports(SSHD_T.loopbackOnly, 'Listen=127.0.0.1:22 (Stream)\n')).toBe('none');
		// sshd -T silent (no /run/sshd yet), the socket on loopback only: none.
		expect(ports('', 'Listen=127.0.0.1:22 (Stream)\nListen=[::1]:22 (Stream)\n')).toBe('none');
	});
});

const HAVE_ANSIBLE = spawnSync('ansible-playbook', ['--version']).status === 0;

describe.skipIf(!HAVE_ANSIBLE)('which SSH rules the role then sets (ansible-playbook)', () => {
	it('rules only when the firewall was off or let everything in, on the real ports', () => {
		const decide = byName('Decide which SSH');
		const cases: [string, string[], boolean][] = [
			['active=no policy=DROP ports=22 ', ['22'], true],
			['active=no policy=DROP ports=2222 ', ['2222'], true],
			['active=yes policy=DROP ports=22 ', ['22'], false],
			['active=yes policy=ACCEPT ports=22 2222 ', ['22', '2222'], true],
			['', ['22'], true],
			['active=no policy=DROP ports=none', [], true]
		];
		const play: unknown[] = [];
		cases.forEach(([out, ports, ours], i) => {
			play.push({ name: `in ${i}`, set_fact: { morphit_ufw_before: { stdout: out } } });
			play.push({ ...decide, name: `decide ${i}` });
			play.push({
				name: `check ${i}`,
				assert: {
					that: [
						`morphit_ssh_ports == ${JSON.stringify(ports)}`,
						`(morphit_ssh_rules_ours | bool) == ${ours ? 'true' : 'false'}`
					]
				}
			});
		});
		const root = mkdtempSync(join(tmpdir(), 'ufw-decide-'));
		roots.push(root);
		writeFileSync(
			join(root, 'p.yml'),
			YAML.stringify([{ hosts: 'localhost', gather_facts: false, tasks: play }])
		);
		const r = spawnSync(
			'ansible-playbook',
			['-i', 'localhost,', '-c', 'local', join(root, 'p.yml')],
			{
				encoding: 'utf8',
				env: { ...process.env, ANSIBLE_LOCALHOST_WARNING: 'False', ANSIBLE_NOCOLOR: '1' }
			}
		);
		expect(r.status, r.stdout + r.stderr).toBe(0);
	}, 120_000);

	it('every SSH rule task is gated on it, and the shared port list no longer opens 22 itself', () => {
		const ssh = tasks.filter(
			(t) =>
				(t['community.general.ufw'] as Record<string, unknown> | undefined)?.port ===
					'{{ item }}' && String(t.loop ?? '').includes('morphit_ssh_ports')
		);
		expect(ssh.map((t) => (t['community.general.ufw'] as { rule: string }).rule).sort()).toEqual([
			'allow',
			'limit'
		]);
		for (const t of ssh) expect(String(t.when)).toContain('morphit_ssh_rules_ours');
		const shared = byName('Allow inbound on required ports');
		expect(JSON.stringify(shared.when)).toContain("(item | string) != '22'");
		// No task anywhere in the role sets a fixed port-22 rule any more.
		expect(
			tasks.filter(
				(t) => (t['community.general.ufw'] as { port?: unknown } | undefined)?.port === '22'
			)
		).toEqual([]);
	});
});
