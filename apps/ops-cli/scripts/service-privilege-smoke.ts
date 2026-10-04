/**
 * service-privilege-smoke.
 *
 * The `morphit` service user (and anything else that is not root) must not be
 * able to become root through Morphit's own units:
 *
 *  1. Every unit in ops/systemd that runs a command as root — a root unit's
 *     ExecStart*, or any `+`-prefixed command — must only execute, source or
 *     read config from paths that the Ansible roles leave root-owned. A path
 *     inside a tree a role hands to another owner (a `file`/`copy`/`template`
 *     task with a non-root `owner:`, recursively or not, or a `git` clone run
 *     as another user) is a way to root: replace the file, wait for the timer.
 *  2. The internet-facing services (indexer, relay) run as their own non-root
 *     user, with no capabilities, NoNewPrivileges and a read-only system.
 *  3. The install role installs dependencies with --ignore-scripts, as root
 *     over a root-owned tree (no npm step runs as the service user).
 *
 * Reads the real files (units, every role's tasks, group_vars) — no Ansible run.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO } from './ansible-template-render.ts';
import { SERVICES } from '../src/lib/unitPrivilegeHeal.ts';
import { INDEXER_HONEST_PEAK_MIB, INDEXER_MEMORY_MAX_BYTES } from '../src/lib/indexerMemoryHeal.ts';

const yaml = createRequire(import.meta.url)('js-yaml') as { load(s: string): unknown };

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

// ── group_vars, for the paths the tasks name ────────────────────────────
const gv = yaml.load(readFileSync(join(REPO, 'ops/ansible/group_vars/all.yml'), 'utf8')) as Record<
	string,
	unknown
>;
const vars: Record<string, string> = {};
for (const [k, v] of Object.entries(gv)) if (typeof v === 'string') vars[k] = v;
const resolve = (s: string): string => {
	let out = s;
	for (let i = 0; i < 5; i++)
		out = out.replace(/\{\{\s*([a-z0-9_]+)(?:\s*\|[^}]*)?\s*\}\}/gi, (m, name: string) =>
			name in vars ? vars[name]! : m
		);
	return out;
};
const ROOTISH = new Set(['root', '0', '']);

// ── 1a. every path an Ansible task hands to a non-root owner ────────────
interface Handed {
	readonly path: string;
	readonly recurse: boolean;
	readonly owner: string;
	readonly where: string;
}
const handed: Handed[] = [];
const rolesDir = join(REPO, 'ops/ansible/roles');
const walkTasks = (list: unknown, where: string): void => {
	if (!Array.isArray(list)) return;
	for (const t of list as Array<Record<string, unknown>>) {
		if (!t || typeof t !== 'object') continue;
		for (const k of ['block', 'rescue', 'always']) walkTasks(t[k], where);
		const becomeUser = typeof t.become_user === 'string' ? resolve(t.become_user) : 'root';
		for (const [mod, args] of Object.entries(t)) {
			const m = /^(?:ansible\.builtin\.)?(file|copy|template|git|unarchive|get_url)$/.exec(mod);
			if (!m || !args || typeof args !== 'object') continue;
			const a = args as Record<string, unknown>;
			const dest = resolve(String(a.path ?? a.dest ?? ''));
			if (!dest.startsWith('/')) continue;
			const owner = resolve(String(a.owner ?? (becomeUser !== 'root' ? becomeUser : 'root')));
			if (ROOTISH.has(owner)) continue;
			handed.push({
				path: dest.replace(/\/+$/, ''),
				recurse: a.recurse === true || m[1] === 'git' || m[1] === 'unarchive',
				owner,
				where: `${where}: ${String(t.name ?? mod)}`
			});
		}
	}
};
for (const role of readdirSync(rolesDir)) {
	let files: string[] = [];
	try {
		files = readdirSync(join(rolesDir, role, 'tasks')).filter((f) => /\.ya?ml$/.test(f));
	} catch {
		continue;
	}
	for (const f of files)
		walkTasks(
			yaml.load(readFileSync(join(rolesDir, role, 'tasks', f), 'utf8')),
			`roles/${role}/tasks/${f}`
		);
}

/** Who but root can change `p` (or a directory on its way): the task, or null. */
const writableByOther = (p: string): Handed | null => {
	for (const h of handed) {
		if (p === h.path) return h;
		// A directory another user owns: they can rename any entry directly in it.
		if (p.startsWith(`${h.path}/`) && (h.recurse || !p.slice(h.path.length + 1).includes('/')))
			return h;
	}
	return null;
};

// ── 1b. what root runs, sources or reads in each unit ───────────────────
const unitDir = join(REPO, 'ops/systemd');
const units = readdirSync(unitDir).filter((f) => f.endsWith('.service'));
const svcLines = (text: string): Array<[string, string]> => {
	const out: Array<[string, string]> = [];
	let joined = '';
	for (const raw of text.split('\n')) {
		const line = joined + raw;
		if (line.endsWith('\\')) {
			joined = `${line.slice(0, -1)} `;
			continue;
		}
		joined = '';
		const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
		if (m) out.push([m[1]!, m[2]!]);
	}
	return out;
};
/** Absolute paths a command line runs or reads: the executable, and inside an
 *  inline shell script every absolute path it names. */
const pathsOf = (cmd: string): string[] =>
	[...cmd.matchAll(/(?:^|[\s'"=;(])(\/(?:opt|etc|var|usr|srv|home|root)\/[^\s'";)]*)/g)].map((m) =>
		m[1]!.replace(/\/+$/, '')
	);
for (const u of units) {
	const lines = svcLines(readFileSync(join(unitDir, u), 'utf8'));
	const get = (k: string): string | null =>
		[...lines].reverse().find(([x]) => x === k)?.[1] ?? null;
	const user = get('User') ?? (get('DynamicUser') === 'true' ? 'dynamic' : 'root');
	const rootRuns: string[] = [];
	for (const [k, v] of lines) {
		if (!/^Exec(Start|StartPre|StartPost|Reload|Stop|StopPost|Condition)$/.test(k)) continue;
		const prefix = /^[-@:+!]*/.exec(v)![0];
		if (ROOTISH.has(user) || prefix.includes('+'))
			rootRuns.push(...pathsOf(v.slice(prefix.length)));
	}
	if (ROOTISH.has(user)) {
		for (const [k, v] of lines)
			if (k === 'EnvironmentFile' || k === 'WorkingDirectory')
				rootRuns.push(v.replace(/^-/, '').replace(/\/+$/, ''));
	}
	const bad = [...new Set(rootRuns)]
		.map((p) => [p, writableByOther(p)] as const)
		.filter(([, h]) => h !== null);
	check(
		`${u}: nothing root runs, sources or reads here can be changed by another user`,
		bad.length === 0,
		bad.map(([p, h]) => `${p} (${h!.owner}: ${h!.where})`).join('; ')
	);
}

// ── 1b. the indexer's memory is capped above what it really uses ─────────
// systemd's size suffixes are base 1024 (K, M, G, T); "infinity" or no
// MemoryMax at all means no cap.
const memBytes = (v: string | null): number => {
	const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/.exec((v ?? '').trim());
	if (!m) return Number.POSITIVE_INFINITY;
	return Number(m[1]) * 1024 ** ' KMGT'.indexOf(m[2] || ' ');
};
{
	const lines = svcLines(readFileSync(join(unitDir, 'morphit-indexer.service'), 'utf8'));
	const max = memBytes([...lines].reverse().find(([x]) => x === 'MemoryMax')?.[1] ?? null);
	check(
		'morphit-indexer.service: its memory is capped (MemoryMax)',
		Number.isFinite(max),
		'no MemoryMax: a burst of large requests can take the whole box'
	);
	check(
		`morphit-indexer.service: the cap leaves room above its measured honest peak (${INDEXER_HONEST_PEAK_MIB} MiB, ×1.5)`,
		max >= INDEXER_HONEST_PEAK_MIB * 1024 * 1024 * 1.5,
		String(max)
	);
	check(
		'the installed-box heal sets the same cap as the shipped unit',
		max === INDEXER_MEMORY_MAX_BYTES,
		`${max} vs ${INDEXER_MEMORY_MAX_BYTES}`
	);
}

// ── 2. the internet-facing services ─────────────────────────────────────
for (const [u, name] of [
	['morphit-indexer.service', 'morphit-indexer'],
	['morphit-relay.service', 'morphit-relay']
] as const) {
	const lines = svcLines(readFileSync(join(unitDir, u), 'utf8'));
	const get = (k: string): string | null =>
		[...lines].reverse().find(([x]) => x === k)?.[1] ?? null;
	check(`${u}: runs as ${name}`, get('User') === name && get('Group') === name);
	check(
		`${u}: no capabilities`,
		get('CapabilityBoundingSet') === '' && get('AmbientCapabilities') === ''
	);
	check(
		`${u}: NoNewPrivileges, read-only system (ProtectSystem=strict), its own state directory`,
		get('NoNewPrivileges') === 'yes' &&
			get('ProtectSystem') === 'strict' &&
			get('StateDirectory') === name
	);
}
{
	const base = readFileSync(join(REPO, 'ops/ansible/roles/base/tasks/main.yml'), 'utf8');
	const tasks = yaml.load(base) as Array<Record<string, any>>;
	for (const name of ['morphit-indexer', 'morphit-relay']) {
		const user = tasks.find((t) => t['ansible.builtin.user']?.name === name)?.[
			'ansible.builtin.user'
		];
		check(
			`base role creates ${name} (no shell, in the service group only)`,
			!!user &&
				user.shell === '/usr/sbin/nologin' &&
				user.system === true &&
				resolve(String(user.groups)) === vars.morphit_service_group
		);
	}
}

// ── 2b. the root pre-start helper and the heal know the same env files ──
{
	const helper = readFileSync(join(REPO, 'ops/scripts/morphit-service-perms.sh'), 'utf8');
	for (const s of SERVICES) {
		const unit = readFileSync(join(unitDir, s.unit), 'utf8');
		const sourced = /for f in ([^;]+); do/.exec(unit)?.[1]?.trim().split(/\s+/) ?? [];
		const inHelper =
			new RegExp(`\\n\\t${s.role}\\)\\n\\t\\tFILES=\\(([^)]*)\\)`)
				.exec(helper)?.[1]
				?.trim()
				.split(/\s+/) ?? [];
		check(
			`${s.unit}: the files it sources = the pre-start helper's list = the heal's list`,
			sourced.length > 0 &&
				sourced.join(' ') === inHelper.join(' ') &&
				sourced.join(' ') === s.envFiles.join(' '),
			`unit [${sourced.join(' ')}] helper [${inHelper.join(' ')}] heal [${s.envFiles.join(' ')}]`
		);
		check(
			`${s.unit}: runs the root-owned pre-start helper (as root, failure tolerated)`,
			new RegExp(
				`^ExecStartPre=\\+-/usr/local/lib/morphit/morphit-service-perms\\.sh ${s.role}$`,
				'm'
			).test(unit)
		);
	}
}

// ── 3. dependency install ────────────────────────────────────────────────
{
	const cb = yaml.load(
		readFileSync(join(REPO, 'ops/ansible/roles/morphit/tasks/clone_and_build.yml'), 'utf8')
	) as Array<Record<string, any>>;
	const npm = cb.filter((t) =>
		/^npm (install|ci)\b/.test(String(t['ansible.builtin.command']?.cmd ?? ''))
	);
	check(
		'clone_and_build: every npm install/ci runs with --ignore-scripts',
		npm.length > 0 && npm.every((t) => /--ignore-scripts\b/.test(t['ansible.builtin.command'].cmd))
	);
	check(
		'clone_and_build: no step runs as another user (the tree stays root-owned)',
		cb.every((t) => t.become_user === undefined || ROOTISH.has(resolve(String(t.become_user))))
	);
}

// ── /etc/morphit: every role that manages the directory agrees ──────────
const etcTasks: string[] = [];
const etcWalk = (list: unknown, where: string): void => {
	if (!Array.isArray(list)) return;
	for (const t of list as Array<Record<string, unknown>>) {
		if (!t || typeof t !== 'object') continue;
		for (const k of ['block', 'rescue', 'always']) etcWalk(t[k], where);
		const a = (t['ansible.builtin.file'] ?? t.file) as Record<string, unknown> | undefined;
		if (a && String(a.path ?? '').replace(/\/+$/, '') === '/etc/morphit')
			etcTasks.push(`${where}: ${String(a.owner)}:${resolve(String(a.group))} ${String(a.mode)}`);
	}
};
for (const role of readdirSync(rolesDir)) {
	let files: string[] = [];
	try {
		files = readdirSync(join(rolesDir, role, 'tasks')).filter((f) => /\.ya?ml$/.test(f));
	} catch {
		continue;
	}
	for (const f of files)
		etcWalk(
			yaml.load(readFileSync(join(rolesDir, role, 'tasks', f), 'utf8')),
			`roles/${role}/tasks/${f}`
		);
}
check(
	'every role leaves /etc/morphit root:morphit 0750 (none flips it back to 0755)',
	etcTasks.length > 0 && etcTasks.every((t) => / root:morphit 0?750$/.test(t)),
	etcTasks.filter((t) => !/ root:morphit 0?750$/.test(t)).join(' | ')
);

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} service-privilege checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} service-privilege checks failed`);
process.exit(1);
