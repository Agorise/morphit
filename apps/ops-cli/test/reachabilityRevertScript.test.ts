/**
 * What the install's SSH safety revert does when it fires.
 *
 * 2026-10-12, a fresh VPS: the "a NEW SSH login still works?" question went
 * unanswered at the end of a long install, and the revert restored the
 * firewall rules from before the install — on a fresh box, NO rules, with the
 * firewall left switched on. That removed SSH itself (only the open session
 * survived) and every rule the install had added: the web containers could no
 * longer reach the relay, indexer or IPFS gateway, so the site's API hung and
 * the federation listed the node as "Clearnet blocked".
 *
 * The revert restores ACCESS: SSH's own settings, and the SSH port open when it
 * was reachable before the run. It never replaces the firewall's rules.
 *
 * The generated script runs here for real, against a stand-in /etc and
 * stand-in ufw / systemctl / sshd / logger on PATH.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SSHD_T } from './fixtures/sshdT.ts';

import {
	confirmReachabilityOrRevert,
	parseUfwTuples,
	revertScript,
	sshExposureBefore,
	type ConfirmAnswer,
	type ConfirmDeps
} from '../src/init/reachabilityRevert.ts';

function box(ufwActive: boolean) {
	const root = mkdtempSync(join(tmpdir(), 'morphit-revert-script-'));
	const snap = join(root, 'snap');
	const etc = join(root, 'etc');
	const bin = join(root, 'bin');
	const log = join(root, 'calls.log');
	for (const d of [snap, join(etc, 'ssh'), bin]) mkdirSync(d, { recursive: true });
	writeFileSync(join(snap, 'sshd_config'), 'PasswordAuthentication yes\n');
	writeFileSync(join(etc, 'ssh', 'sshd_config'), 'PasswordAuthentication no\nPort 2222\n');
	const stub = (name: string, body = '') =>
		writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\nexit 0\n`, {
			mode: 0o755
		});
	stub(
		'ufw',
		ufwActive
			? `[ "$1" = status ] && echo 'Status: active'`
			: `[ "$1" = status ] && echo 'Status: inactive'`
	);
	stub('systemctl');
	stub('logger');
	const marker = join(root, 'reverted');
	const hardened = join(root, 'hardened');
	const reharden = join(root, 'reharden-ssh.sh');
	return { root, snap, etc, bin, log, marker, hardened, reharden };
}

function fire(b: ReturnType<typeof box>, ports: number[], openSsh: boolean) {
	const script = join(b.root, 'revert.sh');
	writeFileSync(
		script,
		revertScript({
			dir: b.snap,
			sshPorts: ports,
			openSsh,
			etc: b.etc,
			marker: b.marker,
			hardened: b.hardened,
			reharden: b.reharden
		}),
		{ mode: 0o700 }
	);
	const r = spawnSync('bash', [script], {
		encoding: 'utf8',
		env: { PATH: `${b.bin}:/usr/bin:/bin` }
	});
	return {
		status: r.status,
		calls: existsSync(b.log) ? readFileSync(b.log, 'utf8').trim().split('\n') : []
	};
}

describe('the safety revert, when it fires', () => {
	it('puts SSH back as it was and keeps its port open — and leaves every other firewall rule alone', () => {
		const b = box(true);
		const { calls } = fire(b, [22], true);
		expect(readFileSync(join(b.etc, 'ssh', 'sshd_config'), 'utf8')).toBe(
			'PasswordAuthentication yes\n'
		);
		expect(calls).toContain('ufw limit 22/tcp');
		// Never replaces or reloads the rule set, never resets or disables it.
		expect(
			calls.filter((c) => c.startsWith('ufw') && !/^ufw (status|limit 22\/tcp)$/.test(c))
		).toEqual([]);
		expect(calls.some((c) => /restart (ssh|sshd)/.test(c))).toBe(true);
		// Docker's forwarding rules are re-asserted (the web containers' traffic).
		expect(calls).toContain('systemctl restart docker');
	});

	it('sshd on loopback only (no port to keep): the script still runs, and opens nothing', () => {
		const b = box(true);
		const r = fire(b, [], true);
		expect(r.status).toBe(0);
		expect(r.calls.filter((c) => /^ufw (allow|limit)/.test(c))).toEqual([]);
		expect(existsSync(b.marker)).toBe(true);
	});

	it('removes SSH drop-ins the run added (they are read before the main file and would keep a lockout), keeps the old ones', () => {
		const b = box(true);
		mkdirSync(join(b.snap, 'sshd_config.d'));
		writeFileSync(
			join(b.snap, 'sshd_config.d', '50-cloud-init.conf'),
			'PasswordAuthentication yes\n'
		);
		mkdirSync(join(b.etc, 'ssh', 'sshd_config.d'));
		writeFileSync(join(b.etc, 'ssh', 'sshd_config.d', '50-cloud-init.conf'), 'changed\n');
		writeFileSync(
			join(b.etc, 'ssh', 'sshd_config.d', '99-morphit-hardening.conf'),
			'MaxAuthTries 3\n'
		);
		fire(b, [22], true);
		expect(existsSync(join(b.etc, 'ssh', 'sshd_config.d', '99-morphit-hardening.conf'))).toBe(
			false
		);
		expect(readFileSync(join(b.etc, 'ssh', 'sshd_config.d', '50-cloud-init.conf'), 'utf8')).toBe(
			'PasswordAuthentication yes\n'
		);
	});

	it('a box that had no drop-in directory loses the ones the run added', () => {
		const b = box(true);
		mkdirSync(join(b.etc, 'ssh', 'sshd_config.d'));
		writeFileSync(
			join(b.etc, 'ssh', 'sshd_config.d', '99-morphit-hardening.conf'),
			'MaxAuthTries 3\n'
		);
		fire(b, [22], true);
		expect(existsSync(join(b.etc, 'ssh', 'sshd_config.d', '99-morphit-hardening.conf'))).toBe(
			false
		);
	});

	it('reads the firewall state in English whatever the system language', () => {
		const b = box(true);
		writeFileSync(
			join(b.bin, 'ufw'),
			`#!/bin/sh\necho "ufw $*" >> '${b.log}'\n[ "$1" = status ] && { [ "$LC_ALL" = C ] && echo 'Status: active' || echo 'Estado: activo'; }\nexit 0\n`,
			{ mode: 0o755 }
		);
		const { calls } = fire(b, [22], true);
		expect(calls).toContain('ufw limit 22/tcp');
	});

	it('leaves a notice that it ran (so health can say the SSH hardening was undone)', () => {
		const b = box(true);
		fire(b, [22], true);
		expect(existsSync(b.marker)).toBe(true);
	});

	it('keeps the hardened settings aside, so one command puts them back', () => {
		const b = box(true);
		mkdirSync(join(b.etc, 'ssh', 'sshd_config.d'));
		writeFileSync(
			join(b.etc, 'ssh', 'sshd_config.d', '99-morphit-hardening.conf'),
			'MaxAuthTries 3\n'
		);
		fire(b, [22], true);
		expect(readFileSync(join(b.hardened, 'sshd_config'), 'utf8')).toBe(
			'PasswordAuthentication no\nPort 2222\n'
		);
		expect(
			readFileSync(join(b.hardened, 'sshd_config.d', '99-morphit-hardening.conf'), 'utf8')
		).toBe('MaxAuthTries 3\n');
	});

	it('the command it leaves puts the hardening back only when sshd accepts it', () => {
		const b = box(true);
		mkdirSync(join(b.etc, 'ssh', 'sshd_config.d'));
		writeFileSync(
			join(b.etc, 'ssh', 'sshd_config.d', '99-morphit-hardening.conf'),
			'MaxAuthTries 3\n'
		);
		fire(b, [22], true);
		const reverted = readFileSync(join(b.etc, 'ssh', 'sshd_config'), 'utf8');
		const reharden = (sshdOk: boolean) => {
			writeFileSync(
				join(b.bin, 'sshd'),
				`#!/bin/sh\necho "sshd $*" >> '${b.log}'\nexit ${sshdOk ? 0 : 255}\n`,
				{
					mode: 0o755
				}
			);
			writeFileSync(b.log, '');
			const r = spawnSync('bash', [b.reharden], {
				encoding: 'utf8',
				env: { PATH: `${b.bin}:/usr/bin:/bin` }
			});
			return { status: r.status, out: r.stdout + r.stderr, calls: readFileSync(b.log, 'utf8') };
		};
		// sshd refuses the kept settings: SSH is left exactly as it is, and
		// nothing is restarted. (Before, they were copied in first, to take
		// effect at the next restart or reboot.)
		const bad = reharden(false);
		expect(bad.status).not.toBe(0);
		expect(bad.out).toMatch(/Not put back/);
		expect(readFileSync(join(b.etc, 'ssh', 'sshd_config'), 'utf8')).toBe(reverted);
		expect(existsSync(join(b.etc, 'ssh', 'sshd_config.d', '99-morphit-hardening.conf'))).toBe(
			false
		);
		expect(bad.calls).not.toMatch(/restart/);
		// Accepted: back in place, SSH restarted.
		const good = reharden(true);
		expect(good.status).toBe(0);
		expect(readFileSync(join(b.etc, 'ssh', 'sshd_config'), 'utf8')).toBe(
			'PasswordAuthentication no\nPort 2222\n'
		);
		expect(
			readFileSync(join(b.etc, 'ssh', 'sshd_config.d', '99-morphit-hardening.conf'), 'utf8')
		).toBe('MaxAuthTries 3\n');
		expect(good.calls).toMatch(/systemctl restart ssh/);
		// SSH does not start with them (sshd -t passes a ListenAddress it then
		// cannot bind): the old settings go back and SSH is started on them, and
		// it says which is true now — never "Done" (exit 1).
		const reharden2 = (restartOkAfter: number, active: boolean) => {
			const n = join(b.root, 'restarts');
			writeFileSync(n, '');
			writeFileSync(
				join(b.bin, 'systemctl'),
				`#!/bin/sh\necho "systemctl $*" >> '${b.log}'\n` +
					`if [ "$1" = restart ]; then echo x >> '${n}'; [ "$(wc -l < '${n}')" -gt ${restartOkAfter} ] && exit 0; exit 5; fi\n` +
					`if [ "$1" = is-active ]; then exit ${active ? 0 : 3}; fi\nexit 0\n`,
				{ mode: 0o755 }
			);
			// Hardened again on disk before each try (the last one put them back).
			spawnSync('cp', ['-a', `${b.hardened}/.`, join(b.etc, 'ssh') + '/']);
			spawnSync('rm', ['-f', join(b.etc, 'ssh', 'sshd_config.d', '99-morphit-hardening.conf')]);
			fire(b, [22], true);
			writeFileSync(n, ''); // the revert's own restarts do not count
			return reharden(true);
		};
		// The hardened start fails (both ssh and sshd), the old one starts.
		const back = reharden2(2, true);
		expect(back.status).toBe(1);
		expect(back.out).not.toMatch(/Done/);
		expect(back.out).toMatch(/runs its old settings again/);
		expect(readFileSync(join(b.etc, 'ssh', 'sshd_config'), 'utf8')).toBe(reverted);
		expect(existsSync(join(b.etc, 'ssh', 'sshd_config.d', '99-morphit-hardening.conf'))).toBe(
			false
		);
		// Nothing starts: say so plainly.
		const down = reharden2(99, false);
		expect(down.status).toBe(1);
		expect(down.out).toMatch(/SSH is NOT running/);
		expect(readFileSync(join(b.etc, 'ssh', 'sshd_config'), 'utf8')).toBe(reverted);
	});

	it('opens no port that was closed before the run (a Tor-only box with SSH over Tor only)', () => {
		const b = box(true);
		const { calls } = fire(b, [22], false);
		expect(calls.some((c) => /^ufw (allow|limit)/.test(c))).toBe(false);
	});

	it('with the firewall off, changes nothing in it', () => {
		const b = box(false);
		const { calls } = fire(b, [22], true);
		expect(calls.some((c) => /^ufw (allow|limit)/.test(c))).toBe(false);
	});
});

describe('which ports sshd listens on', () => {
	it('its config and the ssh.socket count; what is listening only when they say nothing', async () => {
		const { sshPortsFrom } = await import('../src/init/reachabilityRevert.ts');
		expect(sshPortsFrom('port 2222\naddressfamily any\n', '', '')).toEqual([2222]);
		expect(sshPortsFrom('', 'Listen=[::]:2222 (Stream)\n', '')).toEqual([2222]);
		expect(
			sshPortsFrom('', '', 'LISTEN 0 128 0.0.0.0:2200 0.0.0.0:* users:(("sshd",pid=9,fd=3))\n')
		).toEqual([2200]);
		expect(sshPortsFrom('port 22\n', 'Listen=0.0.0.0:2222 (Stream)\n', '')).toEqual([22, 2222]);
		// Nothing known: the default.
		expect(sshPortsFrom('', '', '')).toEqual([22]);
	});

	it('an X11 or `ssh -R` forward (a loopback sshd listener) is no SSH port', async () => {
		const { sshPortsFrom } = await import('../src/init/reachabilityRevert.ts');
		const ss =
			'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=9,fd=3))\n' +
			'LISTEN 0 128 127.0.0.1:6010 0.0.0.0:* users:(("sshd",pid=4242,fd=9))\n' +
			'LISTEN 0 128 [::1]:6010 [::]:* users:(("sshd",pid=4242,fd=10))\n';
		expect(sshPortsFrom('', '', ss)).toEqual([22]);
		// sshd -T knows its port: a forward on another port is not looked at.
		expect(
			sshPortsFrom(
				'port 22\n',
				'',
				'LISTEN 0 128 0.0.0.0:6010 0.0.0.0:* users:(("sshd",pid=4242,fd=9))\n'
			)
		).toEqual([22]);
	});
});

describe('which ports sshd really listens on (its listen addresses)', () => {
	it('a ListenAddress with its own port: that port, not the "port" line', async () => {
		const { sshPortsFrom } = await import('../src/init/reachabilityRevert.ts');
		// Before: [22] — the firewall opened 22, closed 2222, and locked the box out.
		expect(sshPortsFrom(SSHD_T.listenWithPort, '', '')).toEqual([2222]);
		expect(sshPortsFrom(SSHD_T.twoPorts, '', '')).toEqual([22, 2222]);
		expect(sshPortsFrom(SSHD_T.mixed, '', '')).toEqual([2200, 2222]);
		expect(sshPortsFrom(SSHD_T.stock, '', '')).toEqual([22]);
		expect(sshPortsFrom(SSHD_T.oneAddress, '', '')).toEqual([2222]);
		expect(sshPortsFrom(SSHD_T.rdomain, '', '')).toEqual([2222]);
	});

	it('listening on loopback only (SSH over Tor): no port to open', async () => {
		const { sshPortsFrom } = await import('../src/init/reachabilityRevert.ts');
		expect(sshPortsFrom(SSHD_T.loopbackOnly, '', '')).toEqual([]);
		// A socket that listens on loopback only is no port either.
		expect(sshPortsFrom(SSHD_T.loopbackOnly, 'Listen=127.0.0.1:22 (Stream)\n', '')).toEqual([]);
		// sshd -T silent (no /run/sshd yet), the socket on loopback only: none.
		expect(
			sshPortsFrom('', 'Listen=[::1]:22 (Stream)\nListen=127.0.0.1:22 (Stream)\n', '')
		).toEqual([]);
	});
});

describe('how reachable SSH was before the run', () => {
	const on = 'ENABLED=yes\n';
	const deny = 'DEFAULT_INPUT_POLICY="DROP"\n';
	it('a rule that logs (`ufw allow log-all 22`) counts like any other', () => {
		// ufw writes it as allow_log-all (its logtype "log-all").
		for (const action of ['allow_log', 'allow_log-all', 'limit_log-all'])
			expect(
				sshExposureBefore(
					on,
					deny,
					`### tuple ### ${action} tcp 22 0.0.0.0/0 any 0.0.0.0/0 in\n`,
					null,
					[22]
				),
				action
			).toBe('world');
	});

	it('world: the firewall off, an ACCEPT policy, or a rule from anywhere', () => {
		expect(sshExposureBefore('ENABLED=no\n', deny, '', null, [22])).toBe('world');
		expect(sshExposureBefore(null, null, null, null, [22])).toBe('world');
		expect(sshExposureBefore(on, 'DEFAULT_INPUT_POLICY="ACCEPT"\n', '', null, [2222])).toBe(
			'world'
		);
		const rules =
			'### tuple ### limit tcp 22 0.0.0.0/0 any 0.0.0.0/0 in\n-A ufw-user-input -p tcp --dport 22 -j ufw-user-limit\n';
		expect(sshExposureBefore(on, deny, rules, null, [22])).toBe('world');
		expect(
			sshExposureBefore(
				on,
				deny,
				'### tuple ### allow tcp 22,2222 0.0.0.0/0 any 0.0.0.0/0 in\n',
				null,
				[2222]
			)
		).toBe('world');
		expect(
			sshExposureBefore(on, deny, '', '### tuple ### allow tcp 22 ::/0 any ::/0 in\n', [22])
		).toBe('world');
		// `ufw allow OpenSSH` (an app rule), and a rule with a comment.
		expect(
			sshExposureBefore(
				on,
				deny,
				'### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 OpenSSH - in\n',
				null,
				[22]
			)
		).toBe('world');
		expect(
			sshExposureBefore(
				on,
				deny,
				'### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in comment=73736820\n',
				null,
				[22]
			)
		).toBe('world');
	});

	it('restricted: a rule for one source, or one interface, is not opened to the world', () => {
		expect(
			sshExposureBefore(
				on,
				deny,
				'### tuple ### allow tcp 22 0.0.0.0/0 any 203.0.113.5 in\n',
				null,
				[22]
			)
		).toBe('restricted');
		expect(
			sshExposureBefore(
				on,
				deny,
				'### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 in_wg0\n',
				null,
				[22]
			)
		).toBe('restricted');
		// And the revert then opens nothing (the rule is still there).
		const b = box(true);
		const { calls } = fire(b, [22], false);
		expect(calls.some((c) => /^ufw (allow|limit)/.test(c))).toBe(false);
	});

	it('closed: no rule lets it in', () => {
		expect(
			sshExposureBefore(
				on,
				deny,
				'### tuple ### allow tcp 443 0.0.0.0/0 any 0.0.0.0/0 in\n',
				null,
				[22]
			)
		).toBe('closed');
		// An outgoing rule for 22 lets nothing in.
		expect(
			sshExposureBefore(
				on,
				deny,
				'### tuple ### allow tcp 22 0.0.0.0/0 any 0.0.0.0/0 out\n',
				null,
				[22]
			)
		).toBe('closed');
	});

	it('reads ufw\u2019s tuples, ranges included', () => {
		expect(
			parseUfwTuples('### tuple ### allow tcp 2200:2300 0.0.0.0/0 any 10.0.0.0/8 in_eth1\n')
		).toEqual([
			{
				action: 'allow',
				proto: 'tcp',
				dport: '2200:2300',
				dst: '0.0.0.0/0',
				src: '10.0.0.0/8',
				direction: 'in',
				iface: 'eth1'
			}
		]);
		expect(
			sshExposureBefore(
				on,
				deny,
				'### tuple ### allow tcp 2200:2300 0.0.0.0/0 any 0.0.0.0/0 in\n',
				null,
				[2222]
			)
		).toBe('world');
	});
});

describe('the "a NEW SSH login still works?" answer', () => {
	/** `lag`: how many looks pass after `systemctl start` returned before the
	 *  revert's notice is there (systemd's start can return before it ends). */
	/** `stale`: an earlier revert's notice is still there. `startFails`:
	 *  `systemctl start` cannot start the revert's service. */
	function deps(
		answer: ConfirmAnswer,
		lag = 0,
		o: { stale?: boolean; startFails?: boolean } = {}
	): { d: ConfirmDeps; calls: string[]; out: string[] } {
		const calls: string[] = [];
		const out: string[] = [];
		let ran = false;
		let looks = 0;
		let notice = o.stale === true;
		return {
			calls,
			out,
			d: {
				run: (cmd, args) => {
					calls.push([cmd, ...args].join(' '));
					if (args[0] === 'start') {
						if (o.startFails === true) return { status: 5 };
						ran = true;
					}
					return { status: 0 };
				},
				runDetached: (cmd, args) => {
					calls.push(`detached: ${[cmd, ...args].join(' ')}`);
					ran = true;
				},
				clearReverted: () => {
					calls.push('clear notice');
					notice = false;
				},
				confirm: async () => answer,
				schedule: () => null,
				cancel: () => void calls.push('cancel'),
				print: (s) => void out.push(s),
				reverted: () => notice || (ran && looks++ >= lag && (notice = true)),
				waitFor: async (label, done, maxMs) => {
					calls.push(`wait: ${label}`);
					for (let t = 0; t < maxMs; t += 1000) if (done()) return true;
					return done();
				}
			}
		};
	}
	const handle = { armed: true, dir: '/x' };

	it('yes: the revert is cancelled', async () => {
		const { d, calls } = deps('yes');
		await confirmReachabilityOrRevert(handle, 600, d);
		expect(calls).toEqual(['cancel']);
	});

	it('no: the revert runs now, not 10 minutes later', async () => {
		const { d, calls, out } = deps('no');
		await confirmReachabilityOrRevert(handle, 600, d);
		// Not waited for by systemctl (nothing on screen meanwhile): started, then
		// watched under a spinner.
		expect(calls).toContain('systemctl start --no-block morphit-reachability-revert.service');
		expect(
			calls.indexOf('systemctl start --no-block morphit-reachability-revert.service')
		).toBeLessThan(calls.findIndex((c) => c.startsWith('wait: ')));
		expect(calls).not.toContain('cancel');
		expect(out.join('\n')).toMatch(/sudo bash \/var\/lib\/morphit-root\/reharden-ssh\.sh/);
	});

	it('no: a revert still running when systemctl returns is waited for, not reported as failed', async () => {
		const { d, calls, out } = deps('no', 3);
		await confirmReachabilityOrRevert(handle, 600, d);
		// Before: "✗ The revert did not report back" to someone who just said
		// they cannot log in, while it was running (review, 2026-10-12).
		expect(out.join('\n')).toMatch(/✓ SSH’s settings are back/);
		expect(calls.some((c) => c.startsWith('wait: '))).toBe(true);
	});

	it('no, after an earlier revert left its notice: that notice is not taken for this one', async () => {
		const { d, calls, out } = deps('no', 3, { stale: true });
		await confirmReachabilityOrRevert(handle, 600, d);
		// Before: "✓ … back" at once, before the revert had run (review, 2026-10-13).
		expect(calls.indexOf('clear notice')).toBeGreaterThan(-1);
		expect(calls.indexOf('clear notice')).toBeLessThan(
			calls.indexOf('systemctl start --no-block morphit-reachability-revert.service')
		);
		expect(out.join('\n')).toMatch(/✓ SSH’s settings are back/);
	});

	it('no, and systemd cannot start it: the script runs in the background, watched under the spinner', async () => {
		const { d, calls, out } = deps('no', 2, { startFails: true });
		await confirmReachabilityOrRevert(handle, 600, d);
		expect(calls).toContain('detached: /bin/bash /x/revert.sh');
		expect(calls).not.toContain('/bin/bash /x/revert.sh');
		expect(calls.findIndex((c) => c.startsWith('detached:'))).toBeLessThan(
			calls.findIndex((c) => c.startsWith('wait: '))
		);
		expect(out.join('\n')).toMatch(/✓ SSH’s settings are back/);
	});

	it('no: the timer is stopped, so the revert does not run a second time', async () => {
		const { d, calls } = deps('no');
		await confirmReachabilityOrRevert(handle, 600, d);
		expect(calls).toContain('systemctl stop morphit-reachability-revert.timer');
	});

	it('no: a revert that never reports back within a minute says so', async () => {
		const { d, out } = deps('no', 1_000);
		await confirmReachabilityOrRevert(handle, 600, d);
		expect(out.join('\n')).toMatch(/✗ The revert did not report back/);
	});

	it('Ctrl+C: the revert stays armed, how to cancel it is shown, and the caller stops', async () => {
		const { d, calls, out } = deps('stopped');
		await expect(confirmReachabilityOrRevert(handle, 600, d)).rejects.toMatchObject({
			name: 'AbortError'
		});
		expect(calls).toEqual([]);
		expect(out.join('\n')).toContain('sudo systemctl stop morphit-reachability-revert.timer');
	});

	it('no answer in time: nothing is run or cancelled here (the timer does it)', async () => {
		const { d, calls } = deps('timeout');
		await confirmReachabilityOrRevert(handle, 600, d);
		expect(calls).toEqual([]);
	});
});

describe('SSH shut out by the firewall (what the v1.21.6 revert left on fresh VPSes)', () => {
	const on = 'ENABLED=yes\n';
	const deny = 'DEFAULT_INPUT_POLICY="DROP"\n';
	it('found, and health says how to let SSH in again', async () => {
		const { sshClosedPorts } = await import('../src/init/reachabilityRevert.ts');
		const { sshFirewallWarning } = await import('../src/commands/health.ts');
		// Firewall on, no rule at all: the next login fails.
		const closed = sshClosedPorts(on, deny, '', '', [22]);
		expect(closed).toEqual([22]);
		expect(sshFirewallWarning(closed)).toMatch(/sudo ufw limit 22\/tcp$/);
		expect(sshFirewallWarning(sshClosedPorts(on, deny, null, null, [22, 2222]))).toMatch(
			/sudo ufw limit 22\/tcp && sudo ufw limit 2222\/tcp$/
		);
	});
	it('nothing to say when SSH is reachable, limited to some addresses, loopback only, or the firewall is off', async () => {
		const { sshClosedPorts } = await import('../src/init/reachabilityRevert.ts');
		const { sshFirewallWarning } = await import('../src/commands/health.ts');
		const open = '### tuple ### limit tcp 22 0.0.0.0/0 any 0.0.0.0/0 in\n';
		const office = '### tuple ### allow tcp 22 0.0.0.0/0 any 203.0.113.7 in\n';
		for (const c of [
			sshClosedPorts(on, deny, open, '', [22]),
			sshClosedPorts(on, deny, office, '', [22]),
			sshClosedPorts(on, deny, '', '', []),
			sshClosedPorts('ENABLED=no\n', deny, '', '', [22])
		])
			expect(sshFirewallWarning(c)).toBeNull();
	});
});

describe('a box with no SSH server (a home desktop)', () => {
	it('arms no SSH safety net: nothing to put back, and no notice health could never clear', async () => {
		const { armReachabilityRevert, reachabilityRevertAvailable } = await import(
			'../src/init/reachabilityRevert.ts'
		);
		const root = mkdtempSync(join(tmpdir(), 'morphit-arm-'));
		const h = armReachabilityRevert({
			dir: join(root, 'root-only', 'revert'),
			sshdConfig: join(root, 'no-such-sshd_config')
		});
		expect(h.armed).toBe(false);
		// Where it could arm at all (root, systemd), a box WITH sshd is armed.
		if (reachabilityRevertAvailable()) {
			writeFileSync(join(root, 'sshd_config'), 'Port 22\n');
			expect(
				armReachabilityRevert({
					dir: join(root, 'root-only2', 'revert'),
					sshdConfig: join(root, 'sshd_config')
				}).armed
			).toBe(true);
		}
		rmSync(root, { recursive: true, force: true });
	});
});

describe('health and the revert notice', () => {
	it('reads the notice the revert leaves, and nothing when there is none', async () => {
		const { readRevertNotice } = await import('../src/commands/health.ts');
		const b = box(true);
		expect(readRevertNotice(b.marker, b.hardened, join(b.etc, 'ssh'))).toBeNull();
		fire(b, [22], true);
		expect(readRevertNotice(b.marker, b.hardened, join(b.etc, 'ssh'))).toMatch(
			/^\d{4}-\d{2}-\d{2}T/
		);
	});

	it('says nothing more once the hardened settings are back (the command it gives was run)', async () => {
		const { readRevertNotice } = await import('../src/commands/health.ts');
		const b = box(true);
		fire(b, [22], true);
		spawnSync('cp', ['-a', `${b.hardened}/.`, join(b.etc, 'ssh') + '/']);
		expect(readRevertNotice(b.marker, b.hardened, join(b.etc, 'ssh'))).toBeNull();
	});
});

describe('the wait under the spinner', () => {
	it('shows the spinner at once, and returns as soon as it is done', async () => {
		const { waitUnderSpinner } = await import('../src/init/reachabilityRevert.ts');
		const writes: string[] = [];
		const out = Object.assign(Object.create(process.stdout), {
			isTTY: true,
			columns: 80,
			write: (s: string) => void writes.push(s)
		}) as NodeJS.WriteStream;
		let looks = 0;
		const t0 = Date.now();
		const done = await waitUnderSpinner(
			'Putting the SSH settings back…',
			() => ++looks >= 3,
			60_000,
			{
				out,
				pollMs: 20
			}
		);
		expect(done).toBe(true);
		expect(Date.now() - t0).toBeLessThan(2_000);
		expect(writes.join('')).toContain('Putting the SSH settings back');
		// Never done: gives up at its limit, and says so (false).
		expect(await waitUnderSpinner('x', () => false, 100, { out, pollMs: 20 })).toBe(false);
	});
});
