# How to Run Your Own Morphit Node

Running a Morphit node means hosting your own copy of the marketplace. People trade on *your* instance, you earn a large cut of the listing fees, and because every Morphit instance talks to the same Blurt blockchain, your node is part of one shared, federated marketplace — not a walled garden.

This guide is the short, friendly path. A mostly copy-and-paste 15-minute procedure. You do **not** need to be a programmer. If you can follow a recipe, you can do this.

> **The fast version, so nothing's a surprise:**
> 1. Get a computer — a cheap VPS, or an old PC/laptop running Ubuntu.
> 2. Point a web address at it (a domain from any registrar).
> 3. Install Morphit — **one command** sets everything up.
> 4. Let the setup **wizard** ask you a few questions — no file-editing.
> 5. HTTPS turns on automatically.
> 6. Register yourself as an operator (one command).
> 7. You're live.
>
> Each step is walked below — the whole thing is sections 1–10. Anything advanced — installing by hand, building from source, tuning, deeper hardening — lives in the operator reference, `OPERATIONS.md`; you won't need it to get running.

---

## 1. What you'll need

- **A computer that stays on.** A cheap VPS, or an old desktop/laptop. Aim for **2+ CPUs, 4+ GB of RAM, and 80+ GB of drive space (SSD is best)** running **Ubuntu 24.04 LTS** (or a 24.04-based flavor — Linux Mint 22, Pop!_OS 24.04, Zorin OS 17). The one-command installer targets the 24.04 "noble" base; older Ubuntu (22.04) and other distros aren't supported on this path. An old PC from a closet is genuinely fine.
- **A web address — or not.** A domain name (about US$10/year) from any registrar gives you a normal `https://` clearnet site. If you host at home, §3 covers the small bit of extra networking. **Or skip the domain entirely and run Tor-only** — the wizard offers this — and your marketplace is reachable at an auto-generated `.onion` address with no domain, no certificate, and no router port-forward (see the callout below).
- **A Blurt account** for your instance. Free to make; you'll create it in §5.
- **A password manager** to save a few secrets.

That's it. The wizard and the installer handle the fiddly parts.

> **Tor-only nodes (maximum privacy, zero paperwork).** When the wizard asks how people will reach your marketplace, you can choose **Tor-only** instead of a clearnet domain. The node then has **no clearnet reliance**: it's reachable over its auto-generated Tor `.onion` (and, when i2pd is installed, its `.i2p`/`.b32.i2p`), it appears in the federated `/instances` directory by that onion, and it skips the domain, the HTTPS certificate, the home port-forward, and dynamic DNS — so the wizard is a few questions shorter. It advertises the onion as its on-chain origin automatically. You can add a clearnet domain later (see `OPERATIONS.md`).
>
> *Notifications on a Tor-only node:* live chat and the in-tab "you have new messages" badge (the number in the browser tab and on the icon) work exactly as they do on a clearnet node — fast and fully anonymous, no setup. The only thing that does not work is browser *push* notifications when the tab is fully closed: those rely on Google/Mozilla push servers your users would never want an anonymous session touching, and browsers block them on `.onion`/`.i2p` anyway. So you lose nothing a privacy-first node would want. (Details: `OPERATIONS.md` §42.) If you raise how long a push may wait (`MORPHIT_RELAY_PUSH_MAX_AGE_SECONDS`), the relay also remembers sent pushes at least that long, so nobody gets the same notification twice.

---

## 2. Pick where it runs

**A cheap VPS — easiest.** A small virtual server from any provider gives you a public address with no home-network fuss. Best first choice. ~4 GB RAM is plenty to start.

**An old PC or laptop at home — cheapest.** Free if you already own the machine. The only extra work is a couple of router settings (§3). Leave it plugged in somewhere with airflow.

Either way the install is the same once the machine is reachable from the internet.

---

## 3. If you host at home (the networking bits)

Skip this whole section if you rented a server (a VPS) — it's only for running Morphit on a computer in your house, like a spare laptop or a little Raspberry Pi.

Picture it like this: your home has one front door to the internet (your router), and right now nobody outside knows how to knock on it or which room to visit. There are three one-time things to set up so they can. Take them slowly — you only ever do them once.

**1. Make sure outside visitors can reach your house at all.**

Some home internet plans put you behind a shared front door with lots of other homes, so a visitor can't be sent to *your* door specifically. (It has a technical name — "CGNAT" — but you don't need to remember it.) Here's a 30-second check:

- On the computer at home, open [whatismyip.com](https://www.whatismyip.com) and note the number it shows.
- Log into your router — usually by typing `http://192.168.0.1` or `http://192.168.1.1` into a web browser; your router's sticker often lists the exact address and password — and find the number it calls your "internet" or "WAN" address.
- If those two numbers (from 192.168.n.n and whatismyip) are the **same**, you're good. If they're **different**, your provider has you behind the shared door. Either phone them and ask for a "public IP address" (sometimes free, sometimes a small fee), or just rent a cheap server instead (§2), which sidesteps all of this.

If neither `http://192.168.0.1` nor `http://192.168.1.1` opens your router's login page, find its real address by running this in a terminal on the home computer:

```sh
ip route | grep default
```

The address right after `default via` (for example `192.168.1.1`) is your router — type that into the browser instead.

**2. Give your home a web address that keeps up with you.**

Home internet addresses tend to change every so often, so your web address needs to follow the change automatically. You'll get a domain from any registrar — that's §4, coming up. Because your home's address moves, the guided installer sets up **dynamic DNS** for you: it quietly re-points your domain at your home every few minutes, even after your address changes or the power blips. The only home-specific thing the wizard asks for is your registrar's "dynamic DNS update URL" (your registrar's help pages call it exactly that); you paste it in once and you're done.

**3. Tell your router to send Morphit's visitors to the right computer.**

Two small router settings, both one-time:

- **Give your home computer a permanent parking spot.** In your router, find the list of connected devices (often labelled "DHCP" or "LAN") and set your Morphit computer to *always* get the same local number, like `192.168.1.121`. This stops the next step from breaking every time the computer restarts.
- **Point website knocks at that computer.** Find your router's "port forwarding" page and add two rules that send visitors arriving at **door 80** and **door 443** (the two standard doors websites use) to that permanent number. Every router words this slightly differently — searching "port forwarding" together with your router's brand usually turns up a step-by-step with pictures.

**Put up a quick test page first.** Before you test from your phone, give your Morphit computer something to answer with, so the test below actually shows something. On the home computer, open a terminal and run:

```sh
mkdir /tmp/porttest && cd /tmp/porttest && echo "it works" > index.html
sudo python3 -m http.server 80
```

Leave that running. Now on your phone (mobile data only!), visit **`http://YOUR-PUBLIC-IP`** in your browser — the public number from whatismyip.com in step 1, *not* the `192.168…` one (that only works inside your house).
- If you see the words "it works" → the door is open and forwarding is correct. 🎉
- If it times out → forwarding isn't reaching the PC yet; re-check the port rules you set, and confirm the static address is really set to `192.168.1.121` — that's the inside address the front door (port 80) forwards to.
- type Ctrl+C to end the porttest above

**Now test it.** Turn Wi-Fi *off* on your phone (so it uses the mobile network, like a real outside visitor would) and open your new address. If your computer answers, the front door is open and you're ready. If not, re-check the two router settings above.

The fiddly extras — surviving power cuts, locking that local number in place, automating the address updates — are all covered in `OPERATIONS.md`, and the wizard and installer handle most of them for you.

---

## 4. Get a web address

Buy a domain from any registrar, then add a single **A record** pointing your domain at your server's public IP address. (Home setup? Point it at the public IP you found in §3; the guided installer then keeps that record updated automatically as your home address changes — see §3.) DNS **A records** can take up to an hour to take effect, so be patient.

---

## 5. Create your Blurt accounts

Your instance uses the Blurt blockchain, and it's best to make **two** free Blurt accounts:

- a **relay account** — it signs new-user signups and pays the small chain fee for each, so **fund it with enough BLURT for at least 20 signups** (about 2,000 BLURT to start) and have its *active key* ready (it lives on the server); and
- a **fees account** — where your listing-fee earnings land. Keep its keys **off the server** (don't enter them anywhere), so your earnings stay safe even if the machine is ever compromised.

Name them after **your own** instance or domain so they're easy to recognise — use your branding, not the word "morphit" (that's our reserved namespace). For example, if your instance is **Acme Barter** at `acme-barter.com`, you might use **@acmebarter-relay** and **@acmebarter-fees**, or **@acme-relay** and **@acme-fees**. Any Blurt signup works (for example your own onboarding page, or another Blurt wallet); keep all the keys in your password manager.

(You *can* use one account for both to keep things simple, but two is safer. The wizard asks for these — make them before or during setup. Every instance you pay for is **yours**: your relay pays only your signups, and morphit.io never pays for other instances.)

---

## 6. Set up the machine

It's **one command**.

### The easy way (recommended for everyone)

With your two Blurt accounts ready (§5), download the latest release (~700MB) from [morphit.io/en/download](https://morphit.io/en/download#source-code), create and extract it into a `/morphit/` folder, open a terminal **in that folder**, and run:

```sh
sudo bash morphit-setup.sh
```

When it asks, choose **"Full guided install."** That's the whole job: Morphit sets up *everything* on this computer for you — Node.js, PostgreSQL, the app and its background services, HTTPS with automatic renewal, the BunkerWeb firewall, your Tor `.onion` and I2P addresses, and full server hardening. A home computer gets the **exact same** hardened setup a rented server does — nothing is treated as "less". Along the way it asks a few plain-language questions — your domain, your Blurt account and its signing key, an email for your free HTTPS certificate, and, **only if you're at home**, your registrar's dynamic-DNS update URL — and it shows you the passwords it generated so you can save them somewhere safe first. If you're at home it also reminds you to forward ports 80 and 443 to this computer in your router before it turns on HTTPS.

When it finishes, your node is installed and running — HTTPS, firewall, Tor/I2P and all. There's nothing more to switch on; skip straight to **§8 (register as an operator)**.

You only need the release you downloaded — the guided installer deploys exactly those files, so "just the tarball" really is enough. What you download is Morphit's **source** (the code itself — a few tens of megabytes); it deliberately does **not** bundle the software libraries. The very first thing `morphit-setup.sh` does is fetch those with `npm install` — a few hundred megabytes. That step is normal (you'll see "Installing Morphit's libraries…") and can take a few minutes on a slow connection, so let it finish before the wizard appears.

> **Prefer to do it by hand?** Two advanced install paths — running the Ansible playbook yourself, and building from source with "Configure only" (you install Node.js, PostgreSQL and nginx) — live in `OPERATIONS.md` (§49). This guide stays on the one-command path.

---

## 7. Configure it (the wizard)

As part of the one command, the guided install runs a short **setup wizard** — you don't start it yourself. It **walks you through the setup one plain-language question at a time** — your Blurt account, whether you're using a clearnet domain or running Tor-only, your operator tag, your fee preferences, optional alerts — writing the configuration files for you as you go. It's about a dozen questions for a clearnet node, and a few fewer for a Tor-only one (no domain, certificate email, port-forward, or dynamic DNS). The wizard numbers each step so you always know how far along you are. No hand-editing required. (If you *want* to hand-edit later, the full list of settings is documented in `OPERATIONS.md`.)

One of those questions is your **fees account** — the Blurt account your BLURT listing fees are paid into. You earn 90% of those fees, so make it an account you control. If you skip it or mistype it, nothing breaks: fees fall back to the shared `@morphit-fees` treasury and your node keeps running. You can change it later any time with `npx morphit-ops edit` → **Fees account**.

Another is **alerts** (optional, but worth it for an always-on node). If you'd like your node to message you on Matrix when something needs attention — low disk, a backup that didn't run, a service down, a TLS certificate nearing expiry — the wizard asks for a small "bot" Matrix account's access token (separate from your personal account) and the personal `@you:server` address the alerts should be DM'd to. **Enter a valid bot token and alerting switches on by default** — the Matrix bot plus the disk/backup/cert/service monitors all come up together. Don't have a bot token handy? Press Enter to skip; you can turn alerts on any time later with `npx morphit-ops matrix`. (Alerts always go to a private `@user:server` — never a `#room`, which would broadcast them.)

It also **remembers your answers as you go**, so if you ever get interrupted partway through, just start the installer again and it offers to pick up where you left off — re-asking only the two things it never writes to disk: your database connection and your relay account's active key.

Two things the wizard does **for you, by default**: it **generates privacy-network addresses** in the background — a **Tor `.onion`** (instant) and, when **i2pd** is installed on the host, a **`.b32.i2p`** too — so your site is reachable over Tor and I2P and shows those footer pills automatically (no waiting, no vanity grinding; any address you'd already set is kept), and it **hand-holds you through server hardening** — a short run of "yes" confirmations (SSH lockdown, firewall + fail2ban, the BunkerWeb web-application firewall, automatic updates, kernel hardening, intrusion detection). The guided install applies all of that for you automatically.

---

## 8. Register as an operator

This is the step that puts your instance on the map and starts attributing fees to you.

### 8.1 Broadcast the registration

```sh
cd ~/morphit
npx morphit-ops register
```

It reads the account, tag, display name and contact URL the wizard saved, shows you exactly what it will broadcast, and asks you to confirm before posting it on-chain.

> If this says **command not found**, you're almost certainly outside the repo, or `npm install` hasn't finished. `cd` back **inside the Morphit directory** (`cd ~/morphit`), make sure `npm install` is done, and try again (see §10).

Once registered, orders posted on your instance carry your tag, and your share of the listing fees flows to you automatically. There's nothing to invoice and nobody to ask.

> **Pick a tag that doesn't look like a reserved name.** From v1.18.0, a new tag is refused if it is `morphit`, `agorise` or one of the project's accounts, or a look-alike such as `m0rphit`. It is also refused if it starts with one of those names followed by `-`, `.` or `_`, such as `morphit-io`. A tag that only contains the name, such as `mymorphit`, is fine. A tag you already registered keeps working.
>
> **Someone registered your address before you?** You don't need to do anything. Register your address as usual. Your node's own `/v1/instance` names your relay account, and the other nodes give the directory entry to whichever registered account that is. The entry is not shown as a mismatch.

---

## 9. Keeping it running

Day to day there's almost nothing to do. One command shows you everything:

```sh
sudo morphit-ops health
```

It reports sync state, your last backups, the BLURT price feed, and the box's CPU / memory / disk — glance at it now and then; anything unhealthy turns red. (For remote monitoring, `morphit-ops health --json` prints the same thing machine-readably — see `OPERATIONS.md`.)

**Backups (automatic).** The installer sets up a daily database backup. The wizard prints a few `sudo install …` commands — run them to switch the timer on, then prove the first dump actually worked:

```sh
sudo systemctl start morphit-backup.service
```

Afterward the **Backups** line in `morphit-ops health` should show a real file. A backup you've never watched succeed isn't a backup. Back up before any upgrade. (Docker Postgres, off-site copies, and the restore drill are in `OPERATIONS.md`.)

**Updating.** Rarely needed, and easy:

```sh
git pull
sudo morphit-ops upgrade
```

It backs up first, rebuilds and redeploys the site, restarts everything, and rolls back if anything fails. (Fully-offline upgrades from a signed tarball are supported too — see `OPERATIONS.md`.)

**What the upgrade will not do (v1.18.0).** It never installs an older version than the one you run (add `--allow-downgrade` if you really mean to). It stops if a release's signature is there but doesn't check out, or if the downloaded file is a different version than promised. On a Tor-only box it asks only your own indexer, at the address in your settings, and first checks that the program answering there really is your indexer. If something else is sitting on that port, it stops, changes nothing, and tells you which program it is: start your indexer (`sudo systemctl start morphit-indexer`) and try again. Running the indexer without systemd? Put `MORPHIT_UPGRADE_TRUST_LOCAL_INDEXER=1` in front of the command. If an upgrade rolls back, it now also puts back the settings files it changed outside `/opt/morphit`. Note that the upgrade *to* a new version is run by the version you already have, so these protections start with the upgrade after v1.18.0. Details: `OPERATIONS.md`, "Upgrading".

**Your warrant canary.** A short signed note on your site (`/canary.txt`) that quietly says "I haven't been handed a secret order." If you ever stop refreshing it — gagged, seized, or worse — it goes stale on its own and readers take the hint. Set it up once:

```sh
bash scripts/canary/setup.sh
```

It offers to make you a signing key and then re-signs the canary weekly on its own. An upgrade clears the served folder, so the canary needs re-laying afterward — if you sign on the **same box**, the upgrade now does that for you; if you sign on a **separate laptop** (recommended for a VPS, so the key never sits on the server), it reminds you to run `bash ~/.morphit/update-canary.sh` once. Full reasoning: `OPERATIONS.md` §36.

**Helping the next node start fast.** Your instance keeps a pinned copy of the federation's indexer snapshot — a small (~600 kB) file that lets a brand-new node be useful in minutes instead of replaying the chain for days. It refreshes itself weekly and after every upgrade, and it serves over your web address, your `.onion` and your `.i2p` alike, so a newcomer running Tor-only can start up without ever touching the clearnet. There is nothing to set up and nothing to watch: it is automatic wherever IPFS hosting is on. You are not vouching for anything by mirroring — the newcomer checks the file against a fingerprint published on the blockchain, so a bad copy is caught by maths, not by trust. Detail: `OPERATIONS.md` §52.

**How a new node knows the snapshot is genuine (v1.18.0).** Two independent blockchain servers must agree on which snapshot is the newest, and it must carry `@morphit`'s signature. One dishonest server cannot pick it for you. The file can only contain data: the restore refuses anything that tries to run commands. If anything goes wrong, your database stays exactly as it was. Nothing personal travels in a snapshot: no push-notification subscriptions, no payout queue, no local moderation. Fast-sync needs a PostgreSQL client from August 2025 or newer. If yours is older, it says so, changes nothing, and asks you to update `postgresql-client`.

**Checking chat speed to another instance.** Chat between instances is meant to arrive in under six seconds, even over Tor or I2P. To see what your own connection to another instance really gives you, run this on your box, pointed at the other instance's `.onion` or `.b32.i2p` address:

```sh
bash /opt/morphit/ops/fastchat-latency-probe.sh http://<their-address>.onion
```

It sends nothing and changes nothing. Give it just the address, with nothing after it. It ends with `PASS`, `MOSTLY WITHIN` or `SLOWER THAN THE TARGET`, plus what to try on your box if it is slow. Ask the other operator to run it back towards you too, because the two directions can differ. It will not use the open internet unless you tell it to. Details: `OPERATIONS.md`, "Measuring real fast-chat latency to a peer".

**If someone floods fast chat.** Your instance only passes on chat messages it can check, and holds back any it cannot check until the blockchain accepts them. One account sending far too much only slows down its own messages. Everyone else stays fast. If someone floods using many different account names, some messages fall back to chain speed for a while. Nothing is lost and nothing fake is shown. There is nothing to set up. `/v1/health` counts these cases (`replayQuota`, `refusedLocally`, `dispatchedAfterChain`, `shed`). Details: `OPERATIONS.md`, "When someone floods fast chat".

**Tor-only box: what the upgrade tells you about the relay.** On a node that uses no clearnet, `morphit-ops upgrade` also moves the relay onto hidden services only, restarts it, and checks. You will see one of: "…hidden services only — checked", "the relay is not running now…", "…is still starting…" (over Tor the relay's first chain read can take a few minutes; the new setting is kept), "…still reports that it uses clearnet RPC…" (another settings file overrides it; the message says where to look) or "…was put back as it was…" (the relay kept crashing, so nothing was changed). The first three need nothing from you. For the last two, the message says what to look at. Details, and what to do if you ever roll back: `OPERATIONS.md`, "Existing nodes are fixed on upgrade".

**Lokinet.** Your node only looks up `.loki` names if you publish a Lokinet address or set `MORPHIT_INDEXER_LOKINET=on`. Without Lokinet running, those lookups would go to your internet provider's DNS. Nothing to do unless you run Lokinet.

**Tor-only box: nothing reaches the normal internet.** On a Tor-only node, `morphit-ops` now gets everything it needs from the chain through your own node, over Tor/I2P. That covers the "new version" note in the menu, the relay balance, and `register` and `payment-method`. Before, opening the menu or registering contacted public servers from your home connection. Registering over Tor can take a minute; a spinner shows while it works. Your IPFS node also stays off the public IPFS network. It still hands the release to other hidden nodes over your `.onion`, which is all they need to upgrade from you. The job that finishes an offline install checks for a connection over Tor/I2P only. Existing nodes get the IPFS part on their next `morphit-ops upgrade`, which restarts IPFS, checks it came back, and puts the old settings back if it did not. On every node, the IPFS program's usage reporting is now switched off. Nothing to set. Details: `OPERATIONS.md`, "Nothing on a tor-only node talks to clearnet".

**Matrix alerts on a Tor-only box.** The alert bot talks to its Matrix server over the normal internet (by default matrix.org). So if you switch alerts on, your node stops claiming "zero clearnet". That is now reported honestly; before, the claim stayed on anyway. If the claim matters more to you than the alerts, run `morphit-ops matrix clear`. Details: `OPERATIONS.md`, "Transport hardening in the final v1.18.0 review".

**Reading the chain only from your own blurtd.** If you empty both RPC lists and read only from a blurtd on the same box, the indexer now treats your node as hidden-only: it contacts no internet host except through Tor or I2P, and its log says `local_chain_only` at start-up. (Your blurtd itself still talks to other Blurt nodes as usual.) Nothing to do.

**Sign-up limits count real visitors (v1.18.0).** Your relay only allows a few new accounts per visitor per day, because each one costs you BLURT. Before v1.18.0 a visitor could get round that by typing a made-up address into one request header, so one person could look like thousands. Now the relay only believes addresses that your own web server or BunkerWeb wrote, never ones the visitor sent. For BunkerWeb boxes, `morphit-ops upgrade` also switches off one BunkerWeb setting (`USE_REAL_IP`) that believed that header from anyone, and checks that BunkerWeb really picked up the change. You don't need to do anything. If you put a CDN in front of BunkerWeb on purpose, keep `USE_REAL_IP=yes` and list only that CDN's addresses in `REAL_IP_FROM`. The upgrade leaves that alone. Everyone who comes in over Tor or I2P still shares one allowance, as before. Details: `OPERATIONS.md`, "Relay client IP (v1.18.0)".

**If an honest user gets flagged.** Morphit auto-flags accounts that review each other to inflate ratings, and honest people can occasionally trip it. To undo: `sudo morphit-ops` → **Moderation** → **Clear a flag**, name the accounts — instant, reversible, and instance-local. Details in `OPERATIONS.md`.

---

## 10. When something breaks

**"morphit-ops: command not found."** You're running it from the wrong place, or `npm install` hasn't finished. `cd` **inside the Morphit directory** (`cd ~/morphit`), confirm `npm install` completed, and retry.

**The site won't start.** Run `morphit-ops doctor` for a read-only config check — it tells you what's misconfigured before the services even try to boot. Then check the service logs with `journalctl -u morphit-indexer` (and `-u morphit-relay`).

**The indexer fell behind the chain.** Check `https://yourdomain.com/v1/health` and look at the `lag_blocks` field — a small number is normal; a large, growing one means the indexer is struggling (often an RPC or database hiccup). Restart it and watch `lag_blocks` come back down.

**Is the API even up?** Test it directly (note the `/v1/` path, which nginx routes to the indexer):

```sh
curl https://yourdomain.com/v1/health
```

A healthy response is JSON with a recent block number and a small lag, like `{"chain_head_block": 12345678, "lag_blocks": 15}`. If that works but the site doesn't, the problem is in the website/nginx layer, not the services.

## 11. Make it your own (optional — logo, name, colours, wording)

You're free to rebrand — many operators do, to make their instance feel local to their community.

**Logo, icons and your site's name — no rebuild, survives every upgrade.** This is the recommended way, and it keeps every file the integrity check looks at byte-for-byte on the signed release, so visitors never see the build-integrity (tamper) warning. Full guide: [`docs/BRANDING.md`](BRANDING.md).

Copy your SVG files to the server and run one command (use the full path to wherever you put them):

```sh
sudo morphit-ops branding apply --logo /home/you/my-logo.svg --logo-footer /home/you/my-wordmark.svg --icon /home/you/my-symbol.svg --name "Your Site"
```

- `--logo` — header (top-left) and homepage hero. Any aspect ratio: it is shown at the same **height** as the Morphit logo, never stretched.
- `--logo-footer` — the footer logo (optional; defaults to the `--logo` one).
- `--icon` — the favicon and the "add to home screen" app icons (a simple, roughly square symbol). The home-screen icons and iPhone/iPad launch screens are drawn from your files; if the server lacks the small converter for that (`librsvg2-bin`), the command offers to install it.
- `--name` — replaces "Morphit" wherever the site names **itself** ("Sign in to Your Site"), while mentions of the Morphit *software* and federation ("Run a Morphit node", "other Morphit instances") stay. Leave it out to keep "Morphit". A small "Runs on Morphit" line under your footer logo links to *About this instance*, so visitors can still tell what your site runs on.
- **Your directory name is separate.** The name other instances show for you in the directory is `MORPHIT_INSTANCE_NAME` (`sudo morphit-ops` → *Edit settings*). Keep the two the same unless you have a reason not to, so people who find you in the directory recognise the site they land on.

Prefer to be asked? `sudo morphit-ops branding setup` (or *Branding* in the `sudo morphit-ops` menu) asks for each file and the name. It is live on visitors' next page load; `sudo morphit-ops branding status` shows what's configured.

Every `morphit-ops upgrade` re-applies it automatically — set it up once. The red **BETA** marker over the logo turns off automatically once you supply your own `logo.svg` (`MORPHIT_INSTANCE_BETA_BADGE=on|off` to choose).

**Tagline and SEO title/description** are config values too: `sudo morphit-ops` → *Edit settings* → *Branding & SEO*.

**Colours, fonts, wording, layout — that's a fork.** Anything beyond the above means editing the source (`apps/web/`): colour tokens in the Tailwind/CSS config (brand emerald `#00DA69`), every visible string in `apps/web/src/lib/i18n/locales/*.json`, and page layout in the `.svelte` files (HTML-like markup with a little SvelteKit syntax — [svelte.dev/tutorial](https://svelte.dev/tutorial) covers it in a couple of hours; [VS Code](https://code.visualstudio.com/) + its "Svelte" extension helps). Two consequences to know up front: a rebuilt frontend is **no longer byte-identical to the signed release**, so your visitors' browsers show the build-integrity warning (that's by design — it's how users tell modified code from the signed release; a green check means the code is the signed release, not who runs the site — for that they check the address bar and *About this instance*), and `morphit-ops upgrade` installs the canonical frontend again, so you maintain your fork across releases yourself. Stuck? The Agorise Matrix room `#agorise:matrix.org` has people who've done it.

**One rule (the licence).** Morphit is AGPL-3.0-or-later. Cosmetic rebrands are fine and encouraged — the only requirement is that if you run a *modified* frontend as a public instance, you make your changed source available to your users (a footer link to your fork is enough). No secret closed-source forks. See the "Why does Morphit use the AGPL licence?" FAQ.

---

## 12. Going further (optional)

Two things you might do later. Both have full walkthroughs elsewhere, so here's just the gist:

**Switch between Tor-only and clearnet** (either direction, any time). Re-run the guided install — `sudo morphit-ops` → **Install / set up a new node** — and pick the other mode. It's non-destructive: your database, your keys, and your existing `.onion` are all kept, and your on-chain registration re-publishes with the new address for you. Full details: `docs/SWITCHING-NETWORKS.md`. (Just want to *add* a Tor/I2P/Lokinet address without switching your main mode? Use `sudo morphit-ops` → **Set up a Tor / Lokinet / I2P address**.)

**Wipe and reinstall, or move to a new host.** You can rebuild a node from scratch — or move it to a different provider — and come back to the same instance. Back up the three things a reinstall can't regenerate: your **account keys** (kept off the box), your **domain**, and a fresh **database dump** —

```sh
sudo systemctl start morphit-backup.service
```

— then copy the newest `.sql.gz` off the server. Reinstall like a fresh node, restore the dump, and the chain index rebuilds itself. For a canonical instance, rehearse on a throwaway box first. Full procedure: `OPERATIONS.md` and `docs/SWITCHING-NETWORKS.md`.

**Exporting a Tor/I2P key to a file.** `morphit-ops export-altnet-key --out=PATH` only ever creates a new file. If something is already at `PATH`, it writes nothing and tells you; delete the old file first. (That stops another user on the box from setting up the file in advance to read your key.)

## 13. Lock your domain against email spoofing (2 DNS records)

A Morphit node **sends no email** — signup is keys only, there's no mailbox anywhere in the stack. That's a security win you should claim explicitly: publish two DNS TXT records that tell the world your domain never sends mail, so nobody can forge a convincing `you@yourdomain` phishing message that sails past spam filters and damages your reputation. Without them, a domain with no policy is treated as neutral/permissive.

At your DNS provider, on the **apex** of the domain you gave the wizard, add:

| Type | Name/Host | Value |
|------|-----------|-------|
| TXT | `@` (the apex) | `v=spf1 -all` |
| TXT | `_dmarc` | `v=DMARC1; p=reject; aspf=s; adkim=s;` |

- `v=spf1 -all` is a **null-sender SPF**: "no server is authorized to send mail as this domain — reject it all."
- `p=reject` is a **strict DMARC** policy telling receivers to drop anything that fails.

Verify after the DNS propagates (a few minutes to an hour):

```sh
dig +short TXT yourdomain.tld            # expect: "v=spf1 -all"
dig +short TXT _dmarc.yourdomain.tld     # expect: "v=DMARC1; p=reject; ..."
```

**Only if you later add a real mailbox** on this domain (most operators won't) do you replace `v=spf1 -all` with one that lists your actual sender, e.g. `v=spf1 include:_spf.google.com -all`, and relax DMARC to `p=quarantine` while you test.

---

That's the whole job. Get a machine, point a name at it, run the installer, let the wizard configure it, register — and you're an operator in the federation. Welcome aboard.
