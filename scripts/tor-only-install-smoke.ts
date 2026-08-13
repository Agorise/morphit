#!/usr/bin/env tsx
/**
 * tor-only-install — cp705 (Layers 2 + 3). A node can be installed with NO
 * clearnet domain: the wizard offers Tor-only, skips the domain/cert/DDNS/router
 * steps (with a consistent step count), and ansible skips TLS + BunkerWeb's
 * clearnet edge while keeping the frontend, then points every origin at the
 * auto-generated onion.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0, fail = 0;
const check = (n: string, c: boolean): void => { if (c) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}`); fail++; } };

console.log('\n── tor-only-install (cp705) ───────────────────────────\n');
// ── Layer 2: wizard ──
const av = read('apps/ops-cli/src/init/ansibleVars.ts');
check('AnsibleInstallInputs has torOnly', /readonly torOnly: boolean/.test(av));
check('validateInstallInputs skips domain/cert/DDNS for torOnly', /if \(!inputs\.torOnly\) \{/.test(av));
check('buildAnsibleVars gates morphit_domain/enable_tls/enable_ddns + sets morphit_tor_only',
	/morphit_tor_only: inputs\.torOnly/.test(av) && /enable_tls: !inputs\.torOnly/.test(av) &&
	/morphit_domain: inputs\.torOnly \? '' : inputs\.domain/.test(av) &&
	/enable_ddns: inputs\.mode === 'home' && !inputs\.torOnly/.test(av));
const ci = read('apps/ops-cli/src/init/collectInstallInputs.ts');
check('askTorOnly picker exists', /export async function askTorOnly/.test(ci));
check('wizard skips domain + cert-email steps for torOnly', /if \(!torOnly\) \{/.test(ci) && /Email for your free HTTPS certificate/.test(ci));
check('DDNS step gated on home && !torOnly', /mode === 'home' && !torOnly/.test(ci));
const ra = read('apps/ops-cli/src/init/runAnsibleInstall.ts');
check('totalSteps formula accounts for torOnly',
	/3 \+ \(torOnly \? 4 : 6\) \+ 3 \+ \(mode === 'home' \? \(torOnly \? 2 : 4\) : 0\)/.test(ra));
check('router step skipped for torOnly', /inputs\.mode === 'home' && !inputs\.torOnly/.test(ra));
check('register + canary origins use the onion for torOnly (deriveInstanceOrigin)',
	/function deriveInstanceOrigin/.test(ra) && /\.onion/.test(ra) &&
	(ra.match(/deriveInstanceOrigin\(inputs\.torOnly/g) || []).length >= 2);
const su = read('apps/ops-cli/src/init/installSummary.ts');
check('summary skips HTTPS-cert + BunkerWeb-firewall rows for torOnly',
	/readonly torOnly: boolean/.test(su) && /enableBunkerweb && !inputs\.torOnly/.test(su) && /if \(!inputs\.torOnly\) \{/.test(su));
// ── Layer 3: ansible ──
const comp = read('ops/ansible/roles/bunkerweb/templates/docker-compose.yml.j2');
check('compose gates clearnet BunkerWeb services on !torOnly (frontend always present)',
	/\{% if not \(morphit_tor_only \| default\(false\)\) %\}/.test(comp) && /\{% endif %\}/.test(comp));
const bwt = read('ops/ansible/roles/bunkerweb/tasks/main.yml');
check('clearnet no-cache curls skipped for torOnly',
	(bwt.match(/not \(morphit_tor_only \| default\(false\)\)/g) || []).length >= 2);
const cfg = read('ops/ansible/roles/morphit/templates/morphit.config.env.j2');
const rel = read('ops/ansible/roles/morphit/templates/relay.env.j2');
check('instance + relay origins are torOnly-aware (filled post-tor)',
	/morphit_tor_only \| default\(false\)/.test(cfg) && /morphit_tor_only \| default\(false\)/.test(rel));
const pb = read('ops/ansible/playbook.yml');
check('post-tor fixup points instance + relay origins at the onion for torOnly',
	/Tor-only — point instance \+ relay origins at the onion/.test(pb) &&
	/MORPHIT_INSTANCE_ORIGIN=\{\{ morphit_onion_origin \}\}/.test(pb));

console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} tor-only-install checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
