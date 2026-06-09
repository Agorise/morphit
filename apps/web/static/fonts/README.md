# Fonts — Nunito (SIL OFL)

This folder ships the 4 Nunito woff2 subsets the app uses, plus the SIL Open
Font License they're distributed under:

```
nunito-latin-400.woff2
nunito-latin-600.woff2
nunito-latin-700.woff2
nunito-latin-800.woff2
OFL.txt
```

`apps/web/src/app.css` (the `@font-face` blocks) and the preload in
`app.html` reference these filenames directly, so a normal build/deploy just
works — no manual font step. **OFL note:** because we redistribute the font
binaries, `OFL.txt` is the license they ship under and must stay alongside
them (don't delete it; keep it in any mirror).

## How they were generated (to regenerate or update)

These 4 woff2 were produced from the official Google Fonts release with the
steps below. Follow them to refresh the fonts (e.g. a new Nunito version) or
to widen the character set; the output filenames must stay exactly as listed
above. Nunito is SIL Open Font License, so we self-host it freely (the only
obligation is shipping `OFL.txt`, above — no separate attribution required).

1. Download Nunito from https://fonts.google.com/specimen/Nunito (the
   **"Get font" → "Download all"** button) and unzip it.

2. **Use the TTFs in the `static/` subfolder of that zip — NOT the two
   `*-VariableFont_wght.ttf` files at the top level.** Modern Google Fonts
   leads with a *variable* font (one file with a built-in weight dial) and
   also includes a `static/` subfolder of one-file-per-weight TTFs. Our
   `@font-face` blocks are written for discrete static weights, so the
   `static/` files are the ones we want. (We could switch to the single
   variable file later — it would be one `@font-face` with
   `font-weight: 400 800` — but that's a deliberate change, not the current
   setup.)

3. Convert **exactly these 4** (upright only — we deliberately don't ship
   italic; the few italic spots in the UI render as faux-italic, which keeps
   the footprint small):

   | output filename          | source file in the zip       | weight |
   |--------------------------|------------------------------|--------|
   | `nunito-latin-400.woff2` | `static/Nunito-Regular.ttf`  | 400    |
   | `nunito-latin-600.woff2` | `static/Nunito-SemiBold.ttf` | 600    |
   | `nunito-latin-700.woff2` | `static/Nunito-Bold.ttf`     | 700    |
   | `nunito-latin-800.woff2` | `static/Nunito-ExtraBold.ttf`| 800    |

   `pyftsubset` (from the Python `fonttools` package) does the subset +
   woff2 conversion; the `brotli` package is what enables `--flavor=woff2`:

   ```bash
   pip install fonttools brotli          # one-time; this provides pyftsubset

   # run from the unzipped Nunito folder:
   U="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
   pyftsubset static/Nunito-Regular.ttf   --unicodes="$U" --flavor=woff2 --output-file=nunito-latin-400.woff2
   pyftsubset static/Nunito-SemiBold.ttf  --unicodes="$U" --flavor=woff2 --output-file=nunito-latin-600.woff2
   pyftsubset static/Nunito-Bold.ttf      --unicodes="$U" --flavor=woff2 --output-file=nunito-latin-700.woff2
   pyftsubset static/Nunito-ExtraBold.ttf --unicodes="$U" --flavor=woff2 --output-file=nunito-latin-800.woff2
   ```

   The `--unicodes` list above is the SAME range declared in `app.css`'s
   `unicode-range` (Latin + Latin-Extended plus the punctuation, symbol, and
   combining codepoints the UI uses). If either side ever changes, keep the
   two in sync.

4. Move the 4 resulting `.woff2` files into this folder
   (`apps/web/static/fonts/`), then build.

Target size: ~22 KB per weight, ~90 KB total for Latin coverage.

## CJK (Mandarin / Cantonese)

Not shipped yet — Phase 5 will lazy-load Nunito CJK subsets only when the
user switches to those languages. For now CJK falls back to the system font
stack (`system-ui`), which renders cleanly on every modern OS.

## Why not a CDN?

Third-party font hosts (Google Fonts et al.) leak the user's IP and browser
fingerprint on every page load. Morphit's whole point is not to do that.
Self-hosting is non-negotiable.
