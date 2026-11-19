# Morphit v1.24.6

**Security: HTTP/2 is off on every Morphit web server until its nginx is fixed.** Two nginx bugs
made public on 2026-11-18 (CVE-2026-123633, CVE-2026-123007) let a stranger run code on a server
through nginx's HTTP/2 code, in every nginx before 1.30.7. BunkerWeb 1.5.10 (what Morphit runs)
has nginx 1.26.2 with HTTP/2 on, and no BunkerWeb with a fixed nginx exists yet.

The relay's payment queue now gives each claim its own token and a lease, the release tarball can
be checked against the signed tag, website build included, and on servers behind BunkerWeb the
Let's Encrypt certificate gets `www.<domain>` and renews without stopping BunkerWeb.

This release contains everything in v1.24.4 (v1.24.5 was never released; its changes are here).
The deadline v1.23.5 set still stands: every site must run v1.23.5 or later (so this release is
fine) before **2026-11-22 00:00 UTC**.

## For people using the site

**`https://www.<domain>` is secure.** On a site with a domain of its own, www already sent visitors
on to the domain, but the certificate named only the domain, so a browser that went straight to
`https://www.<domain>` showed a certificate warning. Each site's upgrade now adds www to its
certificate. morphit.io has it already.

## For operators

Upgrade as usual. Nothing to configure.

### HTTP/2 off (CVE-2026-123633, CVE-2026-123007)

- **Behind BunkerWeb:** the upgrade sets `HTTP2=no`, and any per-site `<name>_HTTP2` line too. It
  recreates BunkerWeb's two containers and checks in the running nginx (`nginx -T`) that nothing
  turns HTTP/2 on. If something still does, it recreates them once more, then names the command.
  A visitor may now hold 64 connections at once over HTTP/1.1 instead of BunkerWeb's 10
  (`LIMIT_CONN_MAX_HTTP1`). A browser opens up to 6 per site, and a home or phone network puts many
  visitors behind one address. A number of your own is kept.
- **On the server's own nginx (no BunkerWeb):** the upgrade takes `http2` off the `listen` lines of
  Morphit's site files and removes `http2 on;`. The shipped `ops/nginx/*.conf` have no HTTP/2.
  The distro packages are not fixed yet.
- **The frontend container** (what Tor and I2P visitors reach) never had HTTP/2. Its base image
  moves to nginx 1.30.7 anyway.
- **What visitors notice:** nothing. Browsers use HTTP/1.1, as they always have over Tor and I2P.
- **Not upgraded yet?** The one-off script `nginx-http2-off.sh`, handed out the day the bugs were
  made public, does the same on a running server. A later release turns HTTP/2 back on once
  BunkerWeb ships nginx 1.30.7 or newer.

### The payment queue

**Each claim on a payment now has its own token and a lease.** A follow-up to the outside security
report v1.24.3 answered (thanks to its reporter). Up to v1.24.4 a relay's claim on a payment used
the retry time as its identity and its lease, and three later writes were not tied to it. With two
relays on one database (a standard site runs one), a relay that stalled for more than a minute could
still overwrite the record of a payment the other relay had sent since, and that payment could have
been sent a third time. Now:

- a claim writes a random token and a 20-minute lease; no other relay takes the payment while the
  lease runs;
- a relay records a signed payment only while its token and lease hold, and a relay whose chain
  read outlasted the lease sends nothing (it counts as a failed try, with the reason, so it reaches
  you instead of repeating);
- every later write is tied to the claim: the "may have been sent" record, a counted failure, and
  every step that settles an earlier attempt;
- after a relay crash a payment waits until its lease ends. Otherwise nothing changes.

The database gets two columns (migration v75); the indexer adds them when it starts.

### The release check

The release tarball is packed on the build server, and the website in it is built there. Until now
nothing compared it with the signed tag before it was anchored on chain. The release job now checks
that the tarball holds exactly the tag's files, and the maintainer's ceremony rebuilds the website
from the tag and compares it file by file before anchoring (`scripts/verify-release-build.mjs`).
Anyone can run the same check: `docs/VERIFY-YOUR-DOWNLOAD.md`, Option C.

### Certificates behind BunkerWeb

- **What the upgrade changes.** BunkerWeb answers Let's Encrypt's check itself, from its own folder,
  so certbot now puts the check there with two small hooks in `/usr/local/lib/morphit/`. The
  upgrade first proves this works on your server (a test file must come back through your domain,
  and a test renewal with Let's Encrypt must pass). Then it switches your renewal to it, and adds
  www to the certificate when www points at your server. If either test fails, your settings stay
  as they were.
- **Renewals no longer pause BunkerWeb.** Upgrades up to v1.24.4 set renewals to stop BunkerWeb
  for a few seconds every couple of months. This upgrade switches them to the folder, which stops
  nothing.
- **To check:** `sudo morphit-ops ssl` says how your certificate renews.
- **morphit.io** was fixed by hand before this release; its upgrade finds nothing to change.

## For developers

### Payment queue (`apps/relay/src/queue/drainer.ts`)

- **Claim token and lease.** The claim writes `claim_token` (a random UUID) and `claim_lease_until`
  (now + `CLAIM_LEASE_MS`, 20 minutes: longer than the head read can take — the default list's 14
  hidden and 6 clearnet nodes at 60 s and 10 s each make 15 minutes). The drain query skips a row
  whose lease runs. The claim's compare-and-set stays on the row as read (stamp and last_error):
  every claim writes both anew, so a stale read always loses.
- **The signed record** (`onSigned`) is written only while `claim_token` is this drainer's and
  `claim_lease_until > clock_timestamp()`. If the token is still ours but the lease ran out, the
  drainer sends nothing and counts a failure (`row_claim_lease_ran_out`); if another drainer has the
  row, it is a lost claim as before.
- **Tied to the claim:** the outcome-unknown write (token), `recordFailure` (the token as read, or
  ours after the claim), and the three settle writes — not landed, still unknown, escalated — (the
  row's `last_error` as read, which names the attempt exactly). Every write that ends a drainer's
  work on a row clears the lease.
- **Not tied, on purpose:** the writes that record a payment the chain confirmed (the success write
  and a settle that finds it in the history). That payment is on chain whoever holds the row;
  refusing the write would lose its record.
- **Tests.** `drainer-no-double-pay-smoke` +10 scenarios (33 in all), two real drainers on a real
  table, gated at the exact statement: a lease that keeps a second drainer off, a lease that ran out,
  a stalled drainer's late outcome record, stale settle verdicts (absent, unknown, escalation), a
  lost claim's failure, random tokens, the lease ended by the outcome record. 8 of them fail on
  v1.24.4's drainer; 16 mutations of the drainer are each caught. The existing two-drainer scenarios
  now let the first claim's lease run out, or drop the lease from a drainer that ignores it.

### Release check (`scripts/verify-release-build.mjs`)

- **Source:** every file of the tag in the tarball with its git blob hash and executable bit;
  nothing else but `apps/web/build/` and `release-info.json` (which must name the tag and its
  commit); the sitemap may differ only by `<lastmod>` lines of the release's build day; no links,
  devices, absolute or `..` paths. The tarball is read in memory.
- **Website:** `git archive` of the tag, `npm ci --ignore-scripts`, `npm run build -w apps/web` with
  the release's `SOURCE_DATE_EPOCH`, compared file by file; a `.br`/`.gz` may differ in its bytes
  but must unpack to the rebuilt file, and verify.json may name other hashes only for those, which
  must be the shipped copies'.
- **Reproducible build:** SvelteKit's version name came from the build clock and `ConfirmModal`'s
  dialog id from `crypto.randomUUID()`; both made every build differ. The version now follows
  `SOURCE_DATE_EPOCH` (release.yml sets it from `release-info.json`), and `ConfirmModal` and
  `MarkdownGuideModal` use `$props.id()`. Two builds of the same tree from different folders are
  byte-identical; the real v1.24.4 tarball passes the source check against its tag.
- **Where it runs:** release.yml (`--source-only`, before the checksum) and ELI5 Block 3 (full).
- **Tests.** `verify-release-build-smoke` (21 scenarios: a stand-in repository whose build behaves
  like the real one; an honest release passes, each kind of tampering is refused by name);
  19 mutations of the script are each caught. An end-to-end run on the real tree (a release packed
  as release.yml packs it, then checked in full) passes.

### Docs

- `docs/SECURITY.md`: §5 is now "Signed, hashed, reproducible releases" (the release check); §2 says
  how the relay never pays a bonus twice; the program's scope names the release check.
- The site's Security page ("Signed, fingerprinted, reproducible releases") and the FAQ "Is
  Morphit vulnerable to hacking, data theft, or takedowns?" in all 10 languages: releases are
  checked against the signed tag with the website rebuilt, and a bonus payment never goes out
  twice. `llms-full.txt` regenerated.
- The brag list: #50 and #52 updated, #55 (the release check), #56 (no reward paid twice), #57
  (HTTP/2 off the day nginx's bugs went public), #272 (build from source) and #282 (www and renewals
  behind BunkerWeb); media kit rebuilt.
- `docs/VERIFY-YOUR-DOWNLOAD.md` Option C; the ceremony copy in `docs/OPERATIONS.md` and
  `docs/UPGRADING.md`; comments that called every build non-reproducible now say a plain build
  without the release's `SOURCE_DATE_EPOCH` is not byte-identical.

### Certificates behind BunkerWeb

- **The cause.** BunkerWeb 1.5.10's letsencrypt plugin puts
  `location ~ ^/.well-known/acme-challenge/ { root /var/tmp/bunkerweb/lets-encrypt; }` into every
  server it serves (`confs/server-http` and `confs/default-server-http`, with no condition). nginx
  picks a regex location over the reverse proxy's `location /`, so the request never reaches the
  frontend. Every Morphit path that put Let's Encrypt's file into the web build therefore failed
  behind BunkerWeb:
  - the upgrade's TLS renewal heal, which then fell back to pausing BunkerWeb;
  - the www heal, which never added www;
  - the BunkerWeb role's renewal switch;
  - the tls role on a re-run;
  - `morphit-first-online`, which could never get the first certificate on a box installed
    offline;
  - the commands `morphit-ops ssl` and the hardening checklist printed.

  Found on morphit.io: a test file in the web build was visible inside the frontend container, but
  came back as BunkerWeb's own 404 page.

- **The fix.** `apps/ops-cli/src/lib/acmeBunkerweb.ts` holds certbot's manual mode with two hooks.
  The auth hook writes Let's Encrypt's file into BunkerWeb's folder with `docker exec`, as the
  container's own user, which owns the folder. The cleanup hook removes it. It refuses a token
  that is not base64url and finds BunkerWeb's container by its image's `bunkerweb.type` label.
  Proven on morphit.io first: the test file came back for the domain and for www, Let's Encrypt
  issued the certificate with www, and a staging dry run passed.
- **Where it is used:**
  - `tlsRenewHeal.ts`: BunkerWeb's folder first, with the settings written, a real
    `certbot renew --dry-run` and a read-back, and the original restored on any failure. It also
    switches its own earlier pause, and a webroot renewal behind BunkerWeb, and writes missing
    hooks again. The web build stays as the next try for a web server that passes the path on.
  - `bunkerwebWww.ts`: www added through the folder, and a certificate reissued without www the
    same way. `certbotArgs` now takes the way the check reaches the server.
  - `ssl.ts`: commands through the folder. A webroot renewal behind BunkerWeb is flagged, and a
    renewal that pauses BunkerWeb is no longer called failing.
  - The hardening checklist (`render.ts`).
  - Ansible: the tls role installs the hooks (`roles/tls/files/`) and issues through them on a
    re-run; the BunkerWeb role's `reconfigure` and old-certbot renewal use them.
  - `morphit-first-online.sh`.
  - OPERATIONS.md §32 and §35. §35's "renewal breaks" step for BunkerWeb was also wrong: it said
    BunkerWeb's healthcheck renews, but BunkerWeb's own Let's Encrypt client is off.
- **Tests:**
  - The doubles in `tlsRenewHeal.test.ts` and `bunkerwebWww.test.ts` passed the path on to the web
    build, which no BunkerWeb does; that is how the broken path passed. They now answer it from
    BunkerWeb's folder only. A web server that does pass it on is its own case.
  - New `acmeBunkerweb.test.ts` runs both hooks for real in `sh` with a stand-in `docker`, and
    keeps the Ansible files identical to the TypeScript.
  - `bunkerweb-www-install-smoke`, `first-online-tls-smoke`, `sslOnNode.test.ts`,
    `hardenOnNode.test.ts` and `ssl-smoke` cover the new commands.
  - Every new check failed against v1.24.4 first. Breaking each part of the fix on its own fails a
    test: 17 mutations.

### HTTP/2 off (`upgrade.ts` Fix G, `nginxVhostHeal.ts`)

- `healBunkerWebWaf` Fix G: `HTTP2=no` for every line `bwHttp2Keys` finds: `HTTP2` and per-site
  `<name>_HTTP2`, never `LIMIT_CONN_MAX_HTTP2`. `LIMIT_CONN_MAX_HTTP1` is set to
  `BW_LIMIT_CONN_MAX_HTTP1` (64) where it is unset or BunkerWeb's 10 and `USE_LIMIT_CONN` is not
  `no`. Live check (6) reads `nginx -T` with `hasHttp2`, recreates once, then warns with the
  command. Both settings are in `bunkerweb.env.j2` and `bunkerweb.env.example`; `bunkerweb-smoke`
  keeps them equal to the heal's.
- `planVhost` takes `http2` off `listen` lines and removes `http2 on;` (comment lines are left
  alone), and `vhostLoadedOk` fails while either is loaded. Before this, the planner turned
  `http2 on;` into `listen … http2`.
- `ops/bunkerweb/frontend/Dockerfile`: `nginx:1.30.7-alpine` by digest (was 1.30.5).
- Tests:
  - New `bunkerweb-http2-heal-smoke` (15 checks) runs the real heal with a stand-in `docker`.
    Breaking each part of Fix G fails it: 7 mutations.
  - `nginxVhostHeal.test.ts` has 3 new cases. Breaking the planner, the check or either half of
    `hasHttp2` fails them.
  - `nginx-served-hardening-smoke` now asks a real nginx 1.24 for h2 on each TLS listener. It fails
    on v1.24.4's configs.
  - The steady fixtures in `bunkerwebWafIdentify.test.ts` and `bunkerweb-real-ip-heal-smoke` carry
    the two new settings.

### Dependencies

- `scripts/audit-allowlist.json`: GHSA-fc5q-39xc-vjpf (picomatch, build tooling) removed. GitHub now
  lists it as unreviewed with no affected range, so `npm audit` no longer reports it, and the audit
  gate fails on an entry npm does not report. Nothing in the lockfile changed.
