#!/usr/bin/env tsx
/**
 * render-alert-hardening-smoke — regression test for cp18 AUDIT-2,
 * AUDIT-3, AUDIT-4: matrix-bot's renderAlertBody must defend
 * against attacker-influenced payload content reaching Matrix.
 *
 * Threat model: an attacker who can write attacker-controlled
 * strings into a sidecar's structured-log payload (the cp18
 * AUDIT-1 fix blocks newline-injection forging, but doesn't
 * sanitize the CONTENT of legitimate raw_line fields).  Possible
 * via:
 *   - process `comm` names from OOM-kill messages
 *   - container names + image tags from Docker
 *   - apt package names from third-party PPAs
 *   - mount paths from FUSE filesystems
 *
 * The cp18 defenses:
 *   AUDIT-2 — strip C0 control chars (terminal escape sequences
 *             could clear the operator's terminal when viewing
 *             journalctl directly)
 *   AUDIT-3 — defang Matrix mxid + room-alias patterns by
 *             inserting ZWJ after the sigil (no pill render in
 *             Matrix clients — strings like `@victim:matrix.org`
 *             in raw_line don't ping random users)
 *   AUDIT-4 — cap per-field + total payload size so a compromised
 *             sidecar can't DoS the bot with mega-payloads
 *             (Matrix message size limit ~65KB)
 */

import { renderAlertBody } from '../src/classifier.ts';
import type { ClassifiedAlert } from '../src/classifier.ts';

interface Scenario {
	readonly name: string;
	readonly alert: ClassifiedAlert;
	/** Assertions to apply against the rendered plain+html. */
	readonly assert: (rendered: { plain: string; html: string }) => string | null;
}

function alert(payload: Record<string, unknown>): ClassifiedAlert {
	return {
		tier: 'WARN',
		alert: {
			module: 'dmesg',
			event: 'oom_kill',
			payload,
			source: 'morphit-dmesg-monitor.service',
			ts: '2026-05-15T00:00:00Z'
		}
	};
}

const scenarios: Scenario[] = [
	{
		name: 'AUDIT-2: ESC char in payload is stripped (no terminal injection)',
		alert: alert({ victim_proc: 'evil\x1b[2J\x1b[H' }),
		assert: (r) => {
			if (r.plain.includes('\x1b')) return 'plain body still contains ESC byte';
			if (r.html.includes('\x1b')) return 'html body still contains ESC byte';
			return null;
		}
	},
	{
		name: 'AUDIT-2: NUL + bell + form-feed stripped',
		alert: alert({ raw_line: 'msg\x00bell\x07ff\x0cend' }),
		assert: (r) => {
			if (/[\x00\x07\x0c]/.test(r.plain)) return 'plain body has unstripped control char';
			return null;
		}
	},
	{
		name: 'AUDIT-2: tab and newline ARE preserved (legitimate formatting)',
		alert: alert({ raw_line: 'line1\nline2\tcolumn' }),
		assert: (r) => {
			if (!r.plain.includes('line1\nline2\tcolumn'))
				return 'plain body should preserve tab and newline in raw_line';
			return null;
		}
	},
	{
		name: 'AUDIT-3: Matrix mxid is defanged with ZWJ',
		alert: alert({ raw_line: 'ping @victim:matrix.org maybe' }),
		assert: (r) => {
			// Bare mxid should NOT appear; defanged form should
			// (contains ZWJ between @ and victim).
			if (r.plain.includes('@victim:matrix.org'))
				return 'plain body still contains bare mxid (no ZWJ defang)';
			if (!r.plain.includes('@\u200dvictim:matrix.org'))
				return 'plain body missing the defanged mxid form';
			return null;
		}
	},
	{
		name: 'AUDIT-3: Matrix room alias is defanged with ZWJ',
		alert: alert({ raw_line: 'announce in #general:matrix.org' }),
		assert: (r) => {
			if (r.plain.includes('#general:matrix.org'))
				return 'plain body still contains bare room alias';
			if (!r.plain.includes('#\u200dgeneral:matrix.org'))
				return 'plain body missing defanged room alias';
			return null;
		}
	},
	{
		name: 'AUDIT-4: huge per-field gets truncated to ~1KB',
		alert: alert({ huge: 'x'.repeat(50_000) }),
		assert: (r) => {
			// Plain body should contain "…(truncated)" somewhere.
			if (!r.plain.includes('…(truncated)'))
				return 'plain body should mark truncation';
			// And total plain length should be well under 50KB even
			// though one field was 50KB.
			if (r.plain.length > 12_000)
				return `plain body too large: ${r.plain.length} bytes`;
			return null;
		}
	},
	{
		name: 'AUDIT-4: many-field payload gets capped overall',
		alert: alert(
			Object.fromEntries(
				Array.from({ length: 200 }, (_, i) => [`f${i}`, 'x'.repeat(500)])
			)
		),
		assert: (r) => {
			if (r.plain.length > 12_000)
				return `plain body too large: ${r.plain.length} bytes`;
			if (!r.plain.includes('…(payload truncated)'))
				return 'plain body should mark overall truncation';
			return null;
		}
	},
	{
		name: 'AUDIT-2+3 combined: attacker payload with control char AND mxid',
		alert: alert({
			raw_line: 'msg\x1bbypass and @target:matrix.org'
		}),
		assert: (r) => {
			if (r.plain.includes('\x1b')) return 'plain has ESC';
			if (r.plain.includes('@target:matrix.org'))
				return 'plain has bare mxid';
			return null;
		}
	}
];

console.log(`render-alert-hardening smoke: ${scenarios.length} scenarios\n`);
let failed = 0;
for (const s of scenarios) {
	let rendered: { plain: string; html: string };
	try {
		rendered = renderAlertBody(s.alert);
	} catch (err) {
		console.log(`  ✗ ${s.name}: renderAlertBody threw: ${err}`);
		failed++;
		continue;
	}
	const fail = s.assert(rendered);
	if (fail === null) {
		console.log(`  ✓ ${s.name}`);
	} else {
		console.log(`  ✗ ${s.name}: ${fail}`);
		failed++;
	}
}

console.log('');
if (failed === 0) {
	console.log(`✓ all ${scenarios.length} render-alert-hardening checks hold`);
	process.exit(0);
}
console.error(`✗ ${failed} failed, ${scenarios.length - failed} passed`);
process.exit(1);
