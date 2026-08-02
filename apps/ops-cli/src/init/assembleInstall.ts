/**
 * assembleInstall.ts (cp600) — the ORCHESTRATION backbone of the grandma
 * install runner.  The interactive front-end (compose the wizard's account /
 * active-key / fees steps + collectInstallInputs) hands this a finished plan;
 * this drives the irreversible, order-sensitive part and is dependency-injected
 * so its safety invariants are unit-tested even though the real spawn + apt
 * can't run in CI.
 *
 * Invariants this guarantees (and the smoke pins):
 *   - the vars file (which contains the generated DB secrets) is written 0600;
 *   - the operator is made to SAVE those secrets BEFORE the playbook runs;
 *   - Ansible is confirmed present before we try to run it;
 *   - the playbook runs LOCALLY via the shared argv builder;
 *   - the secret-bearing vars file is ALWAYS removed afterwards — success OR
 *     failure (finally), so DB passwords never linger in a temp file;
 *   - a non-zero exit turns into a plain, reassuring message (a re-run is safe).
 */
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildAnsiblePlaybookArgv, renderVarsFile } from './ansibleVars.ts';
import { promptSaveSecrets, type SecretToSave } from './saveSecrets.ts';

export interface PostInstallStep {
	/** Human-readable name for the "couldn't set this up" fallback message. */
	readonly label: string;
	/** argv to run (best-effort) after the playbook succeeds. */
	readonly argv: readonly string[];
}

export interface InstallPlan {
	/** group_vars/vault overrides from buildAnsibleVars(). */
	readonly vars: Record<string, unknown>;
	/** The generated secrets the operator must save (DB passwords, …). */
	readonly secretsToSave: readonly SecretToSave[];
	/** Absolute path to ops/ansible/playbook.yml on this box. */
	readonly playbookPath: string;
	/** Where to write the transient 0600 vars file. */
	readonly varsFilePath: string;
	/** Best-effort steps run AFTER a successful install (e.g. the desktop
	 *  upgrade notifier on a home box). A failure here never fails the install. */
	readonly postInstall?: readonly PostInstallStep[];
}

export interface AssembleDeps {
	readonly writeVarsFile?: (path: string, content: string) => void;
	readonly removeVarsFile?: (path: string) => void;
	readonly promptSave?: (secrets: readonly SecretToSave[]) => Promise<void>;
	/** Ensure `ansible-playbook` is runnable (apt-install if missing) AND the
	 *  required Galaxy collections are installed. Returns false if it still
	 *  isn't available. Given the ansible dir (to find collections/requirements.yml). */
	readonly ensureAnsible?: (ansibleDir: string) => Promise<boolean>;
	/** Run argv, streaming output; resolve with the process exit code. */
	readonly spawn?: (argv: readonly string[]) => Promise<number>;
	/** Resolve how many hosts the playbook targets (pre-flight guard). */
	readonly probeHostCount?: (argv: readonly string[]) => number;
	readonly print?: (s: string) => void;
}

export type AssembleResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// ─── Real (Beelink-validated) implementations ────────────────────
function realWrite0600(path: string, content: string): void {
	writeFileSync(path, content, { mode: 0o600 });
}
function realRemove(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* already gone — fine */
	}
}
async function realEnsureAnsible(ansibleDir: string): Promise<boolean> {
	const have = spawnSync('ansible-playbook', ['--version'], { stdio: 'ignore' });
	if (have.status !== 0) {
		// Not present — install it (needs root; the bootstrap + install run as root).
		spawnSync('apt-get', ['update', '-qq'], { stdio: 'inherit' });
		spawnSync('apt-get', ['install', '-y', 'ansible'], { stdio: 'inherit' });
	}
	if (spawnSync('ansible-playbook', ['--version'], { stdio: 'ignore' }).status !== 0) return false;
	// The playbook uses community.general / community.postgresql / community.docker;
	// apt's `ansible` may not bundle them (and `ansible-core` bundles none), so
	// install them explicitly.  Best-effort: if this can't reach Galaxy, the
	// playbook itself will fail with a clear "couldn't resolve module" pointing
	// at the exact missing collection.
	const reqs = join(ansibleDir, 'collections', 'requirements.yml');
	if (existsSync(reqs)) {
		spawnSync('ansible-galaxy', ['collection', 'install', '-r', reqs], { stdio: 'inherit' });
	}
	return true;
}
async function realSpawn(argv: readonly string[]): Promise<number> {
	const [cmd, ...args] = argv;
	if (cmd === undefined) return 1;
	const r = spawnSync(cmd, args, { stdio: 'inherit' });
	return r.status ?? 1;
}
/** Resolve how many hosts the playbook's pattern matches WITHOUT running it
 *  (`--list-hosts`).  Ansible prints "hosts (N):" per play; take the max.
 *  Returns 0 when the pattern matches nothing — the exact pre-flight that would
 *  have caught the inline-inventory `morphit_servers` mismatch. */
function realProbeHostCount(argv: readonly string[]): number {
	const [cmd, ...args] = argv;
	if (cmd === undefined) return 0;
	const r = spawnSync(cmd, args, { encoding: 'utf8' });
	const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
	let max = 0;
	for (const m of out.matchAll(/hosts \((\d+)\):/g)) max = Math.max(max, Number(m[1]));
	return max;
}

/** Drive the plan.  Order + cleanup are the whole point — see the header. */
export async function assembleInstall(plan: InstallPlan, deps: AssembleDeps = {}): Promise<AssembleResult> {
	const print = deps.print ?? ((s: string): void => console.log(s));
	const writeVarsFile = deps.writeVarsFile ?? realWrite0600;
	const removeVarsFile = deps.removeVarsFile ?? realRemove;
	const promptSave = deps.promptSave ?? promptSaveSecrets;
	const ensureAnsible = deps.ensureAnsible ?? realEnsureAnsible;
	const spawn = deps.spawn ?? realSpawn;
	const probeHostCount = deps.probeHostCount ?? realProbeHostCount;

	// 1. Write the vars file FIRST (0600 — it carries the DB secrets).
	writeVarsFile(plan.varsFilePath, renderVarsFile(plan.vars));
	try {
		// 2. Make the operator save the generated secrets BEFORE we install —
		//    if anything later fails, they already have their copy.
		await promptSave(plan.secretsToSave);

		// 3. Ansible must be runnable.
		const haveAnsible = await ensureAnsible(dirname(plan.playbookPath));
		if (!haveAnsible) {
			return {
				ok: false,
				reason: 'Ansible could not be installed automatically. Install it with `sudo apt-get install -y ansible`, then run this again.'
			};
		}

		// 3b. PRE-FLIGHT: confirm the playbook's host pattern actually matches a
		//     machine before we run — and before we ever tell the operator it
		//     "worked". Ansible exits 0 on a 0-host play, so without this a
		//     host-pattern mismatch silently installs NOTHING (the bug this fixes).
		const probeArgv = buildAnsiblePlaybookArgv({
			playbookPath: plan.playbookPath,
			varsFilePath: plan.varsFilePath,
			listHosts: true
		});
		if (probeHostCount(probeArgv) < 1) {
			return {
				ok: false,
				reason: 'The installer found no machine to configure (Ansible matched 0 hosts). This is a bug in the installer itself, not something you did \u2014 please report it; a re-run won\u2019t help until it\u2019s patched.'
			};
		}

		// 4. Run the playbook against THIS box.
		print('\n  Setting up your node \u2014 this takes several minutes. Ansible\u2019s progress is below.\n');
		const argv = buildAnsiblePlaybookArgv({ playbookPath: plan.playbookPath, varsFilePath: plan.varsFilePath });
		const code = await spawn(argv);
		if (code !== 0) {
			return {
				ok: false,
				reason: `The installer stopped with exit code ${code}. Nothing is left in a state a re-run can\u2019t fix \u2014 check the messages above, then run this again.`
			};
		}

		// Best-effort post-install steps (e.g. the desktop upgrade notifier on a
		// home box). A failure here does NOT fail the install — the node is up —
		// but we tell the operator how to do it later.
		for (const item of plan.postInstall ?? []) {
			const rc = await spawn(item.argv);
			if (rc !== 0) {
				print(`\n  Note: couldn\u2019t set up ${item.label} automatically (not essential).`);
				print(`  You can do it later with:  ${item.argv.join(' ')}`);
			}
		}
		return { ok: true };
	} finally {
		// 5. NEVER leave the DB secrets sitting in a temp file.
		removeVarsFile(plan.varsFilePath);
	}
}
