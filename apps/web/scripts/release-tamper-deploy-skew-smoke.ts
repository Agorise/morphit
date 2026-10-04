#!/usr/bin/env tsx
/**
 * Morphit — the build-integrity check: when it runs, and what can stop it.
 *
 * Runs the real check (checkRunningBuild in apps/web/src/lib/stores/release.ts
 * → checkManifestAgainstRunningBundle) against a simulated site.
 *
 *   - A routine upgrade never raises the alarm: a tab running another version
 *     than the signed release is 'not_checked' (neutral) and fetches nothing.
 *     (TamperAlertBanner also holds the banner back while a new service worker
 *     is landing.)
 *   - Nothing the operator serves switches the check off: with /verify.json
 *     missing, or naming another version, a changed file of the announced
 *     version is still reported.
 *   - A manifest entry that is not a plain path on this site is refused with
 *     no request at all.
 *
 * Usage: tsx --tsconfig apps/web/tsconfig.smoke.json apps/web/scripts/release-tamper-deploy-skew-smoke.ts
 */
import { createHash } from 'node:crypto';

import { checkRunningBuild } from '../src/lib/stores/release.ts';

const ORIGIN = 'https://morphit.example';
const FILES: Record<string, string> = {
	'/index.html': '<!doctype html><title>Morphit</title>',
	'/service-worker.js': 'self.addEventListener("fetch",()=>{})',
	'/_app/immutable/entry/start.js': 'export const start = 1;'
};
const sri = (body: string): string =>
	`sha256-${createHash('sha256').update(body).digest('base64')}`;
const MANIFEST: Record<string, string> = Object.fromEntries(
	Object.entries(FILES).map(([p, b]) => [p, sri(b)])
);

let served: Record<string, string> = {};
let verifyJson: { status: number; version?: string } = { status: 404 };
let requested: string[] = [];

Object.defineProperty(globalThis, 'location', {
	configurable: true,
	value: {
		origin: ORIGIN,
		href: `${ORIGIN}/en`,
		protocol: 'https:',
		hostname: 'morphit.example',
		host: 'morphit.example'
	}
});
globalThis.fetch = (async (input: string | URL | Request) => {
	const url = new URL(
		typeof input === 'string' || input instanceof URL ? input : input.url,
		ORIGIN
	);
	requested.push(url.href);
	if (url.origin !== ORIGIN) return new Response('beacon', { status: 200 });
	if (url.pathname === '/verify.json') {
		return verifyJson.status === 200
			? new Response(JSON.stringify({ morphit_version: verifyJson.version }), { status: 200 })
			: new Response('not found', { status: verifyJson.status });
	}
	const body = served[url.pathname];
	return body === undefined
		? new Response('', { status: 404 })
		: new Response(body, { status: 200 });
}) as typeof fetch;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

async function scenario(
	opts: { running: string; announced: string; verify: typeof verifyJson; change?: string },
	manifest: Record<string, string> = MANIFEST
) {
	served = { ...FILES };
	if (opts.change !== undefined) served[opts.change] = 'changed bytes';
	verifyJson = opts.verify;
	requested = [];
	return checkRunningBuild({ version: opts.announced, hash_manifest: manifest }, opts.running);
}

async function main(): Promise<void> {
	{
		const r = await scenario({
			running: '1.20.3',
			announced: '1.20.4',
			verify: { status: 200, version: '1.20.4' },
			change: '/index.html'
		});
		check(
			'a tab running an older build than the signed release: not checked, no alarm, nothing fetched',
			r.kind === 'not_checked' && requested.length === 0,
			`${r.kind}, ${requested.length} request(s)`
		);
	}
	{
		const r = await scenario({
			running: '1.20.4',
			announced: '1.20.3',
			verify: { status: 200, version: '1.20.4' }
		});
		check(
			'a tab running a newer build than the signed release: not checked either',
			r.kind === 'not_checked',
			r.kind
		);
	}
	{
		const r = await scenario({
			running: '1.20.3',
			announced: '1.20.3',
			verify: { status: 404 },
			change: '/_app/immutable/entry/start.js'
		});
		check(
			'verify.json missing (404): a changed file is still reported',
			r.kind === 'mismatch' &&
				r.mismatches.map((m) => m.path).join() === '/_app/immutable/entry/start.js',
			r.kind
		);
	}
	{
		const r = await scenario({
			running: '1.20.3',
			announced: '1.20.3',
			verify: { status: 200, version: '9.9.9' },
			change: '/service-worker.js'
		});
		check(
			'verify.json naming another version: a changed file is still reported',
			r.kind === 'mismatch',
			r.kind
		);
	}
	{
		const r = await scenario({ running: '1.20.3', announced: '1.20.3', verify: { status: 404 } });
		check('the untouched announced build checks out', r.kind === 'ok', r.kind);
		check(
			'the check never reads /verify.json',
			!requested.some((u) => u.endsWith('/verify.json')),
			requested.join(', ')
		);
	}
	{
		const r = await scenario(
			{ running: '1.20.3', announced: '1.20.3', verify: { status: 404 } },
			{ ...MANIFEST, '//evil.example/beacon': sri('x') }
		);
		check(
			'a manifest entry naming another host: refused, no request made',
			r.kind === 'refused' && requested.length === 0,
			`${r.kind}, ${requested.join(', ')}`
		);
	}

	console.log('');
	if (failed === 0) {
		console.log(`✓ all ${passed} build-integrity check scenarios passed`);
		process.exit(0);
	}
	console.error(`✗ ${failed} build-integrity check scenario(s) failed`);
	process.exit(1);
}

void main();
