#!/usr/bin/env tsx
/**
 * scripts/operations-hardening-smoke.ts
 *
 * Verify OPERATIONS.md §37 (comprehensive server hardening)
 * stays internally cohesive:
 *
 *   1. Subsections numbered §37.1 through §37.N exist with no gaps.
 *   2. Every cross-reference (§37.X) resolves to an existing
 *      subsection.
 *   3. Every cross-reference to other top-level sections (§5, §34,
 *      etc.) resolves to a section that actually exists in
 *      OPERATIONS.md or RUN-A-MORPHIT-NODE.md.
 *   4. The final checklist table at §37.18 references each of
 *      37.1 through 37.17 exactly once (so the operator gets a
 *      summary that doesn't silently drop a defense layer).
 *
 * This guards against the most likely regression mode: someone
 * adds a §37.X subsection mid-doc but forgets to update the
 * cross-reference table at the bottom, leaving the operator
 * unaware of a hardening step.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OPS = join(REPO, 'docs/OPERATIONS.md');
const RUN = join(REPO, 'docs/RUN-A-MORPHIT-NODE.md');

const failures: string[] = [];
const ops = readFileSync(OPS, 'utf8');
const run = readFileSync(RUN, 'utf8');

console.log('\n── operations-hardening smoke ──────────────────────────\n');

// ─── Find §37 subsection headings ────────────────────────────────
const subsections = new Set<number>();
for (const m of ops.matchAll(/^### 37\.(\d+) /gm)) {
	subsections.add(Number(m[1]!));
}
const subsectionNumbers = [...subsections].sort((a, b) => a - b);
console.log(`  §37 subsections found: ${subsectionNumbers.length}`);

if (subsectionNumbers.length === 0) {
	failures.push('§37 has no `### 37.X` subsections');
} else {
	const max = Math.max(...subsectionNumbers);
	const min = Math.min(...subsectionNumbers);
	if (min !== 1) {
		failures.push(`§37 subsections start at 37.${min}, not 37.1`);
	}
	for (let i = min; i <= max; i++) {
		if (!subsections.has(i)) {
			failures.push(`§37 has gap: missing §37.${i}`);
		}
	}
}

// ─── Cross-references inside OPERATIONS.md ───────────────────────
// Every "§37.X" citation in §37's body must point to a subsection
// that exists.
for (const m of ops.matchAll(/§37\.(\d+)/g)) {
	const target = Number(m[1]!);
	if (!subsections.has(target)) {
		failures.push(`OPERATIONS.md references §37.${target}, which doesn't exist`);
	}
}
for (const m of run.matchAll(/§37\.(\d+)/g)) {
	const target = Number(m[1]!);
	if (!subsections.has(target)) {
		failures.push(
			`RUN-A-MORPHIT-NODE.md references §37.${target}, which doesn't exist`
		);
	}
}

// ─── Final checklist table coverage ──────────────────────────────
// The §37.18 table is a summary that should reference every
// §37.1–§37.17 at least once.  This catches the regression where
// someone adds §37.X but forgets the table.
const tableStart = ops.search(/^### 37\.18 /m);
if (tableStart === -1) {
	failures.push('§37.18 final-checklist table is missing');
} else {
	// Take from §37.18 to the next `## ` (top-level section) or end of file.
	const remainder = ops.slice(tableStart);
	const nextTopMatch = remainder.search(/\n## /);
	const tableBody = nextTopMatch === -1 ? remainder : remainder.slice(0, nextTopMatch);
	for (const n of subsectionNumbers) {
		if (n >= 18) continue; // table itself; checklist references go up to 17
		if (!new RegExp(`37\\.${n}\\b`).test(tableBody)) {
			failures.push(
				`§37.18 final checklist doesn't reference §37.${n} — ` +
					`a defense layer is missing from the operator's summary table.`
			);
		}
	}
}

// ─── Cross-references to other OPERATIONS.md sections ────────────
// Find every "§N" reference in §37 and confirm §N is a real
// top-level section.
const opsSectionNums = new Set<number>();
for (const m of ops.matchAll(/^## (\d+)\. /gm)) {
	opsSectionNums.add(Number(m[1]!));
}

const sec37Match = ops.match(/^## 37\. [\s\S]*$/m);
if (sec37Match) {
	for (const m of sec37Match[0].matchAll(/§(\d+)\b(?!\.\d)/g)) {
		const target = Number(m[1]!);
		if (target === 37) continue;
		if (!opsSectionNums.has(target)) {
			// May reference RUN-A-MORPHIT-NODE.md sections — those
			// are numbered separately; we only flag if neither doc
			// has it.
			const runHas = new RegExp(`^## ${target}\\. `, 'm').test(run);
			if (!runHas) {
				failures.push(
					`§37 references §${target}, which isn't a real section in ` +
						`OPERATIONS.md or RUN-A-MORPHIT-NODE.md`
				);
			}
		}
	}
}

// ─── Required hardening categories must exist ────────────────────
// Lock in the major defense layers — if someone deletes a whole
// subsection, this surfaces it.
const REQUIRED_KEYWORDS_PER_LAYER: Array<[string, string]> = [
	['SSH hardening', 'PasswordAuthentication no'],
	['Unattended upgrades', 'unattended-upgrades'],
	['Kernel sysctl', 'kptr_restrict'],
	['Mount hardening', 'nosuid,nodev,noexec'],
	['Systemd hardening', 'ProtectSystem'],
	['auditd', 'auditd'],
	['Postgres SCRAM', 'scram-sha-256'],
	['Postgres statement_timeout', 'statement_timeout'],
	['Filesystem integrity (AIDE)', 'aide'],
	['Secrets perms', '0600'],
	['Disk encryption', 'LUKS'],
	['Backup encryption', 'age'],
	['Outbound network policy', 'default deny outgoing'],
	['Operator alerting', 'msmtp'],
	['Rootkit scanner', 'rkhunter'],
	['GRUB password', 'grub-mkpasswd'],
	['Password discipline', 'pwquality']
];
for (const [layer, keyword] of REQUIRED_KEYWORDS_PER_LAYER) {
	if (!ops.toLowerCase().includes(keyword.toLowerCase())) {
		failures.push(
			`Hardening layer "${layer}" missing — keyword "${keyword}" not found in OPERATIONS.md`
		);
	}
}

// ─── §38 squatter-defense playbook cohesion ──────────────────────
// §38 must reference all six Layer 7 / Layer 8 environment
// knobs by name AND the diamond-hardened preset.  If someone
// removes one of these, the operator's tactical guide silently
// loses a defense.
const sec38Start = ops.search(/^## 38\. /m);
if (sec38Start === -1) {
	failures.push('§38 squatter-defense playbook is missing');
} else {
	const remainder = ops.slice(sec38Start);
	const next = remainder.search(/\n## /);
	const sec38 = next === -1 ? remainder : remainder.slice(0, next);
	const REQUIRED_SQUATTER_KEYS = [
		'MORPHIT_RELAY_HIGHVALUE_NAME_POLICY',
		'MORPHIT_RELAY_HIGHVALUE_SHORT_NAME_THRESHOLD',
		'MORPHIT_RELAY_SEQUENTIAL_DETECTOR_ENABLED',
		'MORPHIT_RELAY_SEQUENTIAL_THRESHOLD',
		'MORPHIT_RELAY_SEQUENTIAL_WINDOW_MS',
		'MORPHIT_RELAY_SEQUENTIAL_MIN_PREFIX',
		'highvalue_name_rejected', // log event name
		'sequential_pattern_rejected', // log event name
		'DIAMOND-HARDENED' // the preset must be present
	];
	for (const key of REQUIRED_SQUATTER_KEYS) {
		if (!sec38.includes(key)) {
			failures.push(
				`§38 squatter playbook missing required reference: ${key}`
			);
		}
	}
}

// ─── §32 BunkerWeb trusted-proxy section ─────────────────────────
// The compatibility advice for BunkerWeb deployments must
// remain present; an operator skimming §32 should immediately
// see the security-critical trusted-proxy guidance.
const sec32Start = ops.search(/^## 32\. /m);
if (sec32Start === -1) {
	failures.push('§32 BunkerWeb section is missing');
} else {
	const remainder = ops.slice(sec32Start);
	const next = remainder.search(/\n## /);
	const sec32 = next === -1 ? remainder : remainder.slice(0, next);
	if (!sec32.includes('MORPHIT_RELAY_TRUSTED_PROXY_IPS')) {
		failures.push(
			'§32 BunkerWeb section missing MORPHIT_RELAY_TRUSTED_PROXY_IPS guidance'
		);
	}
	if (!sec32.includes('Docker bridge')) {
		failures.push('§32 BunkerWeb section missing Docker-bridge advice');
	}
	if (!/SECURITY WARNING/i.test(sec32)) {
		failures.push(
			'§32 BunkerWeb section missing security warning about overly-broad CIDRs'
		);
	}
}

// ─── Report ──────────────────────────────────────────────────────
if (failures.length > 0) {
	console.log(`\n  ✗ ${failures.length} issue(s):`);
	for (const f of failures) console.log(`    - ${f}`);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${failures.length}/${failures.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(
		`  ✓ §37 has ${subsectionNumbers.length} subsections, ` +
			`all cross-references resolve, all defense layers present`
	);
	console.log('\n──────────────────────────────────────────────────────');
	console.log('✓ all 1 scenarios passed');
}
