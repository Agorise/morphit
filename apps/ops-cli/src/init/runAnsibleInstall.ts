/**
 * runAnsibleInstall.ts (cp600) — the guided full install: gather the operator's
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
import { mkdirSync, writeFileSync, readFileSync, existsSync, chownSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { stepRelayAccount, stepActiveKey, stepFeesAccount, type ActiveKeyResult } from './steps.ts';
import { collectInstallInputs, askInstallMode } from './collectInstallInputs.ts';
import { buildAnsibleVars, validateInstallInputs } from './ansibleVars.ts';
import { assembleInstall } from './assembleInstall.ts';
import { collectInstallSummary, printInstallSummary, allComponentsUp } from './installSummary.ts';
import { promptSaveSecrets, type SecretToSave } from './saveSecrets.ts';
import { step, beginSteps, endSteps, currentStepNum, ask } from './prompt.ts';

/** Ansible's `morphit_relay_keystore_path` default; we write the keystore here
 *  and pass the same path in the vars, so the two match by construction. */
const DEFAULT_KEYSTORE_PATH = '/etc/morphit/relay.keystore';
const VARS_FILE_PATH = '/run/morphit-install-vars.json';

/** morphit-first-online reads this env; MORPHIT_AUTO_REGISTER=yes tells it to
 *  publish the on-chain operator registration the moment the box is online. */
const FIRST_ONLINE_ENV_PATH = '/etc/morphit/first-online.env';

/** Arm the deferred on-chain registration by flipping MORPHIT_AUTO_REGISTER to
 *  yes in the first-online env.  This is what makes "list my instance" work on an
 *  OFFLINE appliance install: morphit-first-online publishes the registration the
 *  first time the box has internet + a healthy stack.  It's also a safety net when
 *  an immediate (online) registration attempt fails.  Best-effort — a missing env
 *  file just means the operator runs `morphit-ops register` by hand later. */
function armDeferredRegister(): void {
	try {
		if (!existsSync(FIRST_ONLINE_ENV_PATH)) return;
		const cur = readFileSync(FIRST_ONLINE_ENV_PATH, 'utf8');
		const next = /^MORPHIT_AUTO_REGISTER=/m.test(cur)
			? cur.replace(/^MORPHIT_AUTO_REGISTER=.*$/m, 'MORPHIT_AUTO_REGISTER=yes')
			: cur + (cur.endsWith('\n') ? '' : '\n') + 'MORPHIT_AUTO_REGISTER=yes\n';
		if (next !== cur) writeFileSync(FIRST_ONLINE_ENV_PATH, next, { mode: 0o644 });
	} catch {
		/* best-effort — the operator can always run `morphit-ops register` by hand */
	}
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

function writeRelayKeystore(activeKey: ActiveKeyResult, keystorePath: string): void {
	mkdirSync(dirname(keystorePath), { recursive: true });
	writeFileSync(keystorePath, relayKeystoreContent(activeKey), { mode: 0o600 });
	// cp663 #4 — the relay unit runs User=root with an EMPTY CapabilityBoundingSet
	// (no DAC_OVERRIDE), so root reads the keystore ONLY via the owner bit.  The
	// wizard may run as a non-root service user, which would leave the keystore
	// unreadable by the relay (EACCES).  Force root:root (the Ansible run also
	// re-asserts it — belt and braces).
	try {
		chownSync(keystorePath, 0, 0);
	} catch {
		/* not root / unsupported — the Ansible "Lock down keystore" task fixes it */
	}
	// cp663 #3 — for an encrypted key, seal the passphrase into the systemd
	// host-bound encrypted credential the relay unit consumes
	// (LoadCredentialEncrypted=relay_passphrase).  Without it the relay cannot
	// unlock unattended and the unit fails to start.
	if (activeKey.mode === 'encrypted' && activeKey.passphrase) {
		sealRelayPassphraseCred(activeKey.passphrase);
	}
}

/** Seal the relay unlock passphrase into the systemd host-bound encrypted
 *  credential (/etc/morphit/relay_passphrase.cred) that the relay unit loads.
 *  Best-effort: if systemd-creds is missing or fails, tell the operator the
 *  exact command (also in the unit file comments). */
function sealRelayPassphraseCred(passphrase: string): void {
	try {
		const r = spawnSync(
			'systemd-creds',
			['encrypt', '--name=relay_passphrase', '--with-key=host', '-', RELAY_CRED_PATH],
			{ input: passphrase, stdio: ['pipe', 'ignore', 'pipe'] }
		);
		if (r.status === 0) {
			try { chmodSync(RELAY_CRED_PATH, 0o600); } catch { /* systemd-creds writes 0600 already */ }
			console.log('  ✓ Sealed the relay unlock passphrase into /etc/morphit/relay_passphrase.cred');
			return;
		}
		warnCredManual((r.stderr?.toString() ?? '').trim());
	} catch (e) {
		warnCredManual(String(e));
	}
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

export async function runAnsibleInstall(opts: { repoRoot: string; keystorePath?: string }): Promise<number> {
	const keystorePath = opts.keystorePath ?? DEFAULT_KEYSTORE_PATH;

	// WHERE it runs is the one answer that changes the step count (home adds a DDNS
	// question, a router step, and desktop notifications), so ask it FIRST — before
	// the numbered steps — so the running "Step N of {total}" is accurate from step 1.
	const mode = await askInstallMode();
	// 3 account steps + 5 core questions + saving the DB passwords + the post-install
	// summary + the register opt-in, plus 3 more on a home box (DDNS, the router
	// port-forward, desktop notifications).  Keep in sync with the step() calls below
	// + in collectInstallInputs.
	const totalSteps = 3 + 5 + 3 + (mode === 'home' ? 3 : 0);
	beginSteps(totalSteps);

	const relay = await stepRelayAccount();
	const activeKey = await stepActiveKey(relay.name); // held; written only once inputs validate
	const feesAccount = await stepFeesAccount(undefined);

	const inputs = await collectInstallInputs({
		mode,
		operatorAccount: relay.name,
		operatorTag: relay.name, // default the tag to the account (avoids a domain-derived circular order)
		feesAccount,
		keystorePath
	});

	const problems = validateInstallInputs(inputs);
	if (problems.length > 0) {
		console.log('\n  A couple of answers need fixing before we can install:');
		for (const p of problems) console.log(`    - ${p}`);
		console.log('\n  Run this again to re-enter them.\n');
		return 1;
	}

	// Home boxes need the router pointed at this machine before certbot (in the
	// TLS role) can validate the domain — the one thing we can't do for them.
	if (inputs.mode === 'home') {
		step(0, 0, 'Point your home router at this computer');
		console.log(
			'  Before we install (home connections only):\n' +
				'    In your router, forward ports 80 and 443 to THIS computer, and make\n' +
				'    sure your domain is pointed here. Morphit keeps the address updated\n' +
				'    after that; the port-forward is a one-time router setting.\n'
		);
		const ready = await ask('Type YES once your router forwards 80 + 443 to this computer');
		if (ready.trim().toLowerCase() !== 'yes') {
			console.log('\n  No problem — set up the port-forward, then run this again.\n');
			return 1;
		}
	}

	// Only now (inputs valid, operator ready) write the keystore Ansible reads.
	writeRelayKeystore(activeKey, keystorePath);

	// Saving the generated DB password is its OWN step — and it happens BEFORE
	// the install banner, while the wizard is still interactive, so the operator
	// records it and types SAVED before the automatic part starts. There is ONE
	// shared database (indexer + relay both use it), hence one password.
	const secretsToSave: SecretToSave[] = [
		{ label: 'Database password', value: inputs.indexerDbPassword }
	];
	step(0, 0, 'Save your database password');
	await promptSaveSecrets(secretsToSave);

	// The install itself isn't a numbered step — it's the machine working, not a
	// question — so it gets a plain banner rather than a "Step N of N" header.
	console.log('\n══════════════════════════════════════════════════════════');
	console.log('Installing your node — this part is automatic, sit tight…');
	console.log('══════════════════════════════════════════════════════════\n');
	const res = await assembleInstall({
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
	}, {
		// Already saved as its own numbered step above — don't prompt for them again.
		promptSave: async (): Promise<void> => {}
	});
	if (!res.ok) {
		console.log(`\n  ${res.reason}\n`);
		return 1;
	}

	// A glance-able confirmation of what actually came up + is healthy — asked for
	// by a live operator who (reasonably) didn't want to trust a bare "installed"
	// line. Async: several rows are LIVE (indexer/relay /v1/health, on-chain balance).
	step(0, 0, 'Review your node');
	const summaryRows = await collectInstallSummary({
		domain: inputs.domain,
		mode: inputs.mode,
		enableBunkerweb: inputs.enableBunkerweb ?? true,
		// The playbook deploys to morphit_repo_path (group_vars default
		// /opt/morphit); the front-end build/ dir under it is what BunkerWeb
		// serves, so canary.txt + pgp_keys.asc + SEO surfaces are probed there.
		repoPath: '/opt/morphit',
		// The relay account IS the operator account — used for the on-chain
		// funding check (relay pays ~100 BLURT per signup).
		relayAccount: relay.name,
		// Show a ✓ for the "Contact this operator" link when a Matrix address
		// was given (the wizard stored it as contactUrl).
		contactConfigured: !!inputs.contactUrl
	});
	printInstallSummary(summaryRows);
	const everythingUp = allComponentsUp(summaryRows);

	console.log('\n  \u2713 Your Morphit node is installed and running.');
	console.log('    It got (or will shortly get) its free HTTPS certificate automatically.');

	// Home boxes have a screen → offer desktop upgrade notifications (a toast
	// when a new version ships). Headless VPS installs have no desktop, so skip.
	if (inputs.mode === 'home') {
		step(0, 0, 'Desktop notification when a new version ships');
		const notifyScript = join(opts.repoRoot, 'ops', 'desktop', 'morphit-upgrade-notify-setup.sh');
		if (await askYesNo('\n  Get a desktop notification when a new Morphit version is released?', true)) {
			const rc = spawnSync('bash', [notifyScript], { stdio: 'inherit' });
			if ((rc.status ?? 1) !== 0) {
				console.log('\n  Note: couldn\u2019t set that up automatically (not essential). Do it later with:');
				console.log(`        bash ${notifyScript}\n`);
			}
		}
	}

	// Now — AFTER the summary — offer to list this instance on the shared federated
	// directory (moved here from the questions up front, per the operator who
	// wanted to see the node actually come up before deciding).
	//
	// This works whether or not the box has internet right now.  Opting in ARMS
	// morphit-first-online to publish the registration the moment the box is online
	// and the stack is healthy — that's the whole offline-appliance path.  If
	// everything is already up we ALSO try right now, so an online operator sees it
	// published immediately; `register --non-interactive` is idempotent, so a
	// successful now-registration just makes the armed one a no-op.  We pass the
	// instance identity through the environment because a by-hand `register`
	// otherwise reads it from files this Ansible layout doesn't populate.
	step(0, 0, 'List your instance on the public federated directory');
	if (await askYesNo('\n  List this instance on the public federated directory (start earning fees)?', true)) {
		armDeferredRegister();
		if (everythingUp) {
			const rc = spawnSync('/usr/local/bin/morphit-ops', ['register'], {
				stdio: 'inherit',
				env: {
					...process.env,
					MORPHIT_RELAY_ACCOUNT: relay.name,
					MORPHIT_RELAY_ACTIVE_KEY_FILE: keystorePath,
					MORPHIT_INSTANCE_NAME: inputs.instanceName,
					MORPHIT_INSTANCE_ORIGIN: `https://${inputs.domain}`,
					MORPHIT_INSTANCE_OPERATOR_TAG: inputs.operatorTag
				}
			});
			if ((rc.status ?? 1) !== 0) {
				console.log('\n  Couldn\u2019t reach the chain just now \u2014 no problem: it\u2019s armed to list');
				console.log('  itself automatically the moment this box is online. Or do it by hand');
				console.log('  any time with:');
				console.log('        sudo morphit-ops register\n');
			}
		} else {
			console.log('\n  A few pieces above aren\u2019t up yet, so we won\u2019t list it this second \u2014 but');
			console.log('  it\u2019s armed to list itself automatically once everything is \u2713 and this box');
			console.log('  is online. Check any time with `sudo morphit-ops status`.\n');
		}
	} else {
		console.log('\n  No problem \u2014 list it whenever you\u2019re ready with:');
		console.log('        sudo morphit-ops register\n');
	}
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
	return 0;
}
