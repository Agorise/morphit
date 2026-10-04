#!/usr/bin/env node
/**
 * Put the Matrix bot's two native add-ons in place, each checked against a
 * pinned SHA-256.
 *
 * Every Morphit install path runs `npm ci --ignore-scripts`, so no dependency's
 * install script runs. Two packages need one to work at all, and only the
 * Matrix bot (and its smokes) loads them — matrix-bot-sdk loads both when it is
 * imported:
 *   - @matrix-org/matrix-sdk-crypto-nodejs: its script downloads a binary from
 *     GitHub and checks nothing;
 *   - better-sqlite3: its script downloads a prebuilt from GitHub (or compiles).
 * This downloads the same files and refuses any whose SHA-256 is not the one
 * pinned below for that package version, Node ABI and CPU. The pins are the
 * ones roles/morphit/tasks/clone_and_build.yml uses on Ansible installs.
 *
 *   node scripts/fetch-matrix-bot-natives.mjs [repo-root] [--verify-only]
 *
 * --verify-only downloads nothing (a zero-clearnet box): it only says whether
 * both add-ons are in place and match their pins.
 *
 * Exit 0: both add-ons are in place and match their pins (downloaded, or
 * already there). Exit 1: a version, ABI or CPU with no pin, a failed
 * download, or bytes that do not match — nothing unverified is left in place.
 */
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const PINS = {
	crypto: {
		version: '0.1.0-beta.6',
		sha256: {
			x64: 'f9b8ca0350a2085d189e06b19ffada5689ef843a394705e473a1106893d9f483',
			arm64: 'c1c166690787b12a6bd97070871e8c729082b7d3d3038e15d100612df15e2881'
		}
	},
	sqlite: {
		version: '11.10.0',
		abi: '127',
		tarballSha256: {
			x64: 'ea6a09d12d43cca31782ab0e09ecf442b8e2a49f5a02b219f5f117a6601ed306',
			arm64: '7bdf1d50d7ba21f91a4d3c31da7b1acc1c10d7ef51dd887a6e07d851a75388da'
		},
		nodeSha256: {
			x64: 'd7d9272b12d11c1dc2bb787741b1b7c4037d336155f316ace3420410c28fda37',
			arm64: '2bdcfde76d902d1b83aa957fc359aa37b98e7291d6103f57da4a802ee1cb1aef'
		}
	}
};

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify-only');
const root = args.find((a) => !a.startsWith('--')) ?? process.cwd();
const say = (m) => console.log(m);
const fail = (m) => {
	console.error(`✗ Matrix bot native add-ons: ${m}`);
	process.exit(1);
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const version = (dir) => {
	try {
		return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
	} catch {
		return null;
	}
};
async function download(url) {
	if (verifyOnly)
		fail(`not in place, and --verify-only downloads nothing (${url.replace(/^.*\//, '')})`);
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 180_000);
	try {
		const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
		if (!res.ok) fail(`HTTP ${res.status} from ${url}`);
		return Buffer.from(await res.arrayBuffer());
	} catch (e) {
		fail(`download failed from ${url} (${e?.message ?? e})`);
	} finally {
		clearTimeout(t);
	}
}
function place(file, bytes) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.part`;
	writeFileSync(tmp, bytes, { mode: 0o755 });
	renameSync(tmp, file);
}

if (process.platform !== 'linux') fail(`no pins for ${process.platform}`);
let libc = 'gnu';
try {
	if (!process.report.getReport().header.glibcVersionRuntime) libc = 'musl';
} catch {
	/* assume glibc */
}
if (libc !== 'gnu') fail('no pins for musl systems');
const arch = process.arch;
if (!PINS.crypto.sha256[arch]) fail(`no pins for CPU ${arch}`);

// ── the matrix crypto add-on ──
{
	const dir = join(root, 'node_modules', '@matrix-org', 'matrix-sdk-crypto-nodejs');
	const v = version(dir);
	if (v !== PINS.crypto.version)
		fail(
			`matrix-sdk-crypto-nodejs is ${v ?? 'not installed'}; pinned ${PINS.crypto.version} — update the pins`
		);
	const want = PINS.crypto.sha256[arch];
	const file = join(dir, `matrix-sdk-crypto.linux-${arch}-gnu.node`);
	if (existsSync(file) && sha(readFileSync(file)) === want) {
		say(`✓ matrix crypto add-on ${v} (${arch}) in place and matches its pin`);
	} else {
		if (!verifyOnly) say(`Downloading the matrix crypto add-on ${v} (${arch})…`);
		const bytes = await download(
			`https://github.com/matrix-org/matrix-rust-sdk/releases/download/matrix-sdk-crypto-nodejs-v${v}/matrix-sdk-crypto.linux-${arch}-gnu.node`
		);
		if (sha(bytes) !== want)
			fail(`the matrix crypto add-on has SHA-256 ${sha(bytes)}, pinned ${want}; not installed`);
		place(file, bytes);
		say(`✓ matrix crypto add-on ${v} (${arch}) installed and matches its pin`);
	}
}

// ── better-sqlite3 ──
{
	const dir = join(root, 'node_modules', 'better-sqlite3');
	const v = version(dir);
	if (v !== PINS.sqlite.version)
		fail(
			`better-sqlite3 is ${v ?? 'not installed'}; pinned ${PINS.sqlite.version} — update the pins`
		);
	if (process.versions.modules !== PINS.sqlite.abi)
		fail(
			`this Node has ABI ${process.versions.modules}; better-sqlite3 is pinned for ABI ${PINS.sqlite.abi}`
		);
	const want = PINS.sqlite.nodeSha256[arch];
	const file = join(dir, 'build', 'Release', 'better_sqlite3.node');
	if (existsSync(file) && sha(readFileSync(file)) === want) {
		say(`✓ better-sqlite3 ${v} (${arch}) in place and matches its pin`);
	} else {
		if (!verifyOnly) say(`Downloading the better-sqlite3 ${v} prebuilt (${arch})…`);
		const tgz = await download(
			`https://github.com/WiseLibs/better-sqlite3/releases/download/v${v}/better-sqlite3-v${v}-node-v${PINS.sqlite.abi}-linux-${arch}.tar.gz`
		);
		if (sha(tgz) !== PINS.sqlite.tarballSha256[arch])
			fail(
				`the better-sqlite3 prebuilt has SHA-256 ${sha(tgz)}, pinned ${PINS.sqlite.tarballSha256[arch]}; not installed`
			);
		const tmp = mkdtempSync(join(tmpdir(), 'morphit-sqlite-'));
		try {
			writeFileSync(join(tmp, 'p.tgz'), tgz);
			const x = spawnSync('tar', [
				'-xzf',
				join(tmp, 'p.tgz'),
				'-C',
				tmp,
				'--no-same-owner',
				'build/Release/better_sqlite3.node'
			]);
			const got = join(tmp, 'build', 'Release', 'better_sqlite3.node');
			if (x.status !== 0 || !existsSync(got))
				fail('the better-sqlite3 prebuilt has no build/Release/better_sqlite3.node');
			const bytes = readFileSync(got);
			if (sha(bytes) !== want)
				fail(`better_sqlite3.node has SHA-256 ${sha(bytes)}, pinned ${want}; not installed`);
			place(file, bytes);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
		say(`✓ better-sqlite3 ${v} (${arch}) installed and matches its pin`);
	}
}
