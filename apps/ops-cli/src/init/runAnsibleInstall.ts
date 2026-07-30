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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stepRelayAccount, stepActiveKey, stepFeesAccount, type ActiveKeyResult } from './steps.ts';
import { collectInstallInputs } from './collectInstallInputs.ts';
import { buildAnsibleVars, validateInstallInputs } from './ansibleVars.ts';
import { assembleInstall } from './assembleInstall.ts';
import type { SecretToSave } from './saveSecrets.ts';
import { step, ask } from './prompt.ts';

/** Ansible's `morphit_relay_keystore_path` default; we write the keystore here
 *  and pass the same path in the vars, so the two match by construction. */
const DEFAULT_KEYSTORE_PATH = '/etc/morphit/relay.keystore';
const VARS_FILE_PATH = '/run/morphit-install-vars.json';

/** The bytes to write for the relay keystore, from the wizard's active-key
 *  result: the encrypted envelope (JSON) or the plaintext WIF.  PURE — mirrors
 *  render.ts's keystore write so the guided install and the plain wizard agree. */
export function relayKeystoreContent(activeKey: ActiveKeyResult): string {
	return activeKey.mode === 'encrypted'
		? JSON.stringify(activeKey.envelope, null, 2)
		: (activeKey.plaintextWif ?? '');
}

function writeRelayKeystore(activeKey: ActiveKeyResult, keystorePath: string): void {
	mkdirSync(dirname(keystorePath), { recursive: true });
	writeFileSync(keystorePath, relayKeystoreContent(activeKey), { mode: 0o600 });
}

export async function runAnsibleInstall(opts: { repoRoot: string; keystorePath?: string }): Promise<number> {
	const keystorePath = opts.keystorePath ?? DEFAULT_KEYSTORE_PATH;

	step(1, 3, 'Your Blurt account and signing key');
	const relay = await stepRelayAccount();
	const activeKey = await stepActiveKey(relay.name); // held; written only once inputs validate
	const feesAccount = await stepFeesAccount(relay.name);

	step(2, 3, 'Your address and network');
	const inputs = await collectInstallInputs({
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
		console.log(
			'\n  One manual step before we install (home connections only):\n' +
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

	step(3, 3, 'Installing your node');
	const secretsToSave: SecretToSave[] = [
		{ label: 'Database password (marketplace data)', value: inputs.indexerDbPassword },
		{ label: 'Database password (account signups)', value: inputs.relayDbPassword }
	];
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
		varsFilePath: VARS_FILE_PATH,
		// Home boxes have a screen → set up the desktop upgrade notifier so
		// grandma gets a toast when a new version ships. Headless VPS: skip.
		postInstall:
			inputs.mode === 'home'
				? [
						{
							label: 'desktop upgrade notifications',
							argv: ['bash', join(opts.repoRoot, 'ops', 'desktop', 'morphit-upgrade-notify-setup.sh')]
						}
					]
				: []
	});
	if (!res.ok) {
		console.log(`\n  ${res.reason}\n`);
		return 1;
	}

	console.log('\n  \u2713 Your Morphit node is installed and running.');
	console.log('    It got (or will shortly get) its free HTTPS certificate automatically.');
	console.log('    Last step \u2014 put your instance on the shared map + start earning fees:');
	console.log('        sudo morphit-ops register\n');
	return 0;
}
