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
 * The output is deterministic (sorted, no dates), so the file hashes the same
 * on every build of the same tree.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
	const files = readdirSync(root)
		.filter((f) => LICENCE_FILE.test(f))
		.sort()
		.map((f) => ({ name: f, text: readFileSync(join(root, f), 'utf8').trim() }));
	return {
		root,
		name: typeof meta.name === 'string' ? meta.name : root.split('/').slice(-1)[0]!,
		version: typeof meta.version === 'string' ? meta.version : '?',
		license,
		homepage,
		files,
		legalComments: new Set()
	};
}

/** The text of licenses.txt for the given bundled modules. `codeOf` returns a
 *  module's code (to find embedded licence comments), or null. */
export function buildLicensesText(
	moduleIds: Iterable<string>,
	codeOf: (id: string) => string | null = () => null
): string {
	const byRoot = new Map<string, PackageInfo>();
	for (const id of moduleIds) {
		const root = packageRootOf(id);
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
	out.push(rule, '');
	return out.join('\n');
}

/** Emits licenses.txt into the CLIENT build output (adapter-static copies it
 *  to build/licenses.txt). The server (prerender) build is skipped: none of
 *  its code is sent to a browser. */
export function licensesTxt(): Plugin {
	let ssr = false;
	return {
		name: 'morphit-licenses',
		apply: 'build',
		configResolved(config) {
			ssr = Boolean(config.build.ssr);
		},
		generateBundle(_options, bundle) {
			if (ssr) return;
			const ids = new Set<string>();
			for (const item of Object.values(bundle)) {
				if (item.type === 'chunk') for (const id of Object.keys(item.modules)) ids.add(id);
			}
			const text = buildLicensesText(ids, (id) => this.getModuleInfo(id)?.code ?? null);
			this.emitFile({ type: 'asset', fileName: LICENSES_FILE, source: text });
		}
	};
}
