/**
 * Smoke — scripts/check-frontend-base.mjs.
 *
 * ci.yml runs it on every push: the frontend's pinned nginx base must be a
 * multi-platform index that lists linux/amd64 and linux/arm64 (v1.24.6 pinned
 * an empty placeholder Docker showed mid-publish, and every server's rebuild
 * failed). Here a local stand-in registry answers the sign-in and the
 * manifest request; each scenario pins a Dockerfile to one of its answers and
 * runs the real CLI.
 *
 * Registered: `.:check-frontend-base-smoke`.
 * MORPHIT_CHECK_FRONTEND_BASE=<other copy> runs the scenarios against it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
	process.env.MORPHIT_CHECK_FRONTEND_BASE ?? join(HERE, 'check-frontend-base.mjs')
);
const SHIPPED = join(HERE, '..', 'ops', 'bunkerweb', 'frontend', 'Dockerfile');

let failures = 0;
let scenarios = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
	scenarios++;
	try {
		await fn();
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

// ─── What the stand-in registry serves ───────────────────────────────────
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const sha = (b: string): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const entry = (os: string, architecture: string, variant?: string): object => ({
	mediaType: 'application/vnd.oci.image.manifest.v1+json',
	digest: sha(`${os}/${architecture}/${variant ?? ''}`),
	size: 1000,
	platform: { os, architecture, ...(variant ? { variant } : {}) }
});
const attestation = (): object => ({
	mediaType: 'application/vnd.oci.image.manifest.v1+json',
	digest: sha(`att-${Math.random()}`),
	size: 800,
	platform: { os: 'unknown', architecture: 'unknown' }
});
const index = (manifests: object[]): string =>
	JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests });

const BODIES = {
	complete: index([
		entry('linux', 'amd64'),
		attestation(),
		entry('linux', 'arm64', 'v8'),
		attestation(),
		entry('linux', 'arm', 'v7')
	]),
	// What v1.24.6 pinned: an index Docker had created, with nothing in it yet.
	empty: index([]),
	amd64Only: index([entry('linux', 'amd64'), attestation()]),
	attestationsOnly: index([attestation(), attestation()]),
	single: JSON.stringify({
		schemaVersion: 2,
		mediaType: 'application/vnd.oci.image.manifest.v1+json',
		config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: sha('c'), size: 1 },
		layers: []
	})
};
type Name = keyof typeof BODIES;
const DIGEST: Record<Name, string> = Object.fromEntries(
	Object.entries(BODIES).map(([k, v]) => [k, sha(v)])
) as Record<Name, string>;
// Served for this digest: other bytes (a registry, or a man in the middle,
// answering with something else).
const TAMPERED = sha('tampered');
// Answered with a server error.
const BROKEN = sha('broken');

let authMode: 'ok' | 'refused' | 'no-token' = 'ok';
const seen: { auth?: string; accept?: string }[] = [];

const server: Server = createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://x');
	if (url.pathname === '/token') {
		if (authMode === 'refused') {
			res.writeHead(401).end('{}');
			return;
		}
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(authMode === 'ok' ? { token: 'smoke-token' } : {}));
		return;
	}
	const m = /^\/v2\/library\/nginx\/manifests\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
	seen.push({ auth: req.headers.authorization, accept: req.headers.accept });
	if (!m || req.headers.authorization !== 'Bearer smoke-token') {
		res.writeHead(m ? 401 : 404).end();
		return;
	}
	if (m[1] === BROKEN) {
		res.writeHead(500).end();
		return;
	}
	if (m[1] === TAMPERED) {
		res.writeHead(200, { 'content-type': OCI_INDEX }).end(BODIES.complete);
		return;
	}
	const name = (Object.keys(DIGEST) as Name[]).find((k) => DIGEST[k] === m[1]);
	if (!name) {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, { 'content-type': OCI_INDEX }).end(BODIES[name]);
});
let BASE = '';

const TMP = mkdtempSync(join(tmpdir(), 'morphit-check-frontend-base-'));
let n = 0;
const dockerfile = (from: string, label: string = from): string => {
	const p = join(TMP, `Dockerfile.${++n}`);
	writeFileSync(
		p,
		`# a comment\nFROM ${from}\nLABEL org.morphit.frontend-base="${label}"\n\nRUN rm -f /etc/nginx/conf.d/default.conf\n`
	);
	return p;
};
const pin = (digest: string): string => `nginx:1.30.7-alpine@${digest}`;

function run(
	file: string,
	env: Record<string, string> = {}
): Promise<{ code: number | null; out: string }> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [SCRIPT, file], {
			env: {
				...process.env,
				MORPHIT_REGISTRY_URL: BASE,
				MORPHIT_REGISTRY_AUTH_URL: `${BASE}/token`,
				NO_PROXY: '127.0.0.1',
				...env
			}
		});
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		child.on('close', (code) => done({ code, out }));
	});
}

async function main(): Promise<void> {
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	console.log('check-frontend-base smoke');

	await check('a complete multi-platform index passes, naming its platforms', async () => {
		const r = await run(dockerfile(pin(DIGEST.complete)));
		assert(r.code === 0, `exit ${r.code}: ${r.out}`);
		assert(/✓ .*linux\/amd64, linux\/arm, linux\/arm64/.test(r.out), r.out);
	});

	await check('it signs in and asks for an index, with the token', async () => {
		seen.length = 0;
		await run(dockerfile(pin(DIGEST.complete)));
		assert(seen.length === 1, `${seen.length} manifest requests`);
		assert(seen[0]!.auth === 'Bearer smoke-token', `auth: ${seen[0]!.auth}`);
		assert((seen[0]!.accept ?? '').includes(OCI_INDEX), `accept: ${seen[0]!.accept}`);
	});

	await check(
		"v1.24.6's case: an empty placeholder index fails, saying it lists nothing",
		async () => {
			const r = await run(dockerfile(pin(DIGEST.empty)));
			assert(r.code === 1, `exit ${r.code}: ${r.out}`);
			assert(/lists no image at all; it lacks linux\/amd64 and linux\/arm64/.test(r.out), r.out);
		}
	);

	await check('an index with attestations only fails', async () => {
		const r = await run(dockerfile(pin(DIGEST.attestationsOnly)));
		assert(r.code === 1 && /lists no image at all/.test(r.out), `exit ${r.code}: ${r.out}`);
	});

	await check('a partial index without arm64 fails, naming what is missing', async () => {
		const r = await run(dockerfile(pin(DIGEST.amd64Only)));
		assert(r.code === 1, `exit ${r.code}: ${r.out}`);
		assert(/lists linux\/amd64; it lacks linux\/arm64\./.test(r.out), r.out);
	});

	await check('a single-platform image pinned instead of the index fails', async () => {
		const r = await run(dockerfile(pin(DIGEST.single)));
		assert(r.code === 1 && /single-platform image/.test(r.out), `exit ${r.code}: ${r.out}`);
	});

	await check('bytes that do not hash to the pinned digest fail', async () => {
		const r = await run(dockerfile(pin(TAMPERED)));
		assert(r.code === 1 && /bytes hash to sha256:/.test(r.out), `exit ${r.code}: ${r.out}`);
	});

	await check('a digest the registry does not have fails', async () => {
		const r = await run(dockerfile(pin(sha('nowhere'))));
		assert(r.code === 1 && /has no such digest/.test(r.out), `exit ${r.code}: ${r.out}`);
	});

	await check('a registry error fails, naming its status', async () => {
		const r = await run(dockerfile(pin(BROKEN)));
		assert(r.code === 1 && /Docker Hub answered 500/.test(r.out), `exit ${r.code}: ${r.out}`);
	});

	await check('a LABEL that names another image fails, before asking anyone', async () => {
		seen.length = 0;
		const r = await run(dockerfile(pin(DIGEST.complete), pin(DIGEST.empty)));
		assert(r.code === 1 && /does not name the FROM image/.test(r.out), `exit ${r.code}: ${r.out}`);
		assert(seen.length === 0, 'the registry was asked');
	});

	await check('a base pinned by tag only fails', async () => {
		const r = await run(dockerfile('nginx:1.30.7-alpine'));
		assert(r.code === 1 && /not an official image pinned/.test(r.out), `exit ${r.code}: ${r.out}`);
	});

	await check('a refused sign-in fails', async () => {
		authMode = 'refused';
		try {
			const r = await run(dockerfile(pin(DIGEST.complete)));
			assert(r.code === 1 && /sign-in answered 401/.test(r.out), `exit ${r.code}: ${r.out}`);
		} finally {
			authMode = 'ok';
		}
	});

	await check('a sign-in with no token fails', async () => {
		authMode = 'no-token';
		try {
			const r = await run(dockerfile(pin(DIGEST.complete)));
			assert(r.code === 1 && /gave no token/.test(r.out), `exit ${r.code}: ${r.out}`);
		} finally {
			authMode = 'ok';
		}
	});

	await check('an unreachable registry fails: no answer is not a pass', async () => {
		const r = await run(dockerfile(pin(DIGEST.complete)), {
			MORPHIT_REGISTRY_URL: 'http://127.0.0.1:1',
			MORPHIT_REGISTRY_AUTH_URL: 'http://127.0.0.1:1/token'
		});
		assert(
			r.code === 1 && /could not reach 127\.0\.0\.1:1/.test(r.out),
			`exit ${r.code}: ${r.out}`
		);
	});

	await check(
		'the shipped Dockerfile: FROM and LABEL agree and its pin is read and asked for',
		async () => {
			seen.length = 0;
			const r = await run(SHIPPED);
			// The stand-in registry does not hold the real image: it answers 404, which
			// proves the shipped file parsed and its digest was the one asked for.
			assert(
				r.code === 1 &&
					/nginx:1\.30\.7-alpine@sha256:[0-9a-f]{64}: Docker Hub has no such digest/.test(r.out),
				r.out
			);
			assert(seen.length === 1, `${seen.length} manifest requests`);
		}
	);

	server.close();
	rmSync(TMP, { recursive: true, force: true });
	console.log(
		failures === 0
			? `\n✓ all ${scenarios} check-frontend-base scenarios passed`
			: `\n✗ ${failures} of ${scenarios} check-frontend-base scenarios FAILED`
	);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
