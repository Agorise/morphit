#!/usr/bin/env tsx
/**
 * ansible-env-template-required-vars-smoke.
 *
 * STRUCTURAL DEFENSE.
 *
 * Closes the class: every env var that the indexer/relay
 * Zod schema marks REQUIRED (no `.default()`, no `.optional()`)
 * MUST be present in the corresponding Ansible env template
 * (`ops/ansible/roles/morphit/templates/indexer.env.j2` and
 * `relay.env.j2`).  Without this, running the playbook on a
 * fresh host yields services that fail Zod validation at startup.
 *
 * Bug history:
 *   - Ansible templates last touched; canonical env
 *     examples updated through a later fix.
 *   - on playbook readiness surfaced
 *     `MORPHIT_INDEXER_PUBLIC_ORIGIN` missing from the indexer
 *     template despite being a `z.string().url()` required field.
 *     Indexer would crash at startup on a fresh deploy.
 *   - Fix landed inline; this smoke pins the pattern.
 *
 * Recurring class scope progression (6 defenses across 5 checkpoints):
 *   standalone smoke scripts
 *   vitest unit tests
 *   HTTP route handler regex
 *   ops-cli per-ticker hardcoded tables
 *   per-asset i18n FAQ key coverage
 *   Ansible env template required-var parity (THIS)
 *
 * Mutation test verification: — deleting
 * `MORPHIT_INDEXER_PUBLIC_ORIGIN` from indexer.env.j2 fires:
 *   "ansible-env-template-required-vars FAILED:
 *    indexer template missing required env var
 *    MORPHIT_INDEXER_PUBLIC_ORIGIN.  Indexer would fail Zod
 *    validation at startup."
 *
 * Limitations: parses the Zod schema textually with a regex.  If
 * the schema layout changes (e.g. nested z.object), the parser
 * may need updating.  Schema location is asserted (`z.object({`
 * inside `apps/indexer/src/config/index.ts` and
 * `apps/relay/src/config/index.ts`).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── ansible-env-template-required-vars smoke (cp52 LL #56 / O-6) ──\n');

interface SubsystemDef {
	name: string;
	configPath: string;
	templatePath: string;
}

const SUBSYSTEMS: SubsystemDef[] = [
	{
		name: 'indexer',
		configPath: join(__dirname, '..', 'src', 'config', 'index.ts'),
		templatePath: join(__dirname, '..', '..', '..', 'ops', 'ansible', 'roles', 'morphit', 'templates', 'indexer.env.j2')
	},
	{
		name: 'relay',
		configPath: join(__dirname, '..', '..', 'relay', 'src', 'config', 'index.ts'),
		templatePath: join(__dirname, '..', '..', '..', 'ops', 'ansible', 'roles', 'morphit', 'templates', 'relay.env.j2')
	},
	{
		// Added — matrix-bot has its own Ansible template under
		// roles/matrix_bot/ separate from the morphit role.  Its schema
		// is `const SCHEMA = z.object({` (not `envSchema`); the parser
		// regex above matches `envSchema|envSchema\s*=` — for matrix-bot
		// the parser does not match.  A later change also makes the regex match
		// `SCHEMA`-named schemas.
		name: 'matrix-bot',
		configPath: join(__dirname, '..', '..', 'matrix-bot', 'src', 'config.ts'),
		templatePath: join(__dirname, '..', '..', '..', 'ops', 'ansible', 'roles', 'matrix_bot', 'templates', 'matrix-bot.env.j2')
	}
];

function extractRequiredEnvVars(configSrc: string): string[] {
	// Find the envSchema (or SCHEMA — matrix-bot uses this) block start.
	const schemaIdx = configSrc.search(/(const\s+envSchema|envSchema\s*=|const\s+SCHEMA|SCHEMA\s*=)\s*z\.object\(\{/);
	if (schemaIdx === -1) {
		throw new Error('envSchema|SCHEMA = z.object({ ... }) not found');
	}
	// Walk braces from the first `{` after envSchema to find the
	// matching `}`.  Comments and strings tracked to avoid
	// `{` inside docblock prose or template-literal strings being
	// counted as scope-opening.
	const startBrace = configSrc.indexOf('{', schemaIdx);
	let depth = 0;
	let inString: false | "'" | '"' | '`' = false;
	let inLineComment = false;
	let inBlockComment = false;
	let endBrace = startBrace;
	for (let i = startBrace; i < configSrc.length; i++) {
		const ch = configSrc[i]!;
		const next = configSrc[i + 1];
		if (inLineComment) {
			if (ch === '\n') inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') { inBlockComment = false; i++; }
			continue;
		}
		if (inString) {
			if (ch === '\\') { i++; continue; }
			if (ch === inString) inString = false;
			continue;
		}
		if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
		if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
		if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) { endBrace = i + 1; break; }
		}
	}
	const block = configSrc.slice(startBrace, endBrace);

	// Find each MORPHIT_<X>: line.  For each, slice from that
	// position to the next MORPHIT_<X>: line (or end of block) and
	// look for `.default(` or `.optional(` in the body.
	const startRe = /^\s*(MORPHIT_[A-Z_]+):/gm;
	const matches: Array<{ name: string; idx: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = startRe.exec(block)) !== null) {
		matches.push({ name: m[1]!, idx: m.index });
	}
	const required: string[] = [];
	for (let i = 0; i < matches.length; i++) {
		const start = matches[i]!.idx;
		const end = i + 1 < matches.length ? matches[i + 1]!.idx : block.length;
		const body = block.slice(start, end);
		if (!bodyDeclaresOptional(body, configSrc)) {
			required.push(matches[i]!.name);
		}
	}
	return required;
}

/**
 * True if a field body marks the var optional/defaulted — either inline
 * (`.optional(` / `.default(`) OR by referencing a schema constant that is
 * itself optional/defaulted, e.g. `MORPHIT_X: hmacSecretSchema,` where
 * `const hmacSecretSchema = z.string()...optional()`. Resolving one level of
 * indirection keeps shared schema constants (good DRY — see the relay's
 * `hmacSecretSchema`) from being misread as required, which would otherwise
 * demand they be templated into Ansible even though leaving them unset is a
 * valid, secure default.
 */
function bodyDeclaresOptional(body: string, configSrc: string): boolean {
	if (body.includes('.optional(') || body.includes('.default(')) return true;
	const ref = body.match(/:\s*([A-Za-z_$][\w$]*)\s*,/);
	if (ref) {
		const ident = ref[1]!;
		const declIdx = configSrc.search(new RegExp(`\\bconst\\s+${ident}\\b\\s*=`));
		if (declIdx !== -1) {
			const semi = configSrc.indexOf(';', declIdx);
			const decl = configSrc.slice(declIdx, semi === -1 ? undefined : semi);
			if (decl.includes('.optional(') || decl.includes('.default(')) return true;
		}
	}
	return false;
}

for (const sub of SUBSYSTEMS) {
	try {
		const configSrc = readFileSync(sub.configPath, 'utf-8');
		const requiredVars = extractRequiredEnvVars(configSrc);

		console.log(`\n${sub.name}: ${requiredVars.length} required env vars from Zod schema`);
		for (const v of requiredVars) console.log(`  required: ${v}`);

		const templateSrc = readFileSync(sub.templatePath, 'utf-8');
		const missing: string[] = [];
		for (const v of requiredVars) {
			// Match `^<VAR>=` (top of line) in template
			const lineRe = new RegExp(`^${v}=`, 'm');
			if (!lineRe.test(templateSrc)) {
				missing.push(v);
			}
		}

		if (missing.length === 0) {
			pass(`${sub.name}: every required env var (${requiredVars.length}) is present in Ansible template`);
		} else {
			fail(
				`${sub.name}: every required env var is present in Ansible template`,
				`missing: [${missing.join(', ')}].  ${sub.name} would fail Zod validation at service startup on a fresh deploy.`
			);
		}
	} catch (e) {
		fail(`${sub.name}: parse + verify`, String(e));
	}
}

// ── Regression guard (shadow bug): operator-editable keys must live ONLY in
// morphit.config.env — NEVER in /etc/morphit/indexer.env. An Ansible install
// deploys BOTH, and the indexer unit sources indexer.env LAST, so if these keys
// were in indexer.env its install-time copy would silently shadow an operator's
// `morphit-ops edit` (this is exactly why a title change didn't take effect).
try {
	const ROLE = join(__dirname, '..', '..', '..', 'ops', 'ansible', 'roles', 'morphit', 'templates');
	const indexerEnv = readFileSync(join(ROLE, 'indexer.env.j2'), 'utf-8');
	const configEnv = readFileSync(join(ROLE, 'morphit.config.env.j2'), 'utf-8');
	const EDITABLE = [
		'MORPHIT_INSTANCE_NAME',
		'MORPHIT_INSTANCE_TAGLINE',
		'MORPHIT_INSTANCE_CONTACT_URL',
		'MORPHIT_INDEXER_FEE_RECIPIENT'
	];
	// Matches a real assignment at line start OR right after a Jinja conditional
	// (`{% if ... %}KEY="..."`, as morphit.config.env.j2 writes optional keys).
	const assign = (src: string, k: string): boolean =>
		new RegExp('(?:^|%\\}\\s*)' + k + '=', 'm').test(src);
	for (const k of EDITABLE) {
		if (assign(indexerEnv, k)) {
			fail(`shadow guard: ${k} must NOT be assigned in indexer.env.j2`,
				'It would shadow morphit.config.env (sourced first); operator edits via morphit-ops would silently not take effect.');
		} else if (!assign(configEnv, k)) {
			fail(`shadow guard: ${k} must be assigned in morphit.config.env.j2`,
				'The operator-editable source of truth must carry it, or the value is lost when it is not in indexer.env.');
		} else {
			pass(`shadow guard: ${k} lives only in morphit.config.env.j2 (operator edits win)`);
		}
	}
} catch (e) {
	fail('shadow guard: read env templates', String(e));
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nansible-env-template-required-vars smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} scenarios passed`);
