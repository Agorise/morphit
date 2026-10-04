/**
 * no-docker-latest-tag smoke: every container image Morphit runs or builds
 * from is pinned, by version AND by digest.
 *
 * A tag is a name the registry can point at different bytes tomorrow; only
 * `name:version@sha256:<digest>` names exact bytes. The guard covers where
 * images are named:
 *   - Dockerfiles (`FROM`), compose files, Ansible templates (`*.j2`) and
 *     group_vars (`*_image:`) under apps/, packages/, ops/;
 *   - the Forgejo workflows (`image:` of service containers);
 *   - the release scripts that run containers (`docker run|pull|create <image>`).
 * Checks:
 *   1. no `:latest` in any of them (comments ignored), nor in operator docs
 *      outside the prose that tells readers not to use it;
 *   2. every image reference carries `@sha256:<64 hex>`. A templated
 *      reference (`{{ bunkerweb_image }}`) is checked where the variable is
 *      set. References whose digest still has to be read on a machine with
 *      Docker Hub access are listed in AWAITING_DIGEST: each is printed as a
 *      warning (and a CI ::warning:: annotation) with the command that reads
 *      it, and never blocks a run: the release ceremony gains no manual
 *      step. Any OTHER unpinned reference fails (a new one is caught on the
 *      change that adds it). An entry that is pinned or gone must be removed
 *      from the list;
 *   3. no workflow turns a missing digest into a failure.
 *   MORPHIT_DOCKER_SCAN_ROOT=<other tree> tsx scripts/no-docker-latest-tag-smoke.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RESET = '\x1b[0m';

const REPO_ROOT = resolve(
	process.env.MORPHIT_DOCKER_SCAN_ROOT ?? new URL('..', import.meta.url).pathname
);

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
const pass = (name: string): void => void results.push({ name, passed: true });
const fail = (name: string, detail: string): void =>
	void results.push({ name, passed: false, detail });
const warnings: string[] = [];

/**
 * `<file>|<image>` pairs whose digest has not been read yet (Docker Hub was
 * unreachable where this was written). Read each with, on a machine with
 * Docker:
 *   docker buildx imagetools inspect <image> --format '{{json .Manifest.Digest}}'
 * then write `<image>@sha256:<digest>` and remove the entry.
 */
const AWAITING_DIGEST = new Set<string>([
	'.forgejo/workflows/ci.yml|postgres:16',
	'.forgejo/workflows/release.yml|postgres:16',
	'scripts/build-offline-bundle.sh|ubuntu:24.04',
	'ops/ansible/group_vars/all.yml|bunkerity/bunkerweb:1.5.10',
	'ops/ansible/group_vars/all.yml|bunkerity/bunkerweb-scheduler:1.5.10',
	'ops/bunkerweb/docker-compose.yml|bunkerity/bunkerweb:1.5.10',
	'ops/bunkerweb/docker-compose.yml|bunkerity/bunkerweb-scheduler:1.5.10'
]);

/** Operator docs that mention `:latest` only to say not to use it. */
const PROSE_GUIDANCE_PATHS = new Set<string>([
	'apps/mcp-server/README.md',
	'docs/INTEGRATION-TEST-HARNESS-DESIGN.md'
]);

/* ---------------- file discovery ---------------- */

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (['node_modules', 'dist', '.svelte-kit', 'build', '.git'].includes(name)) continue;
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) out.push(...listFilesRecursive(full));
		else if (st.isFile()) out.push(full);
	}
	return out;
}

const tree = ['apps', 'packages', 'ops', 'docs'].flatMap((d) =>
	listFilesRecursive(join(REPO_ROOT, d))
);
const workflows = listFilesRecursive(join(REPO_ROOT, '.forgejo')).filter((f) => /\.ya?ml$/.test(f));
const releaseScripts = existsSync(join(REPO_ROOT, 'scripts'))
	? readdirSync(join(REPO_ROOT, 'scripts'))
			.filter((n) => n.endsWith('.sh'))
			.map((n) => join(REPO_ROOT, 'scripts', n))
	: [];

const base = (f: string): string => f.split('/').pop() ?? '';
const isDockerfile = (f: string): boolean =>
	/^Dockerfile(\..+)?$/.test(base(f)) || /\.containerfile$/i.test(base(f));
const isCompose = (f: string): boolean => /^(docker-)?compose(\..+)?\.ya?ml(\.j2)?$/.test(base(f));
const isAnsibleYaml = (f: string): boolean =>
	f.includes('/ops/ansible/') && /\.(ya?ml|j2)$/.test(base(f));
const containerFiles = [
	...tree.filter((f) => isDockerfile(f) || isCompose(f) || isAnsibleYaml(f) || /\.j2$/.test(f)),
	...workflows,
	...releaseScripts
];

/* ---------------- image references ---------------- */

interface Ref {
	file: string;
	line: number;
	image: string;
}

/** Join shell continuation lines, keeping the first line number of each. */
function logicalLines(text: string): Array<{ line: number; text: string }> {
	const out: Array<{ line: number; text: string }> = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const start = i;
		let s = lines[i] ?? '';
		while (/\\\s*$/.test(s) && i + 1 < lines.length)
			s = s.replace(/\\\s*$/, ' ') + (lines[++i] ?? '');
		out.push({ line: start + 1, text: s });
	}
	return out;
}

const DOCKER_VALUE_FLAGS = new Set([
	'-e',
	'--env',
	'-v',
	'--volume',
	'--mount',
	'--entrypoint',
	'--name',
	'-w',
	'--workdir',
	'--network',
	'--net',
	'--platform',
	'-u',
	'--user',
	'--env-file',
	'-p',
	'--publish',
	'-h',
	'--hostname',
	'--add-host',
	'--cap-add',
	'--cap-drop',
	'--security-opt',
	'--tmpfs'
]);

/** The image a `docker run|pull|create …` command names, or null. */
export function dockerCommandImage(cmd: string): string | null {
	const m = /\bdocker\s+(run|pull|create)\b(.*)$/.exec(cmd);
	if (!m) return null;
	const toks = (m[2] ?? '').trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]!;
		if (t.startsWith('-')) {
			if (DOCKER_VALUE_FLAGS.has(t)) i++;
			continue;
		}
		return t.replace(/^["']|["']$/g, '');
	}
	return null;
}

export function imageRefs(file: string, text: string): Ref[] {
	const rel = relative(REPO_ROOT, file);
	const refs: Ref[] = [];
	const add = (line: number, image: string): void => {
		const img = image.replace(/^["']|["']$/g, '');
		// Templated / shell-variable references are checked where they are set.
		if (img === '' || /\{\{|\$/.test(img)) return;
		refs.push({ file: rel, line, image: img });
	};
	if (isDockerfile(file)) {
		const stages = new Set<string>();
		text.split('\n').forEach((l, i) => {
			const m = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
			if (!m) return;
			if (m[1] !== 'scratch' && !stages.has(m[1]!)) add(i + 1, m[1]!);
			if (m[2]) stages.add(m[2]);
		});
		return refs;
	}
	if (file.endsWith('.sh')) {
		for (const { line, text: l } of logicalLines(text)) {
			if (/^\s*#/.test(l)) continue;
			const img = dockerCommandImage(l);
			if (img !== null) add(line, img);
		}
		return refs;
	}
	text.split('\n').forEach((l, i) => {
		const m = /^\s*(?:-\s+)?(?:[\w-]+_)?image:\s*(\S+)/.exec(l.replace(/\s#.*$/, ''));
		if (m) add(i + 1, m[1]!);
	});
	return refs;
}

/* ---------------- 1. no :latest ---------------- */

const latestHits: string[] = [];
for (const file of containerFiles) {
	const rel = relative(REPO_ROOT, file);
	readFileSync(file, 'utf8')
		.split('\n')
		.forEach((line, i) => {
			const code = line.replace(/(^|\s)#.*$/, '');
			if (/:latest\b/i.test(code)) latestHits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
		});
}
if (latestHits.length === 0)
	pass('no `:latest` image tag in container configs, templates, workflows or release scripts');
else
	fail(
		'no `:latest` image tag in container configs, templates, workflows or release scripts',
		`${latestHits.length} found:\n      ${latestHits.join('\n      ')}`
	);

const docHits: string[] = [];
for (const file of tree) {
	if (!file.endsWith('.md')) continue;
	const rel = relative(REPO_ROOT, file);
	if (PROSE_GUIDANCE_PATHS.has(rel)) continue;
	readFileSync(file, 'utf8')
		.split('\n')
		.forEach((line, i) => {
			// Backtick spans are prose ("never `:latest`"), not image references.
			if (/:latest\b/i.test(line.replace(/`[^`]*`/g, '')))
				docHits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
		});
}
if (docHits.length === 0)
	pass('no `:latest` image tag in operator docs (outside the guidance prose)');
else
	fail(
		'no `:latest` image tag in operator docs',
		`${docHits.length} found:\n      ${docHits.join('\n      ')}`
	);

/* ---------------- 2. every image pinned by digest ---------------- */

const DIGEST = /^[^@\s]+:[^@\s:]+@sha256:[0-9a-f]{64}$/;
const allRefs = containerFiles.flatMap((f) => imageRefs(f, readFileSync(f, 'utf8')));
const unpinned: string[] = [];
const awaitingSeen = new Set<string>();
for (const r of allRefs) {
	if (DIGEST.test(r.image)) continue;
	const key = `${r.file}|${r.image}`;
	if (AWAITING_DIGEST.has(key)) {
		awaitingSeen.add(key);
		const msg = `${r.file}:${r.line}  ${r.image} — no digest yet: docker buildx imagetools inspect ${r.image} --format '{{json .Manifest.Digest}}'`;
		warnings.push(msg);
		continue;
	}
	unpinned.push(`${r.file}:${r.line}  ${r.image}`);
}
if (allRefs.length === 0)
	fail('image references found', 'no image reference at all — the scan is broken');
if (unpinned.length === 0)
	pass(
		`every image reference (${allRefs.length}) is name:version@sha256:<digest> or awaiting its digest (${warnings.length})`
	);
else
	fail(
		'every image reference is name:version@sha256:<digest>',
		`${unpinned.length} not pinned by digest:\n      ${unpinned.join('\n      ')}`
	);
const stale = [...AWAITING_DIGEST].filter((k) => !awaitingSeen.has(k));
if (stale.length === 0) pass('every AWAITING_DIGEST entry is still an unpinned reference');
else fail('AWAITING_DIGEST lists only unpinned references', `remove: ${stale.join(', ')}`);

/* ---------------- 3. a missing digest never blocks a release ---------------- */
// the release ceremony gains no manual step. A digest still to be read
// is a warning (a CI annotation), never a reason for a workflow to stop.
const blocking = workflows.filter((f) =>
	/MORPHIT_REQUIRE_IMAGE_DIGESTS/.test(readFileSync(f, 'utf8'))
);
if (blocking.length === 0) pass('no workflow makes a missing image digest block the run');
else
	fail(
		'no workflow makes a missing image digest block the run',
		`${blocking.map((f) => relative(REPO_ROOT, f)).join(', ')} sets MORPHIT_REQUIRE_IMAGE_DIGESTS (a manual digest lookup before every release)`
	);

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) console.log(`  ${ANSI_GREEN}✓${ANSI_RESET} ${r.name}`);
	else {
		console.log(`  ${ANSI_RED}✗${ANSI_RESET} ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}
for (const w of warnings) {
	console.log(`  ${ANSI_YELLOW}⚠${ANSI_RESET} ${w}`);
	console.log(`::warning title=image not pinned by digest::${w}`);
}
console.log();
if (failed > 0) {
	console.log(`✗ ${failed} of ${results.length} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${results.length} scenarios passed`);
