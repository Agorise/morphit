/**
 * reachabilityRevert.ts — a dead-man's-switch for Ansible runs that change SSH or
 * the firewall (the hardening role).
 *
 * Two outages seen on installed instances were "the run completed but cut off
 * access": a root-only SSH lockout, and the public site going dark when enabling
 * UFW wiped Docker's forwarding chains. The per-cause guards (SSH lockout-guard,
 * Docker chain re-assertion, post-harden self-test) close those two specific holes;
 * THIS is the belt-and-suspenders that catches ANY future reachability regression.
 *
 * Mechanism: before the reachability-affecting run we snapshot sshd's config and
 * write a revert script. After the run we SCHEDULE that revert via `systemd-run`
 * (a transient timer that fires independently of the operator's SSH session) and
 * ask the operator to confirm they can still reach the box. Confirm → we cancel the
 * timer. No confirmation within the window (walked away, session dropped, genuinely
 * locked out) → the revert fires: SSH's own settings go back, the SSH port stays
 * open (when it was reachable before the run), Docker's forwarding is re-asserted,
 * and a notice is left for `morphit-ops health`.
 *
 * It restores REACHABILITY, not a byte-perfect pre-harden state. It never puts the
 * pre-run firewall rule set back: on a fresh box that set is empty with the
 * firewall still on, which removed SSH itself and every rule the install had added
 * (2026-10-12: the web containers lost the relay and indexer, the site's API hung). Other hardening can also cut reachability
 * (a kernel setting such as net.ipv4.ip_forward=0 stops Docker's published ports);
 * those have their own guards and heals and are not undone here.
 *
 * The script runs as root from a transient timer, so it lives in a root-only
 * directory (/var/lib/morphit-root, 0700) and the timer is scheduled only after
 * the directory, the script and the snapshot files are checked to be root's and
 * writable by no one else. (It used to sit under /var/lib/morphit, which belongs
 * to the service user: whoever ran as that user could edit what root then ran.)
 */
import { spawn, spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { abortError } from './prompt.ts';
import { startDotsSpinner } from './spinner.ts';

export const REVERT_DIR = '/var/lib/morphit-root/reachability-revert';
const REVERT_DIR_DEFAULT = REVERT_DIR;
const UNIT = 'morphit-reachability-revert';

/** Test seam: where the snapshot lives. */
export interface RevertOptions {
	dir?: string;
	/** sshd's main config (tests). */
	sshdConfig?: string;
}

const run = (cmd: string, args: string[]): { error?: Error; status: number | null } =>
	spawnSync(cmd, args, { encoding: 'utf8' });

/**
 * Why `dir` (and everything in it, and its parent) cannot be trusted as the
 * source of a script root runs; null when it can. Owner must be root (uid 0),
 * nothing may be a symlink, and nothing may be writable by group or others.
 */
export function revertDirProblem(dir: string): string | null {
	const check = (p: string, wantDir: boolean): string | null => {
		let st;
		try {
			st = lstatSync(p);
		} catch {
			return `${p} is missing`;
		}
		if (st.isSymbolicLink()) return `${p} is a symlink`;
		if (wantDir ? !st.isDirectory() : !st.isFile() && !st.isDirectory())
			return `${p} is not what was written`;
		if (st.uid !== 0) return `${p} is owned by uid ${st.uid}, not root`;
		if ((st.mode & 0o022) !== 0)
			return `${p} is writable by others (mode ${(st.mode & 0o777).toString(8)})`;
		return null;
	};
	const walk = (p: string): string | null => {
		const own = check(p, true);
		if (own) return own;
		for (const n of readdirSync(p)) {
			const q = join(p, n);
			const st = lstatSync(q);
			const bad = st.isDirectory() && !st.isSymbolicLink() ? walk(q) : check(q, false);
			if (bad) return bad;
		}
		return null;
	};
	return check(dirname(dir), true) ?? walk(dir);
}

/** True only where we can actually snapshot sshd + schedule a transient timer as
 *  root on a systemd box. Everywhere else this whole mechanism no-ops safely. */
export function reachabilityRevertAvailable(): boolean {
	if (typeof process.getuid === 'function' && process.getuid() !== 0) return false;
	const r = spawnSync('systemd-run', ['--version'], { encoding: 'utf8' });
	return !r.error && r.status === 0;
}

export interface RevertHandle {
	readonly armed: boolean;
	readonly dir?: string;
}

/** A file's text, or null when it is missing or unreadable. */
function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

/** Loopback: reached only from this box (a Tor hidden service, a tunnel). */
const LOOPBACK = /^(127\.|\[::1\]$|::1$|localhost$)/;

/** The SSH port(s) a client can reach: where sshd's effective config listens
 *  (`sshd -T`'s `listenaddress` lines — its `port` line is NOT where it listens
 *  when a ListenAddress carries a port: `ListenAddress 0.0.0.0:2222` still says
 *  "port 22", and the firewall then opened 22 and locked the box out, review
 *  2026-10-12), leaving out loopback addresses; the `port` lines only when it
 *  prints no address. And the ssh.socket's Listen= (a port set there is
 *  invisible to sshd -T, which also fails when /run/sshd is missing —
 *  socket-activated Ubuntu before the first SSH connection). Only when none of
 *  these says, what sshd listens on now (`ss`, never a loopback forward). Empty
 *  when sshd listens on loopback only (SSH over Tor: no port to open); 22 when
 *  nothing says. PURE. */
export function sshPortsFrom(sshdT: string, socketListen: string, ss: string): number[] {
	const ports = new Set<number>();
	const add = (n: string | undefined): void => {
		const p = Number(n);
		if (Number.isInteger(p) && p > 0 && p < 65536) ports.add(p);
	};
	// `listenaddress 0.0.0.0:2222` or, with a routing domain, `… rdomain eth0`.
	const listen = [...sshdT.matchAll(/^listenaddress (\S+)(?:\s+rdomain\s+\S+)?$/gm)].map(
		(m) => m[1]!
	);
	for (const a of listen) {
		const m = /^(.*):(\d{1,5})$/.exec(a);
		if (m && !LOOPBACK.test(m[1]!)) add(m[2]);
	}
	if (listen.length === 0) for (const m of sshdT.matchAll(/^port (\d{1,5})$/gm)) add(m[1]);
	const socket = [...socketListen.matchAll(/^Listen=(.*):(\d{1,5}) \(Stream\)/gm)];
	for (const m of socket) if (!LOOPBACK.test(m[1]!)) add(m[2]);
	// It said where it listens, and every place is loopback.
	const loopbackOnly = (listen.length > 0 || socket.length > 0) && ports.size === 0;
	// Only when nothing above says: what sshd listens on now, leaving out
	// loopback listeners — an X11 or `ssh -R` forward (127.0.0.1:6010) is an
	// sshd listener too, and no SSH port (review, 2026-10-12: the revert opened
	// 6010 to the world).
	if (ports.size === 0 && !loopbackOnly) {
		for (const line of ss.split('\n')) {
			if (!/"sshd"/.test(line)) continue;
			const m = /\s(\S+):(\d{1,5})\s+\S+:\*/.exec(line);
			if (!m || LOOPBACK.test(m[1]!)) continue;
			add(m[2]);
		}
	}
	if (ports.size > 0) return [...ports].sort((a, b) => a - b);
	return loopbackOnly ? [] : [22];
}

function currentSshPorts(): number[] {
	const out = (cmd: string, args: string[]): string =>
		spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 }).stdout ?? '';
	return sshPortsFrom(
		out('sshd', ['-T']),
		out('systemctl', ['show', 'ssh.socket', '-p', 'Listen']),
		out('ss', ['-Htlnp'])
	);
}

/** One rule as ufw records it in user.rules / user6.rules:
 *  `### tuple ### <action> <proto> <dport> <dst> <sport> <src> [<dapp> <sapp>] <direction>[_<iface>] [comment=…]`. */
export interface UfwTuple {
	readonly action: string;
	readonly proto: string;
	readonly dport: string;
	readonly dst: string;
	readonly src: string;
	/** `in`, `out`, or `fwd`. */
	readonly direction: string;
	/** The interface the rule is limited to, or null. */
	readonly iface: string | null;
}

/** Every rule tuple in ufw's rules text. PURE. */
export function parseUfwTuples(text: string): UfwTuple[] {
	const out: UfwTuple[] = [];
	for (const m of text.matchAll(/^### tuple ### (.+)$/gm)) {
		const f = m[1]!
			.replace(/\s+comment=\S*\s*$/, '')
			.trim()
			.split(/\s+/);
		if (f.length !== 7 && f.length !== 9) continue;
		const [action, proto, dport, dst, , src] = f as [
			string,
			string,
			string,
			string,
			string,
			string
		];
		const dir = f[f.length - 1]!;
		const u = dir.indexOf('_');
		out.push({
			action,
			proto,
			dport,
			dst,
			src,
			direction: u < 0 ? dir : dir.slice(0, u),
			iface: u < 0 ? null : dir.slice(u + 1)
		});
	}
	return out;
}

/**
 * How reachable SSH was before the run:
 *   world       the firewall was off, its incoming policy was ACCEPT, or a rule
 *               let one of `ports` in from anywhere, on any interface;
 *   restricted  only rules limited to some sources or an interface (a VPN, an
 *               office IP) let it in — those rules are still there after the
 *               run, which adds rules and never removes one;
 *   closed      nothing did (SSH over Tor only, say).
 * Only `world` makes the revert keep the port open to everyone: re-opening a
 * restricted port with a plain `ufw limit` widened it to the whole internet
 * (review, 2026-10-12). PURE.
 */
export function sshExposureBefore(
	ufwConf: string | null,
	defaultUfw: string | null,
	userRules: string | null,
	user6Rules: string | null,
	ports: readonly number[]
): 'world' | 'restricted' | 'closed' {
	const enabled = ufwConf !== null && /^\s*ENABLED\s*=\s*yes\s*$/m.test(ufwConf);
	if (!enabled) return 'world';
	if (defaultUfw !== null && /^\s*DEFAULT_INPUT_POLICY\s*=\s*"?ACCEPT"?\s*$/m.test(defaultUfw))
		return 'world';
	const covers = (spec: string, p: number): boolean =>
		spec === 'any' ||
		spec.split(',').some((part) => {
			const [a, b] = part.split(':').map(Number);
			return b === undefined ? a === p : p >= a! && p <= b;
		});
	const anywhere = (a: string): boolean => a === '0.0.0.0/0' || a === '::/0' || a === 'any';
	let restricted = false;
	for (const t of parseUfwTuples(`${userRules ?? ''}\n${user6Rules ?? ''}`)) {
		if (!/^(allow|limit)(_log([-_]all)?)?$/.test(t.action)) continue;
		if (t.direction !== 'in' || (t.proto !== 'tcp' && t.proto !== 'any')) continue;
		if (!ports.some((p) => covers(t.dport, p))) continue;
		if (anywhere(t.src) && anywhere(t.dst) && t.iface === null) return 'world';
		restricted = true;
	}
	return restricted ? 'restricted' : 'closed';
}

/**
 * The SSH port(s) a client cannot reach because the firewall is on and no rule
 * lets them in — what the v1.21.6 safety revert left behind on a fresh VPS (no
 * rules, firewall on): the session open at the time survived, and the next
 * login failed. Empty when SSH is reachable, restricted to some addresses, or
 * listens on loopback only (SSH over Tor). PURE.
 */
export function sshClosedPorts(
	ufwConf: string | null,
	defaultUfw: string | null,
	userRules: string | null,
	user6Rules: string | null,
	ports: readonly number[]
): number[] {
	if (ports.length === 0) return [];
	return sshExposureBefore(ufwConf, defaultUfw, userRules, user6Rules, ports) === 'closed'
		? [...ports]
		: [];
}

/** {@link sshClosedPorts} on this box (root: ufw's rule files are root's). */
export function sshClosedPortsNow(): number[] {
	return sshClosedPorts(
		readOrNull('/etc/ufw/ufw.conf'),
		readOrNull('/etc/default/ufw'),
		readOrNull('/etc/ufw/user.rules'),
		readOrNull('/etc/ufw/user6.rules'),
		currentSshPorts()
	);
}

/** Where a fired revert leaves its notice (health shows it; a later confirmed
 *  install clears it). In the root-only directory. */
export const REVERTED_MARKER = '/var/lib/morphit-root/reachability-reverted';

/** Where a fired revert keeps the install's hardened SSH settings, so they can
 *  be put back with one command once the operator has checked their key login. */
export const SSH_HARDENED_DIR = '/var/lib/morphit-root/ssh-hardened';

/** The script a fired revert leaves to put the hardening back. */
export const REHARDEN_SCRIPT = '/var/lib/morphit-root/reharden-ssh.sh';

/** The command that puts the install's SSH hardening back after a revert. */
export const REHARDEN_SSH_COMMAND = `sudo bash ${REHARDEN_SCRIPT}`;

/**
 * The script behind {@link REHARDEN_SSH_COMMAND}: put the kept settings back
 * only when sshd accepts them, else leave SSH exactly as it is. The command
 * used to copy them in first and check after (`cp && sshd -t && restart`): a
 * refused file stayed in place, to take effect at the next restart or reboot
 * (review, 2026-10-12). PURE (text).
 */
export function rehardenScript(o: { etc?: string; hardened?: string } = {}): string {
	const e = `${o.etc ?? '/etc'}/ssh`;
	const h = o.hardened ?? SSH_HARDENED_DIR;
	return [
		'#!/bin/bash',
		'# Put back the SSH settings the install hardened (kept aside by the safety',
		'# revert), only when sshd accepts them. Otherwise SSH is left as it is.',
		'set -u',
		`H=${h}`,
		`E=${e}`,
		'if [ ! -f "$H/sshd_config" ]; then echo "Nothing was kept aside to put back."; exit 1; fi',
		'B="$(mktemp -d)" || exit 1',
		'cp -a "$E/sshd_config" "$B/" 2>/dev/null',
		'if [ -d "$E/sshd_config.d" ]; then cp -a "$E/sshd_config.d" "$B/"; fi',
		'cp -a "$H/." "$E/"',
		'mkdir -p /run/sshd 2>/dev/null',
		'restart_ssh() { systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null; }',
		'ssh_up() { systemctl is-active --quiet ssh || systemctl is-active --quiet sshd || systemctl is-active --quiet ssh.socket; }',
		'if sshd -t -f "$E/sshd_config"; then',
		'  if restart_ssh; then',
		'    rm -rf "$B"',
		'    echo "Done: the SSH hardening is back. Check a NEW login before you close this session."',
		'    exit 0',
		'  fi',
		// A config sshd -t accepts can still fail to start (an address it cannot
		// bind), and a failed restart leaves SSH down: put the old ones back.
		'  echo "SSH did not start with the hardened settings: putting the old ones back."',
		'  rm -rf "$E/sshd_config.d"',
		'  cp -a "$B/." "$E/"',
		'  rm -rf "$B"',
		'  restart_ssh',
		'  if ssh_up; then',
		'    echo "SSH runs its old settings again. Why the hardened ones failed:  journalctl -u ssh -n 30"',
		'  else',
		'    echo "SSH is NOT running. Do not close this session. See:  systemctl status ssh"',
		'  fi',
		'  exit 1',
		'fi',
		'rm -rf "$E/sshd_config.d"',
		'cp -a "$B/." "$E/"',
		'rm -rf "$B"',
		'echo "Not put back: sshd does not accept the kept settings (see above). SSH is left as it was."',
		'exit 1',
		''
	].join('\n');
}

/**
 * The revert script. Puts SSH's own settings back and restarts it; keeps the
 * SSH port(s) open when SSH was reachable before the run (`openSsh`) — and
 * never opens one that was closed (a Tor-only box with SSH over Tor only);
 * re-asserts Docker's forwarding; leaves a notice. It never restores, reloads,
 * resets or disables the firewall's rule set. PURE (text).
 */
export function revertScript(o: {
	dir: string;
	sshPorts: readonly number[];
	openSsh: boolean;
	etc?: string;
	marker?: string;
	hardened?: string;
	reharden?: string;
}): string {
	const etc = o.etc ?? '/etc';
	const marker = o.marker ?? REVERTED_MARKER;
	const hardened = o.hardened ?? SSH_HARDENED_DIR;
	const reharden = o.reharden ?? REHARDEN_SCRIPT;
	const keepOpen =
		o.openSsh && o.sshPorts.length > 0
			? 'if LC_ALL=C ufw status 2>/dev/null | grep -q "^Status: active"; then\n' +
				o.sshPorts.map((p) => `  ufw limit ${p}/tcp 2>/dev/null\n`).join('') +
				'fi\n'
			: '# SSH was not reachable through the firewall before the run (or listens on\n' +
				'# loopback only): nothing is opened.\n';
	return (
		'#!/bin/bash\n' +
		'# Morphit reachability auto-revert — restores SSH access after an install or\n' +
		'# harden that may have cut it off. Written by morphit-ops before the run.\n' +
		'set +e\n' +
		'# Keep the hardened settings, so they can be put back with one command.\n' +
		`rm -rf ${hardened}; mkdir -p ${hardened}; chmod 700 ${hardened}\n` +
		`cp -a ${etc}/ssh/sshd_config ${hardened}/ 2>/dev/null\n` +
		`[ -d ${etc}/ssh/sshd_config.d ] && cp -a ${etc}/ssh/sshd_config.d ${hardened}/ 2>/dev/null\n` +
		`cat > ${reharden} <<'MORPHIT_REHARDEN'\n` +
		rehardenScript({ etc, hardened }) +
		'MORPHIT_REHARDEN\n' +
		`chmod 700 ${reharden}\n` +
		`cp -a ${o.dir}/sshd_config ${etc}/ssh/sshd_config 2>/dev/null\n` +
		`if [ -d ${o.dir}/sshd_config.d ]; then cp -a ${o.dir}/sshd_config.d/. ${etc}/ssh/sshd_config.d/ 2>/dev/null; fi\n` +
		'# Drop-ins the run added go too: they are read before the main file, and\n' +
		'# the first value read wins, so a lockout set there would survive the revert.\n' +
		`for f in ${etc}/ssh/sshd_config.d/*; do\n` +
		'  [ -e "$f" ] || continue\n' +
		`  [ -e "${o.dir}/sshd_config.d/$(basename "$f")" ] || rm -f "$f"\n` +
		'done\n' +
		'systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null\n' +
		'# Keep the SSH port open; every other firewall rule stays as the run left it.\n' +
		keepOpen +
		'systemctl restart docker 2>/dev/null\n' +
		`date -u +%Y-%m-%dT%H:%M:%SZ > ${marker} 2>/dev/null\n` +
		`logger -t ${UNIT} "auto-reverted SSH settings (firewall rules kept, SSH port kept open) + docker after an unconfirmed install" 2>/dev/null\n`
	);
}

/**
 * Snapshot SSH config + write the revert script. Does NOT schedule the timer yet
 * (so a failed/aborted run before the confirm step never triggers a revert).
 */
export function armReachabilityRevert(opts: RevertOptions = {}): RevertHandle {
	if (!reachabilityRevertAvailable()) return { armed: false };
	// No SSH server (a home desktop; the hardening role leaves SSH alone there):
	// nothing to put back, and a fired revert left a notice that nothing could
	// clear, naming a command that fails (review, 2026-10-12).
	const sshdConfig = opts.sshdConfig ?? '/etc/ssh/sshd_config';
	if (!existsSync(sshdConfig)) return { armed: false };
	const dir = opts.dir ?? REVERT_DIR_DEFAULT;
	try {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dirname(dir), 0o700);
		chmodSync(dir, 0o700);
		cpSync(sshdConfig, `${dir}/sshd_config`);
		const dropIns = join(dirname(sshdConfig), 'sshd_config.d');
		if (existsSync(dropIns)) {
			cpSync(dropIns, `${dir}/sshd_config.d`, { recursive: true });
		}
		// What the revert needs to keep SSH reachable: the port(s) sshd listens
		// on now (before the run), and whether the firewall let them in. It never
		// restores or replaces the firewall's rules: putting back the pre-run rule
		// set on a fresh box (none, firewall left on) removed SSH itself and every
		// rule the install had added (2026-10-12).
		const sshPorts = currentSshPorts();
		const openSsh =
			sshExposureBefore(
				readOrNull('/etc/ufw/ufw.conf'),
				readOrNull('/etc/default/ufw'),
				readOrNull('/etc/ufw/user.rules'),
				readOrNull('/etc/ufw/user6.rules'),
				sshPorts
			) === 'world';
		const script = revertScript({ dir, sshPorts, openSsh });
		writeFileSync(`${dir}/revert.sh`, script, { mode: 0o700 });
		return { armed: true, dir };
	} catch {
		return { armed: false };
	}
}

/**
 * Schedule the revert to fire in `windowSec` via a transient systemd timer —
 * only after re-checking that what root will run is still root's alone.
 */
function scheduleRevert(handle: RevertHandle, windowSec: number): string | null {
	const dir = handle.dir ?? REVERT_DIR_DEFAULT;
	const problem = revertDirProblem(dir);
	if (problem) return problem;
	const r = run('systemd-run', [
		`--on-active=${windowSec}s`,
		`--unit=${UNIT}`,
		'/bin/bash',
		`${dir}/revert.sh`
	]);
	return !r.error && (r.status === 0 || r.status === null)
		? null
		: 'systemd-run could not schedule the timer';
}

/** Cancel a scheduled revert (operator confirmed reachability) + clean up. */
export function cancelReachabilityRevert(handle: RevertHandle = { armed: false }): void {
	// Confirmed: an earlier revert's notice no longer applies.
	rmSync(REVERTED_MARKER, { force: true });
	run('systemctl', ['stop', `${UNIT}.timer`]);
	run('systemctl', ['stop', `${UNIT}.service`]);
	run('systemctl', ['reset-failed', `${UNIT}.timer`, `${UNIT}.service`]);
	try {
		rmSync(handle.dir ?? REVERT_DIR_DEFAULT, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

/** The operator's answer to the "a NEW SSH login still works?" question. */
export type ConfirmAnswer = 'yes' | 'no' | 'timeout' | 'stopped';

/** The question, until a y or n, the window closes, or Ctrl+C. An empty
 *  answer asks again: Enter alone is not "no" (that reverts at once). */
async function timedConfirm(question: string, windowSec: number): Promise<ConfirmAnswer> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), windowSec * 1000);
	try {
		for (;;) {
			const rl = createInterface({ input: stdin, output: stdout });
			let ans: string;
			try {
				ans = (await rl.question(`${question} [y/n] `, { signal: ac.signal })).trim().toLowerCase();
			} catch {
				// Our own abort is the window closing; any other is Ctrl+C.
				return ac.signal.aborted ? 'timeout' : 'stopped';
			} finally {
				rl.close();
			}
			if (ans === 'y' || ans === 'yes') return 'yes';
			if (ans === 'n' || ans === 'no') return 'no';
			console.log('  Please answer y (a new login works) or n (it does not).');
		}
	} finally {
		clearTimeout(timer);
	}
}

export interface ConfirmDeps {
	readonly run: (cmd: string, args: string[]) => { error?: Error; status: number | null };
	readonly confirm: (question: string, windowSec: number) => Promise<ConfirmAnswer>;
	readonly schedule: (handle: RevertHandle, windowSec: number) => string | null;
	readonly cancel: (handle: RevertHandle) => void;
	readonly print: (s: string) => void;
	/** The revert's notice exists (it ran). */
	readonly reverted: () => boolean;
	/** Remove an earlier revert's notice, so this one's can be waited for. */
	readonly clearReverted: () => void;
	/** Start a program and do not wait for it. */
	readonly runDetached: (cmd: string, args: string[]) => void;
	/** Wait (under a spinner) until `done()`, at most `maxMs`; its last answer. */
	readonly waitFor: (label: string, done: () => boolean, maxMs: number) => Promise<boolean>;
}

/** Wait under the spinner (shown at once) until `done()`, looking every
 *  `pollMs`, at most `maxMs`; true when done. Exported for its test. */
export async function waitUnderSpinner(
	label: string,
	done: () => boolean,
	maxMs: number,
	o: { out?: NodeJS.WriteStream; pollMs?: number } = {}
): Promise<boolean> {
	if (done()) return true;
	const stop = startDotsSpinner(label, o.out);
	try {
		for (const end = Date.now() + maxMs; Date.now() < end; ) {
			await new Promise((r) => setTimeout(r, o.pollMs ?? 500));
			if (done()) return true;
		}
		return done();
	} finally {
		stop();
	}
}

const realConfirmDeps: ConfirmDeps = {
	run,
	confirm: timedConfirm,
	schedule: scheduleRevert,
	cancel: cancelReachabilityRevert,
	print: (s) => console.log(s),
	reverted: () => existsSync(REVERTED_MARKER),
	clearReverted: () => rmSync(REVERTED_MARKER, { force: true }),
	runDetached: (cmd, args) => {
		try {
			spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
		} catch {
			/* waited for below: it says when nothing came back */
		}
	},
	waitFor: (label, done, maxMs) => waitUnderSpinner(label, done, maxMs)
};

/**
 * Arm-and-confirm: schedule the revert, then ask the operator to confirm they can
 * still reach the box. The prompt is SSH-focused (immediate + binary), not
 * site-focused — a fresh install's site may still be starting, and the
 * Docker/site path is already guarded + fail-loud in the hardening role.
 * `promptWindowSec` < the scheduled window so a just-in-time confirm cleanly
 * cancels before the timer fires.
 *   yes      the revert is cancelled; the hardening stays.
 *   no       the revert runs NOW (it used to say "now" and wait 10 minutes —
 *            review, 2026-10-12).
 *   timeout  the timer fires a few seconds later.
 *   Ctrl+C   the revert stays armed; how to cancel it is shown, and the
 *            caller stops (AbortError).
 */
export async function confirmReachabilityOrRevert(
	handle: RevertHandle,
	promptWindowSec = 600,
	d: ConfirmDeps = realConfirmDeps
): Promise<void> {
	if (!handle.armed) return;
	const revertWindowSec = promptWindowSec + 10;
	const notScheduled = d.schedule(handle, revertWindowSec);
	if (notScheduled !== null) {
		// Couldn't schedule — don't pretend there's a safety net.
		d.cancel(handle);
		d.print('');
		d.print(`  The automatic SSH/firewall revert was not armed (${notScheduled}).`);
		d.print('  Check from a NEW SSH session that you can still log in before closing this one.');
		return;
	}
	d.print('');
	d.print('  ─────────────────────────────────────────────────────────');
	d.print('  SAFETY: an automatic revert is armed.');
	d.print(
		`  If you do NOT confirm below within ${Math.round(promptWindowSec / 60)} minutes, this box puts its SSH`
	);
	d.print('  settings back as they were on its own (the SSH port stays as reachable as it');
	d.print('  was), in case this run cut off your access. Test it now, from another');
	d.print('  terminal / your laptop:');
	d.print('');
	d.print('     ssh into the box again in a NEW session (do not close this one)');
	d.print('');
	d.print('  If that new login works, answer y. If it does not, answer n: the settings go');
	d.print('  back right away.');
	d.print('  ─────────────────────────────────────────────────────────');
	// The bell: this comes at the end of a long install, when nobody may be
	// watching (2026-10-12: unanswered, the revert fired).
	process.stdout.write('\u0007');
	const answer = await d.confirm('Confirmed — a NEW SSH login still works?', promptWindowSec);
	if (answer === 'yes') {
		d.cancel(handle);
		d.print('  ✓ Confirmed — safety auto-revert cancelled; hardening kept.');
		return;
	}
	if (answer === 'no') {
		// Run it now: the transient service systemd-run made along with the
		// timer. Not waited for by systemctl — it restarts SSH and Docker, and the
		// screen stayed still meanwhile; its notice is watched for under the
		// spinner instead (it used to be looked for once, at once, and the
		// operator was told it had not run — review, 2026-10-12).
		d.print('');
		// An earlier revert's notice must not be taken for this one's.
		d.clearReverted();
		const now = d.run('systemctl', ['start', '--no-block', `${UNIT}.service`]);
		if (now.error || now.status !== 0)
			d.runDetached('/bin/bash', [`${handle.dir ?? REVERT_DIR_DEFAULT}/revert.sh`]);
		d.run('systemctl', ['stop', `${UNIT}.timer`]);
		const back = await d.waitFor('Putting the SSH settings back\u2026', d.reverted, 120_000);
		d.print('');
		d.print(
			back
				? '  ✓ SSH\u2019s settings are back as they were before the install. Try a NEW login now.'
				: `  ✗ The revert did not report back. Check from a NEW session; its log: journalctl -t ${UNIT}`
		);
		d.print('    The install\u2019s SSH hardening is kept aside; to put it back once a key login');
		d.print(`    works:  ${REHARDEN_SSH_COMMAND}`);
		return;
	}
	if (answer === 'stopped') {
		d.print('');
		d.print('  Stopped. The safety revert stays armed: it puts the SSH settings back about');
		d.print(
			`  ${Math.round(revertWindowSec / 60)} minutes after it was armed. Once a NEW SSH login works, cancel it with:`
		);
		d.print(`      sudo systemctl stop ${UNIT}.timer`);
		throw abortError();
	}
	d.print('');
	d.print('  ⏱ Not confirmed in time — in a few seconds this box puts its SSH settings back');
	d.print('     to restore access (the firewall stays as the install made it).');
	d.print('     `sudo morphit-ops health` shows it, with how to put the hardening back.');
}
