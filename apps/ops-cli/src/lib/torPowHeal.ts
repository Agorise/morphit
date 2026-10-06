/**
 * Installed-box heal: the node's onion service turns on Tor's proof-of-work
 * defence (Tor 0.4.8+ built with the "pow" module).
 *
 * WHY. Without it, a flood of introduction requests makes Tor build a
 * circuit for every one of them and starves real visitors of the .onion
 * site. With it, Tor asks clients for a small puzzle only while it is under
 * such a flood, so the flood costs the attacker; it costs nothing otherwise.
 *
 * WHAT, on this server: in /etc/tor/torrc, every onion service that serves
 * port 80 (Morphit's) gets `HiddenServicePoWDefensesEnabled 1` right after its
 * HiddenServicePort line, unless it already sets the option (an operator's 0
 * is kept). Only when this Tor has the module. The new file is first checked
 * with `tor --verify-config` (as the service runs it), then Tor reloads, and
 * VERIFY: Tor is still active and the file reads back with the option.
 * Otherwise nothing is written.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { keepOwnerAndMode } from './keepOwner.ts';

const POW = 'HiddenServicePoWDefensesEnabled 1';

/** torrc text with PoW added to each port-80 onion service that does not set
 *  the option. PURE. */
export function withPow(text: string): { text: string; added: number } {
	const lines = text.split('\n');
	const out: string[] = [];
	let added = 0;
	// Split into services: each starts at a HiddenServiceDir line.
	const starts = lines
		.map((l, i) => (/^\s*HiddenServiceDir\s/.test(l) ? i : -1))
		.filter((i) => i >= 0);
	const ends = starts.map((s, k) => {
		let e = k + 1 < starts.length ? starts[k + 1]! : lines.length;
		// A service's options run until the next HiddenServiceDir, or the first
		// non-HiddenService* option.
		for (let i = s + 1; i < e; i++)
			if (/^\s*[A-Za-z]/.test(lines[i]!) && !/^\s*HiddenService/.test(lines[i]!)) e = i;
		return e;
	});
	const insertAfter = new Set<number>();
	starts.forEach((s, k) => {
		const block = lines.slice(s, ends[k]);
		if (block.some((l) => /^\s*HiddenServicePoWDefensesEnabled\s/.test(l))) return;
		const port80 = block.findIndex((l) => /^\s*HiddenServicePort\s+80(\s|$)/.test(l));
		if (port80 < 0) return;
		let last = s;
		for (let i = s; i < ends[k]!; i++) if (/^\s*HiddenServicePort\s/.test(lines[i]!)) last = i;
		insertAfter.add(last);
	});
	lines.forEach((l, i) => {
		out.push(l);
		if (insertAfter.has(i)) {
			out.push(`${/^(\s*)/.exec(l)![1]}${POW}`);
			added++;
		}
	});
	return { text: out.join('\n'), added };
}

export interface PowRuntime {
	readTorrc(): string | null;
	writeTorrc(text: string): boolean;
	hasPowModule(): boolean;
	/** `tor --verify-config` on this text, as the service runs it. */
	verifies(text: string): { ok: boolean; out: string };
	reloadTor(): boolean;
	torActive(): boolean;
	sleep(ms: number): Promise<void>;
}

export async function healTorPow(
	ctx: HealCtx,
	opts: { runtime?: PowRuntime } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const text = rt.readTorrc();
	if (text === null)
		return {
			strategy: 'skipped',
			verified: true,
			routine: true,
			detail: 'Tor onion PoW: no /etc/tor/torrc on this server.'
		};
	const w = withPow(text);
	if (w.added === 0)
		return {
			strategy: 'already',
			verified: true,
			routine: true,
			detail: 'Tor onion PoW: nothing to add (set already, or no port-80 onion service).'
		};
	if (!rt.hasPowModule())
		return {
			strategy: 'skipped',
			verified: true,
			detail:
				'Tor onion PoW: this Tor is built without the proof-of-work module, so it was left as it is.'
		};
	const v = rt.verifies(w.text);
	if (!v.ok)
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Tor onion PoW: Tor did not accept the updated torrc (${
				v.out
					.split('\n')
					.find((l) => /warn|err/i.test(l))
					?.trim() ?? 'verify-config failed'
			}), so nothing was changed.`
		};
	if (!rt.writeTorrc(w.text))
		return {
			strategy: 'left-alone',
			verified: false,
			detail: 'Tor onion PoW: could not write /etc/tor/torrc; nothing was changed.'
		};
	const stop = ctx.spinner('Reloading Tor with the proof-of-work defence…');
	try {
		rt.reloadTor();
		await rt.sleep(3_000);
	} finally {
		stop();
	}
	const ok = rt.torActive() && rt.readTorrc() === w.text;
	if (!ok) {
		rt.writeTorrc(text);
		rt.reloadTor();
	}
	return ok
		? {
				strategy: 'applied',
				verified: true,
				detail:
					'Tor onion PoW: on for the onion service (torrc read back, Tor running after its reload).'
			}
		: {
				strategy: 'reverted',
				verified: false,
				detail:
					'Tor onion PoW: Tor was not running after the reload, so the previous torrc was put back. On this server run: sudo systemctl status tor'
			};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healTorPow(ctx);
}

const TORRC = '/etc/tor/torrc';
const DEFAULTS = '/usr/share/tor/tor-service-defaults-torrc';
const realRuntime: PowRuntime = {
	readTorrc: () => {
		try {
			return readFileSync(TORRC, 'utf8');
		} catch {
			return null;
		}
	},
	writeTorrc: (t) => {
		const tmp = `${TORRC}.morphit-tmp`;
		try {
			writeFileSync(tmp, t, { mode: 0o644 });
			keepOwnerAndMode(TORRC, tmp);
			renameSync(tmp, TORRC);
			return true;
		} catch {
			return false;
		}
	},
	hasPowModule: () =>
		/^pow: yes$/m.test(spawnSync('tor', ['--list-modules'], { encoding: 'utf8' }).stdout ?? ''),
	verifies: (t) => {
		const d = mkdtempSync(join(tmpdir(), 'torrc-'));
		try {
			writeFileSync(join(d, 'torrc'), t);
			const r = spawnSync(
				'tor',
				['--defaults-torrc', DEFAULTS, '--verify-config', '-f', join(d, 'torrc')],
				{ encoding: 'utf8', timeout: 30_000 }
			);
			return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	},
	reloadTor: () => spawnSync('systemctl', ['reload', 'tor'], { timeout: 30_000 }).status === 0,
	torActive: () => spawnSync('systemctl', ['is-active', '--quiet', 'tor']).status === 0,
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};
