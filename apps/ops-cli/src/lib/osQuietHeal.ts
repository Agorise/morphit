/**
 * Installed-box heal: the operating system's own fetches that a server does
 * not need are off on every node, clearnet ones too.
 *
 * WHY. Morphit relies on no third party unless it is strictly needed. Ubuntu
 * fetches the login banner's news from motd.ubuntu.com, apt's Ubuntu Pro news at
 * every refresh, firmware metadata from cdn.fwupd.org every day, and at boot
 * pollinate asks entropy.ubuntu.com for randomness. None of them is needed on a
 * server. (apt's updates and the clock stay; a tor-only node already gets all
 * of this, and more, over Tor.)
 *
 * WHAT, on this server: the same scripts and modes the Ansible hardening role
 * runs (roles/hardening/tasks/quiet-os.yml): ops/tor-only/morphit-tor-only-os.sh
 * news-check / news-apply, and ops/tor-only/morphit-tor-egress.sh quiet-check /
 * quiet-apply (fwupd-refresh and pollinate masked; snapd and Ubuntu Pro's timer
 * are left alone, as installed snaps and an attached Pro subscription need
 * them). VERIFY: each check is run again after the apply and reads the live
 * state (the motd-news file, `pro config`, `systemctl is-enabled`). FALL BACK:
 * a part whose check still fails is reverted from its backup and named.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';

export interface QuietRuntime {
	/** Run one of the two scripts in a mode; its exit status. */
	run(script: 'os' | 'egress', mode: string, backupDir?: string): number;
	scriptsPresent(): boolean;
	backupDir(part: string): string | null;
}

const PARTS = [
	{
		script: 'os' as const,
		check: 'news-check',
		apply: 'news-apply',
		revert: 'news-revert',
		what: 'motd news and Ubuntu Pro apt news'
	},
	{
		script: 'egress' as const,
		check: 'quiet-check',
		apply: 'quiet-apply',
		revert: 'quiet-revert',
		what: "fwupd's firmware-metadata refresh and pollinate"
	}
];

export async function healOsQuiet(
	ctx: HealCtx,
	opts: { runtime?: QuietRuntime } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	if (!rt.scriptsPresent())
		return {
			strategy: 'skipped',
			verified: false,
			detail: 'OS fetches: the release has no ops/tor-only scripts here, so nothing was checked.'
		};
	const done: string[] = [];
	const already: string[] = [];
	const left: string[] = [];
	const stop = ctx.spinner('Turning off the OS fetches a server does not need…');
	try {
		for (const p of PARTS) {
			if (rt.run(p.script, p.check) === 0) {
				already.push(p.what);
				continue;
			}
			const bk = rt.backupDir(p.apply);
			if (!bk) {
				left.push(`${p.what} (no place for a backup)`);
				continue;
			}
			rt.run(p.script, p.apply, bk);
			if (rt.run(p.script, p.check) === 0) done.push(p.what);
			else {
				rt.run(p.script, p.revert, bk);
				left.push(p.what);
			}
		}
	} finally {
		stop();
	}
	if (left.length > 0)
		return {
			strategy: done.length > 0 ? 'partial' : 'left-alone',
			verified: false,
			detail: `OS fetches: ${done.length > 0 ? `${done.join(' and ')} now off (read back); ` : ''}${left.join(' and ')} could not be turned off and were put back as they were. On this server, see why with: sudo sh /opt/morphit/ops/tor-only/morphit-tor-only-os.sh news-check; sudo sh /opt/morphit/ops/tor-only/morphit-tor-egress.sh quiet-check`
		};
	return done.length > 0
		? {
				strategy: 'applied',
				verified: true,
				detail: `OS fetches: ${done.join(' and ')} now off (read back on this server).`
			}
		: {
				strategy: 'already',
				verified: true,
				routine: true,
				detail: `OS fetches: ${already.join(' and ')} already off.`
			};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healOsQuiet(ctx);
}

const root = (): string => {
	const m = /^(.*)\/apps\/ops-cli\/(?:dist|src)\//.exec(process.argv[1] ?? '');
	const env = (process.env.MORPHIT_INSTALL_DIR ?? '').trim();
	return env || (m && m[1] && existsSync(join(m[1], 'ops')) ? m[1] : '/opt/morphit');
};
const path = (s: 'os' | 'egress'): string =>
	join(root(), 'ops/tor-only', s === 'os' ? 'morphit-tor-only-os.sh' : 'morphit-tor-egress.sh');
const realRuntime: QuietRuntime = {
	run: (s, mode, bk) =>
		spawnSync('sh', [path(s), mode, ...(bk ? [bk] : [])], { stdio: 'ignore', timeout: 120_000 })
			.status ?? 1,
	scriptsPresent: () => existsSync(path('os')) && existsSync(path('egress')),
	backupDir: (part) => {
		const d = `/var/lib/morphit-quiet-os/${part}-${Date.now()}`;
		try {
			mkdirSync(d, { recursive: true, mode: 0o700 });
			return d;
		} catch {
			return null;
		}
	}
};
