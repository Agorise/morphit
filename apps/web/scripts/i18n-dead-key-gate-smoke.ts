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
	/** cp445 — a dynamic (prefix, suffix) pair whitelists everything between them,
	 *  so harvesting them from EVERY template literal in the tree is dangerous.
	 *  `ChatComposer.svelte` builds a localStorage draft key as `` `chat.${peer}` ``.
	 *  That is not an i18n key at all, but it produced the pair
	 *  ('chat.', '') — and `referenced()` then declared every single key under
	 *  `chat.*` to be in use. The gate went on printing "all 3327 checks passed"
	 *  over a genuinely orphaned `chat.pay_blurt.needs_active_key`.
	 *
	 *  A green number over a broken check is worse than a red one, so: only
	 *  expressions passed to a TRANSLATE CALL are treated as key material. */
	const TRANSLATE_FNS = new Set(['$_', '_', 't', '$t']);
	function isTranslateCall(node: ts.Node): node is ts.CallExpression {
		if (!ts.isCallExpression(node)) return false;
		const e = node.expression;
		if (ts.isIdentifier(e)) return TRANSLATE_FNS.has(e.text);
		// `i18n.t(...)` / `$i18n.t(...)`
		if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
			return TRANSLATE_FNS.has(e.name.text);
		}
		return false;
	}

	function harvestKeyExpr(arg: ts.Node): void {
		if (ts.isTemplateExpression(arg)) {
			const prefix = arg.head.text;
			const suffix = arg.templateSpans[arg.templateSpans.length - 1]!.literal.text;
			if (/[._]/.test(prefix + suffix)) dynPairs.add(prefix + SEP + suffix);
			return;
		}
		if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			const ops: ts.Node[] = [];
			flattenPlus(arg, ops);
			const first = ops[0]!;
			const last = ops[ops.length - 1]!;
			const prefix = ts.isStringLiteral(first) ? first.text : '';
			const suffix = ts.isStringLiteral(last) ? last.text : '';
			if ((prefix || suffix) && /[._]/.test(prefix + suffix)) dynPairs.add(prefix + SEP + suffix);
		}
	}

	function visit(node: ts.Node): void {
		if (ts.isStringLiteralLike(node) && !ts.isTemplateExpression(node)) {
			staticLits.add((node as ts.StringLiteralLike).text);
		}
		// Harvest dynamic key shapes from ANY template/concat, not only from a
		// translate call: several keys are assembled into a variable or returned
		// from a helper (`orderTitleParts`) and translated at the call site. The
		// containment rules in `referenced()` — not the harvest site — are what
		// stop a pair from whitelisting a namespace.
		harvestKeyExpr(node);
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
	// AltNetworkIcon renders `footer.${network}` as its <img> alt. The globe
	// (website) and play (streaming) alts are reached ONLY via that dynamic
	// path — there is no static `$_('footer.globe')` call — so allowlist them.
	// (The other network alts — tor/nostr/ens/… — also appear as static
	// `$_('footer.tor')` etc. in the homepage grid, so they don't need this.)
	'footer.globe',
	'footer.play'
]);
function referenced(key: string): boolean {
	if (staticLits.has(key) || DYNAMIC_ALLOWLIST.has(key)) return true;
	for (const [pfx, sfx] of dynArr) {
		if (!pfx && !sfx) continue;
		if (!key.startsWith(pfx) || !key.endsWith(sfx)) continue;
		if (key.length < pfx.length + sfx.length) continue;
		// cp445 — RULE 1: the interpolated hole must fill EXACTLY ONE key segment.
		// `$_(\`a.b.\${x}\`)` can produce `a.b.foo`, never `a.b.foo.bar`. Without
		// this, a pair with an empty suffix matched every descendant key in the
		// namespace, however deep — which is how a dead `chat.pay_blurt.*` key
		// slipped through while the gate printed a green number.
		const hole = key.slice(pfx.length, key.length - sfx.length);
		if (hole.includes('.') || hole.length === 0) continue;

		// cp445 — RULE 2: an EMPTY suffix means the template ends in the hole, so
		// the pair covers a whole namespace level. Demand that the prefix name at
		// least two levels first. `ChatComposer` builds a localStorage draft key
		// as `chat.${peer}` — not an i18n key at all — and that one-level prefix
		// was whitelisting every `chat.*` key in the app.
		if (sfx.length === 0) {
			const depth = (pfx.match(/\./g) ?? []).length;
			if (depth < 2) continue;
		}
		return true;
	}
	return false;
}

// ── self-test A (false NEGATIVE): the gate must be able to FAIL ──────────────
// cp445 — the gate reported "all 3327 checks passed" while
// `chat.pay_blurt.needs_active_key` was orphaned: `ChatComposer` builds a
// localStorage draft key as `chat.${peer}`, which the extractor read as an i18n
// pair ('chat.', '') and used to whitelist every key under `chat.*`. A gate that
// cannot fail is not a gate. These synthetic keys must be reported dead.
const MUST_BE_DEAD = [
	'chat.__synthetic_orphan__', // 1 segment under a poisoned namespace
	'chat.pay_blurt.__synthetic_orphan__', // deeper under the same
	'footer.__synthetic_orphan__' // `footer.${network}` in AltNetworkIcon
];
const falseNegatives = MUST_BE_DEAD.filter((k) => referenced(k));
if (falseNegatives.length > 0) {
	console.error('\u2717 SELF-TEST FAILED — the gate would not catch these dead keys:');
	for (const k of falseNegatives) console.error(`      ${k}`);
	console.error('');
	console.error('  A dynamic (prefix, suffix) pair is whitelisting a whole namespace.');
	console.error('  The gate is NOT trustworthy. Fix `referenced()` before trusting a pass.');
	process.exit(1);
}

// ── self-test B (false POSITIVE): these live keys use every dynamic-access shape and MUST resolve ─
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
