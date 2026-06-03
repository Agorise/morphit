#!/usr/bin/env -S npx tsx
/**
 * Morphit ops CLI — entry point.
 *
 * Usage:
 *   morphit-ops <subcommand> [flags]
 *
 * Subcommands:
 *   init [--check-only] [--out=PATH]    First-time setup wizard (run on a fresh install)
 *   edit [--out=PATH]                   Re-prompt origin / alt-DNS / SEO of an existing config
 *   edit-active-key [--wipe-prior | --keep-backup]
 *                                       Rotate the relay account ACTIVE key.  Interactive by default;
 *                                       --wipe-prior overwrites prior keystore with random bytes + zeros
 *                                       and unlinks (no .bak created — use for compromised/wrong-key
 *                                       recovery).  --keep-backup forces the safe path even for a
 *                                       compromised-key scenario.
 *   import-altnet-key --network=tor|lokinet|i2p --in=PATH
 *                                       Encrypt an alt-network service key with the relay passphrase
 *   export-altnet-key --network=tor|lokinet|i2p [--out=PATH]
 *                                       Decrypt an alt-network service key (passphrase prompted)
 *   register                            Publish operator registration on-chain (run after init)
 *   show-key                            Show the PUBLIC key your saved active key derives to (verify
 *                                       the right key is installed; never prints the private key)
 *   payment-method add|remove|list      Manage instance-specific payment-method additions (ADR-0021)
 *   upgrade [--check-only] [--yes] [--json]
 *                                       Check for and apply a newer Morphit release
 *   status                              Operator dashboard at a glance
 *   drain-queue [--age=DUR]             List pending relay transfers
 *   signups [--since=DUR]               Recent signups via this relay
 *   abuse [--since=DUR]                 Recent abuse alerts (24h default)
 *   failed-broadcasts [--since=DUR]     Relay broadcasts that errored
 *   loyalty [--since=DUR]               Loyalty milestones triggered
 *   attestations                        Pending fee-attestation queue
 *   flags [--type=reciprocity|related]  Moderation flags raised
 *
 * Sally-operator finding So-2 (Part 119): pre-fix this JSDoc was
 * partial — listed only 8 of 14 subcommands.  Operators reading
 * the source to confirm the help is canonical found a drift
 * between source-level docs and the runtime printHelp() output.
 * Now identical to printHelp; both are the source-of-truth.
 *
 * Global flags:
 *   --json          Emit JSON instead of human-formatted output
 *   --no-color      Disable ANSI color even on a TTY
 *   --help, -h      Show this help and exit
 *   --version, -v   Show version and exit
 *
 * Environment:
 *   MORPHIT_OPS_DATABASE_URL    (or MORPHIT_INDEXER_DATABASE_URL,
 *                                or DATABASE_URL) — required.
 *   MORPHIT_OPS_RELAY_ACCOUNT   default: morphit-relay
 *   MORPHIT_OPS_FEES_ACCOUNT    default: morphit-fees
 *   MORPHIT_OPS_THRESHOLD_*     threshold tunables (see config.ts)
 */

import { loadConfig } from './config.ts';
import { createDatabase } from './db.ts';
import { initColor, error as printError, info, sanitizeForTerm } from './render/term.ts';
import { runStatus } from './commands/status.ts';
import { runDrainQueue } from './commands/drainQueue.ts';
import { runSignups } from './commands/signups.ts';
import { runAbuse } from './commands/abuse.ts';
import { runFailedBroadcasts } from './commands/failedBroadcasts.ts';
import { runLoyalty } from './commands/loyalty.ts';
import { runAttestations } from './commands/attestations.ts';
import { runFlags } from './commands/flags.ts';
import { runInit } from './commands/init.ts';
import { runRegister } from './commands/register.ts';
import { runShowKey } from './commands/showKey.ts';
import { runEdit } from './commands/edit.ts';
import { runHarden } from './commands/harden.ts';
import { runInstall } from './commands/install.ts';
import { runMainMenu } from './commands/mainMenu.ts';
import { runEditActiveKey } from './commands/editActiveKey.ts';
import { runUpgrade } from './commands/upgrade.ts';
import { runImportAltnetKey } from './commands/importAltnetKey.ts';
import { runExportAltnetKey } from './commands/exportAltnetKey.ts';
import { runPaymentMethod } from './commands/paymentMethod.ts';

// ─── Tiny arg parser ─────────────────────────────────────────────

interface ParsedArgs {
	readonly subcommand: string | null;
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
	const flags: Record<string, string> = {};
	const positional: string[] = [];
	let i = 0;
	while (i < argv.length) {
		const a = argv[i]!;
		if (a.startsWith('--')) {
			const eqIdx = a.indexOf('=');
			if (eqIdx > 2) {
				const key = a.slice(2, eqIdx);
				const value = a.slice(eqIdx + 1);
				flags[key] = value;
			} else {
				const key = a.slice(2);
				const next = argv[i + 1];
				if (
					next !== undefined &&
					!next.startsWith('-') &&
					// Don't consume the next arg as a value if it looks
					// like a positional (no = and not after a value-
					// expecting flag).  Heuristic: flags we know take
					// values consume; bare flags don't.
					VALUE_FLAGS.has(key)
				) {
					flags[key] = next;
					i += 2;
					continue;
				}
				flags[key] = 'true';
			}
		} else if (a.startsWith('-') && a.length > 1) {
			// Short flags: -h, -v.  Map to long forms.
			const short = a.slice(1);
			const long = SHORT_FLAGS[short];
			if (long !== undefined) {
				flags[long] = 'true';
			}
		} else {
			positional.push(a);
		}
		i++;
	}
	return {
		subcommand: positional[0] ?? null,
		flags,
		positional: positional.slice(1)
	};
}

/** Long-form names of flags that consume the next arg as their
 *  value.  Bare flags (--json, --help) are not in this set. */
const VALUE_FLAGS = new Set(['since', 'age', 'type', 'out']);

const SHORT_FLAGS: Record<string, string> = {
	h: 'help',
	v: 'version'
};

// ─── Help + version ──────────────────────────────────────────────

function printHelp(): void {
	const lines = [
		'morphit-ops — Morphit operator command-line tool',
		'',
		'Usage:',
		'  morphit-ops <subcommand> [flags]',
		'',
		'Subcommands:',
		'  install                         Guided first-time install (checks prereqs, runs setup, offers',
		'                                  hardening, and a PATH shortcut). Start here on a fresh box.',
		'  init [--check-only] [--out=PATH]   First-time setup wizard (run on a fresh install)',
		'  edit [--out=PATH]               Re-prompt origin / alt-DNS / SEO of an existing config',
		'  edit-active-key [--wipe-prior | --keep-backup]',
		'                                  Rotate the relay account ACTIVE key (no full re-init needed;',
		'                                  use this when an operator pasted the wrong key, or for routine',
		'                                  rotation after an on-chain account_update op).  By default the',
		'                                  command asks interactively whether the prior key was wrong',
		'                                  (no-trace rotation, overwrites + unlinks the prior keystore)',
		'                                  or whether to keep a .bak backup (safe rotation; default).',
		'  import-altnet-key --network=tor|lokinet|i2p --in=PATH',
		'                                  Encrypt an alt-network service key with the relay passphrase',
		'  export-altnet-key --network=tor|lokinet|i2p [--out=PATH]',
		'                                  Decrypt an alt-network service key (passphrase prompted)',
		'  register                        Publish operator registration on-chain (run after init)',
		'  show-key                        Show the public key your saved active key derives to',
		'                                  (verify the correct key is installed; never prints the',
		'                                  private key)',
		'  payment-method add|remove|list  Manage instance-specific payment-method additions (ADR-0021)',
		'  upgrade [--check-only] [--yes] [--json]',
		'                                  Check for and apply a newer Morphit release (manual-only',
		'                                  by default; set MORPHIT_AUTO_UPGRADE=1 to skip the prompt)',
		'  harden                          Server-hardening wizard: generate a personalized checklist and',
		'                                  walk Ubuntu/SSH/UFW/fail2ban/TLS + BunkerWeb + backups setup',
		'  status                          Operator dashboard at a glance',
		'  drain-queue [--age=DUR]         List pending relay transfers',
		'  signups [--since=DUR]           Recent signups via this relay',
		'  abuse [--since=DUR]             Recent abuse alerts (24h default)',
		'  failed-broadcasts [--since=DUR] Relay broadcasts that errored',
		'  loyalty [--since=DUR]           Loyalty milestones triggered',
		'  attestations                    Pending fee-attestation queue',
		'  flags [--type=reciprocity|related]  Moderation flags raised',
		'',
		'Global flags:',
		'  --json          Emit JSON instead of human-formatted output',
		'  --no-color      Disable ANSI color even on a TTY',
		'  --help, -h      Show this help and exit',
		'  --version, -v   Show version and exit',
		'',
		'Duration spec (DUR):',
		'  Number followed by s/m/h/d.  Examples: 30s, 5m, 24h, 7d.',
		'',
		'Environment:',
		'  Set MORPHIT_OPS_DATABASE_URL (or MORPHIT_INDEXER_DATABASE_URL,',
		'  or DATABASE_URL) to the Postgres connection string.  Other env',
		'  vars (relay-account name, threshold tunables) have sensible',
		'  defaults; see apps/ops-cli/src/config.ts for the full list.'
	];
	for (const line of lines) info(line);
}

function printVersion(): void {
	// Hardcoded — matches package.json.  Bump in lockstep on
	// release.  Kept as a constant rather than reading the json
	// at runtime to avoid the file-read cost on every invocation.
	info('morphit-ops 0.1.0');
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<number> {
	let args = parseArgs(process.argv.slice(2));

	// Honor --no-color before initColor so the help-print uses
	// the right mode if the user asked for it.
	if (args.flags['no-color'] === 'true') {
		process.env.MORPHIT_OPS_COLOR = 'never';
	}

	if (args.flags.help === 'true' || args.subcommand === 'help') {
		printHelp();
		return 0;
	}
	if (args.flags.version === 'true') {
		printVersion();
		return 0;
	}

	if (args.subcommand === null) {
		// cp186 — bare `morphit-ops` on an interactive terminal opens a
		// menu so the operator can pick an action by intent instead of
		// memorizing subcommand names.  Non-interactive (piped stdin,
		// CI, or explicit --no-menu) keeps the old help-dump + exit 1
		// so scripts are unaffected.
		const interactive = process.stdin.isTTY === true && args.flags['no-menu'] !== 'true';
		if (!interactive) {
			printHelp();
			return 1;
		}
		const selection = await runMainMenu();
		if (selection === null) {
			return 0;
		}
		// Re-enter dispatch with the chosen subcommand by rebuilding
		// args; everything below handles it exactly as if typed.
		args = {
			subcommand: selection.subcommand,
			flags: args.flags,
			positional: selection.positional
		};
	}

	// `init` runs BEFORE loadConfig — it's the wizard that
	// produces the config file in the first place, so requiring
	// MORPHIT_OPS_DATABASE_URL etc. would be a chicken-and-egg
	// problem.  Same for `--check-only`: it just runs the
	// system check and exits, no DB needed.
	if (args.subcommand === 'init') {
		// Color decision before init starts — TTY-aware default
		// is fine here; operators interactive-running an init
		// will be on a real terminal.
		const colorEnabled = args.flags['no-color'] !== 'true' && process.stdout.isTTY === true;
		try {
			return await runInit({
				flags: args.flags,
				positional: args.positional,
				colorEnabled
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}

	// `install` (cp192) — guided first-time install orchestrator.
	// Runs before loadConfig like init (it produces/consumes config
	// rather than needing a live DB).
	if (args.subcommand === 'install') {
		const colorEnabled = args.flags['no-color'] !== 'true' && process.stdout.isTTY === true;
		try {
			return await runInstall({
				flags: args.flags,
				positional: args.positional,
				colorEnabled
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}

	// `register` posts the operator-register op on-chain.  Reads
	// from env vars (MORPHIT_INSTANCE_*, MORPHIT_RELAY_*) but
	// doesn't need a DB connection.  Skip loadConfig.
	if (args.subcommand === 'register') {
		try {
			return await runRegister({
				flags: args.flags,
				positional: args.positional
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}

	// `show-key` displays the PUBLIC key derived from the saved
	// active key (plus a masked private-key fingerprint) so operators
	// can verify the right key is in place without opening files or
	// exposing secrets.  Reads MORPHIT_RELAY_* env; no DB needed.
	if (args.subcommand === 'show-key') {
		try {
			return await runShowKey({
				flags: args.flags,
				positional: args.positional
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}

	// `payment-method` — operator manages instance-additions to the
	// payment-method registry (ADR-0021).  Subcommands: add | remove |
	// list.  add/remove broadcast a `morphit_payment_method_addition_v1`
	// custom_json op against the operator account; list reads from the
	// local indexer DB.  Per-subcommand DB requirements are handled
	// inside runPaymentMethod (list opens DB; add/remove don't), so
	// we intentionally don't require a DB connection at this dispatch
	// layer.
	if (args.subcommand === 'payment-method') {
		try {
			return await runPaymentMethod({
				flags: args.flags,
				positional: args.positional
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}

	// `edit` re-prompts only the post-launch-tunable sections of
	// an existing morphit.config.env (primary origin, alt-network
	// addresses, SEO copy).  No DB needed — pure file edit.
	if (args.subcommand === 'edit') {
		const colorEnabled = args.flags['no-color'] !== 'true' && process.stdout.isTTY === true;
		try {
			return await runEdit({
				flags: args.flags,
				positional: args.positional,
				colorEnabled
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}

	// `edit-active-key` rotates ONLY the relay account's active
	// key.  cp167 — recovery path for operators who pasted the
	// wrong key (e.g. posting instead of active) during the
	// initial wizard, or for routine key rotation after an
	// on-chain account_update.  Atomic rename + .bak backup +
	// relay-restart reminder.  No DB needed.
	if (args.subcommand === 'edit-active-key') {
		const colorEnabled = args.flags['no-color'] !== 'true' && process.stdout.isTTY === true;
		try {
			return await runEditActiveKey({
				flags: args.flags,
				positional: args.positional,
				colorEnabled
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}

	// Alt-network key management — encrypted-at-rest service
	// keys for Tor / Lokinet / I2P.  Same passphrase as the
	// relay's active-key keystore unlocks them.  No DB needed.
	if (args.subcommand === 'import-altnet-key') {
		const colorEnabled = args.flags['no-color'] !== 'true' && process.stdout.isTTY === true;
		try {
			return await runImportAltnetKey({
				flags: args.flags,
				positional: args.positional,
				colorEnabled
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}
	if (args.subcommand === 'export-altnet-key') {
		const colorEnabled = args.flags['no-color'] !== 'true' && process.stdout.isTTY === true;
		try {
			return await runExportAltnetKey({
				flags: args.flags,
				positional: args.positional,
				colorEnabled
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}

	// `upgrade` — check for + apply releases from Forgejo.
	// No DB needed; talks to the release HTTP API and the local
	// filesystem.  Manual-only by default per Memory #29; set
	// MORPHIT_AUTO_UPGRADE=1 to skip the confirmation prompt for
	// cron/automation use.  Part 122 cp8.
	if (args.subcommand === 'upgrade') {
		try {
			return await runUpgrade({
				flags: args.flags,
				positional: args.positional
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}

	// `harden` (cp187) — the focused, re-runnable hardening wizard.
	// Reads only a few values from morphit.config.env for the
	// checklist; needs no DB, so it dispatches alongside init/upgrade
	// before loadConfig.
	if (args.subcommand === 'harden') {
		const colorEnabled = args.flags['no-color'] !== 'true' && process.stdout.isTTY === true;
		try {
			return await runHarden({
				flags: args.flags,
				positional: args.positional,
				colorEnabled
			});
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err));
			return 3;
		}
	}

	// Now load config — only after we've handled help/version
	// and init, because those work without DATABASE_URL set.
	let config;
	try {
		config = loadConfig();
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		return 2;
	}
	initColor(config);

	const db = await createDatabase(config);
	try {
		const ctx = { db, config, flags: args.flags, positional: args.positional };
		switch (args.subcommand) {
			case 'status':
				return await runStatus(ctx);
			case 'drain-queue':
				return await runDrainQueue(ctx);
			case 'signups':
				return await runSignups(ctx);
			case 'abuse':
				return await runAbuse(ctx);
			case 'failed-broadcasts':
				return await runFailedBroadcasts(ctx);
			case 'loyalty':
				return await runLoyalty(ctx);
			case 'attestations':
				return await runAttestations(ctx);
			case 'flags':
				return await runFlags(ctx);
			default:
				printError(`Unknown subcommand: ${args.subcommand}`);
				info('');
				printHelp();
				return 1;
		}
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err));
		return 3;
	} finally {
		await db.close();
	}
}

// ─── Boot ────────────────────────────────────────────────────────

main()
	.then((code) => process.exit(code))
	.catch((err: unknown) => {
		// Last-resort handler — main()'s try/finally should have
		// caught everything, but if a Promise rejection escapes
		// we still want to surface it cleanly.  cp139-C-18: the
		// err.message can carry filesystem/RPC/library text that
		// has attacker-influenced bytes; sanitizeForTerm strips
		// terminal-control escapes before writing to stderr so a
		// hostile error message can't clear the operator's
		// screen or set the terminal title.
		process.stderr.write(
			`fatal: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}\n`
		);
		process.exit(127);
	});
