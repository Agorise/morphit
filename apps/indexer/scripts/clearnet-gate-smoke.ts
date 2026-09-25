#!/usr/bin/env tsx
/**
 * clearnet-gate-smoke.ts (v1.15.x stage 4)
 * Pins the keystone: clearnet_eliminated is a STRICT AND of every leg (any one
 * false → false), and the Matrix-homeserver condition.
 */
import {
	computeClearnetEliminated,
	matrixHomeserverIsHidden,
	FRONTEND_IS_LOCAL_ONLY,
	type ClearnetEliminationLegs
} from '../src/indexer/clearnetGate.ts';

let pass = 0;
const fails: string[] = [];
const ok = (m: string, c: boolean): void => {
	if (c) {
		pass++;
		console.log(`  \u2713 ${m}`);
	} else {
		fails.push(m);
		console.log(`  \u2717 ${m}`);
	}
};

const ALL: ClearnetEliminationLegs = {
	chainHidden: true,
	transportTor: true,
	transportI2p: true,
	priceFederated: true,
	frontendLocal: true,
	upgradeHidden: true,
	matrixClean: true,
	// v1.18.0 (F32): the relay is a separate process with its own chain route.
	relayHidden: true
};

ok('all legs true → eliminated', computeClearnetEliminated(ALL) === true);
for (const leg of Object.keys(ALL) as Array<keyof ClearnetEliminationLegs>) {
	ok(`leg "${leg}" false → NOT eliminated`, computeClearnetEliminated({ ...ALL, [leg]: false }) === false);
}
// The state as shipped today (upgrade + matrix legs not yet wired) must be false.
ok('today (upgradeHidden+matrixClean false) → gate stays false', computeClearnetEliminated({ ...ALL, upgradeHidden: false, matrixClean: false }) === false);
// Dual-transport is mandatory: a node on Tor alone (no I2P) cannot claim zero-clearnet.
ok('Tor-only (no I2P) → NOT eliminated (dual-transport required)', computeClearnetEliminated({ ...ALL, transportI2p: false }) === false);
ok('I2P-only (no Tor) → NOT eliminated (dual-transport required)', computeClearnetEliminated({ ...ALL, transportTor: false }) === false);
// Diagnostic: missing legs listed for the operator.
{
	const { clearnetEliminationMissing } = await import('../src/indexer/clearnetGate.ts');
	ok('all legs true → nothing missing', clearnetEliminationMissing(ALL).length === 0);
	const miss = clearnetEliminationMissing({ ...ALL, upgradeHidden: false, transportI2p: false });
	ok('missing lists exactly the open legs', miss.length === 2 && miss.includes('upgradeHidden') && miss.includes('transportI2p'));
}

// Matrix homeserver condition.
ok('no homeserver → clean', matrixHomeserverIsHidden(null) === true && matrixHomeserverIsHidden('') === true);
ok('.onion homeserver → clean', matrixHomeserverIsHidden('http://abc.onion') === true);
ok('.i2p homeserver → clean', matrixHomeserverIsHidden('http://xyz.b32.i2p') === true);
ok('clearnet homeserver (matrix.org) → NOT clean', matrixHomeserverIsHidden('https://matrix.org') === false);
ok('unparseable homeserver → NOT clean (fail-safe)', matrixHomeserverIsHidden('not a url') === false);

ok('frontend-local build invariant is true', FRONTEND_IS_LOCAL_ONLY === true);

console.log('');
if (fails.length > 0) {
	console.log(`\u2717 ${fails.length} of ${pass + fails.length} clearnet-gate checks FAILED`);
	for (const f of fails) console.log(`    - ${f}`);
	process.exit(1);
}
console.log(`\u2713 all ${pass} clearnet-gate scenarios passed`);
