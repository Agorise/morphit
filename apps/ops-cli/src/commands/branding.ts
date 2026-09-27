/**
 * morphit-ops branding [status | setup | apply | reset] — per-instance site branding.
 *
 * Re-brands THIS instance's served frontend in place (logo, favicon + app
 * icons, the site's name wherever the UI names the site, the BETA marker)
 * without rebuilding it, so the canonical bytes the on-chain build-integrity
 * check covers stay untouched. See docs/BRANDING.md and src/lib/branding.ts.
 *
 * Inputs (both survive upgrades):
 *   /etc/morphit/branding/   logo.svg, logo-footer.svg, icon.svg, optional
 *                            PNG icons, optional static/ overlay
 *   morphit.config.env       MORPHIT_INSTANCE_BRAND_NAME,
 *                            MORPHIT_INSTANCE_BRAND_SHORT_NAME,
 *                            MORPHIT_INSTANCE_BETA_BADGE
 *
 * `morphit-ops upgrade` re-applies the branding automatically on every
 * upgrade, so an operator sets it up ONCE. This command applies it right now
 * (after a change), shows what is configured, or resets to plain Morphit.
 *
 * Subcommands:
 *   status (default)  what is configured, and whether the served build matches
 *   setup             guided: asks for the logo files and the name, then applies
 *                     (the menu's "Branding" item)
 *   apply             apply now; publishes to a bare-metal web root when present
 *                     (a container frontend bind-mounts the build — live at once)
 *   reset             serve the plain Morphit look again (config is kept, so the
 *                     next upgrade re-applies it unless you remove it)
 * Flags: --dry-run (apply/reset: show what would change), --json
 *
 * One-command setup (apply only) — installs the inputs, then applies:
 *   --logo FILE          header + homepage logo      → /etc/morphit/branding/logo.svg
 *   --logo-footer FILE   footer logo                 → …/logo-footer.svg
 *   --icon FILE          favicon + app icons symbol  → …/icon.svg
 *   --name "TEXT"        the site's name             → MORPHIT_INSTANCE_BRAND_NAME
 *   --short-name "TEXT"  home-screen label           → MORPHIT_INSTANCE_BRAND_SHORT_NAME
 *   --beta on|off|auto   the red BETA marker         → MORPHIT_INSTANCE_BETA_BADGE
 * Each file is validated before it is copied; config lines are written to the
 * install's morphit.config.env (backed up first), like `morphit-ops edit`.
 * An empty value (--name=) removes the setting.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_BRAND_NAME, sanitizeBrandName, INSTANCE_ENV } from '@morphit/operator-config';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import {
	applyBranding,
	brandingPaths,
	BRANDING_FILE_FLAGS,
	brandConfigFiles,
	brandNameProblem,
	installBrandingFile,
	buildDirOf,
	normalizeSvg,
	readBrandingSettings,
	syncTouchedToWebRoot,
	type BrandingResult,
	type BrandingSettings
} from '../lib/branding.ts';
import { resolveWebRoot } from './upgrade.ts';
import { atomicEnvWrite } from './edit.ts';
import { ask, askYesNo } from '../init/prompt.ts';
import { isHiddenOnlyNode } from '../lib/hiddenOnly.ts';
import { info, warn, error as printError, sanitizeForTerm } from '../render/term.ts';

export interface BrandingCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

const INPUT_FILES = [
	'logo.svg',
	'logo-footer.svg',
	'icon.svg',
	'app-icon-192.png',
	'app-icon-512.png',
	'app-icon-maskable-512.png',
	'apple-touch-icon.png',
	'static/'
];

function describeSettings(s: BrandingSettings): void {
	info(
		`  Brand name:     ${s.brandName === null ? 'Morphit (MORPHIT_INSTANCE_BRAND_NAME not set)' : `"${sanitizeForTerm(s.brandName)}"`}`
	);
	if (s.invalidBrandName !== null) {
		warn(
			`  MORPHIT_INSTANCE_BRAND_NAME="${sanitizeForTerm(s.invalidBrandName)}" is not usable — see docs/BRANDING.md`
		);
	}
	if (s.shortName !== null) info(`  Home-screen:    "${sanitizeForTerm(s.shortName)}"`);
	info(`  BETA marker:    ${s.betaBadge ?? 'automatic (off when you supply logo.svg)'}`);
	info(`  Branding files: ${s.dir}`);
	const hasIcon = existsSync(`${s.dir}/icon.svg`);
	for (const f of INPUT_FILES) {
		const present = existsSync(`${s.dir}/${f}`);
		const absent =
			f === 'logo-footer.svg'
				? '(optional — the footer uses logo.svg)'
				: f.endsWith('.png')
					? hasIcon
						? '(optional — made from icon.svg)'
						: '(optional)'
					: f === 'static/'
						? '(optional)'
						: '(not provided)';
		info(`    ${present ? '✓' : '·'} ${f}${present ? '' : `  ${absent}`}`);
	}
}

/** The home directory of the person who ran sudo (for "~/logo.svg"). */
function callerHome(env: NodeJS.ProcessEnv): string {
	const user = env.SUDO_USER;
	if (user && /^[a-z_][a-z0-9_.-]*\$?$/i.test(user)) {
		const r = spawnSync('getent', ['passwd', user], { encoding: 'utf8', timeout: 5000 });
		const home = r.status === 0 ? r.stdout.split(':')[5] : undefined;
		if (home) return home.trim();
	}
	return env.HOME ?? '/root';
}

/**
 * Resolve a file path the operator typed against THEIR working directory.
 * The Ansible-installed `morphit-ops` launcher `cd`s into the install and
 * `npm exec --workspace` then runs this CLI from apps/ops-cli, so a plain
 * `--logo my-logo.svg` used to be looked up there. The launcher now passes the
 * caller's directory (MORPHIT_OPS_CALLER_CWD); an older launcher is detected by
 * npm's INIT_CWD being the install while we run from apps/ops-cli, where the
 * shell's `cd` left the caller's directory in OLDPWD. Also expands "~/".
 */
export function resolveCallerPath(
	typed: string,
	installDir: string,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd()
): string {
	let p = typed.trim().replace(/^['"]|['"]$/g, '');
	if (p === '~' || p.startsWith('~/')) p = join(callerHome(env), p.slice(1));
	if (isAbsolute(p)) return p;
	let base = cwd;
	if (env.MORPHIT_OPS_CALLER_CWD && isAbsolute(env.MORPHIT_OPS_CALLER_CWD)) {
		base = env.MORPHIT_OPS_CALLER_CWD;
	} else if (
		env.INIT_CWD !== undefined &&
		resolve(env.INIT_CWD) === resolve(installDir) &&
		resolve(cwd) === resolve(installDir, 'apps', 'ops-cli') &&
		env.OLDPWD !== undefined &&
		isAbsolute(env.OLDPWD)
	) {
		base = env.OLDPWD;
	}
	return resolve(base, p);
}

function report(r: BrandingResult, verb: string): void {
	for (const n of r.notes) info(`  • ${sanitizeForTerm(n)}`);
	for (const w of r.warnings) warn(sanitizeForTerm(w));
	const files = r.touched.filter((t) => !/\.(gz|br)$/.test(t));
	info(
		files.length === 0
			? `Nothing to ${verb} — the served build already matches.`
			: `${files.length} file(s) ${verb === 'apply' ? 'updated' : 'would change'}.`
	);
}

/**
 * The PNG icons and iOS launch screens are rasterized from the operator's SVGs
 * by rsvg-convert (librsvg2-bin) or ImageMagick. Neither is part of a Morphit
 * install (footprint), so when they are missing and someone is at the
 * keyboard, offer to install the small one — on Debian/Ubuntu, via apt, which
 * already carries this box's updates. Returns true once it is installed.
 */
async function offerRasterizer(): Promise<boolean> {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
	if (spawnSync('sh', ['-c', 'command -v apt-get'], { stdio: 'ignore' }).status !== 0) return false;
	if (isHiddenOnlyNode()) {
		// A hidden-only (Tor/I2P-only) node must not be nudged into a clearnet
		// package download. Say what is needed; the operator installs it through
		// whatever private route their box uses for updates.
		info('');
		info('The home-screen icons and iPhone/iPad launch screens need the image converter');
		info('librsvg2-bin. This node reads the network over hidden services only, so it is not');
		info('installed automatically — install it the way you install updates on this box, then');
		info('run: sudo morphit-ops branding apply');
		return false;
	}
	info('');
	info('Your home-screen icons and iPhone/iPad launch screens are drawn from your SVG files by a');
	info('small image converter (librsvg2-bin) that this server does not have yet.');
	if (!(await askYesNo('Install it now (apt-get install librsvg2-bin)?', true))) {
		info('  Later: sudo apt install librsvg2-bin && sudo morphit-ops branding apply');
		return false;
	}
	const r = spawnSync('apt-get', ['install', '-y', '--no-install-recommends', 'librsvg2-bin'], {
		stdio: 'inherit',
		env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
		timeout: 15 * 60_000
	});
	if (r.status !== 0) {
		warn('Could not install librsvg2-bin. Try: sudo apt update && sudo apt install librsvg2-bin');
		return false;
	}
	return true;
}

/** Ask for an SVG file until it is valid, or Enter (keep what is there). */
async function askSvg(
	question: string,
	current: boolean,
	installDir: string
): Promise<string | null> {
	for (;;) {
		const raw = (
			await ask(
				`${question}\n  (path to an .svg file${current ? '; Enter keeps the current one' : '; Enter skips'})`
			)
		).trim();
		if (raw === '') return null;
		const path = resolveCallerPath(raw, installDir);
		try {
			normalizeSvg(readFileSync(path), path);
			return path;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			warn(
				/ENOENT/.test(msg)
					? `  No file at ${sanitizeForTerm(path)} — try again (the full path, e.g. /home/you/logo.svg, always works).`
					: `  ${sanitizeForTerm(msg)}`
			);
		}
	}
}

/**
 * `morphit-ops branding setup` — the guided form of `apply --logo … --name …`
 * (what the menu runs): show what is set, ask for each file and the name,
 * then install and apply. Enter keeps each current value.
 */
async function runSetup(ctx: BrandingCtx, installDir: string): Promise<number> {
	if (process.stdin.isTTY !== true) {
		printError(
			'branding setup asks questions — run it in a terminal, or use: sudo morphit-ops branding apply --logo FILE --icon FILE --name "…"'
		);
		return 2;
	}
	const settings = readBrandingSettings(installDir);
	info('Per-instance branding (docs/BRANDING.md)');
	describeSettings(settings);
	info('');
	if (!(await askYesNo('Change your branding now?', false))) return 0;
	const has = (f: string): boolean => existsSync(join(settings.dir, f));
	const flags: Record<string, string> = {};
	info('');
	const logo = await askSvg(
		'Your logo for the header and the homepage?',
		has('logo.svg'),
		installDir
	);
	if (logo !== null) flags.logo = logo;
	const footer = await askSvg(
		'Your logo for the footer? (often the same logo, or just the wordmark)',
		has('logo-footer.svg'),
		installDir
	);
	if (footer !== null) flags['logo-footer'] = footer;
	const icon = await askSvg(
		'Your icon — the small square symbol for the browser tab and phone home screen?',
		has('icon.svg'),
		installDir
	);
	if (icon !== null) flags.icon = icon;
	for (;;) {
		const current = settings.brandName ?? 'Morphit';
		const raw = (
			await ask(
				`Your site's name? It replaces "Morphit" wherever the site names itself ("Sign in to …").\n  (Enter keeps "${current}")`
			)
		).trim();
		if (raw === '' || raw === current) break;
		if (raw === 'Morphit') {
			flags.name = '';
			break;
		}
		const problem = brandNameProblem(raw);
		if (problem !== null) {
			warn(`  That name can't be used: ${problem}. Try again.`);
			continue;
		}
		flags.name = raw;
		break;
	}
	if (Object.keys(flags).length === 0) {
		info('Nothing changed.');
		return 0;
	}
	info('');
	return runBranding({
		flags: { ...flags },
		positional: ['apply'],
		colorEnabled: ctx.colorEnabled
	});
}

/** Config settings `apply` can write, by flag. */
const CONFIG_FLAGS = {
	name: INSTANCE_ENV.BRAND_NAME,
	'short-name': INSTANCE_ENV.BRAND_SHORT_NAME,
	beta: INSTANCE_ENV.BETA_BADGE
} as const;

/**
 * `apply --logo … --name …`: install the operator's inputs before applying.
 * Every value is validated first; nothing is written unless all are valid.
 * Returns an error message, or null when everything was installed.
 */
function installInputs(ctx: BrandingCtx, installDir: string, brandDir: string): string | null {
	const files: Array<[string, string, string]> = [];
	for (const [flag, name] of Object.entries(BRANDING_FILE_FLAGS)) {
		const v = ctx.flags[flag];
		if (v === undefined) continue;
		if (v === 'true' || v.trim() === '')
			return `--${flag} needs a file: --${flag} /path/to/${name}`;
		files.push([flag, name, resolveCallerPath(v, installDir)]);
	}
	const updates = new Map<string, string | null>();
	for (const [flag, key] of Object.entries(CONFIG_FLAGS)) {
		const raw = ctx.flags[flag];
		if (raw === undefined) continue;
		if (raw === 'true') return `--${flag} needs a value: --${flag}="…"  (--${flag}= removes it)`;
		const v = raw.trim();
		if (v === '' || (flag === 'beta' && v.toLowerCase() === 'auto')) {
			updates.set(key, null);
			continue;
		}
		if (flag === 'beta') {
			if (!['on', 'off'].includes(v.toLowerCase())) return '--beta takes on, off or auto';
			updates.set(key, v.toLowerCase());
			continue;
		}
		const problem = brandNameProblem(v);
		if (problem !== null) return `--${flag}="${sanitizeForTerm(v)}" can't be used: ${problem}`;
		const clean = sanitizeBrandName(v)!;
		// "Morphit" is the unbranded default: remove the setting rather than
		// store it (an explicit "Morphit" would rewrite the Polish/Persian
		// inflected forms to the Latin word).
		updates.set(key, clean === DEFAULT_BRAND_NAME ? null : clean);
	}
	const configPath = join(installDir, 'morphit.config.env');
	if (updates.size > 0 && !existsSync(configPath)) {
		return `No morphit.config.env at ${configPath} — run this on the Morphit server (or set it with: sudo morphit-ops edit).`;
	}
	// Validate every file before copying any, so a bad one changes nothing.
	for (const [flag, name, src] of files) {
		try {
			normalizeSvg(readFileSync(src), name);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return `--${flag} ${sanitizeForTerm(src)}: ${/ENOENT/.test(msg) ? 'no such file (give the full path, e.g. /home/you/logo.svg)' : msg}`;
		}
	}
	for (const [, name, src] of files) {
		const dest = installBrandingFile(brandDir, name, src);
		info(`  ✓ ${sanitizeForTerm(src)} → ${dest}`);
	}
	if (updates.size === 0) return null;
	const result = atomicEnvWrite(configPath, readFileSync(configPath, 'utf8'), updates, 'parseEnv');
	if (!result.ok) return sanitizeForTerm(result.message);
	for (const [k, v] of updates) info(`  ✓ ${k}=${v === null ? '(removed)' : sanitizeForTerm(v)}`);
	info(`    (wrote ${configPath}; previous version kept at ${result.backupPath})`);
	return null;
}

export async function runBranding(ctx: BrandingCtx): Promise<number> {
	const sub = ctx.positional[0] ?? 'status';
	const json = ctx.flags.json === 'true';
	const dryRun = ctx.flags['dry-run'] === 'true';
	const installDir = defaultRepoRoot();
	const buildDir = buildDirOf(installDir);
	if (!existsSync(buildDir)) {
		printError(
			`No web build at ${buildDir}. Run this on the Morphit server, from its install directory.`
		);
		return 1;
	}
	if (sub === 'setup') return runSetup(ctx, installDir);
	if (sub !== 'status' && sub !== 'apply' && sub !== 'reset') {
		printError(
			`Unknown branding subcommand "${sanitizeForTerm(sub)}". Use: status | setup | apply | reset`
		);
		return 2;
	}

	const inputFlags = [...Object.keys(BRANDING_FILE_FLAGS), ...Object.keys(CONFIG_FLAGS)].filter(
		(f) => ctx.flags[f] !== undefined
	);
	if (inputFlags.length > 0) {
		if (sub !== 'apply' || dryRun) {
			printError(
				`--${inputFlags[0]} only works with \`branding apply\` (without --dry-run): it saves the setting, then applies it.`
			);
			return 2;
		}
		let installErr: string | null;
		try {
			installErr = installInputs(ctx, installDir, readBrandingSettings(installDir).dir);
		} catch (err) {
			installErr = err instanceof Error ? err.message : String(err);
		}
		if (installErr !== null) {
			printError(
				/EACCES|EPERM/.test(installErr)
					? 'Permission denied — run with sudo: sudo morphit-ops branding apply …'
					: `Branding not applied: ${sanitizeForTerm(installErr)}`
			);
			return 1;
		}
	}
	const settings = readBrandingSettings(installDir);
	// A value saved here can still be shadowed by the OS environment or a later
	// env file (the services source them last-wins) — say so rather than let the
	// operator wonder why the name did not change.
	const wantedName = ctx.flags.name;
	if (wantedName !== undefined && wantedName !== 'true') {
		const w = wantedName.trim() === '' ? null : sanitizeBrandName(wantedName.trim());
		const want = w === DEFAULT_BRAND_NAME ? null : w;
		if (want !== settings.brandName) {
			const others = brandConfigFiles(installDir).filter((f) => !f.endsWith('morphit.config.env'));
			warn(
				`MORPHIT_INSTANCE_BRAND_NAME is also set elsewhere (the environment, or ${others.join(' / ')}), and that value wins: "${sanitizeForTerm(settings.brandName ?? 'Morphit')}". Remove it there.`
			);
		}
	}

	let result: BrandingResult;
	try {
		result = applyBranding({
			buildDir,
			settings,
			dryRun: sub === 'status' || dryRun,
			reset: sub === 'reset'
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/EACCES|EPERM/.test(msg)) {
			printError(
				`Permission denied writing the web build — run with sudo: sudo morphit-ops branding ${sub}`
			);
		} else {
			printError(`Branding not applied: ${sanitizeForTerm(msg)}`);
		}
		return 1;
	}

	if (result.unsupported) {
		const msg =
			'This frontend build predates per-instance branding (no build/.brand-slots.json). ' +
			'Upgrade Morphit (sudo morphit-ops upgrade) — the upgrade applies your branding automatically.';
		if (json) info(JSON.stringify({ ok: false, unsupported: true, message: msg }));
		else warn(msg);
		return 1;
	}

	let published = 0;
	const webRoot = resolveWebRoot(process.env);
	if (sub !== 'status' && !dryRun && result.touched.length > 0 && existsSync(webRoot)) {
		published = syncTouchedToWebRoot(buildDir, webRoot, result.touched);
	}

	if (json) {
		info(
			JSON.stringify({
				ok: true,
				subcommand: sub,
				dry_run: sub === 'status' || dryRun,
				brand_name: result.brandName,
				beta_badge: result.beta,
				changed: result.touched.filter((t) => !/\.(gz|br)$/.test(t)),
				warnings: result.warnings,
				notes: result.notes,
				rasterizer_missing: result.rasterizerMissing,
				published_to_web_root: published
			})
		);
		return 0;
	}

	info('Per-instance branding (docs/BRANDING.md)');
	describeSettings(settings);
	info('');
	if (sub === 'status') {
		const pending = result.touched.filter((t) => !/\.(gz|br)$/.test(t)).length;
		for (const w of result.warnings) warn(sanitizeForTerm(w));
		info(
			pending === 0
				? '✓ The served build matches this configuration.'
				: `${pending} file(s) differ from this configuration — run: sudo morphit-ops branding apply`
		);
		const pristine = brandingPaths(buildDir).pristineDir;
		if (existsSync(pristine)) info(`  (Canonical originals are kept in ${pristine}.)`);
		else if (pending > 0)
			info('  (Nothing is applied right now — for example after `branding reset`.)');
		return 0;
	}
	report(result, dryRun ? 'change' : 'apply');
	if (!dryRun && result.touched.length > 0) {
		if (published > 0) info(`✓ Published to ${webRoot}.`);
		else info('✓ The frontend serves the build directory directly — live now.');
		info(
			'Visitors see it on their next page load (the app caches the logo/icons, then refreshes them in the background).'
		);
	}
	if (sub === 'apply' && ctx.flags.name !== undefined) {
		info(
			'RSS feed titles pick up the name when the indexer restarts: sudo systemctl restart morphit-indexer'
		);
	}
	if (
		sub === 'apply' &&
		!dryRun &&
		result.rasterizerMissing &&
		ctx.flags['no-rasterizer-offer'] !== 'true' &&
		(await offerRasterizer())
	) {
		info('');
		info('Applying again, now with your icons and launch screens…');
		return runBranding({
			flags: { 'no-rasterizer-offer': 'true' },
			positional: ['apply'],
			colorEnabled: ctx.colorEnabled
		});
	}
	if (sub === 'reset' && !dryRun) {
		info('');
		info(
			'Reset to the plain Morphit look. Your branding settings are still configured, so the next'
		);
		info(
			'`morphit-ops upgrade` will apply them again — to stop that, remove the MORPHIT_INSTANCE_BRAND_*'
		);
		info(
			`/ MORPHIT_INSTANCE_BETA_BADGE lines from morphit.config.env and the files in ${settings.dir}.`
		);
	}
	return 0;
}
