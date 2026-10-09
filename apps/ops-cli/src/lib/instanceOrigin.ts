/**
 * The instance's own origin in the prebuilt frontend.
 *
 * Every instance serves the same prebuilt pages, which name the build origin
 * (https://morphit.io) in canonical / hreflang / og / JSON-LD, sitemap.xml,
 * robots.txt and llms*.txt. apps/web/scripts/origin-slots.mjs
 * records those places at build time and rewrites them per instance. This
 * module decides WHICH origin an instance gets and runs that script — the
 * copy shipped in the install, so the new release's script runs even when an
 * older morphit-ops drives the upgrade — then OBSERVES the result:
 *   - the origin: MORPHIT_INSTANCE_ORIGIN (as the indexer unit sources the env
 *     files, last one wins); else, on a hidden-only node, its onion
 *     (MORPHIT_INSTANCE_TOR_ADDRESS); else "-" (no absolute URLs at all). A
 *     hidden-only node never gets a clearnet origin: a configured one is
 *     replaced by "-".
 *   - the check: the recorded map says the origin is applied, no recorded file
 *     still names the build origin (when it is not this instance's), a page's
 *     canonical link starts with the origin (or is root-relative for "-"), and
 *     verify.json's hash_manifest matches every file it lists.
 * Branding: brand slots are offsets into the same pages, so the origin goes
 * onto an UNBRANDED build — syncInstanceOrigin() resets the branding first
 * when it has to, applies the origin, then applies the branding again.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	applyBranding,
	brandingConfigured,
	buildDirOf,
	readBrandingSettings,
	syncTouchedToWebRoot
} from './branding.ts';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';

export const ORIGIN_SCRIPT_REL = join('apps', 'web', 'scripts', 'origin-slots.mjs');
const ORIGIN_RE =
	/^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const ONION_V3_RE = /^[a-z2-7]{56}\.onion$/;

/** scheme://host[:port], lower-case, no trailing slash; null when unset or not an origin. PURE. */
export function normalizeOrigin(raw: string | null | undefined): string | null {
	const s = String(raw ?? '')
		.trim()
		.replace(/^["']|["']$/g, '')
		.replace(/\/+$/, '')
		.toLowerCase();
	return ORIGIN_RE.test(s) ? s : null;
}

/** An origin on Tor or I2P (never clearnet). PURE. */
export function isHiddenServiceOrigin(origin: string): boolean {
	return /\.(?:onion|i2p)(?::\d+)?$/.test(origin.replace(/^https?:\/\//, ''));
}

/** Which origin this instance's pages name. PURE. */
export function chooseInstanceOrigin(i: {
	readonly configuredOrigin: string | null;
	readonly torAddress: string | null;
	readonly hiddenOnly: boolean;
}): { origin: string; why: string } {
	const cfg = normalizeOrigin(i.configuredOrigin);
	if (cfg !== null) {
		if (i.hiddenOnly && !isHiddenServiceOrigin(cfg)) {
			return {
				origin: '-',
				why: `MORPHIT_INSTANCE_ORIGIN is ${cfg}, a clearnet address, and this node is hidden-only — its pages name no origin`
			};
		}
		return { origin: cfg, why: 'MORPHIT_INSTANCE_ORIGIN' };
	}
	if (i.hiddenOnly) {
		const onion = String(i.torAddress ?? '')
			.trim()
			.replace(/^["']|["']$/g, '')
			.replace(/^https?:\/\//, '')
			.replace(/\/+$/, '')
			.toLowerCase();
		if (ONION_V3_RE.test(onion))
			return { origin: `http://${onion}`, why: 'MORPHIT_INSTANCE_TOR_ADDRESS' };
	}
	return { origin: '-', why: 'no instance origin is set' };
}

/** `key` as the indexer unit sees it: the env files in its order, last one wins. */
export function effectiveEnvValue(files: readonly string[], key: string): string | null {
	let v: string | null = null;
	const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[ \\t]*(.*)$`, 'gm');
	for (const f of files) {
		let text: string;
		try {
			if (!existsSync(f)) continue;
			text = readFileSync(f, 'utf8');
		} catch {
			continue;
		}
		for (const m of text.matchAll(re)) v = (m[1] ?? '').trim().replace(/^["']|["']$/g, '');
	}
	return v;
}

/** The env files the indexer unit sources (ops/systemd/morphit-indexer.service). */
export function instanceEnvFiles(
	installDir: string,
	etcDir = process.env.MORPHIT_ETC_DIR ?? `${process.env.MORPHIT_ENV_ROOT ?? ''}/etc/morphit`
): string[] {
	return [
		join(installDir, 'morphit.env'),
		join(installDir, 'morphit.config.env'),
		join(etcDir, 'indexer.env')
	];
}

export function resolveInstanceOrigin(
	installDir: string,
	hiddenOnly: boolean = isHiddenOnlyNode(),
	files: readonly string[] = instanceEnvFiles(installDir)
): { origin: string; why: string } {
	return chooseInstanceOrigin({
		configuredOrigin: effectiveEnvValue(files, 'MORPHIT_INSTANCE_ORIGIN'),
		torAddress: effectiveEnvValue(files, 'MORPHIT_INSTANCE_TOR_ADDRESS'),
		hiddenOnly
	});
}

type Run = (
	cmd: string,
	args: string[]
) => { status: number | null; stdout: string; stderr: string };
const realRun: Run = (cmd, args) => {
	const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000 });
	return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const lastJsonLine = (out: string): Record<string, unknown> | null => {
	const line = out
		.trim()
		.split('\n')
		.reverse()
		.find((l) => l.trim().startsWith('{'));
	try {
		return line ? (JSON.parse(line) as Record<string, unknown>) : null;
	} catch {
		return null;
	}
};

export interface OriginApply {
	readonly ok: boolean;
	readonly changed: boolean;
	readonly touched: string[];
	readonly reason?: string;
	readonly error?: string;
}

/** `origin-slots.mjs apply <buildDir> <origin|->` from the install's own copy. */
export function runOriginApply(
	installDir: string,
	buildDir: string,
	origin: string,
	run: Run = realRun
): OriginApply {
	const script = join(installDir, ORIGIN_SCRIPT_REL);
	if (!existsSync(script)) return { ok: true, changed: false, touched: [], reason: 'no-script' };
	const r = run(process.execPath, [script, 'apply', buildDir, origin]);
	const j = lastJsonLine(r.stdout);
	if (r.status !== 0 || j === null) {
		return {
			ok: false,
			changed: false,
			touched: [],
			error: (r.stderr.trim().split('\n').pop() ?? '') || `exit ${r.status ?? 'signal'}`
		};
	}
	return {
		ok: true,
		changed: j.changed === true,
		touched: Array.isArray(j.touched) ? (j.touched as string[]) : [],
		reason: typeof j.reason === 'string' ? j.reason : undefined
	};
}

/** `origin-slots.mjs status <buildDir>`: applied origin ('-' for none), or null when not recorded. */
export function originStatus(
	installDir: string,
	buildDir: string,
	run: Run = realRun
): { recorded: boolean; applied: string | null; pending: boolean } {
	const script = join(installDir, ORIGIN_SCRIPT_REL);
	if (!existsSync(script)) return { recorded: false, applied: null, pending: false };
	const j = lastJsonLine(run(process.execPath, [script, 'status', buildDir]).stdout);
	if (j === null || j.recorded !== true) return { recorded: false, applied: null, pending: false };
	return {
		recorded: true,
		applied: typeof j.applied_origin === 'string' ? j.applied_origin : '-',
		pending: j.pending === true
	};
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** verify.json entries whose file is missing or hashes differently. */
export function verifyJsonMismatches(buildDir: string): string[] {
	const p = join(buildDir, 'verify.json');
	if (!existsSync(p)) return [];
	const hm =
		(JSON.parse(readFileSync(p, 'utf8')) as { hash_manifest?: Record<string, string> })
			.hash_manifest ?? {};
	const bad: string[] = [];
	for (const [rel, hex] of Object.entries(hm)) {
		const f = join(buildDir, rel);
		if (!existsSync(f) || sha256(readFileSync(f)) !== hex) bad.push(rel);
	}
	return bad;
}

const canonicalOf = (html: string): string | null =>
	/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']*)["']/i.exec(html)?.[1] ??
	/<link\b[^>]*\bhref=["']([^"']*)["'][^>]*\brel=["']canonical["']/i.exec(html)?.[1] ??
	null;

/**
 * OBSERVE the origin on a build (or a web root holding a copy of it): the map,
 * every recorded file, a page's canonical link, verify.json. PURE apart from
 * reading files.
 */
export function checkOriginApplied(
	buildDir: string,
	origin: string,
	servedDir: string = buildDir
): {
	ok: boolean;
	canonical: string | null;
	page: string | null;
	problems: string[];
	notes: string[];
} {
	const problems: string[] = [];
	const notes: string[] = [];
	const mapPath = join(buildDir, '.origin-slots.json');
	if (!existsSync(mapPath))
		return { ok: true, canonical: null, page: null, problems: [], notes: [] };
	const map = JSON.parse(readFileSync(mapPath, 'utf8')) as {
		build_origin: string;
		applied_origin: string;
		files: Record<string, unknown>;
	};
	const want = origin === '-' ? '' : origin;
	if (map.applied_origin !== want)
		problems.push(
			`the build records ${map.applied_origin || 'no origin'}, not ${want || 'no origin'}`
		);
	const files = Object.keys(map.files);
	if (map.build_origin !== want) {
		// The SEO files must not name the build origin at all. A page may still
		// carry it outside the recorded places (fixed meta tags of the web app's
		// page template): counted, and a problem only where no clearnet URL may
		// appear (no origin, or a Tor/I2P one).
		const pagesLeft: string[] = [];
		for (const rel of files) {
			const f = join(servedDir, rel);
			if (!existsSync(f) || !readFileSync(f, 'utf8').includes(map.build_origin)) continue;
			if (rel.endsWith('.html')) pagesLeft.push(rel);
			else problems.push(`${rel} still names ${map.build_origin}`);
		}
		if (pagesLeft.length > 0) {
			const msg = `${pagesLeft.length} page(s) still carry ${map.build_origin} outside the recorded places (fixed meta tags of the page template, e.g. ${pagesLeft[0]})`;
			if (want === '' || isHiddenServiceOrigin(want)) problems.push(msg);
			else notes.push(msg);
		}
	}
	const page =
		files.find((rel) => rel.endsWith('.html') && existsSync(join(servedDir, rel))) ?? null;
	const canonical = page === null ? null : canonicalOf(readFileSync(join(servedDir, page), 'utf8'));
	if (page !== null && canonical !== null) {
		const good =
			want === ''
				? canonical.startsWith('/') && !/^\/\//.test(canonical)
				: canonical.startsWith(`${want}/`) || canonical === want;
		if (!good) problems.push(`${page}: canonical is ${canonical}`);
	}
	const bad = verifyJsonMismatches(servedDir);
	if (bad.length > 0)
		problems.push(
			`verify.json does not match ${bad.length} file(s): ${bad.slice(0, 5).join(', ')}`
		);
	return { ok: problems.length === 0, canonical, page, problems, notes };
}

/**
 * Put `origin` on the build (resetting and re-applying the branding around it
 * when the build is branded), mirror what changed into a bare-metal web root,
 * then observe the result. `strategy` says which path was taken.
 */
export function syncInstanceOrigin(
	ctx: HealCtx,
	opts: {
		readonly installDir: string;
		readonly buildDir?: string;
		readonly origin?: { origin: string; why: string };
		readonly webRoot?: string | null;
		readonly run?: Run;
	}
): HealResult & { touched: string[]; origin: string } {
	const buildDir = opts.buildDir ?? buildDirOf(opts.installDir);
	const run = opts.run ?? realRun;
	const { origin, why } = opts.origin ?? resolveInstanceOrigin(opts.installDir);
	const label = origin === '-' ? 'no absolute URLs' : origin;
	// Every wait below is under the caller's spinner (`origin-slots.mjs` runs
	// for up to 300 s; the branding reset/re-apply rasterizes images).
	const spun = <T>(what: string, fn: () => T): T => {
		const stop = ctx.spinner(what);
		try {
			return fn();
		} finally {
			stop();
		}
	};
	const st = spun('Reading which origin the served pages carry…', () =>
		originStatus(opts.installDir, buildDir, run)
	);
	if (!st.recorded) {
		return { strategy: 'no-map', verified: true, detail: '', touched: [], origin };
	}
	const touched = new Set<string>();
	let strategy = 'already';
	const stopApply =
		st.applied !== origin || st.pending
			? ctx.spinner(`Putting ${label} on the served pages…`)
			: () => {};
	try {
		if (st.applied !== origin || st.pending) {
			const settings = readBrandingSettings(opts.installDir);
			let branded = false;
			const reset = applyBranding({ buildDir, settings, reset: true });
			reset.touched.forEach((t) => touched.add(t));
			branded = reset.touched.length > 0;
			const a = runOriginApply(opts.installDir, buildDir, origin, run);
			if (!a.ok) {
				// Put the branding back on whatever is there, then say so.
				const back = applyBranding({ buildDir, settings });
				back.touched.forEach((t) => touched.add(t));
				mirror(buildDir, opts.webRoot, [...touched]);
				return {
					strategy: 'failed',
					verified: false,
					detail: `Your instance origin could not be applied (${a.error}); pages name the build's origin until fixed. Run: sudo morphit-ops upgrade`,
					touched: [...touched],
					origin
				};
			}
			a.touched.forEach((t) => touched.add(t));
			if (brandingConfigured(settings) || branded) {
				applyBranding({ buildDir, settings }).touched.forEach((t) => touched.add(t));
			}
			strategy = branded ? 'applied-around-branding' : 'applied';
		}
	} finally {
		stopApply();
	}
	const served = opts.webRoot && existsSync(opts.webRoot) ? opts.webRoot : buildDir;
	const seen = spun(`Checking the served pages name ${label}…`, () => {
		mirror(buildDir, opts.webRoot, [...touched]);
		return checkOriginApplied(buildDir, origin, served);
	});
	if (!seen.ok) {
		return {
			strategy: `${strategy}-unverified`,
			verified: false,
			detail: `Instance origin (${label}; ${why}): applied, but the served pages do not show it — ${seen.problems.slice(0, 3).join('; ')}. Run: sudo morphit-ops upgrade`,
			touched: [...touched],
			origin
		};
	}
	return {
		strategy,
		verified: true,
		detail:
			strategy === 'already'
				? ''
				: origin === '-'
					? `✓ Pages, sitemap and robots.txt now carry no absolute URLs (${why}; canonical of ${seen.page}: ${seen.canonical}).`
					: `✓ Pages, sitemap and robots.txt now name ${origin} (canonical of ${seen.page}: ${seen.canonical}).${seen.notes.length > 0 ? ` Note: ${seen.notes.join('; ')}.` : ''}`,
		touched: [...touched],
		origin
	};
}

/** Where origin-slots keeps the slot forms a no-origin apply does not serve. */
const HELD_DIR = '.origin-held';

/** Regular files under `root/dir`, as paths relative to `root` (links skipped). */
function filesUnder(root: string, dir: string): string[] {
	const out: string[] = [];
	const walkDir = (rel: string): void => {
		let names: string[];
		try {
			if (!lstatSync(join(root, rel)).isDirectory()) return;
			names = readdirSync(join(root, rel));
		} catch {
			return;
		}
		for (const n of names) {
			const r = `${rel}/${n}`;
			const st = lstatSync(join(root, r));
			if (st.isDirectory()) walkDir(r);
			else if (st.isFile()) out.push(r);
		}
	};
	walkDir(dir);
	return out;
}

/** Remove the empty directories under (and including) `root/dir`; never follows a link. */
function pruneEmptyDirs(root: string, dir: string): void {
	const p = join(root, dir);
	let st;
	try {
		st = lstatSync(p);
	} catch {
		return;
	}
	if (!st.isDirectory()) return;
	for (const n of readdirSync(p)) pruneEmptyDirs(root, `${dir}/${n}`);
	if (readdirSync(p).length === 0) rmdirSync(p);
}

/**
 * Copy what the apply changed into a bare-metal web root. `.origin-held/`
 * appears and disappears between applies (and an older copy may still hold
 * one), so the web root's copy is made to match the build's exactly: every
 * held file copied, every other one deleted, empty folders removed.
 */
function mirror(buildDir: string, webRoot: string | null | undefined, touched: string[]): void {
	if (!webRoot || !existsSync(webRoot)) return;
	const held = new Set([...filesUnder(buildDir, HELD_DIR), ...filesUnder(webRoot, HELD_DIR)]);
	const all = [...new Set([...touched, ...held])];
	if (all.length > 0) syncTouchedToWebRoot(buildDir, webRoot, all);
	pruneEmptyDirs(webRoot, HELD_DIR);
}
