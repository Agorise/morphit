/**
 * nav-arrow-consistency-smoke — every directional arrow uses the shared
 * .nav-arrow affordance, so all arrows slide in their pointing direction and
 * turn emerald on hover/focus, and arrow-bearing links never underline (cp339,
 * the homepage "Learn more" effect, applied site-wide for consistency).
 *
 * WHY: arrows were scattered — tiny "→ / ←", bespoke inline SVGs, and one-off
 * Tailwind `rtl:-scale-x-100` + `group-hover:translate-x-1` classes. They must
 * all be `<span class="nav-arrow nav-arrow-{left|right}">⇦/⇨</span>`, with the
 * slide + color + RTL mirror + no-underline centralized in app.css. This smoke
 * pins:
 *   - no element still carries the old per-arrow rtl:-scale-x-100 class
 *   - the global .nav-arrow rules (slide, emerald, RTL mirror, no-underline)
 *     exist in app.css
 *   - the homepage cards no longer use the bespoke priorities-card-cta-arrow
 *
 * Usage (from apps/web): tsx scripts/nav-arrow-consistency-smoke.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');

function walkSvelte(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) walkSvelte(p, out);
		else if (p.endsWith('.svelte')) out.push(p);
	}
	return out;
}

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ''): void {
	checks++;
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
	}
}

console.log('\n── arrows use the shared .nav-arrow affordance ────────');

const offenders = walkSvelte(SRC).filter((f) => /rtl:-scale-x-100/.test(readFileSync(f, 'utf-8')));
check(
	'no element still uses the old rtl:-scale-x-100 arrow class',
	offenders.length === 0,
	offenders.map((f) => f.replace(SRC, 'src')).join(', ')
);

const css = readFileSync(join(SRC, 'app.css'), 'utf-8');
check('app.css defines .nav-arrow', /\.nav-arrow\s*\{/.test(css));
check('app.css slides nav-arrow-right on hover', /:hover\s+\.nav-arrow-right/.test(css));
check('app.css slides nav-arrow-left on hover', /:hover\s+\.nav-arrow-left/.test(css));
check('app.css greens the arrow on hover', /:hover\s+\.nav-arrow\b/.test(css) && /--morphit-emerald/.test(css));
check('app.css removes underline on links carrying an arrow', /:has\(\.nav-arrow\)/.test(css));
check("app.css mirrors the arrow under RTL", /\[dir='rtl'\]\s*\.nav-arrow/.test(css));

const priorities = readFileSync(join(SRC, 'lib', 'components', 'PrioritiesSection.svelte'), 'utf-8');
check('homepage cards use nav-arrow', /nav-arrow nav-arrow-right/.test(priorities));
check(
	'homepage cards no longer use the bespoke priorities-card-cta-arrow',
	!priorities.includes('priorities-card-cta-arrow')
);

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} nav-arrow-consistency scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
