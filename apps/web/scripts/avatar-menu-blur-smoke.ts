#!/usr/bin/env tsx
/**
 * Smoke: the avatar menu blurs/dims the rest of the page while open, drawing
 * the eye to the menu (same treatment as the FAQ search). Anchor 2026-07-08.
 *
 * Guards: a full-page scrim (fixed inset-0 + backdrop-blur) rendered inside the
 * `{#if open}` block, BELOW the menu (z-40 < z-50), that closes on click.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const menu = readFileSync(
	join(__dirname, '..', 'src', 'lib', 'components', 'AvatarMenu.svelte'),
	'utf8'
);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

check(
	'a full-page backdrop-blur scrim exists (fixed inset-0 + backdrop-blur)',
	/fixed inset-0[^"]*backdrop-blur/.test(menu)
);
check('the scrim sits below the menu (z-40 < the menu z-50)', /z-40[^"]*backdrop-blur|backdrop-blur[^"]*z-40/.test(menu) && /z-50/.test(menu));

// The scrim must be inside the {#if open} block (only while the menu is open).
const openBlock = /\{#if open\}[\s\S]*?\{\/if\}/.exec(menu)?.[0] ?? menu;
check('the scrim is rendered only while the menu is open', /backdrop-blur/.test(openBlock));
check('clicking the scrim closes the menu (open = false)', /backdrop-blur[\s\S]{0,400}/.test(openBlock) && /open = false/.test(openBlock));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} avatar-menu-blur scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} avatar-menu-blur checks FAILED`);
	process.exit(1);
}
