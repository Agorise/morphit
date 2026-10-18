/**
 * No patch leftovers (`*.orig`, `*.rej`) in the tree
 * that ships (the offline bundle and the release tarball exclude neither).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '../../..');
const SKIP = new Set(['node_modules', '.git', 'dist', '.svelte-kit', 'private']);

function leftovers(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(e.name)) continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) leftovers(p, out);
		else if (/\.(orig|rej)$/.test(e.name)) out.push(p.slice(REPO.length + 1));
	}
	return out;
}

describe('tree hygiene', () => {
	it('no *.orig or *.rej files', () => {
		expect(leftovers(REPO)).toEqual([]);
	});
});
