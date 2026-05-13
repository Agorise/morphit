/**
 * Static-analysis smoke: duplicate-import detector.
 *
 * Catches the pattern where two or more identical `import { X }
 * from 'foo'` lines appear in the same file.  These are usually
 * artifacts of merge conflicts or copy-paste edits that survived
 * review because:
 *   - bundlers (Vite/esbuild/tsc) accept duplicate imports
 *     without error and dedupe them at build time.
 *   - linters that catch this aren't always wired into smokes.
 *
 * Why it matters: duplicate imports add bundle bytes (tiny) but
 * are a strong signal that someone hand-edited an import block
 * and left a mess.  The audit found three instances of this in
 * the codebase (BATCH19B caught two; BATCH19D-pass-d caught
 * three more in +layout.svelte, ConversationView.svelte, and
 * release-validator-smoke.ts) — and one of those was in the
 * highest-traffic file in the entire app (the root layout).
 *
 * Output: exit-code-0 if no dups; exit-code-1 + concrete
 * findings on any hit.  Each scanned file counts as one
 * scenario in the runner protocol.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Script is at apps/indexer/scripts/, repo root is 3 up.
const REPO = join(__dirname, '..', '..', '..');

const SCAN_ROOTS = [
	'apps/web/src',
	'apps/indexer/src',
	'apps/indexer/scripts',
	'apps/relay/src',
	'apps/ops-cli/src',
	'apps/avatar/src',
	'apps/payment-watcher/src',
	'packages'
];

const IMPORT_RE = /^(\s*import\s+[^\n]+from\s+['"][^'"]+['"];?)/gm;

interface Finding {
	file: string;
	count: number;
	importLine: string;
}

async function* walk(dir: string): AsyncGenerator<string> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (
				e.name === 'node_modules' ||
				e.name === '.svelte-kit' ||
				e.name === '.git' ||
				e.name === 'dist' ||
				e.name === 'build'
			)
				continue;
			yield* walk(full);
		} else if (e.isFile()) {
			if (
				full.endsWith('.ts') ||
				full.endsWith('.svelte') ||
				full.endsWith('.tsx') ||
				full.endsWith('.js') ||
				full.endsWith('.mjs')
			)
				yield full;
		}
	}
}

async function main(): Promise<void> {
	const findings: Finding[] = [];
	let scanned = 0;

	for (const root of SCAN_ROOTS) {
		for await (const file of walk(join(REPO, root))) {
			scanned++;
			let src;
			try {
				src = await readFile(file, 'utf8');
			} catch {
				continue;
			}
			const counts = new Map<string, number>();
			for (const m of src.matchAll(IMPORT_RE)) {
				const line = (m[1] ?? '').trim();
				counts.set(line, (counts.get(line) ?? 0) + 1);
			}
			for (const [line, c] of counts) {
				if (c > 1) {
					findings.push({
						file: file.replace(REPO, ''),
						count: c,
						importLine: line.slice(0, 100)
					});
				}
			}
		}
	}

	console.log(`Scanned ${scanned} source files.`);
	if (findings.length > 0) {
		console.error(`\nFAIL: ${findings.length} duplicate-import finding(s):\n`);
		for (const f of findings) {
			console.error(`  ${f.file}: ${f.count}× ${f.importLine}`);
		}
		console.error(
			"\nDelete the extra copies. Bundlers tolerate dups but they're " +
				'almost always merge / copy-paste artifacts.\n'
		);
		process.exit(1);
	}
	console.log(`OK: 0 duplicate-import findings across ${scanned} files.`);
	console.log(`✓ all ${scanned} scenarios passed`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
