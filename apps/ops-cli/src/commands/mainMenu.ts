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
}

// Grouped for scanability.  Order: the things an operator reaches
// for most often (setup, change settings, upgrade) first; the
// read-only operational dashboards next; key/secret management
// last.  Each line gets a one-sentence plain-English blurb so the
// operator picks by intent, not by guessing what a name means.
interface MenuGroup {
	readonly heading: string;
	readonly items: readonly MenuItem[];
}

const MENU_GROUPS: readonly MenuGroup[] = [
	{
		heading: 'Set up & change this instance',
		items: [
			{
				label: 'Install / set up a new node (guided)',
				blurb: 'First-time install: checks prerequisites, runs setup, offers hardening and a PATH shortcut.',
				subcommand: 'install'
			},
			{
				label: 'Check if my node will start (doctor)',
				blurb: 'Read-only: reports whether the indexer and relay will boot with the config on disk. Changes nothing.',
				subcommand: 'doctor'
			},
			{
				label: 'Edit settings',
				blurb: 'Change RPC and other URLs, description/SEO, origin, fees, or your operator tag.',
				subcommand: 'edit'
			},
			{
				label: 'Upgrade to the latest version',
				blurb: 'Check for a newer Morphit release and apply it (with backup + rollback).',
				subcommand: 'upgrade'
			},
			{
				label: 'Harden this server',
				blurb: 'Ubuntu/SSH/firewall/fail2ban/TLS + BunkerWeb + backups — generate a personalized checklist and walk each step.',
				subcommand: 'harden'
			},
			{
				label: 'SSL/TLS certificate (HTTPS)',
				blurb: 'Check your HTTPS certificate expiry + auto-renewal, or get the exact steps to obtain a free Let\u2019s Encrypt cert.',
				subcommand: 'ssl'
			},
			{
				label: 'Web firewall (BunkerWeb) status',
				blurb: 'Check whether the optional BunkerWeb WAF is running and healthy, or get the commands to bring it up.',
				subcommand: 'bunkerweb'
			},
			{
				label: 'Re-publish my registration on-chain',
				blurb: 'Push your current origin/tag to the federation directory (run after changing either).',
				subcommand: 'register'
			}
		]
	},
	{
		heading: 'Check on the instance',
		items: [
			{
				label: 'Status dashboard',
				blurb: 'Relay balance, queue depth, health, and your last 3 DB backups (with the file path) at a glance.',
				subcommand: 'status'
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
	},
	{
		heading: 'Keys & payment methods',
		items: [
			{
				label: 'Show my active public key',
				blurb: 'Verify the correct relay active key is installed (never prints the private key).',
				subcommand: 'show-key'
			},
			{
				label: 'Rotate the relay active key',
				blurb: 'Replace the active key (wrong-key recovery, or routine rotation).',
				subcommand: 'edit-active-key'
			},
			{
				label: 'Manage payment methods',
				blurb: 'List the instance-specific payment-method additions.',
				subcommand: 'payment-method',
				positional: ['list']
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
			s += '  ' + fmt.yellow('\u25cf update available');
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
			lines.push(`    ${flat.length}. ${label}${itemSuffix(item.subcommand, annotations)}`);
			lines.push(`        ${item.blurb}`);
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
