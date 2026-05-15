#!/usr/bin/env tsx
/**
 * json-str-injection-smoke — regression test for AUDIT-1 (cp17
 * deep-deep): json_str() in ops/scripts/lib/emit.sh must encode
 * all C0 control characters so an attacker can't forge journal
 * entries via newline injection through untrusted-input paths.
 *
 * Attack scenario (the bug this smoke prevents from regressing):
 *
 *   1. Unprivileged user spawns process with `comm` name
 *      containing literal newline + crafted JSON, e.g.
 *      `exec -a $'name\n{"level":"error","module":"...","event":
 *      "all_clear","context":{}}'`.
 *   2. User triggers OOM-kill of that process.
 *   3. Kernel writes OOM message to dmesg with `comm` verbatim.
 *   4. dmesg-monitor reads the line, passes through json_str(),
 *      embeds in payload, pipes through systemd-cat.
 *   5. systemd-cat creates ONE journal entry per stdin line.
 *      Embedded \n splits one logical emit into two journal
 *      lines — the second being attacker-controlled JSON.
 *   6. matrix-bot reads the second line and routes it as a
 *      legitimate alert.
 *
 * The fix encodes \b\t\n\f\r as their short JSON escapes and
 * all other 0x00-0x1F as \uXXXX.  This smoke feeds each known
 * dangerous input through json_str() (via a shell subprocess so
 * we exercise the actual sed pipeline), then validates the
 * output is parseable JSON whose decoded value matches the
 * original input byte-for-byte.
 *
 * This smoke also serves as the test fixture for the original
 * attack: it includes the actual attacker-style payload from
 * the audit report.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(SELF_DIR, '..', '..', '..');
const EMIT_LIB = join(REPO_ROOT, 'ops', 'scripts', 'lib', 'emit.sh');

/**
 * Invoke json_str via a shell subprocess.  We source emit.sh and
 * call the function with the given input on stdin so we exercise
 * the actual sed pipeline that ships to production.
 *
 * The input is passed via stdin (not as an arg) to avoid any
 * shell-quoting ambiguity: arbitrary bytes including newlines
 * and NULs go in raw.  Inside the script, we slurp stdin into a
 * variable and pass to json_str.
 */
function callJsonStr(input: Buffer | string): string {
	const inputBuf = typeof input === 'string' ? Buffer.from(input) : input;
	// Use base64 to round-trip bytes through the shell without
	// any encoding mishap.  The shell script base64-decodes
	// stdin, then calls json_str on the result.
	const b64 = inputBuf.toString('base64');
	const script = `
. "${EMIT_LIB}"
raw=$(printf '%s' '${b64}' | base64 -d; printf x)
raw=\${raw%x}
json_str "$raw"
`;
	const r = spawnSync('sh', ['-c', script], { encoding: 'buffer' });
	if (r.status !== 0) {
		throw new Error(
			`json_str subprocess exited ${r.status}: ${r.stderr.toString()}`
		);
	}
	// sed appends a trailing newline; strip exactly one.
	let out = r.stdout;
	if (out.length > 0 && out[out.length - 1] === 0x0a) {
		out = out.subarray(0, out.length - 1);
	}
	return out.toString('utf-8');
}

interface Scenario {
	readonly name: string;
	readonly input: Buffer | string;
	/** A description of WHY this input is dangerous, surfaced
	 *  in failure messages. */
	readonly threat: string;
	/** If set, expect the encoder to emit this decoded value
	 *  rather than the original input.  Used for cases where the
	 *  bash variable boundary trims bytes before json_str() sees
	 *  them (NUL truncation) — documenting actual behavior rather
	 *  than asserting an impossible round-trip. */
	readonly expectedEncoded?: string;
}

const scenarios: Scenario[] = [
	{
		name: 'plain ASCII (control case)',
		input: 'hello world',
		threat: 'no threat; baseline that encoding leaves clean input alone'
	},
	{
		name: 'backslash + double-quote (original json_str scope)',
		input: 'path\\with"quotes',
		threat: 'these were the only chars the original implementation escaped'
	},
	{
		name: 'embedded newline (THE primary attack vector — AUDIT-1)',
		input:
			'evil-proc\n{"ts":"2026-01-01T00:00:00Z","level":"error",' +
			'"module":"host-resource","event":"disk_critical",' +
			'"context":{"forged":true}}',
		threat:
			'unprivileged user injects forged JSON via process comm name → ' +
			'kernel OOM logs → dmesg → sidecar → systemd-cat splits at \\n → ' +
			'fake alert delivered to operator'
	},
	{
		name: 'embedded tab',
		input: 'col1\tcol2\tcol3',
		threat:
			'tabs are valid in dmesg output but break JSON strings if unencoded'
	},
	{
		name: 'embedded carriage-return',
		input: 'lf-platform\r\nsecond-line',
		threat: 'CRLF from Windows-ish source breaks JSON same as LF'
	},
	{
		name: 'NUL byte (bash variable semantics strip it; documented)',
		input: Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x62, 0x61, 0x72]),
		// bash command substitution drops the NUL byte but
		// PRESERVES the surrounding bytes (bash 4.4+).  Tests show
		// `foo\0bar` becomes `foobar` post-substitution.  The
		// security-relevant property is the other 31 control chars
		// (covered by the next scenario): no JSON injection is
		// possible regardless of NUL handling because the actual
		// attack vector — newline — is properly encoded.
		expectedEncoded: 'foobar',
		threat:
			'NUL bytes are scrubbed at the bash-variable boundary, not by ' +
			'the encoder; documented in emit.sh'
	},
	{
		name: 'all C0 control chars (0x01-0x1F; NUL stripped at bash boundary)',
		// Skip 0x00; bash variable assignment drops it.  Cover all
		// other 31 control characters in one byte-sequence.
		input: Buffer.from(Array.from({ length: 31 }, (_, i) => i + 1)),
		threat:
			'every byte 0x01-0x1F must be escaped; exhaustive coverage check'
	},
	{
		name: 'ESC char (terminal-control escape)',
		input: 'normal\x1b[31mRED\x1b[0m more',
		threat:
			'ANSI escape sequences from process names could enable terminal-injection ' +
			'when an operator views the journal with `journalctl` directly'
	},
	{
		name: 'backslash-then-quote-then-newline (escape-sequence boundary)',
		input: 'tricky\\"\nrest',
		threat:
			'tests that order of operations (backslash FIRST, then others) is correct — ' +
			'wrong order would double-escape the literal backslash'
	},
	{
		name: 'UTF-8 multibyte (must pass through)',
		input: '日本語 Ñoño 🚀',
		threat:
			'no threat; multibyte UTF-8 must pass through unchanged since JSON allows it'
	},
	{
		name: 'invalid UTF-8 byte sequences',
		input: Buffer.from([0x66, 0xff, 0xfe, 0x6f]),
		threat:
			'invalid UTF-8 in raw kernel data shouldn\'t crash the encoder — ' +
			'LC_ALL=C in the sed pipeline operates byte-wise'
	}
];

console.log(`json-str-injection smoke: ${scenarios.length} scenarios\n`);

let failed = 0;
for (const s of scenarios) {
	const inputBuf =
		typeof s.input === 'string' ? Buffer.from(s.input) : s.input;
	let encoded: string;
	try {
		encoded = callJsonStr(s.input);
	} catch (err) {
		console.log(`  ✗ ${s.name}: json_str subprocess FAILED: ${err}`);
		console.log(`    threat: ${s.threat}`);
		failed++;
		continue;
	}

	// Test 1: the encoded result, wrapped in double quotes, must
	// be valid JSON.
	const asJsonString = `"${encoded}"`;
	let decoded: string;
	try {
		decoded = JSON.parse(asJsonString);
	} catch (err) {
		console.log(`  ✗ ${s.name}: encoded output is NOT valid JSON: ${err}`);
		console.log(`    encoded: ${JSON.stringify(encoded)}`);
		console.log(`    threat: ${s.threat}`);
		failed++;
		continue;
	}

	// Test 2: the decoded string must equal the input byte-for-byte
	// (or the documented expectedEncoded if the scenario overrides
	// it, e.g. for bash-variable-boundary NUL truncation).
	const expected = s.expectedEncoded ?? inputBuf.toString('utf-8');
	const decodedBuf = Buffer.from(decoded, 'utf-8');
	const expectedBuf = Buffer.from(expected, 'utf-8');
	if (decodedBuf.equals(expectedBuf)) {
		console.log(`  ✓ ${s.name}: round-trips correctly`);
	} else {
		console.log(
			`  ✗ ${s.name}: round-trip mismatch (encoder mangled the input)`
		);
		console.log(`    input    bytes: ${inputBuf.toString('hex')}`);
		console.log(`    expected bytes: ${expectedBuf.toString('hex')}`);
		console.log(`    got      bytes: ${decodedBuf.toString('hex')}`);
		console.log(`    threat: ${s.threat}`);
		failed++;
	}
}

console.log('');
if (failed === 0) {
	console.log(`✓ all ${scenarios.length} json-str-injection checks hold`);
	process.exit(0);
}
console.error(`✗ ${failed} failed, ${scenarios.length - failed} passed`);
process.exit(1);
