/**
 * Load an instance's on-disk env files into process.env for `morphit-ops`
 * commands that broadcast on-chain.
 *
 * ── The gap this closes ──────────────────────────────────────────────
 *
 * `payment-method`, `register`, and `show-key` read infra settings —
 * `MORPHIT_RELAY_ACCOUNT`, `MORPHIT_OPERATOR_POSTING_KEY_FILE` — straight
 * from `process.env`. Those live in `morphit.env`, which on a systemd
 * deployment is sourced ONLY by the unit (`EnvironmentFile=`), never by
 * the operator's interactive shell. So running the command by hand fails
 * with `✗ MORPHIT_RELAY_ACCOUNT is not set.` even though the instance is
 * perfectly configured. (Before the systemd migration operators tended to
 * have the env in scope from their `screen` session; the migration removed
 * that, exposing the gap.)
 *
 * This bridges it by loading the instance's two env files on demand:
 *   - `morphit.config.env` (operator-tunable, allowlisted) via the
 *     canonical `@morphit/operator-config` loader.
 *   - `morphit.env` (infra/secrets, normally bash-sourced) via Node's
 *     `node:util.parseEnv`.
 *
 * The OS environment always wins (populate-if-missing), so an explicitly
 * exported value is never overwritten. It is BEST-EFFORT: a missing or
 * unreadable file — e.g. the root-only `morphit.env` opened without sudo —
 * is silently skipped, leaving the caller's own "not set" guard to fire
 * with guidance to re-run under sudo.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { loadOperatorConfig } from '@morphit/operator-config';

export interface InstanceEnvResult {
	/** morphit.config.env was found and its allowlisted keys applied. */
	readonly configLoaded: boolean;
	/** morphit.env was found, readable, and parsed. */
	readonly infraLoaded: boolean;
	/** Absolute path we looked for morphit.config.env at. */
	readonly configPath: string;
	/** Absolute path we looked for morphit.env at. */
	readonly infraPath: string;
}

export function loadInstanceEnv(repoRoot: string): InstanceEnvResult {
	const configPath = join(repoRoot, 'morphit.config.env');
	const infraPath = join(repoRoot, 'morphit.env');

	// 1) Operator-tunable config (allowlist-filtered, OS env wins).
	let configLoaded = false;
	try {
		const res = loadOperatorConfig({ searchPaths: [repoRoot] });
		configLoaded = res.file !== null;
	} catch {
		// Allowlist violation or unreadable file — not fatal here; the
		// command continues and its own guards report anything missing.
		configLoaded = false;
	}

	// 2) Infra/secrets (morphit.env). Populate-if-missing so an explicit
	//    OS-env export always takes precedence.
	let infraLoaded = false;
	if (existsSync(infraPath)) {
		try {
			const parsed = parseEnv(readFileSync(infraPath, 'utf-8'));
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value !== 'string') continue;
				if (process.env[key] !== undefined && process.env[key] !== '') continue;
				process.env[key] = value;
			}
			infraLoaded = true;
		} catch {
			infraLoaded = false;
		}
	}

	return { configLoaded, infraLoaded, configPath, infraPath };
}
