/**
 * Installed-box heal: an Ansible install's /etc/morphit/indexer.env stops
 * silently undoing the operator's asset and payment-method choices.
 *
 * WHY. indexer.env.j2 always wrote
 *   MORPHIT_INDEXER_DISABLED_ASSETS=
 *   MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS=
 * and the indexer unit reads /etc/morphit/indexer.env AFTER
 * /opt/morphit/morphit.config.env, so a value an operator set there (as the
 * docs say) was replaced by "nothing disabled" at every start.
 *
 * WHAT, on this server: an EMPTY assignment of either key in
 * /etc/morphit/indexer.env is removed (a non-empty one is the operator's or
 * group_vars' choice: kept, and named when morphit.config.env says otherwise).
 * When that changes what the indexer gets, it restarts and VERIFY: the
 * running process has the value morphit.config.env sets. Otherwise the file
 * is read back.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { HealCtx, HealResult } from './healTypes.ts';
import { keepOwnerAndMode } from './keepOwner.ts';

export const SHADOW_KEYS = [
	'MORPHIT_INDEXER_DISABLED_ASSETS',
	'MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS'
] as const;

const FILES = (root: string) => ({
	before: [`${root}/opt/morphit/morphit.env`, `${root}/opt/morphit/morphit.config.env`],
	indexer: `${root}/etc/morphit/indexer.env`
});

const valueIn = (texts: readonly string[], key: string): string | undefined => {
	let v: string | undefined;
	const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`, 'gm');
	for (const t of texts)
		for (const m of t.matchAll(re)) v = (m[1] ?? '').replace(/^(["'])(.*)\1$/, '$2');
	return v;
};

/** The text without empty assignments of SHADOW_KEYS. PURE. */
export function withoutEmptyShadows(text: string): { text: string; removed: string[] } {
	const removed: string[] = [];
	const lines = text.split('\n').filter((l) => {
		const m = /^[ \t]*(?:export[ \t]+)?([A-Z_]+)[ \t]*=[ \t]*(""|'')?[ \t]*$/.exec(l);
		if (m && (SHADOW_KEYS as readonly string[]).includes(m[1]!)) {
			removed.push(m[1]!);
			return false;
		}
		return true;
	});
	return { text: lines.join('\n'), removed };
}

export interface ShadowRuntime {
	readFile(path: string): string | null;
	writeFile(path: string, text: string): boolean;
	indexerActive(): boolean;
	restartIndexer(): boolean;
	/** The running indexer's value of `key` (undefined: not set). null: unreadable. */
	processEnv(key: string): string | undefined | null;
	sleep(ms: number): Promise<void>;
}

export async function healIndexerEnvShadow(
	ctx: HealCtx,
	opts: { runtime?: ShadowRuntime; root?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const f = FILES(opts.root ?? '');
	const text = rt.readFile(f.indexer);
	if (text === null)
		return {
			strategy: 'skipped',
			verified: true,
			routine: true,
			detail: 'Indexer asset policy: no /etc/morphit/indexer.env on this server.'
		};
	const before = f.before.map((p) => rt.readFile(p) ?? '');
	const wanted = new Map(SHADOW_KEYS.map((k) => [k, valueIn(before, k) ?? ''] as const));
	const effectiveBefore = new Map(
		SHADOW_KEYS.map((k) => [k, valueIn([...before, text], k) ?? ''] as const)
	);
	const notes: string[] = [];
	for (const k of SHADOW_KEYS) {
		const own = valueIn([text], k);
		if (own !== undefined && own !== '' && own !== wanted.get(k) && wanted.get(k) !== '')
			notes.push(
				`${k}=${own} in ${f.indexer} overrides ${wanted.get(k)} in morphit.config.env (left as it is: remove one of them on this server)`
			);
	}
	const w = withoutEmptyShadows(text);
	if (w.removed.length === 0)
		return {
			strategy: 'already',
			verified: true,
			routine: notes.length === 0,
			detail: `Indexer asset policy: nothing in ${f.indexer} undoes it${notes.length ? `; ${notes.join('; ')}` : ''}.`
		};
	if (
		!rt.writeFile(f.indexer, w.text) ||
		withoutEmptyShadows(rt.readFile(f.indexer) ?? '').removed.length > 0
	)
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Indexer asset policy: could not remove the empty ${w.removed.join(', ')} line(s) from ${f.indexer}; on this server delete them and run: sudo systemctl restart morphit-indexer`
		};
	const changes = SHADOW_KEYS.filter(
		(k) => (effectiveBefore.get(k) ?? '') !== (wanted.get(k) ?? '')
	);
	const done = `the empty ${w.removed.join(', ')} line(s) removed from ${f.indexer} (read back)`;
	if (changes.length === 0 || !rt.indexerActive())
		return {
			strategy: 'removed',
			verified: true,
			detail: `Indexer asset policy: ${done}; ${changes.length === 0 ? 'nothing the indexer uses changes' : 'it takes effect when the indexer starts'}${notes.length ? `; ${notes.join('; ')}` : ''}.`
		};
	const stop = ctx.spinner(
		'Restarting the indexer so your asset and payment-method choices apply…'
	);
	let seen = false;
	try {
		rt.restartIndexer();
		for (let i = 0; i < 20 && !seen; i++) {
			await rt.sleep(1_500);
			seen = changes.every((k) => (rt.processEnv(k) ?? '') === wanted.get(k));
		}
	} finally {
		stop();
	}
	return {
		strategy: 'removed-restarted',
		verified: seen,
		detail: seen
			? `Indexer asset policy: ${done}; the running indexer now has ${changes.map((k) => `${k}=${wanted.get(k)}`).join(', ')} from morphit.config.env.`
			: `Indexer asset policy: ${done}, but the running indexer does not show ${changes.join(', ')} yet; on this server run: sudo systemctl restart morphit-indexer`
	};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healIndexerEnvShadow(ctx);
}

const sh = (cmd: string, args: string[], timeout = 20_000): { ok: boolean; out: string } => {
	try {
		const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
		return { ok: r.status === 0, out: r.stdout ?? '' };
	} catch {
		return { ok: false, out: '' };
	}
};

const realRuntime: ShadowRuntime = {
	readFile: (p) => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	},
	writeFile: (p, text) => {
		const tmp = `${p}.morphit-tmp`;
		try {
			writeFileSync(tmp, text, { mode: 0o640 });
			keepOwnerAndMode(p, tmp);
			renameSync(tmp, p);
			return true;
		} catch {
			return false;
		}
	},
	indexerActive: () => sh('systemctl', ['is-active', '--quiet', 'morphit-indexer']).ok,
	restartIndexer: () => sh('systemctl', ['restart', 'morphit-indexer'], 120_000).ok,
	processEnv: (key) => {
		const pid = sh('systemctl', ['show', '-p', 'MainPID', '--value', 'morphit-indexer']).out.trim();
		if (!/^[1-9]\d*$/.test(pid)) return null;
		try {
			const hit = readFileSync(`/proc/${pid}/environ`, 'utf8')
				.split('\0')
				.find((e) => e.startsWith(`${key}=`));
			return hit === undefined ? undefined : hit.slice(key.length + 1);
		} catch {
			return null;
		}
	},
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};
