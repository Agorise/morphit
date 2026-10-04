/**
 * offline-bundle-provenance-smoke.
 *
 * The offline bundle shipped whatever release-info.json was in the tree — a
 * committed one said v1.17.15 for releases long after — and every file the
 * release job had left around (anchor env, signer fingerprint, IPNS outputs,
 * the IPNS tools' node_modules). Runs scripts/build-offline-bundle.sh's
 * packaging step (--tar-only; no Docker, no network) on a scratch tree.
 *   MORPHIT_BUNDLE_SCRIPT=<other copy> tsx scripts/offline-bundle-provenance-smoke.ts
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(process.env.MORPHIT_BUNDLE_SCRIPT ?? join(HERE, 'build-offline-bundle.sh'));
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const root = mkdtempSync(join(tmpdir(), 'bundle-prov-'));
const files: Record<string, string> = {
	'package.json': '{"name":"morphit","version":"9.9.9"}',
	'release-info.json': '{"tag":"v1.17.15","commit":"103e0b8d"}',
	'apps/web/build/index.html': '<html></html>',
	'node_modules/.morphit-bundle-complete': '',
	'distribution-anchor.env': 'export MORPHIT_BUILD_SOURCE_SHA256=' + 'a'.repeat(64) + '\n',
	'release-signer.fpr': '7B4C1D189DBB610C473B59ED53524E1F1017EB9C\n',
	'ipfs-cid.txt': 'bafy',
	'ipns-name.txt': 'k51',
	'ipns-record.txt': 'rec',
	'ipns-sign.json': '{}',
	'scripts/ipns/node_modules/ipns/package.json': '{}',
	'scripts/ipns/ipns-sign.mjs': '//'
};
for (const [rel, body] of Object.entries(files)) {
	mkdirSync(join(root, dirname(rel)), { recursive: true });
	writeFileSync(join(root, rel), body);
}
mkdirSync(join(root, 'scripts'), { recursive: true });
copyFileSync(SCRIPT, join(root, 'scripts', 'build-offline-bundle.sh'));
const out = join(tmpdir(), `bundle-prov-${process.pid}.tar.gz`);
const r = spawnSync('bash', [join(root, 'scripts', 'build-offline-bundle.sh'), '--tar-only', out], {
	cwd: root,
	encoding: 'utf8',
	env: { ...process.env, GIT_DIR: join(root, 'no-git') }
});
check(
	'the packaging step runs without Docker or a network (--tar-only)',
	r.status === 0,
	(r.stderr || r.stdout).slice(-300)
);
const list = r.status === 0 ? spawnSync('tar', ['-tzf', out], { encoding: 'utf8' }).stdout : '';
const info =
	r.status === 0
		? spawnSync('tar', ['-xzOf', out, './release-info.json'], { encoding: 'utf8' }).stdout
		: '';
check(
	'release-info.json names the version being bundled',
	/"tag": "v9\.9\.9"/.test(info),
	info.slice(0, 80)
);
for (const scratch of [
	'distribution-anchor.env',
	'release-signer.fpr',
	'ipfs-cid.txt',
	'ipns-name.txt',
	'ipns-record.txt',
	'ipns-sign.json',
	'scripts/ipns/node_modules/'
]) {
	check(
		`${scratch} is not shipped`,
		!list.split('\n').some((l) => l.replace(/^\.\//, '').startsWith(scratch))
	);
}
check('the IPNS tools themselves still ship', list.includes('./scripts/ipns/ipns-sign.mjs'));
check('the prebuilt frontend still ships', list.includes('./apps/web/build/index.html'));
const src = readFileSync(SCRIPT, 'utf8');
check(
	'one exact Node pin, a 22.x release',
	(src.match(/^NODE_VERSION="v22\.\d+\.\d+"$/gm) ?? []).length === 1
);
check(
	'the bundle step refuses a release-info.json that names another version',
	/release-info\.json does not name v\$\{VER\}/.test(src)
);

rmSync(root, { recursive: true, force: true });
rmSync(out, { force: true });

// ── The release job's bundle: no Docker, the frontend it already built ──
// The release job runs in a container with no Docker, so it builds the bundle
// with --without-docker (no apt closure, no saved images) and --reuse-frontend
// (the canonical build the slim tarball carries, not a second, different
// one). Stubbed npm / curl / dpkg / docker; the Node and Kubo downloads fail
// here, which must leave them out with a warning rather than fail the release.
function releaseJobBundle(extra: Record<string, string> = {}, omit: string[] = []) {
	const t = mkdtempSync(join(tmpdir(), 'bundle-nodocker-'));
	const tree: Record<string, string> = {
		'package.json': '{"name":"morphit","version":"9.9.9"}',
		'release-info.json': '{\n  "tag": "v9.9.9"\n}\n',
		'apps/web/build/index.html': '<html>canonical</html>',
		'apps/web/build/.brand-slots.json': '{}',
		'apps/web/build/.shipped': '',
		'apps/web/src/app.html': '<html></html>',
		'apps/indexer/src/main.ts': '//',
		'apps/relay/src/main.ts': '//',
		'morphit-v9.9.9.tar.gz': 'slim',
		'morphit-v9.9.9.tar.gz.sha256': 'x  morphit-v9.9.9.tar.gz\n',
		'scripts/fetch-matrix-bot-natives.mjs': 'process.exit(0);\n',
		...extra
	};
	for (const [rel, body] of Object.entries(tree)) {
		if (omit.includes(rel)) continue;
		mkdirSync(join(t, dirname(rel)), { recursive: true });
		writeFileSync(join(t, rel), body);
	}
	copyFileSync(SCRIPT, join(t, 'scripts', 'build-offline-bundle.sh'));
	const bin = join(t, '.bin-stubs');
	mkdirSync(bin);
	const calls = join(t, '.calls');
	const stub = (name: string, body: string): void =>
		writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${body}\n`, {
			mode: 0o755
		});
	stub(
		'npm',
		'if [ "$1" = ci ]; then mkdir -p node_modules/.bin && : > node_modules/.bin/tsx; fi\nexit 0'
	);
	stub('curl', 'exit 7');
	stub('dpkg', 'echo amd64');
	stub('docker', 'exit 1');
	const r2 = spawnSync(
		'bash',
		[join(t, 'scripts', 'build-offline-bundle.sh'), '--without-docker', '--reuse-frontend'],
		{
			cwd: t,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GIT_DIR: join(t, 'no-git') }
		}
	);
	const bundle = join(t, 'morphit-v9.9.9-offline.tar.gz');
	const names = spawnSync('tar', ['-tzf', bundle], { encoding: 'utf8' }).stdout ?? '';
	const manifest =
		spawnSync('tar', ['-xzOf', bundle, './vendor/BUNDLE-MANIFEST.txt'], { encoding: 'utf8' })
			.stdout ?? '';
	const index =
		spawnSync('tar', ['-xzOf', bundle, './apps/web/build/index.html'], { encoding: 'utf8' })
			.stdout ?? '';
	let callLog = '';
	try {
		callLog = readFileSync(calls, 'utf8');
	} catch {
		/* nothing called */
	}
	let shaFile = '';
	try {
		shaFile = readFileSync(`${bundle}.sha256`, 'utf8');
	} catch {
		/* not written */
	}
	rmSync(t, { recursive: true, force: true });
	return { r: r2, names, manifest, index, callLog, shaFile };
}
const nd = releaseJobBundle();
check(
	'release-job bundle (--without-docker --reuse-frontend) is built with no Docker',
	nd.r.status === 0 && !/^docker /m.test(nd.callLog),
	(nd.r.stderr || nd.r.stdout).slice(-400)
);
check(
	'it carries node_modules with the bundle marker (the upgrade skips npm entirely)',
	nd.names.includes('./node_modules/.morphit-bundle-complete') &&
		nd.names.includes('./node_modules/.bin/tsx')
);
check(
	'it ships the frontend the release job already built, not a second build',
	nd.index === '<html>canonical</html>' &&
		nd.names.includes('./apps/web/build/.shipped') &&
		!/^npm run build/m.test(nd.callLog),
	nd.callLog
);
check(
	'it carries the canonical slim tarball (hidden nodes seed it)',
	nd.names.includes('./.canonical-release/morphit-v9.9.9.tar.gz')
);
check(
	'no apt repository and no saved images, and the manifest says so',
	!/\.\/vendor\/(apt|docker)\//.test(nd.names) && /without Docker/i.test(nd.manifest),
	nd.manifest
);
check(
	'a Node/Kubo download that fails is left out with a warning, not a failed release',
	nd.r.status === 0 &&
		/::warning/.test(nd.r.stdout + nd.r.stderr) &&
		!/vendor\/node\/bin\/node/.test(nd.names)
);
check(
	'its .sha256 is written',
	/^[0-9a-f]{64} {2}morphit-v9\.9\.9-offline\.tar\.gz$/m.test(nd.shaFile)
);
const noSlots = releaseJobBundle({}, ['apps/web/build/.brand-slots.json']);
check('--reuse-frontend refuses a frontend without its brand-slot record', noSlots.r.status !== 0);
console.log(
	fail === 0
		? `✓ all ${pass} offline-bundle-provenance checks hold`
		: `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
