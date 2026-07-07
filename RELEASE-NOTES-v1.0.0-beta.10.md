# Morphit v1.0.0-beta.10

A focused operator-reliability release. It fixes a bug in `morphit-ops
upgrade` that left the **web frontend stale after an upgrade on BunkerWeb
deployments** — the backend would move to the new version while visitors
kept loading the old build (and never saw the "Load it now" update
prompt, because the old build was still being served). **Recommended for
every operator, especially anyone running the BunkerWeb WAF.**

If your site upgraded but still shows the previous version, this release
is the fix — and you can confirm the stale state with
`curl -s https://<your-host>/_app/version.json` (an unchanged build
timestamp after an upgrade means the frontend wasn't rebuilt).

## Fixed

- **`morphit-ops upgrade` now always rebuilds and republishes the web
  frontend.** Previously the rebuild step only ran when the bare-metal
  web root (`/var/www/morphit-frontend`) existed. On a BunkerWeb
  deployment — where the site is served by the `frontend` container from
  a different path, not `/var/www` — the upgrade silently skipped the
  rebuild, upgraded the backend, and reported success, leaving the
  container serving the old build. The web app is now rebuilt on every
  upgrade regardless of deployment style.

- **The upgrade now publishes the new build to the right place
  automatically.** It detects how your site is served and acts
  accordingly: on bare-metal nginx it copies the build into your web
  root (as before); on BunkerWeb it recreates the `frontend` container so
  it picks up the freshly-built files (a running container otherwise
  keeps serving the pre-upgrade build). If neither is found — a
  non-standard setup — it leaves the rebuilt files on disk and tells you
  exactly where, instead of failing quietly.

## Notes for operators already on beta.9

If you upgraded to beta.9 with `morphit-ops upgrade` on BunkerWeb and your
frontend is stuck on the old version, you don't need to wait for this
release to recover the current box — rebuild and recreate the container
by hand:

```
cd /opt/morphit/apps/web && npm run build
docker compose -f /opt/morphit/ops/bunkerweb/docker-compose.yml up -d --force-recreate frontend
```

(Node 22 is required for the build.) Once you're on beta.10, future
upgrades do this for you.

---

*Morphit is non-custodial and no-KYC. As always, verify the release
signature against the published fingerprint before deploying.*
