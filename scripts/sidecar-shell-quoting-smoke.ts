#!/usr/bin/env tsx
/**
 * scripts/sidecar-shell-quoting-smoke.ts
 *
 * Structural Defense #33 — sidecar shell-quoting static scanner
 * (cp83-O29 candidate, shipped cp84).
 *
 * Catches the class of bug that produced cp83-D23a (fail2ban
 * monitor emitting malformed JSON envelopes):
 *
 *   - A function-call command line ending in `\` (continuation)
 *   - Followed by a continuation line containing
 *     `'<literal>'$(<command substitution>)` — i.e. a closed
 *     single-quoted literal immediately concatenated with an
 *     UNQUOTED command substitution.
 *   - Per POSIX, the unquoted substitution undergoes word-
 *     splitting on `$IFS` (default: space, tab, newline) when
 *     it sits in a function-argument context.  The captured
 *     output gets split, and only the first token reaches the
 *     function — the rest become extra positional args that the
 *     function ignores.  The trailing single-quoted closing
 *     literal then glues to whichever positional arg expanded
 *     last, producing visible JSON truncation.
 *   - The fix is always: wrap the whole payload in double quotes
 *     so the substitution stays in quoted context (POSIX
 *     guarantees no word-splitting inside `"..."`).
 *
 * POSIX assignment-context exception: command substitution
 * inside a variable assignment (`payload='...'$(sub)'...'`)
 * is NOT word-split — POSIX explicitly carves it out.  The
 * smoke recognizes this case via the line's first token and
 * skips it.
 *
 * Scope: every shell script under `ops/scripts/*.sh` (sidecar
 * monitor scripts) AND `ops/backup/*.sh` (the cp131-rewritten
 * backup script, plus any future ops shell scripts).  Each file
 * is one scenario; the file passes iff zero unsafe patterns are
 * found.  cp131 widened scope from `ops/scripts/` only — the
 * narrow scope was a HIGH-002-class scope-too-narrow risk:
 * `morphit-backup.sh` (cp131 HIGH-001 rewrite) is also a
 * function-call-heavy shell script and belongs in the gate.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** Directories to scan for *.sh files.  cp131 added ops/backup
 *  to cover the new morphit-backup.sh.  When adding a new ops
 *  shell-script directory, ADD IT HERE — leaving the smoke
 *  unaware of a new script directory is the HIGH-002 class. */
const SHELL_SCRIPT_DIRS = [
	join(REPO, 'ops/scripts'),
	join(REPO, 'ops/backup')
];

const SHELL_FILES: string[] = [];
for (const dir of SHELL_SCRIPT_DIRS) {
	if (!existsSync(dir)) {
		// cp131 fail-loudly: stale scan dir is silent drift.
		console.error(`✗ stale SHELL_SCRIPT_DIR: '${dir}' does not exist`);
		process.exit(1);
	}
	for (const f of readdirSync(dir)) {
		if (f.endsWith('.sh')) SHELL_FILES.push(join(dir, f));
	}
}

console.log('\n── sidecar shell-quoting static smoke ───────────────────\n');
console.log(`  sidecar files: ${SHELL_FILES.length}`);

interface Finding {
	file: string;
	line: number;
	startCmdLine: number;
	excerpt: string;
}

const findings: Finding[] = [];

// Trim a line, treating the rest of comment-after-code as
// not-part-of-the-pattern.  Sidecars use `# ...` for trailing
// comments; the unsafe pattern lives in the executable portion.
function stripTrailingComment(s: string): string {
	// Walk and detect comment start (not inside quotes).
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === '#' && !inSingle && !inDouble) {
			// Comment starts here if preceded by whitespace or BOL
			if (i === 0 || /\s/.test(s[i - 1]!)) {
				return s.slice(0, i);
			}
		}
	}
	return s;
}

function isAssignmentLine(line: string): boolean {
	const trimmed = line.trimStart();
	// POSIX simple-command assignment: <NAME>=value (no command before).
	// We require NAME to match the standard variable-name shape so
	// awk-style `count=NR' (which is an awk argument, not a shell
	// assignment) doesn't false-positive.  But the awk case would be
	// inside quotes anyway, so it's belt-and-braces.
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed);
}

for (const filePath of SHELL_FILES) {
	const text = readFileSync(filePath, 'utf8');
	const lines = text.split('\n');
	const rel = filePath.replace(REPO + '/', '');

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		const code = stripTrailingComment(raw);
		if (!code.trim()) continue;

		// Pattern detection: a closed single-quoted literal
		// immediately followed by an unquoted command substitution.
		// `'$(` is the strict canonical form; we also catch the
		// equivalent split-quote variant `'\\$(` should it appear
		// (unusual but possible in escaped quoted contexts).
		const UNSAFE_RE = /'\s*\$\(/;
		if (!UNSAFE_RE.test(code)) continue;

		// Find the start of the logical command (i.e. walk back
		// through line-continuation chains).
		let cmdLine = i;
		while (cmdLine > 0) {
			const prev = stripTrailingComment(lines[cmdLine - 1]!);
			if (prev.trimEnd().endsWith('\\')) {
				cmdLine--;
			} else {
				break;
			}
		}

		// Determine whether the logical command is an assignment
		// (POSIX-safe) or a function/command call (vulnerable).
		if (isAssignmentLine(lines[cmdLine]!)) continue;

		// Also exempt cases where the WHOLE pattern occurs inside
		// double quotes — those are safe because `"..."` blocks
		// word-splitting.  Detect: walk forward through the code
		// portion, tracking double-quote state; if `'$(` lands
		// inside `"..."`, it's safe.
		let inDouble = false;
		let inSingle = false;
		let unsafeFound = false;
		for (let k = 0; k < code.length - 1; k++) {
			const ch = code[k];
			const next = code[k + 1];
			if (ch === '\\' && k + 1 < code.length) {
				// Escape sequence — skip the next char
				k++;
				continue;
			}
			if (ch === '"' && !inSingle) inDouble = !inDouble;
			else if (ch === "'" && !inDouble) inSingle = !inSingle;
			if (ch === "'" && next === '$') {
				// Look ahead: is it `'$(` and OUTSIDE double quotes?
				// (We toggled inSingle just above to close; that's
				// why we check the post-toggle state of inDouble.)
				if (k + 2 < code.length && code[k + 2] === '(' && !inDouble) {
					unsafeFound = true;
					break;
				}
			}
		}

		if (unsafeFound) {
			findings.push({
				file: rel,
				line: i + 1,
				startCmdLine: cmdLine + 1,
				excerpt: raw.trim().slice(0, 100)
			});
		}
	}
}

console.log(`  scenarios checked: ${SHELL_FILES.length}`);

if (findings.length > 0) {
	console.log(`\n  ✗ ${findings.length} unsafe-quoting site(s):`);
	for (const f of findings) {
		const cmdNote =
			f.startCmdLine !== f.line
				? ` (continuation of command starting at line ${f.startCmdLine})`
				: '';
		console.log(`    - ${f.file}:${f.line}${cmdNote}`);
		console.log(`        ${f.excerpt}`);
	}
	console.log(
		`\n  Fix: wrap the entire payload literal in double quotes so the\n` +
			`  command substitution stays in quoted context.  See cp83-D23a\n` +
			`  in TARBALL.md for the canonical repair pattern.`
	);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${findings.length}/${SHELL_FILES.length} scenarios failed`);
	process.exit(1);
}

console.log(`  ✓ all ${SHELL_FILES.length} sidecars use quoted command-substitution context`);
console.log('\n──────────────────────────────────────────────────────');
console.log(`✓ all ${SHELL_FILES.length} scenarios passed`);
