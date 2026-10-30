/**
 * morphit-ops branding [status | setup | apply | reset] — per-instance site branding.
 *
 * Re-brands THIS instance's served frontend in place (logo, favicon + app
 * icons, the site's name wherever the UI names the site, the colours)
 * without rebuilding it, so the canonical bytes the on-chain build-integrity
 * check covers stay untouched. See docs/BRANDING.md and src/lib/branding.ts.
 *
 * Inputs (both survive upgrades):
 *   /etc/morphit/branding/   logo.svg, logo-footer.svg, icon.svg, optional
 *                            PNG icons, optional static/ overlay
 *   morphit.config.env       MORPHIT_INSTANCE_BRAND_NAME,
 *                            MORPHIT_INSTANCE_BRAND_SHORT_NAME
 *                            (a MORPHIT_INSTANCE_BETA_BADGE line from before
 *                            v1.21.5 is ignored: the BETA marker is gone)
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
 * Colour theme (every other colour is derived from these; docs/BRANDING.md):
 *   --theme NAME         preset: morphit (default) | champagne-gold
 *                                                    → MORPHIT_INSTANCE_THEME
 *   --theme-from '#hex'  gradient first stop         → MORPHIT_INSTANCE_THEME_FROM
 *   --theme-mid '#hex'   gradient middle stop (optional; derived otherwise)
 *   --theme-to '#hex'    gradient last stop          → MORPHIT_INSTANCE_THEME_TO
 *   --theme-background '#hex'  page background (dark) → MORPHIT_INSTANCE_THEME_BACKGROUND
 *   --theme-button deep|bright  primary buttons: the last colour deepened with
 *                        white text (deep, Morphit's) or the middle colour with
 *                        dark text (bright)       → MORPHIT_INSTANCE_THEME_BUTTON
 *   A --theme preset replaces the whole theme (colour flags given with it
 *   override its values); `--theme morphit` goes back to the Morphit colours.
 *   The combination is validated (hex only, readable contrast) BEFORE anything
 *   is written; a theme that can't be made readable is refused with a
 *   suggestion.
 * Each file is validated before it is copied; config lines are written to the
 * install's morphit.config.env (backed up first), like `morphit-ops edit`.
 * An empty value (--name=) removes the setting.
 */

import { existsSync, readFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_BRAND_NAME, sanitizeBrandName, INSTANCE_ENV } from '@morphit/operator-config';
import {
	deriveTheme,
	normalizeHex,
	THEME_PRESETS,
	THEME_BUTTON_STYLES,
	themePreset,
	suggestTheme,
	DEFAULT_THEME_PRESET,
	type ThemeInput
} from '@morphit/operator-config/theme';
import { logoColours } from '../lib/brandColours.ts';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import {
	applyBranding,
	brandingPaths,
	BRANDING_FILE_FLAGS,
	MAX_SVG_BYTES,
	brandConfigFiles,
	brandNameProblem,
	installBrandingFile,
	buildDirOf,
	normalizeSvg,
	readBrandingSettings,
	resolveTheme,
	describeTheme,
	themeSettingOf,
	syncTouchedToWebRoot,
	type BrandingResult,
	type BrandingSettings
} from '../lib/branding.ts';
import { resolveWebRoot } from './upgrade.ts';
import { atomicEnvWrite } from './edit.ts';
import { ask, askYesNo } from '../init/prompt.ts';
import { isHiddenOnlyNode } from '../lib/hiddenOnly.ts';
import { startDotsSpinner } from '../init/spinner.ts';
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
	const theme = resolveTheme(s.theme);
	info(`  Colours:        ${sanitizeForTerm(describeTheme(s.theme, theme.palette))}`);
	if (theme.problems.length > 0) {
		warn(`  The colour theme is not usable: ${sanitizeForTerm(theme.problems.join('; '))}`);
	} else if (theme.palette !== null) {
		const t = theme.palette.tokens;
		info(
			`    accent ${t['brand-primary']}, button ${t['brand-btn-face']} with ${t['brand-btn-text'] === '#ffffff' ? 'white' : 'dark'} text, ` +
				`page ${t['surface-950']}, cards ${t['surface-900']}, text ${t['surface-100']}`
		);
	}
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
	const apt = (args: readonly string[], timeoutMs: number): number =>
		spawnSync('apt-get', [...args], {
			stdio: 'inherit',
			env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
			timeout: timeoutMs
		}).status ?? 1;
	const rsvgPresent = (): boolean =>
		spawnSync('sh', ['-c', 'command -v rsvg-convert'], { stdio: 'ignore' }).status === 0;

	// Primary: install straight away (a fresh box often has a usable cache). If
	// that fails — usually a stale/empty apt cache — `apt-get update` then retry.
	let ok = apt(['install', '-y', '--no-install-recommends', 'librsvg2-bin'], 15 * 60_000) === 0;
	if (!ok) {
		info('  Refreshing the package list and trying once more…');
		apt(['update'], 10 * 60_000);
		ok = apt(['install', '-y', '--no-install-recommends', 'librsvg2-bin'], 15 * 60_000) === 0;
	}
	// VERIFY the binary is actually callable now — a 0 exit is not proof the tool
	// landed (a derivative could ship the package without rsvg-convert), and we
	// only want to claim success when the converter really runs.
	if (ok && rsvgPresent()) return true;
	warn(
		'Could not get a working rsvg-convert (librsvg2-bin). Install it by hand, then re-run: ' +
			'sudo apt update && sudo apt install librsvg2-bin && sudo morphit-ops branding apply'
	);
	return false;
}

/**
 * What the three image files must be — shown before branding setup asks for
 * them (and so by the install wizard's branding step). Sizes are what the site
 * actually draws them at (apps/web: MorphitLogoBling in the header, footer and
 * homepage); the byte limit is the one normalizeSvg enforces.
 */
export function brandingFilesGuide(): string[] {
	const mb = MAX_SVG_BYTES / 1024 / 1024;
	const f = BRANDING_FILE_FLAGS;
	return [
		'Your three images — SVG files only (a PNG or JPG is not accepted for these):',
		'',
		`  ${f.logo.padEnd(16)} header (top left) and homepage logo. Shown 32 px tall in the`,
		'                   header and 44–96 px tall on the homepage; its width follows its own',
		'                   shape (Morphit\u2019s wordmark is about 6 wide to 1 tall, ~187 × 32 px in',
		'                   the header). A wide wordmark or a compact logo both work.',
		`  ${f['logo-footer'].padEnd(16)} footer logo, shown 40 px tall. Optional: without it the footer`,
		`                   uses ${f.logo}.`,
		`  ${f.icon.padEnd(16)} the browser-tab and phone home-screen icon: a simple, square`,
		'                   symbol (for example viewBox="0 0 512 512") that still reads at 16 × 16 px.',
		'',
		`  Each file: at most ${mb} MB, with a viewBox (or a width and height in px) so it`,
		'  scales sharply. Nothing in it may be loaded from another file or the internet, and',
		'  it may not contain scripts or links; a picture embedded inside the SVG is fine.',
		'  Your files can have any names — they are saved under the names above, in',
		'  /etc/morphit/branding/.',
		'',
		'  Copy them to this server first, from your own computer (capital -O):',
		'    scp -O my-logo.svg my-footer-logo.svg my-icon.svg you@this-server:~/',
		'',
		'  Colours: your main colour is enough — or say "logo" and they are taken from your',
		'  logo. Every other colour is worked out from it and checked for readability.'
	];
}

/** The theme flags for a suggested theme. `theme: ''` first clears any preset
 *  and middle stop, so the suggestion is applied exactly as shown. */
function suggestedFlags(s: NonNullable<ReturnType<typeof suggestTheme>>): Record<string, string> {
	return {
		theme: '',
		'theme-from': s.from,
		'theme-to': s.to,
		'theme-background': s.background,
		'theme-button': s.button
	};
}

/**
 * The answer to branding setup's colour question, as `apply` flags. PURE.
 *   logo              the colours of the operator's logo (`logos`: SVG texts)
 *   #hex              their main colour; every other colour is worked out
 *   #a #b [#bg]       the gradient's first and last colour (+ page background)
 *   a preset name     morphit | champagne-gold
 */
export function colourAnswer(
	raw: string,
	logos: readonly string[]
): { flags: Record<string, string> } | { error: string } {
	const parts = raw
		.trim()
		.split(/[\s,]+/)
		.filter((x) => x.length > 0);
	const one = parts.length === 1 ? parts[0]!.toLowerCase() : null;
	if (one === 'logo') {
		if (logos.length === 0) {
			return {
				error:
					'there is no logo to take colours from yet — give its file above, or type your main colour, e.g. #d4a017'
			};
		}
		const s = suggestTheme(logos.flatMap((svg) => logoColours(svg)));
		if (s === null) {
			return {
				error:
					'your logo has no colour to take (only black, white or greys) — type your main colour instead, e.g. #d4a017'
			};
		}
		return { flags: suggestedFlags(s) };
	}
	if (one !== null && themePreset(one) !== null) return { flags: { theme: one } };
	if (one !== null) {
		const hex = normalizeHex(one);
		if (hex === null) {
			return {
				error: `"${sanitizeForTerm(parts[0]!)}" is not a colour — type it as hex, like #d4a017`
			};
		}
		const s = suggestTheme([hex]);
		if (s === null) {
			return {
				error: `${hex} is too grey, too dark or too light to be a main colour — pick a clearer colour, or type two: "#f3dca0 #bb872f"`
			};
		}
		return { flags: suggestedFlags(s) };
	}
	if (parts.length >= 2 && parts.length <= 3) {
		// `theme: ''` first: the answer is the whole theme, so a preset's or an
		// earlier middle stop and button style are not left over (review, 2026-10-12).
		const flags: Record<string, string> = {
			theme: '',
			'theme-from': parts[0]!,
			'theme-to': parts[1]!
		};
		if (parts[2] !== undefined) flags['theme-background'] = parts[2];
		return { flags };
	}
	return {
		error:
			'type "logo", your main colour (#d4a017), two or three colours (#f3dca0 #bb872f #181818), or a preset name'
	};
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
	for (const line of brandingFilesGuide()) info(line);
	info('');
	if (!(await askYesNo('Change your branding now?', false))) {
		info('Any time later: sudo morphit-ops branding setup');
		return 0;
	}
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
	// The logos the colours can be taken from: the ones just given, else the ones
	// already installed.
	const logoTexts = (['logo', 'icon', 'logo-footer'] as const)
		.map(
			(k) =>
				flags[k] ??
				(has(BRANDING_FILE_FLAGS[k]) ? join(settings.dir, BRANDING_FILE_FLAGS[k]) : null)
		)
		.flatMap((p) => {
			if (p === null) return [];
			try {
				return [readFileSync(p, 'utf8')];
			} catch {
				return [];
			}
		});
	for (;;) {
		const cur = resolveTheme(settings.theme);
		const raw = (
			await ask(
				'Your colours? Type one of:\n' +
					(logoTexts.length > 0 ? '    logo             take them from your logo\n' : '') +
					'    #d4a017          just your main colour — the rest is worked out from it\n' +
					'    #f3dca0 #bb872f  your gradient\u2019s first and last colour (a third: the dark page background)\n' +
					`    a preset         ${Object.keys(THEME_PRESETS).join(', ')}\n` +
					`  (Enter keeps: ${describeTheme(settings.theme, cur.palette)})`
			)
		).trim();
		if (raw === '') break;
		const answer = colourAnswer(raw, logoTexts);
		if ('error' in answer) {
			warn(`  ${sanitizeForTerm(answer.error)}`);
			continue;
		}
		const themeFlags = answer.flags;
		const problem = themeUpdateProblem(themeFlags, settings.theme ?? null);
		if (problem !== null) {
			warn(`  ${sanitizeForTerm(problem)}. Try again.`);
			continue;
		}
		if (themeFlags['theme-button'] !== undefined) {
			// Worked out for them: show the result before it is used.
			const u = themeUpdates(themeFlags);
			const merged = 'updates' in u ? mergeTheme(settings.theme ?? null, u.updates) : null;
			const shown = resolveTheme(merged);
			info(`  Worked out: ${sanitizeForTerm(describeTheme(merged, shown.palette))}`);
			if (shown.palette !== null) {
				const t = shown.palette.tokens;
				info(
					`    accent ${t['brand-primary']}, button ${t['brand-btn-face']} with ${t['brand-btn-text'] === '#ffffff' ? 'white' : 'dark'} text, ` +
						`page ${t['surface-950']}, cards ${t['surface-900']}, text ${t['surface-100']}`
				);
			}
			if (!(await askYesNo('  Use these colours?', true))) continue;
		}
		Object.assign(flags, themeFlags);
		break;
	}
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
	'short-name': INSTANCE_ENV.BRAND_SHORT_NAME
} as const;

/** Colour-theme settings `apply` can write, by flag. */
export const THEME_FLAGS = {
	theme: INSTANCE_ENV.THEME,
	'theme-from': INSTANCE_ENV.THEME_FROM,
	'theme-mid': INSTANCE_ENV.THEME_MID,
	'theme-to': INSTANCE_ENV.THEME_TO,
	'theme-background': INSTANCE_ENV.THEME_BACKGROUND,
	'theme-button': INSTANCE_ENV.THEME_BUTTON
} as const;
const THEME_COLOUR_FIELD = {
	'theme-from': 'from',
	'theme-mid': 'mid',
	'theme-to': 'to',
	'theme-background': 'background'
} as const;

/**
 * The config lines a set of theme flags writes (null value = remove the line),
 * or an error message. PURE. A `--theme` preset replaces the whole theme (the
 * colour flags given with it override its values); `--theme morphit` (or
 * `--theme=`) removes every theme line — the Morphit colours. Colour flags
 * alone change only their own line; an empty value removes it.
 */
export function themeUpdates(
	flags: Readonly<Record<string, string>>
): { updates: Map<string, string | null> } | { error: string } {
	const updates = new Map<string, string | null>();
	const preset = flags.theme;
	if (preset !== undefined) {
		if (preset === 'true')
			return { error: `--theme needs a name: ${Object.keys(THEME_PRESETS).join(' | ')}` };
		const p = preset.trim().toLowerCase();
		if (p !== '' && themePreset(p) === null) {
			return {
				error: `--theme "${sanitizeForTerm(preset)}" is not a theme — use one of: ${Object.keys(THEME_PRESETS).join(', ')} (or your own colours: --theme-from '#…' --theme-to '#…')`
			};
		}
		for (const key of Object.values(THEME_FLAGS)) updates.set(key, null);
		if (p !== '' && p !== DEFAULT_THEME_PRESET) updates.set(INSTANCE_ENV.THEME, p);
	}
	for (const [flag, field] of Object.entries(THEME_COLOUR_FIELD)) {
		const raw = flags[flag];
		if (raw === undefined) continue;
		if (raw === 'true')
			return {
				error: `--${flag} needs a colour: --${flag} '#${field === 'background' ? '121212' : 'f3dca0'}'`
			};
		const key = THEME_FLAGS[flag as keyof typeof THEME_FLAGS];
		if (raw.trim() === '') {
			updates.set(key, null);
			continue;
		}
		const hex = normalizeHex(raw);
		if (hex === null) {
			return {
				error: `--${flag} "${sanitizeForTerm(raw)}" is not a colour — give a hex colour like '#f3dca0' (quote it: the shell treats # as a comment)`
			};
		}
		updates.set(key, hex);
	}
	const button = flags['theme-button'];
	if (button !== undefined) {
		const b = button.trim().toLowerCase();
		if (b === 'true' || (b !== '' && !(THEME_BUTTON_STYLES as readonly string[]).includes(b))) {
			return {
				error: `--theme-button takes ${THEME_BUTTON_STYLES.join(' or ')} (--theme-button= goes back to the theme's own)`
			};
		}
		updates.set(INSTANCE_ENV.THEME_BUTTON, b === '' ? null : b);
	}
	return { updates };
}

/** Apply theme config updates to the current theme setting. PURE. */
export function mergeTheme(
	current: ThemeInput | null,
	updates: ReadonlyMap<string, string | null>
): ThemeInput | null {
	const base: Record<'preset' | 'from' | 'mid' | 'to' | 'background' | 'button', string | null> = {
		preset: current?.preset ?? null,
		from: current?.from ?? null,
		mid: current?.mid ?? null,
		to: current?.to ?? null,
		background: current?.background ?? null,
		button: current?.button ?? null
	};
	const field: Record<string, keyof typeof base> = {
		[INSTANCE_ENV.THEME]: 'preset',
		[INSTANCE_ENV.THEME_FROM]: 'from',
		[INSTANCE_ENV.THEME_MID]: 'mid',
		[INSTANCE_ENV.THEME_TO]: 'to',
		[INSTANCE_ENV.THEME_BACKGROUND]: 'background',
		[INSTANCE_ENV.THEME_BUTTON]: 'button'
	};
	for (const [k, v] of updates) {
		const f = field[k];
		if (f !== undefined) base[f] = v;
	}
	return themeSettingOf(base);
}

/** Why the theme these flags would produce can't be used, or null. PURE. */
export function themeUpdateProblem(
	flags: Readonly<Record<string, string>>,
	current: ThemeInput | null
): string | null {
	const u = themeUpdates(flags);
	if ('error' in u) return u.error;
	const merged = mergeTheme(current, u.updates);
	if (merged === null) return null;
	const r = deriveTheme(merged);
	return r.ok ? null : `That colour theme can't be used: ${r.problems.join('; ')}`;
}

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
	// v1.21.5: the BETA marker was removed for good. Still parsed as a value
	// flag (main.ts VALUE_FLAGS), so `--beta off` is refused by name instead of
	// leaving "off" behind as a stray argument.
	if (ctx.flags.beta !== undefined) {
		return '--beta is gone: Morphit no longer shows a BETA marker (since v1.21.5). Drop the flag.';
	}
	const updates = new Map<string, string | null>();
	for (const [flag, key] of Object.entries(CONFIG_FLAGS)) {
		const raw = ctx.flags[flag];
		if (raw === undefined) continue;
		if (raw === 'true') return `--${flag} needs a value: --${flag}="…"  (--${flag}= removes it)`;
		const v = raw.trim();
		if (v === '') {
			updates.set(key, null);
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
	// Colour theme: validate the RESULTING theme (current settings + these
	// flags) before anything is written.
	if (Object.keys(THEME_FLAGS).some((f) => ctx.flags[f] !== undefined)) {
		const tu = themeUpdates(ctx.flags);
		if ('error' in tu) return tu.error;
		const merged = mergeTheme(readBrandingSettings(installDir).theme ?? null, tu.updates);
		if (merged !== null) {
			const r = deriveTheme(merged);
			if (!r.ok) return `that colour theme can't be used: ${r.problems.join('; ')}`;
		}
		for (const [k, v] of tu.updates) updates.set(k, v);
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

/** True when at least one of `files` EXISTS but cannot be read by this user
 *  (root-owned config, no sudo) — the case where readBrandingSettings silently
 *  returns "unset" and `branding status` would report a false picture (review
 *  H-17). Injectable `exists`/`access` so the decision is testable (as root,
 *  accessSync never denies, so the real branch only fires for a non-root
 *  operator). PURE given its deps. */
export function anyExistingFileUnreadable(
	files: readonly string[],
	deps: {
		exists?: (p: string) => boolean;
		access?: (p: string) => void;
	} = {}
): boolean {
	const exists = deps.exists ?? existsSync;
	const access = deps.access ?? ((p: string) => accessSync(p, fsConstants.R_OK));
	return files.some((f) => {
		if (!exists(f)) return false;
		try {
			access(f);
			return false;
		} catch {
			return true; // exists but unreadable (EACCES/EPERM)
		}
	});
}

/** The hidden sub-command the CLI runs in a child process to apply branding
 *  (see applyBrandingAsync). Not listed anywhere; operators never type it. */
export const APPLY_CHILD = '__apply-child';
const RESULT_MARK = '__MORPHIT_BRANDING_RESULT__';

type ApplyOpts = Parameters<typeof applyBranding>[0];

/** The child's side: read the options from stdin, apply, print the result. */
async function runApplyChild(): Promise<number> {
	let input = '';
	process.stdin.setEncoding('utf8');
	for await (const chunk of process.stdin) input += chunk as string;
	let out: { ok: true; result: BrandingResult } | { ok: false; message: string };
	try {
		out = { ok: true, result: applyBranding(JSON.parse(input) as ApplyOpts) };
	} catch (err) {
		out = { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
	process.stdout.write(`\n${RESULT_MARK}${JSON.stringify(out)}\n`);
	return 0;
}

/**
 * applyBranding draws the icons and launch screens with rsvg-convert or
 * ImageMagick, one synchronous call after another. Run in THIS process it
 * blocks the event loop, so the spinner shown for it froze on its first frame
 * for the whole wait. Here it runs in a child process (this same CLI, the
 * hidden `branding __apply-child`) while the spinner turns. When this process
 * is not the CLI (a test harness) or the child cannot be started, it runs
 * here, as before.
 */
export async function applyBrandingAsync(
	opts: ApplyOpts,
	/** The child to run (default: this CLI's own entry, `branding __apply-child`). */
	childCmd?: { readonly cmd: string; readonly args: readonly string[] }
): Promise<BrandingResult> {
	const entry = process.argv[1] ?? '';
	const how =
		childCmd ??
		(/(^|[\\/])main\.(ts|js|mjs|cjs)$/.test(entry)
			? { cmd: process.execPath, args: [...process.execArgv, entry, 'branding', APPLY_CHILD] }
			: null);
	if (how === null || process.env.MORPHIT_BRANDING_IN_PROCESS === '1') return applyBranding(opts);
	return new Promise<BrandingResult>((resolvePromise, reject) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const inProcess = (): void => {
			if (settled) return;
			settled = true;
			try {
				resolvePromise(applyBranding(opts));
			} catch (err) {
				reject(err);
			}
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(how.cmd, [...how.args], {
				stdio: ['pipe', 'pipe', 'pipe'],
				env: process.env
			});
		} catch {
			inProcess();
			return;
		}
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (d: string) => (stdout += d));
		child.stderr?.on('data', (d: string) => (stderr = (stderr + d).slice(-4000)));
		child.on('error', inProcess);
		child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			const at = stdout.lastIndexOf(RESULT_MARK);
			if (at < 0) {
				settled = true;
				const how =
					signal !== null ? ` (stopped by ${signal})` : code !== null ? ` (exit code ${code})` : '';
				reject(
					new Error(
						`the branding helper stopped without a result${how}${stderr.trim() !== '' ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`
					)
				);
				return;
			}
			settled = true;
			try {
				const out = JSON.parse(stdout.slice(at + RESULT_MARK.length).split('\n')[0]!) as
					| { ok: true; result: BrandingResult }
					| { ok: false; message: string };
				if (out.ok) resolvePromise(out.result);
				else reject(new Error(out.message));
			} catch (err) {
				reject(err);
			}
		});
		// A child that stops before it reads its input (it failed to start
		// properly, or exited at once) makes this write fail with EPIPE. Without
		// a listener that error would end this whole process; the child's end is
		// what is reported, on 'close' above.
		child.stdin?.on('error', () => {});
		child.stdin?.end(JSON.stringify(opts));
	});
}

export async function runBranding(ctx: BrandingCtx): Promise<number> {
	if (ctx.positional[0] === APPLY_CHILD) return runApplyChild();
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

	const inputFlags = [
		...Object.keys(BRANDING_FILE_FLAGS),
		...Object.keys(CONFIG_FLAGS),
		...Object.keys(THEME_FLAGS)
	].filter((f) => ctx.flags[f] !== undefined);
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
	// A config file that EXISTS but we cannot READ (root-owned, no sudo) makes
	// readBrandingSettings silently return "unset" for every value — so `status`
	// would tell the operator nothing is branded and the build differs, when in
	// truth we just could not see their settings. Detect that and say to re-run
	// with sudo instead of reporting a false picture (review H-17).
	const configUnreadable = anyExistingFileUnreadable(brandConfigFiles(installDir));
	if (configUnreadable && sub === 'status') {
		if (json) {
			info(
				JSON.stringify({
					ok: false,
					needs_sudo: true,
					message: 'branding config is not readable as this user'
				})
			);
		} else {
			warn(
				"Can't read this instance's branding config as the current user, so its settings " +
					'cannot be shown. Re-run with sudo: sudo morphit-ops branding status'
			);
		}
		return 1;
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
	// Rasterizing the icons and launch screens takes a while: the spinner's
	// label is on the line for it (to stderr under --json, so stdout stays JSON).
	const spinOut = json ? process.stderr : process.stdout;
	const stopApply = startDotsSpinner(
		sub === 'status' || dryRun
			? 'Comparing the served build with your branding…'
			: sub === 'reset'
				? 'Putting back the plain Morphit look…'
				: 'Applying your branding (drawing the icons and launch screens)…',
		spinOut
	);
	try {
		result = await applyBrandingAsync({
			buildDir,
			settings,
			dryRun: sub === 'status' || dryRun,
			reset: sub === 'reset'
		});
		stopApply();
	} catch (err) {
		stopApply();
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
		const stopCopy = startDotsSpinner(`Copying the changed files to ${webRoot}…`, spinOut);
		try {
			published = syncTouchedToWebRoot(buildDir, webRoot, result.touched);
		} finally {
			stopCopy();
		}
	}

	if (json) {
		info(
			JSON.stringify({
				ok: true,
				subcommand: sub,
				dry_run: sub === 'status' || dryRun,
				brand_name: result.brandName,
				changed: result.touched.filter((t) => !/\.(gz|br)$/.test(t)),
				warnings: result.warnings,
				notes: result.notes,
				rasterizer_missing: result.rasterizerMissing,
				og_image_sha256: result.ogImageSha256,
				theme:
					result.theme === null
						? null
						: { inputs: result.theme.inputs, tokens: result.theme.tokens },
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
		info(
			`  Link preview:   ${result.ogImageSha256 !== null ? 'og-image.png is your own' : 'og-image.png is the shipped Morphit image'}`
		);
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
			`/ MORPHIT_INSTANCE_THEME* lines from morphit.config.env and the files in ${settings.dir}.`
		);
		info('(Just the colours: sudo morphit-ops branding apply --theme morphit)');
	}
	return 0;
}
