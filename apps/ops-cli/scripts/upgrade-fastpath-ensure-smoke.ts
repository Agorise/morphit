/**
 * upgrade-fastpath-ensure-smoke (cp403 [1], ADR-0048).
 *
 * `morphit-ops upgrade` must, at the end of every upgrade, tell the
 * operator the effective state of the chat head-block fast path (sub-6s
 * message delivery) — so that on the VPS (where the knob is unset and the
 * config default is ON) fast chat is confirmed on after the upgrade, and
 * so it can never be silently off. This pins:
 *
 *   1. indexerEnvFiles — returns the same files the systemd unit sources,
 *      in the same order (later wins), honoring MORPHIT_ETC_DIR.
 *   2. effectiveFastPathState — 'default' (unset → config default ON),
 *      'on', 'off', later-file-wins, malformed-tolerant, missing-file-skip.
 *   3. Structural wiring: the upgrade flow computes the state via those
 *      two helpers and reports it, and does NOT force-flip an operator's
 *      explicit 'off' (respecting intent, not overriding it).
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { indexerEnvFiles, effectiveFastPathState } from '../src/commands/upgrade.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPGRADE_SRC = join(__dirname, '..', 'src', 'commands', 'upgrade.ts');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

// ── 1. indexerEnvFiles: order + MORPHIT_ETC_DIR ──
{
	const savedEtc = process.env.MORPHIT_ETC_DIR;
	delete process.env.MORPHIT_ETC_DIR;
	const files = indexerEnvFiles('/opt/morphit');
	if (
		files.length === 3 &&
		files[0] === '/opt/morphit/morphit.env' &&
		files[1] === '/opt/morphit/morphit.config.env' &&
		files[2] === '/etc/morphit/indexer.env'
	) {
		ok('1a indexerEnvFiles returns the 3 unit-sourced files in order (later wins)');
	} else {
		bad('1a indexerEnvFiles order', JSON.stringify(files));
	}

	process.env.MORPHIT_ETC_DIR = '/custom/etc';
	const f2 = indexerEnvFiles('/srv/morphit');
	if (f2[0] === '/srv/morphit/morphit.env' && f2[2] === '/custom/etc/indexer.env') {
		ok('1b indexerEnvFiles honors installDir + MORPHIT_ETC_DIR');
	} else {
		bad('1b indexerEnvFiles override', JSON.stringify(f2));
	}
	if (savedEtc === undefined) delete process.env.MORPHIT_ETC_DIR;
	else process.env.MORPHIT_ETC_DIR = savedEtc;
}

// ── 2. effectiveFastPathState across temp files ──
{
	const dir = mkdtempSync(join(tmpdir(), 'morphit-fp-'));
	const a = join(dir, 'a.env');
	const b = join(dir, 'b.env');
	const missing = join(dir, 'does-not-exist.env');
	try {
		// Unset everywhere → 'default' (config default is ON).
		writeFileSync(a, 'MORPHIT_INDEXER_START_BLOCK=59441298\n');
		if (effectiveFastPathState([a, missing]) === 'default')
			ok('2a unset in all files → default (config default ON)');
		else bad('2a unset → default');

		// Explicit true → 'on'.
		writeFileSync(a, 'MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED=true\n');
		if (effectiveFastPathState([a]) === 'on') ok('2b =true → on');
		else bad('2b =true → on');

		// Explicit false → 'off'.
		writeFileSync(a, 'MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED=false\n');
		if (effectiveFastPathState([a]) === 'off') ok('2c =false → off');
		else bad('2c =false → off');

		// Later file wins (systemd `set -a; . file` order): a=false, b=true → on.
		writeFileSync(a, 'MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED=false\n');
		writeFileSync(b, 'MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED=true\n');
		if (effectiveFastPathState([a, b]) === 'on') ok('2d later file wins (false then true → on)');
		else bad('2d later-wins');

		// Later file wins the other way: a=true, b=false → off.
		writeFileSync(a, 'MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED=true\n');
		writeFileSync(b, 'MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED=false\n');
		if (effectiveFastPathState([a, b]) === 'off') ok('2e later file wins (true then false → off)');
		else bad('2e later-wins-off');

		// Quotes + surrounding whitespace tolerated.
		writeFileSync(a, '  MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED = "false"  \n');
		if (effectiveFastPathState([a]) === 'off') ok('2f quoted/whitespaced =false → off');
		else bad('2f quoted value');

		// A missing file in the list is skipped, not fatal.
		writeFileSync(a, 'MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED=true\n');
		if (effectiveFastPathState([missing, a]) === 'on') ok('2g missing file skipped, real value read');
		else bad('2g missing-file skip');

		// A commented-out line is NOT a setting (anchored to line start).
		writeFileSync(a, '# MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED=false\n');
		if (effectiveFastPathState([a]) === 'default') ok('2h commented line ignored → default');
		else bad('2h commented line');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── 3. structural wiring in upgrade.ts ──
{
	const src = readFileSync(UPGRADE_SRC, 'utf-8');
	if (/effectiveFastPathState\(\s*indexerEnvFiles\(installDir\)\s*\)/.test(src))
		ok('3a upgrade computes state via effectiveFastPathState(indexerEnvFiles(installDir))');
	else bad('3a upgrade not wired to the helpers');

	if (src.includes('Fast chat is on (sub-6s message delivery)'))
		ok('3b upgrade reports fast chat ON');
	else bad('3b no ON confirmation');

	if (src.includes("fastPathState === 'off'") && src.includes('is DISABLED'))
		ok('3c upgrade warns when explicitly disabled');
	else bad('3c no disabled branch');

	// Must NOT force-flip an operator's explicit choice: no write of
	// the enable var back into an env file from the upgrade path.
	if (!/writeFileSync\([^)]*CHAT_FASTPATH/.test(src) && !/MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED\s*=\s*true['"]/.test(src.replace(/\.default\('true'\)/g, '')))
		ok('3d upgrade does NOT force-write the knob (respects explicit off)');
	else bad('3d upgrade force-writes the knob');

	if (src.includes('morphit-ops health'))
		ok('3e upgrade points operator to `morphit-ops health` to verify');
	else bad('3e no pointer to health view');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 upgrade-fastpath-ensure smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} upgrade-fastpath-ensure scenarios passed`);
