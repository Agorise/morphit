#!/usr/bin/env tsx
/**
 * mcp-webpush-install-defaults-smoke — locks down Ken's cp251
 * requirement: web push AND the MCP server are installed, enabled,
 * and started BY DEFAULT on a fresh node (via the canonical Ansible
 * installer), and stay operator-controllable.
 *
 * This is a STATIC wiring smoke — it reads the role / unit / script /
 * group_var files and asserts the wiring is present.  It does NOT run
 * Ansible or systemd (neither is available in CI / the dev sandbox);
 * the runtime behaviour (the isolated MCP deploy actually resolving
 * its deps, the relay sourcing the VAPID file) is exercised
 * separately — the deploy was verified end-to-end by hand, and the
 * relay ExecStart snippet by a bash dry-run — but ONLY a real fresh
 * Ubuntu box validates the full systemd activation. (See REVISIT.)
 *
 * Guards, by area:
 *   MCP (§45):
 *     - group_var morphit_mcp_enabled defaults true
 *     - the morphit role creates the morphit-mcp group + user, the
 *       isolated /opt/morphit-mcp dir, runs deploy-mcp.sh, installs
 *       the unit, and enables+starts it — ALL gated on the toggle
 *     - a Restart morphit-mcp handler exists
 *     - deploy-mcp.sh vendors BOTH workspace deps + rewrites them to
 *       file: deps + runs npm install (the isolation contract)
 *   Web push (§46):
 *     - group_vars morphit_enable_web_push (true) + morphit_vapid_subject
 *     - the role generates VAPID ONCE (creates: guard) gated on the
 *       toggle, and locks the file down
 *     - the relay unit sources /etc/morphit/relay-vapid.env optionally
 *     - generate-vapid-keys.sh supports --subject + --bare
 *
 * Emits one canonical line at column 0 on success.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

let checks = 0;
const failures: string[] = [];
function check(label: string, cond: boolean): void {
	checks++;
	if (!cond) failures.push(label);
}

const roleMain = read('ops/ansible/roles/morphit/tasks/main.yml');
const roleHandlers = read('ops/ansible/roles/morphit/handlers/main.yml');
const groupVars = read('ops/ansible/group_vars/all.yml');
const relayUnit = read('ops/systemd/morphit-relay.service');
const deployScript = read('ops/scripts/deploy-mcp.sh');
const vapidScript = read('scripts/generate-vapid-keys.sh');
const mcpUnit = read('ops/systemd/morphit-mcp.service');
const indexerUnit = read('ops/systemd/morphit-indexer.service');

// ── group_vars defaults ───────────────────────────────────────────
check(
	'group_vars: morphit_mcp_enabled defaults true',
	/^morphit_mcp_enabled:\s*true\s*$/m.test(groupVars)
);
check(
	'group_vars: morphit_enable_web_push defaults true',
	/^morphit_enable_web_push:\s*true\s*$/m.test(groupVars)
);
check(
	'group_vars: morphit_vapid_subject defined (origin-derived)',
	/^morphit_vapid_subject:\s*".*morphit_domain.*"\s*$/m.test(groupVars)
);

// ── MCP role wiring ───────────────────────────────────────────────
check('role: creates morphit-mcp group', /ansible\.builtin\.group:[\s\S]*?name:\s*morphit-mcp/.test(roleMain));
check(
	'role: creates morphit-mcp user (system, nologin)',
	/ansible\.builtin\.user:[\s\S]*?name:\s*morphit-mcp[\s\S]*?system:\s*true[\s\S]*?nologin/.test(roleMain)
);
check('role: ensures /opt/morphit-mcp dir', /path:\s*\/opt\/morphit-mcp[\s\S]*?state:\s*directory/.test(roleMain));
check('role: runs deploy-mcp.sh', /deploy-mcp\.sh/.test(roleMain));
check(
	'role: installs morphit-mcp.service unit',
	/dest:\s*\/etc\/systemd\/system\/morphit-mcp\.service/.test(roleMain)
);
check(
	'role: enables + starts morphit-mcp',
	/name:\s*morphit-mcp\s*\n\s*enabled:\s*true\s*\n\s*state:\s*started/.test(roleMain)
);
// every MCP task is gated on the toggle (count `when: morphit_mcp_enabled`
// occurrences ≥ the number of MCP tasks: group, user, dir, deploy, unit, enable = 6)
const mcpGateCount = (roleMain.match(/when:\s*morphit_mcp_enabled\s*\|\s*bool/g) ?? []).length;
check(`role: MCP tasks gated on morphit_mcp_enabled (found ${mcpGateCount}, need >=6)`, mcpGateCount >= 6);
check('handlers: Restart morphit-mcp exists', /name:\s*Restart morphit-mcp/.test(roleHandlers));

// ── deploy-mcp.sh isolation contract ──────────────────────────────
check('deploy-mcp.sh: vendors asset-registry', /vendor\/asset-registry/.test(deployScript));
check('deploy-mcp.sh: vendors net-defense', /vendor\/net-defense/.test(deployScript));
check(
	'deploy-mcp.sh: rewrites @morphit/* to file: deps',
	/file:\.\/vendor\/asset-registry/.test(deployScript) && /file:\.\/vendor\/net-defense/.test(deployScript)
);
check('deploy-mcp.sh: runs npm install', /npm install/.test(deployScript));
check('deploy-mcp.sh: chowns to the service user (isolation)', /chown\s+-R\s+"?\$SVC_USER/.test(deployScript));
// the unit it deploys for must actually be the isolated one
check('mcp unit: runs as morphit-mcp from /opt/morphit-mcp', /User=morphit-mcp/.test(mcpUnit) && /WorkingDirectory=\/opt\/morphit-mcp/.test(mcpUnit));

// ── Web push / VAPID wiring ───────────────────────────────────────
check(
	'role: generates VAPID with a creates: guard (generate-once)',
	/generate-vapid-keys\.sh[\s\S]*?creates:\s*\/etc\/morphit\/relay-vapid\.env/.test(roleMain)
);
check(
	'role: VAPID generation gated on morphit_enable_web_push',
	/generate-vapid-keys\.sh[\s\S]*?when:\s*morphit_enable_web_push\s*\|\s*bool/.test(roleMain)
);
check(
	'role: VAPID generation passes --bare --subject',
	/generate-vapid-keys\.sh[\s\S]*?--bare[\s\S]*?--subject/.test(roleMain)
);
check(
	'role: locks down the VAPID env file',
	/path:\s*\/etc\/morphit\/relay-vapid\.env[\s\S]*?mode:\s*'0640'/.test(roleMain)
);
check(
	'relay unit: sources /etc/morphit/relay-vapid.env (in the guarded source list)',
	/\/etc\/morphit\/relay-vapid\.env/.test(relayUnit) &&
		/for f in[^;]*relay-vapid\.env[^;]*;\s*do\s*\[\s*-f\s*"\$f"\s*\]\s*&&\s*\.\s*"\$f"/.test(relayUnit)
);
check('vapid script: supports --subject', /--subject/.test(vapidScript));
check('vapid script: supports --bare/--env', /--bare\|--env/.test(vapidScript));

// ── Env-routing: relay + indexer units source BOTH layouts ────────
// (the cp251 divergence fix — they must source the /etc/morphit/*.env
// files the Ansible playbook writes, not only the ops-cli /opt files)
check(
	'relay unit sources /etc/morphit/relay.env (Ansible layout)',
	/\/etc\/morphit\/relay\.env/.test(relayUnit)
);
check(
	'relay unit still sources /opt/morphit/morphit.env (ops-cli layout)',
	/\/opt\/morphit\/morphit\.env/.test(relayUnit)
);
check(
	'indexer unit sources /etc/morphit/indexer.env (Ansible layout)',
	/\/etc\/morphit\/indexer\.env/.test(indexerUnit)
);
check(
	'indexer unit still sources /opt/morphit/morphit.env (ops-cli layout)',
	/\/opt\/morphit\/morphit\.env/.test(indexerUnit)
);

// ── MCP config: own optional mcp.env, NOT the stale required relay.env
check(
	'mcp unit reads optional /etc/morphit/mcp.env',
	/EnvironmentFile=-\/etc\/morphit\/mcp\.env/.test(mcpUnit)
);
check(
	'mcp unit no longer hard-requires relay.env (isolation + no stale dep)',
	!/EnvironmentFile=\/etc\/morphit\/relay\.env/.test(mcpUnit)
);
check('role deploys mcp.env template', /mcp\.env\.j2/.test(roleMain) && /dest:\s*\/etc\/morphit\/mcp\.env/.test(roleMain));
check(
	'group_var morphit_mcp_instance_url defined (origin-derived)',
	/^morphit_mcp_instance_url:\s*".*morphit_domain.*"\s*$/m.test(groupVars)
);

// ── Result ────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(`mcp-webpush-install-defaults-smoke: ${failures.length} FAILED of ${checks}:`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log(`✓ all ${checks} mcp-webpush-install-defaults-smoke scenarios passed`);
