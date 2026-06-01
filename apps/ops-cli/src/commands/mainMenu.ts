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
				label: 'Edit settings',
				blurb: 'Change RPC URLs, description/SEO, origin, fees, or your operator tag.',
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
				label: 'Re-publish my registration on-chain',
				blurb: 'Push your current origin/tag to the federation directory (run after changing either).',
				subcommand: 'register'
			},
			{
				label: 'Run the first-time setup wizard',
				blurb: 'Full from-scratch setup.  On an already-configured instance this warns first.',
				subcommand: 'init'
			}
		]
	},
	{
		heading: 'Check on the instance (read-only)',
		items: [
			{
				label: 'Status dashboard',
				blurb: 'Relay balance, queue depth, and health at a glance.',
				subcommand: 'status'
			},
			{
				label: 'Recent signups',
				blurb: 'Accounts created through this relay.',
				subcommand: 'signups'
			},
			{
				label: 'Abuse alerts',
				blurb: 'Abuse signals raised in the last 24h.',
				subcommand: 'abuse'
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
				label: 'Moderation flags',
				blurb: 'Reciprocity / related-account flags raised for review.',
				subcommand: 'flags'
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
 * Show the menu and return the operator's selection, or null if
 * they chose to quit.  Caller dispatches the returned subcommand
 * through the normal main() path.
 */
export async function runMainMenu(): Promise<MenuSelection | null> {
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
			lines.push(`    ${flat.length}. ${item.label}`);
			lines.push(`        ${item.blurb}`);
		}
		lines.push('');
	}
	// The final choice is always Quit.
	const quitIndex = flat.length; // 0-based index into the askChoice array
	lines.push(`    ${flat.length + 1}. Quit`);
	lines.push('        Exit without doing anything.');

	// Print our richly-formatted catalog, then use askChoice purely
	// for validated numeric entry.  askChoice re-renders a compact
	// list too, but the rich blurbs above are what the operator
	// reads; the compact list is harmless reinforcement.
	console.log(lines.join('\n'));
	console.log('');

	const choiceLabels = [...flat.map((i) => i.label), 'Quit'];
	const idx = await askChoice('Enter a number', choiceLabels);

	if (idx === quitIndex) {
		return null;
	}
	const chosen = flat[idx]!;
	return {
		subcommand: chosen.subcommand,
		positional: chosen.positional ?? []
	};
}
