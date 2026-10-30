/**
 * runAnsibleInstall.ts — the guided full install: gather the operator's
 * answers with the wizard's existing steps + the home/VPS branch, then hand a
 * finished plan to assembleInstall (which runs the full Ansible playbook against
 * this box).  Both a home box and a VPS get the SAME hardened stack; the only
 * difference is networking, handled inside collectInstallInputs.
 *
 * Interactive end-to-end (it calls the wizard's stdin-driven steps + spawns
 * ansible), so it isn't unit-tested as a whole; the one pure bit worth pinning
 * — the keystore-content choice — is exported + covered by a smoke.  Every
 * other piece it calls (collectInstallInputs, buildAnsibleVars, assembleInstall,
 * the save-secrets prompt) is already verified on its own.
 */
import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	chownSync,
	chmodSync,
	rmSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { stepRelayAccount, stepActiveKey, stepFeesAccount, type ActiveKeyResult } from './steps.ts';
import { collectInstallInputs, askInstallMode, askTorOnly } from './collectInstallInputs.ts';
import { buildAnsibleVars, validateInstallInputs, type InstallMode } from './ansibleVars.ts';
import {
	assembleInstall,
	changedSoFar,
	currentInstallRestartCommand,
	noteInstallStage
} from './assembleInstall.ts';
import { armReachabilityRevert, confirmReachabilityOrRevert } from './reachabilityRevert.ts';
import {
	collectInstallSummary,
	printInstallSummary,
	readLocalIndexerHealth,
	readyToList
} from './installSummary.ts';
import {
	fastSyncFromChain,
	localIndexerHealthBase,
	serviceActive,
	withServicesStopped,
	FAST_SYNC_REPLACED_UNUSABLE
} from '../commands/fastSync.ts';
import { REGISTER_DECLINED } from '../commands/register.ts';
import { startDotsSpinner } from './spinner.ts';
import { renderRemediationReport, getRemediationJournal } from './remediation.ts';
import { promptSaveSecrets, type SecretToSave } from './saveSecrets.ts';
import {
	step,
	beginSteps,
	endSteps,
	currentStepNum,
	ask,
	askChoice,
	abortError,
	isAbortError
} from './prompt.ts';
import {
	clearInstallProgress,
	loadInstallProgress,
	rememberInstallAnswers,
	type InstallProgress
} from './installProgress.ts';
import { describeAge } from './progress.ts';
import { validateBlurtAccountName } from './chainCheck.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { offerTorOnlyRekey, readPriorIdentity } from '../lib/torOnlyRekey.ts';
import { withSpinner } from './spinner.ts';
import { runSpinning, showOutput, sleepMs, systemctlSpinning } from '../lib/spinRun.ts';

/** Ansible's `morphit_relay_keystore_path` default; we write the keystore here
 *  and pass the same path in the vars, so the two match by construction. */
const DEFAULT_KEYSTORE_PATH = '/etc/morphit/relay.keystore';
const VARS_FILE_PATH = '/run/morphit-install-vars.json';

/** morphit-first-online reads this env; MORPHIT_AUTO_REGISTER=yes tells it to
 *  publish the on-chain operator registration the moment the box is online. */
const FIRST_ONLINE_ENV_PATH = '/etc/morphit/first-online.env';

/** Queue the on-chain registration for morphit-first-online: flip
 *  MORPHIT_AUTO_REGISTER to yes in its env, AND start its timer again. This is
 *  what makes "list my instance" work on an OFFLINE appliance install (it lists
 *  itself the first time the box has internet), and it is the safety net when an
 *  immediate registration does not go through.
 *
 *  Starting the timer is not optional: on an online box first-online runs during
 *  the install, finishes its other jobs and switches its own timer off, so a
 *  switch flipped after that was never read (2026-10-12, a VPS that answered yes
 *  and never appeared on /instances).
 *
 *  Returns false when it could not be queued; the caller then gives the command
 *  to run by hand. */
export function armDeferredRegister(
	envPath: string = FIRST_ONLINE_ENV_PATH,
	systemctl: (args: string[]) => number = (args) =>
		spawnSync('systemctl', args, { stdio: 'ignore' }).status ?? 1,
	doneMarker: string = '/var/lib/morphit/first-online/register.done'
): boolean {
	try {
		if (!existsSync(envPath)) return false;
		// A marker from an earlier install on this box would make first-online
		// treat this listing as done and switch itself off (review, 2026-10-12).
		// Registering again is an update of the same record, never a duplicate.
		rmSync(doneMarker, { force: true });
		const cur = readFileSync(envPath, 'utf8');
		const next = /^MORPHIT_AUTO_REGISTER=/m.test(cur)
			? cur.replace(/^MORPHIT_AUTO_REGISTER=.*$/m, 'MORPHIT_AUTO_REGISTER=yes')
			: cur + (cur.endsWith('\n') ? '' : '\n') + 'MORPHIT_AUTO_REGISTER=yes\n';
		if (next !== cur) writeFileSync(envPath, next, { mode: 0o644 });
		return systemctl(['enable', '--now', 'morphit-first-online.timer']) === 0;
	} catch {
		return false;
	}
}

/** A unit's ActiveState means a run of it is under way. A oneshot service
 *  (morphit-first-online) is "activating" for its whole run — `systemctl
 *  is-active` exits 3 for that, so the old check never waited (review,
 *  2026-10-12). PURE. */
export function unitBusy(activeState: string): boolean {
	return ['activating', 'deactivating', 'reloading', 'refreshing', 'active'].includes(
		activeState.trim()
	);
}

export interface FirstOnlinePauseDeps {
	/** `systemctl` with these arguments: exit code and stdout. */
	readonly systemctl: (args: string[]) => { status: number; stdout: string };
	readonly sleep: (ms: number) => Promise<void>;
	readonly spinner: (label: string) => () => void;
	/** Throws when the operator pressed Ctrl+C (outside a child). */
	readonly checkStop: () => void;
}

const realFirstOnlineDeps = (checkStop: () => void): FirstOnlinePauseDeps => ({
	systemctl: (args) => {
		const r = spawnSync('systemctl', args, { encoding: 'utf8' });
		return { status: r.status ?? 1, stdout: r.stdout ?? '' };
	},
	sleep: sleepMs,
	spinner: (label) => startDotsSpinner(label),
	checkStop
});

/** Run `fn` with morphit-first-online's timer stopped (when it was running),
 *  after waiting — under the spinner, up to its own 10-minute limit — for a
 *  run of it already under way (it may restart tor and i2pd under a download
 *  going over them); then start the timer again. */
export async function withFirstOnlinePaused<T>(
	fn: () => Promise<T>,
	d: FirstOnlinePauseDeps
): Promise<T> {
	const timer = 'morphit-first-online.timer';
	const active = d.systemctl(['is-active', '--quiet', timer]).status === 0;
	if (active) d.systemctl(['stop', timer]);
	try {
		const busy = (): boolean =>
			unitBusy(
				d.systemctl(['show', '-p', 'ActiveState', '--value', 'morphit-first-online.service']).stdout
			);
		if (busy()) {
			const stop = d.spinner(
				'Waiting for the background finisher (first-online) to finish its run first\u2026'
			);
			try {
				for (let i = 0; i < 600 && busy(); i++) {
					d.checkStop();
					await d.sleep(1000);
				}
			} finally {
				stop();
			}
		}
		return await fn();
	} finally {
		if (active) d.systemctl(['start', timer]);
	}
}

/** The indexer's health once it reports a chain connection, waiting up to
 *  ~60 s: right after the install it may still be starting or counting its
 *  RPC nodes (slower over Tor), and one early look would skip fast-sync on a
 *  box that is online (review, 2026-10-12). Returns the last answer. */
async function waitForChain(
	checkStop: () => void
): Promise<Awaited<ReturnType<typeof readLocalIndexerHealth>>> {
	let h = await readLocalIndexerHealth();
	for (let i = 0; i < 30 && !(h.reachable && h.rpcOk === true); i++) {
		checkStop();
		await sleepMs(2000);
		h = await readLocalIndexerHealth();
	}
	return h;
}

/**
 * Ctrl+C after the install itself (fast-sync, canary, listing, branding):
 *  - at a question: readline's AbortError, handled by the caller;
 *  - while a child runs (fast-sync's restore, the canary setup, register,
 *    branding): it stops that child only — the wizard goes on;
 *  - anywhere else (a wait under the spinner): the wizard stops at the next
 *    check (`checkStop`), and says what is left to do.
 * A signal that arrives while a child runs is delivered after the child
 * returns, so the child's turn ends one loop turn later (`child`).
 */
export function postInstallSignals(): {
	child: <T>(fn: () => T | Promise<T>) => Promise<T>;
	checkStop: () => void;
	release: () => void;
} {
	let inChild = 0;
	let stopped = false;
	const onSigint = (): void => {
		if (inChild > 0 || stopped) return;
		stopped = true;
		process.stdout.write('\n  Stopping after this check\u2026\n');
	};
	process.on('SIGINT', onSigint);
	return {
		child: async (fn) => {
			inChild++;
			try {
				return await fn();
			} finally {
				// Let the loop read the Ctrl+C that came during the program before
				// it counts again: to the next turn's timers, then past that turn's
				// poll phase (where a signal is read). One setImmediate ran before
				// the poll phase when the program followed an answer just read, and
				// the wizard stopped with it (review, 2026-10-12).
				await new Promise((r) => setTimeout(r, 0));
				await new Promise((r) => setImmediate(r));
				inChild--;
			}
		},
		checkStop: () => {
			if (stopped) throw abortError();
		},
		release: () => {
			process.removeListener('SIGINT', onSigint);
		}
	};
}

/** What the post-install steps left undone, and how to do each later. */
export type PostInstallStep = 'fast-sync' | 'canary' | 'listing' | 'branding';
const LATER: Record<PostInstallStep, [string, string]> = {
	'fast-sync': ['Fast-sync', 'sudo morphit-ops fast-sync'],
	canary: ['Warrant canary', 'sudo bash /opt/morphit/scripts/canary/setup.sh'],
	listing: ['List it', 'sudo morphit-ops register'],
	branding: ['Branding', 'sudo morphit-ops branding setup']
};

/** The message after Ctrl+C in the post-install steps. `indexerStopped`: a
 *  restore replaced the database but did not pass its checks (fast-sync exit
 *  4), so the indexer stays stopped until a fast-sync succeeds — never call
 *  the node "running" then, and list it only after that (review, 2026-10-12).
 *  PURE. */
export function stoppedAfterInstallMessage(
	left: readonly PostInstallStep[],
	o: { indexerStopped?: boolean } = {}
): string {
	const lines = [
		'',
		o.indexerStopped === true
			? '  Stopped \u2014 you pressed Ctrl+C. Your node is installed; its indexer stays stopped until a fast-sync succeeds.'
			: '  Stopped \u2014 you pressed Ctrl+C. Your node is installed and running.'
	];
	if (left.length > 0) {
		lines.push('  Only these optional steps were not done; any time later:');
		// Fast-sync first: the listing waits for it when the indexer is stopped.
		const order = [...left].sort((a, b) => Number(b === 'fast-sync') - Number(a === 'fast-sync'));
		for (const k of order) {
			const label =
				k === 'listing' && o.indexerStopped === true ? 'List it (after fast-sync)' : LATER[k][0];
			lines.push(`      ${(label + ':').padEnd(28)}${LATER[k][1]}`);
		}
	}
	lines.push('  How it is doing:  sudo morphit-ops health', '');
	return lines.join('\n');
}

/** MORPHIT_CANARY_INSTANCE_ORIGIN for scripts/canary/setup.sh: set only to a
 *  real origin. Unset, setup.sh finds the origin itself (the settings, then a
 *  Tor-only node's onion). PURE. */
export function canaryOriginEnv(origin: string | null): Record<string, string> {
	return origin !== null && /^https?:\/\/[^/]+/.test(origin)
		? { MORPHIT_CANARY_INSTANCE_ORIGIN: origin }
		: {};
}

export interface ServerCanaryDeps {
	readonly askChoice: (
		q: string,
		choices: readonly string[],
		defaultIdx: number
	) => Promise<number>;
	/** Run scripts/canary/setup.sh with these extra environment values; exit code. */
	readonly runSetup: (env: Record<string, string>) => number | Promise<number>;
	readonly print: (s: string) => void;
	/** '' on a Tor-only node. */
	readonly domain: string;
	readonly operatorTag: string;
}

/** Where a server's warrant canary is signed (asked on a VPS install; a home
 *  box has its own step). Before v1.21.7 a VPS install never asked, and ended
 *  with no canary and no /pgp_keys.asc (2026-10-12).
 *   here          same-box: a signing key on this server, the first canary now,
 *                 and the weekly refresh — the turnkey path `upgrade` offers
 *   own-computer  the key never sits on the server; set up on the operator's
 *                 computer, which uploads it weekly */
export async function offerServerCanary(
	d: ServerCanaryDeps
): Promise<'here' | 'failed' | 'own-computer' | 'later'> {
	d.print('\n  Your warrant canary is a signed notice, refreshed weekly, that you have');
	d.print('  received no secret orders. Where should it be signed?');
	const choice = await d.askChoice(
		'',
		[
			'Here on this server, automatically every week (simplest)',
			'On my own computer (safest: the signing key never sits on the server)',
			'Later'
		],
		0
	);
	const later = 'bash /opt/morphit/scripts/canary/setup.sh';
	if (choice === 0) {
		const rc = await d.runSetup({
			MORPHIT_CANARY_MODE: 'local',
			MORPHIT_CANARY_SERVE_DIR: '/opt/morphit/apps/web/build',
			MORPHIT_CANARY_OPERATOR_NAME: d.operatorTag,
			MORPHIT_CANARY_OPERATOR_EMAIL: `canary@${d.domain !== '' ? d.domain : `${d.operatorTag}.local`}`
		});
		if (rc === 0) return 'here';
		d.print(`\n  The canary setup didn\u2019t finish. Run it again any time:  sudo ${later}\n`);
		return 'failed';
	}
	if (choice === 1) {
		d.print('\n  On your own computer, from a copy of this Morphit release:');
		d.print('      bash scripts/canary/setup.sh');
		d.print('  Choose "On a remote server / VPS"; it signs there and uploads to this server');
		d.print('  every week. One canary setup per computer account: for a second server, use');
		d.print('  another account on that computer.\n');
		return 'own-computer';
	}
	d.print(`\n  Any time later, here:  sudo ${later}   (or on your own computer, as above)\n`);
	return 'later';
}

export interface FastSyncDeps {
	/** This box already ran a Morphit node before this install (its settings
	 *  were there): its own data is in the database a restore replaces. */
	readonly reinstall: boolean;
	/** The indexer reaches the Blurt chain. */
	readonly online: boolean;
	readonly askYesNo: (q: string, defaultYes: boolean) => Promise<boolean>;
	/** Stop the indexer AND the relay (they share the database), restore the
	 *  newest federation snapshot, and start them again — the relay only once
	 *  the indexer answers ({@link restoreDuringInstall}). Its exit code
	 *  (FAST_SYNC_REPLACED_UNUSABLE: replaced, but not to be served; both are
	 *  then left stopped). */
	readonly restore: () => number | Promise<number>;
	readonly print: (s: string) => void;
}

/** The guided install's fast-sync step: restore the newest signed federation
 *  snapshot instead of replaying the whole chain from genesis.
 *
 *  Only "Configure only" offered it; the full guided install never asked, so a
 *  fresh VPS started 4.8 million blocks behind (2026-10-12). What was stopped
 *  is always started again, whatever happened, and a snapshot is never
 *  restored under a service that did not stop. */
export async function offerFastSync(
	d: FastSyncDeps
): Promise<'synced' | 'failed' | 'skipped' | 'unusable'> {
	const later = (): void => {
		d.print('  Any time later:  sudo morphit-ops fast-sync\n');
	};
	if (!d.online) {
		// It reads the chain and downloads the snapshot: offline it could only
		// stop the indexer and fail.
		d.print('\n  This box can’t reach the Blurt chain yet, so fast-sync is skipped for now');
		d.print('  (the indexer replays the chain meanwhile).');
		later();
		return 'skipped';
	}
	d.print('\n  A new node can restore the newest signed federation snapshot and be live in');
	d.print('  minutes, instead of replaying the whole chain for days. You trust the');
	d.print('  publisher (@morphit) for the settled state; the recent part is re-checked');
	d.print('  against the chain before your node serves it. Say no for a full replay.');
	if (d.reinstall) {
		// Its own data lives in the same database, and a restore replaces it.
		d.print('\n  This box has settings from an earlier Morphit install. If it ran a live node,');
		d.print('  fast-sync REPLACES that node’s database, including its own pending relay');
		d.print('  payouts, push subscriptions and moderation decisions. (An earlier install that');
		d.print('  never got going has nothing to lose: say yes.)');
	}
	if (
		!(await d.askYesNo('\n  Fast-sync this node from the federation snapshot now?', !d.reinstall))
	) {
		d.print('\n  Skipped — the indexer goes on from its own data.');
		later();
		return 'skipped';
	}
	const rc = await d.restore();
	if (rc === FAST_SYNC_REPLACED_UNUSABLE) {
		// Replaced, but it did not pass its checks: the indexer must not serve
		// from it, so it stays stopped (fast-sync printed what to do).
		return 'unusable';
	}
	if (rc !== 0) {
		d.print('\n  The snapshot was not restored; the indexer goes on from its own data.');
		later();
		return 'failed';
	}
	return 'synced';
}

/** Up to ~90 s for the indexer to answer with a chain connection, so the review
 *  and the listing step that follow see it up (on the address its own
 *  settings name). `stopEarly` turns true on Ctrl+C. */
async function indexerConnects(stopEarly: () => boolean): Promise<boolean> {
	const base = localIndexerHealthBase('/opt/morphit');
	const stop = startDotsSpinner('Waiting for the indexer to connect to the chain…');
	try {
		for (let i = 0; i < 45 && !stopEarly(); i++) {
			const h = await readLocalIndexerHealth(base);
			if (h.reachable && h.rpcOk === true) return true;
			await sleepMs(2000);
		}
		return false;
	} finally {
		stop();
	}
}

/**
 * The install's restore, the way `fast-sync` does it (fastSync.ts,
 * withServicesStopped): the relay is stopped too — it writes to the same
 * database the restore replaces (review, 2026-10-29: only the indexer was
 * stopped) — then the indexer is started, and the relay only once the indexer
 * answers. The indexer is always stopped and started again (it is the one the
 * restore needs stopped); the relay only when it was running.
 */
export async function restoreDuringInstall(o: {
	readonly fastSync: () => number | Promise<number>;
	/** Default: the indexer answers with a chain connection (~90 s). */
	readonly indexerAnswers?: (stopEarly: () => boolean) => Promise<boolean>;
}): Promise<number> {
	return withServicesStopped(
		{ indexer: true, relay: serviceActive('morphit-relay') === true },
		o.fastSync,
		o.indexerAnswers ?? indexerConnects
	);
}

export interface ListingDeps {
	readonly askYesNo: (q: string, defaultYes: boolean) => Promise<boolean>;
	/** readyToList(summary): the chain is reachable and nothing a listing needs is ✗. */
	readonly ready: boolean;
	/** The chain is reachable at all. */
	readonly online: boolean;
	/** Run `morphit-ops register` now (interactive); its exit code, or
	 *  'interrupted' when Ctrl+C stopped it. */
	readonly register: () => number | 'interrupted' | Promise<number | 'interrupted'>;
	/** The permanent federation tag it is listed under (shown in the question). */
	readonly tag?: string;
	/** armDeferredRegister. */
	readonly arm: () => boolean;
	readonly print: (s: string) => void;
}

/** The "list this instance on the federated directory?" step.
 *
 *  Ready → register now. Only if that does not go through is it queued for the
 *  background finisher, so a successful listing is never followed by a second,
 *  identical one from first-online. Not ready (or offline) → queued; a broadcast
 *  attempted offline would hang. */
export async function offerListing(
	d: ListingDeps
): Promise<'registered' | 'queued' | 'by-hand' | 'declined'> {
	const byHand = (): 'by-hand' => {
		d.print('\n  It couldn\u2019t be queued automatically on this box. List it by hand any');
		d.print('  time with:');
		d.print('        sudo morphit-ops register\n');
		return 'by-hand';
	};
	const under =
		d.tag !== undefined && d.tag !== ''
			? ` under the tag \u201c${sanitizeForTerm(d.tag)}\u201d (permanent)`
			: '';
	if (
		!(await d.askYesNo(
			`\n  List this instance on the public federated directory${under} (start earning fees)?`,
			true
		))
	) {
		d.print('\n  No problem \u2014 list it whenever you\u2019re ready with:');
		d.print('        sudo morphit-ops register\n');
		return 'declined';
	}
	if (d.ready) {
		const rc = await d.register();
		if (rc === 0) return 'registered';
		// Declined at its own question, or stopped with Ctrl+C (exit 130, or
		// killed by the signal): nothing was published, and nothing may publish
		// it behind the operator's back (review, 2026-10-12: a Ctrl+C queued it,
		// and first-online claimed the permanent tag minutes later).
		if (rc === REGISTER_DECLINED || rc === 130 || rc === 'interrupted') {
			d.print('\n  Not listed. List it whenever you\u2019re ready with:');
			d.print('        sudo morphit-ops register\n');
			return 'declined';
		}
		if (!d.arm()) return byHand();
		d.print('\n  That didn\u2019t go through just now \u2014 no problem: it will retry by itself');
		d.print('  every 5 minutes. Or do it by hand any time with:');
		d.print('        sudo morphit-ops register\n');
		return 'queued';
	}
	if (!d.arm()) return byHand();
	if (!d.online) {
		d.print('\n  This box isn\u2019t online yet, so we won\u2019t try the on-chain listing this');
		d.print('  second \u2014 it will list itself automatically the moment this box is');
		d.print('  online. Or do it by hand any time with:');
	} else {
		d.print('\n  A piece the listing needs isn\u2019t up yet (see the review below), so we');
		d.print('  won\u2019t list it this second \u2014 it will retry by itself every 5 minutes.');
		d.print('  Or do it by hand any time with:');
	}
	d.print('        sudo morphit-ops register\n');
	return 'queued';
}

/** The bytes to write for the relay keystore, from the wizard's active-key
 *  result: the encrypted envelope (JSON) or the plaintext WIF.  PURE — mirrors
 *  render.ts's keystore write so the guided install and the plain wizard agree. */
export function relayKeystoreContent(activeKey: ActiveKeyResult): string {
	return activeKey.mode === 'encrypted'
		? JSON.stringify(activeKey.envelope, null, 2)
		: (activeKey.plaintextWif ?? '');
}

const RELAY_CRED_PATH = '/etc/morphit/relay_passphrase.cred';

/** Write the relay keystore (and seal its passphrase); returns the files
 *  written, the keystore first. */
export function writeRelayKeystore(activeKey: ActiveKeyResult, keystorePath: string): string[] {
	mkdirSync(dirname(keystorePath), { recursive: true });
	const existed = existsSync(keystorePath);
	writeFileSync(keystorePath, relayKeystoreContent(activeKey), { mode: 0o600 });
	// The relay runs as its own user (morphit-relay) and reads the keystore
	// through group morphit-relay, 0640; its unit's pre-start helper
	// (morphit-service-perms.sh) sets that at every start. A NEW keystore starts
	// root:root 0600 (the wizard may run as a non-root account); an existing one
	// keeps the owner and mode it had (writeFileSync does not change them).
	if (!existed) {
		try {
			chownSync(keystorePath, 0, 0);
		} catch {
			/* not root / unsupported — the Ansible "Lock down keystore" task fixes it */
		}
	}
	// for an encrypted key, seal the passphrase into the systemd
	// host-bound encrypted credential the relay unit consumes
	// (LoadCredentialEncrypted=relay_passphrase).  Without it the relay cannot
	// unlock unattended and the unit fails to start.
	if (activeKey.mode === 'encrypted' && activeKey.passphrase) {
		if (sealRelayPassphraseCred(activeKey.passphrase)) return [keystorePath, RELAY_CRED_PATH];
	}
	return [keystorePath];
}

/** Seal the relay unlock passphrase into the systemd encrypted credential
 *  (/etc/morphit/relay_passphrase.cred) that the relay unit loads. Sealed with
 *  this host's credential key (`--with-key=host`, no TPM): it opens on this
 *  machine only, so a copied file is useless, but a full image of the disk
 *  carries the key too (disk encryption covers that).
 *  Best-effort: if systemd-creds is missing or fails, tell the operator the
 *  exact command (also in the unit file comments). */
function sealRelayPassphraseCred(passphrase: string): boolean {
	try {
		const r = spawnSync(
			'systemd-creds',
			['encrypt', '--name=relay_passphrase', '--with-key=host', '-', RELAY_CRED_PATH],
			{ input: passphrase, stdio: ['pipe', 'ignore', 'pipe'] }
		);
		if (r.status === 0) {
			try {
				chmodSync(RELAY_CRED_PATH, 0o600);
			} catch {
				/* systemd-creds writes 0600 already */
			}
			console.log('  ✓ Sealed the relay unlock passphrase into /etc/morphit/relay_passphrase.cred');
			return true;
		}
		warnCredManual((r.stderr?.toString() ?? '').trim());
	} catch (e) {
		warnCredManual(String(e));
	}
	return false;
}

function warnCredManual(detail: string): void {
	const first = detail ? ` (${detail.split('\n')[0]})` : '';
	console.log(
		`  ⚠ Could not auto-create ${RELAY_CRED_PATH}${first}.\n` +
			"    The relay can't unlock its encrypted key until this exists.  Create it with:\n" +
			`      echo -n '<your passphrase>' | sudo systemd-creds encrypt --name=relay_passphrase --with-key=host - ${RELAY_CRED_PATH}`
	);
}

/** A default-answered yes/no prompt.  Empty input takes the default. */
async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
	const a = (await ask(`${question}${defaultYes ? ' [Y/n]' : ' [y/N]'}`)).trim().toLowerCase();
	if (a === '') return defaultYes;
	return a === 'y' || a === 'yes';
}

/** The origin this instance advertises on-chain + on its warrant canary. For a
 *  Tor-only node it's the auto-generated onion (read back from the deployed
 *  morphit.config.env, which the tor role's post-tasks populate); for a clearnet
 *  node it's https://<domain>. Returns null only if a Tor-only install somehow
 *  produced no onion — the caller then arms the deferred register instead of
 *  advertising a bogus origin. */
function deriveInstanceOrigin(torOnly: boolean, domain: string, repoPath: string): string | null {
	if (!torOnly) return `https://${domain}`;
	try {
		const env = readFileSync(join(repoPath, 'morphit.config.env'), 'utf8');
		const m = env.match(/^MORPHIT_INSTANCE_TOR_ADDRESS=(.+)$/m);
		const onion = m?.[1]?.trim();
		if (onion && onion.endsWith('.onion')) return `http://${onion}`;
	} catch {
		/* not readable yet — fall through */
	}
	return null;
}

/**
 * Step budget of the install wizard:
 *   3 account steps
 * + core questions (collectInstallInputs): 7 clearnet (domain, name, desc,
 *   matrix, alerts, cert-email, backup encryption) OR 5 Tor-only (no domain,
 *   no cert-email)
 * + 5 (save DB password, fast-sync, register opt-in, branding, post-install
 *   summary)
 * + home extras: clearnet home = 4 (DDNS, router port-forward, desktop,
 *   canary); Tor-only home = 2 (desktop, canary — no DDNS, no port-forward).
 *   A VPS: 1 (where the warrant canary is signed).
 * Keep in sync with the step() calls (a mismatch trips the assert at the end
 * of runAnsibleInstall). PURE.
 */
export function installStepTotal(mode: InstallMode, torOnly: boolean): number {
	return 3 + (torOnly ? 5 : 7) + 5 + (mode === 'home' ? (torOnly ? 2 : 4) : 1);
}

/** Offer to reuse the answers an interrupted run saved. Returns them, or {}
 *  (no saved run, or the operator chose to start fresh, which deletes them).
 *  Dependencies injectable for the test. */
export async function offerResume(
	deps: {
		readonly load?: typeof loadInstallProgress;
		readonly clear?: () => void;
		readonly askYesNo?: (q: string, defaultYes: boolean) => Promise<boolean>;
		readonly print?: (s: string) => void;
	} = {}
): Promise<InstallProgress> {
	const prior = (deps.load ?? loadInstallProgress)();
	if (prior === null) return {};
	const clear = deps.clear ?? ((): void => clearInstallProgress());
	const yesNo = deps.askYesNo ?? askYesNo;
	const print = deps.print ?? ((s: string): void => console.log(s));
	const a = prior.answers;
	print('');
	print('\u2501'.repeat(58));
	print('  Found an install you started before');
	print('\u2501'.repeat(58));
	print('');
	print(`  You started installing ${describeAge(prior.savedAt)}.`);
	if (a.instanceName) print(`    Marketplace:   ${sanitizeForTerm(a.instanceName)}`);
	if (a.domain) print(`    Web address:   ${sanitizeForTerm(a.domain)}`);
	if (a.relayAccount) print(`    Relay account: @${sanitizeForTerm(a.relayAccount)}`);
	print('');
	print('  I can reuse the answers you gave. You only enter again what is never');
	print('  saved to disk: your relay account\u2019s active key, the alerts step');
	print('  (it holds a bot token) and, at home, your dynamic-DNS update URL.');
	print('');
	if (await yesNo('Reuse your saved answers?', true)) {
		print('\n  \u2713 Reusing them.\n');
		return a;
	}
	clear();
	print('\n  Starting fresh.\n');
	return {};
}

/**
 * Ctrl+C while the wizard asks its questions and checks the answers (a DNS
 * check, a balance check — a wait under a spinner; a Ctrl+C at a question
 * itself is the prompt's own). Nothing is installed or written that matters
 * yet, and the answers given so far are kept: say so, with how to start again,
 * and stop. Before, the process died there without a word (review,
 * 2026-10-12). `release` before the install writes its first secret.
 */
export function questionPhaseStop(
	restart: string,
	d: { print?: (s: string) => void; exit?: (code: number) => void } = {}
): { release: () => void } {
	const print = d.print ?? ((s: string): void => console.log(s));
	const exit = d.exit ?? ((code: number): void => process.exit(code));
	const onSigint = (): void => {
		print('');
		print(`  Stopped \u2014 you pressed Ctrl+C. ${changedSoFar()}`);
		print('  Your answers so far are kept for the next run. To start it again:');
		print(`      ${restart}`);
		print('');
		exit(130);
	};
	process.on('SIGINT', onSigint);
	return { release: () => void process.removeListener('SIGINT', onSigint) };
}

export async function runAnsibleInstall(opts: {
	repoRoot: string;
	keystorePath?: string;
}): Promise<number> {
	// How to start this again, for every message that ends the run early
	// (review, 2026-10-12: they said "run this again" without saying how).
	const restart = currentInstallRestartCommand();
	const questions = questionPhaseStop(restart);
	try {
		return await installFromQuestions(opts, restart, questions.release);
	} finally {
		questions.release();
	}
}

async function installFromQuestions(
	opts: { repoRoot: string; keystorePath?: string },
	restart: string,
	questionsDone: () => void
): Promise<number> {
	const keystorePath = opts.keystorePath ?? DEFAULT_KEYSTORE_PATH;
	// Its questions: each answer is saved as it is given (installProgress.ts).
	noteInstallStage('questions');

	// An earlier run — interrupted, or an install already done on this box —
	// had its own database password; this run makes a new one.
	const earlierRun = loadInstallProgress() !== null || existsSync('/etc/morphit/indexer.env');
	// An interrupted run (Ctrl+C, a dropped connection, a failed install) left its
	// non-secret answers behind: offer to reuse them (installProgress.ts).
	const saved = await offerResume();
	const usedSaved = (what: string, shown: string): void =>
		console.log(`  \u2713 Using your saved ${what} from last time: ${sanitizeForTerm(shown)}\n`);

	// WHERE it runs is the one answer that changes the step count (home adds a DDNS
	// question, a router step, and desktop notifications), so ask it FIRST — before
	// the numbered steps — so the running "Step N of {total}" is accurate from step 1.
	let mode: InstallMode;
	if (saved.mode !== undefined) {
		mode = saved.mode;
		usedSaved(
			'choice of where it runs',
			mode === 'home' ? 'this computer, at home' : 'a rented server'
		);
	} else {
		mode = await askInstallMode();
		rememberInstallAnswers({ mode });
	}
	let torOnly: boolean;
	if (saved.torOnly !== undefined) {
		torOnly = saved.torOnly;
		usedSaved('choice of how people reach it', torOnly ? 'Tor-only' : 'a web address (clearnet)');
	} else {
		torOnly = await askTorOnly();
		rememberInstallAnswers({ torOnly });
	}
	// A clearnet box re-installed as tor-only keeps its published identity
	// unless its onion / I2P keys are replaced.
	if (torOnly)
		await offerTorOnlyRekey(readPriorIdentity(), { print: (s) => console.log(s), askYesNo });
	const totalSteps = installStepTotal(mode, torOnly);
	beginSteps(totalSteps);

	let relay: { readonly name: string };
	if (saved.relayAccount !== undefined && validateBlurtAccountName(saved.relayAccount).ok) {
		step(0, 0, "Your relay's Blurt account");
		relay = { name: saved.relayAccount };
		usedSaved('relay account', `@${saved.relayAccount}`);
	} else {
		relay = await stepRelayAccount();
		rememberInstallAnswers({ relayAccount: relay.name });
	}
	// Never saved: asked on every run.
	const activeKey = await stepActiveKey(relay.name); // held; written only once inputs validate
	let feesAccount: string;
	if (saved.feesAccount !== undefined && validateBlurtAccountName(saved.feesAccount).ok) {
		step(0, 0, 'Fees account');
		feesAccount = saved.feesAccount;
		usedSaved('fees account', `@${saved.feesAccount}`);
	} else {
		feesAccount = await stepFeesAccount(undefined);
		rememberInstallAnswers({ feesAccount });
	}

	const inputs = await collectInstallInputs(
		{
			mode,
			torOnly,
			operatorAccount: relay.name,
			operatorTag: relay.name, // default the tag to the account (avoids a domain-derived circular order)
			feesAccount,
			keystorePath
		},
		{ saved, remember: (a) => rememberInstallAnswers(a) }
	);

	const problems = validateInstallInputs(inputs);
	if (problems.length > 0) {
		console.log('\n  A couple of answers need fixing before we can install:');
		for (const p of problems) console.log(`    - ${p}`);
		console.log(`\n  Run this again to re-enter them:\n      ${restart}\n`);
		return 1;
	}

	// Home boxes need the router pointed at this machine before certbot (in the
	// TLS role) can validate the domain — the one thing we can't do for them.
	// A Tor-only home node needs NO port-forward (the onion is reachable via Tor
	// with no inbound ports), so this step is skipped.
	if (inputs.mode === 'home' && !inputs.torOnly) {
		step(0, 0, 'Point your home router at this computer');
		console.log(
			'  Before we install (home connections only):\n' +
				'    In your router, forward ports 80 and 443 to THIS computer, and make\n' +
				'    sure your domain is pointed here. Morphit keeps the address updated\n' +
				'    after that; the port-forward is a one-time router setting.\n'
		);
		const ready = await ask('Type YES once your router forwards 80 + 443 to this computer');
		if (ready.trim().toLowerCase() !== 'yes') {
			console.log('\n  No problem — set up the port-forward, then run this again:');
			console.log(`      ${restart}\n`);
			return 1;
		}
	}

	// Only now (inputs valid, operator ready) write the keystore Ansible reads.
	// From here a stop says so: "nothing was installed or changed" is no longer
	// true (review, 2026-10-29).
	noteInstallStage('keystore-written', { keystore: writeRelayKeystore(activeKey, keystorePath) });

	// Saving the generated DB password is its OWN step — and it happens BEFORE
	// the install banner, while the wizard is still interactive, so the operator
	// records it and types SAVED before the automatic part starts. There is ONE
	// shared database (indexer + relay both use it), hence one password.
	const secretsToSave: SecretToSave[] = [
		{
			label: 'Database password',
			value: inputs.indexerDbPassword,
			// Every run makes a new one: say so after any earlier run (its answers
			// reused or not, or an install already on this box), or the operator
			// keeps the old one (review, 2026-10-12).
			note: earlierRun
				? 'a NEW password: this run made it, so save this one — a password from an earlier run is no longer used'
				: undefined
		}
	];
	step(0, 0, 'Save your database password');
	noteInstallStage('password-shown');
	await promptSaveSecrets(secretsToSave);

	// The install itself isn't a numbered step — it's the machine working, not a
	// question — so it gets a plain banner rather than a "Step N of N" header.
	console.log('\n══════════════════════════════════════════════════════════');
	console.log('Installing your node — this part is automatic, sit tight…');
	console.log('══════════════════════════════════════════════════════════\n');
	// A box that already ran a Morphit node (its indexer settings exist before
	// the playbook writes them): fast-sync would replace its own data.
	const reinstall = existsSync('/etc/morphit/indexer.env');
	// Arm the reachability dead-man's-switch BEFORE the playbook run (which applies
	// the hardening role's SSH + firewall changes). Snapshot only — nothing is
	// scheduled until we reach the confirm step below, so an aborted/failed run
	// never triggers a revert. No-ops off a systemd/root box.
	const reachabilityGuard = armReachabilityRevert();
	// The install handles Ctrl+C itself from here (it removes its secrets).
	questionsDone();

	const res = await assembleInstall(
		{
			vars: {
				...buildAnsibleVars(inputs),
				// This is a LOCAL install of the release the operator downloaded:
				// relax the remote-only root check + deploy THESE bytes (not git).
				morphit_local_install: true,
				morphit_local_source_path: opts.repoRoot
			},
			secretsToSave,
			playbookPath: join(opts.repoRoot, 'ops', 'ansible', 'playbook.yml'),
			varsFilePath: VARS_FILE_PATH
		},
		{
			// Already saved as its own numbered step above — don't prompt for them again.
			promptSave: async (): Promise<void> => {}
		}
	);
	if (!res.ok) {
		console.log(`\n  ${res.reason}\n`);
		console.log('  Your answers are kept for the next run. To start it again:');
		console.log(`      ${restart}\n`);
		return 1;
	}

	// Installed: the answers now live in the node's configuration.
	clearInstallProgress();

	// From here the node is installed. Every step after this is optional, and a
	// Ctrl+C in any of them says so, with what is left (it used to print "start
	// the install again", and a re-run would have redone everything with a new
	// database password — review, 2026-10-12).
	const left = new Set<PostInstallStep>([
		'fast-sync',
		'canary',
		'listing',
		'branding'
	] as PostInstallStep[]);
	const sig = postInstallSignals();
	const status = { indexerStopped: false };
	try {
		return await afterInstall({
			opts,
			inputs,
			relay,
			keystorePath,
			reinstall,
			totalSteps,
			reachabilityGuard,
			left,
			status,
			sig
		});
	} catch (err) {
		if (!isAbortError(err)) throw err;
		console.log(stoppedAfterInstallMessage([...left], status));
		return 0;
	} finally {
		sig.release();
	}
}

/** Everything after the playbook succeeded. Returns 0 (installed). */
async function afterInstall(c: {
	opts: { repoRoot: string };
	inputs: Awaited<ReturnType<typeof collectInstallInputs>>;
	relay: { readonly name: string };
	keystorePath: string;
	reinstall: boolean;
	totalSteps: number;
	reachabilityGuard: ReturnType<typeof armReachabilityRevert>;
	left: Set<PostInstallStep>;
	/** Set when the indexer was left stopped (fast-sync exit 4). */
	status: { indexerStopped: boolean };
	sig: ReturnType<typeof postInstallSignals>;
}): Promise<number> {
	const { opts, inputs, relay, keystorePath, reinstall, totalSteps, left, status, sig } = c;
	// The playbook (with the hardening role) just changed SSH + the firewall. Before
	// anything else, make the operator prove they can still get in — or the box
	// auto-reverts. This is the net that catches any reachability regression the
	// per-cause guards did not.
	await confirmReachabilityOrRevert(c.reachabilityGuard);

	// Restore the federation snapshot rather than replay the chain from genesis.
	// --force once confirmed: on a fresh box the indexer has only the blocks it
	// replayed during the install; on a re-install the question said what goes.
	step(0, 0, 'Get the orderbook live fast (fast-sync)');
	const chainHealth = await withSpinner('Checking this box reaches the Blurt chain\u2026', () =>
		waitForChain(sig.checkStop)
	);
	const online = chainHealth.reachable && chainHealth.rpcOk === true;
	// Ctrl+C during the restore stops the restore only (it is a child): the
	// wizard goes on to start the indexer and to its remaining steps.
	const synced = await offerFastSync({
		reinstall,
		online,
		askYesNo,
		restore: () =>
			restoreDuringInstall({
				// first-online paused meanwhile: its first online run restarts tor and
				// i2pd, which would drop a snapshot download going over them.
				fastSync: () =>
					withFirstOnlinePaused(
						() =>
							sig.child(() =>
								fastSyncFromChain({
									repoRoot: '/opt/morphit',
									force: true,
									indexerStartedByCaller: true
								})
							),
						realFirstOnlineDeps(sig.checkStop)
					)
			}),
		print: (s) => console.log(s)
	});
	// Done — unless it left the indexer stopped: then it is still to do, first.
	if (synced === 'unusable') status.indexerStopped = true;
	else left.delete('fast-sync');
	sig.checkStop();

	// Where the canary's first publish needs the chain: offline it is deferred
	// to the weekly timer. Decided by whether the chain is reachable now — not by
	// the offline bundle being present, which the guide now uses on every
	// x86 VPS (review, 2026-10-12: "this box is offline" on an online VPS).
	const deferCanary = online ? '' : '1';

	// Home boxes have a screen → offer desktop upgrade notifications (a toast
	// when a new version ships). Headless VPS installs have no desktop, so skip.
	if (inputs.mode === 'home') {
		step(0, 0, 'Desktop notification when a new version ships');
		const notifyScript = join(opts.repoRoot, 'ops', 'desktop', 'morphit-upgrade-notify-setup.sh');
		if (
			await askYesNo('\n  Get a desktop notification when a new Morphit version is released?', true)
		) {
			const rc = await sig.child(() => spawnSync('bash', [notifyScript], { stdio: 'inherit' }));
			if ((rc.status ?? 1) !== 0) {
				console.log(
					'\n  Note: couldn\u2019t set that up automatically (not essential). Do it later with:'
				);
				console.log(`        bash ${notifyScript}\n`);
			}
		}

		// A home box signs its warrant canary locally; a VPS is asked where
		// (offerServerCanary, below — before v1.21.7 a VPS was never asked and
		// ended with no canary). The guided setup arms a weekly
		// auto-refresh with wide third-party failover, so the signed "no secret
		// orders" file never silently goes stale. Declining just leaves the printed
		// next-step; setup.sh is idempotent + re-runnable.
		step(0, 0, 'Warrant canary (signed here, auto-refreshed weekly)');
		const canaryScript = join(opts.repoRoot, 'scripts', 'canary', 'setup.sh');
		if (
			await askYesNo(
				'\n  Set up your warrant canary now (signed on this box, refreshed weekly)?',
				true
			)
		) {
			// the wizard runs from the SOURCE tarball, but the frontend
			// container serves the DEPLOYED build (/opt/morphit/apps/web/build).
			// Point the canary at the served dir so /canary.txt actually loads,
			// instead of landing in the source tree where nothing reads it.
			const rc = await sig.child(() =>
				spawnSync('bash', [canaryScript], {
					stdio: 'inherit',
					env: {
						...process.env,
						MORPHIT_CANARY_SERVE_DIR: '/opt/morphit/apps/web/build',
						// the wizard already collected the domain; pre-fill the
						// canary's "Your instance URL" prompt so the operator confirms
						// with Enter instead of re-typing it (and mistyping it).
						// Only a real origin: an empty Tor-only domain made this a bare
						// "https://", which setup.sh then took instead of reading the onion
						// itself (review, 2026-10-12).
						...canaryOriginEnv(deriveInstanceOrigin(inputs.torOnly, inputs.domain, '/opt/morphit')),
						// Offline, the canary's first publish (which fetches a Blurt
						// chain head as its freshness proof) can't complete now: setup.sh
						// defers it calmly, and the weekly timer publishes it once the
						// box is online.
						MORPHIT_CANARY_DEFER_FIRST_REFRESH: deferCanary
					}
				})
			);
			if ((rc.status ?? 1) !== 0) {
				console.log(
					'\n  Note: couldn\u2019t set that up automatically (not essential). Do it later with:'
				);
				console.log(`        bash ${canaryScript}\n`);
			}
		}
	} else {
		step(0, 0, 'Warrant canary');
		await offerServerCanary({
			askChoice: (q, choices, def) => askChoice(q, choices, def),
			runSetup: (env) =>
				sig.child(
					() =>
						spawnSync('bash', [join('/opt/morphit', 'scripts', 'canary', 'setup.sh')], {
							stdio: 'inherit',
							env: {
								...process.env,
								...env,
								...canaryOriginEnv(
									deriveInstanceOrigin(inputs.torOnly, inputs.domain, '/opt/morphit')
								),
								MORPHIT_CANARY_DEFER_FIRST_REFRESH: deferCanary
							}
						}).status ?? 1
				),
			print: (s) => console.log(s),
			domain: inputs.domain,
			operatorTag: inputs.operatorTag
		});
	}
	left.delete('canary');
	sig.checkStop();

	// Now — AFTER the summary — offer to list this instance on the shared federated
	// directory (moved here from the questions up front, per the operator who
	// wanted to see the node actually come up before deciding).
	//
	// This works whether or not the box has internet right now. When the node is
	// ready to be listed (offerListing / readyToList) it registers right away;
	// otherwise — or if that does not go through — it is queued for
	// morphit-first-online, which lists it the moment the box is online. We pass
	// the instance identity through the environment because a by-hand `register`
	// otherwise reads it from files this Ansible layout doesn't populate.
	// Compute the review now (after desktop + canary) so canary.txt etc. are
	// current; readyToList gates the listing step next. The DISPLAY happens as
	// the final step, after listing.
	const summaryRows = await withSpinner('Checking every part of your node is up…', () =>
		collectInstallSummary({
			domain: inputs.domain,
			torOnly: inputs.torOnly,
			mode: inputs.mode,
			enableBunkerweb: inputs.enableBunkerweb ?? true,
			repoPath: '/opt/morphit',
			relayAccount: relay.name,
			contactConfigured: !!inputs.contactUrl
		})
	);
	sig.checkStop();
	// Is the box actually ONLINE? The summary's "Blurt RPC connectivity" row is ✓
	// only when the indexer can reach a Blurt RPC. If it isn't reachable, a
	// synchronous `register` would BLOCK forever on its broadcast RPC calls (no
	// upstream to answer) — the operator would have to Ctrl-C out. So offline we do
	// NOT attempt it: it is queued for first-online, which lists the node the
	// moment the box is online.
	const rpcReachable = summaryRows.some(
		(r) => r.label === 'Blurt RPC connectivity' && r.ok === true
	);
	step(0, 0, 'List your instance on the public federated directory');
	if (synced === 'unusable') {
		// Its indexer is stopped on a database that did not pass its checks:
		// listing it now would send visitors to a node that cannot serve.
		console.log('\n  Not listing it now: its indexer is stopped until fast-sync succeeds (above).');
		console.log('  Once it is running again, list it with:');
		console.log('        sudo morphit-ops register\n');
	} else {
		// The address the node is listed under. A Tor-only node's is its .onion,
		// read back from the settings; when it is not there yet, never list it as
		// a bare "https://" (2026-10-12 review) — it is queued instead, and
		// first-online lists it once the settings carry the onion.
		const listedOrigin = deriveInstanceOrigin(inputs.torOnly, inputs.domain, '/opt/morphit');
		if (listedOrigin === null) {
			console.log(
				'\n  Your .onion address is not in your settings yet, so this node can\u2019t be'
			);
			console.log(
				'  listed this second (sudo morphit-ops \u2192 Set up a Tor / Lokinet / I2P address).'
			);
		}
		await offerListing({
			askYesNo,
			ready: readyToList(summaryRows) && listedOrigin !== null,
			online: rpcReachable,
			tag: inputs.operatorTag,
			register: () =>
				sig.child(() => {
					// --default-yes: the operator just said "list it" here, so Enter at
					// register's own confirmation (after it shows the details) lists it.
					const r = spawnSync('/usr/local/bin/morphit-ops', ['register', '--default-yes'], {
						stdio: 'inherit',
						env: {
							...process.env,
							MORPHIT_RELAY_ACCOUNT: relay.name,
							MORPHIT_RELAY_ACTIVE_KEY_FILE: keystorePath,
							MORPHIT_INSTANCE_NAME: inputs.instanceName,
							MORPHIT_INSTANCE_ORIGIN: listedOrigin ?? '',
							MORPHIT_INSTANCE_OPERATOR_TAG: inputs.operatorTag
						}
					});
					return r.signal === 'SIGINT' ? ('interrupted' as const) : (r.status ?? 1);
				}),
			arm: () => armDeferredRegister(),
			print: (s) => console.log(s)
		});
	}
	left.delete('listing');
	sig.checkStop();
	// Optional branding: logo, footer logo, icon, site name and colours — the
	// same guided setup as `sudo morphit-ops branding setup` (which first says
	// exactly what files it needs). Run through the installed launcher, so it
	// brands the DEPLOYED site, with file paths read from this folder.
	step(0, 0, 'Brand your instance (optional)');
	const brand = await sig.child(() =>
		spawnSync('/usr/local/bin/morphit-ops', ['branding', 'setup'], {
			stdio: 'inherit'
		})
	);
	if ((brand.status ?? 1) !== 0) {
		console.log('\n  Branding was not applied. Any time later:  sudo morphit-ops branding setup\n');
	}
	left.delete('branding');
	sig.checkStop();
	// FINAL step: show the review last, so it reflects everything the
	// operator just set up (canary signed, listing armed).
	step(0, 0, 'Review your node');
	printInstallSummary(summaryRows);
	// Everything the wizard fixed / the admin approved / skipped — so the operator
	// (and we) can see exactly what happened on this machine, in one place.
	const remReport = renderRemediationReport(getRemediationJournal());
	if (remReport) {
		console.log('');
		console.log(remReport);
	}
	if (synced === 'unusable') {
		// Not "running": its indexer is stopped on purpose (review, 2026-10-12).
		console.log('\n  \u2713 Your Morphit node is installed. Its indexer stays stopped until a');
		console.log('    fast-sync succeeds:  sudo morphit-ops fast-sync');
	} else {
		console.log('\n  \u2713 Your Morphit node is installed and running.');
	}
	console.log('    It got (or will shortly get) its free HTTPS certificate automatically.');
	endSteps();
	// Safety net: the number of steps actually shown MUST equal the total we
	// promised in every "Step N of {total}" header.  If they differ, the numbering
	// misled the operator (someone added/removed a step without updating totalSteps).
	// Loud but non-fatal — the install already succeeded.
	if (currentStepNum() !== totalSteps) {
		console.error(
			`\n  [morphit] internal: wizard showed ${currentStepNum()} steps but announced ${totalSteps}.` +
				'\n  The install is fine; please report this numbering bug.\n'
		);
	}
	// public-reachability self-check. A home box behind a router can't
	// tell it's unreachable by curling its own domain (NAT hairpin), so operators
	// used to discover an ISP 80/443 block only via a stale "Unreachable"
	// federation pill hours later. Probe from an external Tor exit (the node
	// already runs Tor) and say plainly, right now, whether the internet can
	// reach this box — and point at the .onion, which works regardless. Home
	// only: a VPS has a static public IP and no home-router/ISP block to hit.
	if (inputs.mode === 'home' && !inputs.torOnly) {
		const reachScript = join(opts.repoRoot, 'ops', 'scripts', 'morphit-reachability-check.sh');
		if (existsSync(reachScript)) {
			// Its Tor probes are silent for up to 30 s each: run it under the
			// turning spinner and show its report after.
			showOutput(
				await runSpinning(
					'Checking the internet can reach this node (through Tor — up to a few minutes)…',
					'bash',
					[reachScript, inputs.domain],
					{ timeoutMs: 10 * 60_000 }
				)
			);
		}
	}
	return 0;
}
