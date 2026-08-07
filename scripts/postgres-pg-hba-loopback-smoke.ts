#!/usr/bin/env tsx
/**
 * postgres-pg-hba-loopback — cp668.
 *
 * Encodes the invariant whose violation took morphit.lat's indexer down on its
 * first post-install reboot: the indexer AND the relay connect to Postgres via
 * `localhost:PORT` (= loopback TCP), so pg_hba.conf MUST contain a `host` rule
 * that lets the morphit_indexer user in over 127.0.0.1. The postgres role used
 * to DELETE the shipped `host all all 127.0.0.1/32` line ("restrict to local
 * only") and add nothing — so the very first time Postgres reloaded pg_hba.conf
 * the indexer died with `no pg_hba.conf entry for host "127.0.0.1"`.
 *
 * This guard fails if either side of the invariant drifts:
 *   - the DATABASE_URLs stop using loopback TCP, OR
 *   - the postgres role stops guaranteeing the scoped host rule.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── postgres-pg-hba-loopback (cp668) ───────────────────\n');

const pgRole = read('ops/ansible/roles/postgres/tasks/main.yml');
const indexerEnv = read('ops/ansible/roles/morphit/templates/indexer.env.j2');
const relayEnv = read('ops/ansible/roles/morphit/templates/relay.env.j2');

// ── premise: indexer + relay connect over loopback TCP (localhost:PORT) ──
const usesLoopbackTcp = (env: string): boolean => /postgresql:\/\/[^@]+@localhost:\{\{\s*postgres_port\s*\}\}\//.test(env);
const indexerTcp = usesLoopbackTcp(indexerEnv);
const relayTcp = usesLoopbackTcp(relayEnv);
check('indexer DATABASE_URL connects via localhost TCP', indexerTcp);
check('relay DATABASE_URL connects via localhost TCP', relayTcp);

// ── the invariant: if either uses loopback TCP, pg_hba MUST admit that user ──
const requiresHostRule = indexerTcp || relayTcp;

// A scoped host rule for the morphit_indexer DB+user over IPv4 loopback, using a
// jinja var (not a hardcoded name), with a real auth method (not trust).
const hasV4Rule =
	/host\s+\{\{\s*postgres_indexer_db\s*\}\}\s+\{\{\s*postgres_indexer_user\s*\}\}\s+127\.0\.0\.1\/32\s+(scram-sha-256|md5)/.test(pgRole);
const hasV6Rule =
	/host\s+\{\{\s*postgres_indexer_db\s*\}\}\s+\{\{\s*postgres_indexer_user\s*\}\}\s+::1\/128\s+(scram-sha-256|md5)/.test(pgRole);

check(
	'postgres role adds a scoped IPv4 loopback host rule for the indexer user',
	!requiresHostRule || hasV4Rule,
	'the indexer/relay use localhost TCP but pg_hba never permits that user'
);
check(
	'postgres role also covers IPv6 loopback (localhost may resolve to ::1)',
	!requiresHostRule || hasV6Rule
);

// the rule must NOT be `trust` (that would let anything on the box in unauthenticated)
check('the loopback rule authenticates (never `trust`)', !/127\.0\.0\.1\/32\s+trust/.test(pgRole));

// if the role still strips the permissive catch-all, that's fine — but it may not
// be the ONLY host-rule action (the regression was: strip, add nothing).
const stripsCatchAll = /regexp:\s*'\^host\\s\+all\\s\+all\\s\+'/.test(pgRole) && /state:\s*absent/.test(pgRole);
check(
	'if the permissive host-all rule is stripped, a scoped rule is still added',
	!stripsCatchAll || hasV4Rule,
	'stripping host-all-all without adding a scoped rule is exactly the cp668 outage'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} postgres-pg-hba-loopback checks passed` : '✗ postgres-pg-hba-loopback FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
