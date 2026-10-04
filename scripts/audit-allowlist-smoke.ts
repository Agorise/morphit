#!/usr/bin/env tsx
/**
 * Smoke for the supply-chain audit gate's baseline allowlist.
 *
 * The gate itself (scripts/audit-gate.mjs) needs network (npm audit) and runs
 * in CI. This smoke runs OFFLINE in the battery and guards the allowlist file's
 * structural integrity, so a malformed or under-documented allowlist can't
 * silently neuter the gate (e.g. an entry with no category/rationale, or a
 * category the gate/humans don't recognise).
 *
 * Coverage:
 *   - .audit-allowlist.json exists and is valid JSON
 *   - has an `allow` object and a `_categories` map
 *   - every entry has package + severity + a recognised category
 *   - every category used is documented in `_categories`
 *   - the gate script exists (so the smoke fails loudly if it's deleted)
 *   - every entry carries a reason and a lastReviewed date
 *   - the gate's verdict on synthetic audits:
 *     it fails when the audit cannot run, on a stale entry, on an advisory an
 *     in-range update fixes, and on an untriaged moderate; it passes on a
 *     fully triaged audit.
 *   MORPHIT_AUDIT_GATE=<other copy> runs the verdict checks against it.
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

let failures = 0;
let scenarios = 0;
function check(name: string, fn: () => void): void {
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
function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

const ALLOWLIST = '.audit-allowlist.json';
const GATE = 'scripts/audit-gate.mjs';
const VALID_SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);

console.log('audit-allowlist smoke:\n');

let parsed: {
	allow?: Record<string, { package?: string; severity?: string; category?: string }>;
	_categories?: Record<string, string>;
} = {};

check('.audit-allowlist.json exists and is valid JSON', () => {
	assert(existsSync(ALLOWLIST), `${ALLOWLIST} not found`);
	parsed = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
	assert(typeof parsed === 'object' && parsed !== null, 'not an object');
});

check('has an `allow` object and a `_categories` map', () => {
	assert(parsed.allow && typeof parsed.allow === 'object', 'missing `allow` object');
	assert(parsed._categories && typeof parsed._categories === 'object', 'missing `_categories` map');
	assert(Object.keys(parsed.allow).length > 0, '`allow` is empty');
});

check('every allow entry has package + valid severity + a category', () => {
	for (const [ghsa, e] of Object.entries(parsed.allow ?? {})) {
		assert(ghsa.startsWith('GHSA'), `key is not a GHSA id: ${ghsa}`);
		assert(typeof e.package === 'string' && e.package.length > 0, `${ghsa}: missing package`);
		assert(VALID_SEVERITIES.has(e.severity ?? ''), `${ghsa}: invalid severity "${e.severity}"`);
		assert(typeof e.category === 'string' && e.category.length > 0, `${ghsa}: missing category`);
	}
});

check('every category used is documented in `_categories`', () => {
	const documented = new Set(Object.keys(parsed._categories ?? {}));
	for (const [ghsa, e] of Object.entries(parsed.allow ?? {})) {
		assert(
			documented.has(e.category ?? ''),
			`${ghsa}: category "${e.category}" not in _categories`
		);
	}
});

check('the gate script exists', () => {
	assert(existsSync(GATE), `${GATE} not found — the CI gate would be missing`);
});

check('every allow entry has a reason and a lastReviewed date', () => {
	for (const [ghsa, e] of Object.entries(parsed.allow ?? {}) as Array<
		[string, Record<string, unknown>]
	>) {
		assert(typeof e.rationale === 'string' && e.rationale.length >= 40, `${ghsa}: no reason`);
		assert(
			typeof e.lastReviewed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.lastReviewed),
			`${ghsa}: no lastReviewed`
		);
	}
});

void (async (): Promise<void> => {
	// ── the gate's verdict ──
	type Verdict = { failures: string[]; warnings: string[] };
	type Evaluate = (
		audit: unknown,
		allowText: string,
		o?: { mode?: string; reason?: string | null }
	) => Verdict;
	const gate = (await import(
		pathToFileURL(resolve(process.env.MORPHIT_AUDIT_GATE ?? GATE)).href
	)) as {
		evaluate?: Evaluate;
		auditOrReason?: (cwd?: string) => { audit: unknown; reason: string | null };
	};
	const ALLOW = JSON.stringify({
		_categories: { 'dev-build-only': 'x' },
		allow: {
			'GHSA-aaaa-bbbb-cccc': {
				package: 'vite',
				severity: 'high',
				category: 'dev-build-only',
				title: 't',
				lastReviewed: '2026-10-02',
				rationale: 'dev server only; never started on a node, never shipped to one.'
			}
		}
	});
	const adv = (id: string, name: string, severity: string, fixAvailable: unknown) => ({
		[name]: {
			name,
			severity,
			fixAvailable,
			via: [{ name, severity, title: 't', url: `https://github.com/advisories/${id}` }]
		}
	});
	const verdict = (audit: unknown, mode?: string): Verdict | null =>
		gate.evaluate ? gate.evaluate(audit, ALLOW, { mode }) : null;
	const triaged = {
		vulnerabilities: adv('GHSA-aaaa-bbbb-cccc', 'vite', 'high', {
			name: 'vite',
			isSemVerMajor: true
		})
	};

	check('gate: a fully triaged audit passes', () => {
		assert(verdict(triaged)?.failures.length === 0, JSON.stringify(verdict(triaged)));
	});
	check('gate: an audit that could not run FAILS (no information is not a pass)', () => {
		assert((verdict(null)?.failures.length ?? 0) > 0, 'passed with no audit');
	});
	check('gate: an audit that could not run says why, and still FAILS in report mode', () => {
		const reason =
			'npm: request to https://registry.npmjs.org/ failed, reason: getaddrinfo EAI_AGAIN';
		const v = gate.evaluate ? gate.evaluate(null, ALLOW, { mode: 'report', reason }) : null;
		assert((v?.failures.length ?? 0) > 0, 'passed with no audit in report mode');
		assert(
			v?.failures.some((f) => f.includes('getaddrinfo EAI_AGAIN')) === true,
			`the reason is not in the failure: ${JSON.stringify(v?.failures)}`
		);
	});
	check(
		"gate: npm's own error (no audit JSON) becomes the reason, and no audit is returned",
		() => {
			assert(typeof gate.auditOrReason === 'function', 'audit-gate.mjs has no auditOrReason()');
			const bin = mkdtempSync(join(tmpdir(), 'audit-npm-'));
			try {
				writeFileSync(
					join(bin, 'npm'),
					'#!/bin/sh\nprintf \'{"message":"request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: self-signed certificate in certificate chain","error":{"summary":"","detail":""}}\\n\'\necho "npm error audit endpoint returned an error" >&2\nexit 1\n',
					{ mode: 0o755 }
				);
				const oldPath = process.env.PATH;
				process.env.PATH = `${bin}:${oldPath ?? ''}`;
				let r: { audit: unknown; reason: string | null } | undefined;
				try {
					r = gate.auditOrReason?.(bin);
				} finally {
					process.env.PATH = oldPath;
				}
				assert(
					r?.audit === null,
					`an npm error object was taken as an audit: ${JSON.stringify(r)}`
				);
				assert(
					(r?.reason ?? '').includes('self-signed certificate in certificate chain'),
					`reason: ${r?.reason}`
				);
			} finally {
				rmSync(bin, { recursive: true, force: true });
			}
		}
	);
	check('gate: an allowlisted advisory npm no longer reports FAILS (stale entry)', () => {
		assert((verdict({ vulnerabilities: {} })?.failures.length ?? 0) > 0, 'stale entry accepted');
	});
	check('gate: an advisory an in-range update fixes FAILS even when allowlisted', () => {
		const a = { vulnerabilities: adv('GHSA-aaaa-bbbb-cccc', 'vite', 'high', true) };
		assert((verdict(a)?.failures.length ?? 0) > 0, 'fixable advisory accepted');
	});
	check('gate: an untriaged moderate FAILS', () => {
		const a = {
			vulnerabilities: {
				...triaged.vulnerabilities,
				...adv('GHSA-dddd-eeee-ffff', 'qs', 'moderate', false)
			}
		};
		assert((verdict(a)?.failures.length ?? 0) > 0, 'untriaged moderate accepted');
	});
	check(
		'gate (release report mode): an untriaged CRITICAL still fails, an untriaged high only warns',
		() => {
			const hi = {
				vulnerabilities: {
					...triaged.vulnerabilities,
					...adv('GHSA-dddd-eeee-ffff', 'x', 'high', false)
				}
			};
			const cr = {
				vulnerabilities: {
					...triaged.vulnerabilities,
					...adv('GHSA-dddd-eeee-ffff', 'x', 'critical', false)
				}
			};
			assert(verdict(hi, 'report')?.failures.length === 0, 'high failed in report mode');
			assert((verdict(cr, 'report')?.failures.length ?? 0) > 0, 'critical passed in report mode');
		}
	);

	console.log(
		`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} audit-allowlist scenarios passed`
	);
	process.exit(failures === 0 ? 0 : 1);
})();
