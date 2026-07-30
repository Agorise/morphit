/**
 * tor-wizard-wiring-smoke.
 *
 * Static guards on how the basic-onion-by-default feature is wired through
 * the wizard, so a refactor can't silently regress any of Ken's rules:
 *   - the wizard GENERATES a basic onion (generateOnionV3), in the
 *     BACKGROUND (a promise kicked off before the steps),
 *   - it NEVER overwrites an address the operator already set — checked in
 *     both the env var and an existing config file,
 *   - the Tor STEP is gone from the wizard (auto-generated, not asked),
 *   - the generated address flows into altNetworks (→ the env var, pill +
 *     Onion-Location), and the HS key files are written by render.ts.
 *
 * The generator's correctness is in tor-onion-smoke; render.ts's actual
 * file-writing is exercised behaviourally in init-smoke.  Whether a Tor
 * daemon serves the address is a host concern (tor Ansible role's
 * syntax/lint + the operator's deploy).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const initSrc = readFileSync(join(here, '../src/commands/init.ts'), 'utf8');
const stepsSrc = readFileSync(join(here, '../src/init/steps.ts'), 'utf8');
const renderSrc = readFileSync(join(here, '../src/init/render.ts'), 'utf8');

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

// ─── init.ts: generation, background, don't-overwrite, injection ─────
expect('imports the onion generator', initSrc.includes("from '../init/torOnion.ts'"));
expect('calls generateOnionV3', initSrc.includes('generateOnionV3()'));
expect('generation is kicked off in the background (onionPromise)', /onionPromise/.test(initSrc));
expect(
	'generation is deferred via a Promise (not awaited inline before steps)',
	initSrc.includes('Promise.resolve().then(() => generateOnionV3())')
);
expect('defines resolveExistingTorAddress (don\u2019t-overwrite)', /function resolveExistingTorAddress/.test(initSrc));
expect('don\u2019t-overwrite checks the env var', initSrc.includes('process.env.MORPHIT_INSTANCE_TOR_ADDRESS'));
expect('don\u2019t-overwrite also checks an existing config file', initSrc.includes('MORPHIT_INSTANCE_TOR_ADDRESS\\s*='));
expect('validates an existing address before reusing it', initSrc.includes("validateAltAddress('tor'"));
expect('injects the resolved address into altNetworks', initSrc.includes('altNetworksWithTor'));
expect('passes torOnion into the answers', /torOnion\b/.test(initSrc) && initSrc.includes('torOnion'));
// existing address ⇒ no generation, no key files (skip path)
expect('skips generation when an address already exists', initSrc.includes('existingTorAddress'));

// ─── steps.ts: the Tor question is GONE ──────────────────────────────
expect(
	'the old "generate a Tor hidden service now?" prompt is removed',
	!/Generate a Tor hidden service address now/.test(stepsSrc)
);
expect(
	'stepAltNetworks no longer collects a Tor address (auto-generated)',
	stepsSrc.includes('const tor: string | null = null;')
);
expect('stepAltNetworks explains Tor is automatic', /AUTOMATICALLY gets a Tor \.onion/.test(stepsSrc));

// ─── render.ts: writes the three Tor HS files + the env var ──────────
expect('render writes hs_ed25519_secret_key', renderSrc.includes('hs_ed25519_secret_key'));
expect('render writes hs_ed25519_public_key', renderSrc.includes('hs_ed25519_public_key'));
expect('render writes the hostname file', renderSrc.includes("'hostname'") || renderSrc.includes('hostname'));
expect('secret-key file is written owner-only (0600)', /secPath[\s\S]{0,80}0o600/.test(renderSrc));
expect(
	'the tor address env var is emitted from altNetworks.tor',
	renderSrc.includes('MORPHIT_INSTANCE_TOR_ADDRESS=') && /altNetworks\.tor/.test(renderSrc)
);

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 tor-wizard-wiring smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} tor-wizard-wiring checks passed`);
