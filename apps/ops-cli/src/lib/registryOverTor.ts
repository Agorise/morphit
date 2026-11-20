/**
 * Fetch the frontend's pinned base image straight from Docker Hub's registry
 * through Tor — without Docker, and without changing Docker's settings — and
 * write it as the offline bundle's saved copy, so lib/frontendBaseImage.ts
 * loads it and proves it is the pinned image, hash by hash.
 *
 * Why (v1.24.7): Docker Hub refuses some servers outright (morphitir:
 * `https://registry-1.docker.io/v2/` answers 403 instead of 401, for any image;
 * Docker Hub does that for whole networks and countries). Such a server could
 * never move its frontend to a new base. Through Tor, Docker Hub answers.
 *
 * Every piece is checked before anything is loaded: the image list's bytes
 * hash to the pinned digest (the trust anchor: it comes with the release,
 * whose own hash is anchored on chain); this server's platform manifest hashes
 * to the digest that list names; its config and each layer hash to the digests
 * that manifest names. Anything else is refused.
 *
 * The archive holds what `docker save` writes for one platform: an OCI layout
 * (oci-layout, index.json naming the pinned list) plus manifest.json for
 * Docker's classic image store.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	createReadStream,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { digestOf, tagOf } from './frontendBaseImage.ts';

export const DOCKER_HUB_REGISTRY = 'https://registry-1.docker.io';
export const DOCKER_HUB_AUTH = 'https://auth.docker.io/token';

const INDEX_TYPES = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json'
];
const MANIFEST_TYPES = [
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json'
];

/** What the fetch needs from the box (tests drive it with a local registry). */
export interface RegistryFetchHost {
	/** `curl <args>`: exit status and stdout (a body is written to a file by -o). */
	curl(args: readonly string[], timeoutMs: number): Promise<{ status: number | null; out: string }>;
	/** sha256 of a file, `sha256:<hex>`, or null. */
	hashFile(file: string): Promise<string | null>;
	/** `tar` the layout into a gzipped archive. */
	tar(dir: string, out: string, timeoutMs: number): Promise<boolean>;
	now(): number;
}

export interface RegistryFetchOptions {
	/** Tor's SocksPort, host:port; null only in tests (a local registry). */
	readonly socks: string | null;
	/** `os/architecture` of this server's Docker (`linux/amd64`). */
	readonly platform: string;
	readonly timeoutMs: number;
	readonly registry?: string;
	readonly auth?: string;
}

export type RegistryFetchResult = { ok: true } | { ok: false; why: string };

/** PURE. `docker version`'s Server.Os/Server.Arch is already Go's naming
 *  (linux/amd64, linux/arm64); a few uname spellings are mapped too. */
export function normalizePlatform(s: string): string {
	const [os = '', arch = ''] = s.trim().toLowerCase().split('/');
	const a = arch === 'x86_64' ? 'amd64' : arch === 'aarch64' ? 'arm64' : arch;
	return `${os}/${a}`;
}

/** PURE. The manifest for `platform` in an image list, or why there is none. */
export function pickPlatform(
	list: unknown,
	platform: string
): { digest: string; mediaType: string; size: number } | string {
	const ms = (list as { manifests?: unknown })?.manifests;
	if (!Array.isArray(ms)) return 'the pinned image is not an image list';
	const [os, arch] = platform.split('/');
	for (const e of ms as Array<Record<string, unknown>>) {
		const p = e?.platform as { os?: unknown; architecture?: unknown } | undefined;
		if (p?.os === os && p?.architecture === arch && typeof e.digest === 'string')
			return {
				digest: e.digest,
				mediaType: typeof e.mediaType === 'string' ? e.mediaType : MANIFEST_TYPES[0]!,
				size: typeof e.size === 'number' ? e.size : 0
			};
	}
	return `the pinned image list has no ${platform} image`;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** `library/nginx` for `nginx:1.30.7-alpine@…`; null for anything not an
 *  official Docker Hub image. */
export function hubRepo(ref: string): string | null {
	const m = /^(?:docker\.io\/)?(?:library\/)?([a-z0-9._-]+):[\w.-]+@sha256:[0-9a-f]{64}$/.exec(ref);
	return m ? `library/${m[1]}` : null;
}

/**
 * Fetch `ref` (name:tag@sha256:…) for this server's platform into `outFile`
 * (a gzipped `docker save`-style archive). Nothing is written to `outFile`
 * unless every piece hashed right.
 */
export async function fetchImageOverTor(
	ref: string,
	outFile: string,
	o: RegistryFetchOptions,
	host: RegistryFetchHost
): Promise<RegistryFetchResult> {
	const repo = hubRepo(ref);
	const pinned = digestOf(ref);
	if (repo === null || pinned === null)
		return { ok: false, why: `${ref} is not an official image pinned by digest` };
	const registry = o.registry ?? DOCKER_HUB_REGISTRY;
	const auth = o.auth ?? DOCKER_HUB_AUTH;
	const until = host.now() + o.timeoutMs;
	const left = (): number => Math.max(1_000, until - host.now());
	// --noproxy '': curl applies no_proxy even to a SOCKS proxy.
	const via = o.socks === null ? [] : ['--noproxy', '', '--socks5-hostname', o.socks];
	const dir = mkdtempSync(join(tmpdir(), 'morphit-base-'));
	const blobs = join(dir, 'blobs', 'sha256');
	mkdirSync(blobs, { recursive: true });
	const blobPath = (d: string): string => join(blobs, d.slice('sha256:'.length));
	try {
		// 1. A pull token (anonymous; Docker Hub's rule even for public images).
		const tokFile = join(dir, 'token.json');
		const t = await host.curl(
			[
				'-sS',
				'-f',
				'-m',
				String(Math.ceil(Math.min(left(), 120_000) / 1000)),
				...via,
				'-o',
				tokFile,
				`${auth}?service=registry.docker.io&scope=repository:${repo}:pull`
			],
			Math.min(left(), 130_000)
		);
		let token = '';
		try {
			token = t.status === 0 ? String(JSON.parse(readFileSync(tokFile, 'utf8')).token ?? '') : '';
		} catch {
			token = '';
		}
		rmSync(tokFile, { force: true });
		if (token === '') return { ok: false, why: "Docker Hub's sign-in did not answer through Tor" };
		const authz = ['-H', `Authorization: Bearer ${token}`];

		// 2. One registry object by digest, kept only if it hashes to it.
		const get = async (
			path: string,
			digest: string,
			accept: string[] | null
		): Promise<string | null> => {
			const out = blobPath(digest);
			const r = await host.curl(
				[
					'-sS',
					'-f',
					'-L',
					'-m',
					String(Math.ceil(left() / 1000)),
					...via,
					...authz,
					...(accept ? ['-H', `Accept: ${accept.join(', ')}`] : []),
					'-o',
					out,
					`${registry}/v2/${repo}/${path}/${digest}`
				],
				left() + 10_000
			);
			if (r.status !== 0)
				return `Docker Hub did not send ${digest.slice(0, 19)}… through Tor (curl exit ${r.status ?? 'stopped'})`;
			if ((await host.hashFile(out)) !== digest) {
				rmSync(out, { force: true });
				return `what Docker Hub sent for ${digest.slice(0, 19)}… does not hash to it`;
			}
			return null;
		};
		const json = (d: string): Record<string, unknown> | null => {
			try {
				const j: unknown = JSON.parse(readFileSync(blobPath(d), 'utf8'));
				return j !== null && typeof j === 'object' ? (j as Record<string, unknown>) : null;
			} catch {
				return null;
			}
		};

		// 3. The pinned image list, this platform's manifest, its config and layers.
		let why = await get('manifests', pinned, [...INDEX_TYPES, ...MANIFEST_TYPES]);
		if (why) return { ok: false, why };
		const list = json(pinned);
		if (!list || !INDEX_TYPES.includes(String(list.mediaType)))
			return { ok: false, why: 'the pinned digest is not a multi-platform image list' };
		const pick = pickPlatform(list, o.platform);
		if (typeof pick === 'string') return { ok: false, why: pick };
		if (!DIGEST.test(pick.digest))
			return { ok: false, why: 'the image list names a malformed digest' };
		why = await get('manifests', pick.digest, MANIFEST_TYPES);
		if (why) return { ok: false, why };
		const man = json(pick.digest);
		const config = (man?.config as { digest?: unknown } | undefined)?.digest;
		const layers = Array.isArray(man?.layers)
			? (man!.layers as Array<{ digest?: unknown }>).map((l) => l?.digest)
			: null;
		if (
			typeof config !== 'string' ||
			!DIGEST.test(config) ||
			!layers ||
			layers.length === 0 ||
			!layers.every((l): l is string => typeof l === 'string' && DIGEST.test(l))
		)
			return { ok: false, why: `the ${o.platform} manifest is not an image manifest` };
		for (const d of [config, ...layers]) {
			why = await get('blobs', d, null);
			if (why) return { ok: false, why };
		}

		// 4. The archive, as `docker save` writes it for one platform.
		const tag = tagOf(ref);
		const tagName = tag.split(':')[1]!;
		writeFileSync(join(dir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
		writeFileSync(
			join(dir, 'index.json'),
			JSON.stringify({
				schemaVersion: 2,
				mediaType: 'application/vnd.oci.image.index.v1+json',
				manifests: [
					{
						mediaType: String(list.mediaType),
						digest: pinned,
						size: readFileSync(blobPath(pinned)).length,
						annotations: {
							'io.containerd.image.name': `docker.io/${repo}:${tagName}`,
							'org.opencontainers.image.ref.name': tagName
						}
					}
				]
			})
		);
		writeFileSync(
			join(dir, 'manifest.json'),
			JSON.stringify([
				{
					Config: `blobs/sha256/${config.slice(7)}`,
					RepoTags: [tag],
					Layers: layers.map((l) => `blobs/sha256/${l.slice(7)}`)
				}
			])
		);
		mkdirSync(dirname(outFile), { recursive: true });
		const part = `${outFile}.part`;
		if (!(await host.tar(dir, part, left()))) {
			rmSync(part, { force: true });
			return { ok: false, why: 'the archive could not be written' };
		}
		renameSync(part, outFile);
		return { ok: true };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** PURE. Docker Hub's answer to an anonymous `GET /v2/`: 401 means it
 *  answers this server (it asks for a token); 403 means it refuses it. */
export function hubRefuses(httpCode: string): boolean {
	return httpCode.trim() === '403';
}

function run(
	cmd: string,
	args: readonly string[],
	timeoutMs: number
): Promise<{ status: number | null; out: string }> {
	return new Promise((resolve) => {
		let out = '';
		let child;
		try {
			child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
		} catch {
			resolve({ status: null, out: '' });
			return;
		}
		child.stdout?.on('data', (b: Buffer) => (out = (out + b.toString('utf8')).slice(-8192)));
		child.stderr?.on('data', () => undefined);
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.on('error', () => (clearTimeout(timer), resolve({ status: null, out })));
		child.on('close', (code) => (clearTimeout(timer), resolve({ status: code, out })));
	});
}

export const realRegistryFetchHost: RegistryFetchHost = {
	curl: (args, t) => run('curl', args, t),
	hashFile: (file) =>
		new Promise((resolve) => {
			const h = createHash('sha256');
			const s = createReadStream(file);
			s.on('data', (b) => h.update(b));
			s.on('error', () => resolve(null));
			s.on('end', () => resolve(`sha256:${h.digest('hex')}`));
		}),
	tar: async (dir, out, t) =>
		(
			await run(
				'tar',
				['-czf', out, '-C', dir, 'oci-layout', 'index.json', 'manifest.json', 'blobs'],
				t
			)
		).status === 0,
	now: () => Date.now()
};

/** Does Docker Hub refuse this server? Asked directly (never through Tor),
 *  so call it only on a server that may use clearnet. */
export function dockerHubRefusesThisServer(timeoutMs = 20_000): boolean {
	try {
		const r = spawnSync(
			'curl',
			[
				'-s',
				'-o',
				'/dev/null',
				'-m',
				String(Math.ceil(timeoutMs / 1000)),
				'-w',
				'%{http_code}',
				`${DOCKER_HUB_REGISTRY}/v2/`
			],
			{ encoding: 'utf8', timeout: timeoutMs + 5_000, stdio: ['ignore', 'pipe', 'ignore'] }
		);
		return hubRefuses(`${r.stdout ?? ''}`);
	} catch {
		return false;
	}
}

/** This server's Docker platform (`linux/amd64`), or null. */
export async function dockerPlatform(timeoutMs = 15_000): Promise<string | null> {
	const r = await run(
		'docker',
		['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'],
		timeoutMs
	);
	return r.status === 0 && /^[a-z]+\/[a-z0-9_]+$/.test(r.out.trim())
		? normalizePlatform(r.out)
		: null;
}
