/**
 * Vite plugin `morphit-licenses`: writes `licenses.txt` (served at
 * /licenses.txt) next to the client bundle, with the licence of every
 * third-party package whose code the browser bundle contains.
 *
 * The packages are read from the client build itself (every module Rollup put
 * in a chunk), so the file follows the bundle as dependencies come and go. For
 * each package it carries the name, version and declared licence, the text of
 * its LICENSE / LICENCE / COPYING / NOTICE files, and the licence comments of
 * code the package embeds from elsewhere (`@license` and `/*!` blocks).
 *
 * Two things in what the browser gets are not a package module (v1.21.5):
 *   - Vite's own runtime helper (`\0vite/preload-helper`, the code that loads
 *     a lazy chunk), a virtual module of the build tool. It is listed as Vite,
 *     with Vite's own licence — not the licences of the dependencies Vite
 *     bundles into its build tooling, none of which reach the browser.
 *   - The web font, served from static/fonts with its SIL OFL text.
 *
 * The output is deterministic (sorted, no dates), so the file hashes the same
 * on every build of the same tree.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

export const LICENSES_FILE = 'licenses.txt';

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
/** A licence comment: `/*!` (kept by minifiers) or any block naming @license. */
const isLegalComment = (c: string): boolean => c.startsWith('/*!') || c.includes('@license');

/** Code a package copies into its own dist rather than depending on it, named
 *  by the upstream project so the notice can be found. Checked against the
 *  package's sources: jspdf inlines RGBColor (rgbcolor) in dist/jspdf.es.js. */
const EMBEDS: Readonly<Record<string, readonly string[]>> = {
	jspdf: ['rgbcolor (RGBColor by Stoyan Stefanov, license: "Use it if you like it")']
};

interface PackageInfo {
	readonly root: string;
	readonly name: string;
	readonly version: string;
	readonly license: string;
	readonly homepage: string;
	readonly files: readonly { readonly name: string; readonly text: string }[];
	readonly legalComments: Set<string>;
}

/** The package root of a module id under node_modules, or null for the app's
 *  own code, workspace packages and virtual modules. */
export function packageRootOf(id: string): string | null {
	const clean = id.replace(/^\0+/, '').split('?')[0]!.replace(/\\/g, '/');
	const at = clean.lastIndexOf('/node_modules/');
	if (at < 0) return null;
	const rest = clean.slice(at + '/node_modules/'.length).split('/');
	const take = rest[0]?.startsWith('@') ? 2 : 1;
	if (rest.length < take || !rest[0]) return null;
	return clean.slice(0, at + '/node_modules/'.length) + rest.slice(0, take).join('/');
}

/** Vite's package root, for the virtual helper modules Vite itself adds to a
 *  build (`\0vite/preload-helper.js` and the like); null for any other id. */
export function viteHelperRootOf(id: string): string | null {
	if (!id.startsWith('\0vite/')) return null;
	try {
		return dirname(createRequire(import.meta.url).resolve('vite/package.json'));
	} catch {
		return null;
	}
}

/** Vite's LICENSE.md is its own MIT licence followed by the licences of the
 *  build-tool dependencies it bundles; only the first part covers the helper. */
const VITE_BUNDLED_HEADING = '\n# Licenses of bundled dependencies';

/** A repository field as a link: npm's `user/repo` and `github:user/repo`
 *  shorthands, and `git+https:` / `git:` URLs, become plain https URLs. */
export function sourceUrlOf(raw: string): string {
	let u = raw.trim();
	const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(u);
	if (short) return `https://github.com/${short[1]!.replace(/\.git$/, '')}`;
	u = u
		.replace(/^git\+/, '')
		.replace(/^git:\/\//, 'https://')
		.replace(/^ssh:\/\/git@/, 'https://');
	if (/^https?:\/\/.*\.git$/.test(u)) u = u.replace(/\.git$/, '');
	return u;
}

function readPackage(root: string): PackageInfo | null {
	const pj = join(root, 'package.json');
	if (!existsSync(pj)) return null;
	let meta: Record<string, unknown>;
	try {
		meta = JSON.parse(readFileSync(pj, 'utf8')) as Record<string, unknown>;
	} catch {
		return null;
	}
	const lic = meta.license;
	const license =
		typeof lic === 'string'
			? lic
			: typeof (lic as { type?: unknown } | undefined)?.type === 'string'
				? String((lic as { type: string }).type)
				: Array.isArray(meta.licenses)
					? (meta.licenses as { type?: string }[]).map((l) => l.type ?? '?').join(' OR ')
					: 'not declared';
	const repo = meta.repository;
	const homepage =
		typeof meta.homepage === 'string'
			? meta.homepage
			: typeof repo === 'string'
				? repo
				: typeof (repo as { url?: unknown } | undefined)?.url === 'string'
					? String((repo as { url: string }).url)
					: '';
	const isVite = meta.name === 'vite';
	const files = readdirSync(root)
		.filter((f) => LICENCE_FILE.test(f))
		.sort()
		.map((f) => {
			let text = readFileSync(join(root, f), 'utf8').trim();
			if (isVite && text.includes(VITE_BUNDLED_HEADING)) {
				text = text.slice(0, text.indexOf(VITE_BUNDLED_HEADING)).trim();
			}
			return { name: f, text };
		});
	return {
		root,
		name: typeof meta.name === 'string' ? meta.name : root.split('/').slice(-1)[0]!,
		version: typeof meta.version === 'string' ? meta.version : '?',
		license,
		homepage: homepage ? sourceUrlOf(homepage) : '',
		files,
		legalComments: new Set()
	};
}

/** A font the site serves: its files, licence and notice. */
export interface FontInfo {
	readonly name: string;
	readonly files: readonly string[];
	readonly license: string;
	readonly source: string;
	readonly licenseFile: { readonly name: string; readonly text: string };
}

/** The fonts in a static/fonts directory: every .woff2 there, under the
 *  directory's OFL.txt. Empty when there is no such directory. The family name
 *  is read from the file names (`comfortaa-latin-400.woff2` → Comfortaa) and
 *  the source from the OFL's copyright line. */
export function fontsIn(dir: string): FontInfo[] {
	if (!existsSync(dir)) return [];
	const ofl = join(dir, 'OFL.txt');
	const woff = readdirSync(dir)
		.filter((f) => f.endsWith('.woff2'))
		.sort();
	if (woff.length === 0 || !existsSync(ofl)) return [];
	const text = readFileSync(ofl, 'utf8').trim();
	const families = new Map<string, string[]>();
	for (const f of woff) {
		const fam = f.split('-')[0]!;
		families.set(fam, [...(families.get(fam) ?? []), f]);
	}
	const source = /\((https?:\/\/[^)\s]+)\)/.exec(text)?.[1] ?? '';
	return [...families.entries()].map(([fam, files]) => ({
		name: fam.charAt(0).toUpperCase() + fam.slice(1),
		files,
		license: 'OFL-1.1 (SIL Open Font License 1.1)',
		source,
		licenseFile: { name: 'OFL.txt', text }
	}));
}

/** The text of licenses.txt for the given bundled modules. `codeOf` returns a
 *  module's code (to find embedded licence comments), or null. `fonts` are the
 *  web fonts the site serves (see fontsIn). */
export function buildLicensesText(
	moduleIds: Iterable<string>,
	codeOf: (id: string) => string | null = () => null,
	fonts: readonly FontInfo[] = []
): string {
	const byRoot = new Map<string, PackageInfo>();
	for (const id of moduleIds) {
		const root = packageRootOf(id) ?? viteHelperRootOf(id);
		if (root === null) continue;
		let info = byRoot.get(root);
		if (info === undefined) {
			const read = readPackage(root);
			if (read === null) continue;
			info = read;
			byRoot.set(root, info);
		}
		const code = codeOf(id);
		if (code) {
			for (const m of code.match(BLOCK_COMMENT) ?? []) {
				if (isLegalComment(m)) info.legalComments.add(m.trim());
			}
		}
	}
	// One entry per name@version (the same package can sit in two node_modules).
	const seen = new Set<string>();
	const pkgs = [...byRoot.values()]
		.filter((p) => {
			const k = `${p.name}@${p.version}`;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		})
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));

	const rule = '='.repeat(72);
	const out: string[] = [
		'Third-party software in the Morphit web app',
		'',
		'The JavaScript this site sends to your browser contains code from the',
		'packages below. Each is listed with its version, its license and the',
		'notices its authors ship with it. Morphit itself is AGPL-3.0-or-later.',
		...(fonts.length > 0
			? [
					'',
					`The site's text is set in the font${fonts.length > 1 ? 's' : ''} listed after the packages.`
				]
			: []),
		'',
		`${pkgs.length} packages.`,
		''
	];
	for (const p of pkgs) {
		out.push(rule, `${p.name} ${p.version}`, `License: ${p.license}`);
		if (p.homepage) out.push(`Source: ${p.homepage}`);
		for (const e of EMBEDS[p.name] ?? []) out.push(`Embeds: ${e}`);
		out.push('');
		if (p.files.length === 0) {
			out.push(`(The package ships no license file; its package.json declares: ${p.license}.)`, '');
		}
		for (const f of p.files) out.push(`--- ${f.name} ---`, f.text, '');
		const comments = [...p.legalComments].sort();
		if (comments.length > 0) {
			out.push('--- license notices in the code ---');
			for (const c of comments) out.push(c, '');
		}
	}
	for (const f of fonts) {
		out.push(rule, `${f.name} (font)`, `License: ${f.license}`);
		if (f.source) out.push(`Source: ${f.source}`);
		out.push(`Files: ${f.files.map((x) => `/fonts/${x}`).join(', ')}`, '');
		out.push(`--- ${f.licenseFile.name} ---`, f.licenseFile.text, '');
	}
	out.push(rule, '');
	return out.join('\n');
}

/** Emits licenses.txt into the CLIENT build output (adapter-static copies it
 *  to build/licenses.txt). The server (prerender) build is skipped: none of
 *  its code is sent to a browser. */
export function licensesTxt(): Plugin {
	let ssr = false;
	let root = process.cwd();
	return {
		name: 'morphit-licenses',
		apply: 'build',
		configResolved(config) {
			ssr = Boolean(config.build.ssr);
			root = config.root;
		},
		generateBundle(_options, bundle) {
			if (ssr) return;
			const ids = new Set<string>();
			for (const item of Object.values(bundle)) {
				if (item.type === 'chunk') for (const id of Object.keys(item.modules)) ids.add(id);
			}
			const text = buildLicensesText(
				ids,
				(id) => this.getModuleInfo(id)?.code ?? null,
				fontsIn(join(root, 'static', 'fonts'))
			);
			this.emitFile({ type: 'asset', fileName: LICENSES_FILE, source: text });
		}
	};
}
