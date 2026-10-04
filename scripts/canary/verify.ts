#!/usr/bin/env tsx
/**
 * scripts/canary/verify.ts
 *
 * Verify a Morphit warrant canary: its PGP signature, by the key you expect,
 * and then its content (freshness and structure) — the content that was
 * signed, never text around the signature.
 *
 *   ./node_modules/.bin/tsx scripts/canary/verify.ts <path-or-url> --fingerprint <40-hex>
 *   … --key-file pgp_keys.asc      verify against that key file only (a
 *                                  throw-away keyring), not your own keyring
 *   … --structure-only             a template or draft: structure only; it
 *                                  says plainly that nothing was verified
 *
 * The fingerprint is the operator's canary signing key, learned out of band
 * (not from the canary's own instance). gpg must be installed; without gpg,
 * the key, or a good signature from exactly that key, the verdict is FAIL.
 *
 * The frontend's degraded-canary banner pulls /canary.txt and applies the
 * same freshness logic in JS; this script is the reference for "fresh".
 *
 * Exit codes:
 *   0  — signed by the given key, structurally valid, fresh.
 *   1  — anything else: no gpg, no key, bad / missing / other key's
 *        signature, malformed, or stale (treat as silent).
 *   2  — valid but with non-fatal warnings (e.g. a future-dated
 *        Generated: timestamp).
 *   3  — --structure-only: the structure is fine; the signature was NOT checked.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const REQUIRED_PLACEHOLDERS_OR_FILLED = [
	'OPERATOR_NAME',
	'INSTANCE_ORIGIN',
	'GENERATED_AT_ISO',
	'VALID_THROUGH_ISO',
	'OPERATOR_ACCOUNT',
	'BLURT_HEAD_HEIGHT',
	'BLURT_HEAD_HASH',
	'BTC_HEAD_HEIGHT',
	'BTC_HEAD_HASH',
	'NEWS_HEADLINE'
];

const STALE_DAYS = 14;

/**
 * Parse a canary `Generated:` timestamp.
 *
 * Two accepted forms:
 *   • the sitewide human format — "8 July, 2026 @ 23:45:18 UTC"
 *   • the legacy Zulu ISO form  — "2026-07-08T23:45:18Z"
 *
 * The human form is what `scripts/canary/generate.sh` now emits (a
 * warrant canary's whole job is telling a HUMAN whether it's fresh).
 * The ISO form is still accepted so canaries signed before that change
 * — including the one currently deployed — keep verifying.
 *
 * Returns epoch milliseconds, or NaN when neither form matches.
 */
export function parseCanaryTimestamp(raw: string): number {
	const s = raw.trim();
	const human = /^(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})\s*@\s*(\d{2}):(\d{2}):(\d{2})\s*UTC$/.exec(s);
	if (human) {
		const [, d, monthName, y, hh, mm, ss] = human;
		const months = [
			'january',
			'february',
			'march',
			'april',
			'may',
			'june',
			'july',
			'august',
			'september',
			'october',
			'november',
			'december'
		];
		const mi = months.indexOf(monthName!.toLowerCase());
		if (mi === -1) return NaN;
		return Date.UTC(Number(y), mi, Number(d), Number(hh), Number(mm), Number(ss));
	}
	// Legacy Zulu ISO. Require the explicit Z: a bare "2026-07-22 23:45:18"
	// would otherwise be read as LOCAL time by `Date.parse`, skewing the
	// staleness window by the reader's UTC offset. Anything else is NaN —
	// `Date.parse` on a non-ISO string is implementation-defined, and it will
	// cheerfully turn a typo'd month into a real date rather than reject it.
	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) return Date.parse(s);
	return NaN;
}

interface Verification {
	readonly ok: boolean;
	readonly warnings: readonly string[];
	readonly errors: readonly string[];
	readonly generatedAt: string | null;
	readonly ageDays: number | null;
}

export function verifyStructure(text: string): Verification {
	const errors: string[] = [];
	const warnings: string[] = [];

	// ── Structural: must start with the canary header.
	//    A later change renamed the inner marker `-----BEGIN MORPHIT CANARY-----`
	//    (which forced PGP dash-escaping) to `=== MORPHIT CANARY ===`.
	//    Accept BOTH during the transition so an operator's still-valid
	//    OLD-format canary (signed before they pulled the new template)
	//    doesn't trip a false "malformed" alarm until it's re-signed.
	if (
		!text.startsWith('=== MORPHIT CANARY ===') &&
		!text.startsWith('-----BEGIN MORPHIT CANARY-----')
	) {
		errors.push('missing header line "=== MORPHIT CANARY ==="');
	}

	// ── Structural: every required field has been substituted.
	// In a valid canary, none of the {{...}} placeholders remain.
	for (const ph of REQUIRED_PLACEHOLDERS_OR_FILLED) {
		const placeholder = `{{${ph}}}`;
		if (text.includes(placeholder)) {
			errors.push(`unfilled placeholder ${placeholder}`);
		}
	}

	// ── Extract Generated date and check the freshness window.
	let generatedAt: string | null = null;
	let ageDays: number | null = null;
	// Capture the REST OF THE LINE, not the first whitespace-delimited
	// token: the human stamp ("8 July, 2026 @ 23:45:18 UTC") contains
	// spaces, and a `(\S+)` capture would silently grab just "8".
	const m = text.match(/^Generated:[ \t]*(.+)$/m);
	if (m) {
		generatedAt = m[1]!.trim();
		const t = parseCanaryTimestamp(generatedAt);
		if (Number.isNaN(t)) {
			errors.push(`Generated: timestamp is not parseable: ${generatedAt}`);
		} else {
			ageDays = (Date.now() - t) / (24 * 3600 * 1000);
			if (ageDays < 0) {
				warnings.push(`Generated: timestamp is in the future (${ageDays.toFixed(1)} days)`);
			}
			if (ageDays > STALE_DAYS) {
				errors.push(
					`canary is stale: generated ${ageDays.toFixed(1)} days ago ` +
						`(limit: ${STALE_DAYS} days).  Treat as silent.`
				);
			}
		}
	} else {
		errors.push('no Generated: line found');
	}

	return {
		ok: errors.length === 0,
		warnings,
		errors,
		generatedAt,
		ageDays
	};
}

/** The result of checking the PGP signature of a clearsigned canary. */
export type SignatureCheck =
	| { readonly ok: true; readonly signedText: string; readonly fingerprint: string }
	| { readonly ok: false; readonly reason: string };

const FPR_RE = /^[0-9A-F]{40}$/;

/**
 * Check a clearsigned canary with gpg: a good signature (VALIDSIG) whose key
 * fingerprint — the signing subkey's or its primary key's — equals
 * `fingerprint`. With `keyFile`, gpg uses a throw-away keyring holding only
 * that file's keys. Returns the SIGNED text (what gpg says was signed).
 * Fails closed: no gpg, no key, a bad signature, or another key → ok:false.
 */
export function checkCanarySignature(
	text: string,
	opts: { readonly fingerprint: string; readonly keyFile?: string; readonly gpg?: string }
): SignatureCheck {
	const want = opts.fingerprint.replace(/\s+/g, '').toUpperCase();
	if (!FPR_RE.test(want))
		return { ok: false, reason: 'the --fingerprint is not a 40-hex-digit key fingerprint' };
	if (!text.startsWith('-----BEGIN PGP SIGNED MESSAGE-----')) {
		return { ok: false, reason: 'the canary is not a PGP-signed message' };
	}
	const gpg = opts.gpg ?? 'gpg';
	const work = mkdtempSync(join(tmpdir(), 'canary-verify-'));
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' };
		if (opts.keyFile !== undefined) {
			env.GNUPGHOME = join(work, 'gnupg');
			spawnSync('mkdir', ['-m', '700', env.GNUPGHOME]);
			const imp = spawnSync(gpg, ['--batch', '--import', opts.keyFile], { env, encoding: 'utf8' });
			if (imp.error) return { ok: false, reason: 'gpg is not installed' };
			if (imp.status !== 0) return { ok: false, reason: `could not import ${opts.keyFile}` };
		}
		const input = join(work, 'canary.txt');
		writeFileSync(input, text);
		const r = spawnSync(gpg, ['--batch', '--status-fd', '2', '--output', '-', '--decrypt', input], {
			env,
			encoding: 'utf8',
			maxBuffer: 4 * 1024 * 1024
		});
		if (r.error) return { ok: false, reason: 'gpg is not installed' };
		const status = r.stderr ?? '';
		if (/^\[GNUPG:\] NO_PUBKEY /m.test(status)) {
			return { ok: false, reason: `the signing key is not in ${opts.keyFile ?? 'your keyring'}` };
		}
		const valid = [...status.matchAll(/^\[GNUPG:\] VALIDSIG (\S+)(?: \S+)*? (\S+)$/gm)];
		const fprs = valid.flatMap((m) => [m[1]!.toUpperCase(), m[2]!.toUpperCase()]);
		if (r.status !== 0 || valid.length === 0)
			return { ok: false, reason: 'the PGP signature is not good' };
		if (!fprs.includes(want)) {
			return { ok: false, reason: `signed by ${valid[0]![1]}, not by ${want}` };
		}
		return { ok: true, signedText: r.stdout ?? '', fingerprint: want };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function loadFromArg(arg: string): Promise<string> {
	if (arg.startsWith('http://') || arg.startsWith('https://')) {
		const res = await fetch(arg);
		if (!res.ok) {
			throw new Error(`fetch ${arg}: HTTP ${res.status}`);
		}
		return await res.text();
	}
	return readFileSync(arg, 'utf8');
}

function flag(args: readonly string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const arg = args.find(
		(a, i) => !a.startsWith('--') && !['--fingerprint', '--key-file'].includes(args[i - 1] ?? '')
	);
	const fingerprint = flag(args, '--fingerprint');
	const keyFile = flag(args, '--key-file');
	const structureOnly = args.includes('--structure-only');
	if (!arg || (!structureOnly && !fingerprint)) {
		console.error(
			'usage: verify.ts <path-or-url> --fingerprint <40-hex> [--key-file <pgp_keys.asc>]\n' +
				'       verify.ts <path> --structure-only      (no signature check)'
		);
		process.exit(1);
	}
	let text: string;
	try {
		text = await loadFromArg(arg);
	} catch (err) {
		console.error(
			`canary-verify: load failed: ${err instanceof Error ? err.message : String(err)}`
		);
		process.exit(1);
	}

	console.log(`source: ${arg}`);
	let content = text;
	if (!structureOnly) {
		const sig = checkCanarySignature(text, { fingerprint: fingerprint!, keyFile });
		if (!sig.ok) {
			console.log(`  error: ${'reason' in sig ? sig.reason : 'signature not verified'}`);
			console.log('canary-verify: FAIL');
			process.exit(1);
		}
		console.log(`signature: good, by ${sig.fingerprint}`);
		content = sig.signedText;
	}

	const v = verifyStructure(content);
	if (v.generatedAt !== null) console.log(`generated: ${v.generatedAt}`);
	if (v.ageDays !== null) console.log(`age: ${v.ageDays.toFixed(1)} days`);
	for (const w of v.warnings) console.log(`  warn: ${w}`);
	for (const e of v.errors) console.log(`  error: ${e}`);

	if (!v.ok) {
		console.log('canary-verify: FAIL');
		process.exit(1);
	}
	if (structureOnly) {
		console.log('canary-verify: structure OK — the signature was NOT checked (--structure-only)');
		process.exit(3);
	}
	if (v.warnings.length > 0) {
		console.log('canary-verify: OK (with warnings)');
		process.exit(2);
	}
	console.log('canary-verify: OK');
}

// Run-as-main guard: importing this module (e.g. from a smoke that wants
// `parseCanaryTimestamp`) must not execute the CLI. Mirrors the guard the
// llms-full-freshness smoke enforces on scripts/build-llms-full.mjs.
const invokedDirectly =
	process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
	main().catch((err) => {
		console.error('canary-verify: unhandled:', err);
		process.exit(1);
	});
}
