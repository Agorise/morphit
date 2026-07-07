# Fonts — Comfortaa (SIL OFL)

This folder ships the 4 Comfortaa woff2 subsets the app uses, plus the SIL Open
Font License they're distributed under:

```
comfortaa-latin-400.woff2
comfortaa-latin-600.woff2
comfortaa-latin-700.woff2
comfortaa-latin-800.woff2
OFL.txt
```

`apps/web/src/app.css` (the `@font-face` blocks) and the preload in `app.html`
reference these filenames directly, so a normal build/deploy just works — no
manual font step. **OFL note:** because we redistribute the font binaries,
`OFL.txt` is the license they ship under and must stay alongside them (don't
delete it; keep it in any mirror).

**Weight note:** Comfortaa's design axis tops out at **700** (unlike Nunito,
which went to 900). The app's heaviest tier is `font-extrabold` (800), so
`comfortaa-latin-800.woff2` is Comfortaa **700** (its heaviest) — the `800`
`@font-face` block points at it so extrabold text renders as the boldest
Comfortaa rather than a synthesized faux-bold. `400`/`600`/`700` are the real
Comfortaa weights of the same name.

## How they were generated (to regenerate or update)

The 4 woff2 were taken from the **Fontsource** distribution (the same SIL-OFL
Comfortaa Google publishes, pre-subset to `latin`), which is the simplest
reproducible source — no local subsetting toolchain required:

```
# from a scratch dir (npmjs is the only network dependency):
npm pack @fontsource/comfortaa
tar -xzf fontsource-comfortaa-*.tgz
cp package/files/comfortaa-latin-400-normal.woff2 comfortaa-latin-400.woff2
cp package/files/comfortaa-latin-600-normal.woff2 comfortaa-latin-600.woff2
cp package/files/comfortaa-latin-700-normal.woff2 comfortaa-latin-700.woff2
cp package/files/comfortaa-latin-700-normal.woff2 comfortaa-latin-800.woff2   # 800 slot = Comfortaa 700 (heaviest)
cp package/LICENSE OFL.txt
```

The output filenames must stay exactly as listed at the top (the `@font-face`
blocks + the `app.html` preload reference them literally). Fontsource ships the
SIL-OFL Comfortaa binaries + the license verbatim, so `OFL.txt` above is the
license they travel under — no separate attribution required beyond keeping it.

**Alternative (widen the character set):** download Comfortaa from
https://fonts.google.com/specimen/Comfortaa (the **"Get font" → "Download all"**
button), then `pyftsubset` each static-weight TTF (from the zip's `static/`
subfolder — NOT the top-level `*-VariableFont_wght.ttf`) with your desired
`--unicodes` range and `--flavor=woff2`. Comfortaa is a variable font
(`wght 300 700`); a future switch to the single variable file would be one
`@font-face` with `font-weight: 400 700` — a deliberate change, not the current
discrete-weight setup.
