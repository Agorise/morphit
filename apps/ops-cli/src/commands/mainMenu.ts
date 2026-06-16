/**
 * morphit-ops main menu (cp186).
 *
 * When an operator runs bare `morphit-ops` on an interactive
 * terminal, instead of dumping the help text and exiting non-zero
 * we show a grouped, explained menu and let them pick what they
 * want to do — then dispatch to the matching subcommand.  The
 * point is that a sysadmin should never have to memorize or look
 * up the exact subcommand name: the wizard surface IS the
 * discovery layer.
 *
 * Non-interactive invocations (piped stdin, `--no-menu`, CI) keep
 * the old behavior — print help, exit 1 — so scripts that relied
 * on bare `morphit-ops` printing usage are unaffected.
 *
 * Dispatch model: the menu does NOT re-implement any command.  It
 * resolves the operator's choice to a subcommand string (plus any
 * obvious sub-action, e.g. `payment-method list`) and hands back a
 * `MenuSelection`; main.ts re-enters its normal dispatch with that
 * subcommand.  This keeps every command's own config-loading,
 * DB-handling, and teardown in exactly one place.
 */

import { askChoice } from '../init/prompt.ts';
import { fmt } from '../render/term.ts';
import type { MenuAnnotations } from '../lib/menuAnnotations.ts';

export interface MenuSelection {
	/** The subcommand to dispatch, e.g. 'edit', 'upgrade', 'status'. */
	readonly subcommand: string;
	/** Extra positional args to prepend, e.g. ['list'] for
	 *  `payment-method list`.  Usually empty. */
	readonly positional: readonly string[];
}

interface MenuItem {
	readonly label: string;
	readonly blurb: string;
	readonly subcommand: string;
	readonly positional?: readonly string[];
	/** Optional ELI5 recommendation-with-tradeoff, rendered dimmed under
	 *  the blurb. Helps a sysadmin pick by consequence, not just by name
	 *  (e.g. "safe to run anytime", "required before BunkerWeb"). */
	readonly tip?: string;
}

// Grouped by the operator's lifecycle so the menu reads top-to-bottom
// the way you actually run a node: INSTALL the software -> CONFIGURE the
// instance -> SECURE the server -> CHECK & OPERATE it. Within each group
// the most common action is first. Every line has a plain-English blurb
// (pick by intent, not by guessing a name) and most have a dimmed ELI5
// tip with the recommendation/tradeoff. The three "is it OK?" commands
// that sound alike — doctor / health / status — are deliberately
// disambiguated in their blurbs so nobody picks the wrong one.
interface MenuGroup {
	readonly heading: string;
	readonly items: readonly MenuItem[];
}

export const MENU_GROUPS: readonly MenuGroup[] = [
	{
		heading: 'Install & upgrade',
		items: [
			{
				label: 'Install / set up a new node (guided)',
				blurb: 'First-time install: checks prerequisites, runs setup, offers hardening and a PATH shortcut.',
				subcommand: 'install',
				tip: 'Start here on a fresh server. It can also set up firewall hardening and HTTPS for you.'
			},
			{
				label: 'Upgrade to the latest version',
				blurb: 'Check for a newer Morphit release and apply it (with backup + rollback).',
				subcommand: 'upgrade',
				tip: 'Always backs up first and rolls back on failure. A \u201c\u25cf update available\u201d marker shows here when a newer release exists.'
			}
		]
	},
	{
		heading: 'Configure the instance',
		items: [
			{
				label: 'Edit settings',
				blurb: 'Change RPC and other URLs, description/SEO, origin, fees, or your operator tag.',
				subcommand: 'edit',
				tip: 'Safe to revisit anytime. After changing your origin or tag, re-run the on-chain registration below.'
			},
			{
				label: 'Set up a Tor / Lokinet / I2P address',
				blurb: 'Guided: make a privacy-network address (pick the first letters where possible) and show it in your site footer.',
				subcommand: 'alt-address',
				tip: 'Optional. Gives privacy-conscious users a censorship-resistant way to reach your instance.'
			},
			{
				label: 'Manage payment methods',
				blurb: 'List the instance-specific payment-method additions.',
				subcommand: 'payment-method',
				positional: ['list']
			},
			{
				label: 'Show my active public key',
				blurb: 'Verify the correct relay active key is installed (never prints the private key).',
				subcommand: 'show-key',
				tip: 'Read-only and safe — handy to confirm the relay is signing with the key you expect.'
			},
			{
				label: 'Rotate the relay active key',
				blurb: 'Replace the active key (wrong-key recovery, or routine rotation).',
				subcommand: 'edit-active-key',
				tip: 'Most operators never need this. Use it only for key rotation or to recover from a wrong key.'
			},
			{
				label: 'Re-publish my registration on-chain',
				blurb: 'Push your current origin/tag to the federation directory (run after changing either).',
				subcommand: 'register',
				tip: 'Run this after an origin/tag change so other instances and users discover you correctly.'
			}
		]
	},
	{
		heading: 'Secure the server',
		items: [
			{
				label: 'Harden this server',
				blurb: 'Ubuntu/SSH/firewall/fail2ban/TLS + BunkerWeb + backups — generate a personalized checklist and walk each step.',
				subcommand: 'harden',
				tip: 'Recommended for any public server. Safe to re-run — it re-checks what\u2019s still missing.'
			},
			{
				label: 'SSL/TLS certificate (HTTPS)',
				blurb: 'Check your HTTPS certificate expiry + auto-renewal, or get the exact steps to obtain a free Let\u2019s Encrypt cert.',
				subcommand: 'ssl',
				tip: 'Do this before the web firewall below — BunkerWeb needs a valid certificate or it won\u2019t start.'
			},
			{
				label: 'Web firewall (BunkerWeb): install / status',
				blurb: 'Check whether the optional BunkerWeb WAF is running + healthy, and (on a terminal) install + bring it up for you, with confirmations.',
				subcommand: 'bunkerweb',
				tip: 'Optional but recommended for public instances. Needs Docker + a valid HTTPS cert; the installer guides both.'
			}
		]
	},
	{
		heading: 'Check & operate',
		items: [
			{
				label: 'Will my node start? (doctor)',
				blurb: 'Read-only pre-flight: does the config on disk let the indexer + relay BOOT? Use this when the node won\u2019t start.',
				subcommand: 'doctor',
				tip: 'Changes nothing. This is the \u201cwhy won\u2019t it boot?\u201d check — it inspects config, not a running process.'
			},
			{
				label: 'Node health — indexer, relay, services, canary',
				blurb: 'Live check of the RUNNING indexer over HTTP (/v1/health): sync state, last indexed block vs chain head, and lag.',
				subcommand: 'health',
				tip: 'The quickest \u201cis it synced right now?\u201d check. Needs the indexer running; doctor checks config instead.'
			},
			{
				label: 'MCP server (AI-agent discovery): turn on or off',
				blurb: 'The read-only, non-custodial MCP surface that lets AI agents answer \u201cwhere can I buy XMR no-KYC near me\u201d from your orderbook. On by default; this is the off-switch (and on-switch).',
				subcommand: 'mcp',
				tip: 'Holds no keys, signs no trades \u2014 it hands the user off to your web UI for the actual key-signing. Disabling it never affects human traders, only AI-agent discovery.'
			},
			{
				label: 'Matrix alerts: set / clear your alert username',
				blurb: 'Get operator alerts (low balance, service down, security) DM\u2019d to your Matrix account. The matrix-bot auto-starts when you set a username and stops when you clear it.',
				subcommand: 'matrix',
				tip: 'Set your personal MXID (@you:matrix.org) \u2014 NOT a #room alias (that would leak private alerts publicly). You also need a bot account access token in /etc/morphit/matrix-bot.env.'
			},
			{
				label: 'Status dashboard',
				blurb: 'Day-to-day operations: relay balance, queue depth, health, and your last 3 DB backups (with the file path).',
				subcommand: 'status',
				tip: 'Your everyday operational view. If the node won\u2019t boot at all, use doctor; for sync only, use health.'
			},
			{
				label: 'Recent signups',
				blurb: 'Accounts created through this relay.',
				subcommand: 'signups'
			},
			{
				label: 'Failed broadcasts',
				blurb: 'Relay broadcasts that errored.',
				subcommand: 'failed-broadcasts'
			},
			{
				label: 'Pending transfers (drain queue)',
				blurb: 'Relay transfers waiting to settle.',
				subcommand: 'drain-queue'
			},
			{
				label: 'Moderation — review flags & block accounts',
				blurb: 'Review reciprocity / related-account abuse flags, and block or unblock accounts on this instance.',
				subcommand: 'moderation'
			}
		]
	}
];

/**
 * A short, optional suffix appended to a menu item's label from the
 * best-effort annotations: the live version on Upgrade, and an
 * attention marker on Moderation when there are unresolved flags.
 * Colored segments are concatenated (never nested) to keep ANSI codes
 * well-formed. Returns '' when there's nothing to add.
 */
export function itemSuffix(subcommand: string, ann?: MenuAnnotations): string {
	if (ann === undefined) return '';
	if (subcommand === 'upgrade') {
		const { currentVersion: cur, latestVersion: latest } = ann;
		if (cur === null && latest === null) return '';
		const parts: string[] = [];
		if (cur !== null) parts.push(`now: ${cur}`);
		if (latest !== null) parts.push(`latest: ${latest}`);
		let s = '  ' + fmt.dim(`(${parts.join('  ')})`);
		if (cur !== null && latest !== null && cur !== latest) {
			// beta11 item 3 — bold BRIGHT yellow (\x1b[1;93m) so the
			// "update available" marker stays vivid on pale terminal
			// themes where the standard yellow looked near-white.
			s += '  ' + fmt.boldBrightYellow('\u25cf update available');
		}
		return s;
	}
	if (subcommand === 'moderation') {
		const n = ann.unresolvedFlags;
		if (n !== null && n > 0) {
			return '  ' + fmt.yellow(`\u26a0 ${n} to review`);
		}
	}
	if (subcommand === 'status') {
		const st = ann.relayBalanceStatus;
		if (st === 'error') return '  ' + fmt.red('\u{1F6A9} relay balance very low');
		if (st === 'warn') return '  ' + fmt.yellow('\u26a0 relay balance low');
	}
	return '';
}

/** Which attention state (if any) an item's whole LABEL should be
 *  colored for, from the best-effort annotations. Separate from
 *  itemSuffix so the render loop can color the label without nesting
 *  ANSI codes inside the (already-colored) suffix. Returns null when
 *  the line should render in the default color. */
export function itemEmphasis(
	subcommand: string,
	ann?: MenuAnnotations
): 'update' | 'balance-warn' | 'balance-error' | null {
	if (ann === undefined) return null;
	if (subcommand === 'upgrade') {
		const { currentVersion: cur, latestVersion: latest } = ann;
		if (cur !== null && latest !== null && cur !== latest) return 'update';
	}
	if (subcommand === 'status') {
		if (ann.relayBalanceStatus === 'error') return 'balance-error';
		if (ann.relayBalanceStatus === 'warn') return 'balance-warn';
	}
	return null;
}

/**
 * Subcommands that need elevated privileges (sudo / root): they read the
 * root-owned operator config or key files, connect to the database (whose
 * credentials live in that config), or run privileged system operations
 * (docker / systemctl / certbot / writes under /opt/morphit). Run as an
 * unprivileged user they fail with a permission or "no database URL" error.
 * Only `health` (HTTP /v1/health — no config or DB) and Quit run unprivileged.
 *
 * Kept as an explicit allow-list (not "everything except health") so a newly
 * added command is never silently mis-tagged either way — menu-annotations
 * coverage asserts this set against the live menu.
 */
const ROOT_REQUIRED_SUBCOMMANDS: ReadonlySet<string> = new Set([
	'install',
	'upgrade',
	'edit',
	'alt-address',
	'payment-method',
	'show-key',
	'edit-active-key',
	'register',
	'harden',
	'ssl',
	'bunkerweb',
	'doctor',
	'mcp',
	'matrix',
	'status',
	'signups',
	'failed-broadcasts',
	'drain-queue',
	'moderation'
]);

/** A dim "(needs sudo)" tag for the FIRST LINE of menu items that require
 *  elevated privileges. Returns '' for items that run unprivileged. */
export function rootTag(subcommand: string): string {
	return ROOT_REQUIRED_SUBCOMMANDS.has(subcommand) ? '  ' + fmt.dim('(needs sudo)') : '';
}

/**
 * Show the menu and return the operator's selection, or null if
 * they chose to quit.  Caller dispatches the returned subcommand
 * through the normal main() path.
 */
export async function runMainMenu(annotations?: MenuAnnotations): Promise<MenuSelection | null> {
	console.log('');
	console.log('━'.repeat(58));
	console.log('  morphit-ops — what would you like to do?');
	console.log('━'.repeat(58));
	console.log('');
	console.log('  Pick an action below.  (You can also run any of these');
	console.log('  directly, e.g. `morphit-ops status` — run `morphit-ops');
	console.log('  --help` to see every command and its flags.)');
	console.log('');

	// Flatten into a single numbered list, but print group headings
	// inline so the numbering stays continuous and askChoice can map
	// 1:1 to a flat array.
	const flat: MenuItem[] = [];
	const lines: string[] = [];
	for (const group of MENU_GROUPS) {
		lines.push(`  — ${group.heading} —`);
		for (const item of group.items) {
			flat.push(item);
			const emphasis = itemEmphasis(item.subcommand, annotations);
			const label =
				emphasis === 'update'
					? fmt.bold(fmt.yellow(item.label))
					: emphasis === 'balance-error'
						? fmt.bold(fmt.red(item.label))
						: emphasis === 'balance-warn'
							? fmt.yellow(item.label)
							: item.label;
			lines.push(
				`    ${flat.length}. ${label}${rootTag(item.subcommand)}${itemSuffix(item.subcommand, annotations)}`
			);
			lines.push(`        ${item.blurb}`);
			if (item.tip !== undefined) {
				lines.push(`        ${fmt.dim('\u21b3 ' + item.tip)}`);
			}
		}
		lines.push('');
	}
	// The final choice is always Quit.
	const quitIndex = flat.length; // 0-based index into the askChoice array
	lines.push(`    ${flat.length + 1}. Quit`);
	lines.push('        Exit without doing anything.');

	// Print our richly-formatted catalog above, then ask only for a
	// validated number — we pass showList:false so askChoice does NOT
	// re-print all the items (that redundant second list made the
	// screen too tall).
	console.log(lines.join('\n'));
	console.log('');

	const choiceLabels = [...flat.map((i) => i.label), 'Quit'];
	const idx = await askChoice(
		`Enter the number of your choice (1-${choiceLabels.length})`,
		choiceLabels,
		undefined,
		{ showList: false }
	);

	if (idx === quitIndex) {
		return null;
	}
	const chosen = flat[idx]!;
	return {
		subcommand: chosen.subcommand,
		positional: chosen.positional ?? []
	};
}
