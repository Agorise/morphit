# Fonts for the branded social-preview image

`morphit-ops branding apply` draws a branded instance's `og-image.png` (its own logo and site name)
on the server, with `@resvg/resvg-js` (src/lib/ogImage.ts). Its text is set in these fonts, not the
server's own, so every server draws the same image:

| File                    | Font                                        | Covers                                    | Source                                                                                       |
| ----------------------- | ------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Comfortaa-Bold.ttf`    | Comfortaa 700 (v3.105), the site's own font | Latin (incl. Vietnamese), Greek, Cyrillic | `@expo-google-fonts/comfortaa@0.4.2` (the Google Fonts TTF), `700Bold/Comfortaa_700Bold.ttf` |
| `Vazirmatn-NL-Bold.ttf` | Vazirmatn NL 700 (v33.003)                  | Arabic script: Persian, Arabic, Urdu…     | `vazirmatn@33.0.3`, `misc/Non-Latin/fonts/ttf/Vazirmatn-NL-Bold.ttf`                         |

Both are under the SIL Open Font License 1.1 (`OFL-Comfortaa.txt`, `OFL-Vazirmatn.txt`), which
must stay next to them. The site itself serves only the Latin `woff2` subset of Comfortaa
(`apps/web/static/fonts`); resvg reads TrueType/OpenType, not `woff2`, and the image needs the
wider character set, so these TTFs are kept here, outside the served build.

A name with letters neither font has (Chinese, Hebrew, Devanagari, …) is drawn with an installed
font that has them, when the server has one (`MORPHIT_OG_FONT_DIRS`, default `/usr/share/fonts`
and `/usr/local/share/fonts`); otherwise the image shows the logo without the name, never empty
boxes, and `branding apply` says so.

To update: `npm pack` the package versions above, copy the same files, and check the sha256 values:

```
492a6c62d53e4b0c8dbb1f4e53112b73a736537fb6a3a62eec26e0a6dbf92dee  Comfortaa-Bold.ttf
c14881a22c7ea8a4c0ad8477642c1155f141db5e386beed7e0adee46cf0f3e8c  Vazirmatn-NL-Bold.ttf
```
