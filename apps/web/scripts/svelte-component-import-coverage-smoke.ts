#!/usr/bin/env tsx
/**
 * svelte-component-import-coverage-smoke.ts
 *
 * Catches the "component referenced in template but never imported"
 * class of bug.
 *
 * THE CLASS
 *
 * In a .svelte file, the template can reference a PascalCase
 * component (e.g. `<MorphitLogoBling heightPx={32} />`).  If the
 * matching `import MorphitLogoBling from '$components/...'` line
 * is missing, the file STILL compiles to source — Svelte treats the
 * tag as an unknown HTML element and emits it literally.  The page
 * renders without the component.  No SSR error.  No console warning
 * until you actually load the page.
 *
 * WHY THIS SMOKE EXISTS (cp115 lesson)
 *
 * The cp115 session compaction left MorphitLogoBling referenced in
 * `apps/web/src/routes/[lang]/+layout.svelte` without its import
 * line.  Resumed-session caught it via grep, but a grep-style
 * structural defense codifies the catch so the same class can't
 * resurface.
 *
 * WHAT IT CHECKS
 *
 * For every .svelte file under apps/web/src/:
 *   1. Find every PascalCase tag in the template (matching the
 *      Svelte convention: component tags start with a capital
 *      letter; HTML elements are all lowercase).
 *   2. For each PascalCase tag, verify the file's <script> block
 *      contains an `import <TagName>` line.
 *
 * EXCLUSIONS
 *
 * Svelte built-in special elements (`<svelte:head>`, `<svelte:body>`,
 * `<svelte:window>`, `<svelte:component>`, `<svelte:self>`, etc.)
 * are not PascalCase by the rule; they use the `svelte:` namespace
 * prefix and are skipped by the tag-extraction regex.
 *
 * Components from `<slot>` or dynamic `<svelte:component this={X}>`
 * with `this={...}` form are fine — the X is a JS variable, not a
 * tag.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const WEB_SRC = resolve(REPO, 'apps/web/src');

function walk(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry === '.svelte-kit') continue;
			walk(full, acc);
		} else if (entry.endsWith('.svelte')) {
			acc.push(full);
		}
	}
	return acc;
}

const files = walk(WEB_SRC);

let failed = 0;
let passed = 0;
let totalChecked = 0;

console.log('\n── svelte-component-import-coverage smoke (cp115) ───────\n');

for (const file of files) {
	const src = readFileSync(file, 'utf8');

	// Split into script block(s) and the rest (template).  Components
	// are imported in <script>, used in template.  Inline svelte tags
	// inside <script lang="ts"> blocks don't count (strings, comments).
	const scriptMatch = src.match(/<script[\s\S]*?<\/script>/g) ?? [];
	const scriptBlob = scriptMatch.join('\n');
	// Remove all script blocks from the source to get just the template + style.
	let template = src;
	for (const s of scriptMatch) template = template.replace(s, '');

	// Strip HTML comments from the template — module-doc comments at
	// the top of a component file often include example usage like
	// `<MyComponent prop={...} />` which is illustrative, not a real
	// reference.  Counting those as real tags would cause every
	// self-documenting component to fail the smoke against itself.
	template = template.replace(/<!--[\s\S]*?-->/g, '');

	// Pull every PascalCase opening tag from the template.
	//   <Foo …>  or  <Foo />
	// Excludes  <svelte:…> by the `[A-Z]` first-char filter (it's lowercase 's').
	const tagRe = /<([A-Z][A-Za-z0-9_]*)\b/g;
	const referenced = new Set<string>();
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(template)) !== null) {
		referenced.add(m[1]!);
	}

	if (referenced.size === 0) continue;
	totalChecked++;

	// For each referenced component, check the script blob has an
	// `import <Name>` line.  Accept:
	//   - default import:           `import X from '…'`
	//   - named import:             `import { X } from '…'`
	//   - type-only named import:   `import type { X } from '…'`
	//     (Svelte 5 idiom for dynamic <Component> slots)
	//   - aliased import:           `import { Y as X } from '…'`
	// Also accept `let X` / `const X` declarations in the script
	// (covers cases where the PascalCase identifier is a local
	// destructure or dynamic component-class binding).
	const missing: string[] = [];
	for (const name of referenced) {
		const escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const reDefault = new RegExp(`\\bimport\\s+${escName}\\s+from\\s+['"]`);
		const reNamed = new RegExp(
			`\\bimport\\s+(?:type\\s+)?\\{[^}]*\\b${escName}\\b[^}]*\\}\\s+from\\s+['"]`
		);
		const reAliased = new RegExp(
			`\\bimport\\s+(?:type\\s+)?\\{[^}]*\\bas\\s+${escName}\\b[^}]*\\}\\s+from\\s+['"]`
		);
		const reLocal = new RegExp(`\\b(?:let|const|var)\\s+${escName}\\b`);
		if (
			!reDefault.test(scriptBlob) &&
			!reNamed.test(scriptBlob) &&
			!reAliased.test(scriptBlob) &&
			!reLocal.test(scriptBlob)
		) {
			missing.push(name);
		}
	}

	const rel = file.replace(REPO + '/', '');
	if (missing.length === 0) {
		passed++;
	} else {
		failed++;
		console.log(`  ✗ ${rel}`);
		for (const name of missing) {
			console.log(`      <${name}> referenced in template but never imported`);
		}
	}
}

console.log('');
console.log('──────────────────────────────────────────────────────');
console.log(`Checked ${totalChecked} .svelte files with PascalCase tags.`);
if (failed === 0) {
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failed}/${passed + failed} files had unimported component references`);
process.exit(1);
