/**
 * A setting `morphit-ops edit` (or `alt-address`) just wrote must not be
 * undone by a file the service reads AFTER it.
 *
 * WHY. The indexer sources /opt/morphit/morphit.env, then
 * /opt/morphit/morphit.config.env, then /etc/morphit/indexer.env; the relay
 * the same two, then /etc/morphit/relay.env. The last assignment wins. Since
 * v1.12.20 the operator-editable keys live only in morphit.config.env, but a
 * server installed before that still has the install-time copies in
 * indexer.env — and the Ansible files still carry the operator tag and the
 * Blurt node lists. Then an edit is written, the service is restarted, and
 * nothing changes: 2026-10-17, the contact was changed from a Matrix room to
 * an email address; the Operators page (the on-chain registration) showed the
 * email at once, the Instances card (the indexer's own setting) kept "Contact
 * via Matrix".
 *
 * WHAT. For every key just written, an assignment of it in a service's own
 * file is removed (a timestamped backup is kept next to the file), so the
 * value the operator chose is the one the service reads. One exception: an
 * EMPTY Blurt node list there is how a server that must not use public nodes
 * says so — it is kept, and named. After the restart, `confirmRunning` reads
 * the running service's environment and says whether it has the new values.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isHiddenOnlyEndpointSet } from '@morphit/hidden-transport';
import { keepOwnerAndMode } from './keepOwner.ts';
import { parseShellValue } from './offlineNotifyEnv.ts';

export type ServiceUnit = 'morphit-indexer' | 'morphit-relay';

export interface ServiceEnv {
	readonly unit: ServiceUnit;
	/** The files it sources, in order (last wins). */
	readonly files: readonly string[];
	/** Its own file: the last of `files`. */
	readonly own: string;
}

/** The files the installed units read (MORPHIT_ENV_ROOT: a test root). */
export const liveServiceEnvs = (): readonly ServiceEnv[] =>
	serviceEnvs(process.env.MORPHIT_ENV_ROOT ?? '');

/** The settings file `morphit-ops edit` writes, as the units read it. */
export const liveConfigPath = (): string =>
	`${process.env.MORPHIT_ENV_ROOT ?? ''}/opt/morphit/morphit.config.env`;

export function serviceEnvs(root = ''): readonly ServiceEnv[] {
	const shared = [`${root}/opt/morphit/morphit.env`, `${root}/opt/morphit/morphit.config.env`];
	return [
		{
			unit: 'morphit-indexer',
			files: [...shared, `${root}/etc/morphit/indexer.env`],
			own: `${root}/etc/morphit/indexer.env`
		},
		{
			unit: 'morphit-relay',
			files: [...shared, `${root}/etc/morphit/relay.env`],
			own: `${root}/etc/morphit/relay.env`
		}
	];
}

/** Settings `edit` / `alt-address` write that the relay reads at its start
 *  too: the site's name and addresses go into its offline notes
 *  (apps/relay/src/notify/config.ts), the origin into its links and CORS, and
 *  its own Blurt node list. Changing one restarts the relay as well. */
export const RELAY_READS: ReadonlySet<string> = new Set([
	'MORPHIT_INSTANCE_ORIGIN',
	'MORPHIT_INSTANCE_NAME',
	'MORPHIT_INSTANCE_BRAND_NAME',
	'MORPHIT_INSTANCE_TOR_ADDRESS',
	'MORPHIT_INSTANCE_I2P_B32_ADDRESS',
	'MORPHIT_INSTANCE_LOKINET_ADDRESS',
	'MORPHIT_RELAY_BLURT_RPC'
]);

/** Blurt node lists: kept in a service's own file when EMPTY there. */
export const NODE_LIST_KEYS: ReadonlySet<string> = new Set([
	'MORPHIT_INDEXER_RPC_ENDPOINTS',
	'MORPHIT_RELAY_BLURT_RPC'
]);

// The value starts right after `=`: for bash a blank there ends it (and a `#`
// after the blank starts a comment) — parseShellValue reads it that way.
const ASSIGN = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/;

/** `key`'s value across `texts` as the service's shell gets it (last
 *  assignment wins): quotes, `\x`, and a `# comment` after whitespace read as
 *  bash reads them (parseShellValue). undefined: never set; null: set, but to
 *  something only running the file would tell. PURE. */
export function envValue(texts: readonly string[], key: string): string | null | undefined {
	let v: string | null | undefined;
	for (const t of texts)
		for (const line of t.split('\n')) {
			const m = ASSIGN.exec(line);
			if (m && m[1] === key) v = parseShellValue(m[2] ?? '');
		}
	return v;
}

/** A Blurt node list that keeps a service off public nodes: empty, unknown
 *  (kept to be safe), or hidden-service nodes only (the relay's own rule). */
function noPublicNodes(v: string | null): boolean {
	if (v === null) return true;
	const list = v
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length === 0 || isHiddenOnlyEndpointSet(list, []);
}

/** The text without any assignment of `keys` (with or without `export`). PURE. */
export function withoutAssignments(
	text: string,
	keys: ReadonlySet<string>
): { readonly text: string; readonly removed: readonly string[] } {
	const removed: string[] = [];
	const kept = text.split('\n').filter((line) => {
		const m = ASSIGN.exec(line);
		if (m && keys.has(m[1]!)) {
			if (!removed.includes(m[1]!)) removed.push(m[1]!);
			return false;
		}
		return true;
	});
	return { text: kept.join('\n'), removed };
}

/** Which of `written` a service's own file assigns: removed, or kept (an
 *  empty Blurt node list). PURE. */
export function shadowPlan(
	written: Iterable<string>,
	ownText: string
): { readonly drop: readonly string[]; readonly keep: readonly string[] } {
	const drop: string[] = [];
	const keep: string[] = [];
	for (const k of written) {
		const v = envValue([ownText], k);
		if (v === undefined) continue;
		if (NODE_LIST_KEYS.has(k) && noPublicNodes(v)) keep.push(k);
		else drop.push(k);
	}
	return { drop, keep };
}

export interface ShadowFs {
	read(path: string): string | null;
	/** Atomic replace keeping owner and mode. */
	write(path: string, text: string): boolean;
	/** A copy next to it (0600); its path, or null. */
	backup(path: string): string | null;
}

export interface ShadowFixResult {
	readonly removed: ReadonlyArray<{
		readonly unit: ServiceUnit;
		readonly file: string;
		readonly keys: readonly string[];
		readonly backup: string;
	}>;
	readonly kept: ReadonlyArray<{
		readonly unit: ServiceUnit;
		readonly file: string;
		readonly key: string;
	}>;
	readonly failed: ReadonlyArray<{
		readonly unit: ServiceUnit;
		readonly file: string;
		readonly keys: readonly string[];
	}>;
}

/** Remove the assignments in each service's own file that would undo `written`. */
export function clearLaterShadows(
	written: Iterable<string>,
	opts: { fs?: ShadowFs; envs?: readonly ServiceEnv[] } = {}
): ShadowFixResult {
	const fs = opts.fs ?? realFs;
	const keys = [...written];
	const result: {
		removed: ShadowFixResult['removed'][number][];
		kept: ShadowFixResult['kept'][number][];
		failed: ShadowFixResult['failed'][number][];
	} = { removed: [], kept: [], failed: [] };
	for (const s of opts.envs ?? liveServiceEnvs()) {
		const text = fs.read(s.own);
		if (text === null) continue;
		const plan = shadowPlan(keys, text);
		for (const key of plan.keep) result.kept.push({ unit: s.unit, file: s.own, key });
		if (plan.drop.length === 0) continue;
		const next = withoutAssignments(text, new Set(plan.drop));
		const backup = fs.backup(s.own);
		const ok =
			backup !== null &&
			fs.write(s.own, next.text) &&
			shadowPlan(plan.drop, fs.read(s.own) ?? '').drop.length === 0;
		if (ok) result.removed.push({ unit: s.unit, file: s.own, keys: plan.drop, backup: backup! });
		else result.failed.push({ unit: s.unit, file: s.own, keys: plan.drop });
	}
	return result;
}

/** What to tell the operator about it, one line each (empty: nothing to say). */
export function describeShadowFix(r: ShadowFixResult): string[] {
	const lines: string[] = [];
	for (const x of r.removed)
		lines.push(
			`✓ removed the old ${x.keys.join(', ')} from ${x.file}, which the ${unitLabel(x.unit)} reads last and would have kept using (backup: ${x.backup})`
		);
	for (const x of r.kept)
		lines.push(
			`! ${x.file} sets ${x.key} empty: this server is set up not to use public Blurt nodes, so the ${unitLabel(x.unit)} keeps using none (left as it is)`
		);
	for (const x of r.failed)
		lines.push(
			`✗ could not remove ${x.keys.join(', ')} from ${x.file}; the ${unitLabel(x.unit)} reads that file last and keeps its old value. On this server delete those lines, then: sudo systemctl restart ${unitLabel(x.unit)}`
		);
	return lines;
}

export const unitLabel = (u: ServiceUnit): string => u.replace(/^morphit-/, '');

export interface RunningEnv {
	/** The running service's value of `key` (undefined: not set); null: unreadable. */
	processEnv(unit: ServiceUnit, key: string): string | undefined | null;
	sleep(ms: number): Promise<void>;
}

/**
 * After a restart: does each running service have, for every written key,
 * what its files now give it? Waits for the new process (its shell reads the
 * files before the service starts). `unreadable`: the environment could not
 * be read (not root, or the service is not running).
 */
export async function confirmRunning(
	units: readonly ServiceUnit[],
	written: Iterable<string>,
	opts: { fs?: ShadowFs; envs?: readonly ServiceEnv[]; runtime?: RunningEnv; tries?: number } = {}
): Promise<{
	readonly ok: boolean;
	readonly unreadable: boolean;
	readonly wrong: ReadonlyArray<{
		readonly unit: ServiceUnit;
		readonly key: string;
		readonly want: string | undefined;
		readonly got: string | undefined;
	}>;
}> {
	const fs = opts.fs ?? realFs;
	const rt = opts.runtime ?? realRunning;
	const keys = [...written];
	const want = new Map<string, string | null | undefined>();
	for (const s of (opts.envs ?? liveServiceEnvs()).filter((x) => units.includes(x.unit))) {
		const texts = s.files.map((f) => fs.read(f) ?? '');
		for (const k of keys) want.set(`${s.unit} ${k}`, envValue(texts, k));
	}
	const norm = (v: string | undefined): string => v ?? '';
	let wrong: Array<{
		unit: ServiceUnit;
		key: string;
		want: string | undefined;
		got: string | undefined;
	}> = [];
	let unreadable = false;
	const tries = opts.tries ?? 20;
	for (let i = 0; i < tries; i++) {
		if (i > 0) await rt.sleep(1_500);
		wrong = [];
		unreadable = false;
		for (const u of units)
			for (const k of keys) {
				const got = rt.processEnv(u, k);
				if (got === null) {
					unreadable = true;
					continue;
				}
				const w = want.get(`${u} ${k}`);
				// null: what the files give cannot be told without running them.
				if (w === null) continue;
				if (norm(got) !== norm(w)) wrong.push({ unit: u, key: k, want: w, got });
			}
		if (!unreadable && wrong.length === 0) return { ok: true, unreadable: false, wrong: [] };
	}
	return { ok: false, unreadable, wrong };
}

/**
 * For a command that has just written `written` and offers a restart: clear
 * the later copies, offer the restart (the relay too when its own file
 * changed), then say whether the running services have the new values.
 * Returns whether the restart happened.
 */
export async function restartWithWritten(
	written: readonly string[],
	units: readonly ServiceUnit[],
	deps: {
		offer: (units: readonly ServiceUnit[]) => Promise<boolean>;
		print: (line: string) => void;
		/** The files each service reads (default: the installed ones). */
		envs?: readonly ServiceEnv[];
		fs?: ShadowFs;
		runtime?: RunningEnv;
		/** Whether the running services' settings can be read (root). */
		canRead?: () => boolean;
	}
): Promise<boolean> {
	const shadow = clearLaterShadows(written, { envs: deps.envs, fs: deps.fs });
	const notes = describeShadowFix(shadow);
	for (const line of notes) deps.print(line);
	if (notes.length > 0) deps.print('');
	const all = [...units];
	for (const x of shadow.removed) if (!all.includes(x.unit)) all.push(x.unit);
	if (!all.includes('morphit-relay') && written.some((k) => RELAY_READS.has(k)))
		all.push('morphit-relay');
	const restarted = await deps.offer(all);
	const canRead =
		deps.canRead ?? (() => typeof process.getuid === 'function' && process.getuid() === 0);
	const envs = deps.envs ?? liveServiceEnvs();
	// A setting a service's own file keeps (an empty node list) is not what it
	// runs with: never confirmed as "the new settings".
	const check = written.filter((k) => !shadow.kept.some((x) => x.key === k));
	if (!restarted || check.length === 0 || !envs.some((e) => all.includes(e.unit)) || !canRead())
		return restarted;
	const r = await confirmRunning(all, check, {
		envs,
		fs: deps.fs,
		runtime: deps.runtime
	});
	if (r.ok) {
		deps.print(
			`✓ checked: the running ${all.map(unitLabel).join(' and ')} ${all.length === 1 ? 'uses' : 'use'} the new settings.`
		);
		deps.print('');
	} else if (r.wrong.length > 0) {
		for (const w of r.wrong)
			deps.print(
				`! the running ${unitLabel(w.unit)} still has ${w.key}=${w.got ?? '(not set)'} (its settings give ${w.want ?? '(not set)'}). On this server run: sudo systemctl restart ${unitLabel(w.unit)}`
			);
		deps.print('');
	}
	return restarted;
}

const sh = (cmd: string, args: string[]): string => {
	try {
		return spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 }).stdout ?? '';
	} catch {
		return '';
	}
};

const realRunning: RunningEnv = {
	processEnv: (unit, key) => {
		const pid = sh('systemctl', ['show', '-p', 'MainPID', '--value', unit]).trim();
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

const realFs: ShadowFs = {
	read: (p) => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	},
	write: (p, text) => {
		const tmp = `${p}.morphit-tmp`;
		try {
			writeFileSync(tmp, text, { mode: 0o600 });
			keepOwnerAndMode(p, tmp);
			renameSync(tmp, p);
			return true;
		} catch {
			return false;
		}
	},
	backup: (p) => {
		const b = `${p}.bak-${Date.now()}`;
		try {
			copyFileSync(p, b);
			chmodSync(b, 0o600);
			return b;
		} catch {
			return null;
		}
	}
};
