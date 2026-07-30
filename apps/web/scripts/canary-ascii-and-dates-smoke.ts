#!/usr/bin/env tsx
/**
 * Smoke: the warrant canary is byte-portable and human-readable. Anchor
 * 2026-07-08 (Ken).
 *
 * Two reported problems, both guarded here:
 *
 *  1. MOJIBAKE — the published canary showed "Morphit operator canary â€”
 *     morphit.io" and "â€¢" bullets. Those are UTF-8 em-dash / bullet bytes
 *     being decoded as Latin-1 by whatever is reading the file. A warrant
 *     canary is a plain-text legal declaration that people fetch with curl,
 *     open in random viewers, and feed to gpg — it must not depend on the
 *     reader guessing a charset. The template is therefore PURE ASCII, which
 *     makes the failure mode structurally impossible rather than merely fixed.
 *
 *  2. ZULU TIMESTAMPS — "2026-07-08T23:45:18Z" reads as machine output to a
 *     human trying to judge whether the canary is fresh, which is the single
 *     thing this file exists to communicate. The generator now emits Ken's
 *     sitewide format: "8 July, 2026 @ 23:45:18 UTC".
 *
 * `verify.ts` must accept BOTH the new format and the legacy ISO form, or the
 * canary currently signed + deployed on morphit.io would stop verifying.
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * `scripts/canary/verify.ts` lives in the ROOT workspace (CommonJS) while this
 * smoke runs in apps/web (ESM), so a named import across that boundary fails.
 * Exercise the verifier the way operators actually use it instead — through
 * its CLI, over real fixture files. That also covers the argv/exit-code
 * contract, which a direct function import would silently skip.
 */
function runVerify(body: string): { code: number; out: string } {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-canary-'));
	const f = join(dir, 'canary.txt');
	writeFileSync(f, body, 'utf8');
	const r = spawnSync('npx', ['tsx', join(REPO, 'scripts', 'canary', 'verify.ts'), f], {
		encoding: 'utf8',
		timeout: 60_000
	});
	return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** A minimal, fully-substituted canary with the given Generated: stamp. */
function canaryWith(stamp: string): string {
	return template
		.replace(/\{\{OPERATOR_NAME\}\}/g, 'morphit.io')
		.replace(/\{\{INSTANCE_ORIGIN\}\}/g, 'https://morphit.io')
		.replace(/\{\{GENERATED_AT_ISO\}\}/g, stamp)
		.replace(/\{\{VALID_THROUGH_ISO\}\}/g, stamp)
		.replace(/\{\{OPERATOR_ACCOUNT\}\}/g, 'morphit')
		.replace(/\{\{BLURT_HEAD_HEIGHT\}\}/g, '12345678')
		.replace(/\{\{BLURT_HEAD_HASH\}\}/g, 'abc123')
		.replace(/\{\{BLURT_HEAD_TIMESTAMP\}\}/g, stamp)
		.replace(/\{\{BTC_HEAD_HEIGHT\}\}/g, '900001')
		.replace(/\{\{BTC_HEAD_HASH\}\}/g, '0000deadbeef')
		.replace(/\{\{NEWS_HEADLINE\}\}/g, 'A headline')
		.replace(/\{\{NEWS_RSS\}\}/g, 'https://example.org/rss')
		.replace(/\{\{NEWS_FETCHED_AT\}\}/g, stamp);
}

function nowStamp(offsetDays = 0): string {
	const d = new Date(Date.now() + offsetDays * 86_400_000);
	const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${d.getUTCFullYear()} @ ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function nowIso(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const REPO = join(WEB, '..', '..');

const template = readFileSync(join(WEB, 'static', 'canary.txt.template'), 'utf8');
const templateBytes = readFileSync(join(WEB, 'static', 'canary.txt.template'));
const generate = readFileSync(join(REPO, 'scripts', 'canary', 'generate.sh'), 'utf8');
const verify = readFileSync(join(REPO, 'scripts', 'canary', 'verify.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

// ─── 1. Pure ASCII: mojibake is structurally impossible ──────────────
const highBytes = [...templateBytes].filter((b) => b > 127);
check('canary template contains ZERO bytes above 0x7F (pure ASCII)', highBytes.length === 0);
check('no em-dash / bullet left in the template', !template.includes('\u2014') && !template.includes('\u2022'));
check('the mojibake strings themselves never appear', !/\u00e2\u20ac/.test(template));

// ─── 2. Human timestamps, ASCII-safe, English months ─────────────────
check('generator emits the sitewide stamp "%-d %B, %Y @ %H:%M:%S UTC"', /%-d %B, %Y @ %H:%M:%S UTC/.test(generate));
check('generator no longer emits a bare Zulu ISO stamp', !/\+%Y-%m-%dT%H:%M:%SZ/.test(generate));
check('generator pins LC_ALL=C so month names are English + ASCII', /LC_ALL=C date/.test(generate));
check('the Blurt head timestamp is reformatted too', /BLURT_HEAD_TIMESTAMP="\$\(canary_stamp/.test(generate));
check('a malformed chain timestamp cannot abort generation (fallback)', /\|\| printf '%s' "\$BLURT_HEAD_TIMESTAMP"/.test(generate));

// ─── 3. verify.ts parses BOTH formats ────────────────────────────────
check('Generated: capture takes the whole line (not the first token)', /\^Generated:\[ \\t\]\*\(\.\+\)\$/.test(verify));

// Behavioural: run the REAL verifier CLI over real fixtures.
const fresh = runVerify(canaryWith(nowStamp()));
check('verifier accepts the new human stamp', fresh.code === 0 && /canary-verify: OK/.test(fresh.out));

const legacy = runVerify(canaryWith(nowIso()));
check('verifier still accepts the LEGACY Zulu ISO stamp (deployed canary)', legacy.code === 0 && /canary-verify: OK/.test(legacy.out));

const stale = runVerify(canaryWith(nowStamp(-30)));
check('a stale canary still FAILS (freshness guard not weakened)', stale.code !== 0 && /stale/.test(stale.out));

const bogus = runVerify(canaryWith('30 Junius, 2026 @ 16:45:18 UTC'));
check('a bogus month is rejected, not silently treated as fresh', bogus.code !== 0 && /not parseable/.test(bogus.out));

// ─── 4. verify.ts stays importable (run-as-main guard) ───────────────
check('verify.ts has a run-as-main guard (importing it must not run the CLI)', /invokedDirectly/.test(verify) && /if \(invokedDirectly\)/.test(verify));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} canary-ascii-and-dates scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} canary-ascii-and-dates checks FAILED`);
	process.exit(1);
}
