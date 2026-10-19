# Morphit v1.21.11

**The download page is about Morphit, on every site.** On a branded site it said "Get Vigilante
Trading" and invited visitors to "install a Vigilante Trading instance … or run your own node", as if
the site were the software. Its heading, browser-tab title and the title of a shared link now read
"Download Morphit", with no site name, and the introduction says the site runs on open source software called
Morphit, which anyone can use to run their own site and be listed in the Federation directory. Also:
in a chat about a goods or services (barter) listing, "Pay now" now shows to the person who pays and
"Share crypto address" to the one who is paid — it was the other way round — and the mailing-address
and shipment buttons appear. And on a BunkerWeb site with a domain of its own, `www.<domain>` now
works and is secure: it goes to `https://<domain>` instead of BunkerWeb's "403 Forbidden" page.

**Upgrading:** `sudo morphit-ops upgrade` on every server. No database change. On a BunkerWeb site
whose address is a domain of its own (vigilante.trading, morphit.io — not a subdomain such as
morphit.timeapp.foundation) and whose `www` record points at the server, the upgrade adds `www` to
BunkerWeb's settings and to the Let's Encrypt certificate (see below; BunkerWeb's services restart for
the settings, then again for the certificate). Check
the record first, on any computer: `getent ahosts www.<domain>` should list the same addresses as
`getent ahosts <domain>`; if not, add a CNAME record `www` → `<domain>` at your DNS provider.
**Every instance must run v1.21.1 or later before 2026-11-01 00:00 UTC.**

## Download page

- **Title:** "Download Morphit" (it was "Get *your site*"), the same on every site — the heading, the
  browser tab and the title of a shared link, in all 10 languages. No site name follows it: a branded
  site added none already, and an unbranded site no longer adds its name ("— *your site*") on this
  page; every other page keeps its title as before.
- **Description** (search results and shared links): it said "Install *your site* as an app", which
  the page no longer covers. It now says Morphit is the free, open source software the site runs on,
  which anyone can use to run their own site, and that its code is mirrored and verifiable.
- **Introduction:** "This website runs on open source software called Morphit. It enables anyone to
  run their own Morphit-powered website like this one and get auto-listed in the Federation directory
  so you can start earning from it." — "run their own" opens the run-a-node page, "the Federation
  directory" the instances page.
- **Source code:** the canonical repository "lives on the Agorise server" (it said "our own Forgejo
  server").

## Chat about a barter listing

- **The right button for the right person.** A barter listing says what happens to the goods ("I'm
  selling bananas for XMR"), so its crypto runs the other way: the goods buyer pays, the goods seller
  is paid. The chat read the listing as a crypto order and offered the goods seller "Pay now" and the
  goods buyer "Share crypto address". It now turns the direction round for barter listings only — the
  rule the orderbook already used — on whichever side of the chat you are.
- **Mailing address and shipment.** "Share mailing address" (for the one who pays) and "Record
  shipment" (for the one who is paid and sends the goods) appear in a barter chat. They showed only
  when a listing named a payment method that is posted (metals, cash by mail, barter goods), and a
  barter listing names only the coins it accepts, so they never appeared there.
- Contributed by another developer, with tests; crypto orders behave exactly as before.

## www.(your domain) on BunkerWeb sites

- **What happened.** `http://www.vigilante.trading` showed BunkerWeb's "403 Forbidden" page. The
  `www` record pointed at the server, but BunkerWeb serves only the names in its `SERVER_NAME`
  setting, which held the domain alone, and turns every other name away. The certificate named the
  domain alone too, so `https://www…` could not be secure either.
- **Now.** BunkerWeb answers for `www.<domain>` and sends every request for it, on http and https, to
  `https://<domain>` with the same page (one redirect), and the Let's Encrypt certificate names both.
  Renewals check `www` through that redirect, the way they check the domain.
- **Which sites.** A domain of its own: two parts (`example.com`) or a country's three
  (`example.com.mx`, `example.co.uk`). Never a subdomain (`morphit.timeapp.foundation`,
  `trade.example.org`), an address that already starts with `www.`, or an onion or I2P address.
- **New installs** set it up. They ask Let's Encrypt for the domain's certificate, then add `www` to
  it; while `www` does not point at the server yet, only that addition is refused (the domain's own
  requests stay under Let's Encrypt's limit of five failed checks an hour).
- **The upgrade** looks up where `www` points, asking DNS servers directly (systemd-resolved's own
  upstream servers when it runs, so not this server's hosts file). When it points at the server, it
  adds `www` to `SERVER_NAME` and the redirect rule to `bunkerweb.env` (a copy of the old file is
  kept next to it), recreates BunkerWeb's services (a plain restart keeps a container's old settings),
  and checks on the server that `www` answers with the redirect. It then proves Let's Encrypt can
  check `www` (a test file in the web build must come back through `http://www…`), asks for the
  certificate with `www` added, reads it back, and checks that `https://www…` passes a certificate
  check. The certificate keeps what the operator set for it (its own deploy hook, preferred chain,
  key reuse; not OCSP Must-Staple, which Let's Encrypt no longer issues — the upgrade says so). When BunkerWeb refuses the settings or the site stops answering, the old
  file goes back. A settings file that already names `www` while the running BunkerWeb does not (a
  fresh install, or an upgrade that could not recreate it) is loaded by recreating BunkerWeb's
  services — once per version of the file. When BunkerWeb's Compose service sets `SERVER_NAME`
  itself, or does not read `bunkerweb.env`, the file is left alone and the upgrade names what to
  change instead. When `www` has no record, the upgrade says which record to add; when it points
  elsewhere, it says where. A certificate that names `www` after its record is gone is issued again
  without it, so renewals keep working. All of it runs in the background part of the upgrade and
  stops in time: a step that would not finish before that run's time limit is left for the next
  upgrade, so BunkerWeb is never stopped half-way (when that background part cannot be started on a
  server, the upgrade says that `www` waits for it).
- **Installer.** `morphit-ops bunkerweb` reads the domain from a `SERVER_NAME` that also lists
  `www`, keeps `www` when the domain stays the same, and moves the certificate paths with a new
  domain.
- **Onion-Location header (corrected comment).** The install template claimed the header kept the
  page a visitor is on. It never did: BunkerWeb sends the header exactly as written, and Docker
  Compose dropped the `$request_uri` it ended with. The header names the onion (as it always did in
  practice), and the page's own `onion-location` tag keeps carrying the page for Tor Browser.
