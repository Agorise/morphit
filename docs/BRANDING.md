# Branding your instance

Every Morphit instance runs the same open-source software, but it is **your site**: your logo, your
icons, your name. This guide shows how to brand an instance so that:

- it takes your logo files and one command, **once**. Every `morphit-ops upgrade` re-applies it.
- there is **no custom build**. The files the integrity check looks at stay byte-for-byte the signed
  release, so visitors' browsers never show the build-integrity (tamper) warning.
- the Morphit software is still credited where the text is about the software.

## What you can brand

| What | Where it shows | You provide |
|---|---|---|
| Logo | Header (top-left) and homepage hero, with the occasional sheen | `logo.svg` |
| Footer logo | Footer (with the sheen) | `logo-footer.svg` (optional; defaults to `logo.svg`) |
| Icon | Browser-tab favicon, "add to home screen" app icons | `icon.svg` |
| Launch screens | The iPhone/iPad screen shown while the app opens | made from `logo.svg` |
| Link preview | The picture shown when a link to your site is shared (`/og-image.png`, 1200 × 630) | drawn from `icon.svg` (or `logo.svg`) and the site name |
| Site name | Every place the UI names the **site**: "Sign in to …", "Your … password", page titles, RSS feed titles, and — on the pages Morphit prerenders (homepage, sign-in, FAQ, guides) — link previews and the home-screen label (see [Limits](#limits)) | `MORPHIT_INSTANCE_BRAND_NAME` |
| BETA marker | The small red "BETA" over the logo | `MORPHIT_INSTANCE_BETA_BADGE` (automatic) |
| Colours | The whole colour scheme: the hero heading gradient, accents, links, buttons, focus rings, chat bubbles, the homepage cards, the page background and its corner glows, the grey text/surface scale, the browser's theme colour and the Android app colours | two or three colours: `--theme-from`, `--theme-to` (optional `--theme-mid`, `--theme-background`), or a preset `--theme champagne-gold` |

Mentions of the **software** and the **federation** stay "Morphit": "Run a Morphit node", "other
Morphit instances", "Morphit is open source (AGPL)". A Vigilante Trading user sees
"Sign in to Vigilante Trading". Under the footer logo a small "Runs on Morphit" line links to
*About this instance*, which shows your site's name and how many files you re-branded — so a
visitor can always tell that your site is a Morphit instance, and check it.

## Set it up (once)

Copy your three SVG files to the server — from your own computer:

```sh
scp -O my-logo.svg my-wordmark.svg my-symbol.svg you@your-server:/home/you/
```

(capital `-O`: hardened Morphit servers turn off SFTP, which plain `scp` uses, and a plain `scp`
fails with "Connection closed"). Then run one command **on the server** (the paths below are
examples — use wherever you put the files):

```sh
sudo morphit-ops branding apply \
  --logo /home/you/my-logo.svg \
  --logo-footer /home/you/my-wordmark.svg \
  --icon /home/you/my-symbol.svg \
  --name "Vigilante Trading"
```

- `--logo` is the header (top-left) and homepage logo, `--logo-footer` the footer logo (optional;
  the footer uses `--logo` without it), `--icon` the favicon and app-icon symbol.
- Full paths always work. A plain file name (`--logo my-logo.svg`) is looked up in the folder you
  ran the command from, and `~/my-logo.svg` in your home folder.
- `--name` is the site's name. Leave it out to keep "Morphit"; `--name Morphit` or `--name=` removes
  it. `--short-name "Vigilante"` sets a shorter label for Android's home screen (iPhones use the
  full name). `--beta on|off|auto` controls the red BETA marker (automatic: off once you supply a
  logo).
- Colours: `--theme-from '#…' --theme-to '#…'` or a preset such as `--theme champagne-gold` — see
  [Colours](#colours).
- Each file is checked first. A file with scripts, event handlers, links, anything loaded from
  another file or the internet, or parts an image has no use for is refused, and nothing changes.
- The files are copied to `/etc/morphit/branding/`, and the name goes into the install's settings
  file, `morphit.config.env` (the previous version is kept as a backup). Upgrades keep both. Run the
  command again any time to change something.

Or let it ask you: `sudo morphit-ops branding setup` (also in the `sudo morphit-ops` menu, under
*Branding*) asks for each file, the name and the colours, one question at a time, and applies them.

The home-screen icons and launch screens are drawn from your SVGs by a small image converter,
`librsvg2-bin`. If the server does not have it, `branding apply` offers to install it; you can
also install it yourself with `sudo apt install librsvg2-bin` and run `branding apply` again.
(ImageMagick works too.) A server that reaches the internet only through Tor, I2P or Lokinet is
not offered the install, because `apt` would fetch it over the open internet — install it the way
you install other packages on that server. The offline bundle already carries it.

RSS feed titles use the new name after the indexer restarts:

```sh
sudo systemctl restart morphit-indexer
```

Visitors see the change on their next page load; on the pages the app draws in the browser
(orders, profiles, chats), returning visitors may need one more visit. `sudo morphit-ops branding
status` shows what is configured and whether the frontend build matches it (it checks the build
folder the site is published from). After that you're done: upgrades keep it.

**Prefer to do it by hand?** Put the files in `/etc/morphit/branding/` (create it with
`sudo mkdir -p /etc/morphit/branding`) as `logo.svg`, `logo-footer.svg` and `icon.svg`, and set the
name in `morphit.config.env` (or with `sudo morphit-ops` → *Edit settings* → *Branding & SEO* →
*Site brand name*). Keep the quotes — the file is also read by the services' shell, and an unquoted
name with a space breaks there:

```sh
MORPHIT_INSTANCE_BRAND_NAME='Vigilante Trading'
#MORPHIT_INSTANCE_BRAND_SHORT_NAME='Vigilante'
#MORPHIT_INSTANCE_BETA_BADGE=off
```

and run `sudo morphit-ops branding apply`.

## Your files

**SVG, please.** Logos and the icon must be SVG so they stay sharp at every size. Morphit checks
each file against a list of the parts a plain drawing uses (shapes, paths, text, gradients,
patterns, masks, filters, styles) and refuses anything else: scripts, event handlers, links,
embedded web pages, animation, and references to other files or the internet. Editor leftovers
(Inkscape, Illustrator and similar metadata) are removed; the drawing itself is never changed. The
web server also serves these files with a policy that stops anything in them from running if
someone opens one directly.

- **Sizing is automatic and never distorts.** Each logo is shown at the same **height** as the
  Morphit logo it replaces (header 32 px, footer 40 px, homepage hero 44–96 px), and its width
  follows its own proportions. A wide logo is wide, a compact one compact. It is never stretched or
  squashed; a very wide logo is scaled down to fit a phone screen.
- **Include a `viewBox`**, or at least a pixel `width` and `height`. If only the size is given,
  Morphit adds the matching `viewBox` itself so the logo scales in every browser.
- **The sheen** (the glint that sweeps across the logo every ~15 s) follows your logo's own shape
  automatically. It is off for visitors who ask their device for reduced motion.
- **The icon** should be a simple, roughly square symbol that reads at 16 px. Morphit places it on
  the dark app background for the home-screen icons (64% of the canvas, 49% for Android's
  "maskable" icon so it survives circular masks).
- **PNG app icons** (`app-icon-192.png`, `app-icon-512.png`, `app-icon-maskable-512.png`,
  `apple-touch-icon.png`, which is 180 × 180) are generated from `icon.svg`, and the **iPhone/iPad
  launch screens** from `logo.svg` (centred on the dark background, in the same box the Morphit
  logo uses). Both need `rsvg-convert` (`librsvg2-bin`) or ImageMagick on the server. To use your
  own images instead, put PNGs of those exact names and sizes in `/etc/morphit/branding/`, and
  launch screens under `/etc/morphit/branding/static/splash/`. Your own files always win.

- **The link preview** (`/og-image.png`, the picture chat apps and social sites show for a link to
  your site) is drawn on the server, in the layout of Morphit's own: your `icon.svg` with your site
  name beside it, the tagline, and your web address in a pill. Without `icon.svg` it uses
  `app-icon-512.png` or `logo.svg`; a wide `logo.svg` (a wordmark) is shown on its own. The name is
  set in Comfortaa, the site's font, which `morphit-ops` carries with it (Persian and Arabic names
  in Vazirmatn), so it looks the same on every server; it is made smaller, or split over two lines,
  to fit. A name in a script neither font has (Chinese, Hebrew, …) uses a font installed on the
  server (`sudo apt install fonts-noto-cjk` for Chinese, Japanese and Korean); without one the
  picture shows your logo alone and `branding apply` says so. The web address appears only when
  your instance's clearnet address is set (`MORPHIT_INSTANCE_ORIGIN`); a Tor/I2P-only instance gets
  none. An instance with only its own colours keeps Morphit's picture. Your own 1200 × 630
  `static/og-image.png` replaces it (see below).

- **The pictures in Blurt posts.** When a user posts an order to their Blurt blog, or announces
  their first trade to the Morphit community, the post leads with your link-preview picture
  (`/og-image.png`, drawn as above or your `static/og-image.png`), never Morphit's: if your
  picture could not be drawn, the posts carry none. `branding apply` (and every upgrade) records
  which it is in `/brand/brand.json` (`"og_image": "own"` or `"shipped"`). Blurt can only show a
  picture from an `https://` address, so a post made over Tor or I2P carries none. An unbranded
  instance keeps Morphit's pictures.

**Other images** can be replaced by putting them under `/etc/morphit/branding/static/` at the same
path they have on the site. For example, `static/splash/splash-iphone-12.png` replaces the iOS
launch image at `/splash/splash-iphone-12.png`. Only images are accepted (`.png`, `.jpg`, `.webp`,
`.gif`, `.ico`, `.svg`; SVGs get the same check as your logo). Pages, scripts, fonts, the app
code, the files the integrity check covers, `verify.json`, and the warrant canary (`canary.txt`,
`pgp_keys.asc`) can't be overridden, and are skipped with a warning. Browsers that already cached
one of these other images keep their copy until the next Morphit release.

## The site name: rules

- Up to 48 visible characters.
- Not allowed: `{ } # | < > " \ * [ ]`, backtick, `__`, and invisible or direction-changing
  characters. They would be read as markup, message syntax or formatting, or could disguise the
  name. (The joiners Persian needs are fine.)
- A name that passes for the Morphit project itself — a look-alike of the bare name ("M0rphit",
  "Мorphit" with a Cyrillic М), "Agorise", or one of the project's account names ("morphit-fees") —
  is refused, by the same rule as directory names. A name that builds on it ("Morphit Latino") is
  fine. "Morphit" itself just means "not branded".
- An ASCII apostrophe is shown as a typographic one (`Alice’s Market`).
- In languages that inflect names (Polish, German), your name is inserted uninflected. The
  translations were written so this reads naturally, for example
  "Otwórz Vigilante Trading na telefonie" and "Der Schutz von Vigilante Trading ist mehrschichtig".
  German compounds are joined with hyphens ("Vigilante-Trading-Konto").
- A name that starts with an article ("The …", "El …", "Le …", "Der …") can read awkwardly after
  prepositions in some languages ("de El …"); a name without one reads well everywhere.
- `MORPHIT_INSTANCE_NAME` is a different setting: it is the name on your **directory card** that
  other instances show (set it with `sudo morphit-ops` → *Edit settings*). The site brand is what
  your own pages call themselves. Keep them the same unless you have a reason not to, so people who
  find you in the directory recognise the site they land on.

## Colours

Give the first and last colour of your gradient — Morphit derives every other colour from them:

    sudo morphit-ops branding apply --theme-from '#f3dca0' --theme-to '#bb872f'

(on the server; keep the quotes — the shell reads an unquoted `#` as a comment). Optional:

- `--theme-mid '#d6b26a'` — the gradient's middle colour (otherwise halfway between the two);
- `--theme-background '#181818'` — the page background. It must be dark (Morphit is a dark
  site); the grey text and card colours are re-tinted from it, so a neutral near-black gives
  neutral greys and Morphit's navy gives the navy greys;
- `--theme-button bright` or `deep` — the main buttons. *bright*: your middle colour with dark text
  (the dark text is guaranteed at least 4.5:1); *deep*: your last colour deepened, with white or dark
  text — Morphit's own style. `champagne-gold` uses bright, Morphit uses deep. Saved as
  `MORPHIT_INSTANCE_THEME_BUTTON`; `--theme-button=` goes back to the theme's own.

Or a ready-made theme: `--theme champagne-gold` (Vigilante Trading: champagne `#f3dca0` to gold
`#bb872f` on near-black `#181818`, gold buttons with dark text), `--theme morphit` (the Morphit
colours — also how you go back). A `--theme` replaces the whole colour theme; `--theme-…` colours
given with it override its values. `sudo morphit-ops branding setup` asks for them too, and
`sudo morphit-ops branding status` shows the colours in use.

What is derived, and how it stays readable:

- the button colour (with `deep`: the last colour deepened, the way Morphit's button is a deepened
  teal) with white or dark text — whichever reads better (at least 4.5:1, WCAG AA);
- the accent colour for links, highlighted text and borders, lifted if needed until it reads on
  every background it sits on (at least 4.5:1);
- the chat bubble, the keyboard focus ring, the homepage card icons (3:1), the card hover, the two
  soft glows in the page corners, and the grey text/surface scale.

Colours that can't be made readable are refused before anything is saved, with a suggestion:
"--theme-background #777777 is too light for readable text (body text on the page: 4.21:1, needs 7:1)
— try a darker background such as #373737". Colours that carry a meaning stay the same on every
instance: red for errors, green for "paid" and other success notices, amber warnings, and each
coin's own colour.

The colours are saved in `morphit.config.env` (`MORPHIT_INSTANCE_THEME`,
`MORPHIT_INSTANCE_THEME_FROM`, `_MID`, `_TO`, `_BACKGROUND`, `_BUTTON`) and re-applied on every
upgrade, like the rest of your branding.

### Colours in the frontend (for developers)

All brand and surface colours live in `apps/web/src/theme.css` as `--<token>-rgb: R G B`
custom properties; `tailwind.config.js` maps `morphit-*` / `ink-*` to them
(`rgb(var(--x-rgb) / <alpha-value>)`, so opacity modifiers keep working). Never write a colour
literal in a component: `scripts/theme-literal-scan-smoke.ts` fails on one (non-brand colours —
error red, coin colours, print styles — go on its ALLOW list with a reason). The token table and
the derivation are `packages/operator-config/src/theme.ts`; `scripts/theme-tokens-smoke.ts` keeps
theme.css equal to it. The pixel-level proof that an unthemed build is unchanged:
`apps/web/scripts/theme-pixel-check.mjs` (header explains how to run it).

`build/.brand-slots.json` keeps `files` in the v1.19 shape (site-name slots only): `morphit-ops
upgrade` runs the PREVIOUS release's CLI branding on the new build first, and a v1.19 CLI treats
every `files` entry as a name slot. The colour-theme slots are under `theme_files`, read only by
v1.20+.

## Undo

```sh
sudo morphit-ops branding reset
```

This serves the plain Morphit look again. To keep it that way across upgrades, also remove the
`MORPHIT_INSTANCE_BRAND_*` / `MORPHIT_INSTANCE_BETA_BADGE` / `MORPHIT_INSTANCE_THEME*` lines from
`morphit.config.env` and the files in `/etc/morphit/branding/`. Just the colours:
`sudo morphit-ops branding apply --theme morphit`.

## How it works (and why it passes the integrity check)

Your visitors' browsers verify the frontend they are running against the release manifest Morphit
publishes on-chain: `index.html`, the service worker and the app's entry code. A locally rebuilt
frontend is never byte-identical to the release, which is why a custom build shows the red tamper
warning. Branding therefore never rebuilds. `morphit-ops branding apply` edits the canonical build
**in place**, and only touches files outside that manifest:

- `/brand/site-logo.svg`, `/brand/site-logo-footer.svg`, `/favicon.svg`, `/app-icon.svg`,
  `/app-icon-maskable.svg`, the PNG app icons, the launch screens under `/splash/`, the link-preview
  picture `/og-image.png`, `/manifest.webmanifest`, and any images you put under `static/` are
  replaced.
- **Prerendered pages** get your name in exactly the places that name the site. At build time every
  such place is recorded in `build/.brand-slots.json`; software mentions are not in that list and
  are never touched. Because the page itself carries your name, it is right on first paint, for
  visitors without JavaScript, and for search engines and link previews.
- `/brand/brand.json` carries the name for pages the app renders in the browser (chats, profiles,
  orders), which boot from the untouched `index.html`.
- **Colours**: every colour the app's (signed, untouched) stylesheet paints is a CSS custom
  property with Morphit's value. Each prerendered page gets a small `<style id="morphit-theme">`
  just before `</head>` that sets your values (and its `theme-color` meta), so the colours are right
  on first paint, without JavaScript, and in Tor Browser. `/brand/brand.json` carries the same
  values for the pages the app draws in the browser. `/manifest.webmanifest` gets your theme and
  background colours (it is not on the on-chain manifest). The colour slots are recorded in
  `build/.brand-slots.json` under `theme_files` (see "Colours in the frontend").
- The pre-compressed `.gz`/`.br` copies are regenerated, so your web server never serves a stale
  Morphit version.
- `verify.json` (the full-file manifest anyone can inspect) is updated to describe exactly what you
  serve, and it gains an `operator_branding` block listing every file you re-branded. *About this
  instance* shows it. Nothing is hidden.

The originals are kept in `apps/web/.brand-pristine`, so `apply` is repeatable and `reset` is exact.
`apply` saves every original before it changes anything, so an interrupted run (Ctrl-C, a full
disk) is finished or undone correctly by the next `apply` or `reset`. The service worker refreshes
the logo, icons and `brand.json` in the background, and the web server tells browsers to re-check
them, so a changed brand reaches returning visitors on their next visit.

A green integrity check means the site runs the signed Morphit code. It does not say who runs the
site: for that, visitors look at the address bar and *About this instance*.

## Limits

- Fonts, layout and wording beyond the site name need a fork of the frontend. A fork is
  rebuilt, so it shows the integrity warning, and upgrades reinstall the canonical frontend, so you
  maintain the fork yourself. See [RUN-A-MORPHIT-NODE.md §11](RUN-A-MORPHIT-NODE.md).
- On the pages the app draws in the browser (an order, a chat, a profile), the first instant
  before `/brand/brand.json` arrives shows the Morphit page background; the page itself only
  renders once the colours are known (or after 3 seconds on a very slow connection). Prerendered
  pages are right from the first paint.
- The app icons and iPhone launch screens made from your `icon.svg` / `logo.svg` sit on your
  theme's background; without your own icon they keep Morphit's (navy) icons.
- The hero heading's gradient runs left to right, as Morphit's does.
- Pages the app draws in the browser (an order, a profile, a chat, an explorer transaction) start
  from the shared `index.html`, which the integrity check covers and branding never edits. Their
  link previews, the text shown to visitors without JavaScript, and the iPhone "Add to Home Screen"
  label taken from one of those pages say "Morphit". Once the page has loaded, everything a visitor
  reads uses your name.
- The link-preview picture's tagline ("Anonymously trade crypto, fiat, goods and services") is in
  English, as on Morphit's own.
- In Persian (right-to-left) text, punctuation right after a Latin-script name can display on the
  wrong side of it ("Swap!" as "!Swap"). A name that ends in a letter or digit avoids it.
- A Chinese-script name is set with spaces around it in the Chinese translations, which were
  written for a Latin-script name.
- Downloaded files (keyfiles, key backups, CSV exports) keep `morphit-` in their names: the keys
  work on every Morphit instance, not only yours.
