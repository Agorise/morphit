/**
 * The frontend's pinned nginx base from the offline bundle: usable by name
 * and by digest, and never trusted before it is proven to be the pinned image
 * (lib/frontendBaseImage.ts; Docker 29.8.2 behaviour in its header).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	digestOf,
	frontendBaseState,
	loadBundledFrontendBase,
	pinnedConfigDigests,
	tagOf,
	withTagOnlyFrom,
	type BaseImageHost
} from '../src/lib/frontendBaseImage.ts';
import { FRONTEND_BASE, isMorphitFrontendDockerfile } from '../src/lib/proxyConfigHeal.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const sha = (b: Buffer): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const J = (o: unknown): Buffer => Buffer.from(JSON.stringify(o));

/** An OCI layout like the one a containerd-store `docker save <tag>` writes. */
function layout(arches = ['amd64', 'arm64']) {
	const blobs = new Map<string, Buffer>();
	const configs: string[] = [];
	const manifests = arches.map((arch) => {
		const cfg = J({ architecture: arch, os: 'linux', rootfs: { type: 'layers', diff_ids: [] } });
		blobs.set(sha(cfg), cfg);
		configs.push(sha(cfg));
		const m = J({
			schemaVersion: 2,
			mediaType: 'application/vnd.oci.image.manifest.v1+json',
			config: {
				mediaType: 'application/vnd.oci.image.config.v1+json',
				digest: sha(cfg),
				size: cfg.length
			},
			layers: []
		});
		blobs.set(sha(m), m);
		return {
			mediaType: 'application/vnd.oci.image.manifest.v1+json',
			digest: sha(m),
			size: m.length,
			platform: { os: 'linux', architecture: arch }
		};
	});
	const att = J({ schemaVersion: 2, config: { digest: sha(J('att')) } });
	blobs.set(sha(att), att);
	const index = J({
		schemaVersion: 2,
		mediaType: 'application/vnd.oci.image.index.v1+json',
		manifests: [
			...manifests,
			{ digest: sha(att), platform: { os: 'unknown', architecture: 'unknown' } }
		]
	});
	blobs.set(sha(index), index);
	return {
		blobs,
		index: sha(index),
		configs,
		manifests: manifests.map((m) => m.digest),
		att: sha(J('att'))
	};
}

describe('pinnedConfigDigests (PURE)', () => {
	it('the configs of every image the pinned index lists, each manifest hash-checked; attestations left out', () => {
		const l = layout();
		expect(pinnedConfigDigests(l.index, (d) => l.blobs.get(d) ?? null)).toEqual(l.configs);
	});
	it('a pinned blob that does not hash to the pinned digest proves nothing', () => {
		const l = layout();
		const forged = Buffer.concat([l.blobs.get(l.index)!, Buffer.from(' ')]);
		expect(
			pinnedConfigDigests(l.index, (d) => (d === l.index ? forged : (l.blobs.get(d) ?? null)))
		).toEqual([]);
	});
	it('a listed manifest whose bytes were changed (another config) is not counted', () => {
		const l = layout();
		const evil = J({ schemaVersion: 2, config: { digest: `sha256:${'e'.repeat(64)}` } });
		const got = pinnedConfigDigests(l.index, (d) =>
			d === l.manifests[0] ? evil : (l.blobs.get(d) ?? null)
		);
		expect(got).toEqual([l.configs[1]]);
		expect(got).not.toContain(`sha256:${'e'.repeat(64)}`);
	});
	it('a manifest pinned directly gives its own config; a missing blob gives nothing', () => {
		const l = layout(['amd64']);
		expect(pinnedConfigDigests(l.manifests[0]!, (d) => l.blobs.get(d) ?? null)).toEqual([
			l.configs[0]
		]);
		expect(pinnedConfigDigests(l.index, () => null)).toEqual([]);
	});
});

/** A Docker host: which references resolve to which ID, which images a
 *  container can be created from, the bundle's blobs. */
function host(o: {
	refs: Record<string, string>;
	creatable?: string[];
	bundle?: Map<string, Buffer> | null;
}) {
	const calls: string[] = [];
	const h: BaseImageHost = {
		docker: (args) => {
			calls.push(args.join(' '));
			if (args[0] === 'image' && args[1] === 'inspect') {
				const id = o.refs[args[args.length - 1]!];
				return id ? { ok: true, out: id } : { ok: false, out: '' };
			}
			if (args[0] === 'create') {
				const img = args[args.length - 2]!;
				return { ok: (o.creatable ?? Object.keys(o.refs)).includes(img), out: '' };
			}
			return { ok: true, out: '' };
		},
		bundleBlob: (_f, d) => o.bundle?.get(d) ?? null,
		exists: () => o.bundle !== null && o.bundle !== undefined
	};
	return { h, calls };
}

describe('frontendBaseState', () => {
	const l = layout();
	const ref = `nginx:1.30.5-alpine@${l.index}`;
	const tag = tagOf(ref);

	it('containerd store (found by name:tag@digest, a container can be created): by digest', () => {
		const { h, calls } = host({ refs: { [ref]: l.index, [tag]: l.index }, bundle: null });
		expect(frontendBaseState(ref, null, h)).toBe('digest');
		expect(calls.some((c) => c.startsWith('create --pull never --network none'))).toBe(true);
		expect(calls.some((c) => /^pull\b/.test(c))).toBe(false);
	});
	it('found by digest but its layers are not all here (a blob dropped at load): not usable', () => {
		const { h } = host({ refs: { [ref]: l.index }, creatable: [], bundle: null });
		expect(frontendBaseState(ref, null, h)).toBe('absent');
	});
	it('classic store: the tag is the image whose config the pinned index names → by tag', () => {
		const { h } = host({ refs: { [tag]: l.configs[0]! }, bundle: l.blobs });
		expect(frontendBaseState(ref, '/b.tar.gz', h)).toBe('tag');
	});
	it('classic store: the tag is some other image (re-pushed tag, a forged bundle) → absent', () => {
		const { h } = host({ refs: { [tag]: `sha256:${'f'.repeat(64)}` }, bundle: l.blobs });
		expect(frontendBaseState(ref, '/b.tar.gz', h)).toBe('absent');
	});
	it('classic store without the bundle to prove it: absent (nothing digest-less is trusted)', () => {
		const { h } = host({ refs: { [tag]: l.configs[0]! }, bundle: null });
		expect(frontendBaseState(ref, '/b.tar.gz', h)).toBe('absent');
	});
	it('`docker load` exit 0 is not evidence: only what is usable afterwards counts', () => {
		const { h } = host({ refs: { [ref]: l.index }, creatable: [], bundle: l.blobs });
		expect(loadBundledFrontendBase(ref, '/b.tar.gz', 10_000, h, () => true)).toBe('absent');
		const ok = host({ refs: {}, bundle: l.blobs });
		let loaded = false;
		expect(
			loadBundledFrontendBase(ref, '/b.tar.gz', 10_000, ok.h, () => {
				loaded = true;
				ok.h.docker = (args) =>
					args[0] === 'image' && args[args.length - 1] === tag
						? { ok: true, out: l.configs[1]! }
						: { ok: args[0] !== 'image', out: '' };
				return false;
			})
		).toBe('tag');
		expect(loaded).toBe(true);
	});
});

describe('withTagOnlyFrom', () => {
	const shipped = readFileSync(join(REPO, 'ops/bunkerweb/frontend/Dockerfile'), 'utf8');
	it('only the FROM line loses its digest; the label keeps the pinned reference; still a Morphit Dockerfile', () => {
		const out = withTagOnlyFrom(shipped, FRONTEND_BASE);
		expect(out).toMatch(new RegExp(`^FROM ${tagOf(FRONTEND_BASE).replace(/\./g, '\\.')}$`, 'm'));
		expect(out).toContain(`LABEL org.morphit.frontend-base="${FRONTEND_BASE}"`);
		expect(out.split('\n').length).toBe(shipped.split('\n').length);
		expect(isMorphitFrontendDockerfile(out)).toBe(true);
		expect(digestOf(FRONTEND_BASE)).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});
