# Morphit frontend container — a plain nginx that serves the built
# SvelteKit static site AND reverse-proxies the API paths to the
# relay + indexer on the host.
#
# It sits BEHIND BunkerWeb (which terminates TLS, runs the WAF and sets
# the real client IP), so this nginx listens on plain :80 inside the
# bunkerweb_net Docker network.  It does send Morphit's security headers
# and keeps no access log itself (v1.20.0): Tor/I2P visitors reach it
# directly, without BunkerWeb — see nginx.conf.
#
# The SvelteKit production build is bind-mounted at
# /usr/share/nginx/html (see ../docker-compose.yml), so this image
# carries only the nginx config. Ship new frontend bytes by
# rebuilding the web app (`npm run build` in apps/web) — you do NOT
# need to rebuild this image for a content change. nginx.conf is ALSO
# bind-mounted from the host repo in docker-compose.yml (the COPY
# below is a baked fallback the mount overrides at runtime), so a
# config change deploys by pulling the new source and RESTARTING the
# container — `docker compose restart frontend`, or just
# `morphit-ops upgrade`, which restarts it for you. You only need to
# rebuild this image (`docker compose up -d --build frontend`) if you
# run WITHOUT the docker-compose nginx.conf mount.
# The base is pinned by digest (nginx 1.30.7, the stable line, on Alpine
# 3.24), so every box builds from the same bytes and a re-pushed tag cannot
# change them; the digest is the multi-platform index from the official
# image's repo-info.  ci.yml (scripts/check-frontend-base.mjs) asks Docker
# Hub that this index lists linux/amd64 and linux/arm64: one read while a
# release is being published can be an empty placeholder (v1.24.6 pinned
# one).  The label lets `morphit-ops upgrade` see which base a running
# frontend was built from and rebuild an older one.
FROM nginx:1.30.7-alpine@sha256:3bc3836dc0be3b811f238210360bf8e7ca8a2d0effdae46160bf1f3578710051
LABEL org.morphit.frontend-base="nginx:1.30.7-alpine@sha256:3bc3836dc0be3b811f238210360bf8e7ca8a2d0effdae46160bf1f3578710051"

# Drop the stock default server (it also listens on :80) and install
# Morphit's routing as the only server block.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/morphit.conf

EXPOSE 80

# The nginx image's default CMD already runs `nginx -g 'daemon off;'`;
# stated here explicitly for clarity.
CMD ["nginx", "-g", "daemon off;"]
