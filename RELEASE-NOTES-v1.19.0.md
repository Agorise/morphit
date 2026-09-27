# Morphit v1.19.0

Instances can now carry their own name and logo. An operator runs one command
and their site says "Sign in to Vigilante Trading" instead of "Sign in to
Morphit", shows their logo in the header, homepage and footer, and uses their
icon for the browser tab and the phone home screen. Nothing is rebuilt, so
visitors' build-integrity check stays green, and every upgrade keeps it. No
protocol or consensus change.

## Added

- **Your instance, your name and logo.** Every Morphit instance runs the same
  signed frontend, and until now every one of them looked like morphit.io. An
  operator can now brand theirs (use the full path to wherever you copied the
  files):

  ```sh
  sudo morphit-ops branding apply \
    --logo /home/you/my-logo.svg --logo-footer /home/you/my-wordmark.svg \
    --icon /home/you/my-symbol.svg --name "Vigilante Trading"
  ```

  - **The logo** replaces the Morphit logo in the header, on the homepage and
    in the footer. It is shown at the same height as the Morphit logo and is
    never stretched or squashed. The occasional sheen still sweeps across it,
    following the new logo's own shape. The red BETA marker goes away once you
    supply a logo (you can turn it back on).
  - **The icon** becomes the browser-tab icon and the "add to home screen"
    icon. The iPhone and iPad launch screens show the new logo.
  - **The name** replaces "Morphit" wherever the site names itself: "Sign in
    to …", page titles, RSS feed titles, and on the pages Morphit prerenders
    (homepage, sign-in, FAQ, guides) also link previews and the home-screen
    label, on first paint and for visitors without JavaScript. It works in all
    10 languages. Where the text is about the software or the federation ("Run
    a Morphit node", "other Morphit instances"), it still says Morphit, and a
    small "Runs on Morphit" line under the footer logo links to *About this
    instance*, which shows the site's name and how many files the operator
    re-branded.

  `sudo morphit-ops branding setup` (or *Branding* in the `sudo morphit-ops`
  menu) asks for each file and the name instead. The logo files are kept in
  `/etc/morphit/branding/` and the name in `morphit.config.env`, and every
  upgrade re-applies them. `morphit-ops branding status` shows what is set, and
  `morphit-ops branding reset` brings back the plain Morphit look. The full
  guide is `docs/BRANDING.md`.

- **Logo files are checked before they are served.** Each SVG is compared with
  a list of the parts a plain drawing uses; anything else — scripts, event
  handlers, links, embedded web pages, animation, references to other files or
  the internet — is refused and nothing changes. The web server also serves
  these files under a policy that stops anything in them from running if
  someone opens one directly. A site name that passes for the Morphit project
  itself (a look-alike of "Morphit", or one of the project's account names) is
  refused, like it is for directory names.

- **Branding keeps the build-integrity check green.** Branding never rebuilds
  the frontend. It edits the served files in place and never touches the ones
  the on-chain release record covers (the start page, the service worker and
  the app code), so visitors never see the tamper warning because of it. The
  published `verify.json` lists every file the operator re-branded. If
  `branding apply` is interrupted (Ctrl-C, a full disk), the next `apply` or
  `reset` finishes or undoes it correctly.

## Fixed

- **npm's "New major version of npm available!" notice is gone for good.** It
  kept appearing at the very end of installs and upgrades, telling operators to
  run `npm install -g npm@…` — advice that can break an install, which pins its
  own Node and npm. The earlier fixes switched it off inside `morphit-ops`, but
  the notice comes from the npm process that *starts* `morphit-ops` (on a
  guided install the `morphit-ops` shortcut runs through npm, and so does
  `npx morphit-ops`), and it prints when that process exits, where no setting
  inside `morphit-ops` can reach it. Now:
  - the install carries its own npm setting (`.npmrc`) that turns the notice
    off for every npm run inside it;
  - the `morphit-ops` shortcut and the MCP deploy turn it off themselves;
  - every install and upgrade also turns it off for the whole server.

  Because the notice comes from the version that starts the upgrade, the
  upgrade *to* this release can still show it one last time; after that it
  cannot appear.

- **The server-wide npm setting file is no longer writable by every account.**
  Saving a setting with `npm config set --location=global` leaves npm's global
  settings file world-writable, and servers set up with the guided installer
  had such a file. Any account on the server could then have added a setting
  that runs its own code the next time root used npm. Installs and upgrades
  now write that file themselves and keep it owned by root and not writable by
  others, and repair an existing one.

- **A failed late upgrade no longer leaves a container frontend serving
  nothing.** If an upgrade rolled back after the frontend container had been
  switched to the new files, the container kept pointing at the removed folder
  and every page failed. The rollback now re-attaches it to the restored
  install.

- **`morphit-ops payment-method add` accepts its documented form.** `--name
  "…" --description "…" --category …` used to save the word "true" in
  place of each value unless it was written as `--name="…"`. Both forms now
  work, a value may start with a dash ("-5% off"), and `block --reason "…"`
  and the other commands' value flags behave the same way.

- **Two-factor setup labels your account correctly** in authenticator apps
  when the site's name contains spaces or a colon.

- **Upgrade hints** now say `sudo morphit-ops …` instead of `npx morphit-ops …`,
  which could look the tool up on the public npm registry when run outside the
  install.

## Changed

- **The homepage lists ENS instead of Nostr** among the ways to reach
  Morphit: "Reachable on clearnet, Tor, Lokinet, I2P, ENS and Federated
  instance runners." (all 10 languages).

## Upgrading

`sudo morphit-ops upgrade`. Nothing else is needed; an instance that does not
set any branding looks exactly as before.

To keep even this one upgrade free of the npm notice, run this once first (it
also makes npm's global settings file root-only):

```sh
cd ~ && sudo npm config set update-notifier=false --location=global && sudo chmod 644 "$(npm config get globalconfig)"
```

To brand an instance after upgrading, copy the logo files to the server and
run the `branding apply` command above. The phone icons and launch screens are
drawn from your SVG files by a small image converter (`librsvg2-bin`); if the
server does not have it, the command offers to install it.
