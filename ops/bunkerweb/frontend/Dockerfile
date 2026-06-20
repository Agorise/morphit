# Morphit frontend container — a plain nginx that serves the built
# SvelteKit static site AND reverse-proxies the API paths to the
# relay + indexer on the host.
#
# It sits BEHIND BunkerWeb (which terminates TLS, runs the WAF, sets
# the real client IP in X-Forwarded-For, and adds the security
# headers), so this nginx listens on plain :80 inside the
# bunkerweb_net Docker network and intentionally does NONE of that —
# its only jobs are static-file serving + path routing.
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
FROM nginx:alpine

# Drop the stock default server (it also listens on :80) and install
# Morphit's routing as the only server block.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/morphit.conf

EXPOSE 80

# nginx:alpine's default CMD already runs `nginx -g 'daemon off;'`;
# stated here explicitly for clarity.
CMD ["nginx", "-g", "daemon off;"]
