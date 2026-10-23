/**
 * No indexer test imports a module from apps/web (v1.21.14 review).
 *
 * The web tsconfig extends `.svelte-kit/tsconfig.json`, a file `svelte-kit
 * sync` or a build generates. A fresh checkout — CI's smoke job, a clean
 * battery copy — has none until web-build-smoke has run, and vitest then fails
 * to transform any web module an indexer test imports. That is what made
 * vitest-must-pass fail on every clean tree (the stream-ticket interop tests,
 * now in apps/web/src/lib/chat/streamTicketInterop.test.ts), and it was put
 * down to load twice. A test that needs both sides lives in apps/web, which
 * resolves its own config.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname);

function files(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) files(p, out);
		else if (/\.ts$/.test(name)) out.push(p);
	}
	return out;
}

/** Module specifiers in `import … from '…'`, `import('…')` and `vi.mock('…')`. */
function specifiers(src: string): string[] {
	const out: string[] = [];
	const re = /(?:from\s+|import\s*\(\s*|vi\.mock\s*\(\s*)['"]([^'"]+)['"]/g;
	for (let m = re.exec(src); m !== null; m = re.exec(src)) out.push(m[1] as string);
	return out;
}

describe('indexer tests import nothing from apps/web', () => {
	it('no module specifier reaches into the web workspace', () => {
		const offenders: string[] = [];
		for (const f of files(ROOT)) {
			if (f.endsWith('noWebSourceImports.test.ts')) continue; // its own control string
			for (const s of specifiers(readFileSync(f, 'utf8')))
				if (/(^|\/)web\/src\//.test(s)) offenders.push(`${f.slice(ROOT.length + 1)}: ${s}`);
		}
		expect(offenders).toEqual([]);
	});
	it('the scan sees a dynamic import (control)', () => {
		expect(specifiers("await import('../../../web/src/lib/chat/x.ts')")).toEqual([
			'../../../web/src/lib/chat/x.ts'
		]);
	});
});
