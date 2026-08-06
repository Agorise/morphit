/**
 * mcp-server private-instance policy smoke (cp154 F-mcp-1).
 *
 * Verifies the env-var-gated private-address denylist in
 * `getInstanceUrl()`.  Three policies tested:
 *
 *   1. PUBLIC hostname (morphit.io) is always allowed.
 *   2. PRIVATE hostname (127.0.0.1, localhost, etc.) is REJECTED
 *      by default — env var absent or set to anything not "1".
 *   3. PRIVATE hostname is ALLOWED when
 *      MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE=1 is set explicitly.
 *
 * The smoke imports `getInstanceUrl` directly from src (no
 * dist/main.js spawn) so it can manipulate `process.env` per
 * scenario.
 *
 * cp154 net-defense package supplies the underlying
 * `isPrivateHostname` predicate; this smoke verifies the
 * mcp-server's POLICY around it (where to draw the line, where
 * to provide an escape hatch).
 */

import { getInstanceUrl } from '../src/indexerClient.js';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

const originalUrl = process.env.MORPHIT_MCP_INSTANCE_URL;
const originalAllowPrivate = process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE;

try {
	/* ============= Scenario 1: public hostname always allowed ============= */

	{
		delete process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE;
		process.env.MORPHIT_MCP_INSTANCE_URL = 'https://morphit.io';
		try {
			const url = getInstanceUrl();
			if (url === 'https://morphit.io') {
				pass('public hostname (morphit.io) allowed with no opt-in');
			} else {
				fail(
					'public hostname (morphit.io) allowed with no opt-in',
					'unexpected URL: ' + url
				);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			fail('public hostname (morphit.io) allowed with no opt-in', 'threw: ' + msg);
		}
	}

	/* ============= Scenario 2: private hostname rejected by default ============= */

	const privateUrls = [
		'http://127.0.0.1:3000',
		'http://localhost:3000',
		'https://10.0.0.5',
		'https://192.168.1.1',
		'http://169.254.169.254',
		'https://my-instance.local'
	];

	for (const target of privateUrls) {
		delete process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE;
		process.env.MORPHIT_MCP_INSTANCE_URL = target;
		try {
			const url = getInstanceUrl();
			fail(
				'private hostname rejected by default: ' + target,
				'unexpectedly returned: ' + url
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('private-address hostname') && msg.includes('MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE')) {
				pass('private hostname rejected by default: ' + target);
			} else {
				fail(
					'private hostname rejected by default: ' + target,
					'wrong error message: ' + msg
				);
			}
		}
	}

	/* ============= Scenario 3: opt-in env var allows private hostname ============= */

	for (const target of privateUrls) {
		process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE = '1';
		process.env.MORPHIT_MCP_INSTANCE_URL = target;
		try {
			const url = getInstanceUrl();
			if (url === target.replace(/\/+$/, '')) {
				pass('opt-in allows private hostname: ' + target);
			} else {
				fail(
					'opt-in allows private hostname: ' + target,
					'unexpected URL: ' + url
				);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			fail('opt-in allows private hostname: ' + target, 'threw: ' + msg);
		}
	}

	/* ============= Scenario 4: opt-in env var must equal "1" exactly ============= */

	// Sanity guard: MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE=true (not "1")
	// should NOT activate the opt-in.  Loose truthy parsing would let
	// stray config like `=yes` or `=on` accidentally enable it.
	const looseValues = ['true', 'yes', 'on', 'TRUE', '0', '', '  '];
	for (const value of looseValues) {
		process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE = value;
		process.env.MORPHIT_MCP_INSTANCE_URL = 'http://localhost:3000';
		try {
			const url = getInstanceUrl();
			fail(
				'loose opt-in value (' + JSON.stringify(value) + ') does NOT activate opt-in',
				'unexpectedly allowed: ' + url
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('private-address hostname')) {
				pass('loose opt-in value (' + JSON.stringify(value) + ') does NOT activate opt-in');
			} else {
				fail(
					'loose opt-in value (' + JSON.stringify(value) + ') does NOT activate opt-in',
					'wrong error: ' + msg
				);
			}
		}
	}

	/* ============= Scenario 5: malformed URL rejected before private-address check ============= */

	{
		delete process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE;
		process.env.MORPHIT_MCP_INSTANCE_URL = 'not a url';
		try {
			getInstanceUrl();
			fail('malformed URL rejected', 'should have thrown');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('not a valid URL')) {
				pass('malformed URL rejected with clear diagnostic');
			} else {
				fail('malformed URL rejected', 'wrong error: ' + msg);
			}
		}
	}

	/* ============= Scenario 6: unsupported scheme rejected ============= */

	{
		delete process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE;
		process.env.MORPHIT_MCP_INSTANCE_URL = 'ftp://morphit.io';
		try {
			getInstanceUrl();
			fail('unsupported scheme rejected', 'should have thrown');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('unsupported scheme')) {
				pass('unsupported scheme rejected with clear diagnostic');
			} else {
				fail('unsupported scheme rejected', 'wrong error: ' + msg);
			}
		}
	}
} finally {
	if (originalUrl === undefined) delete process.env.MORPHIT_MCP_INSTANCE_URL;
	else process.env.MORPHIT_MCP_INSTANCE_URL = originalUrl;
	if (originalAllowPrivate === undefined) delete process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE;
	else process.env.MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE = originalAllowPrivate;
}

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
	} else {
		console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
		if (r.detail) console.log('      ' + r.detail);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
	process.exit(1);
} else {
	console.log('✓ all ' + results.length + ' scenarios passed');
}
