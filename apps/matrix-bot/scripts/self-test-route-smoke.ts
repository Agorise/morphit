#!/usr/bin/env tsx
/**
 * self-test-route-smoke — the matrix-bot healthcheck server's POST /self-test
 * route (what `morphit-ops matrix test` triggers) must DM the configured
 * recipients via the bot's own sender, report per-recipient results, leave
 * the GET liveness probe intact, and only ever target the CONFIGURED
 * recipients (no caller-supplied destination → not a spam vector).
 *
 * Why this exists: the self-test is the one-command operator verification
 * that alerting actually delivers. It deliberately reuses the bot's own
 * client — a Matrix access token is bound to a device whose E2E identity
 * keys are immutable, so a second client with the same token would clobber
 * the running bot's identity — which is exactly why the trigger lives on the
 * bot's loopback healthcheck server rather than in ops-cli. This smoke locks
 * down the route contract and that safety property.
 */

import { createHealthServer, runSelfTest } from '../src/health.ts';
import { renderTestAlertBody } from '../src/classifier.ts';
import { parseMxid, type MatrixMxid } from '@morphit/operator-config';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';

let failures = 0;
let n = 0;
function check(name: string, cond: boolean, detail = ''): void {
	n++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		failures++;
		console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
	}
}

function mxid(s: string): MatrixMxid {
	const m = parseMxid(s);
	if (m === null) throw new Error(`test setup: ${s} is not a valid MXID`);
	return m;
}

interface Call {
	to: string;
	plain: string;
	html: string;
}
function makeSender(throwFor: ReadonlySet<string> = new Set()): {
	calls: Call[];
	sender: { sendDm: (to: MatrixMxid, body: { plain: string; html: string }) => Promise<void> };
} {
	const calls: Call[] = [];
	return {
		calls,
		sender: {
			async sendDm(to: MatrixMxid, body: { plain: string; html: string }): Promise<void> {
				calls.push({ to: String(to), plain: body.plain, html: body.html });
				if (throwFor.has(String(to))) {
					throw new Error(`simulated delivery failure for ${String(to)}`);
				}
			}
		}
	};
}

async function req(
	port: number,
	path: string,
	method: string
): Promise<{ status: number; json: Record<string, unknown> | null }> {
	const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
	let json: Record<string, unknown> | null = null;
	try {
		json = (await res.json()) as Record<string, unknown>;
	} catch {
		json = null;
	}
	return { status: res.status, json };
}

/** POST with a custom Host header (fetch forbids setting Host), to simulate a
 *  DNS-rebound / cross-origin request hitting the loopback endpoint. */
function reqWithHost(
	port: number,
	path: string,
	host: string
): Promise<{ status: number; json: Record<string, unknown> | null }> {
	return new Promise((resolve, reject) => {
		const r = httpRequest(
			{ host: '127.0.0.1', port, path, method: 'POST', headers: { Host: host } },
			(res) => {
				let body = '';
				res.on('data', (c) => (body += String(c)));
				res.on('end', () => {
					let json: Record<string, unknown> | null = null;
					try {
						json = JSON.parse(body) as Record<string, unknown>;
					} catch {
						json = null;
					}
					resolve({ status: res.statusCode ?? 0, json });
				});
			}
		);
		r.on('error', reject);
		r.end();
	});
}

interface ServerOpts {
	alertMxids: ReadonlyArray<MatrixMxid>;
	dryRun: boolean;
	sender: { sendDm: (to: MatrixMxid, body: { plain: string; html: string }) => Promise<void> };
	renderTestBody: () => { plain: string; html: string };
}
async function withServer(opts: ServerOpts, fn: (port: number) => Promise<void>): Promise<void> {
	const server = createHealthServer(opts);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const port = (server.address() as AddressInfo).port;
	try {
		await fn(port);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

async function main(): Promise<void> {
	console.log('self-test-route-smoke');

	// ─── renderTestAlertBody ────────────────────────────────────────────
	const body = renderTestAlertBody();
	check('test body: non-empty plain + html', body.plain.length > 0 && body.html.length > 0);
	check(
		'test body: clearly labelled a self-test',
		/self-test/i.test(body.plain) && /self-test/i.test(body.html)
	);
	check(
		'test body: names the command that triggered it',
		body.plain.includes('morphit-ops matrix test')
	);
	check('test body: states it is NOT a real alert', /not a real alert/i.test(body.plain));

	const A = mxid('@alice:matrix.org');
	const B = mxid('@bob:matrix.org');

	// ─── happy path: both delivered ─────────────────────────────────────
	{
		const { calls, sender } = makeSender();
		await withServer(
			{ alertMxids: [A, B], dryRun: false, sender, renderTestBody: renderTestAlertBody },
			async (port) => {
				const { status, json } = await req(port, '/self-test', 'POST');
				check('happy: HTTP 200', status === 200, `status=${status}`);
				check('happy: ok=true', json?.ok === true);
				check('happy: dryRun=false', json?.dryRun === false);
				check('happy: recipients=2', json?.recipients === 2);
				check(
					'happy: sent both recipients',
					Array.isArray(json?.sent) && (json?.sent as unknown[]).length === 2
				);
				check(
					'happy: failed empty',
					Array.isArray(json?.failed) && (json?.failed as unknown[]).length === 0
				);
				check('happy: sender called once per recipient', calls.length === 2);
				check(
					'happy: sender delivered the test body',
					calls.every((c) => c.plain === body.plain && c.html === body.html)
				);
				const live = await req(port, '/', 'GET');
				check('liveness: GET still 200', live.status === 200);
				check('liveness: ok=true', live.json?.ok === true);
			}
		);
	}

	// ─── failure path: B throws ─────────────────────────────────────────
	{
		const { calls, sender } = makeSender(new Set([String(B)]));
		await withServer(
			{ alertMxids: [A, B], dryRun: false, sender, renderTestBody: renderTestAlertBody },
			async (port) => {
				const { status, json } = await req(port, '/self-test', 'POST');
				check('fail: HTTP 502', status === 502, `status=${status}`);
				check('fail: ok=false', json?.ok === false);
				check(
					'fail: sent has A only',
					Array.isArray(json?.sent) &&
						(json?.sent as string[]).length === 1 &&
						(json?.sent as string[])[0] === String(A)
				);
				const failed = json?.failed as Array<{ mxid: string; error: string }> | undefined;
				check(
					'fail: failed lists B with an error',
					Array.isArray(failed) &&
						failed.length === 1 &&
						failed[0]?.mxid === String(B) &&
						typeof failed[0]?.error === 'string'
				);
				check('fail: bot still attempted both', calls.length === 2);
			}
		);
	}

	// ─── dry-run flag passthrough ───────────────────────────────────────
	{
		const { sender } = makeSender();
		await withServer(
			{ alertMxids: [A], dryRun: true, sender, renderTestBody: renderTestAlertBody },
			async (port) => {
				const { json } = await req(port, '/self-test', 'POST');
				check('dryRun: flag surfaced in response', json?.dryRun === true);
			}
		);
	}

	// ─── runSelfTest directly: only configured recipients are ever targeted ─
	{
		const { calls, sender } = makeSender();
		const r = await runSelfTest({
			alertMxids: [A, B],
			dryRun: false,
			sender,
			renderTestBody: renderTestAlertBody
		});
		check('runSelfTest: ok + sent both', r.ok && r.sent.length === 2);
		check(
			'runSelfTest: only the configured recipients were messaged',
			calls.every((c) => c.to === String(A) || c.to === String(B))
		);
	}

	// ─── DNS-rebind / CSRF guard: non-loopback Host refused, no send ─────
	{
		const { calls, sender } = makeSender();
		await withServer(
			{ alertMxids: [A], dryRun: false, sender, renderTestBody: renderTestAlertBody },
			async (port) => {
				const evil = await reqWithHost(port, '/self-test', 'evil.example.com');
				check('rebind-guard: non-loopback Host → 403', evil.status === 403, `status=${evil.status}`);
				check('rebind-guard: ok=false', evil.json?.ok === false);
				check('rebind-guard: NO DM sent on rebound request', calls.length === 0);
				const good = await reqWithHost(port, '/self-test', `127.0.0.1:${port}`);
				check('rebind-guard: loopback Host still → 200', good.status === 200, `status=${good.status}`);
				check('rebind-guard: loopback request did send', calls.length === 1);
			}
		);
	}

	if (failures > 0) {
		console.error(`\nself-test-route-smoke: ${failures} failure(s) across ${n} checks`);
		process.exit(1);
	}
	console.log(`\n\u2713 all ${n} self-test-route-smoke checks passed`);
}

main().catch((e: unknown) => {
	console.error('self-test-route-smoke crashed:', e);
	process.exit(1);
});
