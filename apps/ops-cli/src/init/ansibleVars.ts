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
	/** Friendly instance title (MORPHIT_INSTANCE_NAME) — the site header + the
	 *  name on the shared /instances directory.  REQUIRED (register needs it). */
	readonly instanceName: string;
	/** One-line description (MORPHIT_INSTANCE_TAGLINE) — shown under the title on
	 *  the /instances directory + as the SEO/link-preview blurb.  Optional. */
	readonly instanceTagline?: string;
	/** Operator contact link (MORPHIT_INSTANCE_CONTACT_URL) — drives the "Contact
	 *  this operator" link on the /instances card.  The wizard collects an
	 *  optional Matrix account (@you:matrix.org) and stores it as a matrix.to URL;
	 *  undefined means the operator has none yet (the card omits the link). */
	readonly contactUrl?: string;
	/** Operator's BLURT account (signs registration/releases, collects fees). */
	readonly operatorAccount: string;
	/** Short attribution tag (often == operatorAccount). */
	readonly operatorTag: string;
	/** Email for Let's Encrypt / certbot (expiry notices). */
	readonly acmeEmail: string;
	/** Auto-publish the on-chain operator registration the first time the box
	 *  sees the internet (morphit-first-online). Opt-in; false = register by hand. */
	readonly autoRegister: boolean;
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
	if (!/^https:\/\//i.test(u)) return 'must start with https:// (your DNS provider\u2019s dynamic-DNS update URL)';
	// {ip} is OPTIONAL. If present, the updater replaces it with the detected
	// public IP; if absent, it pushes the URL as-is and the provider detects the
	// caller's IP itself (Namecheap, for one, documents `ip=` as optional). So we
	// require only a well-formed https URL, not the {ip} token.
	return true;
}
export function validateOperatorAccount(name: string): true | string {
	return /^[a-z0-9.-]{3,16}$/.test(name.trim()) ? true : 'is not a valid BLURT account name (3\u201316 chars, a\u2013z 0\u20139 . -)';
}
/** The instance title (MORPHIT_INSTANCE_NAME).  Required + capped at 64 to match
 *  the indexer's Zod `z.string().max(64)`. */
export function validateInstanceTitle(title: string): true | string {
	const t = title.trim();
	if (t.length === 0) return 'is required (it names your marketplace on the shared directory)';
	if (t.length > 64) return 'must be 64 characters or fewer';
	return true;
}

/** Validate an optional Matrix contact — EITHER an account (an MXID, e.g.
 *  @you:matrix.org) OR a room (an alias, e.g. #room:matrix.org).  An EMPTY value
 *  is VALID — the operator may not want one.  A non-empty value must look like a
 *  real account or room (@localpart:domain.tld / #alias:domain.tld) so a typo
 *  can't produce a dead "Contact this operator" link.  Letting operators point at
 *  a ROOM means the link can open a shared support channel rather than a personal
 *  account, if that is what they prefer.  PURE. */
export function validateMatrixAddress(raw: string): true | string {
	const v = raw.trim();
	if (v.length === 0) return true; // optional — Enter to skip
	// @localpart:server (account) OR #alias:server (room), where server is a domain
	// (dot + TLD). Deliberately lenient on the localpart/alias (Matrix allows
	// ._=-/+ etc.), strict on the overall shape. The leading sigil picks which:
	// '@' = a person to DM, '#' = a room to join.
	if (!/^[@#][^\s:@/]+:[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) {
		return 'is not a Matrix account or room \u2014 it should look like @you:matrix.org or #room:matrix.org';
	}
	return true;
}

/** Turn a validated Matrix contact into a universally-clickable URL.  matrix.to is
 *  the form Matrix itself recommends for sharing — it opens in any browser and
 *  lets the visitor pick their client, so the "Contact this operator" link works
 *  even where no matrix: handler is registered.  Works for BOTH an account
 *  (@you:server → matrix.to/#/@you:server) and a room alias (#room:server →
 *  matrix.to/#/#room:server); both are valid matrix.to targets.  `safeContactUrl`
 *  accepts the https result.  Caller guarantees `address` already passed
 *  validateMatrixAddress.  PURE. */
export function matrixToContactUrl(address: string): string {
	return `https://matrix.to/#/${address.trim()}`;
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
	const title = validateInstanceTitle(inputs.instanceName);
	if (title !== true) problems.push(`instance title ${title}.`);
	// Optional contact link — when present it must pass the same scheme guard the
	// frontend re-applies before rendering (matrix:/https:/mailto:/xmpp:/nostr:).
	if (inputs.contactUrl !== undefined && inputs.contactUrl.length > 0) {
		if (!/^(https?|matrix|mailto|xmpp|nostr):/i.test(inputs.contactUrl.trim())) {
			problems.push('contactUrl must be a matrix:/https:/mailto:/xmpp:/nostr: link.');
		}
	}
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
		// The playbook's `hosts:` is `{{ morphit_target_hosts | default('morphit_servers') }}`.
		// A LOCAL grandma install runs against the inline `localhost,` inventory, where
		// localhost lands in the implicit `all` group — NOT `morphit_servers` — so without
		// this the play matched 0 hosts and silently no-op'd (exit 0, nothing installed).
		// Pinning it to `localhost` here makes the SAME playbook serve both this local
		// install and the documented remote `[morphit_servers]` inventory (which just
		// omits this var and gets the default).
		morphit_target_hosts: 'localhost',
		// A grandma install ALWAYS runs against localhost over connection=local
		// (`morphit-ops install` configures the very box it runs on), so tell the
		// playbook's connection-safety assert this is a local install — running as
		// root via sudo is fine here (there is no SSH session to lock out). The
		// documented remote `[morphit_servers]` inventory omits this var and gets
		// the group_vars default (false), so the root-over-SSH guard still bites.
		morphit_local_install: true,
		// The relay account IS the operator account (see relay.env.j2); the
		// wizard-written keystore path + the operator's fees account:
		morphit_relay_keystore_path: inputs.keystorePath,
		morphit_fee_recipient: inputs.feesAccount,
		// Instance identity shown on the shared /instances directory (indexer
		// reads these from indexer.env → its /instance API → the federated list).
		morphit_instance_name: inputs.instanceName,
		morphit_instance_tagline: inputs.instanceTagline ?? '',
		tls_acme_email: inputs.acmeEmail,
		morphit_auto_register: inputs.autoRegister,
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
	// Optional operator contact link (the /instances "Contact this operator"
	// link); omitted entirely when the operator gave no Matrix account.
	if (inputs.contactUrl) {
		vars.morphit_instance_contact_url = inputs.contactUrl;
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
 *  box.  `hosts:` is pinned to localhost via the morphit_target_hosts extra-var
 *  (in the vars file).  Pass `listHosts` to RESOLVE the target hosts without
 *  running anything — used as a pre-flight guard so a 0-host play can never
 *  again masquerade as a successful install.  PURE. */
export function buildAnsiblePlaybookArgv(opts: {
	playbookPath: string;
	varsFilePath: string;
	check?: boolean;
	listHosts?: boolean;
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
	if (opts.listHosts) argv.push('--list-hosts');
	return argv;
}
