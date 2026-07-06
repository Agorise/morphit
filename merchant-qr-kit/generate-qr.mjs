#!/usr/bin/env node
/**
 * Morphit merchant QR generator.
 *
 * Produces a crisp SVG QR code that points at your Morphit page (default) or
 * encodes your bare account name for wallet scan-to-pay (--pay). Uses the same
 * `qrcode` library Morphit itself uses.
 *
 * Usage:
 *   node generate-qr.mjs <account> [instance]     Storefront QR (https://instance/@account)
 *   node generate-qr.mjs <account> --pay          Payment QR (bare account name)
 *
 * Examples:
 *   node generate-qr.mjs alice                     -> morphit-qr-alice.svg   (https://morphit.io/@alice)
 *   node generate-qr.mjs alice example.org         -> morphit-qr-alice.svg   (https://example.org/@alice)
 *   node generate-qr.mjs alice --pay               -> morphit-pay-alice.svg  ("alice")
 *
 * Requires Node.js and the `qrcode` package (already installed in a Morphit
 * repo checkout; otherwise run `npm install qrcode` first).
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((a) => a.length > 0);
const pay = args.includes('--pay');
const positional = args.filter((a) => !a.startsWith('--'));

const rawAccount = positional[0];
if (!rawAccount) {
	console.error('Usage: node generate-qr.mjs <account> [instance] [--pay]');
	process.exit(1);
}

// Blurt account names are lowercase and carry no leading '@'.
const account = rawAccount.replace(/^@+/, '').toLowerCase();
const instance = (positional[1] ?? 'morphit.io').replace(/^https?:\/\//, '').replace(/\/+$/, '');

const payload = pay ? account : `https://${instance}/@${account}`;
const outFile = pay ? `morphit-pay-${account}.svg` : `morphit-qr-${account}.svg`;

let QRCode;
try {
	QRCode = (await import('qrcode')).default;
} catch {
	console.error(
		'Could not load the "qrcode" package. Run this from a Morphit repo checkout,\n' +
			'or install it first with:  npm install qrcode'
	);
	process.exit(1);
}

// margin: quiet zone in modules. errorCorrectionLevel 'M' (~15%) tolerates a
// little print smudging / a small logo overlay without failing to scan.
const svg = await QRCode.toString(payload, {
	type: 'svg',
	margin: 2,
	errorCorrectionLevel: 'M'
});

writeFileSync(outFile, svg);
console.log(`Wrote ${outFile}`);
console.log(`Encodes: ${payload}`);
if (!pay) {
	console.log('Tip: this opens in any phone camera. For wallet scan-to-pay, add --pay.');
}
