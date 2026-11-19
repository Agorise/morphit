#!/usr/bin/env node
/*
 * scripts/verify-release-build.mjs — is the release tarball exactly the signed
 * tag, plus the website built from it?
 *
 *   node scripts/verify-release-build.mjs --tag v1.2.3 --tarball morphit-v1.2.3.tar.gz
 *   node scripts/verify-release-build.mjs --tag v1.2.3 --tarball … --source-only
 *
 * WHY. The release job (release.yml, on the build server) packs the tarball and
 * builds the website into it; ELI5 Block 3 then anchors that tarball's SHA-256
 * on chain, and every instance installs it. The tag is signed on the
 * maintainer's own machine, but nothing compared the tarball with it: a build
 * server that had been broken into could have packed other code, or another
 * website, and it would have been anchored as the release. This script is
 * that comparison. Run from a clone that has the signed tag.
 *
 * 1. SOURCE. Every file of the tag must be in the tarball with exactly its
 *    bytes and its executable bit (compared by git's own blob hash), and the
 *    tarball may carry nothing else but:
 *      - apps/web/build/…   the website, checked in step 2;
 *      - release-info.json  which must name this tag and the tag's commit.
 *    One tracked file may differ: apps/web/static/sitemap.xml, and only by
 *    the <lastmod> lines the build adds, dated the release's build day.
 *    Only plain files and folders are accepted (no links, devices, absolute
 *    or ".." paths). The tarball is read in memory; nothing from it is
 *    written to disk.
 * 2. WEBSITE (skipped with --source-only). The tag is exported from git (not
 *    from the tarball), its dependencies installed with
 *    `npm ci --ignore-scripts`, and the website built with the release's
 *    SOURCE_DATE_EPOCH, as release.yml builds it. Every file must come out
 *    byte for byte as shipped, with two allowances that cannot hide anything:
 *      - a compressed copy (.br, .gz) may differ in its bytes (another Node
 *        version compresses differently) but must unpack to exactly the
 *        rebuilt file;
 *      - verify.json may name other hashes for those compressed copies only,
 *        and those must be the hashes of the copies shipped.
 *    `.shipped` (the marker release.yml adds) must be empty.
 *
 * Exit 0 only when both hold; otherwise every difference is listed and the
 * exit code is 1 — do not anchor that tarball.
 *
 * release.yml runs step 1 itself before publishing (--source-only), so a
 * release job that packs anything else fails there first.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const BUILD = 'apps/web/build/';
const SITEMAP = 'apps/web/static/sitemap.xml';
const INFO = 'release-info.json';

// ─── Output ───────────────────────────────────────────────────────────────
const tty = process.stderr.isTTY === true;
let spin = null;
function step(label) {
	stopSpin();
	if (!tty) {
		process.stderr.write(`… ${label}\n`);
		return;
	}
	const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
	let i = 0;
	process.stderr.write(`${frames[0]} ${label}`);
	spin = {
		label,
		timer: setInterval(() => {
			i = (i + 1) % frames.length;
			process.stderr.write(`\r${frames[i]} ${label}`);
		}, 120)
	};
}
function stopSpin() {
	if (spin === null) return;
	clearInterval(spin.timer);
	process.stderr.write('\r\x1b[2K');
	spin = null;
}
function ok(label) {
	stopSpin();
	process.stderr.write(`✓ ${label}\n`);
}
function fail(problems, what) {
	stopSpin();
	process.stderr.write(`✗ ${what}\n`);
	for (const p of problems.slice(0, 40)) process.stderr.write(`    ${p}\n`);
	if (problems.length > 40) process.stderr.write(`    … and ${problems.length - 40} more\n`);
	process.stderr.write(
		'\nThis tarball is not the signed tag plus the website built from it. Do not anchor or broadcast it.\n'
	);
	process.exit(1);
}
function usage(msg) {
	stopSpin();
	process.stderr.write(`verify-release-build: ${msg}\n`);
	process.stderr.write(
		'usage: node scripts/verify-release-build.mjs --tag vX.Y.Z --tarball <file> [--source-only]\n'
	);
	process.exit(2);
}

// ─── Arguments ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let tag = null;
let tarball = null;
let sourceOnly = false;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--tag') tag = argv[++i] ?? null;
	else if (a === '--tarball') tarball = argv[++i] ?? null;
	else if (a === '--source-only') sourceOnly = true;
	else usage(`unknown argument ${JSON.stringify(a)}`);
}
if (tag === null || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag))
	usage('--tag vX.Y.Z is required');
if (tarball === null) usage('--tarball <file> is required');
if (!existsSync(tarball)) usage(`${tarball} does not exist`);

// ─── git ──────────────────────────────────────────────────────────────────
function git(args, opts = {}) {
	const r = spawnSync('git', args, {
		encoding: opts.encoding ?? 'utf8',
		maxBuffer: 1 << 30,
		...opts
	});
	if (r.error) usage(`git could not run: ${r.error.message}`);
	return r;
}
const commitR = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
if (commitR.status !== 0)
	usage(`this clone has no tag ${tag} (run it in the repository that made the tag)`);
const tagCommit = commitR.stdout.trim();

// ─── The tarball, read in memory ──────────────────────────────────────────
/** Minimal ustar/GNU/pax reader. Returns Map path → {type, mode, data}. */
function readTar(buf) {
	const out = new Map();
	const problems = [];
	let off = 0;
	let longName = null;
	let paxPath = null;
	const str = (b) => {
		const z = b.indexOf(0);
		return b.subarray(0, z === -1 ? b.length : z).toString('utf8');
	};
	const oct = (b) => {
		const s = str(b).trim();
		return s === '' ? 0 : parseInt(s, 8);
	};
	while (off + 512 <= buf.length) {
		const h = buf.subarray(off, off + 512);
		if (h.every((x) => x === 0)) break;
		let size;
		if (h[124] & 0x80) {
			size = 0;
			for (let i = 125; i < 136; i++) size = size * 256 + h[i];
		} else size = oct(h.subarray(124, 136));
		const type = String.fromCharCode(h[156] || 48);
		const body = buf.subarray(off + 512, off + 512 + size);
		off += 512 + Math.ceil(size / 512) * 512;
		if (type === 'L') {
			longName = str(body);
			continue;
		}
		if (type === 'x') {
			const text = body.toString('utf8');
			const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
			if (m) paxPath = m[1];
			continue;
		}
		if (type === 'g') continue;
		const prefix = str(h.subarray(345, 500));
		let name =
			longName ??
			paxPath ??
			(prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
		longName = null;
		paxPath = null;
		const raw = name;
		while (name.startsWith('./')) name = name.slice(2);
		name = name.replace(/\/+$/, '');
		if (name === '' || name === '.') continue;
		if (name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) {
			problems.push(`unsafe path in the tarball: ${JSON.stringify(raw)}`);
			continue;
		}
		if (type === '5') continue;
		if (type !== '0' && type !== '7') {
			problems.push(`not a plain file in the tarball (type ${JSON.stringify(type)}): ${name}`);
			continue;
		}
		if (out.has(name)) problems.push(`the tarball carries ${name} twice`);
		out.set(name, { mode: oct(h.subarray(100, 108)), data: Buffer.from(body) });
	}
	return { files: out, problems };
}

step(`Reading ${tarball}`);
let files;
{
	let gz;
	try {
		gz = gunzipSync(readFileSync(tarball), { maxOutputLength: 2 ** 31 - 1 });
	} catch (e) {
		fail([`could not unpack: ${e.message}`], 'The tarball is not a gzip-compressed tar file');
	}
	const r = readTar(gz);
	if (r.problems.length > 0) fail(r.problems, 'The tarball carries entries a release never has');
	files = r.files;
}
ok(`Read the tarball: ${files.size} files`);

// ─── release-info.json ────────────────────────────────────────────────────
const infoEntry = files.get(INFO);
if (infoEntry === undefined) fail([`${INFO} is missing`], 'The tarball has no release-info.json');
let info;
try {
	info = JSON.parse(infoEntry.data.toString('utf8'));
} catch {
	fail([`${INFO} is not JSON`], 'release-info.json cannot be read');
}
const buildMs = Date.parse(info?.build_time ?? '');
{
	const p = [];
	if (info?.tag !== tag) p.push(`it names tag ${JSON.stringify(info?.tag)}, not ${tag}`);
	if (info?.commit !== tagCommit)
		p.push(`it names commit ${JSON.stringify(info?.commit)}, but ${tag} is ${tagCommit}`);
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(info?.build_time ?? '') ||
		!Number.isFinite(buildMs)
	)
		p.push(`its build_time ${JSON.stringify(info?.build_time)} is not a UTC time`);
	if (p.length > 0) fail(p, 'release-info.json does not describe this tag');
}
const sourceDateEpoch = Math.floor(buildMs / 1000);
const releaseDay = new Date(buildMs).toISOString().slice(0, 10);

// ─── 1. Source: every tracked file, exactly ───────────────────────────────
step(`Comparing every file with the signed tag ${tag}`);
const blobId = (data) =>
	createHash('sha1')
		.update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]))
		.digest('hex');
{
	const ls = git(['ls-tree', '-r', '-z', '--full-tree', tag]);
	if (ls.status !== 0) usage(`git ls-tree ${tag} failed: ${ls.stderr.trim()}`);
	const problems = [];
	const tracked = new Set();
	for (const rec of ls.stdout.split('\0')) {
		if (rec === '') continue;
		const tab = rec.indexOf('\t');
		const [mode, type, oid] = rec.slice(0, tab).split(' ');
		const path = rec.slice(tab + 1);
		if (type !== 'blob') {
			problems.push(`the tag holds a ${type} at ${path}, which this check does not expect`);
			continue;
		}
		tracked.add(path);
		const f = files.get(path);
		if (mode === '120000') {
			problems.push(`the tag holds a link at ${path}; a release has none`);
			continue;
		}
		if (f === undefined) {
			problems.push(`missing from the tarball: ${path}`);
			continue;
		}
		if (path.startsWith(BUILD) || path === INFO) {
			problems.push(`the tag tracks ${path}, which the release job writes`);
			continue;
		}
		const exec = (f.mode & 0o111) !== 0;
		if (exec !== (mode === '100755'))
			problems.push(`${path} is ${exec ? '' : 'not '}executable in the tarball, unlike the tag`);
		if (blobId(f.data) === oid) continue;
		if (path === SITEMAP) {
			// The build adds <lastmod> lines dated the release's build day; nothing else.
			const shipped = f.data.toString('utf8');
			const lines = shipped.split('\n');
			const dated = lines.filter((l) => /^\s*<lastmod>[^<]*<\/lastmod>\s*$/.test(l));
			const rest = lines.filter((l) => !/^\s*<lastmod>[^<]*<\/lastmod>\s*$/.test(l)).join('\n');
			const tagged = git(['cat-file', 'blob', oid], { encoding: 'buffer' }).stdout.toString('utf8');
			if (rest === tagged && dated.every((l) => l.trim() === `<lastmod>${releaseDay}</lastmod>`))
				continue;
		}
		problems.push(`differs from the tag: ${path}`);
	}
	for (const path of files.keys()) {
		if (tracked.has(path) || path.startsWith(BUILD) || path === INFO) continue;
		problems.push(`not in the tag: ${path}`);
	}
	if (problems.length > 0) fail(problems, `The tarball's files are not the tag ${tag}'s`);
	ok(`Every file is exactly the signed tag ${tag} (${tracked.size} files)`);
}

if (sourceOnly) {
	process.stderr.write('  (the website was not rebuilt: --source-only)\n');
	process.exit(0);
}

// ─── 2. The website, rebuilt from the tag ─────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'morphit-verify-build-'));
function cleanup() {
	try {
		rmSync(work, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}
process.on('exit', cleanup);
function run(label, cmd, args, env = {}) {
	step(label);
	const r = spawnSync(cmd, args, {
		cwd: work,
		encoding: 'utf8',
		maxBuffer: 1 << 28,
		env: { ...process.env, ...env }
	});
	if (r.status !== 0) {
		const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-15);
		stopSpin();
		process.stderr.write(`✗ ${label} failed\n`);
		for (const l of tail) process.stderr.write(`    ${l}\n`);
		process.stderr.write(
			'\nThe website could not be rebuilt here, so it was not compared. Fix the cause above and run this again.\n'
		);
		process.exit(1);
	}
}

step(`Exporting ${tag} from git`);
{
	const arch = git(['archive', '--format=tar', tag], { encoding: 'buffer' });
	if (arch.status !== 0) usage(`git archive ${tag} failed`);
	const x = spawnSync('tar', ['-xf', '-', '-C', work], { input: arch.stdout });
	if (x.status !== 0) usage('could not unpack the exported tag');
	writeFileSync(join(work, INFO), infoEntry.data);
}
ok(`Exported ${tag}`);
run('Installing its dependencies (npm ci --ignore-scripts)', 'npm', [
	'ci',
	'--ignore-scripts',
	'--no-audit',
	'--no-fund'
]);
ok('Installed its dependencies');
run('Building its website as the release job does', 'npm', ['run', 'build', '-w', 'apps/web'], {
	SOURCE_DATE_EPOCH: String(sourceDateEpoch)
});
ok('Built its website');

step('Comparing the website with the one shipped');
{
	const rebuilt = join(work, 'apps', 'web', 'build');
	const local = new Map();
	(function walk(dir) {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else local.set(relative(rebuilt, p).split('\\').join('/'), readFileSync(p));
		}
	})(rebuilt);
	const shipped = new Map();
	for (const [path, f] of files)
		if (path.startsWith(BUILD)) shipped.set(path.slice(BUILD.length), f.data);

	const problems = [];
	const unpack = (name, data) =>
		name.endsWith('.br') ? brotliDecompressSync(data) : gunzipSync(data);
	const compressed = (name) => name.endsWith('.br') || name.endsWith('.gz');
	const sha256 = (b) => createHash('sha256').update(b).digest('hex');
	for (const [name, data] of shipped) {
		if (name === '.shipped') {
			if (data.length !== 0) problems.push('.shipped is not empty');
			continue;
		}
		if (name === 'verify.json') continue;
		const mine = local.get(name);
		if (mine === undefined) {
			problems.push(`shipped, but the build does not make it: ${name}`);
			continue;
		}
		if (mine.equals(data)) continue;
		if (compressed(name)) {
			let a;
			let b;
			try {
				a = unpack(name, data);
				b = unpack(name, mine);
			} catch {
				problems.push(`a compressed copy that does not unpack: ${name}`);
				continue;
			}
			if (a.equals(b)) continue;
		}
		problems.push(`differs from the rebuilt website: ${name}`);
	}
	for (const name of local.keys()) {
		if (!shipped.has(name)) problems.push(`the build makes it, but it is not shipped: ${name}`);
	}
	// verify.json: the same document, except the hashes of compressed copies,
	// which must be those of the copies shipped.
	const shippedVerify = shipped.get('verify.json');
	const localVerify = local.get('verify.json');
	if (shippedVerify === undefined || localVerify === undefined) {
		problems.push('verify.json is missing');
	} else if (!shippedVerify.equals(localVerify)) {
		let s;
		let l;
		try {
			s = JSON.parse(shippedVerify.toString('utf8'));
			l = JSON.parse(localVerify.toString('utf8'));
		} catch {
			problems.push('verify.json is not JSON');
		}
		if (s && l) {
			const sh = s.hash_manifest ?? {};
			const lh = l.hash_manifest ?? {};
			const keys = new Set([...Object.keys(sh), ...Object.keys(lh)]);
			for (const k of keys) {
				if (sh[k] === lh[k]) continue;
				const copy = shipped.get(k);
				if (compressed(k) && copy !== undefined && sh[k] === sha256(copy)) continue;
				problems.push(`verify.json names another hash for ${k}`);
			}
			const rest = (d) => JSON.stringify({ ...d, hash_manifest: undefined });
			if (rest(s) !== rest(l)) problems.push('verify.json differs outside its list of hashes');
		}
	}
	if (problems.length > 0) fail(problems, 'The shipped website is not the one built from the tag');
	ok(`The shipped website is the one built from ${tag} (${shipped.size} files)`);
}
process.stderr.write(
	`\n✓ The tarball is exactly the signed tag ${tag}, plus the website built from it.\n`
);
process.exit(0);
