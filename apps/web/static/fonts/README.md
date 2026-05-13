# Fonts — Nunito (SIL OFL)

This folder ships empty. Drop the Nunito woff2 subsets here before building:

```
nunito-latin-400.woff2
nunito-latin-600.woff2
nunito-latin-700.woff2
nunito-latin-800.woff2
```

## How to get them (legally and safely)

Nunito is licensed under the SIL Open Font License, so we can self-host it
without any attribution requirements beyond the license itself.

Grab the official TTFs from https://fonts.google.com/specimen/Nunito and
convert them to woff2 with [glyphhanger](https://github.com/zachleat/glyphhanger)
subsetted to Latin + Latin-Extended:

```bash
npm install -g glyphhanger
pyftsubset Nunito-Regular.ttf \
  --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215" \
  --flavor=woff2 \
  --output-file=nunito-latin-400.woff2
# Repeat for 600, 700, 800 weights.
```

Target size: ~22 KB per weight, ~90 KB total for Latin coverage.

CJK coverage (for Mandarin / Cantonese) is not yet shipped — Phase 5 will
lazy-load Nunito CJK subsets only when the user switches to those languages.
For now, CJK falls back to the system font stack (`system-ui`) which renders
cleanly on every modern OS.

## Why not a CDN?

Third-party font hosts (Google Fonts et al.) leak the user's IP and browser
fingerprint on every page load. Morphit's whole point is not to do that.
Self-hosting is non-negotiable.
