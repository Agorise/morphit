/**
 * The Node.js runtime of an offline (bundled) install.
 *
 * morphit-setup.sh installs Node from the bundle's vendor/node into /usr/local
 * when the box has none; nothing ever updated it, so every offline node kept
 * the Node of the bundle it was installed from (22.14.0 for a long time) and
 * its security fixes stopped there. When an upgrade brings a bundle whose
 * vendor/node is newer than the /usr/local one the services run, this puts it
 * in place:
 *   - everything but bin/node is copied over /usr/local;
 *   - bin/node is copied next to the running one and renamed over it (the
 *     running process keeps its old file; nothing is half-written);
 *   - VERIFY: /usr/local/bin/node now reports the bundle's version.
 * A box whose Node came from apt (/usr/bin/node) is left to apt.
 *
 * v1.24.8 — a release names its Node (NODE_RUNTIME: the version the offline
 * bundle carries, scripts/build-offline-bundle.sh NODE_VERSION, and the
 * SHA-256 of nodejs.org's linux tarballs of it). The servers' own answers
 * (components-check.sh, 2026-11-20) showed three of four running a /usr/local
 * Node from a bundle that no upgrade ever replaced: a normal release carries no
 * vendor/node, so morphitir still ran 22.14.0 and vigilante and morphitlat
 * 22.22.2, behind every Node security release since. Now, when no bundle
 * brings it, the upgrade downloads that tarball from nodejs.org — directly,
 * else through this server's Tor (a zero-clearnet server: through Tor only) —
 * keeps it only when its SHA-256 is the one this release names, checks the
 * Node inside reports the version, and puts it in place the same way. Within
 * an upgrade the services restart on it right after; for `upgrade --heals` the
 * restart script (ops/scripts/morphit-node-restart.sh) restarts the ones still
 * running the replaced Node.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	cpSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync
} from 'node:fs';
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { runAsync } from './spinRun.ts';
import { torSocksFromEnv } from './torOnlyOsHeal.ts';

/** The Node.js this release runs on: the offline bundle carries it, and a
 *  server with a /usr/local Node downloads it when no bundle brings it. The
 *  SHA-256s are the lines of nodejs.org's SHASUMS256.txt for this version. */
export const NODE_RUNTIME: {
	readonly version: string;
	readonly sha256: Readonly<Record<'x64' | 'arm64', string>>;
} = {
	version: 'v22.23.5',
	sha256: {
		x64: 'cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8',
		arm64: '2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09'
	}
};

/** nodejs.org's tarball of a version for an architecture. PURE. */
export function nodeTarballUrl(version: string, arch: 'x64' | 'arm64'): string {
	return `https://nodejs.org/dist/${version}/node-${version}-linux-${arch}.tar.xz`;
}

/** The download (about 30 MB; over Tor it can be slow). */
export const NODE_DOWNLOAD_MS = 15 * 60_000;

export interface NodeRuntimeDeps {
	readonly installDir: string;
	/** Where the vendored runtime lives on this box (default /usr/local). */
	readonly prefix?: string;
	/** `<binary> --version`, or null when it does not run. */
	readonly versionOf?: (bin: string) => string | null;
	/** The runtime this release names (tests). */
	readonly runtime?: typeof NODE_RUNTIME;
	/** Where a download is unpacked (default /var/lib/morphit/node-runtime). */
	readonly workDir?: string;
	/** `process.arch`. */
	readonly arch?: string;
	/** A zero-clearnet server (downloads through Tor only). */
	readonly hiddenOnly?: () => boolean;
	/** Download `url` to `dest`, directly or through Tor; true when it came. */
	readonly download?: (url: string, dest: string, viaTor: boolean) => Promise<boolean>;
	/** SHA-256 (hex) of a file, or null. */
	readonly sha256Of?: (file: string) => Promise<string | null>;
	/** Unpack a .tar.xz into a folder; true when it worked. */
	readonly unpack?: (tarball: string, dir: string) => Promise<boolean>;
	/** Restart the Morphit services still running the replaced Node (the
	 *  restart script); only asked for outside an upgrade, which restarts
	 *  them itself right after. */
	readonly restartServices?: () => Promise<void>;
}

const realSha256 = (file: string): Promise<string | null> =>
	new Promise((resolve) => {
		const h = createHash('sha256');
		const s = createReadStream(file);
		s.on('error', () => resolve(null));
		s.on('data', (d) => h.update(d));
		s.on('end', () => resolve(h.digest('hex')));
	});

const realDownload = async (url: string, dest: string, viaTor: boolean): Promise<boolean> => {
	const r = await runAsync(
		'curl',
		[
			'-fsSL',
			'--max-time',
			String(Math.floor(NODE_DOWNLOAD_MS / 1000) - 30),
			...(viaTor ? ['--noproxy', '', '--socks5-hostname', torSocksFromEnv()] : []),
			'-o',
			dest,
			url
		],
		{ timeoutMs: NODE_DOWNLOAD_MS }
	);
	return r.status === 0 && existsSync(dest);
};

const realUnpack = async (tarball: string, dir: string): Promise<boolean> =>
	(
		await runAsync('tar', ['-xJf', tarball, '-C', dir, '--no-same-owner'], {
			timeoutMs: 5 * 60_000
		})
	).status === 0;

const realVersionOf = (bin: string): string | null => {
	const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 });
	const v = (r.stdout ?? '').trim();
	return r.status === 0 && /^v\d+\.\d+\.\d+$/.test(v) ? v : null;
};

/** -1 / 0 / 1 for two `vX.Y.Z` strings. PURE. */
export function compareNodeVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, '').split('.').map(Number);
	const pb = b.replace(/^v/, '').split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
	}
	return 0;
}

export async function healNodeRuntime(ctx: HealCtx, deps: NodeRuntimeDeps): Promise<HealResult> {
	const prefix = deps.prefix ?? '/usr/local';
	const versionOf = deps.versionOf ?? realVersionOf;
	const runtime = deps.runtime ?? NODE_RUNTIME;
	const vendor = join(deps.installDir, 'vendor', 'node');
	const bundled = join(vendor, 'bin', 'node');
	const installed = join(prefix, 'bin', 'node');
	if (!existsSync(installed)) {
		return { strategy: 'not-vendored', verified: true, routine: true, detail: '' };
	}
	const have = versionOf(installed);
	const bundleWant = existsSync(bundled) ? versionOf(bundled) : null;
	// The bundle's Node when it brings one at least as new as the release's.
	if (
		bundleWant !== null &&
		compareNodeVersions(bundleWant, runtime.version) >= 0 &&
		(have === null || compareNodeVersions(have, bundleWant) < 0)
	)
		return putInPlace(ctx, vendor, bundleWant, installed, prefix, have, versionOf, deps, 'bundle');
	if (have !== null && compareNodeVersions(have, runtime.version) >= 0) {
		return { strategy: 'already', verified: true, routine: true, detail: '' };
	}
	// Download the release's Node from nodejs.org.
	const arch = deps.arch ?? process.arch;
	if (arch !== 'x64' && arch !== 'arm64')
		return {
			strategy: 'unsupported-arch',
			verified: true,
			detail: `Node runtime: ${installed} is ${have ?? 'unknown'}; Morphit downloads Node ${runtime.version} only for x64 and arm64, and this server is ${arch}. Install Node ${runtime.version} in ${prefix} yourself.`
		};
	const pin = runtime.sha256[arch];
	const work = deps.workDir ?? '/var/lib/morphit/node-runtime';
	const name = `node-${runtime.version}-linux-${arch}`;
	const tarball = join(work, `${name}.tar.xz`);
	const download = deps.download ?? realDownload;
	const hidden = (deps.hiddenOnly ?? isHiddenOnlyNode)();
	const url = nodeTarballUrl(runtime.version, arch);
	try {
		rmSync(work, { recursive: true, force: true });
		mkdirSync(work, { recursive: true, mode: 0o700 });
	} catch {
		/* the download below fails and says so */
	}
	let came = false;
	let route = '';
	for (const viaTor of hidden ? [true] : [false, true]) {
		const stop = ctx.spinner(
			`Downloading Node.js ${runtime.version} from nodejs.org${viaTor ? ' through Tor' : ''} (${have ?? 'unknown'} → ${runtime.version})…`
		);
		try {
			rmSync(tarball, { force: true });
			came = await download(url, tarball, viaTor);
		} finally {
			stop();
		}
		if (came) {
			route = viaTor ? ' through Tor' : '';
			break;
		}
	}
	const cleanup = () => rmSync(work, { recursive: true, force: true });
	if (!came) {
		cleanup();
		return {
			strategy: 'download-failed',
			verified: false,
			detail: `Node runtime: ${installed} is ${have ?? 'unknown'}, older than Node ${runtime.version} this release runs on, and nodejs.org could not be reached${hidden ? ' through Tor' : ', directly or through Tor'}, so it stays as it is for now; the next upgrade tries again (on this server: sudo morphit-ops upgrade --heals).`
		};
	}
	const sum = await (deps.sha256Of ?? realSha256)(tarball);
	if (sum === null || sum !== pin) {
		cleanup();
		return {
			strategy: 'checksum-mismatch',
			verified: false,
			detail: `Node runtime: the Node ${runtime.version} downloaded from nodejs.org${route} is not the file this release names (its SHA-256 differs), so it was thrown away and ${installed} stays ${have ?? 'unknown'}; the next upgrade tries again.`
		};
	}
	const stop = ctx.spinner(`Unpacking Node.js ${runtime.version}…`);
	let unpacked = false;
	try {
		unpacked = await (deps.unpack ?? realUnpack)(tarball, work);
	} finally {
		stop();
	}
	const dir = join(work, name);
	const got = unpacked ? versionOf(join(dir, 'bin', 'node')) : null;
	if (got !== runtime.version) {
		cleanup();
		return {
			strategy: 'unpack-failed',
			verified: false,
			detail: `Node runtime: Node ${runtime.version} was downloaded and checked, but ${unpacked ? `the Node inside reports ${got ?? 'nothing'}` : 'it could not be unpacked'}, so ${installed} stays ${have ?? 'unknown'}.`
		};
	}
	try {
		return await putInPlace(
			ctx,
			dir,
			got,
			installed,
			prefix,
			have,
			versionOf,
			deps,
			`nodejs.org${route}`
		);
	} finally {
		cleanup();
	}
}

async function putInPlace(
	ctx: HealCtx,
	vendor: string,
	want: string,
	installed: string,
	prefix: string,
	have: string | null,
	versionOf: (bin: string) => string | null,
	deps: NodeRuntimeDeps,
	from: string
): Promise<HealResult> {
	const source = join(vendor, 'bin', 'node');
	const stop = ctx.spinner(`Updating the Node.js runtime ${have ?? '(unknown)'} → ${want}…`);
	try {
		for (const n of readdirSync(vendor)) {
			if (n === 'bin') continue;
			cpSync(join(vendor, n), join(prefix, n), { recursive: true, force: true });
		}
		for (const n of readdirSync(join(vendor, 'bin'))) {
			if (n === 'node') continue;
			cpSync(join(vendor, 'bin', n), join(prefix, 'bin', n), {
				recursive: true,
				force: true,
				verbatimSymlinks: true
			});
		}
		const tmp = `${installed}.new`;
		rmSync(tmp, { force: true });
		copyFileSync(source, tmp);
		chmodSync(tmp, 0o755);
		renameSync(tmp, installed);
	} catch (e) {
		return {
			strategy: 'failed',
			verified: false,
			detail: `Node runtime: could not put ${want} in place (${e instanceof Error ? e.message : String(e)}); ${installed} is still ${have ?? 'unknown'}. On this server: sudo morphit-ops upgrade --heals`
		};
	} finally {
		stop();
	}
	const now = versionOf(installed);
	if (now !== want)
		return {
			strategy: 'failed',
			verified: false,
			detail: `Node runtime: ${installed} reports ${now ?? 'nothing'} after the update to ${want}. On this server: sudo morphit-ops upgrade --heals`
		};
	if (deps.restartServices) {
		const s = ctx.spinner('Restarting the Morphit services onto the new Node…');
		try {
			await deps.restartServices();
		} finally {
			s();
		}
	}
	return {
		strategy: from === 'bundle' ? 'updated' : 'downloaded',
		verified: true,
		detail: `Node runtime: ${installed} updated ${have ?? '(unknown)'} → ${want} (${from === 'bundle' ? 'from the bundle' : `from ${from}, its SHA-256 checked`}); ${deps.restartServices ? 'the Morphit services were restarted onto it' : 'the services restart on it with this upgrade'}.`
	};
}
