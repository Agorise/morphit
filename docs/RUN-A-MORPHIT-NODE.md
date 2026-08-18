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

- **A computer that stays on.** A cheap VPS, or an old desktop/laptop. Aim for **4 GB of RAM or more** and a recent **Ubuntu** (22.04 or 24.04). An old PC from a closet is genuinely fine.
- **A web address — or not.** A domain name (about US$10/year) from any registrar gives you a normal `https://` clearnet site. If you host at home, §3 covers the small bit of extra networking. **Or skip the domain entirely and run Tor-only** — the wizard offers this — and your marketplace is reachable at an auto-generated `.onion` address with no domain, no certificate, and no router port-forward (see the callout below).
- **A Blurt account** for your instance. Free to make; you'll create it in §5.
- **A password manager** to save a few secrets.

That's it. The wizard and the installer handle the fiddly parts.

> **Tor-only nodes (maximum privacy, zero paperwork).** When the wizard asks how people will reach your marketplace, you can choose **Tor-only** instead of a clearnet domain. The node then has **no clearnet reliance**: it's reachable over its auto-generated Tor `.onion` (and, when i2pd is installed, its `.i2p`/`.b32.i2p`), it appears in the federated `/instances` directory by that onion, and it skips the domain, the HTTPS certificate, the home port-forward, and dynamic DNS — so the wizard is a few questions shorter. It advertises the onion as its on-chain origin automatically. You can add a clearnet domain later (see `OPERATIONS.md`).
>
> *Notifications on a Tor-only node:* live chat and the in-tab "you have new messages" badge (the number in the browser tab and on the icon) work exactly as they do on a clearnet node — fast and fully anonymous, no setup. The only thing that does not work is browser *push* notifications when the tab is fully closed: those rely on Google/Mozilla push servers your users would never want an anonymous session touching, and browsers block them on `.onion`/`.i2p` anyway. So you lose nothing a privacy-first node would want. (Details: `OPERATIONS.md` §42.)

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

Name them after your instance or domain so they're easy to recognise. For example, if your instance is **Morphit NL** at `morphit.io`, you might use **@morphitnl-relay** and **@morphitnl-fees**, or **@morphitio-relay** and **@morphitio-fees**. Any Blurt signup works (for example [morphit.io/en/onboarding](https://morphit.io/en/onboarding)); keep all the keys in your password manager.

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

**Your warrant canary.** A short signed note on your site (`/canary.txt`) that quietly says "I haven't been handed a secret order." If you ever stop refreshing it — gagged, seized, or worse — it goes stale on its own and readers take the hint. Set it up once:

```sh
bash scripts/canary/setup.sh
```

It offers to make you a signing key and then re-signs the canary weekly on its own. An upgrade clears the served folder, so the canary needs re-laying afterward — if you sign on the **same box**, the upgrade now does that for you; if you sign on a **separate laptop** (recommended for a VPS, so the key never sits on the server), it reminds you to run `bash ~/.morphit/update-canary.sh` once. Full reasoning: `OPERATIONS.md` §36.

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

## 11. Make it your own (optional — logo, colours, wording)

You're free to rebrand completely — name, logo, colours, even every word on screen. Many operators do, to make their instance feel local to their community.

**The easy 90% — no programming.**

- **Logo / brand images** — drop your own SVG/PNG files into `apps/web/static/brand/`. If you can save a file, you can do this.
- **Colours / fonts** — a handful of named colour tokens in the Tailwind/CSS config (brand emerald `#00DA69`, teal `#027c86`). Change the values and the whole site follows. Plain CSS.
- **Text / wording** — every visible string lives in `apps/web/src/lib/i18n/locales/` (`en.json`, one file per language) as simple `"key": "value"` pairs. Edit the values, keep the keys.

**The other 10% — layout.** Moving things around means editing the page files (`.svelte`) — HTML-like markup with a little framework syntax (SvelteKit). If you know HTML and CSS most of it transfers; the [svelte.dev/tutorial](https://svelte.dev/tutorial) is a couple of hours and covers what you'd hit. Install [VS Code](https://code.visualstudio.com/) + its "Svelte" extension + [Node.js](https://nodejs.org/) LTS, then from `apps/web/` run `npm install` once and `npm run dev` to preview live at `http://localhost:5173` (it reloads as you save). `npm run build` then `sudo morphit-ops upgrade` ships it. Stuck? The Agorise Matrix room `#agorise:matrix.org` has people who've done it.

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

---

That's the whole job. Get a machine, point a name at it, run the installer, let the wizard configure it, register — and you're an operator in the federation. Welcome aboard.
