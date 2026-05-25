#!/usr/bin/env tsx
/**
 * Morphit relay — log sanitize smoke (cp139-F-1).
 *
 * Asserts that textSink + formatValue strip terminal-control
 * escapes before writing to stdout/stderr.  jsonSink is also
 * exercised; JSON.stringify natively escapes control bytes so
 * the JSON path should pass through these tests trivially —
 * including jsonSink is defense-in-depth in case a future
 * refactor changes how either sink emits.
 *
 * Threat model: operator-configurable context values (RPC
 * endpoint URLs, persistPath, recipient account names) or
 * chain-RPC error messages could contain ANSI/CSI escapes;
 * without sanitize the textSink bare-string emission path
 * would let them reach the operator's journal/console
 * verbatim.
 *
 * Wired into scripts/run-smokes.sh.
 */

import { textSink, jsonSink, type LogRecord } from '../src/log/index.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(`${label}: actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`);
	}
}

function assertNotMatch(haystack: string, needle: string | RegExp, label: string): void {
	const found = typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);
	if (found) {
		throw new Error(`${label}: unexpectedly found ${JSON.stringify(needle.toString())} in:\n${haystack}`);
	}
}

function assertMatch(haystack: string, needle: string | RegExp, label: string): void {
	const found = typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);
	if (!found) {
		throw new Error(`${label}: expected to find ${JSON.stringify(needle.toString())} in:\n${haystack}`);
	}
}

/** Capture process.stdout/stderr writes during a closure. */
function captureWrites(fn: () => void): { stdout: string; stderr: string } {
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	let stdout = '';
	let stderr = '';
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(process.stdout.write as any) = (chunk: unknown): boolean => {
		stdout += String(chunk);
		return true;
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(process.stderr.write as any) = (chunk: unknown): boolean => {
		stderr += String(chunk);
		return true;
	};
	try {
		fn();
	} finally {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(process.stdout.write as any) = origOut;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(process.stderr.write as any) = origErr;
	}
	return { stdout, stderr };
}

function mkRecord(overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		ts: '2026-05-25T00:00:00.000Z',
		level: 'info',
		module: 'test',
		event: 'evt',
		context: {},
		...overrides
	};
}

console.log('\n── indexer log sanitize smoke (cp139-F-1) ─────────────────\n');

// ─── textSink: bare-string emission strips control bytes ──────

scenario('cp139-F-1: textSink strips ANSI ESC from string-without-space context value', () => {
	const r = mkRecord({
		level: 'info',
		module: 'access',
		event: 'request',
		context: { path: '/api/foo\x1b[2J' }  // <-- ANSI clear-screen embedded
	});
	const { stdout } = captureWrites(() => textSink(r));
	// The ESC byte must NOT appear raw in the output stream.
	assertNotMatch(stdout, '\x1b[2J', 'raw ANSI ESC[2J must not reach stdout');
	assertNotMatch(stdout, '\x1b', 'raw ESC byte must not reach stdout');
	// The visible filename portion should survive (sanitize keeps printables).
	assertMatch(stdout, 'path=/api/foo[2J', 'sanitized value still readable');
});

scenario('cp139-F-1: textSink strips C0 controls (NUL/BEL/BS) from bare value', () => {
	const r = mkRecord({
		level: 'info',
		context: { token: 'abc\x00def\x07ghi\x08jkl' }
	});
	const { stdout } = captureWrites(() => textSink(r));
	for (const code of [0x00, 0x07, 0x08]) {
		assertNotMatch(stdout, String.fromCharCode(code), `C0 0x${code.toString(16)} must not reach stdout`);
	}
	assertMatch(stdout, 'token=abcdefghijkl', 'visible portions survive');
});

scenario('cp139-F-1: textSink strips DEL (0x7F) from bare value', () => {
	const r = mkRecord({ context: { account: 'alice\x7fbob' } });
	const { stdout } = captureWrites(() => textSink(r));
	assertNotMatch(stdout, '\x7f', 'DEL must not reach stdout');
	assertMatch(stdout, 'account=alicebob', 'survives');
});

scenario('cp139-F-1: textSink strips C1 (0x80-0x9F) from bare value', () => {
	// C1 8-bit ESC introducer (0x9b = CSI) is a hostile byte
	// that some terminals interpret as ESC [.  Strip.
	const r = mkRecord({ context: { rpc: 'wss://node\x9b2Jevil' } });
	const { stdout } = captureWrites(() => textSink(r));
	assertNotMatch(stdout, '\x9b', 'C1 CSI 0x9b must not reach stdout');
	assertMatch(stdout, 'rpc=wss://node2Jevil', 'survives');
});

scenario('cp139-F-1: textSink with string-with-space goes JSON path (still no control bytes)', () => {
	// formatValue JSON.stringify path also gets sanitize (defense
	// in depth).  Even though JSON.stringify would already escape
	// \x1b → \u001b, we sanitize before JSON.stringify too.
	const r = mkRecord({ context: { note: 'with spaces \x1b[31mred\x1b[0m and stuff' } });
	const { stdout } = captureWrites(() => textSink(r));
	assertNotMatch(stdout, '\x1b', 'no raw ESC in JSON path');
});

scenario('cp139-F-1: textSink preserves printable ASCII intact', () => {
	const r = mkRecord({
		event: 'request',
		context: {
			method: 'POST',
			path: '/api/account/create',
			status: 200,
			dur_ms: 42
		}
	});
	const { stdout } = captureWrites(() => textSink(r));
	assertMatch(stdout, '[test] request method=POST path=/api/account/create status=200 dur_ms=42', 'expected line');
});

scenario('cp139-F-1: textSink preserves SGR escape (legitimate color)', () => {
	// SGR escapes (ESC [ N;N;...m) are allowed through because
	// they're used by fmt.X color helpers — would-be useful for
	// future colored log output.
	const r = mkRecord({ context: { tag: '\x1b[31m' } });
	const { stdout } = captureWrites(() => textSink(r));
	assertMatch(stdout, 'tag=\x1b[31m', 'SGR survives');
});

scenario('cp139-F-1: textSink drops non-SGR ESC sequence', () => {
	// ESC [ 2J is non-SGR (J = clear screen), must be dropped.
	const r = mkRecord({ context: { tag: '\x1b[2J' } });
	const { stdout } = captureWrites(() => textSink(r));
	assertNotMatch(stdout, '\x1b[2J', 'ESC [ 2J dropped');
});

scenario('cp139-F-1: textSink sanitizes module name', () => {
	const r = mkRecord({ module: 'mod\x1b[2J' });
	const { stdout } = captureWrites(() => textSink(r));
	assertNotMatch(stdout, '\x1b[2J', 'module sanitized');
	assertMatch(stdout, '[mod[2J]', 'module visible portion present');
});

scenario('cp139-F-1: textSink sanitizes event name', () => {
	const r = mkRecord({ event: 'evt\x1bX' });
	const { stdout } = captureWrites(() => textSink(r));
	assertNotMatch(stdout, '\x1b', 'event ESC stripped');
	assertMatch(stdout, 'evtX', 'event visible portion present');
});

scenario('cp139-F-1: textSink sanitizes context key name', () => {
	const r = mkRecord({ context: { 'a\x1bb': 'val' } });
	const { stdout } = captureWrites(() => textSink(r));
	assertNotMatch(stdout, '\x1b', 'context key ESC stripped');
});

scenario('cp139-F-1: textSink sanitizes error stack trace', () => {
	const r = mkRecord({
		level: 'error',
		error: {
			name: 'TestErr',
			message: 'boom',
			stack: 'TestErr: boom\n    at \x1b[2Jevil:1:1'
		}
	});
	const { stderr } = captureWrites(() => textSink(r));
	assertNotMatch(stderr, '\x1b[2J', 'stack trace ESC stripped');
});

// ─── jsonSink: JSON.stringify already escapes control bytes ──

scenario('jsonSink already escapes control bytes via JSON.stringify', () => {
	const r = mkRecord({ context: { evil: 'foo\x1b[2Jbar' } });
	const { stdout } = captureWrites(() => jsonSink(r));
	assertNotMatch(stdout, '\x1b', 'no raw ESC in JSON');
	assertMatch(stdout, '\\u001b', 'JSON-escaped ESC present');
});

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} log-sanitize scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
