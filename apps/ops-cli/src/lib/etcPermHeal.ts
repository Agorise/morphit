/**
 * Installed-box heal: /etc/morphit is root:morphit 0750 again.
 *
 * WHY. The base and hardening roles make it root:morphit 0750 (the services'
 * group reads the env files and the keystore inside; nobody else may even list
 * them), but the ipfs role, which runs later, set it back to root:root 0755 on
 * every converge — so on most Ansible boxes any local user could list it.
 *
 * WHAT, on this server: when the directory exists and the `morphit` group
 * does, set owner root, group morphit, mode 0750 — never following a link —
 * and VERIFY with stat. The files inside are not touched (the services' own
 * pre-start helper keeps those).
 */
import { chmodSync, chownSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { HealCtx, HealResult } from './healTypes.ts';

export interface EtcPermRuntime {
	/** uid, gid, mode bits, or null when absent; isDir false for anything but a real directory. */
	stat(path: string): { uid: number; gid: number; mode: number; isDir: boolean } | null;
	gid(group: string): number | null;
	set(path: string, uid: number, gid: number, mode: number): boolean;
}

export async function healEtcMorphitPerms(
	_ctx: HealCtx,
	opts: { runtime?: EtcPermRuntime; path?: string; group?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const p = opts.path ?? '/etc/morphit';
	const group = opts.group ?? 'morphit';
	const st = rt.stat(p);
	if (st === null)
		return { strategy: 'skipped', verified: true, detail: `${p}: not on this server.` };
	if (!st.isDir)
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `${p} is not a plain directory (a link?), so it was left alone; on this server check: ls -ld ${p}`
		};
	const gid = rt.gid(group);
	if (gid === null)
		return {
			strategy: 'skipped',
			verified: true,
			detail: `${p}: no '${group}' group on this server (a manual install); left as it is.`
		};
	const good = (s: typeof st): boolean =>
		s !== null && s.uid === 0 && s.gid === gid && (s.mode & 0o777) === 0o750;
	if (good(st))
		return { strategy: 'already', verified: true, detail: `${p} is root:${group} 0750.` };
	const before = `${st.uid === 0 ? 'root' : st.uid}:${st.gid === gid ? group : st.gid} ${(st.mode & 0o777).toString(8).padStart(4, '0')}`;
	rt.set(p, 0, gid, 0o750);
	const after = rt.stat(p);
	return after !== null && good(after)
		? {
				strategy: 'fixed',
				verified: true,
				detail: `${p}: ${before} → root:${group} 0750 (read back with stat).`
			}
		: {
				strategy: 'left-alone',
				verified: false,
				detail: `${p} is still ${before}; on this server run: sudo chown root:${group} ${p} && sudo chmod 0750 ${p}`
			};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healEtcMorphitPerms(ctx);
}

const realRuntime: EtcPermRuntime = {
	stat: (p) => {
		try {
			const s = lstatSync(p);
			return {
				uid: s.uid,
				gid: s.gid,
				mode: s.mode,
				isDir: s.isDirectory() && !s.isSymbolicLink()
			};
		} catch {
			return null;
		}
	},
	gid: (g) => {
		const r = spawnSync('getent', ['group', g], { encoding: 'utf8' });
		const n = Number((r.stdout ?? '').split(':')[2]);
		return r.status === 0 && Number.isInteger(n) ? n : null;
	},
	set: (p, uid, gid, mode) => {
		try {
			// lstat above confirmed a real directory; chown/chmod act on it.
			chownSync(p, uid, gid);
			chmodSync(p, mode);
			return true;
		} catch {
			return false;
		}
	}
};
