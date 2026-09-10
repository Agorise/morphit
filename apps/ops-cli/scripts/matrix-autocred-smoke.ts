/**
 * matrix-autocred-smoke — pins the Matrix auto-credential flow (v1.16.14): the
 * operator gives a recipient + bot username/password (or a token) and morphit-ops
 * mints + persists it with ZERO hand-editing, surviving an Ansible re-render.
 * Structural (the flow does real HTTP + systemd + fs), asserting the shape across
 * all four layers.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const rd = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const lib = rd('apps/ops-cli/src/lib/matrixBot.ts');
const matrix = rd('apps/ops-cli/src/commands/matrix.ts');
const wizard = rd('apps/ops-cli/src/init/collectInstallInputs.ts');
const harden = rd('apps/ops-cli/src/commands/harden.ts');
const opcfg = rd('packages/operator-config/src/index.ts');
const role = rd('ops/ansible/roles/matrix_bot/tasks/main.yml');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) pass++;
	else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

// Layer 1 — the mint + two-key writer live in the shared lib.
check('mintMatrixToken POSTs to the Matrix login API for a FRESH device', /export async function mintMatrixToken/.test(lib) && /_matrix\/client\/v3\/login/.test(lib) && /initial_device_display_name/.test(lib));
check('writeMatrixCreds writes BOTH the MXID and the token atomically', /export function writeMatrixCreds/.test(lib) && /KEY_MXID/.test(lib) && /KEY_TOKEN/.test(lib));

// Layer 2 — the interactive flow: mint OR paste, persist BOTH files, clear store, start, test.
check('token persists ONLY to the 0600 bot env; MXID (non-secret) to the config', /writeMatrixCreds\(mxid, token, MATRIX_BOT_ENV_PATH\)/.test(matrix) && /writeConfigMxid\(mxid, OPERATOR_CONFIG_PATH\)/.test(matrix));
check('configureMatrixAlerts clears the stale E2EE store before starting', /MATRIX_CRYPTO_STORE/.test(matrix) && /rmSync\(MATRIX_CRYPTO_STORE/.test(matrix));
check('configureMatrixAlerts offers mint (username+password) OR paste', /askChoice\([\s\S]{0,120}mint the token|username \+ password/.test(matrix));
check('configureMatrixAlerts never hangs in a non-interactive context', /process\.stdin\.isTTY/.test(matrix));

// Layer 3 — persistence: token is a managed operator-config key + the role reads it from config.
check('SECURITY: token is NOT a group-readable operator-config key (stays 0600)', !/'MORPHIT_MATRIX_BOT_ACCESS_TOKEN'/.test(opcfg) && /export function writeConfigMxid/.test(lib) && /statSync\(path\)\.mode/.test(lib));
check('role preserves the token from the 0600 live env + MXID from config (survives re-render, no leak)', /live="\/etc\/morphit\/matrix-bot\.env"/.test(role) && /token preserved from the 0600 live env/.test(role));

// Layer 4 — wired into all three entry points.
check('wired into `matrix setup` + status→setup offer', /action === 'setup'/.test(matrix) && /deps\.configure \?\? configureMatrixAlerts/.test(matrix));
check('wired into the install wizard (mint option)', /mintMatrixToken/.test(wizard) && /I mint the token for you/.test(wizard));
check('wired into harden (guided Matrix setup option)', /configureMatrixAlerts\(ctx\.colorEnabled\)/.test(harden));


if (fail === 0) {
	console.log(`\u2713 all ${pass} matrix-autocred checks passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} matrix-autocred checks FAILED`);
	process.exit(1);
}
