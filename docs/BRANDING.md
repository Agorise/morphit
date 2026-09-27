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
| Site name | Every place the UI names the **site**: "Sign in to …", "Your … password", page titles, RSS feed titles, and — on the pages Morphit prerenders (homepage, sign-in, FAQ, guides) — link previews and the home-screen label (see [Limits](#limits)) | `MORPHIT_INSTANCE_BRAND_NAME` |
| BETA marker | The small red "BETA" over the logo | `MORPHIT_INSTANCE_BETA_BADGE` (automatic) |

Mentions of the **software** and the **federation** stay "Morphit": "Run a Morphit node", "other
Morphit instances", "Morphit is open source (AGPL)". A Vigilante Trading user sees
"Sign in to Vigilante Trading". Under the footer logo a small "Runs on Morphit" line links to
*About this instance*, which shows your site's name and how many files you re-branded — so a
visitor can always tell that your site is a Morphit instance, and check it.

## Set it up (once)

Copy your three SVG files to the server, then run one command (the paths below are examples — use
wherever you put the files):

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
- Each file is checked first. A file with scripts, event handlers, links, anything loaded from
  another file or the internet, or parts an image has no use for is refused, and nothing changes.
- The files are copied to `/etc/morphit/branding/`, and the name goes into the install's settings
  file, `morphit.config.env` (the previous version is kept as a backup). Upgrades keep both. Run the
  command again any time to change something.

Or let it ask you: `sudo morphit-ops branding setup` (also in the `sudo morphit-ops` menu, under
*Branding*) asks for each file and the name, one question at a time, and applies them.

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

## Undo

```sh
sudo morphit-ops branding reset
```

This serves the plain Morphit look again. To keep it that way across upgrades, also remove the
`MORPHIT_INSTANCE_BRAND_*` / `MORPHIT_INSTANCE_BETA_BADGE` lines from `morphit.config.env` and the
files in `/etc/morphit/branding/`.

## How it works (and why it passes the integrity check)

Your visitors' browsers verify the frontend they are running against the release manifest Morphit
publishes on-chain: `index.html`, the service worker and the app's entry code. A locally rebuilt
frontend is never byte-identical to the release, which is why a custom build shows the red tamper
warning. Branding therefore never rebuilds. `morphit-ops branding apply` edits the canonical build
**in place**, and only touches files outside that manifest:

- `/brand/site-logo.svg`, `/brand/site-logo-footer.svg`, `/favicon.svg`, `/app-icon.svg`,
  `/app-icon-maskable.svg`, the PNG app icons, the launch screens under `/splash/`,
  `/manifest.webmanifest`, and any images you put under `static/` are replaced.
- **Prerendered pages** get your name in exactly the places that name the site. At build time every
  such place is recorded in `build/.brand-slots.json`; software mentions are not in that list and
  are never touched. Because the page itself carries your name, it is right on first paint, for
  visitors without JavaScript, and for search engines and link previews.
- `/brand/brand.json` carries the name for pages the app renders in the browser (chats, profiles,
  orders), which boot from the untouched `index.html`.
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

- Colours, fonts, layout and wording beyond the site name need a fork of the frontend. A fork is
  rebuilt, so it shows the integrity warning, and upgrades reinstall the canonical frontend, so you
  maintain the fork yourself. See [RUN-A-MORPHIT-NODE.md §11](RUN-A-MORPHIT-NODE.md).
- Pages the app draws in the browser (an order, a profile, a chat, an explorer transaction) start
  from the shared `index.html`, which the integrity check covers and branding never edits. Their
  link previews, the text shown to visitors without JavaScript, and the iPhone "Add to Home Screen"
  label taken from one of those pages say "Morphit". Once the page has loaded, everything a visitor
  reads uses your name.
- Link-preview images (`og:image`) and canonical URLs point at `https://morphit.io` in the
  canonical build. Replacing `og-image.png` via `static/` changes the file on your server, not what
  previews fetch.
- In Persian (right-to-left) text, punctuation right after a Latin-script name can display on the
  wrong side of it ("Swap!" as "!Swap"). A name that ends in a letter or digit avoids it.
- A Chinese-script name is set with spaces around it in the Chinese translations, which were
  written for a Latin-script name.
- Downloaded files (keyfiles, key backups, CSV exports) keep `morphit-` in their names: the keys
  work on every Morphit instance, not only yours.
