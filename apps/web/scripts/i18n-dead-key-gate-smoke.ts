#!/usr/bin/env tsx
/**
 * i18n-dead-key-gate-smoke (cp419).
 *
 * Fails CI if any i18n key is defined in the locale files but referenced
 * NOWHERE in the app source — dead weight that bloats every locale bundle.
 *
 * Why AST, not grep: keys are referenced in shapes a text search can't resolve
 * reliably — held in data structures (`{ key: 'nav.orderbook' }` then
 * `$_(item.key)`), built by template (`t(\`faq.entries.${k}.q\`)`) or
 * concatenation (`$_('assets.' + t + '.price_subline.' + s)`), and inside
 * .svelte markup expressions. Earlier grep detectors false-flagged live keys
 * (e.g. nav.orderbook, the whole faq.entries.* cluster) — which is the
 * dangerous failure for a gate (it would either block CI on a real key or lure
 * someone into deleting one). This gate instead parses every .ts with the
 * TypeScript compiler and compiles every .svelte with the Svelte compiler, then
 * extracts EVERY string literal + EVERY template/concat (prefix,suffix) pair
 * from the resulting JS. A key is "referenced" if its full path is a literal OR
 * it matches a (prefix,suffix). This resolves all the shapes above, so a live
 * key is never flagged dead.
 *
 * The gate DETECTS ONLY — it never edits locales. Removal stays a deliberate,
 * verified human step.
 *
 * DYNAMIC_ALLOWLIST is an escape hatch for the (currently empty) theoretical
 * case of a key assembled purely from runtime values with no literal part
 * anywhere. Add to it with a comment rather than letting a real key get removed.
 *
 * Usage: tsx apps/web/scripts/i18n-dead-key-gate-smoke.ts
 */
import ts from 'typescript';
import { compile } from 'svelte/compiler';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const SRC = join(WEB, 'src');
const SEP = '\u0000';

// ── extraction ────────────────────────────────────────────────────────────
function extractFromJs(code: string, staticLits: Set<string>, dynPairs: Set<string>): void {
	let sf: ts.SourceFile;
	try {
		sf = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	} catch {
		return;
	}
	function flattenPlus(node: ts.Node, out: ts.Node[]): void {
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			flattenPlus(node.left, out);
			flattenPlus(node.right, out);
		} else out.push(node);
	}
	function visit(node: ts.Node): void {
		if (ts.isStringLiteralLike(node) && !ts.isTemplateExpression(node)) {
			staticLits.add((node as ts.StringLiteralLike).text);
		}
		if (ts.isTemplateExpression(node)) {
			const prefix = node.head.text;
			const suffix = node.templateSpans[node.templateSpans.length - 1]!.literal.text;
			if (/[._]/.test(prefix + suffix)) dynPairs.add(prefix + SEP + suffix);
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			const ops: ts.Node[] = [];
			flattenPlus(node, ops);
			const first = ops[0]!;
			const last = ops[ops.length - 1]!;
			const prefix = ts.isStringLiteral(first) ? first.text : '';
			const suffix = ts.isStringLiteral(last) ? last.text : '';
			if ((prefix || suffix) && /[._]/.test(prefix + suffix)) dynPairs.add(prefix + SEP + suffix);
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);
}

let svelteCompileFailures = 0;
function extractFromSvelte(source: string, staticLits: Set<string>, dynPairs: Set<string>): void {
	try {
		const { js } = compile(source, { generate: 'client', dev: false });
		extractFromJs(js.code, staticLits, dynPairs);
	} catch {
		// Fallback: pull the <script> blocks and TS-parse them, and scan the whole
		// file so template-expression string literals are still captured.
		svelteCompileFailures++;
		for (const m of source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
			extractFromJs(m[1] ?? '', staticLits, dynPairs);
		}
		extractFromJs(source, staticLits, dynPairs);
	}
}

// ── walk the source tree ────────────────────────────────────────────────────
function walk(dir: string, files: string[]): void {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name.startsWith('.')) continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, files);
		else if (['.ts', '.svelte'].includes(extname(p)) && !p.endsWith('.d.ts')) files.push(p);
	}
}

const staticLits = new Set<string>();
const dynPairs = new Set<string>();
const files: string[] = [];
walk(SRC, files);
for (const f of files) {
	const src = readFileSync(f, 'utf8');
	if (f.endsWith('.svelte')) extractFromSvelte(src, staticLits, dynPairs);
	else extractFromJs(src, staticLits, dynPairs);
}

// ── locale leaves ────────────────────────────────────────────────────────────
const en = JSON.parse(readFileSync(join(SRC, 'lib/i18n/locales/en.json'), 'utf8')) as Record<string, unknown>;
const leaves: string[] = [];
(function flat(o: unknown, p: string): void {
	if (o && typeof o === 'object' && !Array.isArray(o)) {
		for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k);
	} else leaves.push(p);
})(en, '');

const dynArr = [...dynPairs].map((s) => s.split(SEP) as [string, string]);
const DYNAMIC_ALLOWLIST = new Set<string>([
	// (empty) keys assembled purely from runtime values with no literal fragment.
]);
function referenced(key: string): boolean {
	if (staticLits.has(key) || DYNAMIC_ALLOWLIST.has(key)) return true;
	for (const [pfx, sfx] of dynArr) {
		if ((pfx || sfx) && key.startsWith(pfx) && key.endsWith(sfx) && key.length >= pfx.length + sfx.length) {
			return true;
		}
	}
	return false;
}

// ── self-test: these live keys use every dynamic-access shape and MUST resolve ─
const KNOWN_LIVE = [
	'nav.orderbook', 'nav.messages',
	'faq.entries.why_agpl.q', 'faq.entries.what_is_bch.a',
	'payment_method.paypal.description',
	'post_order.form.asset_explainer.btc',
	'run_a_node.step1_title',
	'paired_readonly.write_blocked_post_order_body',
	'orderbook.order.range_open' in en ? 'nav.orderbook' : 'nav.orderbook', // placeholder-safe
	'settings.hardware_key.error.timeout',
	'assets.usdt.price_subline.live',
	'order_title.buy_range'
];
const selfTestFailures = KNOWN_LIVE.filter((k) => leaves.includes(k) && !referenced(k));

// ── report ────────────────────────────────────────────────────────────────
const dead = leaves.filter((k) => !referenced(k));
console.log('i18n-dead-key-gate:\n');
console.log(`  parsed ${files.length} source files (${svelteCompileFailures} .svelte fell back to script-scan)`);
console.log(`  extracted ${staticLits.size} string literals, ${dynPairs.size} dynamic (prefix,suffix) pairs`);
console.log(`  ${leaves.length} locale leaf keys checked\n`);

if (selfTestFailures.length > 0) {
	console.log('  ✗ SELF-TEST FAILED — the extractor missed these KNOWN-LIVE keys (false positives):');
	for (const k of selfTestFailures) console.log(`      ${k}`);
	console.log('\n  The gate is not trustworthy until the extractor resolves these. NOT reporting dead keys.');
	process.exit(1);
}
console.log('  ✓ self-test: all known dynamic-access keys resolve (no false positives)');

if (dead.length > 0) {
	console.log(`\n  ✗ ${dead.length} DEAD key(s) — defined in locales, referenced nowhere in source:`);
	for (const k of dead) console.log(`      ${k}`);
	console.log('\n  Remove them from ALL 10 locales (then regenerate the native snapshot), or');
	console.log('  add to DYNAMIC_ALLOWLIST (with a comment) if genuinely runtime-assembled.');
	process.exit(1);
}
console.log(
	`\n✓ all ${leaves.length} i18n-dead-key-gate checks passed ` +
		`(every locale leaf key is referenced in source; self-test clean; ` +
		`${files.length} source files scanned)`
);
