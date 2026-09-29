/**
 * scripts/lib/nginx-conf.ts — a small, dependency-free nginx config parser for
 * smokes that must check what a config DOES (which directive sits in which
 * block), not whether some text appears somewhere in the file.
 *
 * Handles what Morphit's configs use: `#` comments (outside quotes), single-
 * and double-quoted arguments, nested blocks (`http`, `server`, `location`,
 * `map`, `geo`, `if`). Quoted arguments are returned WITHOUT their quotes.
 * It is not a full nginx grammar (no `include` resolution, no lua blocks).
 */

export interface NginxDirective {
	readonly name: string;
	readonly args: readonly string[];
	readonly block: readonly NginxDirective[] | null;
}

function tokenize(text: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i]!;
		if (c === '#') {
			while (i < text.length && text[i] !== '\n') i++;
			continue;
		}
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === '{' || c === '}' || c === ';') {
			out.push(c);
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			let j = i + 1;
			let v = '';
			while (j < text.length && text[j] !== c) {
				if (text[j] === '\\' && j + 1 < text.length) {
					v += text[j + 1];
					j += 2;
					continue;
				}
				v += text[j];
				j++;
			}
			out.push(`\u0000${v}`); // mark "was quoted" so `{` inside quotes is not a brace
			i = j + 1;
			continue;
		}
		let j = i;
		while (j < text.length && !/[\s;{}]/.test(text[j]!) && text[j] !== '#') j++;
		out.push(text.slice(i, j));
		i = j;
	}
	return out;
}

export function parseNginx(text: string): NginxDirective[] {
	const toks = tokenize(text);
	let p = 0;
	const unq = (t: string): string => (t.startsWith('\u0000') ? t.slice(1) : t);
	function block(): NginxDirective[] {
		const list: NginxDirective[] = [];
		while (p < toks.length && toks[p] !== '}') {
			const words: string[] = [];
			while (p < toks.length && toks[p] !== ';' && toks[p] !== '{' && toks[p] !== '}') {
				words.push(unq(toks[p]!));
				p++;
			}
			if (p >= toks.length) break;
			if (toks[p] === ';') {
				p++;
				if (words.length > 0) list.push({ name: words[0]!, args: words.slice(1), block: null });
			} else if (toks[p] === '{') {
				p++;
				const inner = block();
				if (toks[p] === '}') p++;
				list.push({ name: words[0] ?? '', args: words.slice(1), block: inner });
			}
		}
		return list;
	}
	return block();
}

/** All blocks named `name` anywhere in the tree (depth-first). */
export function findBlocks(list: readonly NginxDirective[], name: string): NginxDirective[] {
	const out: NginxDirective[] = [];
	for (const d of list) {
		if (d.name === name && d.block) out.push(d);
		if (d.block) out.push(...findBlocks(d.block, name));
	}
	return out;
}

/** Directives named `name` DIRECTLY inside a block (not nested deeper). */
export function direct(block: readonly NginxDirective[] | null, name: string): NginxDirective[] {
	return (block ?? []).filter((d) => d.name === name && d.block === null);
}

/** `add_header` values directly in a block, keyed by header name (lower-cased). */
export function addHeaders(block: readonly NginxDirective[] | null): Map<string, string> {
	const m = new Map<string, string>();
	for (const d of direct(block, 'add_header'))
		m.set((d.args[0] ?? '').toLowerCase(), d.args[1] ?? '');
	return m;
}

/** Entries of a `map <src> <var> { … }` block: key → value. */
export function mapEntries(
	tree: readonly NginxDirective[],
	variable: string
): Map<string, string> | null {
	const b = findBlocks(tree, 'map').find((d) => d.args[1] === variable);
	if (!b) return null;
	const m = new Map<string, string>();
	for (const d of b.block ?? []) m.set(d.name, d.args[0] ?? '');
	return m;
}
