/**
 * matrix-bot healthcheck HTTP server (loopback-only).
 *
 * Serves two things on 127.0.0.1:<healthcheckPort>:
 *   - GET (anything)  → liveness probe ({ ok, tailer_alive, ts }): 200 while
 *                       the journal tailer is running, 503 while it is not —
 *                       a bot that cannot read the journal cannot alert.
 *   - POST /self-test → ask the bot to DM a clearly-labelled TEST alert to
 *                       each CONFIGURED alert MXID, using the bot's OWN
 *                       client / token / crypto.  This is what
 *                       `morphit-ops matrix test` triggers.
 *
 * Why the self-test lives HERE rather than in ops-cli: a Matrix access token
 * is bound to a DEVICE, and a device's identity keys are immutable once
 * uploaded.  Spinning up a SECOND Matrix client with the same token from
 * ops-cli would generate + try to upload conflicting device keys — rejected
 * by the homeserver, and in the bad case poisoning the *running* bot's E2E
 * identity.  Triggering the bot's own client over loopback sidesteps that
 * entirely: the test DM travels exactly like a genuine alert (end-to-end
 * encrypted only when MORPHIT_MATRIX_ENCRYPT=1, see matrix.ts).  The route can ONLY reach the recipients already in the bot's config
 * (there is no caller-supplied target), so the loopback endpoint can't be
 * turned into a spam vector even if something local POSTs to it.
 */

import { createServer, type Server } from 'node:http';
import type { MatrixMxid } from '@morphit/operator-config';
import type { MatrixSender } from './matrix.ts';

export interface HealthServerOptions {
	readonly alertMxids: ReadonlyArray<MatrixMxid>;
	readonly dryRun: boolean;
	/** Only sendDm is needed — keeps the mock surface in tests tiny. */
	readonly sender: Pick<MatrixSender, 'sendDm'>;
	readonly renderTestBody: () => { plain: string; html: string };
	/** Whether the journal tailer is running (see journalctl.ts). Omitted =
	 *  not tracked (always reported alive). */
	readonly tailerAlive?: () => boolean;
}

export interface SelfTestResult {
	readonly ok: boolean;
	readonly dryRun: boolean;
	readonly recipients: number;
	readonly sent: string[];
	readonly failed: Array<{ mxid: string; error: string }>;
}

/** Run the self-test: DM the test body to every configured recipient,
 *  collecting per-recipient success/failure.  Never throws — a failed
 *  delivery is captured in `failed`, not propagated. */
export async function runSelfTest(opts: HealthServerOptions): Promise<SelfTestResult> {
	const sent: string[] = [];
	const failed: Array<{ mxid: string; error: string }> = [];
	const body = opts.renderTestBody();
	for (const mxid of opts.alertMxids) {
		try {
			await opts.sender.sendDm(mxid, body);
			sent.push(mxid);
		} catch (err) {
			failed.push({
				mxid,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}
	return {
		ok: failed.length === 0,
		dryRun: opts.dryRun,
		recipients: opts.alertMxids.length,
		sent,
		failed
	};
}

/** True when the HTTP Host header refers to loopback (127.0.0.1 / localhost
 *  / [::1], with or without a :port).  The self-test endpoint is localhost-
 *  only, so a request whose Host isn't loopback is a DNS-rebound or
 *  cross-origin POST (e.g. a malicious page the operator visited) and is
 *  refused — the legitimate caller (ops-cli) always connects to
 *  127.0.0.1:<port>. */
function isLoopbackHost(host: string | undefined): boolean {
	if (host === undefined || host === '') return false;
	const h = host.replace(/:\d+$/, '').toLowerCase();
	return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
}

/** Build (but do NOT listen on) the loopback healthcheck server. */
export function createHealthServer(opts: HealthServerOptions): Server {
	return createServer((req, res) => {
		const url = req.url ?? '';
		if (req.method === 'POST' && (url === '/self-test' || url.startsWith('/self-test?'))) {
			// DNS-rebinding / CSRF guard: this control endpoint is loopback-only.
			// The server binds 127.0.0.1, but a browser tricked via DNS rebinding
			// could still POST here carrying the attacker's hostname in Host; the
			// legitimate caller (ops-cli) always sends 127.0.0.1.  Refuse anything
			// whose Host isn't loopback so the endpoint can't be turned into an
			// unrequested-test-DM nuisance.
			if (!isLoopbackHost(req.headers.host)) {
				res.writeHead(403, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: 'self-test is loopback-only' }));
				return;
			}
			void runSelfTest(opts)
				.then((result) => {
					res.writeHead(result.ok ? 200 : 502, {
						'Content-Type': 'application/json'
					});
					res.end(JSON.stringify(result));
				})
				.catch((err: unknown) => {
					// runSelfTest never rejects, but be defensive.
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(
						JSON.stringify({
							ok: false,
							error: err instanceof Error ? err.message : String(err)
						})
					);
				});
			return;
		}

		// Default: liveness probe. Down while the tailer is down — a bot that
		// cannot read the journal cannot alert, whatever else is fine.
		const tailerAlive = opts.tailerAlive?.() ?? true;
		res.writeHead(tailerAlive ? 200 : 503, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({ ok: tailerAlive, tailer_alive: tailerAlive, ts: new Date().toISOString() })
		);
	});
}
