/**
 * ansibleVars.ts (cp600) — the wizard↔Ansible bridge core.
 *
 * The grandma install runs the SAME full hardened playbook a VPS does; the only
 * home/VPS difference is networking (a home box's IP changes → DDNS) plus the
 * desktop notifier.  This module turns the wizard's eli5 answers into the
 * playbook's variable contract (group_vars + vault) and builds the argv to run
 * it LOCALLY (connection=local against localhost).
 *
 * Design notes that shape the mapping:
 *   - The playbook PROVISIONS PostgreSQL (creates the dbs/users), so we GENERATE
 *     fresh random DB passwords here rather than asking the operator for a
 *     database URL — Ansible creates the DB with these and writes the env.
 *   - `morphit_domain` is the BARE domain (TLS SERVER_NAME / cert), not a URL.
 *   - A home box sets `enable_ddns: true` + its provider update URL; a VPS
 *     leaves DDNS off.  Everything else (hardening, TLS, BunkerWeb WAF, …) is
 *     identical either way — nothing is lightened for home.
 *
 * Everything here is PURE + unit-tested; the actual `ansible-playbook` spawn +
 * apt-installing Ansible live in the (Beelink-validated) install runner.
 */
import { randomBytes } from 'node:crypto';

export type InstallMode = 'home' | 'vps';

export interface AnsibleInstallInputs {
	/** 'home' → dynamic IP behind a router (enables DDNS); 'vps' → static IP. */
	readonly mode: InstallMode;
	/** Bare public domain, e.g. "trade.example.com" (NOT a URL). */
	readonly domain: string;
	/** Operator's BLURT account (signs registration/releases, collects fees). */
	readonly operatorAccount: string;
	/** Short attribution tag (often == operatorAccount). */
	readonly operatorTag: string;
	/** Email for Let's Encrypt / certbot (expiry notices). */
	readonly acmeEmail: string;
	/** Random password Ansible provisions the indexer DB with. */
	readonly indexerDbPassword: string;
	/** Random password Ansible provisions the relay DB with. */
	readonly relayDbPassword: string;
	/** BLURT account that RECEIVES BLURT listing fees (the operator earns
	 *  these); defaults to the operator's own account in the wizard. */
	readonly feesAccount: string;
	/** Absolute path of the encrypted relay keystore the wizard wrote; Ansible
	 *  points MORPHIT_RELAY_ACTIVE_KEY_FILE at it, so we pass the wizard's
	 *  actual path (they match by construction). */
	readonly keystorePath: string;
	/** HOME only: DNS provider update URL with {ip}.  Required when mode==home. */
	readonly ddnsUpdateUrl?: string;
	/** Git ref to deploy (default "main"; a release tag for prod). */
	readonly gitRef?: string;
	/** Install the BunkerWeb WAF (default true — same as a VPS). */
	readonly enableBunkerweb?: boolean;
}

/** A cryptographically-random secret, as strong as is meaningful: 48 bytes =
 *  384 bits of entropy from the OS CSPRNG (256 bits is already physically
 *  unbreakable; we mint more for margin).  base64url so it is safe verbatim in
 *  env files, Postgres connection strings, shells, and URLs — no quoting, no
 *  shell-hostile characters.  UNIQUE on every call (crypto RNG, never seeded/
 *  reused). */
export function randomSecret(bytes = 48): string {
	return randomBytes(bytes).toString('base64url');
}

/** Per-field validators (return true, or a human-readable reason).  Shared by
 *  the interactive prompts (re-prompt on failure) AND the batch
 *  validateInstallInputs below, so the wizard and the bridge agree.  PURE. */
export function validateDomain(domain: string): true | string {
	return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim())
		? true
		: 'does not look like a bare domain (e.g. trade.example.com \u2014 no https://, no path)';
}
export function validateAcmeEmail(email: string): true | string {
	return /.+@.+\..+/.test(email.trim())
		? true
		: 'is not a valid email (Let\u2019s Encrypt sends certificate-expiry notices here)';
}
export function validateDdnsUrl(url: string): true | string {
	const u = url.trim();
	if (!/^https?:\/\//i.test(u)) return 'must start with https:// (your DNS provider\u2019s dynamic-DNS update URL)';
	if (!u.includes('{ip}')) return 'must contain {ip} where your provider wants the current IP address';
	return true;
}
export function validateOperatorAccount(name: string): true | string {
	return /^[a-z0-9.-]{3,16}$/.test(name.trim()) ? true : 'is not a valid BLURT account name (3\u201316 chars, a\u2013z 0\u20139 . -)';
}

/** Validate the whole input set; returns human-readable problems (empty = ok).
 *  Kept separate from the wizard's per-field prompts so the bridge can't emit a
 *  vars file that would make the playbook fail deep into a run.  PURE. */
export function validateInstallInputs(inputs: AnsibleInstallInputs): string[] {
	const problems: string[] = [];
	const d = validateDomain(inputs.domain);
	if (d !== true) problems.push(`domain "${inputs.domain}" ${d}.`);
	const acct = validateOperatorAccount(inputs.operatorAccount);
	if (acct !== true) problems.push(`operatorAccount "${inputs.operatorAccount}" ${acct}.`);
	const fa = validateOperatorAccount(inputs.feesAccount);
	if (fa !== true) problems.push(`feesAccount "${inputs.feesAccount}" ${fa}.`);
	if (!inputs.keystorePath.startsWith('/')) {
		problems.push(`keystorePath "${inputs.keystorePath}" must be an absolute path (the wizard writes the keystore there).`);
	}
	const e = validateAcmeEmail(inputs.acmeEmail);
	if (e !== true) problems.push(`acmeEmail ${e}.`);
	if (inputs.indexerDbPassword.length < 24 || inputs.relayDbPassword.length < 24) {
		problems.push('DB passwords must be strong (>= 24 characters \u2014 use randomSecret()).');
	}
	if (inputs.indexerDbPassword === inputs.relayDbPassword) {
		problems.push('the indexer and relay DB passwords must be DIFFERENT (generate each with its own randomSecret() call).');
	}
	if (inputs.mode === 'home') {
		const dd = validateDdnsUrl(inputs.ddnsUpdateUrl ?? '');
		if (dd !== true) problems.push(`home mode needs a DDNS update URL that ${dd}.`);
	}
	return problems;
}

/** Map validated inputs → the playbook's variable contract (group_vars/vault
 *  overrides passed via -e).  PURE. */
export function buildAnsibleVars(inputs: AnsibleInstallInputs): Record<string, unknown> {
	const vars: Record<string, unknown> = {
		morphit_domain: inputs.domain,
		morphit_operator_account: inputs.operatorAccount,
		morphit_operator_tag: inputs.operatorTag,
		// The relay account IS the operator account (see relay.env.j2); the
		// wizard-written keystore path + the operator's fees account:
		morphit_relay_keystore_path: inputs.keystorePath,
		morphit_fee_recipient: inputs.feesAccount,
		tls_acme_email: inputs.acmeEmail,
		// Secrets Ansible provisions the DB with (referenced as vault_* with
		// defaults in group_vars/all.yml).
		vault_postgres_indexer_password: inputs.indexerDbPassword,
		vault_postgres_relay_password: inputs.relayDbPassword,
		// Same full stack either way.
		enable_tls: true,
		enable_bunkerweb: inputs.enableBunkerweb ?? true,
		morphit_repo_ref: inputs.gitRef ?? 'main',
		// The ONE home/VPS difference.
		enable_ddns: inputs.mode === 'home'
	};
	if (inputs.mode === 'home' && inputs.ddnsUpdateUrl) {
		vars.morphit_ddns_update_url = inputs.ddnsUpdateUrl;
	}
	return vars;
}

/** Serialize vars for an Ansible `-e @file`.  We emit JSON, which Ansible
 *  accepts verbatim and which sidesteps every YAML-quoting pitfall (a stray
 *  ':' or leading '@' in a secret can't break it).  PURE. */
export function renderVarsFile(vars: Record<string, unknown>): string {
	return JSON.stringify(vars, null, 2) + '\n';
}

/** Build the argv for a LOCAL playbook run.  The inline `localhost,` inventory
 *  + `-c local` means no inventory file and no SSH — Ansible configures THIS
 *  box.  PURE. */
export function buildAnsiblePlaybookArgv(opts: {
	playbookPath: string;
	varsFilePath: string;
	check?: boolean;
}): string[] {
	const argv = [
		'ansible-playbook',
		'-i',
		'localhost,',
		'-c',
		'local',
		opts.playbookPath,
		'-e',
		`@${opts.varsFilePath}`
	];
	if (opts.check) argv.push('--check');
	return argv;
}
