/**
 * Every local probe that pins a name to 127.0.0.1 with `curl --resolve` must
 * also pass `--noproxy '*'`: with https_proxy / ALL_PROXY in root's
 * environment curl ignores --resolve and sends the probe through the proxy
 * (review A-F10). Checked on the parsed source: each function that hands curl
 * a '--resolve' also hands it '--noproxy'.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
function files(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? files(p) : n.endsWith('.ts') ? [p] : [];
	});
}

describe('curl --resolve never goes through a proxy', () => {
	it('every function passing --resolve also passes --noproxy', () => {
		const bad: string[] = [];
		for (const f of files(SRC)) {
			const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
			const visit = (n: ts.Node): void => {
				if (ts.isStringLiteral(n) && n.text === '--resolve') {
					let fn: ts.Node | undefined = n.parent;
					while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
					const body = (fn ?? sf).getText(sf);
					if (!/'--noproxy'/.test(body)) {
						const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
						bad.push(`${f.slice(SRC.length + 1)}:${line + 1}`);
					}
				}
				ts.forEachChild(n, visit);
			};
			visit(sf);
		}
		expect(bad).toEqual([]);
	});
});
