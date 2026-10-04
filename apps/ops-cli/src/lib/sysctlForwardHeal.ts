/**
 * Installed-box heal: IPv4 forwarding back on where Docker publishes public
 * ports.
 *
 * WHY. The hardening role used to write `net.ipv4.ip_forward = 0` into
 * /etc/sysctl.d/99-morphit-hardening.conf, applied by a handler that runs after
 * Docker is up. Clearnet traffic to BunkerWeb's published 80/443 is DNAT'd to
 * the container and then FORWARDED, so with forwarding off it is dropped —
 * while loopback, Tor and I2P keep working and every local self-test passes.
 * Docker turns forwarding on again only when it restarts, so a box could go
 * dark at the next `sysctl --system` or reboot.
 *
 * WHAT. Only on a box where a running container publishes a port on a
 * non-loopback address (a hidden-only box publishes on 127.0.0.1 only and is
 * left alone):
 *  1. remove the `ip_forward = 0` line from Morphit's own drop-in (any other
 *     file that sets it is the operator's: named, not edited);
 *  2. if forwarding is off now, `sysctl -w net.ipv4.ip_forward=1`;
 *  3. VERIFY: read the value back, and see Docker's DNAT rule for each
 *     published public port in the nat table.
 * FALLBACK when the value does not stick: restart Docker (it sets forwarding
 * when it starts; the containers restart with it), then read it back again.
 * Otherwise one calm line with the command for this server.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';

export const MORPHIT_SYSCTL_DROPIN = '99-morphit-hardening.conf';
const FORWARD_LINE = /^\s*net\.ipv4\.ip_forward\s*=\s*0\s*$/;

/** The public (non-loopback) host ports in `docker ps --format '{{.Ports}}'`
 *  output, e.g. "0.0.0.0:443->8443/tcp, [::]:443->8443/tcp". PURE. */
export function publicPublishedPorts(psPorts: string): number[] {
	const out = new Set<number>();
	for (const m of psPorts.matchAll(/(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]*\]):(\d+)->/gi)) {
		const host = m[1]!;
		if (/^127\./.test(host) || host === '[::1]') continue;
		out.add(Number(m[2]));
	}
	return [...out].sort((a, b) => a - b);
}

/** Drop-in text without the forwarding-off line, and whether it changed. PURE. */
export function withoutForwardOff(text: string): { text: string; changed: boolean } {
	const lines = text.split('\n');
	const kept = lines.filter((l) => !FORWARD_LINE.test(l));
	return { text: kept.join('\n'), changed: kept.length !== lines.length };
}

/** Does this NAT dump DNAT `port` to a container? Understands `iptables-save
 *  -t nat` lines and `nft list table ip nat` rules (Docker's two backends). PURE. */
export function natForwards(natDump: string, port: number): boolean {
	return natDump
		.split('\n')
		.some(
			(l) =>
				(/-j DNAT\b/.test(l) &&
					new RegExp(`--dport ${port}\\b`).test(l) &&
					/--to-destination \d/.test(l)) ||
				(new RegExp(`\\bdport ${port}\\b`).test(l) && /\bdnat (?:ip )?to \d/.test(l))
		);
}

export interface ForwardRuntime {
	/** `docker ps --format '{{.Ports}}'` output; null when Docker is not usable. */
	dockerPorts(): string | null;
	readForward(): string | null;
	writeForward(): boolean;
	/** Files under /etc/sysctl.d (+ /etc/sysctl.conf) and their text. */
	sysctlFiles(): Array<{ path: string; text: string }>;
	writeFile(path: string, text: string): boolean;
	natDump(): string;
	restartDocker(): boolean;
	sleep(ms: number): Promise<void>;
}

export async function healForwarding(
	ctx: HealCtx,
	opts: { runtime?: ForwardRuntime; sysctlDir?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime(opts.sysctlDir ?? '/etc/sysctl.d');
	let stop = ctx.spinner('Checking IPv4 forwarding for the published web ports…');
	let ports: number[];
	try {
		const ps = rt.dockerPorts();
		ports = ps === null ? [] : publicPublishedPorts(ps);
	} finally {
		stop();
	}
	if (ports.length === 0)
		return {
			strategy: 'skipped',
			verified: true,
			detail:
				'IPv4 forwarding: no container publishes a public port on this server, so it was left as it is.'
		};

	// 1. Morphit's own drop-in no longer turns it off; others are named.
	const notes: string[] = [];
	for (const f of rt.sysctlFiles()) {
		const isOurs = f.path.endsWith(`/${MORPHIT_SYSCTL_DROPIN}`);
		const w = withoutForwardOff(f.text);
		if (!w.changed) continue;
		if (isOurs) {
			if (
				!rt.writeFile(f.path, w.text) ||
				withoutForwardOff(rt.sysctlFiles().find((x) => x.path === f.path)?.text ?? '').changed
			)
				notes.push(`could not remove "net.ipv4.ip_forward = 0" from ${f.path}`);
		} else
			notes.push(
				`${f.path} also sets net.ipv4.ip_forward = 0 and would turn it off again at the next reboot; remove that line on this server`
			);
	}

	// 2–3. Set, then observe.
	const before = rt.readForward();
	let strategy = before === '1' ? 'already' : 'sysctl';
	if (before !== '1') rt.writeForward();
	let now = rt.readForward();
	if (now !== '1') {
		stop = ctx.spinner(
			'Restarting Docker so it turns forwarding back on (the web containers restart with it)…'
		);
		try {
			rt.restartDocker();
			await rt.sleep(5_000);
			now = rt.readForward();
			strategy = 'docker-restart';
		} finally {
			stop();
		}
	}
	const nat = rt.natDump();
	const missing = ports.filter((p) => !natForwards(nat, p));
	const ok = now === '1' && missing.length === 0;
	const detail =
		now !== '1'
			? `IPv4 forwarding is off on this server (read back), so clearnet visitors cannot reach the published ports ${ports.join(', ')}. On this server run: sudo sysctl -w net.ipv4.ip_forward=1 && sudo systemctl restart docker`
			: `IPv4 forwarding: ${before === '1' ? 'on' : 'turned back on'} (read back)` +
				(missing.length === 0
					? `, and Docker forwards the public ports ${ports.join(', ')} (seen in its NAT rules)`
					: `; Docker's forwarding rule for port(s) ${missing.join(', ')} was not seen — on this server run: sudo systemctl restart docker`);
	return {
		strategy: notes.length > 0 && strategy === 'already' ? 'dropin-cleaned' : strategy,
		verified: ok,
		detail: [detail, ...notes].join('; ') + '.'
	};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healForwarding(ctx);
}

function sh(cmd: string, args: string[], timeout = 20_000): { ok: boolean; out: string } {
	try {
		const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
		return { ok: r.status === 0, out: `${r.stdout ?? ''}` };
	} catch {
		return { ok: false, out: '' };
	}
}

function realRuntime(sysctlDir: string): ForwardRuntime {
	return {
		dockerPorts: () => {
			const r = sh('docker', ['ps', '--format', '{{.Ports}}']);
			return r.ok ? r.out : null;
		},
		readForward: () => {
			try {
				return readFileSync('/proc/sys/net/ipv4/ip_forward', 'utf8').trim();
			} catch {
				return null;
			}
		},
		writeForward: () => sh('sysctl', ['-w', 'net.ipv4.ip_forward=1']).ok,
		sysctlFiles: () => {
			const out: Array<{ path: string; text: string }> = [];
			const add = (p: string): void => {
				try {
					out.push({ path: p, text: readFileSync(p, 'utf8') });
				} catch {
					/* unreadable: skip */
				}
			};
			add('/etc/sysctl.conf');
			try {
				for (const f of readdirSync(sysctlDir).sort())
					if (f.endsWith('.conf')) add(join(sysctlDir, f));
			} catch {
				/* no drop-in dir */
			}
			return out;
		},
		writeFile: (p, text) => {
			try {
				const tmp = `${p}.tmp-${process.pid}`;
				writeFileSync(tmp, text, { mode: 0o644 });
				renameSync(tmp, p);
				return true;
			} catch {
				return false;
			}
		},
		natDump: () => {
			const a = sh('iptables-save', ['-t', 'nat']);
			if (a.ok && /DNAT/.test(a.out)) return a.out;
			const b = sh('iptables', ['-t', 'nat', '-S']);
			if (b.ok && /DNAT/.test(b.out)) return b.out;
			return sh('nft', ['list', 'table', 'ip', 'nat']).out;
		},
		restartDocker: () => sh('systemctl', ['restart', 'docker'], 180_000).ok,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms))
	};
}
