/**
 * Is the frontend's pinned nginx base (`name:tag@digest`) on this box, and
 * can a build use it without asking a registry? And: load the offline
 * bundle's copy, then prove it is the pinned image before anything uses it.
 *
 * Docker 29.8.2, seen on both image stores (2026-10-06):
 *  - containerd store: an image loaded from a save BY TAG is found by
 *    `name:tag` and by `name:tag@digest`, and a `FROM name:tag@digest` build
 *    uses it offline. Saved by `name:tag@digest` it loads with no name at all.
 *    A blob whose bytes do not match its digest is dropped by `docker load`,
 *    which still exits 0 and still names the image: only a container create
 *    shows the image cannot be used (a build would then fetch the blob).
 *  - classic store (overlay2, boxes whose Docker predates 29): `docker load`
 *    never records a digest, so the loaded image is found by `name:tag` only,
 *    and a `FROM name:tag@digest` build asks the registry. A `FROM name:tag`
 *    build of an image that is here asks no registry. The loaded image's ID
 *    is its config's digest, and `docker load` refuses layers that do not
 *    match that config.
 *
 * So the bundle saves the base by tag with its original index (the pinned
 * digest) inside, and here:
 *  - 'digest': `docker image inspect name:tag@digest` finds it and a
 *    container can be created from it (no pull): any build may use the pinned
 *    FROM line;
 *  - 'tag': classic store, `name:tag` is the image whose config the pinned
 *    index names — checked hash by hash from the bundle's own copy of that
 *    index and manifest — and a container can be created from it: a build
 *    uses `FROM name:tag` (the label keeps the pinned reference);
 *  - 'absent': anything else. Nothing is fetched here, ever.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type BaseState = 'digest' | 'tag' | 'absent';

/** The pinned reference without its digest (`nginx:1.30.5-alpine`). */
export function tagOf(ref: string): string {
	return ref.split('@')[0]!;
}

/** The pinned reference's digest (`sha256:…`), or null. */
export function digestOf(ref: string): string | null {
	const m = /@(sha256:[0-9a-f]{64})$/.exec(ref);
	return m ? m[1]! : null;
}

/** Where an offline bundle keeps its saved copy of `ref`
 *  (scripts/build-offline-bundle.sh: `tr '/:' '__'`). */
export function bundledBaseFile(installRoot: string, ref: string): string {
	return join(installRoot, 'vendor', 'docker', `${ref.replace(/[/:]/g, '_')}.tar.gz`);
}

const sha256 = (b: Buffer): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/**
 * PURE. The config digests the pinned digest stands for, from the blobs of an
 * OCI layout: the pinned blob must hash to the pinned digest; when it is an
 * index, each image manifest it lists (attestations aside) that is present
 * and hashes to its digest gives its config digest; when it is a manifest,
 * its own config digest. Nothing that does not hash right counts.
 */
export function pinnedConfigDigests(
	pinned: string,
	readBlob: (digest: string) => Buffer | null
): string[] {
	const parse = (d: string): Record<string, unknown> | null => {
		if (!/^sha256:[0-9a-f]{64}$/.test(d)) return null;
		const b = readBlob(d);
		if (b === null || sha256(b) !== d) return null;
		try {
			const j: unknown = JSON.parse(b.toString('utf8'));
			return j !== null && typeof j === 'object' ? (j as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	};
	const configOf = (m: Record<string, unknown> | null): string | null => {
		const c = (m?.config as { digest?: unknown } | undefined)?.digest;
		return typeof c === 'string' && /^sha256:[0-9a-f]{64}$/.test(c) ? c : null;
	};
	const top = parse(pinned);
	if (top === null) return [];
	if (!Array.isArray(top.manifests)) {
		const c = configOf(top);
		return c ? [c] : [];
	}
	const out: string[] = [];
	for (const e of top.manifests as Array<Record<string, unknown>>) {
		const os = (e?.platform as { os?: unknown } | undefined)?.os;
		if (typeof e?.digest !== 'string' || os === 'unknown') continue;
		const c = configOf(parse(e.digest));
		if (c && !out.includes(c)) out.push(c);
	}
	return out;
}

/** PURE. A frontend Dockerfile whose pinned `FROM name:tag@digest` line reads
 *  `FROM name:tag` (everything else, the label included, as it was). */
export function withTagOnlyFrom(dockerfile: string, ref: string): string {
	const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return dockerfile.replace(new RegExp(`^(\\s*FROM\\s+)${esc}(\\s*)$`, 'm'), `$1${tagOf(ref)}$2`);
}

/** What the checks below need from the box (tests drive them with fakes). */
export interface BaseImageHost {
	/** `docker <args>`: exit 0, and its stdout. */
	docker(args: readonly string[], timeoutMs: number): { ok: boolean; out: string };
	/** One blob of the saved image (a gzipped tar), or null. */
	bundleBlob(file: string, digest: string): Buffer | null;
	exists(file: string): boolean;
}

export const realBaseImageHost: BaseImageHost = {
	docker: (args, timeout) => {
		try {
			const r = spawnSync('docker', [...args], {
				encoding: 'utf8',
				timeout,
				stdio: ['ignore', 'pipe', 'ignore']
			});
			return { ok: r.status === 0, out: `${r.stdout ?? ''}`.trim() };
		} catch {
			return { ok: false, out: '' };
		}
	},
	bundleBlob: (file, digest) => {
		try {
			const r = spawnSync(
				'tar',
				['-xzOf', file, '--occurrence=1', `blobs/sha256/${digest.slice('sha256:'.length)}`],
				{ timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
			);
			return r.status === 0 && r.stdout ? Buffer.from(r.stdout) : null;
		} catch {
			return null;
		}
	},
	exists: (f) => existsSync(f)
};

/** A container can be created from `image` without any pull (all of its
 *  layers are here); the container is removed again. */
function usable(host: BaseImageHost, image: string, timeoutMs: number): boolean {
	const name = `morphit-base-check-${process.pid}`;
	host.docker(['rm', '-f', name], timeoutMs);
	const ok = host.docker(
		['create', '--pull', 'never', '--network', 'none', '--name', name, image, 'true'],
		timeoutMs
	).ok;
	host.docker(['rm', '-f', name], timeoutMs);
	return ok;
}

/**
 * Which way a build can use the pinned base on this box (see the header).
 * `bundle` is the offline bundle's saved copy, when the install has one: the
 * only evidence that a digest-less image is the pinned one.
 */
export function frontendBaseState(
	ref: string,
	bundle: string | null,
	host: BaseImageHost = realBaseImageHost,
	timeoutMs = 15_000
): BaseState {
	const digest = digestOf(ref);
	if (digest === null) return 'absent';
	if (host.docker(['image', 'inspect', '--format', '{{.Id}}', ref], timeoutMs).ok)
		return usable(host, ref, timeoutMs) ? 'digest' : 'absent';
	if (bundle === null || !host.exists(bundle)) return 'absent';
	const id = host.docker(['image', 'inspect', '--format', '{{.Id}}', tagOf(ref)], timeoutMs);
	if (!id.ok || !/^sha256:[0-9a-f]{64}$/.test(id.out)) return 'absent';
	const configs = pinnedConfigDigests(digest, (d) => host.bundleBlob(bundle, d));
	if (!configs.includes(id.out)) return 'absent';
	return usable(host, tagOf(ref), timeoutMs) ? 'tag' : 'absent';
}

/**
 * Load the offline bundle's copy of the pinned base (when the install has
 * one), then check it as above. Returns what a build can use afterwards.
 */
export function loadBundledFrontendBase(
	ref: string,
	bundle: string,
	timeoutMs: number,
	host: BaseImageHost = realBaseImageHost,
	load: (file: string, timeoutMs: number) => boolean = loadGzipImage
): BaseState {
	if (!host.exists(bundle)) return 'absent';
	const t0 = Date.now();
	load(bundle, timeoutMs);
	// Whatever `docker load` said: only what is here now counts.
	return frontendBaseState(ref, bundle, host, Math.max(5_000, timeoutMs - (Date.now() - t0)));
}

function loadGzipImage(file: string, timeoutMs: number): boolean {
	try {
		return (
			spawnSync('sh', ['-c', 'gzip -dc "$1" | docker load', 'sh', file], {
				stdio: 'ignore',
				timeout: timeoutMs
			}).status === 0
		);
	} catch {
		return false;
	}
}
