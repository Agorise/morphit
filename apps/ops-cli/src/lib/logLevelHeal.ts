/**
 * Installed-box heal: the indexer's MORPHIT_LOG_LEVEL is one it knows.
 *
 * WHY. The indexer accepts debug / info / warn / error (any case). Anything
 * else used to be taken as-is; it now falls back to info and warns
 * `log_level_invalid` at every start. A box whose env file says, say,
 * `verbose` would log that warning for ever.
 *
 * WHAT, on this server: in the env files the indexer reads, a
 * MORPHIT_LOG_LEVEL that is not one of the four becomes `info` (only that
 * line changes; owner and mode kept); the indexer restarts; VERIFY: its
 * process has `info`, and its log since the restart has no
 * `log_level_invalid`. A valid value, or none, is left alone.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { HealCtx, HealResult } from './healTypes.ts';
import { keepOwnerAndMode } from './keepOwner.ts';

const KEY = 'MORPHIT_LOG_LEVEL';
const VALID = /^(debug|info|warn|error)$/i;

/** The text with every invalid MORPHIT_LOG_LEVEL set to info. PURE. */
export function fixLogLevel(text: string): { text: string; bad: string[] } {
	const bad: string[] = [];
	const out = text.replace(
		new RegExp(`^([ \\t]*(?:export[ \\t]+)?${KEY}[ \\t]*=[ \\t]*)(.*?)[ \\t]*$`, 'gm'),
		(line, prefix: string, raw: string) => {
			const v = raw.replace(/^(["'])(.*)\1$/, '$2');
			if (v === '' || VALID.test(v)) return line;
			bad.push(v);
			return `${prefix}info`;
		}
	);
	return { text: out, bad };
}

export interface LogLevelRuntime {
	readFile(p: string): string | null;
	writeFile(p: string, t: string): boolean;
	indexerActive(): boolean;
	restartIndexer(): boolean;
	processEnv(key: string): string | null;
	logSince(ms: number): string;
	now(): number;
	sleep(ms: number): Promise<void>;
}

export async function healLogLevel(
	ctx: HealCtx,
	opts: { runtime?: LogLevelRuntime; root?: string } = {}
): Promise<HealResult> {
	const rt = opts.runtime ?? realRuntime;
	const R = opts.root ?? '';
	const files = [
		`${R}/opt/morphit/morphit.env`,
		`${R}/opt/morphit/morphit.config.env`,
		`${R}/etc/morphit/indexer.env`
	];
	const changed: string[] = [];
	const bad: string[] = [];
	for (const f of files) {
		const t = rt.readFile(f);
		if (t === null) continue;
		const w = fixLogLevel(t);
		if (w.bad.length === 0) continue;
		if (!rt.writeFile(f, w.text) || fixLogLevel(rt.readFile(f) ?? '').bad.length > 0)
			return {
				strategy: 'left-alone',
				verified: false,
				detail: `Indexer log level: could not update ${f}; on this server set ${KEY}=info there and run: sudo systemctl restart morphit-indexer`
			};
		changed.push(f);
		bad.push(...w.bad);
	}
	if (changed.length === 0)
		return {
			strategy: 'already',
			verified: true,
			detail: `Indexer log level: ${KEY} is valid or unset.`
		};
	if (!rt.indexerActive())
		return {
			strategy: 'rewritten',
			verified: true,
			detail: `Indexer log level: "${bad.join('", "')}" → info in ${changed.join(', ')} (read back); the indexer is not running here.`
		};
	const t0 = rt.now();
	const stop = ctx.spinner('Restarting the indexer with a log level it knows…');
	let seen = false;
	try {
		rt.restartIndexer();
		for (let i = 0; i < 20 && !seen; i++) {
			await rt.sleep(1_500);
			seen = rt.processEnv(KEY) === 'info';
		}
	} finally {
		stop();
	}
	const warned = /log_level_invalid/.test(rt.logSince(t0));
	return seen && !warned
		? {
				strategy: 'rewritten',
				verified: true,
				detail: `Indexer log level: "${bad.join('", "')}" → info in ${changed.join(', ')}; the running indexer has info and no longer warns.`
			}
		: {
				strategy: 'rewritten',
				verified: false,
				detail: `Indexer log level: ${KEY}=info written in ${changed.join(', ')}, but the running indexer ${seen ? 'still warns log_level_invalid' : 'does not show it yet'}; on this server run: sudo systemctl restart morphit-indexer`
			};
}

/** The real entry `morphit-ops upgrade` calls (lib/healTypes.ts). */
export function heal(ctx: HealCtx): Promise<HealResult> {
	return healLogLevel(ctx);
}

const sh = (cmd: string, args: string[], timeout = 20_000) => {
	try {
		const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
		return { ok: r.status === 0, out: r.stdout ?? '' };
	} catch {
		return { ok: false, out: '' };
	}
};
const realRuntime: LogLevelRuntime = {
	readFile: (p) => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	},
	writeFile: (p, t) => {
		const tmp = `${p}.morphit-tmp`;
		try {
			writeFileSync(tmp, t, { mode: 0o640 });
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
			return hit === undefined ? null : hit.slice(key.length + 1);
		} catch {
			return null;
		}
	},
	logSince: (ms) =>
		sh('journalctl', [
			'-u',
			'morphit-indexer',
			'--since',
			`@${Math.floor(ms / 1000)}`,
			'--no-pager',
			'-o',
			'cat'
		]).out,
	now: () => Date.now(),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};
