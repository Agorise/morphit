/**
 * i2p-wizard-wiring-smoke.
 *
 * Static guards on how the default-on I2P b32 feature is wired through the
 * wizard, so a refactor can't silently regress any of Ken's rules:
 *   - a fresh instance GENERATES a basic .b32.i2p (generateI2pDestination),
 *     guarded by i2pdAvailable() so a box without i2pd degrades gracefully,
 *   - it NEVER overwrites / regenerates over an address the operator already
 *     set — checked in both the env var and an existing config file — and a
 *     value typed in the alt-network step wins,
 *   - generation failure is non-fatal (the wizard continues),
 *   - the resolved address flows into altNetworks (→ the env var + footer
 *     pill) and the keyfile + tunnel stanza are written by render.ts.
 *
 * The derivation's correctness is in i2p-destination-smoke; whether i2pd
 * serves the address is a host concern (i2pd Ansible role + the operator's
 * deploy — i2pd's cold router init can't be exercised in-sandbox).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const initSrc = readFileSync(join(here, '../src/commands/init.ts'), 'utf8');
const renderSrc = readFileSync(join(here, '../src/init/render.ts'), 'utf8');
const spinnerSrc = readFileSync(join(here, '../src/init/spinner.ts'), 'utf8');

let pass = 0;
let fail = 0;
function expect(name: string, cond: boolean, msg = ''): void {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}${msg ? ` — ${msg}` : ''}`);
	}
}

// ─── init.ts: generate, guard, don't-overwrite, inject ───────────────
expect('imports the i2p generator', initSrc.includes("from '../init/i2pGenerate.ts'"));
expect('calls generateI2pDestination', initSrc.includes('generateI2pDestination()'));
expect('generation is guarded by i2pdAvailable()', initSrc.includes('i2pdAvailable()'));
expect(
	'defines resolveExistingI2pAddress (don\u2019t-overwrite)',
	/function resolveExistingI2pAddress/.test(initSrc)
);
expect(
	'don\u2019t-overwrite checks the env var',
	initSrc.includes('process.env.MORPHIT_INSTANCE_I2P_B32_ADDRESS')
);
expect(
	'don\u2019t-overwrite also checks an existing config file',
	initSrc.includes('MORPHIT_INSTANCE_I2P_B32_ADDRESS\\s*=')
);
expect('validates an existing address before reusing it', initSrc.includes("validateAltAddress('i2p'"));
expect(
	'a manually-entered / existing address wins (only generate when null)',
	/if \(i2pB32 === null\)/.test(initSrc)
);
expect('generation failure is non-fatal (wrapped in try/catch)', /try \{[\s\S]{0,200}generateI2pDestination/.test(initSrc));
expect('injects the resolved address into altNetworks', initSrc.includes('altNetworksFinal'));
expect('passes i2pDestination into the answers', /i2pDestination\b/.test(initSrc));

// ─── slow-generation spinner (Ken t.txt #1) ──────────────────────────
// i2pd's destination generation can take minutes on a small VPS; without
// on-screen motion an operator assumes a hang and Ctrl-C's out, losing the
// work. A 6-dot braille spinner + a "stand by" label reassures them.
expect('shows a spinner during the slow alt-dns generation', initSrc.includes('startDotsSpinner('));
expect(
	'spinner uses the exact stand-by message',
	initSrc.includes('Stand by, generating alt-dns addresses (this might take a few minutes)')
);
expect(
	'spinner is stopped on BOTH the success and the error path',
	(initSrc.match(/stopSpinner\(\)/g) ?? []).length >= 2
);
expect('spinner is TTY-aware (no animation on a non-tty)', /isTTY/.test(spinnerSrc));
expect('spinner stop is idempotent (guards a double-clear)', /stopped\b/.test(spinnerSrc));
expect('spinner restores the cursor on stop', spinnerSrc.includes('?25h'));

// ─── render.ts: writes the keyfile + tunnel stanza + the env var ─────
expect('render writes the i2pd keyfile', renderSrc.includes('I2P_KEYFILE_NAME'));
expect('render writes a tunnel stanza', renderSrc.includes('i2pTunnelStanza'));
expect('keyfile is written owner-only (0600)', /keyPath[\s\S]{0,90}0o600/.test(renderSrc));
expect(
	'the i2p b32 env var is emitted from altNetworks.i2pB32',
	renderSrc.includes('MORPHIT_INSTANCE_I2P_B32_ADDRESS=') && /altNetworks\.i2pB32/.test(renderSrc)
);
expect(
	'the keyfile write is gated on a generated destination (skip when preserved)',
	renderSrc.includes('answers.i2pDestination')
);

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 i2p-wizard-wiring smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} i2p-wizard-wiring checks passed`);
