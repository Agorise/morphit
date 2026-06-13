/**
 * refresh-units-smoke — verifies refreshManagedUnits() brings installed
 * systemd unit files up to date with the repo templates on upgrade, with
 * its safety invariants:
 *   - only INSTALLED + CHANGED units are refreshed,
 *   - the prior file is backed up to <unit>.bak before overwrite,
 *   - drop-ins (<unit>.d/) are NEVER touched,
 *   - dry-run (apply:false) classifies but writes nothing,
 *   - .timer units are handled, non-unit files ignored,
 *   - a missing templateDir is a no-op, not a throw.
 *
 * Runs entirely against temp dirs — no real /etc/systemd/system.
 *
 * Usage (from apps/ops-cli):
 *   tsx scripts/refresh-units-smoke.ts
 */

import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	existsSync,
	mkdirSync,
	rmSync
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { refreshManagedUnits } from '../src/lib/refreshUnits.ts';

let failures = 0;
let scenarios = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}
function assertEq(a: unknown, b: unknown, label: string): void {
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
	}
}

function makeDirs(): { root: string; tmpl: string; sysd: string } {
	const root = mkdtempSync(join(tmpdir(), 'morphit-refresh-units-'));
	const tmpl = join(root, 'templates');
	const sysd = join(root, 'systemd');
	mkdirSync(tmpl, { recursive: true });
	mkdirSync(sysd, { recursive: true });
	return { root, tmpl, sysd };
}

console.log('\n── refresh systemd units ──────────────────────────────');

scenario('installed unit that differs is refreshed (with .bak), reloadNeeded', () => {
	const { root, tmpl, sysd } = makeDirs();
	try {
		writeFileSync(join(tmpl, 'morphit-relay.service'), 'NEW\n');
		writeFileSync(join(sysd, 'morphit-relay.service'), 'OLD\n');
		const { results, reloadNeeded } = refreshManagedUnits({
			templateDir: tmpl,
			systemdDir: sysd,
			apply: true
		});
		assertEq(reloadNeeded, true, 'reloadNeeded');
		const r = results.find((x) => x.unit === 'morphit-relay.service')!;
		assertEq(r.action, 'refreshed', 'action');
		assertEq(
			readFileSync(join(sysd, 'morphit-relay.service'), 'utf-8'),
			'NEW\n',
			'installed updated to template'
		);
		assert(existsSync(join(sysd, 'morphit-relay.service.bak')), 'backup created');
		assertEq(
			readFileSync(join(sysd, 'morphit-relay.service.bak'), 'utf-8'),
			'OLD\n',
			'backup holds the old content'
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

scenario('identical unit is unchanged (no backup written)', () => {
	const { root, tmpl, sysd } = makeDirs();
	try {
		writeFileSync(join(tmpl, 'morphit-indexer.service'), 'SAME\n');
		writeFileSync(join(sysd, 'morphit-indexer.service'), 'SAME\n');
		const { results, reloadNeeded } = refreshManagedUnits({
			templateDir: tmpl,
			systemdDir: sysd,
			apply: true
		});
		assertEq(reloadNeeded, false, 'reloadNeeded');
		assertEq(
			results.find((x) => x.unit === 'morphit-indexer.service')!.action,
			'unchanged',
			'action'
		);
		assert(!existsSync(join(sysd, 'morphit-indexer.service.bak')), 'no backup for unchanged');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

scenario('uninstalled template is skipped (not-installed), not created', () => {
	const { root, tmpl, sysd } = makeDirs();
	try {
		writeFileSync(join(tmpl, 'morphit-mcp.service'), 'X\n');
		const { results, reloadNeeded } = refreshManagedUnits({
			templateDir: tmpl,
			systemdDir: sysd,
			apply: true
		});
		assertEq(reloadNeeded, false, 'reloadNeeded');
		assertEq(
			results.find((x) => x.unit === 'morphit-mcp.service')!.action,
			'not-installed',
			'action'
		);
		assert(!existsSync(join(sysd, 'morphit-mcp.service')), 'refresh did not install it');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

scenario('drop-in directory + its override survive a refresh', () => {
	const { root, tmpl, sysd } = makeDirs();
	try {
		writeFileSync(join(tmpl, 'morphit-relay.service'), 'NEW\n');
		writeFileSync(join(sysd, 'morphit-relay.service'), 'OLD\n');
		const dropinDir = join(sysd, 'morphit-relay.service.d');
		mkdirSync(dropinDir, { recursive: true });
		const dropin = '[Service]\nRestrictAddressFamilies=AF_UNIX\n';
		writeFileSync(join(dropinDir, 'af-unix.conf'), dropin);
		refreshManagedUnits({ templateDir: tmpl, systemdDir: sysd, apply: true });
		assert(existsSync(join(dropinDir, 'af-unix.conf')), 'drop-in survives');
		assertEq(readFileSync(join(dropinDir, 'af-unix.conf'), 'utf-8'), dropin, 'drop-in untouched');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

scenario('dry-run classifies refreshed but writes nothing', () => {
	const { root, tmpl, sysd } = makeDirs();
	try {
		writeFileSync(join(tmpl, 'morphit-relay.service'), 'NEW\n');
		writeFileSync(join(sysd, 'morphit-relay.service'), 'OLD\n');
		const { results, reloadNeeded } = refreshManagedUnits({
			templateDir: tmpl,
			systemdDir: sysd,
			apply: false
		});
		assertEq(reloadNeeded, true, 'reloadNeeded (would reload)');
		const r = results.find((x) => x.unit === 'morphit-relay.service')!;
		assertEq(r.action, 'refreshed', 'action (would refresh)');
		assert(r.backupPath === undefined, 'no backupPath in dry-run');
		assertEq(
			readFileSync(join(sysd, 'morphit-relay.service'), 'utf-8'),
			'OLD\n',
			'installed NOT changed in dry-run'
		);
		assert(!existsSync(join(sysd, 'morphit-relay.service.bak')), 'no backup in dry-run');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

scenario('.timer handled; non-unit files (README) ignored', () => {
	const { root, tmpl, sysd } = makeDirs();
	try {
		writeFileSync(join(tmpl, 'morphit-backup.timer'), 'NEWTIMER\n');
		writeFileSync(join(sysd, 'morphit-backup.timer'), 'OLDTIMER\n');
		writeFileSync(join(tmpl, 'README.md'), 'docs\n');
		writeFileSync(join(sysd, 'README.md'), 'docs\n');
		const { results } = refreshManagedUnits({ templateDir: tmpl, systemdDir: sysd, apply: true });
		assert(
			results.some((x) => x.unit === 'morphit-backup.timer' && x.action === 'refreshed'),
			'timer refreshed'
		);
		assert(!results.some((x) => x.unit === 'README.md'), 'README ignored');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

scenario('missing templateDir returns empty result without throwing', () => {
	const { root, sysd } = makeDirs();
	try {
		const { results, reloadNeeded } = refreshManagedUnits({
			templateDir: join(root, 'does-not-exist'),
			systemdDir: sysd,
			apply: true
		});
		assertEq(results.length, 0, 'no results');
		assertEq(reloadNeeded, false, 'no reload');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

scenario('mixed inventory: only changed+installed units refresh', () => {
	const { root, tmpl, sysd } = makeDirs();
	try {
		writeFileSync(join(tmpl, 'morphit-relay.service'), 'NEW\n');
		writeFileSync(join(sysd, 'morphit-relay.service'), 'OLD\n');
		writeFileSync(join(tmpl, 'morphit-indexer.service'), 'SAME\n');
		writeFileSync(join(sysd, 'morphit-indexer.service'), 'SAME\n');
		writeFileSync(join(tmpl, 'morphit-mcp.service'), 'X\n');
		const { results, reloadNeeded } = refreshManagedUnits({
			templateDir: tmpl,
			systemdDir: sysd,
			apply: true
		});
		assertEq(reloadNeeded, true, 'reloadNeeded (relay changed)');
		const by = (u: string): string => results.find((x) => x.unit === u)!.action;
		assertEq(by('morphit-relay.service'), 'refreshed', 'relay');
		assertEq(by('morphit-indexer.service'), 'unchanged', 'indexer');
		assertEq(by('morphit-mcp.service'), 'not-installed', 'mcp');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

console.log('');
if (failures === 0) {
	console.log('──────────────────────────────────────────────────────');
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log('──────────────────────────────────────────────────────');
	console.log(`✗ ${failures} of ${scenarios} scenarios failed`);
	process.exit(1);
}
