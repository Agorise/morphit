/**
 * avatar-upload-robustness-smoke (v1.16.5)
 *
 * The maintainer's rule: every way the avatar upload can fail must surface a concise,
 * actionable message (or be auto-handled) — never a dead-end, never a silent
 * choke. This pins:
 *   1. every AvatarErrorCode the processor can return has an i18n message;
 *   2. the broadcast handler is idempotent (re-entrancy + empty-staged guards),
 *      so an accidental double-click can't fire — or pay for — the op twice;
 *   3. the file-select handler ignores a re-entrant pick while busy;
 *   4. the file input is disabled while processing/broadcasting.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	readRasterDimensions,
	MAX_AVATAR_SOURCE_PIXELS,
	MAX_AVATAR_SOURCE_DIM
} from '../src/lib/avatar/index.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

// ── 1. every processor error code has an actionable i18n message ──
const avatarSrc = read('apps/web/src/lib/avatar/index.ts');
const unionBlock = avatarSrc.slice(avatarSrc.indexOf('type AvatarErrorCode ='));
const unionEnd = unionBlock.indexOf(';');
const codes = new Set(
	[...unionBlock.slice(0, unionEnd).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
);
// handler-level codes not in the processor union but surfaced the same way
codes.add('load_failed');
codes.add('processing_failed');
const en = JSON.parse(read('apps/web/src/lib/i18n/locales/en.json'));
const errs = en.settings.avatar.error as Record<string, string>;
check('processor returns ≥8 distinct error codes', codes.size >= 8, `got ${codes.size}`);
for (const c of codes)
	check(`error code has an actionable message: ${c}`, typeof errs[c] === 'string' && errs[c].length > 10);
// and no code is returned in the source without a message (catch drift the other way)
for (const m of avatarSrc.matchAll(/code:\s*'([a-z_]+)'/g))
	check(`returned code '${m[1]}' is translated`, typeof errs[m[1]] === 'string');

// ── 2–4. handler guards in settings ──
const s = read('apps/web/src/routes/[lang]/settings/+page.svelte');
const bcast = s.slice(s.indexOf('async function broadcastAvatar'), s.indexOf("async function broadcastAvatar") + 900);
check('broadcastAvatar guards re-entry (idempotent double-click)', /if \(avatarBroadcasting\) return;/.test(bcast));
check('broadcastAvatar never broadcasts an empty avatar', /if \(!avatarStagedSvg && !avatarStagedDataUri\) return;/.test(bcast));
check('broadcastAvatar pre-checks offline (no wasted attempt)', /navigator\.onLine === false/.test(bcast));
const sel = s.slice(s.indexOf('async function handleAvatarFileSelected'), s.indexOf('async function handleAvatarFileSelected') + 600);
check('file-select ignores a re-entrant pick while busy', /if \(avatarProcessing \|\| avatarBroadcasting\)/.test(sel));
check('file input is disabled while processing/broadcasting', /type="file"[\s\S]{0,200}disabled=\{avatarProcessing \|\| avatarBroadcasting\}/.test(s));
check('filename is displayed truncated (no overflow from long names)', /avatarFileName[\s\S]{0,120}truncate/.test(s) || /truncate[\s\S]{0,120}avatarFileName/.test(s));

// ── pixel-bomb guard: header dimension parser + cap ──
const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w: number, h: number): Uint8Array =>
	Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h)]);
const gif = (w: number, h: number): Uint8Array =>
	Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8]);
const jpeg = (w: number, h: number): Uint8Array =>
	Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 0]);
const webpx = (w: number, h: number): Uint8Array => {
	const w1 = w - 1;
	const h1 = h - 1;
	return Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 0, 0, 0, 0, 0, 0, 0, 0, w1 & 255, (w1 >> 8) & 255, (w1 >> 16) & 255, h1 & 255, (h1 >> 8) & 255, (h1 >> 16) & 255]);
};
check('PNG dimensions parsed', JSON.stringify(readRasterDimensions(png(640, 480))) === JSON.stringify({ width: 640, height: 480 }));
check('GIF dimensions parsed', JSON.stringify(readRasterDimensions(gif(200, 100))) === JSON.stringify({ width: 200, height: 100 }));
check('JPEG dimensions parsed (SOF scan past APP0)', JSON.stringify(readRasterDimensions(jpeg(1024, 768))) === JSON.stringify({ width: 1024, height: 768 }));
check('WebP VP8X dimensions parsed', JSON.stringify(readRasterDimensions(webpx(300, 250))) === JSON.stringify({ width: 300, height: 250 }));
check('garbage header → null (falls through to decode)', readRasterDimensions(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])) === null);
// the pixel-bomb: a small PNG that decodes to 30000×30000 is caught by the cap
const bomb = readRasterDimensions(png(30000, 30000))!;
check('pixel-bomb exceeds the megapixel cap', bomb.width * bomb.height > MAX_AVATAR_SOURCE_PIXELS);
check('over-dimension caught by per-side cap', readRasterDimensions(png(20000, 10))!.width > MAX_AVATAR_SOURCE_DIM);
check('reencodeRaster guards dimensions before decode', /readRasterDimensions\(head\)[\s\S]{0,200}image_dimensions_too_large/.test(read('apps/web/src/lib/avatar/index.ts')));

console.log(fail === 0 ? `✓ all ${pass} avatar-upload-robustness checks hold` : `✗ ${fail} failed (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
