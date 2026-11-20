#!/usr/bin/env node
// Is the frontend's pinned nginx base (ops/bunkerweb/frontend/Dockerfile)
// an image every Morphit server can build from?
//
// v1.24.6 pinned the digest Docker Hub showed for nginx:1.30.7-alpine while
// that release was still being published: an empty placeholder index with no
// image in it. Every server's rebuild then failed with "no match for
// platform". This asks Docker Hub for the pinned index itself and fails
// unless:
//   - the FROM line and the LABEL name the same reference, by digest;
//   - the registry's bytes hash to that digest;
//   - it is a multi-platform index listing linux/amd64 and linux/arm64.
//
// Run by ci.yml on every push, so a bad pin turns CI red before a tag.
// Not reaching Docker Hub is a failure too: no answer is not a pass.
//
//   node scripts/check-frontend-base.mjs [path/to/Dockerfile]
//
// MORPHIT_REGISTRY_URL / MORPHIT_REGISTRY_AUTH_URL point it at another
// registry (its smoke uses a local one).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? join(here, '..', 'ops', 'bunkerweb', 'frontend', 'Dockerfile');
const REGISTRY = process.env.MORPHIT_REGISTRY_URL ?? 'https://registry-1.docker.io';
const AUTH = process.env.MORPHIT_REGISTRY_AUTH_URL ?? 'https://auth.docker.io/token';
const NEEDED = ['linux/amd64', 'linux/arm64'];
const INDEX_TYPES = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json'
];

const fail = (msg) => {
	console.error(`✗ Frontend base image: ${msg}`);
	process.exit(1);
};

const text = readFileSync(file, 'utf8');
const from = /^FROM\s+(\S+)\s*$/m.exec(text)?.[1];
const label = /^LABEL\s+org\.morphit\.frontend-base="([^"]+)"\s*$/m.exec(text)?.[1];
if (!from) fail(`${file} has no FROM line.`);
if (label !== from)
	fail(`${file}: the LABEL (${label ?? 'none'}) does not name the FROM image (${from}).`);
const m = /^(?:docker\.io\/)?(?:library\/)?([a-z0-9._-]+):[\w.-]+@(sha256:[0-9a-f]{64})$/.exec(
	from
);
if (!m) fail(`${from} is not an official image pinned as name:tag@sha256:…`);
const [, repo, digest] = m;

const get = async (url, headers = {}) => {
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
		return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
	} catch (e) {
		fail(
			`could not reach ${new URL(url).host} (${e?.cause?.code ?? e?.message ?? e}), so the pin was not checked.`
		);
	}
};

const tok = await get(`${AUTH}?service=registry.docker.io&scope=repository:library/${repo}:pull`);
if (tok.status !== 200) fail(`Docker Hub's sign-in answered ${tok.status}.`);
let token;
try {
	token = JSON.parse(tok.body.toString('utf8')).token;
} catch {
	/* below */
}
if (typeof token !== 'string' || token === '') fail("Docker Hub's sign-in gave no token.");

const res = await get(`${REGISTRY}/v2/library/${repo}/manifests/${digest}`, {
	Authorization: `Bearer ${token}`,
	Accept: [
		...INDEX_TYPES,
		'application/vnd.oci.image.manifest.v1+json',
		'application/vnd.docker.distribution.manifest.v2+json'
	].join(', ')
});
if (res.status === 404) fail(`${from}: Docker Hub has no such digest.`);
if (res.status !== 200) fail(`${from}: Docker Hub answered ${res.status}.`);
const got = `sha256:${createHash('sha256').update(res.body).digest('hex')}`;
if (got !== digest) fail(`${from}: Docker Hub's bytes hash to ${got}, not the pinned digest.`);

let index;
try {
	index = JSON.parse(res.body.toString('utf8'));
} catch {
	fail(`${from}: Docker Hub's answer is not JSON.`);
}
if (!INDEX_TYPES.includes(index?.mediaType) || !Array.isArray(index?.manifests))
	fail(
		`${from} is a single-platform image, not a multi-platform index: pin the index, so arm64 servers build too.`
	);
const platforms = new Set(
	index.manifests
		.map((e) => e?.platform)
		.filter((p) => p && p.os !== 'unknown' && p.architecture !== 'unknown')
		.map((p) => `${p.os}/${p.architecture}`)
);
const missing = NEEDED.filter((p) => !platforms.has(p));
if (missing.length > 0)
	fail(
		`${from} lists ${platforms.size === 0 ? 'no image at all' : [...platforms].sort().join(', ')}; ` +
			`it lacks ${missing.join(' and ')}. A digest read while Docker publishes a release can be an empty or ` +
			'partial placeholder: read it again once Docker has finished publishing, and pin that.'
	);
console.log(
	`✓ Frontend base image ${from}: lists ${[...platforms].sort().join(', ')} (checked with Docker Hub).`
);
