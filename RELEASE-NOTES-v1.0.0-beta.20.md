# Morphit v1.0.0-beta.20

A reliability and polish release, with most of the new work aimed at operators.
The optional Matrix alert bot is now something you set up and verify with two
short commands instead of hand-editing systemd, and several bugs that quietly
stopped it from starting on a fresh deploy are fixed. On the visitor side, the
home page and order book start faster, the "new version available" banner now
appears promptly when you come back to the tab, and a trade chat can offer a
one-tap prompt to turn on reply notifications. A wrong description of the
welcome bonus in the FAQ was corrected in every language.

For operators: there's nothing required beyond deploying this build. If you want
Matrix alerts, `morphit-ops matrix set @you:your.server` turns them on and
`morphit-ops matrix test` sends you a real test alert so you know delivery works
end to end. If you upgrade from beta.19 and had configured the alert bot, this
build is the first one where its service unit actually starts cleanly.

## Improved

- **The home page and order book load faster.** The browser no longer pulls the
  elliptic-curve signing and seed-phrase libraries (and the Blurt client) into
  the very first page load on pages that don't need them. First-paint JavaScript
  on the home page dropped by roughly a fifth. These libraries still load the
  moment you do something that needs them — create an account, sign in, open an
  encrypted chat — and not before.
- **The "a new version is available" banner now appears promptly.** It used to
  rely on a slow background timer, so on mobile it could take several minutes to
  notice a freshly deployed build (and on a desktop tab that was already up to
  date it correctly showed nothing). It now re-checks the instant you bring the
  tab back to the foreground, or when your connection comes back, so the prompt
  shows up within a beat of an update being available.
- **Optional reply notifications inside a trade chat.** When you open a trade
  conversation, Morphit can offer a small, dismissible prompt to turn on chat
  notifications so you're pinged when the other person replies even with the tab
  closed. It rides the same private web-push mechanism the rest of the app uses
  — an opaque browser endpoint, no email, phone number, or other personal detail
  — and "Not now" hides it for good.

## For operators

- **Manage the Matrix alert bot with `morphit-ops matrix`.** The alert bot is
  installed by default but only runs once you give it a valid Matrix username to
  notify. `morphit-ops matrix set @you:your.server` turns it on (and starts it),
  `morphit-ops matrix clear` turns it off (and stops it), and `morphit-ops matrix`
  shows its current status. Upgrades re-check the setting automatically, so the
  bot's running state always matches your configuration.
- **Confirm alerts actually reach you with `morphit-ops matrix test`.** One
  command asks the running bot to send you a clearly-labelled test alert DM, so
  you can verify the whole delivery path — token, direct message, encryption —
  without the old manual log-watching dance. (The first message from the bot
  arrives as a room invite you accept once.)
- **The alert bot's service unit now starts cleanly on a fresh deploy.** Three
  packaging bugs that could stop the unit from starting — a mount path it never
  used, the wrong launcher path, and an over-restrictive `/proc` setting that
  broke its log reader — are fixed.
- **Alerts from the shell-based system monitors now reliably reach the bot.** On
  some hosts, alerts emitted by the host/disk/firewall/etc. monitors were landing
  in the journal without the unit attribution the bot filters on, so the bot
  silently missed them. They now flow through the path that carries reliable
  attribution. (If your indexer and relay are your only alert sources, you were
  unaffected either way.)

## Fixed

- **The FAQ described the welcome bonus incorrectly.** One FAQ answer said new
  traders receive "10 BP delegated"; the welcome bonus is actually 10 Blurt plus
  10 Blurt Power *granted* (powered up and owned, not a revocable delegation),
  and it omitted the liquid Blurt entirely. This was corrected in all ten
  languages, and a related reward-description wording fix was made in the two
  Chinese locales. The fee and reward reference docs were brought into line.

## Under the hood

- **A slimmed production install can no longer break the services at launch.**
  The indexer, relay, Matrix bot, and MCP server all run their TypeScript source
  through `tsx` at runtime, but several of them only declared `tsx` as a *dev*
  dependency — so a production-style install (`npm install --omit=dev`,
  `NODE_ENV=production`) would have stripped it and stopped those services from
  starting. `tsx` is now a regular dependency wherever a service runs it, and a
  new check fails the build if that ever regresses.
- **The `/dev` diagnostic pages are disabled in production builds.** The internal
  diagnostic pages (icon catalogue, responsive-layout preview, and a hardware
  security-key probe) were reachable on a deployed site. They now return "not
  found" in a production build and are available only when running the app
  locally for development.
- **DNS-rebinding hardening on the alert bot's local self-test endpoint**, plus
  a small set of audit-driven accuracy fixes across the documentation.
- **Dependency-licensing transparency.** A `THIRD-PARTY-LICENSES.md` now documents
  that the dependency tree is otherwise fully permissive except for one
  source-available (no-military-use) runtime library, and a new check fails the
  build if any non-free dependency license is introduced.
