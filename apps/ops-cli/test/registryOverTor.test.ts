/**
 * lib/registryOverTor.ts — the frontend's pinned base fetched from Docker
 * Hub's registry without Docker (through Tor on a server; here from a local
 * stand-in registry, with the real curl and tar), every piece hashed against
 * the pinned digest, written as `docker save` writes one platform.
 *
 * Why (v1.24.7): Docker Hub answers morphitir's `/v2/` with 403, for any image.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
	fetchImageOverTor,
	hubRefuses,
	hubRepo,
	normalizePlatform,
	pickPlatform,
	realRegistryFetchHost
} from '../src/lib/registryOverTor.ts';
import { loadBundledFrontendBase, pinnedConfigDigests } from '../src/lib/frontendBaseImage.ts';

const sha = (b: Buffer | string): string =>
	`sha256:${createHash('sha256').update(b).digest('hex')}`;

// ─── A small image, as Docker Hub serves one ─────────────────────────────
/** A one-file tar (512-byte header + content): a real layer, before gzip. */
function layer(name: string, content: string): Buffer {
	const body = Buffer.from(content);
	const h = Buffer.alloc(512);
	h.write(name, 0);
	h.write('0000644\0', 100);
	h.write('0000000\0', 108);
	h.write('0000000\0', 116);
	h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
	h.write('00000000000\0', 136);
	h.write('        ', 148);
	h.write('0', 156);
	h.write('ustar\0', 257);
	h.write('00', 263);
	let sum = 0;
	for (const b of h) sum += b;
	h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
	const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
	return Buffer.concat([h, body, pad, Buffer.alloc(1024)]);
}
const RAW1 = layer('etc/hello', 'hello\n');
const RAW2 = layer('etc/world', 'world\n');
const L1 = gzipSync(RAW1);
const L2 = gzipSync(RAW2);
const CONFIG = Buffer.from(
	JSON.stringify({
		architecture: 'amd64',
		os: 'linux',
		config: { Cmd: ['true'] },
		rootfs: { type: 'layers', diff_ids: [sha(RAW1), sha(RAW2)] },
		history: []
	})
);
const MANIFEST = Buffer.from(
	JSON.stringify({
		schemaVersion: 2,
		mediaType: 'application/vnd.oci.image.manifest.v1+json',
		config: {
			mediaType: 'application/vnd.oci.image.config.v1+json',
			digest: sha(CONFIG),
			size: CONFIG.length
		},
		layers: [L1, L2].map((l) => ({
			mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
			digest: sha(l),
			size: l.length
		}))
	})
);
const entry = (digest: string, os: string, architecture: string, variant?: string) => ({
	mediaType: 'application/vnd.oci.image.manifest.v1+json',
	digest,
	size: 100,
	platform: { os, architecture, ...(variant ? { variant } : {}) }
});
// Like Docker Hub's: other platforms the registry has (absent here) and an
// attestation, around this server's.
const INDEX = Buffer.from(
	JSON.stringify({
		schemaVersion: 2,
		mediaType: 'application/vnd.oci.image.index.v1+json',
		manifests: [
			entry(sha('arm64'), 'linux', 'arm64', 'v8'),
			entry(sha('att'), 'unknown', 'unknown'),
			entry(sha(MANIFEST), 'linux', 'amd64')
		]
	})
);
const PIN = `nginx:1.30.7-alpine@${sha(INDEX)}`;

/** What the stand-in registry serves, by digest (tests may swap in other bytes). */
const objects = new Map<string, Buffer>([
	[sha(INDEX), INDEX],
	[sha(MANIFEST), MANIFEST],
	[sha(CONFIG), CONFIG],
	[sha(L1), L1],
	[sha(L2), L2]
]);
let tokenOk = true;
const requests: string[] = [];
/** Requests to the "CDN" that carried the registry token (must be none). */
let cdnWithToken = 0;

let server: Server;
let BASE = '';
let CDN = '';
beforeAll(async () => {
	// The real curl, with this test's proxy settings left out of it.
	process.env.no_proxy = process.env.NO_PROXY = '127.0.0.1,localhost';
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://x');
		requests.push(url.pathname);
		if (url.pathname === '/token') {
			if (!tokenOk) return void res.writeHead(401).end();
			return void res.writeHead(200).end(JSON.stringify({ token: 'tok' }));
		}
		// Blobs redirect to a "CDN", as Docker Hub's do (no token there).
		const cdn = /^\/cdn\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
		if (cdn) {
			if (req.headers.authorization) cdnWithToken++;
			const b = objects.get(cdn[1]!);
			return void (b ? res.writeHead(200).end(b) : res.writeHead(404).end());
		}
		const m = /^\/v2\/library\/nginx\/(manifests|blobs)\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
		if (!m || req.headers.authorization !== 'Bearer tok') return void res.writeHead(401).end();
		// Another host name for the same server: curl must not carry the token there.
		if (m[1] === 'blobs') return void res.writeHead(307, { location: `${CDN}/cdn/${m[2]}` }).end();
		const b = objects.get(m[2]!);
		return void (b ? res.writeHead(200).end(b) : res.writeHead(404).end());
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	const port = (server.address() as { port: number }).port;
	BASE = `http://127.0.0.1:${port}`;
	CDN = `http://localhost:${port}`;
});
afterAll(() => server.close());

const dirs: string[] = [];
const out = (): string => {
	const d = mkdtempSync(join(tmpdir(), 'morphit-rot-'));
	dirs.push(d);
	return join(d, 'vendor', 'docker', 'nginx_1.30.7-alpine.tar.gz');
};
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const fetch = (file: string, o: { platform?: string; ref?: string } = {}) =>
	fetchImageOverTor(
		o.ref ?? PIN,
		file,
		{
			socks: null,
			platform: o.platform ?? 'linux/amd64',
			timeoutMs: 60_000,
			registry: BASE,
			auth: `${BASE}/token`
		},
		realRegistryFetchHost
	);
const tarList = (f: string): string[] =>
	spawnSync('tar', ['-tzf', f], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
const tarRead = (f: string, member: string): Buffer =>
	spawnSync('tar', ['-xzOf', f, member]).stdout as unknown as Buffer;

describe('fetchImageOverTor (real curl and tar, a local registry)', () => {
	it("writes this platform's image as `docker save` would: oci-layout, index.json naming the pinned list, manifest.json, and only the blobs it needs", async () => {
		const f = out();
		expect(await fetch(f)).toEqual({ ok: true });
		const hex = (b: Buffer) => sha(b).slice(7);
		expect(tarList(f)).toEqual(
			[
				'blobs/',
				'blobs/sha256/',
				...[INDEX, MANIFEST, CONFIG, L1, L2].map((b) => `blobs/sha256/${hex(b)}`),
				'index.json',
				'manifest.json',
				'oci-layout'
			].sort()
		);
		const index = JSON.parse(tarRead(f, 'index.json').toString());
		expect(index.manifests).toEqual([
			{
				mediaType: 'application/vnd.oci.image.index.v1+json',
				digest: sha(INDEX),
				size: INDEX.length,
				annotations: {
					'io.containerd.image.name': 'docker.io/library/nginx:1.30.7-alpine',
					'org.opencontainers.image.ref.name': '1.30.7-alpine'
				}
			}
		]);
		expect(JSON.parse(tarRead(f, 'manifest.json').toString())).toEqual([
			{
				Config: `blobs/sha256/${hex(CONFIG)}`,
				RepoTags: ['nginx:1.30.7-alpine'],
				Layers: [L1, L2].map((l) => `blobs/sha256/${hex(l)}`)
			}
		]);
		for (const b of [INDEX, MANIFEST, CONFIG, L1, L2])
			expect(sha(tarRead(f, `blobs/sha256/${hex(b)}`))).toBe(sha(b));
	});

	it("the archive passes frontendBaseImage's own proof: the pinned list leads to this image's config", async () => {
		const f = out();
		await fetch(f);
		const blob = (d: string) => {
			const r = spawnSync('tar', ['-xzOf', f, `blobs/sha256/${d.slice(7)}`]);
			return r.status === 0 ? (r.stdout as unknown as Buffer) : null;
		};
		expect(pinnedConfigDigests(sha(INDEX), blob)).toEqual([sha(CONFIG)]);
	});

	it('the arm64 server gets its own manifest; a platform the list lacks is refused, saying so', async () => {
		const f = out();
		const r = await fetch(f, { platform: 'linux/s390x' });
		expect(r).toEqual({ ok: false, why: 'the pinned image list has no linux/s390x image' });
		expect(existsSync(f)).toBe(false);
	});

	it('a layer whose bytes do not hash to its digest: refused, nothing written, nothing left behind', async () => {
		const f = out();
		const real = objects.get(sha(L2))!;
		objects.set(sha(L2), Buffer.concat([real, Buffer.from('x')]));
		try {
			const r = await fetch(f);
			expect(r.ok).toBe(false);
			expect(r.ok ? '' : r.why).toMatch(
				/^what Docker Hub sent for sha256:[0-9a-f]{12}… does not hash to it$/
			);
			expect(existsSync(f)).toBe(false);
			expect(existsSync(`${f}.part`)).toBe(false);
		} finally {
			objects.set(sha(L2), real);
		}
	});

	it('an image list whose bytes do not hash to the pinned digest: refused before anything else is asked', async () => {
		const f = out();
		const fake = `nginx:1.30.7-alpine@${sha('not the list')}`;
		objects.set(sha('not the list'), INDEX);
		requests.length = 0;
		try {
			const r = await fetch(f, { ref: fake });
			expect(r.ok ? '' : r.why).toMatch(/does not hash to it$/);
			expect(requests.filter((p) => p.startsWith('/v2/'))).toHaveLength(1);
		} finally {
			objects.delete(sha('not the list'));
		}
	});

	it('a pinned single-platform manifest, not a list: refused', async () => {
		const f = out();
		const r = await fetch(f, { ref: `nginx:1.30.7-alpine@${sha(MANIFEST)}` });
		expect(r).toEqual({ ok: false, why: 'the pinned digest is not a multi-platform image list' });
	});

	it('a digest the registry does not have, or a sign-in refused: refused, saying what did not answer', async () => {
		const f = out();
		const missing = await fetch(f, { ref: `nginx:1.30.7-alpine@${sha('nowhere')}` });
		expect(missing.ok ? '' : missing.why).toMatch(
			/^Docker Hub did not send sha256:[0-9a-f]{12}… through Tor \(curl exit 22\)$/
		);
		tokenOk = false;
		try {
			expect(await fetch(out())).toEqual({
				ok: false,
				why: "Docker Hub's sign-in did not answer through Tor"
			});
		} finally {
			tokenOk = true;
		}
	});

	it('only an official image pinned by digest is fetched', async () => {
		expect(await fetch(out(), { ref: 'nginx:1.30.7-alpine' })).toEqual({
			ok: false,
			why: 'nginx:1.30.7-alpine is not an official image pinned by digest'
		});
		expect(hubRepo('evil.example/nginx:1@sha256:' + '0'.repeat(64))).toBeNull();
		expect(hubRepo(PIN)).toBe('library/nginx');
	});

	it('the token goes to the registry only: blobs come from the "CDN" it redirects to, without it', async () => {
		requests.length = 0;
		cdnWithToken = 0;
		expect(await fetch(out())).toEqual({ ok: true });
		expect(requests.filter((p) => p.startsWith('/cdn/'))).toHaveLength(3);
		expect(cdnWithToken).toBe(0);
	});
});

describe('the pure parts', () => {
	it("Docker Hub's 403 means it refuses this server; 401 means it answers (it asks for a token)", () => {
		expect(hubRefuses('403')).toBe(true);
		expect(hubRefuses('401')).toBe(false);
		expect(hubRefuses('000')).toBe(false);
		expect(hubRefuses('')).toBe(false);
	});
	it('platform names', () => {
		expect(normalizePlatform('linux/amd64\n')).toBe('linux/amd64');
		expect(normalizePlatform('Linux/x86_64')).toBe('linux/amd64');
		expect(normalizePlatform('linux/aarch64')).toBe('linux/arm64');
	});
	it('picks the platform, ignoring attestations', () => {
		const list = JSON.parse(INDEX.toString());
		expect(pickPlatform(list, 'linux/amd64')).toEqual({
			digest: sha(MANIFEST),
			mediaType: 'application/vnd.oci.image.manifest.v1+json',
			size: 100
		});
		expect(pickPlatform(list, 'unknown/unknown')).toEqual({
			digest: sha('att'),
			mediaType: 'application/vnd.oci.image.manifest.v1+json',
			size: 100
		});
		expect(pickPlatform({ manifests: [] }, 'linux/amd64')).toBe(
			'the pinned image list has no linux/amd64 image'
		);
		expect(pickPlatform({}, 'linux/amd64')).toBe('the pinned image is not an image list');
	});
});

// With a Docker daemon here (MORPHIT_TEST_DOCKER=1): the archive really loads,
// and loadBundledFrontendBase proves it is the pinned image.
describe.runIf(process.env.MORPHIT_TEST_DOCKER === '1')(
	'docker load of the archive (real daemon)',
	() => {
		it('loads, and is then usable as the pinned base', async () => {
			const f = out();
			expect(await fetch(f)).toEqual({ ok: true });
			spawnSync('docker', ['rmi', '-f', PIN, 'nginx:1.30.7-alpine']);
			const state = loadBundledFrontendBase(PIN, f, 120_000);
			expect(state).not.toBe('absent');
			// A build uses it as the real rebuild names it: by the pinned reference
			// (containerd store), or by its tag once proven (classic store, where a
			// digest makes Docker ask the registry). This test's registry is not
			// Docker Hub, so a build that asked Docker Hub fails.
			const ctx = mkdtempSync(join(tmpdir(), 'morphit-rot-build-'));
			dirs.push(ctx);
			writeFileSync(
				join(ctx, 'Dockerfile'),
				`FROM ${state === 'digest' ? PIN : 'nginx:1.30.7-alpine'}\nLABEL t=1\n`
			);
			const b = spawnSync('docker', ['build', '-q', '-t', 'morphit-rot-test', ctx], {
				encoding: 'utf8'
			});
			expect(b.status, b.stderr).toBe(0);
			spawnSync('docker', ['rmi', '-f', 'morphit-rot-test', PIN, 'nginx:1.30.7-alpine']);
		});
	}
);
