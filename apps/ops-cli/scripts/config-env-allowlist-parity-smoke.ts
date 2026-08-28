/**
 * config-env-allowlist-parity-smoke
 *
 * loadOperatorConfig() throws FATALLY on any key in morphit.config.env that is
 * not in its allowlist — so if the setup wizard (render.ts) or the ansible
 * template (morphit.config.env.j2) writes a key the allowlist doesn't know, the
 * indexer AND relay crash-loop on first boot, taking the whole node down
 * (morphitir shipped exactly this: MORPHIT_INDEXER_FEE_RECIPIENT was written but
 * not allowlisted). This smoke makes that class of drift impossible to ship:
 * every MORPHIT_* key written into morphit.config.env by either writer must be
 * present in the operator-config allowlist.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');

// 1) the allowlist (the Set literal in operator-config)
const ocSrc = read(join(REPO, 'packages', 'operator-config', 'src', 'index.ts'));
const setStart = ocSrc.indexOf('new Set([');
const setBody = setStart >= 0 ? ocSrc.slice(setStart, ocSrc.indexOf('])', setStart)) : '';
const allow = new Set([...setBody.matchAll(/'(MORPHIT_[A-Z0-9_]+)'/g)].map((m) => m[1]));

// 2) keys each writer puts into morphit.config.env
const j2 = read(join(REPO, 'ops', 'ansible', 'roles', 'morphit', 'templates', 'morphit.config.env.j2'));
const j2Keys = [...j2.matchAll(/^(MORPHIT_[A-Z0-9_]+)=/gm)].map((m) => m[1]);

// render.ts pushes lines into the CONFIG env array; capture the MORPHIT_* keys
// it writes as `...=` template literals (the guided-installer path).
const render = read(join(REPO, 'apps', 'ops-cli', 'src', 'init', 'render.ts'));
const renderKeys = [...render.matchAll(/`(MORPHIT_[A-Z0-9_]+)=\$\{/g)].map((m) => m[1]);

const failures: string[] = [];
if (allow.size === 0) failures.push('could not parse the operator-config ALLOWLIST (Set literal not found)');
if (j2Keys.length === 0) failures.push('could not parse morphit.config.env.j2 (no MORPHIT_* keys found)');

// render.ts writes to several env files; only flag a render key when it is ALSO
// a config.env key (i.e. appears in the j2) — that scopes the check to the
// morphit.config.env writer without guessing render.ts's per-file routing.
const configKeys = new Set<string>(j2Keys);
for (const k of renderKeys) if (j2Keys.includes(k)) configKeys.add(k);

const missing = [...configKeys].filter((k) => !allow.has(k)).sort();
for (const k of missing) {
	failures.push(`morphit.config.env writes ${k} but it is NOT in the operator-config allowlist — loadOperatorConfig would abort the indexer + relay on boot. Add '${k}' to the ALLOWLIST in packages/operator-config/src/index.ts (or stop writing it to morphit.config.env).`);
}

if (failures.length > 0) {
	console.error('✗ config-env-allowlist-parity-smoke FAILED');
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log(
	`✓ all ${configKeys.size} morphit.config.env keys are in the operator-config allowlist (allowlist has ${allow.size} entries)`
);
