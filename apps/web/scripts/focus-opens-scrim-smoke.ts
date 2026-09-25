#!/usr/bin/env tsx
/**
 * apps/web/scripts/focus-opens-scrim-smoke.ts  (the maintainer — Settings page blurred on load)
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * `LanguageFilterSelect` opened its dropdown from a bare `onfocus`, and that
 * dropdown paints a VIEWPORT-COVERING blur scrim (`fixed inset-0 …
 * backdrop-blur-sm`, z-20) behind its listbox. Firefox restores focus to the
 * previously-focused element when a page is reloaded. So once that language
 * field had been focused in a tab, EVERY subsequent load re-fired `onfocus`,
 * re-opened the dropdown, and blurred the whole page before the user touched
 * anything. The sticky page header sits at z-40, so the header stayed sharp
 * while everything beneath it blurred — which is what made it look like a
 * rendering or a browser bug rather than ours. Clicking anywhere hit the
 * scrim's close handler and the page snapped sharp.
 *
 * Confirmed by the maintainer from the opposite direction: a Firefox private window, which
 * has no saved focus state to restore, renders the page perfectly.
 *
 * Focus is NOT an expression of user intent. It happens on reload restoration,
 * on programmatic `.focus()`, and on tab-through. Anything that paints over the
 * whole viewport must wait for a real gesture: pointerdown, typing, or ArrowDown.
 *
 * WHY THIS GUARD IS EXECUTED, NOT GREPPED
 * ---------------------------------------
 * When this was first fixed, the sibling components were hand-checked with an
 * exact-string grep and declared clean. They were not:
 *   - `PaymentFilterSelect` had the same bug across several lines, so the
 *     single-line pattern missed it.
 *   - `FiatCurrencySelect` had it behind a NAMED FUNCTION (`onfocus={onFocus}`,
 *     and `onFocus()` sets `open = true`), so no pattern matching the handler
 *     ATTRIBUTE could ever have seen it.
 * A text search sees the shape it was told to look for. So this guard does not
 * match text: it locates each viewport-covering scrim, works out which piece of
 * component state gates it, then EXECUTES each focus handler's real body — the
 * inline one, or the named function it points at — inside a recording sandbox
 * and observes which state that execution actually sets. A handler is a failure
 * if running it turns on a variable that gates a scrim, whatever it looks like.
 *
 * A handler whose body cannot be executed is a FAILURE, never a silent pass
 * (see J-1: silent zero counting). If this guard cannot see, it says so.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const SRC = resolve(WEB, 'src');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  ✓ ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  ✗ ${m}`);
	if (d) console.log(`      ${d}`);
};

function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		const p = resolve(dir, e);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (e.endsWith('.svelte')) out.push(p);
	}
	return out;
}

/** Scan forward from `i` and return the index just past the balanced closer. */
function matchDelim(s: string, i: number, open: string, close: string): number {
	let depth = 0;
	for (let j = i; j < s.length; j++) {
		const c = s[j];
		if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return j + 1;
		}
	}
	return -1;
}

/**
 * The scrim signature: an element that covers the whole viewport AND blurs what
 * is behind it. `fixed inset-0` alone is a positioned overlay (a modal's dim
 * layer, a drag target); it is the `backdrop-blur` that makes an accidental
 * open look like the page itself broke.
 */
const SCRIM = /class="[^"]*fixed inset-0[^"]*backdrop-blur[^"]*"/;

/**
 * Iterate `{#if COND}…{/if}` blocks, returning each condition with its body.
 * Depth-aware, so a nested `{#if}` does not truncate its parent's body.
 */
function ifBlocks(src: string): { cond: string; body: string; at: number }[] {
	const out: { cond: string; body: string; at: number }[] = [];
	for (const m of src.matchAll(/\{#if\s+/g)) {
		const condStart = m.index! + m[0].length;
		const condEnd = src.indexOf('}', condStart);
		if (condEnd < 0) continue;
		let depth = 1;
		const re = /\{#if\b|\{\/if\}/g;
		re.lastIndex = condEnd + 1;
		let bodyEnd = src.length;
		let mm: RegExpExecArray | null;
		while ((mm = re.exec(src))) {
			if (mm[0] === '{/if}') {
				depth--;
				if (depth === 0) {
					bodyEnd = mm.index;
					break;
				}
			} else depth++;
		}
		out.push({
			cond: src.slice(condStart, condEnd),
			body: src.slice(condEnd + 1, bodyEnd),
			at: m.index!
		});
	}
	return out;
}

/** Identifiers referenced by a `{#if …}` condition. */
function idsIn(expr: string): string[] {
	const out = new Set<string>();
	for (const m of expr.matchAll(/[A-Za-z_$][\w$]*/g)) {
		const w = m[0];
		if (!['true', 'false', 'null', 'undefined', 'typeof', 'in'].includes(w)) out.add(w);
	}
	return [...out];
}

/**
 * Which state gates a viewport-covering scrim in this component?
 *
 * Two ways a focus event can end up painting over the page:
 *   (a) DIRECTLY — the component owns the scrim behind its own `{#if}`, as the
 *       three orderbook selects do.
 *   (b) ACROSS THE COMPONENT BOUNDARY — the component MOUNTS a child that paints
 *       a scrim the moment it exists (every modal in this tree renders its scrim
 *       ungated, because the parent's `{#if}` is the gate). Turning that
 *       condition on from a focus handler blurs the page exactly the same way,
 *       and a guard that only looked inside one file would never see it.
 *
 * `mountPaints` carries the names of (b)-style children, collected in a first
 * pass over the whole tree.
 */
function scrimGates(src: string, mountPaints: ReadonlySet<string>): string[] {
	const gates = new Set<string>();
	for (const blk of ifBlocks(src)) {
		let paints = SCRIM.test(blk.body);
		if (!paints) {
			for (const name of mountPaints) {
				if (new RegExp(`<${name}[\\s/>]`).test(blk.body)) {
					paints = true;
					break;
				}
			}
		}
		if (paints) for (const id of idsIn(blk.cond)) gates.add(id);
	}
	return [...gates];
}

/**
 * Components whose scrim is NOT behind any `{#if}` — merely rendering them
 * paints over the viewport, so their MOUNT is the thing that must not be
 * triggered by focus.
 */
function paintsOnMount(src: string): boolean {
	if (!SCRIM.test(src)) return false;
	return !ifBlocks(src).some((b) => SCRIM.test(b.body));
}

/** Every `onfocus=`/`onfocusin=` handler expression in the markup. */
function focusHandlers(src: string): { attr: string; expr: string; line: number }[] {
	const out: { attr: string; expr: string; line: number }[] = [];
	for (const m of src.matchAll(/on(focus|focusin)=\{/g)) {
		const braceAt = m.index! + m[0].length - 1;
		const end = matchDelim(src, braceAt, '{', '}');
		if (end < 0) continue;
		out.push({
			attr: `on${m[1]}`,
			expr: src.slice(braceAt + 1, end - 1).trim(),
			line: src.slice(0, m.index!).split('\n').length
		});
	}
	return out;
}

/** Resolve a handler expression to executable statements. */
function resolveBody(expr: string, src: string): { body: string; via: string } | null {
	// Inline arrow: () => (X = true)   |   () => { … }   |   (e) => …
	const arrow = expr.match(/^\([^)]*\)\s*=>\s*([\s\S]+)$/);
	if (arrow) {
		let b = arrow[1].trim();
		if (b.startsWith('{')) b = b.slice(1, -1);
		else if (b.startsWith('(')) b = b.slice(1, b.endsWith(')') ? -1 : undefined);
		return { body: b, via: 'inline arrow' };
	}
	// Bare identifier: onfocus={onFocus} — resolve the named function.
	if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
		const fn = src.match(
			new RegExp(`function\\s+${expr}\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+)?\\s*\\{`)
		);
		if (fn) {
			const braceAt = src.indexOf('{', fn.index! + fn[0].length - 1);
			const end = matchDelim(src, braceAt, '{', '}');
			if (end > 0) return { body: src.slice(braceAt + 1, end - 1), via: `function ${expr}()` };
		}
		const konst = src.match(
			new RegExp(`(?:const|let)\\s+${expr}\\s*(?::\\s*[^=]+)?=\\s*\\([^)]*\\)\\s*=>\\s*`)
		);
		if (konst) {
			const after = src.slice(konst.index! + konst[0].length);
			if (after.startsWith('{')) {
				const end = matchDelim(after, 0, '{', '}');
				if (end > 0) return { body: after.slice(1, end - 1), via: `const ${expr} = () =>` };
			}
			const semi = after.indexOf(';');
			return { body: after.slice(0, semi < 0 ? after.length : semi), via: `const ${expr} = () =>` };
		}
		return null;
	}
	return null;
}

/**
 * EXECUTE the handler body and record which state it sets truthy.
 * Free identifiers resolve against a recording Proxy; unknown calls are no-ops,
 * so `void ensureLoaded()` runs harmlessly while `open = true` is observed.
 */
function stateSetTrue(body: string): { set: string[] } | { error: string } {
	const assigned = new Set<string>();
	const noop = function () {
		return undefined;
	};
	const store: Record<string, unknown> = {};
	const sandbox = new Proxy(store, {
		has: () => true,
		get: (t, k: string) => {
			if (k === (Symbol.unscopables as unknown as string)) return undefined;
			if (k in t) return t[k];
			return noop;
		},
		set: (t, k: string, v) => {
			t[k] = v;
			if (v === true) assigned.add(k);
			return true;
		}
	});
	// Strip TS type annotations that `new Function` would reject.
	const js = body.replace(/:\s*(?:Promise<[^>]*>|[A-Za-z_$][\w$.<>[\]| ]*)(?=\s*[=,)])/g, '');
	try {
		// Non-strict body: `with` + a has-trapping Proxy captures every free name.
		const fn = new Function('S', `with (S) { ${js} }`);
		fn(sandbox);
	} catch (e) {
		return { error: (e as Error).message };
	}
	return { set: [...assigned] };
}

console.log('focus-opens-scrim — a focus event must never paint over the viewport');
console.log('');

const files = walk(SRC).sort();
const source = new Map<string, string>();
for (const abs of files) source.set(abs, stripComments(readFileSync(abs, 'utf8')));

// Pass 1 — which components paint the moment they are mounted?
const mountPaints = new Set<string>();
for (const [abs, src] of source) {
	if (paintsOnMount(src))
		mountPaints.add(
			abs
				.split('/')
				.pop()!
				.replace(/\.svelte$/, '')
		);
}
console.log(`  mount-paints-scrim components: ${[...mountPaints].sort().join(', ') || '(none)'}`);
console.log('');

let inspected = 0;
let withScrim = 0;

// Pass 2 — execute every focus handler that lives where a scrim can be reached.
for (const abs of files) {
	const rel = relative(WEB, abs);
	const src = source.get(abs)!;
	const gates = scrimGates(src, mountPaints);
	if (gates.length === 0) continue;
	withScrim++;
	const handlers = focusHandlers(src);
	if (handlers.length === 0) continue;

	for (const h of handlers) {
		inspected++;
		const resolved = resolveBody(h.expr, src);
		if (!resolved) {
			bad(
				`${rel}:${h.line} — ${h.attr} handler could not be resolved to a body; this guard must be able to read it`,
				h.expr.slice(0, 80)
			);
			continue;
		}
		const run = stateSetTrue(resolved.body);
		if ('error' in run) {
			bad(
				`${rel}:${h.line} — ${h.attr} body (${resolved.via}) could not be executed: ${run.error}`,
				resolved.body.slice(0, 120)
			);
			continue;
		}
		const hits = run.set.filter((v) => gates.includes(v));
		if (hits.length) {
			bad(
				`${rel}:${h.line} — ${h.attr} (${resolved.via}) sets ${hits
					.map((x) => `\`${x}\``)
					.join(', ')}, which gates a full-viewport blur scrim. ` +
					`Focus fires on reload restoration and tab-through, so this blurs the page unprompted. ` +
					`Open on pointerdown / typing / ArrowDown instead.`,
				resolved.body.trim().replace(/\s+/g, ' ').slice(0, 120)
			);
		} else {
			ok(
				`${rel}:${h.line} — ${h.attr} (${resolved.via}) sets nothing that gates a scrim` +
					(run.set.length ? ` (sets ${run.set.map((x) => `\`${x}\``).join(', ')})` : '')
			);
		}
	}
}

// A guard that inspects nothing passes vacuously. Pin the population so that
// deleting the scrims — or renaming the handlers out from under this — fails
// here rather than quietly reducing the guard to a no-op.
if (mountPaints.size >= 10)
	ok(`found ${mountPaints.size} components that paint a full-viewport scrim on mount`);
else
	bad(
		`expected at least 10 mount-paints-scrim components, found ${mountPaints.size} — ` +
			`the cross-component half of this guard has gone blind`
	);

if (withScrim >= 6)
	ok(`swept ${withScrim} components where a focus event can reach a full-viewport scrim`);
else bad(`expected at least 6 scrim-reachable components, found ${withScrim}`);

if (inspected >= 7) ok(`executed ${inspected} focus handlers in those components`);
else bad(`expected at least 7 focus handlers to execute, executed ${inspected}`);

console.log('');
console.log('─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} focus-opens-scrim scenarios passed`);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
