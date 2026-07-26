# How to Run Your Own Morphit Node

Running a Morphit node means hosting your own copy of the marketplace. People trade on *your* instance, you earn a small cut of the listing fees, and because every Morphit instance talks to the same Blurt blockchain, your node is part of one shared, federated marketplace — not a walled garden.

This guide is the short, friendly path. Plan for **an afternoon**, mostly copy-and-paste. You do **not** need to be a programmer. If you can follow a recipe, you can do this.

> **The fast version, so nothing's a surprise:**
> 1. Get a computer — a cheap VPS, or an old PC/laptop running Ubuntu.
> 2. Point a web address at it (a domain, or a free hostname).
> 3. Install Morphit (the automated playbook, or the guided installer).
> 4. Let the setup **wizard** ask you a few questions — no file-editing.
> 5. Turn on HTTPS (one command).
> 6. Register yourself as an operator (one command).
> 7. You're live.
>
> Each step is walked below. Most people only need sections 1–9. The **Reference and hardening** (§11) at the end is for doing things by hand or tuning later, and the deep operator reference lives in `OPERATIONS.md`.

---

## 1. What you'll need

- **A computer that stays on.** A cheap VPS, or an old desktop/laptop. Aim for **2 GB of RAM or more** and a recent **Ubuntu** (22.04 or 24.04). An old PC from a closet is genuinely fine.
- **A web address.** Either a domain name (about US$10/year) or a free dynamic-DNS hostname (see §3 if you host at home).
- **A Blurt account** for your instance. Free to make; you'll create it in §6.
- **About an afternoon**, and a password manager to save a few secrets.

That's it. The wizard and the installer handle the fiddly parts.

---

## 2. Pick where it runs

**A cheap VPS — easiest.** A small virtual server from any provider gives you a public address with no home-network fuss. Best first choice. ~2 GB RAM is plenty to start.

**An old PC or laptop at home — cheapest.** Free if you already own the machine. The only extra work is a couple of router settings (§3). Leave it plugged in somewhere with airflow.

Either way the install is the same once the machine is reachable from the internet.

> **Doing your second node?** Once you've been through this once, the script at `scripts/vps-bootstrap.sh` bundles the first-time server prep (SSH key, firewall, non-root user, automatic security updates) into one command — a handy **fast-path** for experienced operators. First time through, prefer the walkthrough below so you learn the moving parts.

---

## 3. If you host at home (the networking bits)

Skip this whole section if you went with a VPS.

Three things to sort out, once:

1. **Check your internet can be reached.** Some home connections sit behind "CGNAT," which blocks incoming visitors. Ask your provider, or compare the address on [whatismyip.com](https://www.whatismyip.com) with the "WAN IP" shown in your router — if they differ, you're behind CGNAT and should use a VPS instead.
2. **Get a free hostname.** Sign up at [duckdns.org](https://www.duckdns.org), pick a subdomain (e.g. `myinstance.duckdns.org`), and keep a small script updating it so the name always points at your home's current IP. DuckDNS gives you a ready-made update line; run it from cron every few minutes. (A normal paid domain works too — see §4.)
3. **Forward the ports.** In your router, forward incoming **port 80** and **port 443** to your home machine's local IP. Give the machine a fixed local IP first (your router's DHCP settings) so the forwarding doesn't break on reboot.

Test from your phone on mobile data (not home Wi-Fi): your hostname should reach the machine on ports 80 and 443. The blow-by-blow for power-blip survival, fixed IPs and DDNS automation is in `OPERATIONS.md`.

---

## 4. Get a web address

Buy a domain from any registrar, then add a single **A record** pointing your domain at your server's public IP address (for a home setup, use the DuckDNS hostname from §3 instead). DNS can take a few minutes to an hour to take effect. That's all the DNS you need — HTTPS comes later, in §8.

---

## 5. Set up the machine

There are two ways. Pick one.

### 5a. The automated way (recommended)

Morphit ships an **Ansible playbook** that does the whole operating-system setup for you on a fresh Ubuntu box — it installs Node.js and PostgreSQL, builds the app, lays down the background services, and deploys the website and the read-only helper. You fill in a couple of small config files and run one command:

```sh
cd ops/ansible
# 1. Tell it which machine(s) to set up.
cp inventory/hosts.yml.example inventory/hosts.yml
$EDITOR inventory/hosts.yml

# 2. Fill in the non-secret settings (your domain, your Blurt account, etc.).
$EDITOR group_vars/all.yml

# 3. Put your secrets in an encrypted vault.
cp group_vars/vault.yml.example group_vars/vault.yml
$EDITOR group_vars/vault.yml
ansible-vault encrypt group_vars/vault.yml

# 4. Run it.
ansible-playbook -i inventory/hosts.yml playbook.yml --ask-vault-pass
```

When it finishes, your services are installed and running. Jump to §8 (HTTPS).

### 5b. The hands-on way (guided installer)

If you'd rather see each step, install the prerequisites yourself, then let `morphit-ops` walk you through configuration.

Install **Node.js 22**, **PostgreSQL 15.x or higher**, and **nginx** from your system's package manager (`psql --version` should read 15.x or higher). Then get Morphit:

```sh
cd ~
git clone https://git.agorise.net/agorise/morphit.git
cd morphit
npm install
npm run build --workspaces --if-present
```

`npm install` pulls in the libraries (a few hundred MB — normal) and creates the `morphit-ops` command you'll use for everything else. It also wires up Morphit's internal **workspace symlinks** (`@morphit/asset-registry` and friends). If you ever run the test suite before `npm install` finishes and see `ERR_MODULE_NOT_FOUND` complaining about `@morphit/asset-registry`, that just means the symlinks aren't in place yet — run `npm install` and it clears up. **Re-run `npm install` after every `git pull`.**

Now run the guided installer:

```sh
npx morphit-ops install
```

It checks your prerequisites (Node 22, PostgreSQL, git), runs the **setup wizard** (§8), and offers to harden the server. It deliberately does **not** install Node/PostgreSQL or the background services for you — that's what the automated playbook in §5a is for — so set up the database and services next.

**Database.** Pick a strong password (`openssl rand -base64 32`), save it, then create the role and database:

```sh
MORPHIT_INDEXER_DB_PASSWORD='<your-strong-password>' \
    sudo -E -u postgres psql -f ops/postgres/init.sql
cd apps/indexer && npm run migrate && cd ../..
```

The init script refuses to run with a placeholder like `__SET_BEFORE_DEPLOY__` or `CHANGEME` — that's on purpose, so nobody ships with an example password.

**Background services.** The shipped unit files assume the default `/opt/morphit` path, so instead of editing them by hand, run the **path-aware installer** — it detects where you actually cloned the repo and writes the services with the correct paths:

```sh
sudo bash ops/scripts/install-systemd-units.sh
sudo chown morphit-relay:morphit-relay /etc/morphit/relay.env
sudo systemctl enable --now morphit-indexer morphit-relay
```

**nginx.** Serve the built website over HTTPS and proxy the API to the local services. The shipped `ops/nginx/web.conf` is a complete, ready-to-adapt server block — copy it and change `yourdomain.com` to your domain. The security headers and no-cache rules you must keep in sync are reproduced in §11. One thing worth setting while you're in there: the live-chat endpoints (`/v1/chat/…/stream` and `/v1/chat-activity`) are held-open "streaming" connections, so instead of the usual per-minute request limit they want a **per-visitor cap on how many streams one address can hold open at once** (a generous number — a few dozen — so nobody with several tabs is affected). This stops one bad actor from tying up connections without slowing chat down for everyone else. `OPERATIONS.md` (the BunkerWeb / reverse-proxy section) shows the exact `limit_conn` snippet.

---

## 6. Create your Blurt account

Your instance posts to the Blurt blockchain under its own account. Make a free Blurt account (any Blurt signup works), and keep its keys in your password manager. The wizard will ask for the account name and the key it needs. You can do this before or during the wizard.

---

## 7. Configure it (the wizard)

If you ran `morphit-ops install`, the wizard already ran. To run it on its own:

```sh
npx morphit-ops init
```

The wizard **walks you through 23 steps** — your Blurt account, your domain, your operator tag, your fee preferences, optional alerts — asking one plain-language question at a time and writing the configuration files for you. No hand-editing required. (If you *want* to hand-edit later, the full list of settings is documented in `OPERATIONS.md`.)

One of those questions is your **fees account** — the Blurt account your BLURT listing fees are paid into. You earn 90% of those fees, so make it an account you control. If you skip it or mistype it, nothing breaks: fees fall back to the shared `@morphit-fees` treasury and your node keeps running. You can change it later any time with `npx morphit-ops edit` → **Fees account**.

It also **remembers your answers as you go**, so if you ever get interrupted partway through, just run `npx morphit-ops init` again and it offers to pick up where you left off — re-asking only the two things it never writes to disk: your database connection and your relay account's active key.

Two things the wizard does **for you, by default**: it **generates privacy-network addresses** in the background — a **Tor `.onion`** (instant) and, when **i2pd** is installed on the host, a **`.b32.i2p`** too — so your site is reachable over Tor and I2P and shows those footer pills automatically (no waiting, no vanity grinding; any address you'd already set is kept), and it **hand-holds you through server hardening** — a short run of "yes" confirmations (SSH lockdown, firewall + fail2ban, automatic updates, kernel hardening, intrusion detection). The Ansible playbook (§5a) applies all of that for you; to *serve* the generated addresses, point the `tor` role at the `tor-hidden-service/` directory and the `i2pd` role at the `i2p-tunnel/` directory the wizard wrote (see `OPERATIONS.md`).

---

## 8. Turn on HTTPS

Once your domain points at the machine and nginx is serving it, get a free Let's Encrypt certificate. The easiest way is to let `morphit-ops` print the exact command for your domain:

```sh
npx morphit-ops ssl setup
```

It checks the prerequisites and shows you the precise `certbot` line for *your* domain (under the hood it's `sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com`). Afterwards, `npx morphit-ops ssl` tells you at a glance whether the certificate is valid, when it expires, and — the part people forget — whether automatic renewal is switched on.

---

## 9. Register as an operator

This is the step that puts your instance on the map and starts attributing fees to you.

### 9.1 Broadcast the registration

```sh
cd ~/morphit
npx morphit-ops register
```

It reads the account, tag, display name and contact URL the wizard saved, shows you exactly what it will broadcast, and asks you to confirm before posting it on-chain.

> If this says **command not found**, you're almost certainly outside the repo, or `npm install` hasn't finished. `cd` back **inside the Morphit directory** (`cd ~/morphit`), make sure `npm install` is done, and try again (see §12).

Once registered, orders posted on your instance carry your tag, and your share of the listing fees flows to you automatically. There's nothing to invoice and nobody to ask.

---

## 10. Keeping it running

**If someone gets flagged unfairly.** Morphit watches for self-dealing — accounts reviewing each other to inflate a rating. The detectors are heuristics, so honest people can trip them (two accounts set up on the same machine reviewing each other looks identical to the real thing). A flagged account loses its reputation card and its reviews are shown subdued. You can undo this: `sudo morphit-ops` → Moderation → **Clear a flag**, name the two accounts, and they are restored immediately and permanently. It is instance-local and reversible. Clearing the related-accounts flag is permanent (it rests on how the accounts were created, which cannot change); clearing the mutual-review flag forgives the reviews so far but keeps watching, so the pair is flagged again if they build up a fresh pattern. OPERATIONS.md explains what each flag meant before you decide.

**Backups.** Your data lives in PostgreSQL. The automated playbook sets up a daily database backup on a timer for you. The wizard writes your backup config and then prints a short list of `sudo install …` commands to run — the timer is live only once you have run them, so do not assume backups exist until you have seen one. **Prove the first dump:** `sudo systemctl start morphit-backup.service`, then `sudo journalctl -u morphit-backup.service -e --no-pager` should report a real byte count, and the file should be there in your backup directory at a plausible size. Check again after the first unattended run — a backup you have never watched succeed is not a backup. After that, `morphit-ops health` keeps an eye on it for you: its **Backups** line shows the newest dump with its size and age, and turns red if the timer has been firing without producing anything. That last case is the one that bites silently, so glance at it whenever you run a health check. If your Postgres runs in a Docker container (a BunkerWeb / `docker-compose` setup), that's handled automatically — the wizard, and every `sudo morphit-ops upgrade`, detect the container and dump it via `docker exec` (you never look up the container name). The full backup recipe, the Docker-aware `DB_CONTAINER` field, off-site options, and the quarterly restore drill are in `OPERATIONS.md`. Back up before any upgrade.

**A backup that failed no longer looks like one that worked.** Up to v1.8.9 there was a nasty edge here: if the database was unreachable when the nightly run fired, the script still wrote a tiny file, gave it a real backup name, and reported success — and because that file was the *newest* one, the health check called it fresh. You would have had a directory that looked like a year of backups and was in fact a year of 20-byte stubs. From v1.8.10 the script checks whether `pg_dump` itself succeeded, throws away anything that failed, and `morphit-ops health` refuses to call an implausibly small dump fresh. If you are upgrading, run `ls -lS` on your backup directory once and delete anything measured in bytes rather than kilobytes — those are old failed runs. A real dump is tens of kilobytes at the very least.

**Upkeep — how often will I touch this?** Rarely. To update Morphit, `git pull`, then `sudo morphit-ops upgrade` — it rebuilds and redeploys the website (and the read-only helper) and restarts the services for you, then double-checks that the read-only helper answered back on the address it's set to listen on (if it doesn't, you get a plain warning pointing at `journalctl -u morphit-mcp` — the website itself is unaffected). Check on things any time with `morphit-ops status`, or the live health endpoint at `https://yourdomain.com/v1/health`.

**Is the USD price healthy?** Run `morphit-ops health` and look at the price-feed lines. Morphit reads the BLURT price from several public providers at once — including Blurt's own feed (`api.blurt.blog`) — and uses the middle value, so one provider being off doesn't move your price. The health view lists each provider, whether it answered, and the price it gave — so if one (say, a particular API) is down, you'll see a `down` next to its name and can ignore it unless several go dark at once. (If you firewall your server's outbound traffic, allow `api.blurt.blog` along with the other price sites.) This detail shows only in your own `morphit-ops health` on the server, never on the public `https://yourdomain.com/v1/health` page.

**Is the server itself OK?** The same `morphit-ops health` view has a **System** section showing your box's CPU, memory, and disk usage (the disk numbers match `df -h /`). It's a quick gut-check: if the disk is nearly full or the CPU is pegged at 100%, that's usually why things feel slow or the indexer falls behind. These numbers are read right off your own machine and are never exposed on the public health page.

---

## 11. Reference and hardening

The bits you copy into config, plus optional extra protection. Most people set these once.

### 11.1 Which assets you offer

Every tradable asset is **on by default** — including **BARTER** (goods/services, the one non-crypto "asset"). To switch some off, list their tickers in one line of your indexer config:

```
MORPHIT_INDEXER_DISABLED_ASSETS=USDT,USDC,DAI,BCH,LTC,DASH,DOGE,ZEC,ARRR,DCR,SOL,ETH,XRP,BARTER
```

Leave it empty to offer everything. (BLURT, BTC and XMR are always available.) For example, a crypto-only instance that doesn't want off-platform barter listings would add `BARTER` to that line.

### 11.2 nginx: never cache the update files

So the website updates cleanly for visitors after you deploy, mark these two files no-cache in your nginx site config:

```
location = /service-worker.js { expires -1; try_files $uri =404; }
location = /verify.json       { expires -1; try_files $uri =404; }
```

These blocks go in **the server config that actually serves the website files** — the one holding your `location /` and API proxy blocks. If your reverse proxy (e.g. BunkerWeb) serves the build *directly* rather than proxying to a separate frontend nginx, that's the file to edit; see OPERATIONS.md §"Caching the update surface" for that topology and the header-inheritance caveat.

**Verify it after setup — one command, and it's the difference between updates working or not.** Once your site is live, check the two files come back uncacheable:

```
curl -sI https://yourdomain.com/service-worker.js | grep -i cache-control
curl -sI https://yourdomain.com/verify.json       | grep -i cache-control
```

You want `cache-control: no-cache` on **both**. If either line is missing or shows something cacheable (`max-age=…`, `public`, or an `age:` above 0), the no-cache rule isn't reaching those files — fix that before announcing your node. Without it, a stale service worker sticks on visitors' devices and they stop receiving your deploys until they manually hard-refresh (which almost no one does), so they can silently miss bug fixes and even see chat messages fail to appear.

**Don't add your own caching on top of `/v1/...`.** The indexer already sets the right `Cache-Control` per response, and it varies deliberately: `GET /v1/profiles` returns `max-age=90` only when every requested account was found, and `no-store` when any account is missing. A missing account usually just means the indexer hasn't caught up with that person's brand-new profile yet — if an edge cache pins that answer, visitors see their display name as `@account` and their avatar as the default identicon, and refreshing the page won't fix it. Proxy `/v1/` straight through and let the upstream headers win. (If you enable BunkerWeb's `USE_CACHE`, check it isn't configured to override upstream cache directives.)

### 11.3 Security headers (copy verbatim)

Add these two headers to your HTTPS server block. **Keep them byte-for-byte identical** to the shipped `ops/nginx/web.conf` — they lock the site to itself and to the known Blurt RPC servers:

```
add_header Permissions-Policy "camera=(self), microphone=(), geolocation=(), interest-cohort=()" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://rpc.drakernoise.com https://blurtrpc.dagobert.uk https://rpc.blurt.blog https://rpc.beblurt.com https://rpc.blurt.one https://blurt-rpc.saboin.com; media-src 'none'; object-src 'none'; child-src 'none'; frame-src 'none'; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'" always;
```

### 11.4 Optional: a web application firewall (BunkerWeb)

For extra protection you can put Morphit behind BunkerWeb. The guided installer sets it up:

```sh
npx morphit-ops bunkerweb
```

It runs as a small Docker stack on its own private network (`172.20.0.0/16`); use that range if you ever reference the WAF network in your own config.

### 11.5 Optional: an encrypted-memory host (advanced)

Totally optional, and most people don't need it. If your VPS offers a "confidential computing" mode (AMD SEV-SNP or Intel TDX), turning it on encrypts your server's memory in hardware. The only secret Morphit keeps in memory is your relay's Blurt posting key — never anyone's funds, because Morphit holds no funds. So it's a small extra shield for that one key, not a fix for any gap. Morphit makes no "secure-enclave" claims and doesn't rely on it; your Tor address, the locked-down security headers, and the on-chain hash of every release already cover the essentials. `OPERATIONS.md` has the honest details and the trade-offs.

### 11.6 Chat speed (on by default)

Messages in a chat show up within a few seconds. Your node does this by watching the very newest blocks on the chain, instead of waiting the ~45–60 seconds it takes for a block to become permanent. It's on automatically — you don't have to do anything.

It's safe: this fast lane only ever *reads* the chain, never writes to your database, and it only handles chat (never money or orders — those always wait for permanence). It still respects your users' block lists. If a block gets reorganized away by the network (rare), a message that flashed up live just won't be saved to history — fine for chat.

You can check on it any time from the node-health screen — `morphit-ops` → **Node health** (main menu item 13) shows a **Fast path** line next to your price feeds. It tells you whether the fast lane is keeping up with the chain, and how many blocks behind it is if it isn't.

There's no switch to turn this off, and that's deliberate: the fast lane only ever reads, so the worst it can do is fail to be fast. There's nothing to protect you from, and nobody prefers slow. (If you have an old `MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED` line in `ops/env/indexer.env`, it does nothing now — you can delete it.)

If the small amount of extra chain traffic is a problem for your node, you can slow the fast lane down rather than lose it — open `ops/env/indexer.env` and raise:

```
MORPHIT_INDEXER_FASTPATH_INTERVAL_MS=2000
```

then restart the indexer. (`OPERATIONS.md` §19 has the full details, including the `/v1/health` status field.)

### 11.7 Verify what you downloaded (optional but wise)

Before you deploy code you fetched, you can prove it's the genuine, unmodified release. Every release is a GPG-signed git tag, mirrored automatically to GitHub + Codeberg, and its hash + signing-key fingerprint are anchored on the Blurt chain by `@morphit` — so verification doesn't rest on trusting any single host. If you cloned the repo, the quickest check is the signed tag:

```
git verify-tag v1.8.15
```

Or, for a downloaded release tarball, cross-check it against the on-chain anchor:

```
node scripts/verify-download.mjs morphit-v1.8.15.tar.gz
```

That computes the tarball's SHA-256, fetches the on-chain anchor straight from a Blurt RPC node, and tells you whether they match — then prints the fingerprint to check the signature against. The full step-by-step (both paths, plus optional IPFS) is in **`docs/VERIFY-YOUR-DOWNLOAD.md`**.

### 11.8 Everything else

The full operator reference — every configuration setting, the complete nginx server block, the background-service details, the Ansible internals, federation-cost mechanics, and deeper hardening (SSH lockdown, fail2ban tuning, firewall rules) — lives in **`OPERATIONS.md`**. This guide covers the happy path; `OPERATIONS.md` is the encyclopedia.

---

## 11.5 Your node helps host Morphit (automatic)

Your instance also runs a small **IPFS node** that keeps a copy of Morphit's current signed release available to everyone. Think of it as every operator chipping in to host the app itself, so a signed copy is always reachable even if the big pinning services ever go away. You keep 90% of the listing fees — hosting the release you run is a fair trade.

You don't have to do anything: on an Ansible install it's **on by default**. It's deliberately light (a low-power profile, a small connection cap, about 12 MB kept), and if it ever hiccups it never affects your site.

On a hand-installed box, turn it on once with `morphit-ops` → **Harden this server** → **Set up IPFS release hosting** (or `sudo sh ops/ipfs/morphit-ipfs-setup.sh`). To check it: `systemctl status ipfs morphit-ipfs-pin.timer`. Details are in `OPERATIONS.md` §48. If your box is very small on memory, you can opt out there.

---

## 12. When something breaks

**"morphit-ops: command not found."** You're running it from the wrong place, or `npm install` hasn't finished. `cd` **inside the Morphit directory** (`cd ~/morphit`), confirm `npm install` completed, and retry.

**The site won't start.** Run `morphit-ops doctor` for a read-only config check — it tells you what's misconfigured before the services even try to boot. Then check the service logs with `journalctl -u morphit-indexer` (and `-u morphit-relay`).

**Account avatars show as broken images.** This is almost always a missing or wrong image-host setting, or your nginx not proxying the API; confirm the API answers (next item) and check the avatar/media settings documented in `OPERATIONS.md`.

**The indexer fell behind the chain.** Check `https://yourdomain.com/v1/health` and look at the `lag_blocks` field — a small number is normal; a large, growing one means the indexer is struggling (often an RPC or database hiccup). Restart it and watch `lag_blocks` come back down.

**Is the API even up?** Test it directly (note the `/v1/` path, which nginx routes to the indexer):

```sh
curl https://yourdomain.com/v1/health
```

A healthy response is JSON with a recent block number and a small lag, like `{"chain_head_block": 12345678, "lag_blocks": 2}`. If that works but the site doesn't, the problem is in the website/nginx layer, not the services.

---

That's the whole job. Get a machine, point a name at it, run the installer, let the wizard configure it, turn on HTTPS, register — and you're an operator in the federation. Welcome aboard.

## Your node is a good neighbour to the Blurt RPC nodes (v1.7.5)

The public Blurt RPC nodes are run by volunteers, for free, and
Morphit leans on them.  Your indexer is built not to abuse that:
it caps its own request rate, backs off exponentially when a node
pushes back, jitters its retries so every Morphit instance in the
federation doesn't stampede the same node at the same second, and
fetches blocks in batches of 20 rather than one request at a time
when it is catching up after downtime.  If a node's firewall
refuses those batches (some public nodes return an HTTP 406/403 to
a batched request while serving single ones fine), your indexer
notices and quietly switches to one-at-a-time for that node — so a
single strict node can't stall your catch-up, and you never have to
hand-pick endpoints (since v1.8.1).

It also **says who it is**.  Every request your indexer makes to a
Blurt RPC node carries:

```
User-Agent: Morphit/<your indexer version> (+https://git.agorise.net/agorise/morphit)
```

(`<your indexer version>` is the same version `/v1/health` reports —
so an operator can tell an old instance from a current one.)

That matters more than it looks.  Node's built-in `fetch` sends
`user-agent: node` by default — the same string as every anonymous
script on the internet — which is exactly what bot-detection rules
are written to catch, and it gives an RPC operator nobody to contact
if your traffic misbehaves.  Naming ourselves means an operator who
wants us to back off can find us instead of just blocking us.

Two of Morphit's own background jobs identify themselves more precisely
still — `morphit-indexer/federation-probe` and
`morphit-indexer/signup-anomaly-probe` — because a node operator
reading logs is better served by "which job" than by "which app".

If you run a public Blurt RPC node and Morphit traffic is causing you
grief, the contact URL above is the right place to say so.

**Be aware of what this means for your server.**  The header goes on
*every* outbound request your indexer makes — the Blurt RPC nodes, the
BLURT price feed, and the federation probe that checks other instances.
So any host your indexer contacts learns that the IP calling it is
running Morphit, and which version.

We think that is the right trade and we are not hiding it: an RPC node
operator who cannot tell who is calling can only block, never ask.
Your server's IP is visible to those hosts either way, and the public
instances list already names the instances that want naming.  But if you
are running an instance you would rather nobody enumerate, know that
this header is one of the ways they could — and note that it says
nothing whatsoever about your *users*.  Your users' browsers are not
touched by this; their requests go to your indexer, not through it.

You don't configure any of this and there is nothing to tune.  It
is listed here so you know what your node is doing on your behalf,
and because if you ever run your own Blurt node, this is the
behaviour you'll be receiving.

## Upgrading past v1.3.5 — one database change, applied for you

Upgrading an indexer to v1.3.5 or later applies a schema
migration (v39) that re-keys the chat read-receipt table so
that reading one conversation with somebody no longer marks
every other conversation with that same person as read.

You do not have to run anything. `sudo morphit-ops` →
**option 2** applies it at start-up, and read receipts you
already have keep working exactly as before.

**One caution:** once that migration has run, an *older*
indexer build can no longer write chat read receipts — it
looks for a database constraint that no longer exists. If you
roll the indexer back to a pre-v1.3.5 build, roll it forward
again, or restore the database backup you took before the
upgrade. Messages, orders and the orderbook are unaffected
either way.
