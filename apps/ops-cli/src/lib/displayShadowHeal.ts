/**
 * Installed-box heal: the site's own Instances card shows the name, tagline,
 * contact link and addresses in morphit.config.env — not an install-time copy
 * in /etc/morphit/indexer.env.
 *
 * WHY. Before v1.12.20 the Ansible indexer.env carried MORPHIT_INSTANCE_NAME,
 * _TAGLINE and _CONTACT_URL, and the indexer reads that file after
 * morphit.config.env (last wins). The template stopped writing them; the
 * servers installed before kept the copies. `morphit-ops edit` and the
 * on-chain registration both use morphit.config.env, so the Operators page
 * (the registration) showed one contact and the Instances card (the indexer)
 * another.
 *
 * WHAT, on this server: each of those settings that BOTH files set is removed
 * from indexer.env (a backup is kept next to it), so morphit.config.env — the
 * file the operator edits — decides. A setting only indexer.env has is left
 * where it is (removing it would lose it). When that changes what the indexer
 * uses, it restarts and VERIFY: the running process has the morphit.config.env
 * values. Otherwise the file is read back.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { HealCtx, HealResult } from './healTypes.ts';
import {
	clearLaterShadows,
	confirmRunning,
	envValue,
	serviceEnvs,
	type RunningEnv,
	type ShadowFs
} from './laterEnvShadow.ts';

/** What the site shows about itself, set with `morphit-ops edit` / `alt-address`. */
export const DISPLAY_KEYS = [
	'MORPHIT_INSTANCE_NAME',
	'MORPHIT_INSTANCE_BRAND_NAME',
	'MORPHIT_INSTANCE_TAGLINE',
	'MORPHIT_INSTANCE_CONTACT_URL',
	'MORPHIT_INSTANCE_TOR_ADDRESS',
	'MORPHIT_INSTANCE_LOKINET_ADDRESS',
	'MORPHIT_INSTANCE_I2P_ADDRESS',
	'MORPHIT_INSTANCE_I2P_B32_ADDRESS',
	'MORPHIT_INSTANCE_I2P_NAME_ADDRESS',
	'MORPHIT_INSTANCE_NOSTR_PUBKEY',
	'MORPHIT_INSTANCE_ENS_NAME',
	'MORPHIT_INSTANCE_SEO_TITLE',
	'MORPHIT_INSTANCE_SEO_DESCRIPTION',
	'MORPHIT_INSTANCE_SEO_KEYWORDS'
] as const;

export interface DisplayShadowRuntime {
	readonly fs?: ShadowFs;
	readonly running?: RunningEnv;
	indexerActive(): boolean;
	restartIndexer(): boolean;
}

export async function healDisplayShadow(
	ctx: HealCtx,
	opts: { runtime?: DisplayShadowRuntime; root?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const read = (p: string): string | null => (rt.fs ? rt.fs.read(p) : realFsRead(p));
	const indexer = serviceEnvs(opts.root ?? process.env.MORPHIT_ENV_ROOT ?? '').filter(
		(s) => s.unit === 'morphit-indexer'
	);
	const s = indexer[0]!;
	const own = read(s.own);
	if (own === null)
		return {
			strategy: 'skipped',
			verified: true,
			routine: true,
			detail: `Instances card settings: no ${s.own} on this server.`
		};
	const before = s.files.slice(0, -1).map((f) => read(f) ?? '');
	const keys = DISPLAY_KEYS.filter(
		(k) => envValue([own], k) !== undefined && envValue(before, k) !== undefined
	);
	if (keys.length === 0)
		return {
			strategy: 'already',
			verified: true,
			routine: true,
			detail: `Instances card settings: nothing in ${s.own} overrides morphit.config.env.`
		};
	const changes = keys.filter((k) => envValue([own], k) !== envValue(before, k));
	const r = clearLaterShadows(keys, { envs: indexer, fs: rt.fs });
	if (r.removed.length === 0)
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Instances card settings: could not remove ${keys.join(', ')} from ${s.own}, which overrides morphit.config.env; on this server delete those lines, then run: sudo systemctl restart morphit-indexer`
		};
	const done = `removed the old ${keys.join(', ')} from ${s.own} (backup ${r.removed[0]!.backup})`;
	if (changes.length === 0 || !rt.indexerActive())
		return {
			strategy: 'removed',
			verified: true,
			detail: `Instances card settings: ${done}; ${changes.length === 0 ? 'nothing the indexer uses changes' : 'it takes effect when the indexer starts'}.`
		};
	const stop = ctx.spinner('Restarting the indexer so your Instances card shows your settings…');
	let ok = false;
	try {
		rt.restartIndexer();
		ok = (
			await confirmRunning(['morphit-indexer'], changes, {
				envs: indexer,
				fs: rt.fs,
				runtime: rt.running
			})
		).ok;
	} finally {
		stop();
	}
	return {
		strategy: 'removed-restarted',
		verified: ok,
		detail: ok
			? `Instances card settings: ${done}; the running indexer now uses ${changes.join(', ')} from morphit.config.env.`
			: `Instances card settings: ${done}, but the running indexer does not show ${changes.join(', ')} from morphit.config.env yet; on this server run: sudo systemctl restart morphit-indexer`
	};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healDisplayShadow(ctx);
}

const realFsRead = (p: string): string | null => {
	try {
		return readFileSync(p, 'utf8');
	} catch {
		return null;
	}
};

const sh = (args: string[], timeout = 20_000): boolean => {
	try {
		return spawnSync('systemctl', args, { timeout }).status === 0;
	} catch {
		return false;
	}
};

const realRuntime: DisplayShadowRuntime = {
	indexerActive: () => sh(['is-active', '--quiet', 'morphit-indexer']),
	restartIndexer: () => sh(['restart', 'morphit-indexer'], 120_000)
};
