/**
 * requirements-consistency-smoke (v1.16.2)
 *
 * The minimum system requirements must read the SAME everywhere they face the
 * public: 2+ CPUs, 4+ GB RAM, 80+ GB drive (SSD is best). They used to drift —
 * some pages said 60 GB, others 20 GB, some said "2 GB minimum" RAM. This pins
 * the three surfaces that state them:
 *
 *   1. the frontend i18n requirement keys (all 10 locales),
 *   2. the operator doc RUN-A-MORPHIT-NODE.md,
 *   3. the installer's own pre-flight system check (ops-cli systemCheck.ts).
 *
 * Non-requirement mentions are deliberately NOT checked (BunkerWeb's footprint
 * on a <1 GB VPS, the alert-tuning vCPU range in OPERATIONS.md, the recommended
 * higher tier in PLAN.md, the REVISIT changelog).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
// Derive the locale set from the filesystem (the canonical source) rather than
// hardcoding it — keeps this smoke in step with locale-source-of-truth-smoke.
const LOCALE_DIR = 'apps/web/src/lib/i18n/locales';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const LOCALES = readdirSync(join(REPO, LOCALE_DIR))
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.slice(0, -'.json'.length))
	.sort();
// requirement-bearing i18n keys (dotted)
const REQ_KEYS = [
	'run_a_node.req_hw_value',
	'download.operator_distros_body',
	'run_a_node.step1_body',
	'faq.entries.node_minimum_requirements.a',
	'faq.entries.node_hosting_costs.a'
];
// keys whose canonical DISK figure (80) must literally appear
const DISK_KEYS = new Set([
	'run_a_node.req_hw_value',
	'run_a_node.step1_body',
	'faq.entries.node_hosting_costs.a',
	'faq.entries.node_minimum_requirements.a'
]);
// forbidden stale disk/RAM figures (ASCII + Persian digits)
const FORBIDDEN: RegExp[] = [
	/60\s*(?:GB|Go|ГБ|گ)/i, // old 60 GB disk (req_hw_value used to say 60)
	/\b20\s*(?:GB|Go|ГБ)/i, // old 20 GB disk
	/۲۰\s*گیگابایت/, // old 20 GB disk, Persian
	/۶۰\s*گیگابایت/ // old 60 GB disk, Persian
];

function get(obj: unknown, dotted: string): string | undefined {
	let o: unknown = obj;
	for (const p of dotted.split('.')) {
		if (o && typeof o === 'object' && p in (o as Record<string, unknown>))
			o = (o as Record<string, unknown>)[p];
		else return undefined;
	}
	return typeof o === 'string' ? o : undefined;
}

// ── 1. frontend i18n ──
for (const loc of LOCALES) {
	const d = JSON.parse(read(`apps/web/src/lib/i18n/locales/${loc}.json`));
	for (const key of REQ_KEYS) {
		const v = get(d, key);
		if (v === undefined) {
			check(`${loc} has ${key}`, false, 'key missing');
			continue;
		}
		if (DISK_KEYS.has(key)) {
			const has80 = v.includes('80') || /۸۰/.test(v);
			check(`${loc} ${key.split('.').pop()} states 80 GB`, has80);
		}
		for (const rx of FORBIDDEN) {
			const m = rx.exec(v);
			check(`${loc} ${key.split('.').pop()} no stale figure`, m === null, m ? m[0] : '');
		}
	}
}

// ── 2. operator doc ──
const doc = read('docs/RUN-A-MORPHIT-NODE.md');
check('RUN-A doc states 2+ CPUs', /2\+\s*CPUs/.test(doc));
check('RUN-A doc states 4+ GB RAM', /4\+\s*GB of RAM/.test(doc));
check('RUN-A doc states 80+ GB drive', /80\+\s*GB of drive/.test(doc));
check('RUN-A doc states SSD is best', /SSD is best/.test(doc));

// ── 3. installer pre-flight ──
const sc = read('apps/ops-cli/src/init/systemCheck.ts');
check('installer recommends ≥4 GB RAM', sc.includes("recommended: '≥4 GB'"));
check('installer recommends ≥80 GB disk', sc.includes("recommended: '≥80 GB'"));
check('installer recommends ≥2 CPU', sc.includes("recommended: '≥2'"));
check('installer dropped stale ≥2 GB RAM', !sc.includes("recommended: '≥2 GB'"));
check('installer dropped stale ≥20 GB disk', !sc.includes("recommended: '≥20 GB'"));

console.log(
	fail === 0
		? `✓ all ${pass} requirements-consistency checks hold`
		: `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
