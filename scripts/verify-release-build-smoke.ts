/**
 * Smoke — scripts/verify-release-build.mjs.
 *
 * The maintainer runs it in ELI5 Block 3 before anchoring a release: the
 * tarball the release job packed must be exactly the signed tag, plus the
 * website built from it (release.yml runs the source half itself). Here a
 * small stand-in repository plays the part of Morphit: a tag, a workspace
 * `apps/web` whose build writes a page, a script, their compressed copies, a
 * verify.json and the sitemap's <lastmod> lines, as the real build does. Each
 * scenario packs a release the way release.yml packs one, changes one thing,
 * and runs the real CLI against it.
 *
 * Registered: `.:verify-release-build-smoke`.
 * MORPHIT_VERIFY_RELEASE_BUILD=<other copy> runs the scenarios against it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
	process.env.MORPHIT_VERIFY_RELEASE_BUILD ?? join(HERE, 'verify-release-build.mjs')
);

let failures = 0;
let scenarios = 0;
function check(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}
function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

// ─── The stand-in repository ─────────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), 'morphit-verify-build-smoke-'));
const REPO = join(ROOT, 'repo');
const TAG = 'v9.9.9';
const BUILD_TIME = '2026-11-18T02:02:34Z';
const DAY = '2026-11-18';

/** The stand-in website build: deterministic for a given source and
 *  SOURCE_DATE_EPOCH, like the real one. */
const BUILD_MJS = `import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
const sde = process.env.SOURCE_DATE_EPOCH ?? String(Math.floor(Date.now() / 1000));
const day = new Date(Number(sde) * 1000).toISOString().slice(0, 10);
const map = 'static/sitemap.xml';
writeFileSync(map, readFileSync(map, 'utf8').replace(/(\\t\\t<loc>[^<]*<\\/loc>\\n)/g, '$1\\t\\t<lastmod>' + day + '</lastmod>\\n'));
mkdirSync('build', { recursive: true });
const files = {
	'index.html': '<!doctype html><title>' + readFileSync('src/title.txt', 'utf8').trim() + '</title><meta name="v" content="' + sde + '">',
	'a.js': readFileSync('src/a.js', 'utf8')
};
for (const [n, t] of Object.entries(files)) {
	writeFileSync('build/' + n, t);
	writeFileSync('build/' + n + '.gz', gzipSync(t, { level: 9 }));
	writeFileSync('build/' + n + '.br', brotliCompressSync(t));
}
const hm = {};
for (const n of Object.keys(files).flatMap((n) => [n, n + '.gz', n + '.br']).sort())
	hm[n] = createHash('sha256').update(readFileSync('build/' + n)).digest('hex');
writeFileSync('build/verify.json', JSON.stringify({ schema_version: 1, built_at: new Date(Number(sde) * 1000).toISOString(), hash_manifest: hm }, null, 2));
`;

function sh(cmd: string, args: string[], cwd: string, input?: Buffer): Buffer {
	const r = spawnSync(cmd, args, { cwd, input, maxBuffer: 1 << 28 });
	if (r.status !== 0)
		throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr?.toString() ?? r.error}`);
	return r.stdout;
}
function write(rel: string, text: string, mode?: number): void {
	const p = join(REPO, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, text);
	if (mode !== undefined) chmodSync(p, mode);
}
write('package.json', JSON.stringify({ name: 'fake', private: true, workspaces: ['apps/web'] }));
write(
	'package-lock.json',
	JSON.stringify({
		name: 'fake',
		lockfileVersion: 3,
		requires: true,
		packages: {
			'': { name: 'fake', workspaces: ['apps/web'] },
			'apps/web': { name: 'fake-web', version: '1.0.0' },
			'node_modules/fake-web': { resolved: 'apps/web', link: true }
		}
	})
);
write(
	'apps/web/package.json',
	JSON.stringify({ name: 'fake-web', version: '1.0.0', scripts: { build: 'node build.mjs' } })
);
write('apps/web/build.mjs', BUILD_MJS);
write('apps/web/src/title.txt', 'Morphit stand-in\n');
write('apps/web/src/a.js', 'console.log("the real script");\n');
write(
	'apps/web/static/sitemap.xml',
	'<urlset>\n\t<url>\n\t\t<loc>https://x/</loc>\n\t</url>\n</urlset>\n'
);
write('scripts/run.sh', '#!/bin/sh\necho run\n', 0o755);
write('README.md', 'stand-in\n');
write('.gitignore', 'node_modules\napps/web/build\n');
const G = ['-c', 'user.email=s@s', '-c', 'user.name=s'];
sh('git', ['init', '-q'], REPO);
sh('git', [...G, 'add', '-A'], REPO);
sh('git', [...G, 'commit', '-qm', 'stand-in'], REPO);
sh('git', [...G, 'tag', '-a', TAG, '-m', TAG], REPO);
const COMMIT = sh('git', ['rev-parse', `${TAG}^{commit}`], REPO)
	.toString()
	.trim();

// ─── Packing a release the way release.yml does ──────────────────────────
type Entry = { name: string; data: Buffer; mode: number; type?: string; link?: string };

/** The honest release: the tag's files, release-info.json, the website built
 *  with the release's SOURCE_DATE_EPOCH (it also dates the sitemap), and the
 *  empty .shipped marker. */
function honest(): Map<string, Entry> {
	const ci = mkdtempSync(join(ROOT, 'ci-'));
	sh('tar', ['-xf', '-', '-C', ci], ci, sh('git', ['archive', TAG], REPO));
	writeFileSync(
		join(ci, 'release-info.json'),
		JSON.stringify({ tag: TAG, commit: COMMIT, build_time: BUILD_TIME, builder: 'forgejo-actions' })
	);
	const sde = String(Math.floor(Date.parse(BUILD_TIME) / 1000));
	const r = spawnSync('node', ['build.mjs'], {
		cwd: join(ci, 'apps/web'),
		env: { ...process.env, SOURCE_DATE_EPOCH: sde }
	});
	if (r.status !== 0) throw new Error(`stand-in build failed: ${r.stderr}`);
	writeFileSync(join(ci, 'apps/web/build/.shipped'), '');
	const out = new Map<string, Entry>();
	const list = sh('find', ['.', '-type', 'f', '-printf', '%m %P\\n'], ci)
		.toString()
		.trim()
		.split('\n');
	for (const line of list) {
		const sp = line.indexOf(' ');
		const name = line.slice(sp + 1);
		out.set(name, {
			name: `./${name}`,
			data: readFileSync(join(ci, name)),
			mode: parseInt(line.slice(0, sp), 8)
		});
	}
	rmSync(ci, { recursive: true, force: true });
	return out;
}

/** A ustar archive (with GNU long names), gzip-compressed. */
function pack(entries: Iterable<Entry>): Buffer {
	const blocks: Buffer[] = [];
	const header = (name: string, size: number, mode: number, type: string, link = ''): Buffer => {
		const h = Buffer.alloc(512);
		h.write(name.slice(0, 100), 0, 'utf8');
		h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
		h.write('0000000\0', 108);
		h.write('0000000\0', 116);
		h.write(size.toString(8).padStart(11, '0') + '\0', 124);
		h.write('00000000000\0', 136);
		h.write('        ', 148);
		h.write(type, 156);
		h.write(link, 157);
		h.write('ustar  \0', 257);
		let sum = 0;
		for (const b of h) sum += b;
		h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
		return h;
	};
	const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
	for (const e of entries) {
		if (Buffer.byteLength(e.name) > 99) {
			const n = Buffer.from(e.name + '\0');
			blocks.push(header('././@LongLink', n.length, 0o644, 'L'), pad(n));
		}
		const type = e.type ?? '0';
		blocks.push(header(e.name, type === '0' ? e.data.length : 0, e.mode, type, e.link ?? ''));
		if (type === '0') blocks.push(pad(e.data));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

let n = 0;
function verify(
	entries: Iterable<Entry>,
	extra: string[] = [],
	cwd = REPO
): { status: number; out: string } {
	const file = join(ROOT, `release-${++n}.tar.gz`);
	writeFileSync(file, pack(entries));
	const r = spawnSync('node', [SCRIPT, '--tag', TAG, '--tarball', file, ...extra], {
		cwd,
		encoding: 'utf8',
		maxBuffer: 1 << 26
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
function refused(r: { status: number; out: string }, says: RegExp): void {
	assert(r.status === 1, `accepted (exit ${r.status}):\n${r.out}`);
	assert(says.test(r.out), `refused, but without saying ${says}:\n${r.out}`);
}
const VJ = 'apps/web/build/verify.json';
function vjson(m: Map<string, Entry>): Record<string, unknown> {
	return JSON.parse(m.get(VJ)!.data.toString('utf8'));
}
function setVjson(m: Map<string, Entry>, doc: Record<string, unknown>): void {
	m.set(VJ, { ...m.get(VJ)!, data: Buffer.from(JSON.stringify(doc, null, 2)) });
}
function replace(m: Map<string, Entry>, path: string, data: Buffer | string): void {
	m.set(path, { ...m.get(path)!, data: Buffer.from(data) });
}
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

console.log('verify-release-build smoke:\n');

// ─── Source ──────────────────────────────────────────────────────────────
check('an honest release passes: the tag, plus the website built from it', () => {
	const r = verify(honest().values());
	assert(r.status === 0, `refused (exit ${r.status}):\n${r.out}`);
	assert(
		/✓ The tarball is exactly the signed tag v9\.9\.9, plus the website built from it\./.test(
			r.out
		),
		r.out
	);
	assert(/Built its website/.test(r.out), `the website was not rebuilt:\n${r.out}`);
});
check('--source-only checks the files and says the website was not rebuilt', () => {
	const r = verify(honest().values(), ['--source-only']);
	assert(r.status === 0, `refused:\n${r.out}`);
	assert(/not rebuilt: --source-only/.test(r.out) && !/Built its website/.test(r.out), r.out);
});
check('a changed source file is refused, by name', () => {
	const m = honest();
	replace(m, 'README.md', 'stand-in, but changed\n');
	refused(verify(m.values(), ['--source-only']), /differs from the tag: README\.md/);
});
check('a file the tag does not have is refused', () => {
	const m = honest();
	m.set('evil.js', { name: './evil.js', data: Buffer.from('x'), mode: 0o644 });
	refused(verify(m.values(), ['--source-only']), /not in the tag: evil\.js/);
});
check('a file of the tag missing from the tarball is refused', () => {
	const m = honest();
	m.delete('scripts/run.sh');
	refused(verify(m.values(), ['--source-only']), /missing from the tarball: scripts\/run\.sh/);
});
check('a lost executable bit is refused', () => {
	const m = honest();
	m.set('scripts/run.sh', { ...m.get('scripts/run.sh')!, mode: 0o644 });
	refused(
		verify(m.values(), ['--source-only']),
		/scripts\/run\.sh is not executable in the tarball/
	);
});
const SITEMAP = 'apps/web/static/sitemap.xml';
check('a sitemap changed beyond its <lastmod> lines is refused', () => {
	const m = honest();
	replace(m, SITEMAP, m.get(SITEMAP)!.data.toString().replace('https://x/', 'https://evil/'));
	refused(
		verify(m.values(), ['--source-only']),
		/differs from the tag: apps\/web\/static\/sitemap\.xml/
	);
});
check('a sitemap dated another day than the release is refused', () => {
	const m = honest();
	assert(
		m.get(SITEMAP)!.data.toString().includes(DAY),
		'the stand-in build did not date the sitemap'
	);
	replace(m, SITEMAP, m.get(SITEMAP)!.data.toString().replace(DAY, '2020-01-01'));
	refused(
		verify(m.values(), ['--source-only']),
		/differs from the tag: apps\/web\/static\/sitemap\.xml/
	);
});
check('release-info.json naming another commit is refused', () => {
	const m = honest();
	const doc = JSON.parse(m.get('release-info.json')!.data.toString());
	doc.commit = '0'.repeat(40);
	replace(m, 'release-info.json', JSON.stringify(doc));
	refused(verify(m.values(), ['--source-only']), /names commit/);
});
check('a link in the tarball is refused', () => {
	const m = [...honest().values()];
	m.push({
		name: './apps/web/build/x',
		data: Buffer.alloc(0),
		mode: 0o777,
		type: '2',
		link: '/etc/passwd'
	});
	refused(verify(m, ['--source-only']), /not a plain file in the tarball/);
});
check('a path that climbs out of the tarball is refused', () => {
	const m = [...honest().values()];
	m.push({ name: './../outside.txt', data: Buffer.from('x'), mode: 0o644 });
	refused(verify(m, ['--source-only']), /unsafe path in the tarball/);
});
check('a clone without the tag is told so, and nothing is checked', () => {
	const other = mkdtempSync(join(ROOT, 'empty-'));
	sh('git', ['init', '-q'], other);
	const r = verify(honest().values(), ['--source-only'], other);
	assert(
		r.status === 2 && /this clone has no tag v9\.9\.9/.test(r.out),
		`exit ${r.status}:\n${r.out}`
	);
});

// ─── The website ─────────────────────────────────────────────────────────
check('a changed script in the shipped website is refused, by name', () => {
	const m = honest();
	replace(m, 'apps/web/build/a.js', 'console.log("something else");\n');
	refused(verify(m.values()), /differs from the rebuilt website: a\.js$/m);
});
check('a file the build does not make is refused', () => {
	const m = honest();
	m.set('apps/web/build/extra.js', {
		name: './apps/web/build/extra.js',
		data: Buffer.from('x'),
		mode: 0o644
	});
	refused(verify(m.values()), /shipped, but the build does not make it: extra\.js/);
});
check('a file the build makes but the release lacks is refused', () => {
	const m = honest();
	m.delete('apps/web/build/a.js.br');
	refused(verify(m.values()), /the build makes it, but it is not shipped: a\.js\.br/);
});
check('a compressed copy made by another compressor passes, if it unpacks to the same file', () => {
	const m = honest();
	const other = gzipSync('console.log("the real script");\n', { level: 1 });
	assert(!other.equals(m.get('apps/web/build/a.js.gz')!.data), 'the stand-in made the same bytes');
	replace(m, 'apps/web/build/a.js.gz', other);
	const v = vjson(m);
	(v.hash_manifest as Record<string, string>)['a.js.gz'] = sha256(other);
	setVjson(m, v);
	const r = verify(m.values());
	assert(r.status === 0, `refused:\n${r.out}`);
});
check('a compressed copy with other content is refused', () => {
	const m = honest();
	const other = brotliCompressSync('console.log("something else");\n', {
		params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
	});
	replace(m, 'apps/web/build/a.js.br', other);
	const v = vjson(m);
	(v.hash_manifest as Record<string, string>)['a.js.br'] = sha256(other);
	setVjson(m, v);
	refused(verify(m.values()), /differs from the rebuilt website: a\.js\.br/);
});
check('verify.json naming another hash for a file is refused', () => {
	const m = honest();
	const v = vjson(m);
	(v.hash_manifest as Record<string, string>)['a.js'] = '0'.repeat(64);
	setVjson(m, v);
	refused(verify(m.values()), /verify\.json names another hash for a\.js$/m);
});
check(
	'verify.json naming a hash for a compressed copy that is not the shipped one is refused',
	() => {
		const m = honest();
		const v = vjson(m);
		(v.hash_manifest as Record<string, string>)['a.js.gz'] = '1'.repeat(64);
		setVjson(m, v);
		refused(verify(m.values()), /verify\.json names another hash for a\.js\.gz/);
	}
);
check('verify.json changed outside its hashes is refused', () => {
	const m = honest();
	const v = vjson(m);
	v.built_at = '2020-01-01T00:00:00.000Z';
	setVjson(m, v);
	refused(verify(m.values()), /verify\.json differs outside its list of hashes/);
});
check('a .shipped marker with content is refused', () => {
	const m = honest();
	replace(m, 'apps/web/build/.shipped', 'x');
	refused(verify(m.values()), /\.shipped is not empty/);
});

rmSync(ROOT, { recursive: true, force: true });
console.log('');
if (failures > 0) {
	console.log(`✗ ${failures} of ${scenarios} verify-release-build scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} verify-release-build scenarios passed`);
process.exit(0);
