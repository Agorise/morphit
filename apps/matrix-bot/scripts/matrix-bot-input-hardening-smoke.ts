#!/usr/bin/env tsx
/**
 * matrix-bot-input-hardening-smoke — regression for cp139
 * matrix-bot deep-walk findings.
 *
 *   ME-1 (LOW)    parseJournalLine() must not throw on malformed
 *                 journald __REALTIME_TIMESTAMP.  Contract is
 *                 "return null on garbage"; call site
 *                 (tailJournalctl's stdout 'data' handler) has no
 *                 outer try/catch, so a RangeError would crash the
 *                 tailer and the bot would stop alerting.
 *
 *   ME-2 (MED-on-paper, LOW-practical)  buildDigestBody() must
 *                 HTML-escape category strings before inlining them
 *                 into the formatted_body.  Matches renderAlertBody
 *                 hardening so both Matrix-HTML surfaces share one
 *                 canonical defense.
 *
 *   B-1 (LOW)     drainInfoEvents() must tolerate corrupt JSON
 *                 rows.  Naive `rows.map(r => JSON.parse(...))`
 *                 throws on the first bad row; the surrounding
 *                 DELETE never runs; the corrupt row stays; same
 *                 throw every 24h cycle = silent permanent hang.
 *
 *   B-2 (LOW)     parseJournalLine() must cap envelope-field
 *                 lengths (module/event/source/ts).  A compromised
 *                 sidecar emitting a 1 MB module string would
 *                 explode downstream consumers (renderAlertBody
 *                 default-path title, digest cat interpolation).
 *                 Cap is 256 bytes with "(truncated)" suffix.
 *
 *   B-3 (LOW)     config.ts digest-time regex must reject hour
 *                 values 24-29 (Date.UTC silently absorbed them).
 *
 *   B-4 (LOW)     config.ts homeserver URL must reject http://
 *                 schemes except for localhost / 127.x / [::1].
 *
 * Tamper test (do NOT change production code to satisfy these;
 * if you must change a production constant, update the test):
 *
 *   ME-1: revert journalctl.ts isFinite guard → "RangeError" pop.
 *   ME-2: revert digest.ts to interpolate `cat` without escape.
 *   B-1:  revert state.ts drainInfoEvents to naive .map.
 *   B-2:  revert journalctl.ts truncEnv → length not capped.
 *   B-3:  revert config.ts regex to /^[0-2]\d:[0-5]\d$/.
 *   B-4:  revert config.ts .refine on homeserver scheme.
 */

import { parseJournalLine } from '../src/journalctl.ts';
import { buildDigestBody } from '../src/digest.ts';
import type { StructuredAlert } from '../src/classifier.ts';
import { parseInfoRowsTolerantly } from '../src/state.ts';
import { parseConfig } from '../src/config.ts';

interface Scenario {
	readonly name: string;
	readonly run: () => string | null;
}

// ─── ME-1 scenarios ──────────────────────────────────────────────

function feedJournalLine(realtimeTimestamp: unknown): {
	threw: boolean;
	result: StructuredAlert | null;
	error?: string;
} {
	const inner = JSON.stringify({
		// ts deliberately omitted → forces fallback to __REALTIME_TIMESTAMP
		module: 'host-resource',
		event: 'mem_warn',
		context: {}
	});
	const outer = {
		MESSAGE: inner,
		__REALTIME_TIMESTAMP: realtimeTimestamp
	};
	try {
		const result = parseJournalLine(JSON.stringify(outer));
		return { threw: false, result };
	} catch (err) {
		return {
			threw: true,
			result: null,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

const me1: Scenario[] = [
	{
		name: 'ME-1 a: __REALTIME_TIMESTAMP = "garbage" must not throw',
		run: () => {
			const r = feedJournalLine('garbage');
			if (r.threw) return `threw on hostile string: ${r.error}`;
			if (r.result === null) return 'returned null instead of falling back to current time';
			if (!/^\d{4}-\d{2}-\d{2}T/.test(r.result.ts)) return `bad ts shape: ${r.result.ts}`;
			return null;
		}
	},
	{
		name: 'ME-1 b: __REALTIME_TIMESTAMP = "" (empty) must not throw',
		run: () => {
			const r = feedJournalLine('');
			if (r.threw) return `threw on empty: ${r.error}`;
			if (r.result === null) return 'returned null on empty timestamp';
			return null;
		}
	},
	{
		name: 'ME-1 c: __REALTIME_TIMESTAMP = "Infinity" must not throw',
		run: () => {
			const r = feedJournalLine('Infinity');
			if (r.threw) return `threw on Infinity: ${r.error}`;
			if (r.result === null) return 'returned null on Infinity';
			if (!/^\d{4}-\d{2}-\d{2}T/.test(r.result.ts)) return `bad ts shape: ${r.result.ts}`;
			return null;
		}
	},
	{
		name: 'ME-1 d: __REALTIME_TIMESTAMP overflows Date range must not throw',
		run: () => {
			const r = feedJournalLine('9000000000000000000000');
			if (r.threw) return `threw on overflow: ${r.error}`;
			if (r.result === null) return 'returned null on overflow';
			if (!/^\d{4}-\d{2}-\d{2}T/.test(r.result.ts)) return `bad ts shape: ${r.result.ts}`;
			return null;
		}
	},
	{
		name: 'ME-1 e: well-formed __REALTIME_TIMESTAMP still produces correct ts',
		run: () => {
			// 1716624000000000 microseconds = 1716624000000 ms = 2024-05-25T08:00:00.000Z.
			const r = feedJournalLine('1716624000000000');
			if (r.threw) return `threw on valid: ${r.error}`;
			if (r.result === null) return 'returned null on valid';
			if (r.result.ts !== '2024-05-25T08:00:00.000Z')
				return `wrong ts: ${r.result.ts}`;
			return null;
		}
	}
];

// ─── ME-2 scenarios ──────────────────────────────────────────────

function alertWithModuleEvent(module: string, event: string): StructuredAlert {
	return {
		module,
		event,
		payload: {},
		source: 'morphit-test.service',
		ts: '2026-05-25T00:00:00Z'
	};
}

const me2: Scenario[] = [
	{
		name: 'ME-2 a: <script> in module is escaped in digest html',
		run: () => {
			const body = buildDigestBody(
				[alertWithModuleEvent('<script>alert(1)</script>', 'evt')],
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{} as any
			);
			if (body.html.includes('<script>'))
				return 'raw <script> tag in digest html';
			if (!body.html.includes('&lt;script&gt;'))
				return 'expected &lt;script&gt; entity not found';
			return null;
		}
	},
	{
		name: 'ME-2 b: " quote in event is escaped',
		run: () => {
			const body = buildDigestBody(
				[alertWithModuleEvent('mod', 'evt"attr=bad')],
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{} as any
			);
			if (body.html.includes('"attr=bad'))
				return 'raw " in digest html';
			if (!body.html.includes('&quot;'))
				return 'expected &quot; entity not found';
			return null;
		}
	},
	{
		name: "ME-2 c: ' apostrophe is escaped",
		run: () => {
			const body = buildDigestBody(
				[alertWithModuleEvent('mod', "evt'x")],
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{} as any
			);
			if (body.html.includes("'x")) return "raw ' in digest html";
			if (!body.html.includes('&#39;')) return 'expected &#39; entity not found';
			return null;
		}
	},
	{
		name: 'ME-2 d: & ampersand is escaped (no double-escape on entities)',
		run: () => {
			const body = buildDigestBody(
				[alertWithModuleEvent('a&b', 'c')],
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{} as any
			);
			if (/a&b/.test(body.html.replace(/&amp;/g, '!!!')))
				return 'raw & in digest html';
			if (!body.html.includes('a&amp;b'))
				return 'expected a&amp;b not found';
			return null;
		}
	},
	{
		name: 'ME-2 e: plain body keeps raw characters (only html is escaped)',
		run: () => {
			const body = buildDigestBody(
				[alertWithModuleEvent('<script>', 'evt')],
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				{} as any
			);
			if (!body.plain.includes('<script>:evt'))
				return 'plain body lost the raw content';
			return null;
		}
	}
];

// ─── B-1 scenarios (drainInfoEvents tolerant of corrupt JSON) ────
//
// We test the extracted parseInfoRowsTolerantly helper directly,
// not the SQLite-backed drainInfoEvents.  Production drain calls
// the same helper.  This decouples the smoke from native-module
// build environments (the smoke runner may lack a built
// better-sqlite3 binary) while still covering the bug class.

// Silence the stderr log inside the helper so the smoke output
// stays clean.
function quietParse(
	rows: ReadonlyArray<{ payload_json: string }>
): ReadonlyArray<StructuredAlert> {
	const origErr = console.error;
	console.error = () => {};
	try {
		return parseInfoRowsTolerantly(rows);
	} finally {
		console.error = origErr;
	}
}

const b1: Scenario[] = [
	{
		name: 'B-1 a: corrupt JSON row does not throw the parse',
		run: () => {
			const rows = [
				{ payload_json: JSON.stringify({ module: 'a', event: 'one', ts: 't1' }) },
				{ payload_json: 'this is not valid json {{{' },
				{ payload_json: JSON.stringify({ module: 'b', event: 'two', ts: 't2' }) }
			];
			let drained: ReadonlyArray<StructuredAlert>;
			try {
				drained = quietParse(rows);
			} catch (err) {
				return `parseInfoRowsTolerantly threw: ${err instanceof Error ? err.message : String(err)}`;
			}
			if (drained.length !== 2)
				return `expected 2 good events after dropping corrupt, got ${drained.length}`;
			if (drained[0]?.event !== 'one' || drained[1]?.event !== 'two')
				return `wrong events: ${drained.map((e) => e.event).join(',')}`;
			return null;
		}
	},
	{
		name: 'B-1 b: all-corrupt batch returns empty array, does not throw',
		run: () => {
			const rows = [
				{ payload_json: 'not json' },
				{ payload_json: '{' },
				{ payload_json: '}' }
			];
			let drained: ReadonlyArray<StructuredAlert>;
			try {
				drained = quietParse(rows);
			} catch (err) {
				return `parseInfoRowsTolerantly threw on all-corrupt: ${err instanceof Error ? err.message : String(err)}`;
			}
			if (drained.length !== 0)
				return `expected 0 events from all-corrupt batch, got ${drained.length}`;
			return null;
		}
	},
	{
		name: 'B-1 c: empty batch returns empty array',
		run: () => {
			const drained = quietParse([]);
			if (drained.length !== 0)
				return `expected 0 events from empty batch, got ${drained.length}`;
			return null;
		}
	},
	{
		name: 'B-1 d: input order preserved (minus drops)',
		run: () => {
			const rows = [
				{ payload_json: JSON.stringify({ module: 'a', event: '1', ts: 't' }) },
				{ payload_json: 'corrupt-1' },
				{ payload_json: JSON.stringify({ module: 'b', event: '2', ts: 't' }) },
				{ payload_json: 'corrupt-2' },
				{ payload_json: JSON.stringify({ module: 'c', event: '3', ts: 't' }) }
			];
			const drained = quietParse(rows);
			if (drained.length !== 3) return `expected 3, got ${drained.length}`;
			const order = drained.map((e) => e.event).join(',');
			if (order !== '1,2,3') return `order broken: ${order}`;
			return null;
		}
	}
];

// ─── B-2 scenarios (envelope field length caps) ──────────────────

function feedAlertWithModule(module: string, event = 'evt'): StructuredAlert | null {
	const inner = JSON.stringify({ module, event, context: {} });
	return parseJournalLine(JSON.stringify({ MESSAGE: inner }));
}

const b2: Scenario[] = [
	{
		name: 'B-2 a: 10 KB module string is capped to ~256 bytes + truncation marker',
		run: () => {
			const huge = 'A'.repeat(10_000);
			const r = feedAlertWithModule(huge);
			if (r === null) return 'parseJournalLine returned null on huge module';
			if (r.module.length > 320)
				return `module not capped: length ${r.module.length}`;
			if (!r.module.endsWith('…(truncated)'))
				return 'truncation marker missing';
			return null;
		}
	},
	{
		name: 'B-2 b: 10 KB event string is capped',
		run: () => {
			const huge = 'B'.repeat(10_000);
			const r = feedAlertWithModule('m', huge);
			if (r === null) return 'parseJournalLine returned null on huge event';
			if (r.event.length > 320)
				return `event not capped: length ${r.event.length}`;
			return null;
		}
	},
	{
		name: 'B-2 c: 10 KB _SYSTEMD_UNIT source is capped',
		run: () => {
			const huge = 'S'.repeat(10_000);
			const inner = JSON.stringify({ module: 'm', event: 'e', context: {} });
			const outer = { MESSAGE: inner, _SYSTEMD_UNIT: huge };
			const r = parseJournalLine(JSON.stringify(outer));
			if (r === null) return 'parseJournalLine returned null on huge source';
			if (!r.source || r.source.length > 320)
				return `source not capped: length ${r.source?.length}`;
			return null;
		}
	},
	{
		name: 'B-2 d: short module passes through unchanged',
		run: () => {
			const r = feedAlertWithModule('operator-balance', 'low_balance');
			if (r === null) return 'null on short module';
			if (r.module !== 'operator-balance') return `module mangled: ${r.module}`;
			if (r.event !== 'low_balance') return `event mangled: ${r.event}`;
			return null;
		}
	}
];

// ─── B-3 scenarios (digest-time regex) ───────────────────────────

function parseWithTime(t: string): { ok: boolean; err?: string } {
	try {
		parseConfig({
			MORPHIT_MATRIX_BOT_ALERT_MXID: '@a:b.example',
			MORPHIT_MATRIX_BOT_ACCESS_TOKEN: 'x',
			MORPHIT_MATRIX_BOT_DIGEST_SEND_TIME_UTC: t
		});
		return { ok: true };
	} catch (err) {
		return { ok: false, err: err instanceof Error ? err.message : String(err) };
	}
}

const b3: Scenario[] = [
	{
		name: 'B-3 a: "24:00" rejected',
		run: () => {
			const r = parseWithTime('24:00');
			if (r.ok) return 'parseConfig accepted "24:00"';
			return null;
		}
	},
	{
		name: 'B-3 b: "29:59" rejected',
		run: () => {
			const r = parseWithTime('29:59');
			if (r.ok) return 'parseConfig accepted "29:59"';
			return null;
		}
	},
	{
		name: 'B-3 c: "23:59" accepted (valid)',
		run: () => {
			const r = parseWithTime('23:59');
			if (!r.ok) return `parseConfig rejected valid "23:59": ${r.err}`;
			return null;
		}
	},
	{
		name: 'B-3 d: "00:00" accepted (valid midnight)',
		run: () => {
			const r = parseWithTime('00:00');
			if (!r.ok) return `parseConfig rejected valid "00:00": ${r.err}`;
			return null;
		}
	}
];

// ─── B-4 scenarios (homeserver URL scheme) ───────────────────────

function parseWithHomeserver(url: string): { ok: boolean; err?: string } {
	try {
		parseConfig({
			MORPHIT_MATRIX_BOT_ALERT_MXID: '@a:b.example',
			MORPHIT_MATRIX_BOT_ACCESS_TOKEN: 'x',
			MORPHIT_MATRIX_BOT_HOMESERVER: url
		});
		return { ok: true };
	} catch (err) {
		return { ok: false, err: err instanceof Error ? err.message : String(err) };
	}
}

const b4: Scenario[] = [
	{
		name: 'B-4 a: https://matrix.org accepted',
		run: () => {
			const r = parseWithHomeserver('https://matrix.org');
			if (!r.ok) return `rejected valid https url: ${r.err}`;
			return null;
		}
	},
	{
		name: 'B-4 b: http://matrix.example.com rejected (must be https)',
		run: () => {
			const r = parseWithHomeserver('http://matrix.example.com');
			if (r.ok) return 'http:// scheme was accepted';
			return null;
		}
	},
	{
		name: 'B-4 c: http://localhost:8008 accepted (loopback exception)',
		run: () => {
			const r = parseWithHomeserver('http://localhost:8008');
			if (!r.ok) return `rejected localhost dev url: ${r.err}`;
			return null;
		}
	},
	{
		name: 'B-4 d: http://127.0.0.1:8008 accepted (loopback exception)',
		run: () => {
			const r = parseWithHomeserver('http://127.0.0.1:8008');
			if (!r.ok) return `rejected loopback ipv4 dev url: ${r.err}`;
			return null;
		}
	},
	{
		name: 'B-4 e: http://[::1]:8008 accepted (loopback ipv6)',
		run: () => {
			const r = parseWithHomeserver('http://[::1]:8008');
			if (!r.ok) return `rejected loopback ipv6 dev url: ${r.err}`;
			return null;
		}
	},
	{
		name: 'B-4 f: ftp:// scheme rejected',
		run: () => {
			const r = parseWithHomeserver('ftp://matrix.org');
			if (r.ok) return 'ftp:// scheme was accepted';
			return null;
		}
	}
];

// ─── Runner ──────────────────────────────────────────────────────

const scenarios = [...me1, ...me2, ...b1, ...b2, ...b3, ...b4];

console.log(`matrix-bot-input-hardening smoke: ${scenarios.length} scenarios\n`);
let failed = 0;
for (const s of scenarios) {
	const result = s.run();
	if (result === null) {
		console.log(`  ✓ ${s.name}`);
	} else {
		console.log(`  ✗ ${s.name}: ${result}`);
		failed++;
	}
}

console.log('');
if (failed === 0) {
	console.log(`✓ all ${scenarios.length} matrix-bot-input-hardening checks hold`);
	process.exit(0);
}
console.error(`✗ ${failed} failed, ${scenarios.length - failed} passed`);
process.exit(1);
