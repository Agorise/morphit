/**
 * password-field-scope-smoke
 * ──────────────────────────
 * A browser's password manager must never write into a field that is not a
 * login field. Asserts, for every `<input type="password">` in the web app:
 *
 *   1. A field for the Morphit password (autocomplete current-password or
 *      new-password) sits in a form of its own whose user name is the
 *      account: inside <PasswordScope>, or inside a <form> holding a
 *      <LoginNameField> before it. Before it in that form there is nothing
 *      else Firefox could take for a user name: no other such input, no
 *      component that renders one (or that this check cannot read), no
 *      `{@render}` of a snippet from elsewhere.
 *   2. A field for a KEY (any other autocomplete) is `readonly` (bare, in the
 *      markup) with `use:keyField`, so it starts read-only on every render
 *      and no saved password is filled in.
 *   3. No form inside a form: a <form>, <PasswordScope>, or a component that
 *      renders one, never sits inside a <form> or a <PasswordScope>. A
 *      <LoginNameField> always sits in one. A plain <form> with a
 *      <LoginNameField> has a submit button: without one, Enter submits a
 *      form only when it has ONE text-like field, and the name is a second.
 *   4. Nothing it cannot read: no input with `{...spread}` or a computed
 *      `type`, no <svelte:element>.
 *
 * WHY (v1.21.14): outside a form, Firefox's password manager treats every
 * field of the page as one login form. It looks backwards from the first
 * password field for a text field it can call a user name (type text, email,
 * url, tel, number or search; autocomplete empty, on, off, username, email or
 * tel) and writes the saved user name there, and it fills the saved password
 * into the first password field even with autocomplete="off", unless that
 * field is read-only. Seen in Firefox: "morphit" in the language field of
 * /settings (its menu opened and blurred the page), in the memo of a BLURT
 * transfer, in the amount to power up; the saved password in the Active-key
 * box. (Firefox source: toolkit/components/passwordmgr LoginManagerChild
 * _getFormFields / _fillForm, LoginManager.shared isUsernameFieldType,
 * FormLikeFactory createFromDocumentRoot.)
 *
 * Parsed with the Svelte compiler, not a regex: {#if}/{#each}/{#await}
 * blocks and snippets defined in the file are walked; components are judged
 * by their own files (transitively).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_ROOT = process.env.PASSWORD_SCOPE_SCAN_ROOT ?? join(REPO_ROOT, 'apps', 'web', 'src');
const IGNORE_DIRS = new Set(['node_modules', '.svelte-kit', 'dist', 'build']);

/** Morphit-password fields. Everything else of type password is a key. */
const LOGIN_PASSWORD = new Set(['current-password', 'new-password']);
/** Firefox: types it may take for a user name (LoginManager.shared). */
const USERNAME_TYPES = new Set(['text', 'email', 'url', 'tel', 'number', 'search']);
/** Firefox: autocomplete values it still takes for a user name. */
const USERNAME_AC = new Set([
	'',
	'on',
	'off',
	'username',
	'webauthn',
	'email',
	'tel',
	'tel-national'
]);

type Node = any;

export interface Found {
	file: string;
	ast: Node;
	src: string;
}

function walkFiles(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (!IGNORE_DIRS.has(entry)) walkFiles(full, out);
		} else if (entry.endsWith('.svelte')) out.push(full);
	}
}

/** Visit every template node with its ancestors (elements, components, blocks). */
function visit(node: Node, ancestors: Node[], cb: (n: Node, anc: Node[]) => void): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const n of node) visit(n, ancestors, cb);
		return;
	}
	if (typeof node.type === 'string') cb(node, ancestors);
	const next = typeof node.type === 'string' ? [...ancestors, node] : ancestors;
	for (const key of Object.keys(node)) {
		if (key === 'attributes' || key === 'expression' || key === 'metadata' || key === 'parent')
			continue;
		const v = node[key];
		if (v && typeof v === 'object') visit(v, next, cb);
	}
}

function attr(el: Node, name: string): Node | undefined {
	return (el.attributes ?? []).find(
		(a: Node) => a.type === 'Attribute' && a.name.toLowerCase() === name
	);
}

/** A static attribute value, '' for a bare attribute, null for none, undefined when computed. */
function staticValue(el: Node, name: string): string | null | undefined {
	const a = attr(el, name);
	if (!a) return null;
	if (a.value === true) return '';
	const parts = Array.isArray(a.value) ? a.value : [a.value];
	if (parts.every((p: Node) => p.type === 'Text')) return parts.map((p: Node) => p.data).join('');
	return undefined;
}

/** The string literals an expression can produce (`a ? 'x' : 'y'`), or null when not only literals. */
function literals(e: Node): string[] | null {
	if (e?.type === 'Literal' && typeof e.value === 'string') return [e.value];
	if (e?.type === 'ConditionalExpression') {
		const a = literals(e.consequent);
		const b = literals(e.alternate);
		return a && b ? [...a, ...b] : null;
	}
	return null;
}

/** The input's type, lower case; undefined when it cannot be read ({...spread}, a computed
 *  type that is not a choice between fixed words, or one that may be "password"). A choice
 *  of fixed words counts as the one Firefox could most take for a user name. */
function inputType(el: Node): string | undefined {
	if ((el.attributes ?? []).some((a: Node) => a.type === 'SpreadAttribute')) return undefined;
	const t = staticValue(el, 'type');
	if (t !== undefined) return (t ?? 'text').trim().toLowerCase();
	const a = attr(el, 'type');
	const v = Array.isArray(a.value) ? a.value : [a.value];
	const words = v.length === 1 && v[0].type === 'ExpressionTag' ? literals(v[0].expression) : null;
	if (!words) return undefined;
	const types = words.map((w) => w.trim().toLowerCase());
	if (types.includes('password')) return undefined;
	return types.find((w) => USERNAME_TYPES.has(w)) ?? types[0];
}

function isEl(n: Node, name: string): boolean {
	return n.type === 'RegularElement' && n.name === name;
}
function isComp(n: Node, name: string): boolean {
	return n.type === 'Component' && n.name === name;
}
function isScope(n: Node): boolean {
	return isEl(n, 'form') || isComp(n, 'PasswordScope');
}

/** Could Firefox take this input for a user name? Anything unreadable counts as yes. */
function usernameCapable(el: Node): boolean {
	const t = inputType(el);
	if (t === undefined) return true;
	if (!USERNAME_TYPES.has(t) && !t.includes('user')) return false;
	const ac = staticValue(el, 'autocomplete');
	if (ac === undefined) return true;
	return USERNAME_AC.has((ac ?? '').trim().toLowerCase());
}

function hasSubmit(form: Node): boolean {
	let found = false;
	visit(form.fragment, [], (m) => {
		const t = (staticValue(m, 'type') ?? '').toLowerCase();
		if (t !== 'submit') return;
		if (isEl(m, 'button') || isEl(m, 'input') || m.type === 'Component') found = true;
	});
	return found;
}

function lineOf(src: string, pos: number): number {
	return src.slice(0, pos).split('\n').length;
}

export interface Problem {
	file: string;
	line: number;
	why: string;
}

/** Component names (file base names) whose file — or a component it renders — has a node passing `test`. */
function closure(files: Found[], seed: string[], test: (n: Node) => boolean): Set<string> {
	const set = new Set<string>(seed);
	for (let changed = true; changed; ) {
		changed = false;
		for (const f of files) {
			const name = basename(f.file, '.svelte');
			if (set.has(name)) continue;
			let hit = false;
			visit(f.ast.fragment, [], (n) => {
				if (test(n) || (n.type === 'Component' && set.has(n.name))) hit = true;
			});
			if (hit) {
				set.add(name);
				changed = true;
			}
		}
	}
	return set;
}

export function check(files: Found[]): {
	problems: Problem[];
	loginFields: number;
	keyFields: number;
} {
	const problems: Problem[] = [];
	let loginFields = 0;
	let keyFields = 0;
	const known = new Set(files.map((f) => basename(f.file, '.svelte')));

	// Components that render a form of their own, directly or through another.
	const rendersForm = closure(files, ['PasswordScope'], (n) => isEl(n, 'form'));
	// Components that put what they are given ({@render …}) inside a <form> of
	// their own (review D, F2): a scope handed to one ends up in a form.
	const wrapsInForm = new Set<string>();
	for (const f of files) {
		let wraps = false;
		visit(f.ast.fragment, [], (n, anc) => {
			if (n.type === 'RenderTag' && anc.some((a) => isEl(a, 'form'))) wraps = true;
		});
		if (wraps) wrapsInForm.add(basename(f.file, '.svelte'));
	}
	const formAround = (a: Node): boolean =>
		isScope(a) || (a.type === 'Component' && wrapsInForm.has(a.name));
	// Components that render a field Firefox could take for a user name.
	const rendersNameField = closure(
		files,
		[],
		(n) =>
			(isEl(n, 'input') && inputType(n) !== 'password' && usernameCapable(n)) ||
			n.type === 'SvelteElement'
	);

	for (const f of files) {
		const at = (n: Node, why: string): void => {
			problems.push({ file: f.file, line: lineOf(f.src, n.start), why });
		};
		// Snippets holding a form or a scope, by name, and every snippet rendered
		// inside a form (review D, F2).
		const scopeSnippets = new Set<string>();
		const renderedInForm: { name: string; node: Node }[] = [];
		const calleeName = (e: Node | undefined): string | null => {
			let x = e;
			if (x?.type === 'ChainExpression') x = x.expression;
			if (x?.type === 'CallExpression') x = x.callee;
			return x?.type === 'Identifier' ? (x.name as string) : null;
		};
		visit(f.ast.fragment, [], (n, anc) => {
			if (
				(isEl(n, 'form') ||
					isComp(n, 'PasswordScope') ||
					(n.type === 'Component' && rendersForm.has(n.name))) &&
				anc.length > 0
			) {
				const snip = [...anc].reverse().find((a) => a.type === 'SnippetBlock');
				const name = snip ? calleeName(snip.expression) : null;
				if (name !== null) scopeSnippets.add(name);
			}
			if (n.type === 'RenderTag' && anc.some(formAround)) {
				const name = calleeName(n.expression);
				if (name !== null) renderedInForm.push({ name, node: n });
			}
		});
		for (const r of renderedInForm)
			if (scopeSnippets.has(r.name))
				at(r.node, `{@render ${r.name}()} puts a form or <PasswordScope> inside a form`);
		visit(f.ast.fragment, [], (n, anc) => {
			if (
				(isEl(n, 'form') || (n.type === 'Component' && rendersForm.has(n.name))) &&
				anc.some(formAround)
			)
				at(n, `<${n.name}> (a form) inside a form`);
			// Inside a PasswordScope a button is a submit button unless it says
			// otherwise, and Enter in its password field would press it (review D, F1).
			if (
				isEl(n, 'button') &&
				anc.some((a) => isComp(a, 'PasswordScope')) &&
				(staticValue(n, 'type') ?? '').toLowerCase() !== 'button'
			)
				at(n, '<button> inside a <PasswordScope> without type="button": Enter would press it');
			if (isComp(n, 'LoginNameField') && !anc.some(isScope))
				at(n, '<LoginNameField> outside a form: no password field can pair with it');
			if (isEl(n, 'form')) {
				let named = false;
				visit(n.fragment, [], (m) => {
					if (isComp(m, 'LoginNameField')) named = true;
				});
				// PasswordScope's own form never submits on purpose (its buttons act).
				if (named && !hasSubmit(n) && basename(f.file, '.svelte') !== 'PasswordScope')
					at(n, '<form> with a <LoginNameField> but no submit button: Enter does nothing');
				// Its submit must be handled (preventDefault), or Enter submits the
				// page as a GET — what was typed in the URL (review D, F1).
				const handled = (n.attributes ?? []).some(
					(a: Node) =>
						(a.type === 'Attribute' && a.name === 'onsubmit') ||
						(a.type === 'OnDirective' && a.name === 'submit')
				);
				if (named && !handled && basename(f.file, '.svelte') !== 'PasswordScope')
					at(n, '<form> with a <LoginNameField> but no onsubmit handler: Enter submits the page');
			}
			if (n.type === 'SvelteElement')
				at(n, '<svelte:element>: may be an input this check cannot read');
			if (!isEl(n, 'input')) return;

			const type = inputType(n);
			if (type === undefined) {
				at(n, 'input with {...spread} or a computed type: this check cannot read it');
				return;
			}
			if (type !== 'password') return;
			const ac = staticValue(n, 'autocomplete');
			if (ac === null || ac === undefined) {
				at(n, 'password field without a fixed autocomplete value');
				return;
			}
			if (!LOGIN_PASSWORD.has(ac)) {
				keyFields++;
				const ro = attr(n, 'readonly');
				const locked = ro !== undefined && ro.value === true;
				const action = (n.attributes ?? []).some(
					(a: Node) => a.type === 'UseDirective' && a.name === 'keyField'
				);
				if (!locked || !action)
					at(
						n,
						`key field (autocomplete="${ac}") not \`readonly\` + use:keyField: a saved password would be filled into it`
					);
				return;
			}
			loginFields++;
			const scope = [...anc].reverse().find(isScope);
			if (!scope) {
				at(
					n,
					`password field (${ac}) outside a form: the saved user name lands in another field of the page`
				);
				return;
			}
			// Everything before it in its form that Firefox could take for a user name.
			let names = 0;
			const others: Node[] = [];
			visit(scope.fragment, [], (m, manc) => {
				if (m.start >= n.start || manc.some(isScope)) return;
				if (isComp(m, 'LoginNameField')) names++;
				else if (isEl(m, 'input') && inputType(m) !== 'password' && usernameCapable(m))
					others.push(m);
				else if (m.type === 'RenderTag') others.push(m);
				else if (m.type === 'Component' && (rendersNameField.has(m.name) || !known.has(m.name)))
					others.push(m);
			});
			if (names === 0 && !isComp(scope, 'PasswordScope'))
				at(n, `password field (${ac}) in a <form> without a <LoginNameField> before it`);
			for (const o of others)
				at(
					n,
					`password field (${ac}): line ${lineOf(f.src, o.start)} before it could take the saved user name`
				);
		});
	}
	return { problems, loginFields, keyFields };
}

function load(path: string): Found {
	const src = readFileSync(path, 'utf8');
	return { file: relative(REPO_ROOT, path), src, ast: parse(src, { modern: true }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	console.log('');
	console.log('── password-field-scope smoke ──────────────────────────');
	console.log('');
	const paths: string[] = [];
	walkFiles(SCAN_ROOT, paths);
	const { problems, loginFields, keyFields } = check(paths.map(load));

	// The rule itself, on small pages: each must give exactly the problems listed.
	const fx = (file: string, src: string): Found => ({
		file,
		src,
		ast: parse(src, { modern: true })
	});
	const PW = '<input type="password" maxlength="64" autocomplete="current-password" />';
	const SUBMIT = '<button type="submit">go</button>';
	const page = (src: string): Found[] => [fx('a', src)];
	const cases: { name: string; files: Found[]; expect: number }[] = [
		{
			name: 'scoped password field passes',
			expect: 0,
			files: page(`<input type="text" /><PasswordScope>${PW}</PasswordScope>`)
		},
		{
			name: 'password field outside a form fails',
			expect: 1,
			files: page(`<input type="text" />${PW}`)
		},
		{
			name: 'type="PASSWORD" is a password field too',
			expect: 1,
			files: page('<input type="PASSWORD" maxlength="64" autocomplete="current-password" />')
		},
		{
			name: 'a text field inside the scope, before the password, fails',
			expect: 1,
			files: page(`<PasswordScope><input type="text" />${PW}</PasswordScope>`)
		},
		{
			name: 'autocomplete="off" does not stop Firefox taking a field for the user name',
			expect: 1,
			files: page(`<PasswordScope><input type="text" autocomplete="off" />${PW}</PasswordScope>`)
		},
		{
			name: 'a <form>: no other user-name field before the password, even after the <LoginNameField>',
			expect: 1,
			files: page(
				`<form onsubmit={go}><LoginNameField /><input type="email" />${PW}${SUBMIT}</form>`
			)
		},
		{
			name: 'a <form> without a <LoginNameField> fails',
			expect: 1,
			files: page(`<form>${PW}</form>`)
		},
		{
			name: 'a <form> with a <LoginNameField> and a submit button passes',
			expect: 0,
			files: page(
				`<form onsubmit={go}><LoginNameField />${PW}<BusyButton type="submit">go</BusyButton></form>`
			)
		},
		{
			name: 'a <form> with a <LoginNameField> but no submit button fails (Enter would do nothing)',
			expect: 1,
			files: page(
				`<form onsubmit={go}><LoginNameField />${PW}<button type="button">go</button></form>`
			)
		},
		// v1.21.14 review D, F1/F2: Enter must never submit a form (a GET would put
		// what is typed in the URL), and a form must not end up around a scope by
		// way of a wrapper component or a snippet.
		{
			name: 'a <form> with a <LoginNameField> but no onsubmit handler fails (Enter would submit the page)',
			expect: 1,
			files: page(`<form><LoginNameField />${PW}${SUBMIT}</form>`)
		},
		{
			name: 'a <button> with no type inside a <PasswordScope> fails (it is a submit button)',
			expect: 1,
			files: page(`<PasswordScope>${PW}<button>cancel</button></PasswordScope>`)
		},
		{
			name: 'a <button type="button"> inside a <PasswordScope> passes',
			expect: 0,
			files: page(`<PasswordScope>${PW}<button type="button">cancel</button></PasswordScope>`)
		},
		{
			name: 'a <PasswordScope> inside a component that wraps its children in a <form> fails',
			expect: 1,
			files: [
				fx('Wrap.svelte', '<form onsubmit={f}>{@render children()}</form>'),
				fx('a', `<Wrap><PasswordScope>${PW}</PasswordScope></Wrap>`)
			]
		},
		{
			name: 'a snippet holding a <PasswordScope>, rendered inside a <form>, fails',
			expect: 1,
			files: page(
				`{#snippet s()}<PasswordScope>${PW}</PasswordScope>{/snippet}<form onsubmit={f}>{@render s()}</form>`
			)
		},
		{
			name: 'a snippet holding a <PasswordScope>, rendered outside any form, passes',
			expect: 0,
			files: page(
				`{#snippet s()}<PasswordScope>${PW}</PasswordScope>{/snippet}<div>{@render s()}</div>`
			)
		},
		{
			name: 'a field Firefox never takes for a user name (autocomplete="url") may sit between',
			expect: 0,
			files: page(
				`<form onsubmit={go}><LoginNameField /><input type="text" autocomplete="url" />${PW}${SUBMIT}</form>`
			)
		},
		{
			name: 'a key field must start read-only',
			expect: 1,
			files: page('<input type="password" maxlength="64" autocomplete="off" use:keyField />')
		},
		{
			name: 'a key field with readonly={false} fails',
			expect: 1,
			files: page(
				'<input type="password" maxlength="64" autocomplete="off" readonly={false} use:keyField />'
			)
		},
		{
			name: 'a read-only key field needs use:keyField (an onfocus handler is not enough)',
			expect: 1,
			files: page(
				'<input type="password" maxlength="64" autocomplete="off" readonly onfocus={f} />'
			)
		},
		{
			name: 'a read-only key field with use:keyField passes',
			expect: 0,
			files: page(
				'<input type="password" maxlength="64" autocomplete="off" readonly use:keyField />'
			)
		},
		{
			name: 'a password field needs a fixed autocomplete value',
			expect: 1,
			files: page('<PasswordScope><input type="password" maxlength="64" /></PasswordScope>')
		},
		{
			name: 'an input with {...spread} fails (its type cannot be read)',
			expect: 1,
			files: page('<input {...props} />')
		},
		{
			name: 'an input with a computed type fails',
			expect: 1,
			files: page('<input type={kind} maxlength="64" />')
		},
		{
			name: 'a computed type that may be "password" fails',
			expect: 1,
			files: page("<input type={show ? 'text' : 'password'} maxlength=\"64\" />")
		},
		{
			name: 'a computed choice of fixed words counts as a user-name field',
			expect: 1,
			files: page(
				`<PasswordScope><input type={c ? 'email' : 'text'} maxlength="9" />${PW}</PasswordScope>`
			)
		},
		{
			name: '<svelte:element> fails',
			expect: 1,
			files: page('<svelte:element this="input" />')
		},
		{
			name: '<PasswordScope> inside a <form> fails',
			expect: 1,
			files: page(
				`<form onsubmit={go}><LoginNameField /><PasswordScope>${PW}</PasswordScope>${SUBMIT}</form>`
			)
		},
		{
			name: '<PasswordScope> inside a <PasswordScope> fails',
			expect: 1,
			files: page(`<PasswordScope><PasswordScope>${PW}</PasswordScope></PasswordScope>`)
		},
		{
			name: 'a <form> inside a <PasswordScope> fails',
			expect: 1,
			files: page(
				`<PasswordScope><form onsubmit={go}><LoginNameField />${PW}<BusyButton type="submit">go</BusyButton></form></PasswordScope>`
			)
		},
		{
			name: 'a component that renders a <PasswordScope> inside a <form> fails',
			expect: 1,
			files: [
				fx('Inner.svelte', `<PasswordScope>${PW}</PasswordScope>`),
				fx('b', '<form><Inner /></form>')
			]
		},
		{
			name: 'a component that renders a <PasswordScope> inside a <PasswordScope> fails',
			expect: 1,
			files: [
				fx('Inner.svelte', `<PasswordScope>${PW}</PasswordScope>`),
				fx('b', '<PasswordScope><Inner /></PasswordScope>')
			]
		},
		{
			name: '<LoginNameField> outside a form fails',
			expect: 1,
			files: page('<LoginNameField />')
		},
		{
			name: 'blocks inside the scope still count (an {#if} text field before the password fails)',
			expect: 1,
			files: page(`<PasswordScope>{#if x}<input />{/if}${PW}</PasswordScope>`)
		},
		{
			name: 'a {@render} before the password in the scope fails (its fields are elsewhere)',
			expect: 1,
			files: page(`<PasswordScope>{@render extra()}${PW}</PasswordScope>`)
		},
		{
			name: 'a component with a text field, before the password in the scope, fails',
			expect: 1,
			files: [
				fx('Txt.svelte', '<input type="text" maxlength="9" />'),
				fx('b', `<PasswordScope><Txt />${PW}</PasswordScope>`)
			]
		},
		{
			name: 'a component this check cannot read, before the password in the scope, fails',
			expect: 1,
			files: page(`<PasswordScope><Mystery />${PW}</PasswordScope>`)
		},
		{
			name: 'a component without a text field, before the password in the scope, passes',
			expect: 0,
			files: [
				fx('Safe.svelte', '<p>hello</p>'),
				fx('b', `<PasswordScope><Safe />${PW}</PasswordScope>`)
			]
		}
	];
	const wrong = cases.filter((c) => check(c.files).problems.length !== c.expect);
	for (const c of wrong)
		console.log(
			`    rule case "${c.name}": got ${check(c.files).problems.length} problem(s), expected ${c.expect}`
		);

	const scenarios = [
		{
			name: 'every password field is scoped as above (login: own form + user name; key: read-only until touched)',
			ok: problems.length === 0
		},
		{
			name: 'the scan found the Morphit-password fields and the key fields',
			ok: loginFields >= 20 && keyFields >= 3
		},
		{
			name: `the rule gives the expected result on ${cases.length} small pages`,
			ok: wrong.length === 0
		}
	];
	for (const p of problems) console.log(`    ${p.file}:${p.line}  ${p.why}`);
	if (problems.length) console.log('');
	console.log(
		`  scanned ${paths.length} .svelte files: ${loginFields} password fields, ${keyFields} key fields`
	);
	const failed = scenarios.filter((s) => !s.ok);
	for (const s of failed) console.log(`  ✗ ${s.name}`);
	console.log('────────────────────────────────────────────────────────');
	if (failed.length === 0) {
		console.log(`✓ all ${scenarios.length} password-field-scope scenarios passed`);
		process.exit(0);
	} else {
		console.log(`✗ ${failed.length} of ${scenarios.length} scenarios failed`);
		process.exit(1);
	}
}
