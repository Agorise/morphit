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
 * A box whose Node came from apt (/usr/bin/node) is left to apt. No network.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	readdirSync,
	renameSync,
	rmSync
} from 'node:fs';
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';

export interface NodeRuntimeDeps {
	readonly installDir: string;
	/** Where the vendored runtime lives on this box (default /usr/local). */
	readonly prefix?: string;
	/** `<binary> --version`, or null when it does not run. */
	readonly versionOf?: (bin: string) => string | null;
}

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
	const vendor = join(deps.installDir, 'vendor', 'node');
	const bundled = join(vendor, 'bin', 'node');
	const installed = join(prefix, 'bin', 'node');
	if (!existsSync(bundled)) return { strategy: 'no-bundle', verified: true, detail: '' };
	if (!existsSync(installed)) {
		return { strategy: 'not-vendored', verified: true, detail: '' };
	}
	const want = versionOf(bundled);
	const have = versionOf(installed);
	if (want === null) {
		return {
			strategy: 'skipped',
			verified: false,
			detail: `Node runtime: the bundled ${bundled} does not run here, so ${installed} (${have ?? 'unknown'}) was left as it is.`
		};
	}
	if (have !== null && compareNodeVersions(have, want) >= 0) {
		return { strategy: 'already', verified: true, detail: '' };
	}
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
		copyFileSync(bundled, tmp);
		chmodSync(tmp, 0o755);
		renameSync(tmp, installed);
	} catch (e) {
		return {
			strategy: 'failed',
			verified: false,
			detail: `Node runtime: could not put ${want} in place (${e instanceof Error ? e.message : String(e)}); ${installed} is still ${have ?? 'unknown'}. On this server run: sudo cp -a ${vendor}/. ${prefix}/`
		};
	} finally {
		stop();
	}
	const now = versionOf(installed);
	return now === want
		? {
				strategy: 'updated',
				verified: true,
				detail: `Node runtime: ${installed} updated ${have ?? '(unknown)'} → ${want}; the services use it from their next start.`
			}
		: {
				strategy: 'failed',
				verified: false,
				detail: `Node runtime: ${installed} reports ${now ?? 'nothing'} after the update to ${want}. On this server run: sudo cp -a ${vendor}/. ${prefix}/`
			};
}
