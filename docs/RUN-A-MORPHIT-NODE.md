# How to Run Your Own Morphit Node

**Audience:** A smart, motivated person who's never set up a server before. You know how to use a computer. You can copy and paste. You're willing to read instructions carefully. You've probably never typed `ssh` in your life.

**Companion to:** `OPERATIONS.md`. That document is the reference manual for an experienced operator handling alerts at 2 a.m. **This document is the friendly walkthrough that gets you from zero to a running Morphit instance.** When you're done with this guide, you'll know enough to read OPERATIONS.md when something goes wrong.

**Honest expectation-setting:** running your own Morphit instance is not as hard as building a rocket, but it's not as easy as installing an app on your phone. Plan two evenings. The first evening you'll set up the server and install things. The second evening you'll troubleshoot whatever didn't work the first time, because something always doesn't.

The Agorise team is four people, none of whom are full-time tech support. **If you get stuck, the friendliest place to ask for help is the Matrix channel** at `#agorise:matrix.org`. Other operators hang out there and are usually willing to walk newcomers through tricky bits. It's not a 24/7 helpdesk — it's a community.

Before we start, three things to know:

1. **Nothing in this guide is irreversible until step 6 (creating Blurt accounts) and step 9 (registering as an operator).** Everything before that is just "set up a server" — you can wipe it and start over with no on-chain consequence. Be more careful in steps 6 and 9 because Blurt account names are permanent and the operator-tag claim is too.

2. **Morphit is open source under the AGPL-3.0 license.** That means you can run it, change it, share it, charge for it. The only catch: if you run a modified version, you have to share your modifications publicly. Fair trade.

3. **You are not building a business that needs to scale to millions of users.** A Morphit instance for a community of a few hundred active traders runs comfortably on a $5/month VPS or a Raspberry Pi 4 you have lying around. Don't over-provision; don't pay for "production-grade" infrastructure you don't need.

Let's go.

---

## Table of contents

1. [What you're building](#1-what-youre-building)
2. [What you'll need](#2-what-youll-need)
3. [Pick your hosting option](#3-pick-your-hosting-option)
3a. [Hosting at home — the soup-to-nuts walkthrough](#3a-hosting-at-home--the-soup-to-nuts-walkthrough)
4. [Get a domain name](#4-get-a-domain-name)
5. [Provision the server (the part where SSH happens)](#5-provision-the-server-the-part-where-ssh-happens)
6. [Create your Blurt accounts](#6-create-your-blurt-accounts)
7. [Install Morphit](#7-install-morphit)
8. [First-time configuration](#8-first-time-configuration)
9. [Register as an operator (this is where you start earning)](#9-register-as-an-operator)
10. [Backups — do this before anything bad happens](#10-backups)
11. [Recommended hardening (optional but encouraged)](#11-recommended-hardening-optional-but-encouraged)
12. [What to do when things break](#12-what-to-do-when-things-break)
13. [Where to go from here](#13-where-to-go-from-here)
14. [Running a second instance — DO NOT share relay accounts](#14-running-a-second-instance--do-not-share-relay-accounts)

---

## 1. What you're building

A "Morphit node" is three pieces of software running on one server:

- **The indexer.** Reads the Blurt blockchain and remembers every Morphit-related thing that happens (orders posted, feedback left, chat messages). Serves that data to the web app.
- **The relay.** Helps your users do things on the Blurt blockchain by spending the tiny "stamp fee" (Blurt calls this **Mana** — you may see it called "Resource Credits" or "RC" in older Blurt docs; think postage stamps) on their behalf. This is what lets users sign up without owning any BLURT first.
- **The web app.** The thing that runs in your users' browsers when they visit your site. Same code as morphit.io.

All three live on one server. They talk to each other locally, and to the public Blurt blockchain over the internet.

Visually:

```
   [Your users' browsers]
            ↓
       [The internet]
            ↓
    ┌───────────────────┐
    │   Your server     │
    │                   │
    │  ┌─────────────┐  │
    │  │  Web app    │  │  ← what users see
    │  └──────┬──────┘  │
    │         │         │
    │  ┌──────▼──────┐  │
    │  │  Indexer    │  │  ← reads the blockchain
    │  └──────┬──────┘  │
    │         │         │
    │  ┌──────▼──────┐  │
    │  │  Relay      │  │  ← pays for stamps
    │  └──────┬──────┘  │
    │         │         │
    └─────────┼─────────┘
              ↓
       [Blurt blockchain]
       (a public network of
        thousands of computers
        worldwide — neither
        you nor anyone else
        owns it)
```

That's the whole picture. Everything else in this guide is detail.

---

## 2. What you'll need

Before you start, gather:

- **A computer to do the setup from.** Mac, Windows, or Linux all work. You'll mostly use a terminal (the black-screen-with-text app). You don't need to know terminal commands — this guide will give you the exact commands to copy-paste.
- **Money for hosting.** This is the one decision you make first, in §3 below. Roughly $5–10/month for a rented VPS, OR a one-time $0 if you have a Raspberry Pi or old laptop sitting around (electricity is a few dollars a year — about as much as a phone charger). Either way, plan on $10–15/year for a domain name. If you'd rather not use a credit card, several hosting providers and domain registrars accept Monero or Bitcoin (we'll point you at them in §3 and §4).
- **An hour for the first session, two hours for the second.** Most things take 5 minutes. A few things take 30 minutes because you have to wait for something to download or DNS to update. **If you're hosting at home, add another hour** for the home-internet setup (§3a) — that's a one-time thing.
- **Patience.** Especially with DNS. DNS is the system that maps domain names like "myinstance.com" to server addresses, and **it can take up to an hour for changes to propagate worldwide**. Wait it out — almost every "this is broken" feeling during setup is actually "DNS hasn't caught up yet."

That's it. You don't need:

- A Linux laptop. Your existing computer is fine.
- Programming experience. We'll never ask you to write code.
- Sysadmin experience. The longest command in this guide is one line, and you'll copy-paste it.
- A static IP address. If you go the VPS route, the VPS already has its own. If you host at home, **§3a covers the workaround for the dynamic IP your home internet gives you** — it's free and the setup takes 10 minutes.

---

## 3. Pick your hosting option

You have three reasonable choices. Pick whichever matches your wallet and your patience.

### Option A: A cheap VPS (recommended for most people)

A VPS ("Virtual Private Server") is a small computer that lives in a datacenter somewhere, that you rent by the month and access remotely. It's the path of least resistance — you don't need any hardware at home, you don't need to deal with home-internet quirks, and the provider handles the boring stuff (electricity, networking, hardware failures).

**Recommended providers** (alphabetical, all known to be reasonable for Morphit):

- **Hetzner** (hetzner.com) — Germany. Excellent value, $5–6/month for a server that's plenty for Morphit. Pays in EUR.
- **Mullvad** (mullvad.net) — Sweden. Privacy-respecting (they accept cash by mail!). Slightly more expensive but worth it if privacy matters to you.
- **NJALLA** (njal.la) — Sweden. Privacy-focused. Accepts Monero and Bitcoin. Anonymous registration possible.
- **Vultr** (vultr.com) — USA. Cheap, many datacenters worldwide, reliable. Accepts crypto.
- **OVH** (ovhcloud.com) — France. Cheap, big provider, less privacy-friendly than the others but very stable.

**What to order:** the smallest "shared CPU" instance that has 2 GB of RAM and 20 GB of disk. That's all you need. The provider's website will list it as something like "Cloud Server 1" or "Cloud Compute 1GB" — pick the second-smallest tier (the smallest is usually only 1 GB RAM, which works but is tight). Spend the extra dollar.

**Operating system:** **Ubuntu 24.04 LTS** is the recommended, best-tested choice. The Morphit Ansible playbook (at `ops/ansible/playbook.yml`, invoked via `ansible-playbook -i inventory/hosts.yml playbook.yml --ask-vault-pass` — see §13 below) now accepts **any Ubuntu-24.04-based system**: Ubuntu 24.04 itself, OR a derivative built on it — **Linux Mint 22** (any edition: Cinnamon, MATE, or Xfce — the desktop environment doesn't matter for a server), Pop!_OS 24.04, Zorin OS 17, KDE neon, elementary OS 8, etc. It detects this from the Ubuntu base codename (`noble`) in `/etc/os-release`, so the apt repos it adds (Docker, Trivy) resolve correctly even on a derivative. It still **hard-fails** on anything NOT built on the 24.04 base — Debian, LMDE (Debian-based), Ubuntu 22.04 / Linux Mint 21 (the older "jammy" base), and non-Ubuntu distros — because package names and config paths differ there.

**Prefer a leaner or more hardened base?** **Debian 12+** and security-hardened Debian distributions like **Kicksecure** (a reconfigured Debian that ships hardened defaults — an excellent lightweight, privacy-focused server) are fully supported — just not by the one-command playbook. Install the prerequisites yourself (Node.js 22+, PostgreSQL 15+) and run `morphit-ops install` (the guided setup wizard): its pre-flight system check recognizes these bases and green-lights the OS as a supported Debian-family server. The playbook's `noble` gate is only about *its* apt-repo automation, not a Morphit limitation — the services themselves are plain Node + Postgres and run on any modern Linux. If you specifically want the one-command playbook on a non-`noble` base, you'd need to fork it. **Don't pick anything labeled "minimal" or "container"** — those skip parts you'll need.

**SSH key vs password:** the provider will ask whether you want to log in with a password or with an "SSH key". **Pick SSH key.** It's safer and easier. We'll cover how to make one in step 5. If you're feeling intimidated by the SSH key step, you can use a password to start and switch later, but plan to do that switch within a week.

Order it. The server is yours within a minute or two. Save the IP address it gives you — you'll need it in step 4.

### Option B: A Raspberry Pi at home

If you have a Raspberry Pi 4 or 5 sitting around with at least 4 GB of RAM, you can host Morphit on it. Pros: no monthly bill, your data stays in your house, satisfying. Cons: you need to deal with home-internet stuff — your internet provider needs to allow incoming connections (most do, but some "carrier-grade NAT" setups don't), you need a free dynamic-DNS service to handle your home IP changing periodically, and your Pi needs to stay on 24/7.

**If you pick this option, finish reading §3, then go do §3a (the home-hosting setup).** Section 3a walks you through every home-internet quirk — checking that your ISP allows incoming connections, signing up for a free dynamic-DNS hostname, setting up your router's port forwarding, and making the Pi survive power blips. After §3a is done, come back here and skip ahead to §5 (you don't need to "rent a server" — your Pi IS the server).

For your **first** Morphit instance, the VPS path (Option A) is smoother because someone else handles the networking. **You can always migrate to a Pi later** — Morphit stores everything on the public Blurt blockchain, so moving the indexer to a different machine is just "set up the new one, point your domain at it, decommission the old one." There's no user data to migrate; it's all on the blockchain.

### Option C: An old laptop

Functionally identical to the Pi option. **If you have a laptop from the last decade with a working hard drive and a working ethernet jack, it can run Morphit.** Plug it into ethernet (don't run on WiFi for a server), close the lid (we'll show you how to configure it not to sleep when the lid closes), put it on a shelf. Same caveats as the Pi about home internet.

A 10-year-old laptop with 4 GB of RAM is more than enough. A 15-year-old one with 2 GB might work if you're patient. The CPU doesn't matter much — Morphit isn't compute-heavy. The disk does matter; if your laptop has a spinning hard drive (HDD) instead of an SSD, the database will be noticeably slower but still works.

**If you pick this option, finish reading §3, then go do §3a (the home-hosting setup) plus §3a's "lid-closed laptop config" subsection.** After that, come back and skip ahead to §5.

---

## 3a. Hosting at home — the soup-to-nuts walkthrough

**Skip this section if you picked Option A (VPS) in §3.** This section is for people hosting at home — it covers everything between "I have a Pi or a laptop" and "I'm ready to start §5 (Provision the server)."

You're going to do six things in this section, in order:

1. **Check that your home internet can actually receive connections.** (Some ISPs put you behind something called "CGNAT" that blocks this. Quick test, no commitment.)
2. **Sign up for a free dynamic-DNS hostname.** (DuckDNS — five minutes.)
3. **Give your home machine a fixed IP on your home network.** (So your router always sends Morphit traffic to it.)
4. **Configure your home router to forward incoming web traffic to your machine.** (One-time, in your router's admin page.)
5. **Make your home machine survive power blips and (for laptops) survive lid-closing.** (UPS recommendation, sleep settings.)
6. **Verify the whole thing from outside your house** before moving on to §4.

The whole section takes about an hour the first time. You won't ever do most of these steps again — once your DDNS hostname is registered and your router is forwarding correctly, the only ongoing maintenance is paying your electric bill.

> **A note about home electricity:** A Raspberry Pi 4 sips about 5 watts. An old laptop running a server runs about 15–25 watts. At US average rates ($0.16/kWh in 2026), that's **roughly $7/year for the Pi and $25/year for the laptop**. Cheaper than a VPS. If your power is more expensive (Germany, UK, Australia), expect $15/year for the Pi and $50/year for the laptop. Still cheaper than a VPS.

### 3a.1. Is your home internet viable? (the CGNAT check)

This is the first thing to check, because if your ISP has put you behind something called **CGNAT** (Carrier-Grade NAT), home hosting is going to be very hard and you should switch to Option A (VPS) instead.

**What CGNAT is, in 30 seconds:** Normally, your home internet has one public IP address visible to the rest of the world. Your router uses that IP to send traffic out, and people on the internet can send traffic back to it. CGNAT means your ISP shares one public IP among many customers, and your router can't receive incoming connections — only outgoing ones. The internet still works for browsing and email and Netflix, but **you can't run a server** because nobody outside your house can reach it.

This is most common with mobile-internet providers (T-Mobile Home Internet, Verizon 5G Home), some rural fiber rollouts, and some cable ISPs in apartment buildings. It's rare on traditional cable or DSL.

**Quick check** — do this from any computer on your home network:

1. Visit https://www.whatismyip.com on the computer you're going to run Morphit on. Note the IP address it shows you. Call this **IP-A**.
2. Now log into your home router's admin page. (If you don't know how — see §3a.4 below; come back here when you've found it.) Look for a status page that shows "WAN IP" or "Internet IP" or "Public IP". Note that address. Call this **IP-B**.
3. **Compare them.** If `IP-A == IP-B`, you're fine — you have a real public IP and you can host. Skip ahead to §3a.2. If `IP-A != IP-B` (or `IP-A` is in the range `100.64.x.x` through `100.127.x.x`, which is the special CGNAT range), your ISP has CGNATed you.

If you're CGNATed, you have three choices:

- **Switch to Option A (VPS).** Easiest — go back to §3 and pick a $5/month VPS. The rest of this guide just works.
- **Call your ISP and ask for a public IPv4 address.** Some ISPs offer this for free, others charge $5–10/month. Worth asking. Use the words "public IPv4 address, not a CGNAT-shared one" and they'll usually understand.
- **Use a relay tunnel like Cloudflare Tunnel or Tailscale Funnel.** This is a more advanced workaround that lets a CGNATed machine accept incoming connections by tunneling through a third-party service. Cloudflare Tunnel is free; Tailscale Funnel is free for personal use. Setting either up is a 30-minute extra step we don't cover in this guide; if you want to go this route, search "Cloudflare Tunnel for self-hosting" or "Tailscale Funnel" and follow their docs. For Morphit specifically, you forward port 443 of your tunnel to `127.0.0.1:443` on the local machine.

If you're NOT CGNATed, congratulations — you can host at home. Continue.

### 3a.2. Get a free dynamic-DNS hostname (DuckDNS)

Your home internet's public IP changes every now and then (when your modem reboots, when your ISP's DHCP lease renews, sometimes every few days). That's a problem because your domain name (which we'll set up in §4) needs to always point at your current IP. **Dynamic DNS** is the workaround: you get a hostname like `myinstance.duckdns.org` that automatically updates whenever your IP changes.

We recommend **DuckDNS** because it's free, no-frills, has been running for 12+ years, and accepts anonymous signup. Two alternatives: **Dynu** (also free, slightly fancier UI) and **No-IP** (free but pesters you to confirm your hostname every 30 days, which you'll forget and your site will go down — we don't recommend No-IP for that reason).

**DuckDNS signup:**

1. Go to **https://www.duckdns.org**.
2. Sign in with one of the four "Sign in with..." options (GitHub, Twitter, Reddit, Google). DuckDNS doesn't have its own accounts — it just uses one of these to identify you. Pick whichever you have. **GitHub is the most privacy-respecting** of the four because it doesn't sell ad data. If you don't want any of these, skip to Dynu (below).
3. After signing in, you'll see a page with a **token** at the top (a long hex string) and a "domains" box where you type the hostname you want. Pick something — let's say `myinstance` — and click "add domain". You now own `myinstance.duckdns.org`.
4. **Copy the token** somewhere safe (a password manager, or a text file on your local computer). You'll need it in step 5 below.
5. **Test that it works:** in the page's "current ip" box, click "update ip". After a few seconds, on your local computer, run:
   ```
   nslookup myinstance.duckdns.org
   ```
   You should see your home's public IP (the IP-A from §3a.1). If you do, DuckDNS is working.

**Dynu alternative** (in case you don't want to use one of DuckDNS's sign-in providers):

1. Go to **https://www.dynu.com** and create a free account (email + password — they don't require phone verification or real name).
2. Once logged in, go to "DDNS Services" → "Add". Pick a hostname (`myinstance.dynu.net` or similar). Save.
3. Go to "Control Panel" → "API Credentials" and note your username + password (Dynu uses these instead of a token). You'll use them in step 5 below.

The next steps in §3a.5 work the same regardless of whether you picked DuckDNS or Dynu.

### 3a.3. Give your home machine a fixed IP on your home network

Your router hands out IP addresses to every device in your house using something called **DHCP** (a "lease" system — your router says "you're 192.168.1.47 for the next 24 hours; ask again later"). By default, your machine's IP can change every few days. That's bad for a server because **port forwarding (next step) sends traffic to a specific IP** — if your Pi's IP changes from 192.168.1.47 to 192.168.1.62, the port forward will start sending traffic to whichever device happens to be at 192.168.1.47 now. Your Morphit will go offline.

The fix is called a **DHCP reservation**: you tell the router "always give THIS device THIS IP." It's a single setting in your router's admin page.

**Find your machine's MAC address first** (the hardware ID of its ethernet card):

On the Pi or laptop you're going to run Morphit on, plug it into ethernet, then run:

```
ip link show eth0
```

(On older systems it might be `ifconfig eth0` instead.) Look for a line like `link/ether 28:cd:c1:01:a2:b3`. That hex string is your MAC address. Copy it down.

**Now set the reservation in your router:**

1. Open your router's admin page in a browser. Common URLs: `http://192.168.1.1`, `http://192.168.0.1`, `http://10.0.0.1`. If none of those work, on a computer connected to your home network run `ip route | grep default` (Linux/Mac) or `ipconfig` (Windows, look for "Default Gateway") — that's the address.
2. Log in. Default username/password is on a sticker on the router itself (often `admin`/`admin` or `admin`/`password`). **If you've never logged into your router before, the password is probably the default — change it after this session is done.**
3. Look for a section called **"DHCP"**, **"DHCP Reservations"**, **"Address Reservation"**, or **"LAN settings"**. Different brands hide it in different places — search the admin page for the word "reservation" or "DHCP". On many TP-Link / Asus / Netgear routers it's under "Advanced" → "Network" → "LAN".
4. Add a new reservation:
   - **MAC address:** the one you copied (e.g. `28:cd:c1:01:a2:b3`)
   - **IP address:** pick something near the top of your router's range that isn't in active use. `192.168.1.50` is a good default.
   - **Name** (some routers): "Morphit" — just for your own reference.
5. Save. Reboot the Pi/laptop. Run `ip addr show eth0` and confirm the new IP took effect.

From now on, **your Morphit machine will always be at the IP you reserved** (e.g. 192.168.1.50) — the rest of this guide assumes this.

> **One word for IPv6 users:** if your home is IPv6-only (rare but increasing), the DHCP-reservation step is replaced by "configure your machine with a static IPv6 address from your /64 prefix" — see your router's IPv6 configuration page. The rest of §3a still works; everywhere we say "your machine's LAN IP" below, substitute the IPv6 address.

### 3a.4. Configure router port forwarding

Now tell your router: "When traffic from the internet arrives on port 80 (HTTP) or port 443 (HTTPS), send it to my Morphit machine at 192.168.1.50."

1. Still in your router's admin page, look for **"Port Forwarding"**, **"Virtual Servers"**, **"NAT Forwarding"**, or **"Port Mapping"**. On TP-Link routers it's under "Advanced" → "NAT Forwarding" → "Virtual Servers". On ASUS routers: "WAN" → "Virtual Server / Port Forwarding". On Netgear: "Advanced" → "Advanced Setup" → "Port Forwarding". On a stock Verizon Fios router: "Firewall" → "Port Forwarding".
2. Add **two** rules — one for HTTP (port 80) and one for HTTPS (port 443). Different routers ask for different fields, but the values are always the same:

   | Service / Name | External (WAN) Port | Internal (LAN) IP | Internal (LAN) Port | Protocol |
   |---|---|---|---|---|
   | Morphit-HTTP  | 80  | 192.168.1.50 (yours) | 80  | TCP |
   | Morphit-HTTPS | 443 | 192.168.1.50 (yours) | 443 | TCP |

3. Save. Reboot the router (most don't need this, but it doesn't hurt — and it confirms the rules persist).

**Test the port forward** — from a phone on cellular data (NOT on your home WiFi), or any computer outside your house, try:

```
nc -vz <your-public-IP> 80
```

(Where `<your-public-IP>` is what `whatismyip.com` showed you in §3a.1.) You should get `Connection succeeded`. If you get `Connection refused` or `Connection timed out`, the port forward isn't working — go back to your router's admin page and double-check the rule. Common gotchas: typoed the LAN IP, the rule was saved as "disabled", or your ISP blocks inbound port 80 entirely (some do; see below).

> **Some ISPs block ports 80 / 443 / 25 even without CGNAT.** This is most common with US residential Comcast, Spectrum, and AT&T accounts that are explicitly residential-tier (the same ISPs offer "business" tiers that don't block, for $20–50/month more). If port 80 is blocked but port 443 isn't, you can run Morphit on 443 only — but Let's Encrypt's auto-renewal won't work without port 80, so you'd need to use the DNS-01 challenge instead (a more advanced setup we cover in §3a.6 below). If both 80 and 443 are blocked, switch to a VPS or use a tunnel service (Cloudflare Tunnel — see §3a.1).

### 3a.5. Auto-update your DDNS hostname

Now that DuckDNS knows your current IP and your router is forwarding traffic correctly, set up the **automatic update** so DuckDNS always knows your CURRENT IP — even when your ISP changes it next week.

We'll install a tiny update script on your Morphit machine that runs every 5 minutes via cron.

**For DuckDNS:**

```
sudo mkdir -p /etc/duckdns
sudo nano /etc/duckdns/update.sh
```

Paste this in (replacing the two placeholders):

```sh
#!/bin/sh
# Updates the DuckDNS record with this machine's current public IP.
# Runs every 5 min via cron (see /etc/cron.d/duckdns).
#
# Token is per-account; copy it from https://www.duckdns.org after
# signing in.  Hostname is the subdomain you registered (e.g.
# "myinstance" if your full hostname is myinstance.duckdns.org).

DUCKDNS_DOMAIN="myinstance"            # ← change to your subdomain
DUCKDNS_TOKEN="00000000-0000-0000-0000-000000000000"   # ← change to your token

curl -sS -o /var/log/duckdns.log \
  "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip="
```

Save. Then:

```
sudo chmod 0700 /etc/duckdns/update.sh
sudo /etc/duckdns/update.sh
cat /var/log/duckdns.log
```

The log should show `OK`. (If it shows `KO`, your token or hostname is wrong — re-check both against the DuckDNS web page.)

Now schedule it to run every 5 minutes:

```
sudo nano /etc/cron.d/duckdns
```

Paste:

```
*/5 * * * * root /etc/duckdns/update.sh >/dev/null 2>&1
```

Save. Cron will pick this up automatically — no service to restart.

**For Dynu** (alternative DDNS provider): the equivalent script is:

```sh
#!/bin/sh
DYNU_USER="yourdynuusername"
DYNU_PASS="yourdynupassword"
DYNU_HOSTNAME="myinstance.dynu.net"

curl -sS -o /var/log/dynu.log -u "${DYNU_USER}:${DYNU_PASS}" \
  "https://api.dynu.com/nic/update?hostname=${DYNU_HOSTNAME}"
```

Same install steps — `chmod 0700`, run once, check the log shows `good` or `nochg`, schedule via `/etc/cron.d/dynu`.

**Verify everything's wired up:**

```
nslookup myinstance.duckdns.org
```

(Or your Dynu hostname.) From any computer in the world, this should resolve to your home's current public IP. **You're now reachable from the internet at a stable hostname.**

### 3a.6. Survive power blips and lid-closing

Your home machine doesn't have a datacenter's redundant power and cooling. Two small investments make it survive the small failures:

**A small UPS (Uninterruptible Power Supply).** A $50 UPS with 600VA capacity runs a Pi or a laptop for 1–4 hours during a power outage. The point isn't to keep running through a multi-hour blackout — it's to **gracefully ride out the 30-second flickers and 2-minute outages that happen every few months in most places**. APC, CyberPower, and Eaton all make small UPSs in this range. Plug the modem, the router, AND your Morphit machine into it.

If you want to go further: configure your machine to **shut down cleanly when the UPS battery gets low** (so a long outage doesn't corrupt the database). On Ubuntu/Debian:

```
sudo apt install -y nut nut-server nut-client
```

Then follow your UPS model's NUT config (search "NUT config <your UPS model>"). For most home-grade UPSes, the USB cable from the UPS to your machine plus NUT's `usbhid-ups` driver does it automatically.

**Configure your laptop to NOT sleep when the lid closes.** This is the single most common gotcha for people running Morphit on a laptop — they close the lid, the laptop sleeps, and Morphit goes offline.

On Ubuntu/Debian (which is what this guide uses), edit the systemd-logind config:

```
sudo nano /etc/systemd/logind.conf
```

Find these lines (they're commented out by default with `#`):

```
#HandleLidSwitch=suspend
#HandleLidSwitchExternalPower=suspend
#HandleLidSwitchDocked=ignore
```

Change them to:

```
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
```

Save. Apply the change:

```
sudo systemctl restart systemd-logind
```

Now close the lid and run a `ssh morphit@192.168.1.50` from another computer — your laptop should still be reachable.

**Configure auto-boot when power returns** (in case your UPS does run out and the power comes back):

- **On a laptop**, this is in the BIOS/UEFI. Reboot the laptop, hammer F2 / F12 / Del at boot to enter BIOS, look for "AC Power Recovery" or "After Power Failure" — set it to "Power On" or "Last State". Save and exit.
- **On a Raspberry Pi 4 or 5**, edit `/boot/config.txt` (or `/boot/firmware/config.txt` on newer Pi OS) and add: `boot_delay=1`. The Pi auto-boots when power returns by default; this just adds a small delay so the network has time to come up.

**Test the whole thing:** unplug the wall power. Wait 30 seconds. Plug it back in. Confirm Morphit comes back online (you can SSH in within 90 seconds, and `https://yourdomain.com` is reachable within 2–3 minutes once nginx is running).

### 3a.7. Verify from outside the house

Before moving on to §4, verify the whole chain from outside your home network. **Use your phone on cellular data (turn WiFi OFF on your phone)** — that simulates "the rest of the internet."

```
# 1. Does your DDNS hostname resolve to your home's public IP?
nslookup myinstance.duckdns.org

# 2. Can the phone reach port 80 on your home machine?
nc -vz myinstance.duckdns.org 80

# 3. Same for port 443.
nc -vz myinstance.duckdns.org 443
```

You can run these from your phone using the **Termux** app (free on F-Droid for Android) or from any laptop tethered to your phone's hotspot. If `nc` isn't installed, `curl -v http://myinstance.duckdns.org` works as an alternative test.

**All three should succeed.** If any fail, fix that step before going on:

- **DDNS doesn't resolve:** the cron job hasn't run, or the script's token is wrong. Check `cat /var/log/duckdns.log` on the Morphit machine.
- **Port 80 fails but 443 works (or vice versa):** the router's port-forward rule for that port wasn't saved correctly. Re-check §3a.4.
- **Both ports fail:** your ISP is blocking inbound 80/443 (some residential ISPs do). Either upgrade to a business-tier connection, switch to a VPS (Option A), or use Cloudflare Tunnel (mentioned in §3a.1).

When all three checks pass, you're done with §3a. Skip ahead to §4 (Get a domain name) — and make sure to pick the **DDNS-CNAME** path in §4 instead of the A-record path.

---

## 4. Get a domain name

Your Morphit instance needs a domain name — something like `mymorphit.com` or `tradehouse.org`. Users will type this into their browser to reach you.

### Pick a name

A few thoughts on choosing a good one:

- **Short and rememberable** beats clever. "swap.fi" is better than "best-p2p-crypto-trades.network".
- **Don't use "morphit" in the name.** That's our brand and it would mislead users into thinking your instance is the canonical one.
- **Avoid words that sound like banks or exchanges** ("coinbase-clone.com" is just inviting Apple's lawyers to a party). Stick to neutral or community-y names.
- **A `.com` is fine but expensive.** `.net`, `.org`, `.io`, `.fi`, `.world`, `.cc`, `.so` are all reasonable. `.crypto` and similar "crypto-themed" TLDs work but are expensive.

### Register the domain

**Recommended registrars:**

- **Njalla** (njal.la) — privacy-respecting, accepts Monero. The domain is technically registered to Njalla and they "lend" it to you, which is the strongest privacy posture available. Costs about $20/year.
- **Porkbun** (porkbun.com) — cheap, USA-based, decent privacy by default.
- **Namecheap** (namecheap.com) — cheap, USA-based, lots of TLDs. Less privacy-respecting than Njalla but the free WHOIS-privacy add-on is fine.

Avoid **GoDaddy** (they have a long history of pulling domains for sketchy reasons) and **Google Domains / Squarespace Domains** (Google has shown willingness to drop domains tied to any kind of cryptocurrency).

When the registrar asks for your contact info, **enable "WHOIS privacy" or "domain privacy"**. This is free with most registrars now and means your home address isn't published to the internet.

### Point the domain at your server

This is the step where DNS gets involved. **Pick the path that matches the hosting option you chose in §3.**

#### Path A — VPS (Option A from §3)

In your registrar's dashboard, find "DNS" or "DNS records" or "manage nameservers". You'll see a list of records (probably empty or with placeholder entries). You need to add **two records**:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `@` | (the IP address of your VPS from §3) | 300 |
| A | `www` | (the same IP address) | 300 |

The `@` is registrar-speak for "the bare domain itself" (`mymorphit.com`). The `www` covers people who type `www.mymorphit.com`. The `300` is the "time to live" — how long your record is cached. 300 means 5 minutes; that's fine for setup. After things are working, you can raise it to 3600 (1 hour) or 86400 (1 day).

#### Path B — Home hosting (Option B or C from §3, with §3a's DDNS already set up)

Your home IP changes periodically, so we use a **CNAME** record (which says "this domain points at THAT hostname") instead of an A record (which would point at a specific IP). The CNAME points at your DuckDNS / Dynu hostname from §3a.2, and the DDNS update script (from §3a.5) keeps that hostname's IP fresh.

Add **two records**:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| CNAME | `@` | `myinstance.duckdns.org.` (yours, with trailing dot) | 300 |
| CNAME | `www` | `myinstance.duckdns.org.` (same) | 300 |

**The trailing dot matters** — it tells the DNS system "this is a fully qualified hostname, not a subdomain of mine." Most registrars add the dot for you if you forget; some don't. Check the saved record after you save it.

Some registrars don't allow CNAME on the bare `@` apex (this is a long-standing DNS quirk). If yours doesn't, two workarounds:

- **Use an A record at `@` pointing to your home's current IP**, and add an `ALIAS` or `ANAME` record (registrar-specific) at `@` pointing at your DuckDNS hostname. Cloudflare, DNSimple, and Hover support ALIAS / ANAME; Namecheap and Porkbun call theirs "ALIAS Record"; Njalla calls it "Dynamic" record.
- **Or just use a subdomain like `www.mymorphit.com`** as your primary URL, where CNAME-on-subdomain always works, and put a redirect from `mymorphit.com` to `www.mymorphit.com` once nginx is running (we'll show you how in §8).

The advantage of Path B: when your home IP changes, you don't have to do anything. The DDNS update script (§3a.5) updates DuckDNS, and your domain's CNAME just keeps following it.

#### After saving (both paths)

**Save the records and wait.** Sometimes propagation is instant. Sometimes it takes 30 minutes. Almost never longer than an hour. While you wait, do step 5.

To check whether DNS has propagated, on your local computer run:

```
nslookup mymorphit.com
```

(Replace `mymorphit.com` with your actual domain.) You should see your VPS's IP address (Path A) or your home's current public IP (Path B). If you see "Non-existent domain" or a different IP, wait longer.

---

## 5. Provision the server (the part where SSH happens)

This is the longest section and contains the only steps that might feel scary if you've never done this before. **Don't worry — every command is copy-paste, and we explain what each one does.**

> **Optional fast-path for impatient operators:** the manual steps below (SSH key setup, firewall, non-root user, fail2ban, unattended-upgrades) are also bundled into a single script at `scripts/vps-bootstrap.sh`. After you've SSHed into the server for the first time as root, you can `git clone https://git.agorise.net/agorise/morphit.git ~/morphit && sudo bash ~/morphit/scripts/vps-bootstrap.sh` and skip ahead to "Install Node.js and PostgreSQL." We recommend the manual walkthrough first time — you'll learn the moving parts, and Sally-operator (Part 119 walkthrough) confirmed the manual steps remain easy to follow. Use the script for your second instance.

### Make an SSH key on your local computer

An SSH key is two files: a "public key" (which you give to the server) and a "private key" (which stays on your computer and is the proof that you're you). Together they replace passwords for logging in.

**On Mac or Linux:** open the Terminal app and type:

```
ssh-keygen -t ed25519 -C "your-email@example.com"
```

Replace the email with anything — it's just a label. When it asks "where to save the key", press Enter (accept the default location, which is `~/.ssh/id_ed25519`). When it asks for a passphrase, **type something memorable**. The passphrase encrypts your private key on your local disk; if your laptop gets stolen, the passphrase is what stops the thief from logging into your server.

**On Windows:** install **PuTTY** (putty.org) and use **PuTTYgen** to generate the keypair. PuTTY's documentation walks through this in five steps. Or, if you have a recent Windows 11 with the OpenSSH client built in, the Mac/Linux instructions above work in Windows Terminal too.

Your public key is now in `~/.ssh/id_ed25519.pub` (Mac/Linux) or wherever PuTTYgen saved it (Windows).

To see the public key, run:

```
cat ~/.ssh/id_ed25519.pub
```

It looks like a single long line starting with `ssh-ed25519 AAAA...` and ending with the email you put in earlier. Copy that whole line.

### Add your public key to the server

Go back to your VPS provider's dashboard. Find "SSH keys" or "Add SSH key". Paste in the public key you just copied. Save.

Some providers ask for the key when you create the server (option you might have skipped earlier). Some let you add it after. Either way works.

**If you set up the server with a password instead of an SSH key**, you can add the key to an existing server like this. Log in with the password (using `ssh root@your-ip-address` and entering your password when prompted), then on the server run:

```
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo "ssh-ed25519 AAAA...your-key-here..." >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Replace the `ssh-ed25519 AAAA...` with the actual contents of your public key. Now log out, then log back in — it shouldn't ask for a password this time.

### SSH into your server

From your local terminal (Mac/Linux/Windows-Terminal):

```
ssh root@123.45.67.89
```

Replace `123.45.67.89` with your server's actual IP address. The first time, it will ask "are you sure you want to connect" — type `yes`. Then your terminal prompt should change to something like `root@myhost:~#`.

You're now on the server. Everything you type from here on runs on the VPS, not your local computer.

### Initial server setup

Run these commands one at a time, reading what each does:

```
apt update && apt upgrade -y
```

Updates the list of installable software, then installs all available updates. Takes 1–5 minutes the first time.

```
apt install -y curl git ufw fail2ban unattended-upgrades
```

Installs:
- `curl` — for downloading things from the internet.
- `git` — for downloading the Morphit source code.
- `ufw` — a friendly firewall.
- `fail2ban` — automatically blocks attackers who repeatedly try to log in.
- `unattended-upgrades` — automatic security patching.

```
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Opens the three ports your server needs (SSH for you, HTTP and HTTPS for users) and turns the firewall on. Everything else stays blocked.

```
adduser morphit
usermod -aG sudo morphit
```

Creates a non-root user called `morphit` and gives it `sudo` (the ability to run privileged commands when needed). When it asks for a password, **set a real password and write it down** — you'll need it occasionally. The other questions (full name, room number, etc.) you can just press Enter past.

Now copy your SSH key to the new user:

```
mkdir -p /home/morphit/.ssh
cp ~/.ssh/authorized_keys /home/morphit/.ssh/authorized_keys
chown -R morphit:morphit /home/morphit/.ssh
chmod 700 /home/morphit/.ssh
chmod 600 /home/morphit/.ssh/authorized_keys
```

Now disable root login over SSH (for security):

```
sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

This says "you can only log in over SSH as a non-root user, and only with a key (no passwords)." This is the gold standard for SSH security on a public-internet server.

**Now log out** (`exit`) **and log back in as the morphit user**:

```
ssh morphit@123.45.67.89
```

If that works, the SSH key migration succeeded. If it asks for a password, your key isn't set up correctly — try the steps above again. Don't proceed until you can log in as `morphit` without a password prompt.

You now have a properly secured server.

### Install Node.js and PostgreSQL

Morphit needs Node.js (a programming language runtime) and PostgreSQL (a database). Install both:

```
sudo apt install -y postgresql postgresql-contrib
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

The Node.js install pulls from a third-party repo (NodeSource). This is the standard way to get a modern Node version on Debian/Ubuntu.

Verify both are installed:

```
node --version    # should show v22.x or similar
psql --version    # should show 15.x or higher
```

(ADR-0008 sets the floor at PostgreSQL 15.  Recent Debian
and Ubuntu releases ship a recent-enough version through
stock `apt`; if `psql --version` shows 14.x or lower, your
distro's default Postgres is too old — add the official
[PGDG repo](https://www.postgresql.org/download/linux/ubuntu/)
and `apt install postgresql-16` or `postgresql-17`.)

**Verify Postgres is bound to localhost only.** Stock Ubuntu's
default is correct (`listen_addresses = 'localhost'`), but it's
worth confirming — an exposed Postgres would let anyone on the
internet try to log in:

```
sudo -u postgres psql -t -c "SHOW listen_addresses;"
```

You should see `localhost` or `127.0.0.1`. If you see `*` or
`0.0.0.0`, your Postgres install is exposed; fix it before
proceeding (edit `/etc/postgresql/*/main/postgresql.conf`,
set `listen_addresses = 'localhost'`, then
`sudo systemctl restart postgresql`).

### Install nginx (the reverse proxy)

A "reverse proxy" is the thing that takes connections from the internet on port 443 (HTTPS) and routes them to the Morphit services running locally. We use nginx — it's the same thing the canonical morphit.io operator uses, the ops/ folder ships nginx config snippets, and it has the simplest path to Let's Encrypt certificates via certbot.

```
sudo apt install -y nginx certbot python3-certbot-nginx
```

nginx is now installed and running on port 80 with a default landing page. We'll replace the default config with Morphit's in step 8. certbot (the Let's Encrypt client) is installed but won't issue a certificate until step 8 either — you need a valid DNS record and the nginx config in place first.

> **Tip — let `morphit-ops` walk you through the certificate.** Once your domain points at this server and nginx is serving it, run `npx morphit-ops ssl setup` from your install directory. It checks the prerequisites and prints the exact certbot command for *your* domain, so you don't have to adapt the examples by hand. Afterwards, `npx morphit-ops ssl` tells you at a glance whether the certificate is valid, when it expires, and — the part people forget — whether automatic renewal is actually turned on. It's also in the interactive menu as **"SSL/TLS certificate (HTTPS)."**

> **Optional — Brotli compression module:** Morphit's `web.conf` enables both `gzip_static` (always works) and `brotli_static` (requires an extra module). gzip alone is fine for production. If you want the extra 15–20% smaller payload Brotli gives on JS/CSS, install `libnginx-mod-brotli` from your distro (Debian/Ubuntu) or the `nginx-mod-http-brotli` package on Fedora/RHEL. If you skip this, comment out the single `brotli_static on;` line in `ops/nginx/web.conf` to silence the "unknown directive" warning — your operator still wins compression via gzip. See [§9 Configure nginx](#configure-nginx) for the full config walkthrough.

That's all the system prep done. The actual Morphit install is shorter than this section.

> **Note for Caddy users:** if you'd rather use Caddy, that
> works too — Caddy can reverse-proxy to the same loopback ports
> and handle TLS automatically. The proxy config in step 8 will
> need to be translated to Caddyfile syntax (the path-prefix
> rewrite is straightforward; see Caddy's `handle` and `uri
> strip_prefix` directives). The rest of the guide is the same.

---

## 6. Create your Blurt accounts

Before we install Morphit itself, you need accounts on the Blurt blockchain. Morphit uses three accounts (see "Initial account setup" in OPERATIONS.md for the why), but you can start with just one and add more later.

**These are real, permanent accounts on a real blockchain.** Pick names you can live with — they cannot be changed.

For your first instance, the simplest setup is:

- **One account** for everything: signing operator-release ops, paying for users' stamps (the "relay" role), and receiving listing fees (the "fees" role).

For a more production setup later, you'd split into three accounts: `@yourbrand`, `@yourbrand-relay`, `@yourbrand-fees`. See OPERATIONS.md section 0 for the full pros/cons.

### Create the account

Go to **morphit.io/onboarding** (or any other Morphit instance) and follow the signup flow. Pick a name that matches your domain — e.g. if your domain is `swap.fi`, use `@swap` or `@swapfi`.

**Save the 12-word seed phrase** that's shown during signup. **On paper. In ink. In a safe place.** Lose this and your account is gone forever.

The seed gives you all four Blurt key types:

- **Owner key** — the master key. Almost never used. Keep this offline.
- **Active key** — used for transferring BLURT and changing other keys. Used by the relay (because spending Mana to broadcast on a user's behalf is an active-key operation).
- **Posting key** — used for posting orders, leaving feedback, sending chat messages. The lowest-risk key.
- **Memo key** — for encrypting memos in transfers. Morphit doesn't really use this.

For the first install, the relay needs the active key. We'll show you how to give it the active key safely in step 8.

---

## 7. Install Morphit

Back on your server, as the `morphit` user:

```
cd ~
git clone https://git.agorise.net/agorise/morphit.git
cd morphit
```

This downloads the Morphit source code into `~/morphit`. The first clone takes a minute or two.

Now install the dependencies and build. **Run these from inside the repo** (`cd ~/morphit` if you've changed directories since the clone — every Morphit command in this guide assumes you're in the repo root):

```
cd ~/morphit
npm install
npm run build --workspaces --if-present
```

`npm install` downloads all the libraries Morphit uses (about 800 MB of node_modules — most modern projects are like this). It also creates **workspace symlinks** under `node_modules/@morphit/asset-registry`, `node_modules/@morphit/indexer-client`, and a few others — these are Morphit's own internal packages (the source lives under `packages/`) wired up so the indexer, relay, and frontend can `import` from them by name. Without this step the smoke suite at `bash scripts/run-smokes.sh` will fail several runners with `ERR_MODULE_NOT_FOUND` errors complaining about `@morphit/asset-registry` (or one of the other `@morphit/*` packages) — that's the symptom that you ran the smoke suite before `npm install`, not a real code problem. Run `npm install` once and they pass.

`npm install` *also* creates the `morphit-ops` command you'll use for setup (`morphit-ops init`, `register`, `edit`). That command only exists after `npm install`, and only resolves when you run it from inside this repo — if `npx morphit-ops` ever says "command not found," you're either outside the repo directory or you haven't run `npm install` yet. (See §12 if you hit that.) **Re-run `npm install` after every `git pull`**, the same way you re-run the build.

`npm run build --workspaces --if-present` builds each workspace that has a build script — the web app (static HTML/CSS/JS that nginx will serve), the `morphit-ops` CLI (compiled into a single bundled file that runs under plain `node`), and the `morphit-mcp` AI-agent server. Workspaces without a build script (the relay and indexer run from TypeScript source) are skipped. This is the same command the Ansible playbook runs, so the manual and automated paths produce identical artifacts.

> *Note:* if the build for the morphit-ops CLI fails or you skip it, the CLI still works — it falls back to running its TypeScript source via tsx. The build just makes invocation faster (no per-invocation transpile). The web app, however, must be built; nginx serves the static files it produces.

This takes 5–10 minutes. Make tea.

### Set up the database

Morphit ships an init script at `ops/postgres/init.sql` that creates the database role and database with the right privileges. It's opinionated about passwords: it refuses to run if you haven't picked a real one. This is on purpose — the most common pre-launch mistake is shipping with an example password.

Pick a strong password first. A long random string is best; one quick way:

```
openssl rand -base64 32
```

Save it in your password manager. You'll need it again in step 8.

Now run the init script with the password in the environment:

```
MORPHIT_INDEXER_DB_PASSWORD='<your-strong-password>' \
    sudo -E -u postgres psql -f ops/postgres/init.sql
```

The `-E` flag tells `sudo` to preserve your environment so the postgres user sees the password variable. If it worked, you'll see `Password sanity check passed. Creating role and database...` followed by `CREATE ROLE`, `CREATE DATABASE`, and a "Done. Next steps:" footer.

If you forget to set the variable, set it to an empty string, or paste in one of the example placeholder values, the script aborts with a clear error and exit code 3 — no role or database is created.

Apply the database schema using the migration runner:

```
cd apps/indexer
npm run migrate
cd ../..
```

The migration runner reads `MORPHIT_INDEXER_DATABASE_URL` from your environment, applies the canonical `apps/indexer/src/db/schema.sql` (which is the pre-launch v1 collapsed baseline — it folds the historical v1-v35 deltas into one in-place schema), and records what it has applied in a `schema_migrations` table so re-running it is idempotent. You should see log lines like `applied {versions: [1]}` on the first run, and `already_applied {versions: [1]}` on subsequent runs. Behind the scenes, the runner also records all subsumed historical versions (v2-v35) in `schema_migrations` so any downstream "is v15 applied?" check returns true. If you see neither `applied` nor `already_applied` log lines, check that `MORPHIT_INDEXER_DATABASE_URL` is exported in your shell — the runner won't guess.

> **Note on the password sentinel.** The init script and both runtime services (indexer and relay) reject a known list of placeholder password strings — `CHANGEME`, `CHANGE_ME`, `CHANGE_ME_BEFORE_PRODUCTION`, `__SET_BEFORE_DEPLOY__`, `password`, `postgres`. The example `.env` files ship with `__SET_BEFORE_DEPLOY__` as the placeholder so it's obvious you need to replace it. See OPERATIONS.md §30 for the full provisioning + runtime guardrail rationale.

---

## 8. First-time configuration

### 8.0 The recommended path — `morphit-ops init` (interactive wizard)

The fastest, lowest-error setup path is the interactive wizard.
It walks you through 23 steps in plain English and generates
correctly-shaped `morphit.config.env` + `morphit.env` files plus
your encrypted relay keystore.

```
cd /opt/morphit                  # or wherever you cloned to
npx morphit-ops init
```

What it asks you, in order:

1. Instance name (the public brand for your node)
2. Tagline (one-line description shown on `/`)
3. Database connection (postgres URL — set up in §7)
4. Your relay's Blurt account name (the dedicated account you
   created in §6)
5. **The ACTIVE key for that relay account** — paste the WIF
   string starting with `5`.  This is the **active** key, not
   posting.  The wizard explains why in detail; the short
   version is that the relay broadcasts `create_claimed_account`,
   `transfer`, `transfer_to_vesting`, and
   `delegate_vesting_shares` operations — all active-authority.
   The chain rejects every one of those with "missing required
   active authority" if you paste the posting key by mistake.
6. Fees account name (where listing-fee revenue lands)
7. Daily signup ceiling (how many account creations per 24h)
8. Contact URL (operator email or chat link — optional)
9. Public origin URL (your https:// frontend)
10. Alt-network addresses (Tor / Lokinet / I2P / Nostr — optional)
11. Fee-verifier explorer URLs (BTC + XMR; defaults are fine)
12. Chat-link external explorer URLs (per-asset; defaults are fine)
13. Trade-only asset policy (which non-BLURT assets to accept)
14. Listing fee + fallback BLURT price
15. Homepage SEO meta tags (title / description / keywords —
    optional but recommended for your instance to stand out)
16. Daily DB backup automation (recommended on)
17. Operator tag (for federation-scoped payout attribution)
18. Matrix surfaces (private alert MXID + public room alias)
19. Blurt RPC endpoints (defaults are fine for most operators)
20. **MCP server** (Model Context Protocol for AI agents —
    recommended on; lets AI agents like Claude Desktop, Cursor,
    etc. discover your instance and answer user queries from
    your orderbook).  On the canonical Ansible + BunkerWeb path it
    is now exposed automatically — the playbook binds it for the
    BunkerWeb frontend, opens the firewall to the bridge only,
    proxies `/mcp`, and advertises `<origin>/mcp` for federation
    discovery, with no manual step.  See OPERATIONS.md §45.
21. **BunkerWeb WAF / reverse proxy** (recommended for any
    public instance — answer yes if BunkerWeb terminates TLS and
    fronts your stack, and the wizard sets
    `MORPHIT_RELAY_TRUSTED_PROXY_IPS=172.20.0.0/16` for you; answer
    no if you serve directly behind nginx/Caddy).  See §11 of this
    guide and OPERATIONS.md §32.
22. **Server hardening checklist** (strongly recommended — the
    wizard offers to write a personalized
    `morphit-hardening-checklist.md` with your domain and your
    BunkerWeb-vs-nginx choice baked in, sequencing SSH lockdown,
    UFW + fail2ban, unattended-upgrades, and TLS in a safe order).
    See §11 of this guide and OPERATIONS.md §34/§35/§37.

Don't be put off by the length of that list.  Most steps have a
safe default: anything marked *optional* or *defaults are fine* can
be accepted by just pressing Enter.  To get to a running instance
you really only have to answer a handful of required questions —
instance name, database connection, your relay account + its active
key, and the fees account.  Everything else can be left at its
default and revisited later by re-running `morphit-ops init`.

The wizard writes three files atomically:

  - `/etc/morphit/morphit.config.env` — operator-tunable settings
  - `/etc/morphit/morphit.env` — critical infrastructure (DB URL,
    account names, keystore path)
  - `/opt/morphit/apps/relay/keystore.{json,wif}` — your encrypted
    or plaintext relay active key

Each is mode 0600, owned by the appropriate service user.

#### If you accidentally pasted the wrong key

If the wizard accepted your input but the relay refuses to start
(`missing required active authority` on every broadcast), or
you realize you pasted your posting key instead of the active
key, **do NOT re-run `morphit-ops init` from scratch** — that
would force you to re-enter all 19 other steps.  Instead use
the dedicated rotation command:

```
morphit-ops edit-active-key
```

When it asks "Was the previous key wrong or compromised?",
answer YES.  The prior keystore gets overwritten with random
bytes + zeros, then unlinked — no `.bak` file is left behind.
See [`docs/RECOVERING-FROM-WRONG-RELAY-KEY.md`](RECOVERING-FROM-WRONG-RELAY-KEY.md)
for the full procedure with verification steps.

### 8.1 The manual path — hand-editing env files

If you'd rather not use the wizard, you can configure Morphit by
hand.  The wizard generates the same files this section describes;
the result is byte-equivalent.  Use this path when you're
automating the setup (Ansible, Terraform, etc.) and need the
shape documented.

Templates live in `ops/env/`. Copy them and fill in your specifics:

```
cp ops/env/indexer.env.example /etc/morphit/indexer.env
cp ops/env/relay.env.example /etc/morphit/relay.env
```

Now set the owners and modes. Indexer.env is read by the indexer daemon (running as the `morphit` user, created above). Relay.env is read by the relay daemon, which runs as a **separate** `morphit-relay` system user — smaller blast radius if the relay is ever compromised. Create that user now if it doesn't already exist:

```
sudo adduser --system --group --no-create-home morphit-relay
```

Then chown each env file to the daemon that reads it:

```
sudo chown morphit:morphit       /etc/morphit/indexer.env
sudo chown morphit-relay:morphit-relay /etc/morphit/relay.env
sudo chmod 0600 /etc/morphit/indexer.env /etc/morphit/relay.env
```

Mode 0600 means only the owning daemon (or root) can read the file. Group read isn't needed because each env file has exactly one consuming daemon.

Then edit each file. The minimum settings to change:

### `/etc/morphit/indexer.env`

```
MORPHIT_INDEXER_DATABASE_URL=postgresql://morphit_indexer:YOURDBPASSWORD@localhost:5432/morphit_indexer
MORPHIT_INDEXER_OFFICIAL_ACCOUNT_NAME=morphit
MORPHIT_INDEXER_FEE_RECIPIENT=morphit-fees
MORPHIT_INDEXER_LISTEN_PORT=8081
MORPHIT_INDEXER_PUBLIC_ORIGIN=https://yourdomain.com
MORPHIT_INDEXER_ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

Replace `YOURDBPASSWORD` with the database password you set in step 7. The `__SET_BEFORE_DEPLOY__` sentinel must NOT remain anywhere — the indexer refuses to boot while it's still there. The `OFFICIAL_ACCOUNT_NAME` and `FEE_RECIPIENT` are the canonical Morphit accounts (`morphit` and `morphit-fees`); operators do **not** change these — they're federation-wide constants.

For the full list of every env var the indexer reads (price feed, operator-balance alerts, BTC/XMR fee acceptance, attestation phase, low-balance auto-refill), open `ops/env/indexer.env.example` itself — every key is commented with what it does and a sane default.

> **About `MORPHIT_INDEXER_PRICE_FEED_NATIVE_ENABLED` (cp127 self-sovereign pricing):** Leave it `false` for a brand-new instance with zero trade history. Once your platform has enough on-platform trading activity (≥3 distinct verified-fee traders posting BLURT-vs-USD or BLURT-vs-stablecoin orders within an 8-hour window), you can flip it to `true`. The native fetcher slots BETWEEN coingecko and the static floor, so external sources still work as primary. Inspect what the native fetcher WOULD produce (even while disabled) via `GET /v1/price/morphit-native/receipt` on your instance. See ADR-0039 for the full design.

> **About `MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT` (cp128 denomination configurability):** Default `USD`.  Set this to a different ticker (`EUR`, `GBP`, `JPY`, `BRL`, `CNY`, `INR`, `RUB`, `AED`, `XDR`, `XAU`, or any 3-8 character uppercase ticker) if your instance serves a non-USD-native market — or as a hedge against future scenarios where USD's reserve-currency role erodes.  The wizard's "Listing fee + fallback BLURT price" step now prompts for this with a curated picker plus an "Other (enter ticker)" escape hatch.  Affects only the display unit on `/v1/listing-fee` and `/v1/price/morphit-native/receipt`; order matching and on-chain fees are denomination-agnostic.  See ADR-0040 for the full design.

> **About `MORPHIT_INDEXER_PEER_PRICE_MONITOR_ENABLED` (cp129 Defense F — cross-instance peer disagreement):** Default `false`. Leave it off until your instance is federated with at least 3 reachable peers (visible in `/v1/instances` with `last_probe_status` of `good` or `quiet`).  When enabled, the indexer periodically (every 30 minutes by default) queries peer instances' `/v1/price/morphit-native/receipt` and alerts on sustained median-vs-self disagreement above 25% for over 4 hours.  This defense catches the case where YOUR indexer is the one being manipulated (rather than the trader-level manipulation the cp127 sybil filters address); a healthy peer median acts as a sanity check that no single compromised indexer can fake.  See ADR-0041 for the full design + threat model.  Requires the price feed to be enabled (`MORPHIT_INDEXER_PRICE_FEED_ENABLED=true`); the monitor has nothing to compare against otherwise.

> **About the slow-drift (B) and native-vs-external (C) price defenses (cp127, runtime-wired cp233):** Unlike Defense F above, these two need **no peers** — they protect a lone instance — and they are **on by default whenever `MORPHIT_INDEXER_PRICE_FEED_NATIVE_ENABLED=true`** (no separate switch).  B watches the published price for a slow walk away from its own time-decayed moving baseline ("frog in boiling water"); C cross-checks the published external market price against your `morphit_native` price.  Both log-alert on a sustained breach, and — as of cp233 — all three defenses (B, C, and F) surface in the verbose price block of `/v1/health` under `price.drift`, `price.disagreement`, and `price.peer`.  Neither B nor C ever auto-corrects the price; they make manipulation loud so you can investigate.  See `docs/OPERATIONS.md` → "Monitoring the price-manipulation defenses" for what to do on an alert, and ADR-0039 for the design.

> **About `MORPHIT_INDEXER_PRICE_FEED_BTC_STATIC_FLOOR` + `..._XMR_STATIC_FLOOR` (cp130 multi-asset pricing):** Defaults are USD-shaped: 60000 for BTC, 200 for XMR.  These are the per-asset fallback prices that the composite source serves when all live upstreams have failed AND no value has cached since boot — they never surface in normal operation.  Operators in non-USD denominations (per cp128 `MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT`) should override these to match their unit — e.g. on a EUR-denominated instance, set `BTC_STATIC_FLOOR=55000` (~BTC/EUR) instead of the USD-shaped 60000.  The cp127 morphit_native price source now derives prices for BTC and XMR too (in addition to BLURT), so `/v1/price/morphit-native/receipt?asset=BTC` returns a real derivation; Klingex remains BLURT-only since it doesn't trade BTC/USDT or XMR/USDT at scale, so BTC and XMR get a 3-tier chain (Coingecko → morphit_native → static floor) rather than BLURT's 4-tier chain.  See ADR-0042.

> **About `MORPHIT_INDEXER_BTC_FEE_ADDRESS` (community
> operators):** Leave it empty.  As of Part 106, your
> indexer automatically inherits the canonical Morphit
> treasury BTC address from the most recent signed
> `morphit_release_v1` op on chain.  You still get your
> 90% operator share on BLURT-paid fees (separate pipeline,
> see §9.3 below); only BTC fees go 100% to canonical's
> treasury.

> **About `MORPHIT_INDEXER_XMR_FEE_ADDRESS` (community
> operators):** Leave it empty.  As of Part 108++, your
> indexer can verify XMR fees independently using
> per-payment proofs that users generate from their own
> Monero wallets — no view key required by you, no
> shared secret, no dependency on canonical morphit.io.
>
> The default flow:
>
> 1. User pays canonical's chain-pinned XMR address
>    from their own wallet.
> 2. User generates a `tx_proof` from their wallet (one
>    extra step compared to BTC, but the post-order page
>    has inline per-wallet instructions in 10 locales —
>    Monero CLI / GUI / Cake / Feather).
> 3. User submits the order op carrying both the txid
>    and the proof.
> 4. Your indexer's `MoneroProofFeeVerifier` calls a
>    public Monero block explorer (default
>    `xmrchain.net`) with the proof.  No secret
>    required.
> 5. Verified or rejected, just like BTC.
>
> **For maximum independence (priority #2):** point your
> verifier at a self-hosted `monero-block-explorer` +
> local `monerod` instead of a third-party explorer.
> See `OPERATIONS.md §40.4`.
>
> **About the old `MORPHIT_INDEXER_XMR_FEE_VIEWKEY`
> env var:** removed entirely in Part 109.  If your
> `/etc/morphit/indexer.env` still contains a line for
> it, the line is harmless (zod ignores unknown env
> vars) — delete it next time you touch the file.
>
> **If you want to run your own XMR treasury** (collect
> XMR fees yourself instead of forwarding to canonical):
> generate your OWN Monero wallet and put your address
> in `MORPHIT_INDEXER_XMR_FEE_ADDRESS`.  Your XMR-fee
> orders won't appear on canonical's orderbook (the
> txid paid your address, not canonical's), but you keep
> 100% of the XMR.  Federation health monitors will
> show the divergence.

### `/etc/morphit/relay.env`

```
MORPHIT_RELAY_ACCOUNT=yourblurtaccountname
MORPHIT_RELAY_ACTIVE_KEY_FILE=/etc/morphit/keys/relay-active.key
MORPHIT_RELAY_DATABASE_URL=postgresql://morphit_indexer:YOURDBPASSWORD@localhost:5432/morphit_indexer
MORPHIT_RELAY_LISTEN_PORT=8080
MORPHIT_RELAY_DATA_DIR=/var/lib/morphit-relay
MORPHIT_RELAY_INVITE_HMAC_SECRET=<run `openssl rand -base64 32` and paste here>
MORPHIT_RELAY_ALTCHA_HMAC_SECRET=<run `openssl rand -base64 32` and paste here>
MORPHIT_RELAY_SIGNUP_DAILY_CEILING=50
MORPHIT_RELAY_SIGNUP_ENABLED=true
```

`MORPHIT_RELAY_ACTIVE_KEY_FILE` points to the file holding the active private key for your Blurt account, in WIF format (or as an encrypted envelope — see the comments at the top of `ops/env/relay.env.example`). **The active key is a hot key on a server connected to the internet — that's an unavoidable part of running a relay.** Make sure your server is properly secured (which the steps in section 5 take care of) and that the key file is mode `0400`, owned by the relay's system user.

> **About the in-memory key handling (2026-05-07 audit):**
> When the relay decrypts its active-key envelope at boot, the
> scrypt-derived KDF key and the intermediate plaintext Buffer
> are explicitly zeroed in a `finally` block right after use
> (see `apps/relay/src/crypto/keyEnvelope.ts`). The
> `key-envelope-smoke.ts` runner enforces this discipline. The
> decrypted WIF then lives in a JS string in process memory for
> the lifetime of the relay — that's intentional for the
> persistent-signer role. Defense against process-memory
> attackers comes from file-system permissions (0400 owner-only,
> enforced at boot), the §37 server hardening checklist in
> `docs/OPERATIONS.md`, and the passphrase-at-boot ceremony for
> encrypted envelopes. **No operator action is required for
> this audit** — existing key files, envelopes, and passphrases
> work unchanged. Full details in `docs/OPERATIONS.md` §3.

> **Want more than the baseline?** §3 + §37 + the in-process
> handling above are the production-ready baseline.  Once the
> relay is live and stable, `docs/OPERATIONS.md` **§37.20**
> documents an optional 8-step defense-in-depth ladder for the
> active key (YubiKey-as-boot-passphrase, `mlock`-on-key-buffer,
> air-gapped signer process, YubiHSM 2, etc.).  Each step
> declares its cost, value, and when it makes sense.  Read
> §37.20 in a quiet week; pick the ones that fit your threat
> model and budget.  Don't try them all at once.

The two HMAC secrets MUST be different from each other AND from any other password on the system. Generate fresh ones with `openssl rand -base64 32`. They're used to sign anti-bot puzzles and invite tokens; if either is empty or a known placeholder, the relay refuses to boot.

`MORPHIT_RELAY_DATA_DIR` is where the relay keeps its kill-switch sentinel file (see step 11 below) and the persisted daily-ceiling counter. Create it now and give the relay user ownership:

```
sudo mkdir -p /var/lib/morphit-relay
sudo chown morphit-relay:morphit-relay /var/lib/morphit-relay
sudo chmod 0700 /var/lib/morphit-relay
```

For the full list of relay env vars, open `ops/env/relay.env.example` — every key is commented.

### Web Push (on by default)

Morphit can deliver notifications to users even when their browser
tab is closed or their phone is locked. This requires a one-time
**VAPID keypair** that identifies your relay to push services
(Google FCM, Mozilla autopush, Apple's push service).

**The Ansible playbook generates this for you automatically** the
first time it runs — once, into `/etc/morphit/relay-vapid.env`, which
the relay sources on startup — so push works out of the box. It is
never regenerated on a later run (rotating the public key would drop
everyone's subscriptions). The subject defaults to your public origin;
override it with `morphit_vapid_subject` in `group_vars/all.yml`, or
set `morphit_enable_web_push: false` to turn it off.

If you installed by hand, generate the keypair once into the same
file the relay sources, then restart the relay (use a real `https://`
URL or a `mailto:` address you read — push services use it to reach
you if something goes wrong with your pushes):

```
sudo bash scripts/generate-vapid-keys.sh --bare \
  --subject https://your-domain.example \
  | sudo tee /etc/morphit/relay-vapid.env >/dev/null
sudo chmod 640 /etc/morphit/relay-vapid.env
sudo systemctl restart morphit-relay
```

Running the script with no flags prints a human-readable version of
the three env vars you can paste into any env file instead:

```
MORPHIT_RELAY_VAPID_PUBLIC_KEY=BH5ZK…   (~88 chars)
MORPHIT_RELAY_VAPID_PRIVATE_KEY=AzbhfY…  (~44 chars — TREAT AS SECRET)
MORPHIT_RELAY_VAPID_SUBJECT=mailto:operator@your-domain.example
```

If you don't set these, the relay starts with push disabled —
users on your instance see "Not supported on this device" next to
the push toggle in their Settings, and fall back to the in-tab
notification channels (title-bar prefix, favicon badge, OS
notifications via the Notification API, audio cue, mobile vibration).
This is a perfectly fine state for operators who want minimal
infrastructure.

If you do enable push: the relay's `morphit-relay` daemon starts a
**push-sender worker** that drains the `push_pending` queue every
30 seconds (tunable via `MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS`) and
fans out to subscribed devices. Payloads are end-to-end encrypted
per RFC 8291 (the push service sees ciphertext, not text). No
subscriber IPs are stored. Subscriptions auto-clean when push
services return 410 Gone.

By default the relay requires every subscribe request to carry a
**posting-key signature** — only the holder of the account's
posting key can register a device as that account. If you need to
roll out a new frontend before the relay (rare), set
`MORPHIT_RELAY_PUSH_REQUIRE_SIGNED=false` temporarily. Full
operator reference at `docs/OPERATIONS.md` §42.

### How your homepage actually loads (the big picture)

Here's the mental model that makes the next steps click: **your homepage isn't a program that "runs."** It's a folder of plain files — HTML, CSS, JavaScript — that a web server hands to a browser on each visit. Nothing about the frontend needs to be "started"; you build the folder once (and re-build on each upgrade), and nginx serves it.

Three things have to line up for **https://yourdomain.com** to show the homepage (and `/post`, and every other page):

1. **The name points at the box** — the DNS `A`/`AAAA` records you set in §4, sending your domain at this server's public IP.
2. **The built files are where the web server can reach them** — the next step ("Build the frontend"): `npm run build` produces `apps/web/build/`, which you copy to `/var/www/morphit-frontend/`.
3. **nginx serves those files over HTTPS** — "Configure nginx" below: it serves `/var/www/morphit-frontend` at `/` (with a fallback so deep links like `/post` work), proxies the relay + indexer API to loopback, and terminates TLS with your Let's Encrypt cert (run `morphit-ops ssl` for the exact steps to get one). Reload nginx, open the URL, and the homepage is live.

**If you run BunkerWeb, read this carefully.** The BunkerWeb config Morphit ships now serves the **whole site**, not just the API — it runs a small `frontend` nginx container that serves your static homepage AND proxies the relay/indexer API (`/v1/`, `/relay/`, `/rss/`), with BunkerWeb in front as the TLS terminator + WAF. So you do NOT separately set up the host nginx in this section if you're going the BunkerWeb route; the `frontend` container is your web server. Two things differ from the bare-metal nginx path: (1) the SvelteKit build is mounted into the container read-only from `/opt/morphit/apps/web/build` (so `npm run build` is still required, but you don't `cp` it to `/var/www/...`), and (2) the relay + indexer must bind on an address the Docker bridge can reach (NOT `127.0.0.1` only — the canonical setup binds `0.0.0.0` and the shipped UFW rules let only the `172.20.0.0/16` bridge CIDR reach the service ports). See "BunkerWeb — recommended WAF" later in this guide, `ops/bunkerweb/README.md`, and `docs/OPERATIONS.md` §32 for the full wiring. (If you'd rather keep the bare-metal host nginx and just put BunkerWeb in front of it as a pure WAF, that also works — point BunkerWeb at your host nginx instead of the `frontend` container.)

One last thing: make sure the **relay and indexer are running** first. If they're not, the pages still load (they're just static files) — but anything you click that fetches live data (the orderbook, signing in, posting) will error.

### Build the frontend (static files)

The frontend is a SvelteKit app that builds to a directory of static files. There is no separate "web service" to run — nginx serves the static files directly. Build it now:

```
cd apps/web
npm run build
cd ../..
```

This produces `apps/web/build/`. Copy it to a stable system path (the nginx config below points at this path):

```
sudo mkdir -p /var/www/morphit-frontend
sudo cp -r apps/web/build/* /var/www/morphit-frontend/
sudo chown -R www-data:www-data /var/www/morphit-frontend
```

Re-run these three commands every time you update Morphit **by hand** (`git pull` followed by `npm run build` followed by the `cp`). Section 12 below shows how to do it as a single update procedure. (If you update via a release with `morphit-ops upgrade` instead, you do **not** do this by hand — the upgrade rebuilds `apps/web` and republishes it for you: it copies the build into your web root on bare-metal nginx, or `docker restart`s the container that bind-mounts the build directory — any Docker frontend, including BunkerWeb, found by the mount rather than by name — so it serves the new build. See `docs/UPGRADING.md`.)

### Configure nginx

Morphit ships nginx server-block templates in `ops/nginx/`. The recommended deployment is **single-hostname** — frontend, indexer, and relay all reachable under one domain (`yourdomain.com`) via path prefixes — the indexer at `/v1/`, the relay at `/relay/` (and the indexer's RSS feeds at `/rss/`). This means you do NOT need separate DNS entries for the indexer or relay; the frontend reaches them via same-origin paths.

Create `/etc/nginx/sites-available/morphit.conf`:

```nginx
# HTTP -> HTTPS redirect.
server {
    listen 80;
    listen [::]:80;
    server_name yourdomain.com www.yourdomain.com;

    # ACME http-01 challenge for Let's Encrypt
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS — the only public surface.
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Security headers.  The Content-Security-Policy lives HERE (a real
    # response header), NOT as a <meta> tag in the HTML — this is a
    # static build, `frame-ancestors` only works as a header, and the app
    # needs `wasm-unsafe-eval` (in-browser argon2 KDF + signing) plus
    # `'unsafe-inline'` for SvelteKit's inline bootstrap once per-page
    # hashes aren't computed.  The build no longer emits a meta CSP, so
    # you do NOT need to strip one anymore.  See OPERATIONS.md §15 for the
    # directive-by-directive rationale.
    #
    # IMPORTANT: connect-src lists the FOUR default Blurt RPC nodes
    # (apps/web/src/lib/net/config.ts).  If you run a different RPC set,
    # edit connect-src to match or the browser will block your nodes
    # (incl. failover).  It deliberately lists NO price API: price
    # fetching is server-side (the indexer), the browser never calls
    # CoinGecko, so adding it here would only leak visitor IPs.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Frame-Options "DENY" always;
    add_header Permissions-Policy "camera=(self), microphone=(), geolocation=(), interest-cohort=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://rpc.drakernoise.com https://blurtrpc.dagobert.uk https://rpc.blurt.blog https://rpc.beblurt.com https://rpc.blurt.one https://blurt-rpc.saboin.com; media-src 'none'; object-src 'none'; child-src 'none'; frame-src 'none'; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'" always;

    # Frontend — static files from the SvelteKit build output.
    #
    # The build uses trailingSlash:'never', so prerendered pages are
    # flat files: `en.html`, `en/login.html` (NOT `en/index.html`).
    # The `$uri.html` step maps the extensionless route `/en/login` to
    # `en/login.html`. Without it, nginx matches the `en/` directory
    # (autoindex off -> 403) and never tries `en.html`. The trailing
    # `/index.html` is the SPA fallback for any route that wasn't
    # prerendered. Always navigate to extensionless URLs (`/en`,
    # `/en/login`) — never the `.html` files directly.
    root /var/www/morphit-frontend;
    index index.html;

    # Keep the "update surface" always-fresh so the in-app update snackbar
    # appears after every deploy. /service-worker.js drives update
    # detection (the browser refetches it on each update check and a
    # byte-changed worker is what raises the "Load it now" prompt), and
    # verify.json carries this build's version (read by the update-version
    # poll and the "About this instance" auto-verify). If either is served
    # stale — from the browser's cache OR an upstream proxy/CDN edge cache —
    # the client never learns a new build is live and the prompt never
    # shows (the classic "no snackbar on mobile or PC" symptom). `expires -1`
    # emits `Cache-Control: no-cache` (revalidate every time) WITHOUT an
    # `add_header`, so — unlike add_header — it does NOT drop the inherited
    # security headers set above this block. (The shipped ops/nginx/web.conf
    # achieves the same with add_header + a full security-header re-emission;
    # expires -1 is the shorter equivalent.)
    location = /service-worker.js { expires -1; try_files $uri =404; }
    location = /verify.json       { expires -1; try_files $uri =404; }

    location / {
        try_files $uri $uri.html $uri/index.html /index.html;
    }

    # Relay — fund-spending endpoints. Proxied to loopback.
    #
    # The frontend calls the relay at same-origin `/relay/v1/*` (e.g.
    # `/relay/v1/account/create`). The rewrite strips the `/relay`
    # prefix so the relay process sees `/v1/account/create`.
    location /relay/ {
        rewrite ^/relay/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 64k;
    }

    # Indexer — read-only public API. Proxied to loopback.
    #
    # The frontend calls the indexer at same-origin `/v1/*` (e.g.
    # `/v1/orderbook`, `/v1/instance`). The indexer serves those paths
    # as-is, so forward them unchanged — do NOT add a rewrite here.
    # (`/relay/v1/*` is matched by the longer `/relay/` prefix above,
    # so it never falls into this block.)
    location /v1/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 4k;
    }

    # SSE live-update streams (orderbook / chat / instances). These
    # are long-lived; the indexer sends a `:keepalive` comment every
    # 25s, so nginx's default 60s read timeout won't sever a healthy
    # stream — but proxy buffering MUST be off or events arrive in
    # laggy batches instead of live. This regex matches the
    # `.../stream` paths ahead of the `/v1/` prefix above, so the live
    # endpoints get the streaming treatment and everything else keeps
    # normal buffering.
    location ~ ^/v1/.*/stream$ {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }

    # RSS/Atom orderbook feeds — the same loopback indexer, served
    # under `/rss/*` (the page footer and `<head>` link to
    # `/rss/orderbook.xml` plus the by-asset / by-account feeds).
    # Forward unchanged, like `/v1/`.
    location /rss/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Save the file. Replace `yourdomain.com` with your actual domain in three places. Enable the site and reload nginx:

```
sudo ln -s /etc/nginx/sites-available/morphit.conf /etc/nginx/sites-enabled/
sudo nginx -t                # syntax check
sudo systemctl reload nginx
```

For TLS certificates, the simplest path is **certbot in standalone mode** (the snippet above assumes Let's Encrypt is already issued):

```
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot edits the nginx config in place to add the certificate directives — that's fine, just make sure the resulting file still has the proxy and try_files locations from above. Certbot also installs a systemd timer for auto-renewal. See OPERATIONS.md §35 for the renewal quick-reference.

Reference templates: separate-subdomain configurations (where the indexer and relay are at `indexer.yourdomain.com` and `relay.yourdomain.com`) live in `ops/nginx/indexer.conf` and `ops/nginx/relay.conf` — useful if you have a reason to split them, but most operators don't need to.

### Set up systemd services

The Morphit services (indexer + relay) need to keep running even when you're not logged in. Use systemd. The shipped unit files in `ops/systemd/` reference the default `/opt/morphit` path, so rather than copy them by hand and fix the paths, run the installer — it detects where you actually cloned the repo and writes the units with the correct `WorkingDirectory`/`ExecStart`, so this guide's `~/morphit` layout works with no extra steps:

```
sudo bash ops/scripts/install-systemd-units.sh
sudo systemctl enable --now morphit-indexer morphit-relay
```

The installer writes the three monorepo services (indexer, relay, and matrix-bot if you run the alert bot), each pointed at this checkout. The MCP server and the weekly mint-acts job deliberately run from their own restricted directories as separate low-privilege users, so this manual installer leaves them alone. The **Ansible playbook deploys and enables the MCP server for you by default** (isolated, as its own `morphit-mcp` user from `/opt/morphit-mcp`, locked down so it can't read your DB password or relay keys); to do it by hand, create the `morphit-mcp` user **first**, then run `sudo bash ops/scripts/deploy-mcp.sh "$PWD" /opt/morphit-mcp morphit-mcp` and enable `morphit-mcp.service` — the full ordered steps (the deploy chowns the tree to that user, so creating it first matters) are in OPERATIONS.md §45, and the mint-acts job is a separate setup. The service runs the hardened HTTP transport on `127.0.0.1:8124`, so confirm it with `curl http://127.0.0.1:8124/health`; and `sudo morphit-ops upgrade` now redeploys and restarts it automatically on every version bump, so you never re-run the deploy by hand after an upgrade. That isolation is intentional. Once the MCP server is installed, you can turn it on or off at any time with `sudo morphit-ops mcp` (or the interactive menu → **Check & operate → MCP server**) — no need to remember the unit name.

> **Before you start the services, run the doctor.** From your
> install directory, `npx morphit-ops doctor` reads your config and
> reports whether the indexer and relay will actually start — in
> plain English, changing nothing. It also pings the Blurt RPC
> endpoints your node will use and tells you if any are unreachable
> (the most common reason a node runs but never catches up). Catching
> a missing or misplaced setting here (a quick read-only check) is far
> easier than reading a stack trace after a failed `systemctl start`.
> See the "My node won't start" troubleshooting entry later in this
> guide.

> **Install path.** The installer above writes the units pointed at
> wherever you cloned the repo — `/opt/morphit`, `~/morphit`, or
> anywhere else — so there's no `systemctl edit` drop-in to maintain.
> If you'd rather install by hand, copy the units from `ops/systemd/`
> and replace `/opt/morphit` with your clone path in each
> `WorkingDirectory=` and `ExecStart=` line; `systemctl cat
> morphit-indexer` shows the merged result, and the units survive
> upgrades.

**The relay's active key is encrypted, and its passphrase must be supplied as a systemd _encrypted credential_** — never as plaintext on disk. This is what lets the relay start unattended (no prompt) while keeping the key encrypted at rest. Create the credential once (as root), using the same passphrase you set when you created the relay key:

```
echo -n 'your-relay-passphrase' | sudo systemd-creds encrypt --name=relay_passphrase - /etc/morphit/relay_passphrase.cred
```

systemd decrypts it automatically at every start using the machine's host key (and the TPM, if present) — so after a reboot the relay comes back and resumes posting to the chain on its own, with nothing to type. Keep the passphrase itself in your password manager: if you ever rebuild the host from scratch, re-run that one command to recreate the credential. The relay unit **refuses to start without the credential** — that's deliberate; do not fall back to a plaintext passphrase in `morphit.env`.

Now start both services — they come up unattended, no passphrase prompt:

```
sudo systemctl start morphit-indexer morphit-relay
```

(There's no "morphit-web" service — the frontend is static files served by nginx, no Node process. The build step above is the entire web "deployment.")

Check that both are running:

```
sudo systemctl status morphit-indexer
sudo systemctl status morphit-relay
```

You should see "active (running)" for each. If either says "failed", run:

```
sudo journalctl -u morphit-indexer -n 50
```

(replace with the failing service name) to see why. The most common first-boot failures are: database password mismatch in `indexer.env`, missing HMAC secrets in `relay.env`, or unset `MORPHIT_RELAY_DATA_DIR`.

### Visit your site

Open a browser and go to `https://yourdomain.com`. You should see Morphit's home page.

If you see a default nginx page or "this site can't be reached":
- Check DNS has propagated (`nslookup yourdomain.com` from your local computer — it should show your VPS's IP).
- Check nginx is happy with its config (`sudo nginx -t`).
- Check that `/var/www/morphit-frontend/index.html` exists.

If you see Morphit but it says "Indexer unreachable":
- Check `sudo systemctl status morphit-indexer` and look at the logs.
- Most common cause: database password mismatch in `indexer.env`.

If both work but the orderbook is empty: **that's normal**. Your indexer starts at the **Morphit genesis block** — the point on the Blurt chain where Morphit data first appears — and catches up from there to the current chain head. That's a small slice of the chain (not the whole multi-year history), so a fresh node is usually current within a few minutes to about an hour. The orderbook fills in as it catches up; existing orders appear once it reaches the blocks they were posted in. Just wait.

**To check it's actually catching up** (and not stuck), ask the indexer directly:

```
curl -s http://127.0.0.1:8081/v1/health \
  | jq '{indexed_block, chain_head_block, lag_blocks, rpc_endpoints_healthy, rpc_endpoints_total}'
```

> The `morphit-ops` menu (item 13, *Node health*) runs this same check
> for you — and now also shows the relay, the matrix-bot and mcp
> service state, and the warrant-canary's freshness, all in one view
> that **needs no sudo**. If your indexer binds the Docker bridge
> rather than loopback (the BunkerWeb path binds `0.0.0.0`, reachable
> on the bridge gateway such as `172.18.0.1`), the view auto-probes
> that gateway for you, so it now works without a flag. To pin a
> specific target anyway: `morphit-ops health --url http://172.18.0.1:8081/v1/health`.

Run it twice a minute apart — `indexed_block` should be climbing and `lag_blocks` shrinking. **If `rpc_endpoints_healthy` is `0`, that's your problem:** the public Blurt servers your node talks to aren't reachable, so it can't catch up. Fix the `MORPHIT_INDEXER_RPC_ENDPOINTS` list (see OPERATIONS.md "Monitoring RPC endpoint health") and restart the indexer. A healthy count with a big `lag_blocks` just means it's still catching up — leave it be.

> Already synced from too far back and don't want to wait? `morphit-ops fast-forward` jumps the indexer to a recent block. **Stop the indexer first** — the command guards against this by refusing if the cursor looks live (updated in the last ~90s), and you can override with `--force` if you're sure it's stopped. It's safe before launch — there's no Morphit data in the skipped blocks yet. (It's a recovery command, not a menu item: a normal node auto-starts at the Morphit genesis block and resumes from its cursor, so you'd only need this if it was started from too far back.)


---

## 9. Register as an operator

This is the step that turns your instance from "a Morphit mirror" into "an operator that earns 90% of BLURT-paid listing fees from users who post through it."

It's a two-part job: (a) broadcast the on-chain registration so your operator identity exists, and (b) tell your instance to actually *attribute* orders to that identity. Skip step (b) and you'll register fine but earn nothing — orders posted through your frontend will go out without an operator tag and the treasury will keep 100%.

### 9.1 Broadcast the registration op

Run the operator-register CLI tool.  The CLI reads your
account, tag, display name, and contact URL from the env
files the wizard wrote in step 8 — no flags needed at the
command line:

```
cd ~/morphit
npx morphit-ops register
```

> If this returns **command not found**, you're most likely running
> it from outside the repo directory, or you haven't run `npm install`
> yet. `cd` back to the Morphit repo root (`cd ~/morphit`), make sure
> `npm install` has finished, then retry. See §12 "morphit-ops says
> command not found" for the full fix.

You'll see a confirmation showing the values that will be
broadcast:

```
  Account:      @yourblurtaccountname
  Origin:       https://yourdomain.com
  Display name: Your Display Name
  Contact URL:  https://yourdomain.com/about
  Federation tag: yourdomain.com
    (from MORPHIT_INSTANCE_OPERATOR_TAG — the same tag your
     relay uses to attribute order earnings to you)
```

The **federation tag** is the important one: it's your
instance's unique, permanent identity. It's what attributes
orders to you for fee earnings, and — once registered — what
other nodes list you under in the public `/instances`
directory and on your `/about-this-instance` page. The
register tool uses the tag you set as
`MORPHIT_INSTANCE_OPERATOR_TAG` (the wizard defaults this to
your domain, e.g. `yourdomain.com`), so the tag you register
on chain and the tag your relay earns under are guaranteed to
match. (If that variable isn't set — e.g. an older config —
the tool falls back to a slug of your display name and tells
you to set the variable so the two can't drift.)

The tool prompts for confirmation, then loads your **active**
key from `MORPHIT_RELAY_ACTIVE_KEY_FILE` (prompting for the
unlock passphrase if the keystore is encrypted), shows you
the public key that key derives to so you can sanity-check
it, and broadcasts a single `morphit_operator_register_v1` op
on chain. Your instance now appears in `/instances` on every
Morphit instance worldwide.

Once this op confirms, you're a registered operator. **You
can never reuse this tag from a different account, and the
tag is forever associated with this account on chain.**
That's by design — operators have a permanent, verifiable
identity.

If the values shown by the prompt aren't what you expected,
abort the prompt, re-run `npx morphit-ops edit` to fix the
values in `morphit.config.env`, then re-run
`npx morphit-ops register`.

**If the broadcast fails**, the tool now tells you exactly
why and what to do — it no longer prints a generic checklist.
The common cases:

- **"the tag … is reserved by the Morphit project"** — you
  chose a tag like `morphit` or `agorise` that the project
  holds back. Pick a tag that identifies your node (your
  domain is ideal) via `npx morphit-ops edit` → Operator tag,
  then re-run. (The wizard now blocks reserved tags up front,
  so you'll usually only hit this on a hand-edited config.)
- **"this account is already registered"** — you already
  registered this account. Nothing to do; check any node's
  `/instances` page to confirm you're listed.
- **"the signing key did not satisfy … posting authority"** —
  the key on disk isn't your account's active key (a common
  mix-up is saving a *posting* key instead). Run
  `npx morphit-ops show-key` to see the **public** key your
  saved key derives to (it never prints the private key), and
  compare it against the **"Active Auth"** (active authority)
  key shown for your account at
  `https://blocks.blurtwallet.com/#/@YOUR-RELAY-ACCOUNT`. If
  they differ, run `npx morphit-ops edit-active-key` and supply
  the correct active key.
- **"does not have enough mana"** — your account is low on
  mana (Blurt's transaction fuel, which comes from BLURT
  Power and refills over ~5 days). The tool tells you roughly
  how much BLURT Power to add (≈50 BP is a comfortable floor)
  and then offers to **retry in place** — power up in any
  Blurt wallet (Wallet → Power Up), come back to the prompt,
  and answer yes. No need to re-run the whole setup.

### Verifying your saved key any time

You don't have to wait for a failure to check your key. Run:

```
npx morphit-ops show-key
```

It prints the **public** key your saved active key
corresponds to (and a short masked fingerprint of the private
key — never the full key). Compare that public key against the
**"Active Auth"** key shown for your account at
`https://blocks.blurtwallet.com/#/@YOUR-RELAY-ACCOUNT`; if they
match, the right key is installed.

### 9.1.2 Managing your instance later (the menu)

You will not run the full setup wizard again — `morphit-ops
init` is a one-time, from-scratch setup, and if you run it on
an already-configured instance it stops and warns you first,
offering to open the edit menu instead of overwriting
everything.

For everything after first setup, just run the tool with no
arguments:

```
npx morphit-ops
```

On an interactive terminal this opens a menu of every action —
edit settings, **harden this server**, upgrade to the latest
version (the menu shows your installed version and the latest
available release right on that item), re-publish your
registration, the status dashboard, recent signups,
**moderation** (review abuse flags and block or unblock
accounts), key management, and more — each with a one-line
description so you pick by what you want to do, not by memorizing
command names. The Moderation item shows a `⚠ N to review` marker
when there are recent abuse flags you haven't acted on. (Every
item is still runnable directly too, e.g. `npx morphit-ops
status`; run `npx morphit-ops --help` for the full list and
flags. Scripts and cron are unaffected — piped/non-interactive
runs print the help text as before.)

**Moderation is instance-local.** From the Moderation screen (or
directly with `npx morphit-ops block <account> "reason"` /
`npx morphit-ops unblock <account>`) you can hide a misbehaving
account's listings on *your* instance. It is reversible, needs no
posting key, and broadcasts nothing to the chain — the account
stays on Blurt and remains visible on every other Morphit
instance; your block applies only to what your instance serves.
(A blocked seller is also dropped from the median behind your
instance's own derived price feed, so they can't skew the price
you compute from your orderbook.)
The blocked user sees a banner explaining that, with a Matrix
link to appeal. Full details, plus the abuse signals behind the
flags, are in OPERATIONS.md §6a.

**Hardening is its own wizard.** Securing the host — SSH
lockdown, firewall, fail2ban, automatic security updates, TLS,
an optional BunkerWeb WAF, and daily database backups — is the
most important thing you do before going public, so it has a
dedicated, re-runnable flow:

```
npx morphit-ops harden
```

(or pick **Harden this server** from the menu). It generates a
**personalized `morphit-hardening-checklist.md`** with your
domain and your BunkerWeb-vs-nginx choice baked in, sequenced in
a safe order (it leads with the SSH-lockout rule: add your key
and test it in a second terminal *before* disabling password
login), and it can walk you through each piece on screen. None
of it is Morphit-specific — it is the baseline every
internet-facing Ubuntu box needs — and everything it describes
is already shipped in the repo (the Ansible role in
`ops/ansible/`, the nginx + BunkerWeb configs, the backup
units). Full reference: OPERATIONS.md §34 (UFW + fail2ban), §35
(TLS), §37 (the complete hardening role).

**One rule worth remembering:** your **origin** and **operator
tag** are part of your on-chain registration — the record other
Morphit instances read to list you in their `/instances`
directory. If you change either one with `morphit-ops edit`,
the edit updates your *local* config, but the rest of the
federation won't see it until you re-publish:

```
npx morphit-ops register
```

`morphit-ops edit` now reminds you of this automatically right
after you change your origin or tag, so you don't have to keep
it in your head. Changing anything else (description/SEO, RPC
URLs, fees) is local-only — no re-register needed, just the
service restart the tool tells you to run.

### 9.2 Wire your instance to attribute orders to your tag

The wizard already wrote `MORPHIT_INSTANCE_OPERATOR_TAG` for
you (defaulting to your domain). This is the SAME tag the
register step above publishes on chain, so they match by
construction. If you're configuring by hand, add this line to
your `ops/env/indexer.env` (or wherever you keep your
instance-config env vars):

```
MORPHIT_INSTANCE_OPERATOR_TAG=yourtag
```

Replace `yourtag` with the same tag you registered above. Restart the indexer (`docker-compose restart indexer` or `systemctl restart morphit-indexer` depending on how you run it).

What this does: every order op the post-form on your frontend builds will now carry `operator_tag: "yourtag"` in its payload. When that order's listing fee is verified, the indexer credits 90% of the fee to the account that registered `yourtag` — that's you. The transfer is queued immediately and the relay broadcasts it on its next cycle (~5-10 seconds).

### 9.3 How earnings actually flow to you

Within ~10–15 seconds of a user clicking "Post" on your frontend (and their order op landing on chain):

1. Your indexer sees the order op, verifies the BLURT listing fee transfer.
2. The attribution module looks up your tag in the `operators` table, confirms `is_active = TRUE`, and computes your 90% share with floor-rounding to 3 decimals (BLURT chain precision).
3. A row gets queued in `relay_pending_transfers` with the transfer details.
4. The relay's queue drainer (already running for welcome bonuses) picks up the row on its next cycle, signs and broadcasts a normal Blurt `transfer` op from `morphit-relay` to your account.
5. The BLURT lands in your wallet. You can power it up, vote with it, send it to an exchange, anything.

You can monitor your earnings at any time:

```
curl http://localhost:8081/v1/operators/yourtag
```

(The indexer's default listen port is `8081`; the relay's is
`8080`.  `/v1/operators/...` lives on the indexer.)

The response includes:
- `cumulative_blurt_earned` — lifetime credit (sum of all attributed shares)
- `lifetime_paid_blurt` — lifetime BLURT actually queued for transfer
- `total_orders_attributed` — count of orders that paid through your tag
- `last_payout_at` / `last_payout_blurt` — most recent attribution event

Or, from any Morphit frontend that shows your operator profile, the same numbers appear in the public operator-directory entry.

### 9.4 What happens if attribution fails

The attribution path is robust to several failure modes:

- **Tag mismatch / typo in env var.** The indexer's lookup returns 0 rows and the order goes through with no attribution — same as if no tag was configured. The treasury keeps 100%. You'll see this if you forgot to register, registered with a different tag, or have a typo in `MORPHIT_INSTANCE_OPERATOR_TAG`. Cross-check the value in your env against the `tag` column of your row in the `operators` table.

- **Operator marked inactive.** If your operator row has `is_active = FALSE` (a future deactivation feature; not currently available via CLI), new attributions skip you. Existing earnings already paid stay paid.

- **Relay broadcast fails.** If the relay can't broadcast the transfer (network, mana, your account doesn't exist), the row stays in `relay_pending_transfers` with `last_error` set. The indexer's earnings accounting on its side is correct (it credited your `lifetime_paid_blurt` at queue time); the relay drainer will retry on its next cycle. Persistent failures show up in `monitor` output and your error logs.

### 9.5 Why this beats the alternatives

Other federated marketplaces typically use either monthly invoicing (operator submits a payout request, project manually transfers) or claim-balance ops (operator broadcasts a claim op to pull accumulated earnings). Both delay the operator's gratification.

Morphit's immediate-per-order payout works because Blurt has 3-second blocks and effectively zero per-transfer fees (mana-based). The relay account's mana easily covers dozens of micro-transfers per day. Operators see real BLURT in their wallets within seconds of users clicking "Post" — closer to a card-processor's instant-settlement experience than to a typical platform's "we'll Venmo you next month."

### 9.6 Federation-cost attribution: only YOU pay for YOUR ops

Pre-Part-111, every operator's relay queued payouts on every chain-op it saw — meaning if you and I both ran indexers, and a user on your instance triggered a welcome bonus, BOTH our relays would queue and broadcast that 20 BLURT. The federation paid 2× (or N× for N operators) for every payout-triggering op.

Part 111 closes this. The gate is the same `MORPHIT_INSTANCE_OPERATOR_TAG` you set in step 9.2 above. Every payout queue insert in the indexer now checks: "does this op's `operator_tag` match MY operator tag?" If yes, queue it. If no, skip — the operator named on the op is the one obligated.

Four payout categories are gated:

| Payout | When it fires | Gate |
|---|---|---|
| Welcome bonus (20 BLURT, 10 liquid + 10 vesting) | First feedback citing a real order | Cited order's `operator_tag` matches MY tag |
| Low-balance dust refill (~1 BLURT) | Scanner finds active user below threshold | User's recent orders attribute to MY tag |
| Operator-payout (90% of BLURT fee) | `morphit_order_v1` with `operator_tag` | Op's `operator_tag` matches MY tag |
| Loyalty milestone BP delegation | Cumulative-BLURT-paid crosses threshold | Order's `operator_tag` matches MY tag |

(Account creation is the 5th payout. It's the only one not gated here — it's already correctly scoped because it's an HTTP endpoint on the relay, so only the operator the user hit pays.)

**What stays consistent across the federation** (NOT gated — every indexer agrees on these):

- `orders` table contents
- `feedback` table contents
- `account_loyalty.cumulative_blurt_paid` per user
- `account_loyalty_milestones` rows
- `accounts.first_trade_complete_at` per user
- `operator_attribution_events` rows

This matters because the orderbook + audit trail + loyalty accounting must look the same on every indexer in the federation. Only the **payout queue** is per-operator.

**Conservative default**: if `MORPHIT_INSTANCE_OPERATOR_TAG` is unset, your relay queues NOTHING. Better to pay nothing than to pay for ops you can't prove are yours. A community operator who skips step 9.2 will see their indexer running fine (orderbook updates, chat works, fee verification works) but their relay queue will be empty. Cross-check the env var if this happens.

**Verify the gate works**: post a test order through your instance (use a trusted contact's account, pay the BLURT fee), then leave feedback citing the order. Within ~15 seconds you should see:

```
SELECT recipient, kind, amount_blurt, amount_bp, reason
  FROM relay_pending_transfers
 WHERE recipient = '<test account>'
 ORDER BY created_at DESC;
```

Expected rows: `welcome_bonus_liquid` (10 BLURT), `welcome_bonus_vesting` (10 BLURT), `first_listing_fee_welcome` (1 BP delegation), `operator_payout:<trxid>` (the 90% share to your operator account).

If you see none of these, the most likely cause is `MORPHIT_INSTANCE_OPERATOR_TAG` not matching the `operator_tag` on the order op. The order op gets its tag from `/v1/instance.operator_tag` which is exposed from the same env var, so as long as the var is set consistently (both indexer + frontend reading from the same morphit.config.env), they'll match.

For a deeper walkthrough see `docs/OPERATIONS.md` §41.

---

## 10. Backups

**Do this before anything bad happens, not after.**

> **Special note for home hosters:** if your Morphit machine is in your house, the off-site backup step below is **not optional** — it's the difference between "server died, restore took 2 hours" and "house fire, lost everything, can't recover." For VPS operators it's mostly insurance against datacenter failures (rare). For home operators it's insurance against fires, floods, theft, and the kid spilling juice on the laptop. Schedule the off-site copy step (§10's "Off-server replication" subsection below — covered in OPERATIONS.md §31) within the first week.

### What to back up

Three things:

1. **Your Blurt seed phrase** — already done in step 6. Paper, ink, safe place. Two copies in two locations is the gold standard for valuable seeds.

2. **Your `ops/env/*.env` files** — these contain your DB password and your relay's active key. Keep an encrypted copy somewhere off-server.

3. **The PostgreSQL database** — daily snapshots in case the server has a disk failure.

### Daily DB backup

The indexer's database is rebuildable from the Blurt blockchain in case of total loss, but a same-day snapshot saves you hours of catch-up time when you actually need to recover. Set this up once and forget it.

Once it's running, you can confirm it any time without digging through the filesystem: `npx morphit-ops status` (or the **Status dashboard** menu item) ends with a **Backups** section showing the backup directory and your **last 3 backup files** with their age and size — the quick "are my backups actually happening?" check. It also prints the path so you can grab a file to download or send to a developer if you ever need help. (See OPERATIONS.md §31.)

#### Did you run `morphit-ops init` and answer Yes to backup automation?

If yes, you already have everything in the repo — `ops/backup/morphit-backup.sh`, `ops/backup/backup.env`, `ops/systemd/morphit-backup.service`, and `ops/systemd/morphit-backup.timer`. The wizard printed the install commands at the end of init; run them, then `sudo systemctl enable --now morphit-backup.timer`, and you're done. (If you didn't save them, the same commands are in the manual recipe below.)

If you're not sure whether the wizard wrote `ops/backup/backup.env`, check:

```
ls -l ops/backup/backup.env
```

If it exists, the wizard handled it. If not, run `morphit-ops init` again and answer Yes at the backup step (your existing config files won't be touched if you answer No to the "write configuration" review prompt — only the backup section gets generated when you confirm).

#### Manual recipe (for non-wizard installs)

If you want to set up backups manually, or you skipped the wizard, here's what to do.

The shipped script at `ops/backup/morphit-backup.sh` does the local backup loop:
pg_dumps the DB, gzips it, optionally encrypts it with age (when
`AGE_RECIPIENT` is set in `backup.env`), optionally rsync-pushes the result
to an off-site host (when `REMOTE_DESTINATION` is set), and prunes old
backups by age.  All four are independently configurable — leaving the
optional env vars unset gives the simple gzip-locally behaviour; setting
`AGE_RECIPIENT` alone gives encrypted local backups; setting both gives
encrypted-and-pushed off-site backups.  See `ops/backup/backup.env.example`
for the full list with REQUIRED/OPTIONAL labelling.

Make it readable by your morphit system user:

```
chmod +x ops/backup/morphit-backup.sh
```

Copy the example config and edit it:

```
cp ops/backup/backup.env.example ops/backup/backup.env
# edit BACKUP_DIR and RETAIN_DAYS to taste; optionally set
# AGE_RECIPIENT for encryption and REMOTE_DESTINATION for off-site push
```

Install the config to `/etc/morphit/backup.env` (root-owned, 600):

```
sudo install -m 600 -o root -g root ops/backup/backup.env /etc/morphit/backup.env
```

Install the script itself to a stable path. The systemd unit's `ExecStart` points at `/usr/local/lib/morphit/morphit-backup.sh`, NOT the repo path — this way the unit works regardless of where you checked out the repo (could be `/home/morphit/morphit`, could be `/opt/morphit`, could be anywhere):

```
sudo install -d -m 755 /usr/local/lib/morphit
sudo install -m 755 ops/backup/morphit-backup.sh /usr/local/lib/morphit/
```

When you `git pull` and the script changes, re-run just the second command above to update the installed copy. The script reads `/etc/morphit/backup.env` at runtime, so config changes don't require a re-install.

For pg_dump to authenticate without prompting, the `morphit` system user needs a `~/.pgpass` file:

```
echo 'localhost:5432:morphit_indexer:morphit_indexer:YOUR-DB-PASSWORD' > ~/.pgpass
chmod 600 ~/.pgpass
```

(If you used socket authentication / peer auth during `init.sql`, the system user matches the DB user and `pg_dump` works without a password — in that case you can skip `~/.pgpass`.)

Install the systemd units and enable the timer:

```
sudo install -m 644 ops/systemd/morphit-backup.service /etc/systemd/system/
sudo install -m 644 ops/systemd/morphit-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now morphit-backup.timer
```

Check that the timer is registered:

```
systemctl list-timers morphit-backup.timer
```

You should see a row showing `morphit-backup.timer` and a `NEXT` time around 04:00 local. By default it runs every night at 04:00 with up to 30 minutes of randomized delay (so a fleet of operators doesn't all hit Blurt RPC nodes at exactly the same instant), writes a gzipped snapshot to `/home/morphit/backups/`, and prunes anything older than 30 days. Files are chmod 600 so other local users can't read them.

If you'd rather use cron, the script works there too. Replace the systemd setup with:

```
crontab -e
```

```
0 4 * * * BACKUP_ENV=/etc/morphit/backup.env /usr/local/lib/morphit/morphit-backup.sh
```

The systemd version is recommended because failures land in `journalctl -u morphit-backup.service` alongside the rest of your Morphit logs.

#### Verifying

A few days after enabling, check that backups are landing:

```
ls -lh /home/morphit/backups
```

You should see one file per day, each in the 50–500 MB range depending on indexer activity. To verify the dumps are actually restorable, periodically (once a quarter is reasonable) restore the most recent backup to a throwaway database and diff the orderbook count against production:

```
gunzip < /home/morphit/backups/morphit-YYYYMMDD-HHMMSS.sql.gz | psql morphit_indexer_test
psql morphit_indexer_test -c "SELECT COUNT(*) FROM orders WHERE expired = false"
psql morphit_indexer      -c "SELECT COUNT(*) FROM orders WHERE expired = false"
```

The two counts should be within ±1 (some orders may have expired between the snapshot and "now").

#### Off-server copies

The setup above keeps a 30-day rolling local backup. If the server burns down, you lose those too. Pick one or more of:

- **rsync built into the backup script** (simplest — set `REMOTE_DESTINATION` and `SSH_KEY` in `/etc/morphit/backup.env` and the nightly run pushes after writing the local snapshot; encrypts first if `AGE_RECIPIENT` is also set)
- **Separate rsync to a second host** (use this when you want a different schedule or a different destination than the main script's)
- **rclone to S3, B2, or any object store** (best for off-network durability; runs as a separate timer)
- **Periodic manual download** if you SSH to the server anyway

The simplest path is to use the script's built-in rsync — set both
`REMOTE_DESTINATION=user@backup-host:/path/to/morphit/` and `SSH_KEY=/home/morphit/.ssh/morphit-backup` in `backup.env`, ensure the morphit user has a passwordless SSH key authorized on the destination, and the nightly timer takes care of it. Verify the recipe works by running the script once by hand: `sudo systemctl start morphit-backup.service` then check the destination host.

For a separate rsync (different cadence or destination), add a cron entry:

```
30 4 * * * rsync -az --delete /home/morphit/backups/ user@backup-host:/path/to/morphit/
```

Note: **the database is technically rebuildable from the Blurt blockchain.** If you have nothing — no backup, no off-server copy, server gone — you can spin up a new server, point a fresh indexer at chain block zero, and let it rebuild. This takes hours but works. The local + off-server backup just saves you those hours and preserves the read state / federation cache / engagement aggregates that are derived but not directly chain-stored.

---

## 10b. How often will I touch this thing?

Short version: **once per month is the design target**, and most weeks you should be doing zero. Here's where the time goes:

- **Indexer + relay + frontend services**: zero touch. They auto-restart on failure (systemd), TLS certificates auto-renew (certbot timer), they auto-apply schema migrations on deploy, and the indexer auto-recovers from blockchain reorgs. If something is on fire your monitor will tell you.

- **OS package updates**: install `unattended-upgrades` (the `ops-cli init` system check tells you if it's missing) and security patches install themselves. You don't have to do anything.

- **Weekly ACT minting**: the relay needs ~25 fresh Account Creation Tokens per week to handle new signups. **Set this up on a systemd timer once and forget it.** See `OPERATIONS.md` §2 → "Unattended mode". After the one-time setup (5 minutes), the timer fires every Sunday at 04:00 UTC and you don't think about it again. If you skip the timer, you're SSH-ing in once a week to run the mint script — that's the previous default and it works, but it's the only thing pushing you above the once-per-month bar.

- **Relay BLURT top-up**: already automated as a `recurrent_transfer` from your funding account (set up once during step 8 → "Configure the relay"). Fires weekly without you. Quarterly you check that the funding account itself isn't running low — that's a one-minute glance at a Blurt wallet.

- **Operator-balance alerts**: §16 of OPERATIONS.md. Set up once; the scanner emails/pings you when something's low. You only act when it pings.

- **Updating the Blurt RPC endpoint list**: ad-hoc. When a community RPC node goes offline (witness retired the node, server moved, geo-filter started misfiring) or a new one comes online, you'll want to refresh your indexer's list. Easy way:
  ```sh
  cd /opt/morphit
  npm exec --workspace apps/ops-cli morphit-ops -- edit
  ```
  Pick "Blurt RPC endpoints" from the menu, paste the new comma-separated list, confirm. The wizard validates each URL, backs up your previous `morphit.env`, writes atomically, then **offers to restart the indexer for you** (just press Enter) so the new endpoints take effect. Watch `journalctl -u morphit-indexer -f` on restart — if the indexer fails to connect it'll log which endpoint refused, fix that one, and try again.

- **Once-per-month review**: glance at `journalctl -u morphit-relay-mint-acts` (did the timer fire successfully every Sunday?), glance at the witness-fee-divergence log, glance at your nightly backup directory. ~5 minutes total. If everything's normal, you do nothing.

If you find yourself touching the instance more often than monthly for routine maintenance, file a bug — we want to know what we missed. Operators staying engaged long-term is the entire reason Morphit can exist as a federation.

---

## 11. Recommended hardening (optional but encouraged)

Everything in §1–§10 gets you to a running, public Morphit instance with TLS, a firewall, and automated backups. **That's already a perfectly secure setup for typical traffic.** This section is for operators who want extra layers — none required, all optional. Each subsection is a brief overview with a pointer into `docs/OPERATIONS.md` for the full reference.

### Already covered in this guide

- ✅ **UFW firewall** — basic 22/80/443 setup in §5. For SSH rate-limiting, IPv6, and going-deeper hardening, see `OPERATIONS.md` §34.
- ✅ **fail2ban** — installed and enabled by default in §5. For tuning bans, adding a Morphit-relay filter, and avoiding self-lockout, see `OPERATIONS.md` §34.
- ✅ **TLS auto-renewal** — certbot installs a renewal timer automatically. Quarterly verification + troubleshooting in `OPERATIONS.md` §35.
- ✅ **Daily DB backups** — wizard sets this up by default. Off-server replication patterns + restore drill in `OPERATIONS.md` §31.
- ✅ **Signup-drain defense** — 6-layer defense stack (kill-switch, daily ceiling, per-IP spacing, signed invites, Altcha PoW, anomaly alerts) is built into the relay. Tuning in `OPERATIONS.md` §18.

### Recommended additions

#### Extra private addresses — Tor / Lokinet / I2P (one wizard does it)

Besides your normal web address, you can give people a *private* way to reach your instance over Tor, Lokinet, or I2P. Each one shows up as a little pill in your site footer. This is optional — your normal address works fine on its own — but it's the most on-brand thing you can add.

You don't have to know how any of these networks work. Run:

```
npx morphit-ops
```

…and pick **"Set up a Tor / Lokinet / I2P address"** (or run `npx morphit-ops alt-address` directly). It walks you through it in plain English. The short version:

- **Tor (`.onion`)** and **I2P (`.b32.i2p`)** — you can pick the **first few letters** of your address. A helper tries random keys until it finds one that starts with your letters (short = seconds, long = much slower). You run that helper **on your own computer, not the server**, so the secret key is born somewhere you control; then you copy the key to the server over SSH and paste the address into the wizard. The helpers are `scripts/generate-onion.sh` and `scripts/generate-i2p.sh`.
- **Lokinet (`.loki`)** — you **can't** pick the letters; Lokinet makes the address for you. You just add one `keyfile=` line to `lokinet.ini`, restart Lokinet, and paste the `.loki` it prints. Want a short, readable name like `yourname.loki`? That's **ONS** — you buy it with OXEN coin in the Oxen wallet (optional, costs money). The `scripts/generate-lokinet.sh` helper prints these steps.

After you paste an address, the wizard saves it and **offers to restart the indexer for you** (just press Enter) so the change goes live. Reload your site and the new footer pill appears — no manual restart needed. The secret keys are **never** committed to the repo. Full reference (env vars, exact mechanics, why Lokinet differs): `OPERATIONS.md` §23.


#### BunkerWeb — recommended WAF (canonical config shipped)

[BunkerWeb](https://www.bunkerweb.io) is an AGPLv3 reverse-proxy WAF.  Adds OWASP Top-10 protection, bot detection, GeoIP filtering, per-AS rate limiting, and behavioral DDoS mitigation in front of your Morphit stack.  Recommended for **any public-facing instance**.

The morphit repo ships a turnkey BunkerWeb deployment at `ops/bunkerweb/` — paralleling `ops/nginx/` and `ops/systemd/`.  Copy to `/etc/bunkerweb/`, edit the operator-tunable values (your domain, ASN block list if any), `docker compose up -d`.  The shipped compose serves the **whole site**: a small `frontend` nginx container serves your static build (mounted read-only from `/opt/morphit/apps/web/build`) AND proxies the API (`/v1/`, `/relay/`, `/rss/`) to the relay + indexer, with BunkerWeb in front for TLS + WAF — so you don't run a separate host nginx, and the relay/indexer bind bridge-reachable (not loopback-only).  The compose pins a `172.20.0.0/16` Docker network so the relay's `MORPHIT_RELAY_TRUSTED_PROXY_IPS` can be hard-coded without re-inspecting after rebuilds.  See `ops/bunkerweb/README.md` for the Quick Start.

Operators using the Ansible playbook get this deployment automatically.

Skip BunkerWeb only if:

- You're running a small private instance with a single-operator audience.
- Tor-only or Lokinet-only deployment (squatters don't route through anonymity networks; .onion has natural friction).
- Resource-constrained VPS (<1 GB RAM) — BunkerWeb + scheduler add ~150–250 MB resident.

Full configuration reference, architecture options (BunkerWeb instead of nginx vs. in front of nginx), and Morphit-specific tuning (the `/relay/v1/*` and SSE endpoints) in `OPERATIONS.md` §32.

#### Matrix alerting — recommended bot sidecar

`apps/matrix-bot/` is a turnkey sidecar that tails journalctl, classifies indexer + relay alerts into three tiers (CRITICAL / WARN / INFO), and DMs them to the operator's private Matrix MXID over E2E-encrypted private chat.  Strongly recommended for any operator running a public-facing instance — silent operator-account drain or a stuck signup queue is exactly the kind of thing email alerts get filtered into oblivion.

Three tiers, designed to never spam:

- **CRITICAL** — immediate, no rate limit: tamper detection, kill-switch fired, sustained RPC failure, daily ceiling hit, fee_method violation attempt, backup failure, AIDE integrity violation, operator account at 0 BLURT.
- **WARN** — 1/hour per category: balance crossings above zero, witness fee change, stale price feed, single-IP signup spike, federation peer down >24h, sequential pattern detected.
- **INFO** — daily 09:00 UTC digest, skipped on quiet days: RECOVERED events, normal backups, federation discovery.

The bot is **installed by default but stays inert until you give it an alert username** — nothing runs on an instance that doesn't use Matrix. Two distinct Matrix knobs (the codebase enforces the `@user`-vs-`#room` split at compile time + at every boundary via adversarial smoke):

- `MORPHIT_MATRIX_BOT_ALERT_MXID` — your PRIVATE MXID for operator alerts (`@user:server`; comma-separate multiple for vacation coverage). This is the matrix-bot's lifecycle switch: set it with **`morphit-ops matrix set @you:matrix.org`**, which writes it to `/etc/morphit/matrix-bot.env` (the bot's OWN env file — it does NOT read `morphit.config.env`) **and** enables + starts the bot. `morphit-ops matrix clear` empties it and stops + disables the bot; `morphit-ops matrix` shows the username, readiness, and service state; **`morphit-ops matrix test`** DMs you a one-off labelled test alert to confirm delivery actually works (no journal dance — it triggers the running bot's own client); and `sudo morphit-ops upgrade` re-checks the field on every upgrade and starts/stops to match. The bot also needs `MORPHIT_MATRIX_BOT_ACCESS_TOKEN` (a dedicated bot account's token) in that same file; with a username set but no token, the bot stays stopped with a hint instead of crash-looping. PRIVATE — never exposed via the public API.
- `MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM` — a PUBLIC group room alias (`#room:server`), set at `morphit-ops init` time and editable in `morphit.config.env` (the indexer reads it). Surfaced on `/support`, `/about-this-instance`, and the site footer so users can contact the operator publicly. Distinct from the alert MXID.

Setup + the full alert-tier policy + vacation coverage advice in `OPERATIONS.md` §16 "Canonical Matrix routing — apps/matrix-bot".  Once it's running, you can confirm an alert actually reaches you end-to-end (not just that the bot started): the quickest way is **`morphit-ops matrix test`**, which DMs you a labelled test alert through the bot's real client; the one-time **"Verifying end-to-end delivery"** runbook in that same section additionally exercises the journal→classifier half of the path. Either way you should get a DM within seconds.  If `npm audit` flags critical vulnerabilities for your install, those trace through `matrix-bot-sdk@0.7.1`'s deprecated `request` dependency — OPERATIONS.md has the full risk analysis under "matrix-bot — known dependency vulnerabilities" (TL;DR: matrix-bot is outbound-only and opt-in, so the practical exposure is near-zero, but expect automated CVE scanners to flag it).

#### Host-resource monitoring — disk / memory / swap / CPU

A companion to the matrix-bot.  `ops/scripts/morphit-host-monitor.sh` is a POSIX-sh sidecar that runs every 5 minutes via a systemd timer, polls `/proc/meminfo` + `df` + `/proc/loadavg` + `/proc/vmstat`, and emits structured JSON to journalctl when host-level thresholds are crossed.  The matrix-bot picks them up automatically because `morphit-host-monitor.service` is in the default `MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS` list — no extra wiring required.

What gets alerted (all thresholds env-tunable in `/etc/morphit/host-monitor.env`):

- **Disk** — INFO >70%, WARN >85%, CRITICAL >95% (per mount; default `/` only)
- **Memory** — INFO >70%, WARN >85%, CRITICAL >95% used
- **Swap usage** — INFO >25%, WARN >50%, CRITICAL >75% used
- **Swap thrashing** — WARN >100 pages/sec, CRITICAL >1000 pages/sec (delta tracked across runs)
- **CPU saturation** — INFO >1.5x cores, WARN >3x cores, CRITICAL >5x cores (1-min load average)

Each alert ships with ELI5 advice in the DM (e.g. mem_critical says "the OOM killer will start killing processes soon — check `ps aux --sort=-%mem | head -10`").

Opt-in default — if you don't `systemctl enable --now morphit-host-monitor.timer`, the sidecar doesn't run and no host-resource alerts fire.  Same opt-in promise as matrix-bot.

Full setup procedure + threshold tuning + adding extra mount points in `OPERATIONS.md` §16 "Host-resource monitoring sidecar".

#### Extended monitoring — disk SMART, fail2ban, RAID

Three more sidecars in the same pattern, each opt-in via their own systemd timer:

- **`morphit-smartctl-monitor`** — disk SMART health every 6h.  Alerts on SMART overall-health FAILED, failed self-tests, high temperature, reallocated/pending sectors.  Also scrapes the SCT thermal log (`smartctl -l scttempsts`) for drives that hit WARN+ at some point in their lifetime even if cool now, and drives whose own firmware has flagged thermal stress.  Requires `apt install -y smartmontools`.  Useful for bare-metal; less useful on VPS providers that virtualize disks.
- **`morphit-fail2ban-monitor`** — fail2ban jail observability every 5 min.  Alerts CRITICAL if the fail2ban daemon is unreachable (meaning brute-force is no longer being blocked), WARN if any jail's currently-banned IP count spikes (active attack indicator).  Requires fail2ban itself (installed by base hardening §5).
- **`morphit-mdadm-monitor`** — Linux software RAID health every 15 min.  Alerts CRITICAL on array_failed / array_degraded, INFO on array_resyncing.  No package install required (`/proc/mdstat` is in the kernel).  Safe to enable defensively even on hosts without RAID — exits silently.
- **`morphit-dmesg-monitor`** — kernel ring buffer scan every 5 min for OOM-killer activations, kernel oopses/panics, hardware errors (MCE/EDAC/ATA), and segfaults.  Cursor-based state so successive runs don't re-alert on old events.  Critical complement to the host-resource monitor: host-monitor sees memory pressure *building*; dmesg-monitor sees what got killed when it broke.
- **`morphit-trivy-monitor`** — daily Docker image CVE rescan for CRITICAL + HIGH vulnerabilities.  Installs trivy from the Aqua Security apt repo.  Most useful with the BunkerWeb deploy path; useless on bare-metal-only.  Without this you wouldn't know your BunkerWeb container had unpatched CVEs until you happened to read an advisory.
- **`morphit-postfix-monitor`** — mail queue depth + oldest-message age every 15 min.  Catches silent operator-alerting failures: if your smarthost credentials rotated or TLS bumped, emails pile up in postfix and you'd never know.  This sidecar makes "alerts aren't arriving" itself an alert.
- **`morphit-certbot-monitor`** — TLS cert expiry + renewal-stall detector.  Daily check.  Catches the killer pattern most monitoring stacks miss: cert renewing fine for months silently starts failing for weeks before it expires.  This sidecar fires CRITICAL if a cert is expiring AND certbot has not had a successful renewal in 14 days — long before expiry actually breaks your site.
- **`morphit-apt-monitor`** — daily count of pending security updates.  Surfaces what the motd line shows but operators stop reading.  CRITICAL at ≥10 pending security updates.  Debian/Ubuntu only.
- **`morphit-compose-monitor`** — Docker Compose service health-check status + restart-loop detector every 5 min.  Most useful with the BunkerWeb deploy path (§32); useless on bare-metal-only (sidecar exits cleanly with INFO event in that case).
- **`morphit-systemd-monitor`** — systemd unit health every 5 min.  Watches morphit-* units for "failed" state + high restart counts.  Closes a gap journalctl-based alerting can't cover: a unit that fails to start emits no journal output.
- **`morphit-journald-monitor`** — daily journal disk usage + rotation health.  Catches the "journal silently grew to 8 GB over six months until disk full" pattern most operators only find when it's too late.

Full setup procedure + threshold tuning + per-jail overrides in `OPERATIONS.md` §16 "Extended monitoring sidecars".

#### Automated deployment via Ansible

The repository ships a tested Ansible playbook at `ops/ansible/` that automates everything in §1–§9 of this guide plus all the optional sidecars.  Roles: `base`, `hardening`, `tls`, `postgres`, `morphit`, `bunkerweb`, plus opt-in sidecar roles `matrix_bot`, `host_monitor`, `smartctl_monitor`, `fail2ban_monitor`, `mdadm_monitor` (all default off; set `enable_*: true` in `group_vars/all.yml`).

Quick start:

```sh
cd /opt/morphit/ops/ansible
# 1. Configure inventory (one or more hosts).
cp inventory/hosts.yml.example inventory/hosts.yml
$EDITOR inventory/hosts.yml

# 2. Configure non-secret vars.
$EDITOR group_vars/all.yml

# 3. Configure secrets in an encrypted vault.
cp group_vars/vault.yml.example group_vars/vault.yml
$EDITOR group_vars/vault.yml         # fill real secrets
ansible-vault encrypt group_vars/vault.yml

# 4. Run.
ansible-playbook -i inventory/hosts.yml playbook.yml --ask-vault-pass
```

Run with `--tags monitors` to add monitoring to an already-deployed instance without touching the rest.

#### Docker

If you already use Docker for everything else, you can run Morphit's indexer + relay + web + Postgres in containers. Same monorepo, just a `docker-compose.yml` you write once. Trade-offs (consistency vs. backup complexity) and a tested compose shape in `OPERATIONS.md` §33.

For first-time operators: stick with the bare-metal install from §1–§9. Docker is for when you've got a fleet to standardize.

#### Stronger UFW + fail2ban tuning

The defaults from §5 are fine. If you want:

- SSH rate-limiting (`ufw limit 22/tcp` instead of `ufw allow 22/tcp`)
- A Morphit-specific fail2ban filter that bans IPs sending repeat `429`s on `/v1/account/create`
- Lockout-prevention rules for your own admin IP

…all in `OPERATIONS.md` §34.

#### Comprehensive server hardening (defense-in-depth)

`OPERATIONS.md` §37 is a copy-pasteable, 19-subsection hardening checklist for everything BELOW the application layer: SSH, kernel sysctls, /tmp mount options, systemd unit isolation (ProtectSystem, NoNewPrivileges, capability dropping), auditd, AppArmor, Postgres SCRAM + pg_hba + per-database `statement_timeout`, AIDE filesystem integrity, secrets file 0600 + age encryption, LUKS full-disk encryption, encrypted backups, outbound egress allowlist, alerting, rootkit scanners, GRUB password, password discipline.  Finishes with §37.18 (final attack-vs-defense map showing which subsection blocks each attack class) and §37.19 (concrete copy-pasteable verification commands that prove each defense actually fires — `nmap` for network surface, the X-Forwarded-For spoof test for the trusted-proxy CIDR gotcha, `aide --check`, etc.).  The threat model assumed: a determined attacker who has read every line of Morphit's public source and is now probing the host itself. Each subsection independently improves posture; apply in order, test with §37.19, stop when you hit your operational risk tolerance.

The README of §37 spells out which attack each defense blocks, with severity notes about which subsections are aspirational vs. baseline. Recommended baseline for any public Morphit instance: §37.1 (SSH hardening), §37.2 (unattended security upgrades), §37.3 (kernel sysctl), §37.6 (auditd), §37.8 (Postgres SCRAM), §37.10 (secrets file perms), §37.14 (msmtp for alerting). Everything else is operator's-call.

#### The active key on disk — your single highest-value secret

The relay holds your `@morphit-relay` (or whatever you named it) **active private key in a file on disk** — that's how the relay signs account-creation, welcome-bonus, and reward-payout transactions on the chain. This is your single highest-value secret on the system. If an attacker reads it, they drain your BLURT balance and reassign your delegated BP.

`OPERATIONS.md` §37.10.1 ("The relay's active key — your single highest-value secret") is a 7-point sysadmin checklist specifically for this key:

1. Verify file mode `0400`, owned by `morphit-relay` user
2. Use the encrypted-envelope form (`apps/relay/scripts/encrypt-active-key.ts` migrates a bare WIF to a passphrase-encrypted envelope; the relay prompts for the passphrase at first boot and holds it in memory thereafter)
3. Confirm §37.5 systemd hardening is in effect (process memory protection)
4. Optional but high-value: AppArmor profile (§37.7) confines the relay to JUST the key file + env file + IPC socket — an RCE in the HTTP layer can't read `/etc/passwd`
5. UFW egress allowlist (§37.13) prevents an attacker with code-execution from `curl`ing the active key out
6. Backups encrypted (§37.12) — never include the bare WIF in an unencrypted backup
7. **Owner key NEVER on the server** — it stays on paper, in a safe, off any networked machine. Without offline owner-key access you cannot rotate the active key after a compromise. This is the single most important sysadmin discipline.

Read §37.10.1 the first time you set up a relay AND any time you migrate to a new server. The 2026-05-07 audit (`SECURITY.md` §1b) was browser-side; the operator-side equivalent of those user-facing protections IS §37.10.1.

#### Diamond-hardened squatter defense

`OPERATIONS.md` §38 is the tactical guide for locking down against name-squatters specifically. Squatter-driven account creation is the **single largest financial risk** to a Morphit relay — every successful squatter signup costs the relay ~100 BLURT regardless of who's behind it. §38 covers: strict configuration of every squatter-relevant env var (Layers 7-8 of the signup-drain stack), monitoring the structured rejection logs, recognizing the five attacker patterns, weekly audit of recent registrations, incident-response procedure when an attack is suspected, and a copy-pasteable "diamond-hardened" preset for operators willing to accept moderately higher friction in exchange for maximum squatter resistance. Read this BEFORE going public if you're at all worried about squatters; the BLURT you save will be your own.

#### Weekly warrant canary

Morphit ships a weekly warrant canary at `/canary.txt` declaring you have not received an NSL / FISA / gag-order / backdoor demand. Freshness proofs from the Blurt + Bitcoin chain heads + a current news headline. PGP-signed by your release key.

Setup is one cron line and four env vars; full walkthrough in `OPERATIONS.md` §36. Worth doing because:

- Users CAN'T verify the absence of demands you've received — the canary is the only mechanism that lets them notice silently
- A federation full of canary-publishing operators is hard to suppress: a coordinated takedown shows up as silence across many operators simultaneously
- Operators who skip the canary are still legitimate — there's no on-chain enforcement — but users have less assurance about you specifically

If you're served with a gag order: don't lie. Stop updating. Users notice and switch operators. The federation is designed for exactly this case.

### What none of these prevent

The Blurt protocol itself charges ~100 BLURT per new account, and **your relay pays that cost** on the user's behalf — that's the whole reason the relay exists. From an attacker's perspective, signing up is free; from your perspective, every account creation costs your relay ~100 BLURT. The brake on squatting isn't that it costs the attacker anything — it's that your relay's balance is finite, and the §18 signup-drain defense (`OPERATIONS.md` §18) caps how fast that balance can be drained per UTC day. BunkerWeb and UFW stop *web* attackers (bots, OWASP exploits, brute-force SSH); they don't change the underlying economics of someone wanting to grab a bunch of Blurt usernames at your relay's expense.

If a name-squatter shows up willing to burn real BLURT from the relay, the right response is the §18 anomaly alerts firing, you flipping the kill-switch, raising the daily ceiling temporarily back DOWN, and contacting `#agorise:matrix.org` so other operators know to expect the same attacker.

#### For home hosters specifically

If you went the home-hosting route in §3a, there are a few additional operational concerns once you're up and running. They're collected in `OPERATIONS.md` §39 ("Operating a home-hosted instance"). The greatest hits:

- **Uptime monitoring tuned for residential connections.** Don't alert on a single failed probe; require 3 consecutive failures. Probe from multiple regions to avoid false alarms during ISP peering disputes.
- **Restart story has three legs to verify**: BIOS/UEFI auto-power-on, systemd unit `enabled` state, and how the relay's encrypted-key passphrase comes back after an unattended reboot (the latter has a real failure mode where the relay sits forever waiting for keyboard input — §39.2 covers two mitigations).
- **The off-site backup is mandatory, not optional.** A home fire wipes out everything else. §39.8 documents the encrypted-rclone-to-Backblaze-B2 pattern as the recommended starting point.
- **ISP TOS reality check.** Most consumer ISPs technically prohibit "running servers"; enforcement is essentially never on real-world traffic at Morphit's scale. §39.3 gives you the diplomatic responses if you ever do hear from your ISP.
- **What if you move?** The instance is tied to your physical address. §39.4 covers the migration paths (transport the hardware, or migrate to VPS).
- **Network-level privacy** — your home's public IP is visible to every visitor. §39.9 covers Tor onion / Cloudflare Tunnel / VPS migration as mitigations if that becomes a concern.

---

## 12. What to do when things break

Some common things and how to fix them.

### "`morphit-ops` says command not found"

This is the most common first-run snag. `npx morphit-ops init` (or `register`, `edit`, `upgrade`) worked once, then stopped — or never worked on a fresh clone.

**The cause (almost always one of these two):**

1. **You're not inside the repo, or you haven't run `npm install` yet.** `morphit-ops` is a tool that lives inside *this repo* (under `apps/ops-cli/`), not something published to the public npm registry. `npx` finds it only when you run from **inside the Morphit directory** and after `npm install` has set up `node_modules`. Run it from your home folder, a subdirectory, or a fresh clone you haven't installed — and `npx` gives up and asks the public registry, which returns a 404 that shows up as "command not found." The classic version: it worked yesterday from `~/morphit`, but today you're in a different folder, or on a second server where you skipped `npm install`.

2. **A `git pull` invalidated the symlink** that `npm install` creates (`node_modules/.bin/morphit-ops`). If the pull changed the dependency files, re-running `npm install` rebuilds it.

**The fix — run from the repo root, after installing:**

```
cd ~/morphit
npm install
npx morphit-ops init
```

**The rule: re-run `npm install` after every `git pull`.** The update procedure later in this section already says to rebuild the frontend after a pull; the same `npm install` is what restores the `morphit-ops` command. Two notes:

- Run `morphit-ops` **from inside the repo** — `npx` looks for the local tool by searching upward from your current directory, so running it from an unrelated folder won't find it.
- If `npm install` doesn't fix it, run the tool directly without the symlink:
  ```
  npm exec --workspace apps/ops-cli morphit-ops -- init
  ```

If you installed Morphit with the **Ansible playbook** (`ops/ansible/`), you don't run these commands by hand — the playbook runs `npm install` for you and (since cp161) verifies the `morphit-ops` tool is runnable before finishing. If something changed on the box, re-run the playbook rather than doing a manual `git pull` on the server.

For the full explanation of *why* this happens (workspace bins, the `tsx` runtime dependency, the `NODE_ENV=production` edge case), see **OPERATIONS.md → "Troubleshooting: `morphit-ops` says command not found"** in §33.

### "Account avatars show as broken images"

The heart identicons on the onboarding "your keys are ready" screen (and profile chips, the avatar menu, etc.) show the browser's broken-image icon, and the browser console / **Issues** panel mentions a Content-Security-Policy violation on `data:image/svg+xml` requests.

Those avatars are tiny SVGs the browser builds on the fly as `data:` URIs — they're valid, so this is never a frontend-bundle problem, and **rebuilding the frontend alone will not fix it**. It means the CSP your web server is actually *sending* is older than this repo's: its `img-src` directive is missing `data:`. The shipped policy is `img-src 'self' data: blob:`.

Fix it in two steps:

1. **Update the served policy.** Confirm what's being sent first: DevTools → Network → the HTML document request → Response Headers → `content-security-policy`, or from a shell `curl -sI https://your-site/ | grep -i content-security` (look for `img-src` — if it's just `'self'`, or missing entirely, `data:` images are blocked). Then fix it wherever your edge sets it: bare-metal nginx → re-copy `ops/nginx/web.conf` and `sudo nginx -t && sudo nginx -s reload`; BunkerWeb → set `CONTENT_SECURITY_POLICY` to match `ops/bunkerweb/bunkerweb.env.example` and restart the container. **If you front the site directly with the BunkerWeb-compose `frontend` nginx (the `bunkerweb` service commented out), or any other proxy**, the policy is an `add_header Content-Security-Policy` directive inside *that* config — locate it with `sudo grep -rni 'content-security-policy' <your-edge-config-dir>` (search the header spelling, not the `CONTENT_SECURITY_POLICY` env-var name), match its value to the canonical one, then `nginx -t` and reload/restart that proxy.
2. **Clear the cached page.** The service worker may have cached an old HTML response that still carries the old CSP header, so the fix won't show until the cache is gone: DevTools → Application → Storage → **Clear site data**, then reload.

See **OPERATIONS.md §15 → "Troubleshooting: account avatars show as broken images"** for the same fix with more detail.

### "My node won't start"

If you run the indexer or relay and it exits immediately with a
configuration error — anything like `config validation failed: …
Required`, `… not in the operator allowlist`, or a key-file
permission complaint — **run the doctor first** instead of reading
stack traces:

```
cd /opt/morphit          # your install directory
npx morphit-ops doctor
```

It reads your `morphit.env` and `morphit.config.env` the same way
the services do, then tells you in plain English whether the indexer
and relay will start — and if not, exactly which setting is missing
or wrong and how to fix it. It changes nothing on your system; it
only reads and reports. It also tells you whether your relay key is
encrypted (i.e. whether the relay will ask for a passphrase when it
starts).

Fix what it reports, then run `morphit-ops doctor` again until both
services show a green check. Common fixes it points you to: a setting
that belongs in `morphit.env` rather than `morphit.config.env`, a
required value that is missing (re-running `morphit-ops init`
regenerates a complete config), or a key file that needs
`chmod 0600`.

`doctor` also runs a short **security check** at the end. The most
important item: it tells you whether your relay's active key is
**encrypted** or stored in **plaintext**, and recommends encrypting
it (`morphit-ops edit-active-key`). It also flags any secret file
(`morphit.env`, the key file) that is readable by other users on the
box. Note the deliberate trade-off: an encrypted key gives you much
better security but **must be unlocked by hand each time the relay
starts** — there is no automatic unlock, so the relay will not come
back on its own after a reboot until you enter the passphrase.

`doctor` also does a quick **database-schema** check: it tells you
whether your database is missing anything this version expects. That
can happen if you upgraded across a schema change during the beta (an
existing database doesn't pick up in-place schema edits on its own). If
it reports `Database schema (drift detected)`, follow the reset steps in
`OPERATIONS.md` §46 — it's safe, because the indexer rebuilds its
database from the chain. Pass `--no-db` to skip this check (e.g. when
Postgres is intentionally down).

### "The indexer fell behind"

The indexer's job is to read every Blurt block as it confirms. Sometimes it gets behind (server was off, internet hiccup, etc.). It catches up automatically — usually within minutes.

To check:

```
curl https://yourdomain.com/v1/health
```

You'll see something like `"lag_blocks": 5`. Fewer than 100 is fine. Higher than 500 means it's significantly behind — usually it'll catch up on its own. If it's been over 1000 for more than an hour, something is wrong:

- Your Blurt RPC endpoint might be unreachable. Check the indexer logs.
- Your server might be out of disk space. `df -h` to check.
- Your CPU might be pegged. `top` to check.

### "My relay is out of BLURT"

The relay spends Mana (Blurt's transaction fuel) when users do things on the chain. Each new signup costs about 100 BLURT. If your relay's balance hits zero, signups will fail.

Check the balance via any working Blurt RPC node (the six
defaults shipped with Morphit's frontend are listed in
OPERATIONS.md §22):

```
curl -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"condenser_api.get_accounts","params":[["yourblurtaccountname"]],"id":1}' \
    https://rpc.blurt.blog | grep -o '"balance":"[^"]*"'
```

Or use whichever Blurt block explorer the community currently
maintains — check the Blurt community channels for an up-to-date
URL, since explorer hosts have changed over the years.

If the balance is low, send more BLURT to the account from your operator-fees account or buy some from any Blurt exchange. OPERATIONS.md section 1 has the canonical operator's procedure for setting up a recurring auto-top-up.

### "certbot can't get a certificate"

Usually this means Let's Encrypt couldn't reach your server. Causes:

- DNS isn't pointing to your IP (`nslookup yourdomain.com`).
- Your firewall is blocking port 80 (`ufw status` should show `80/tcp ALLOW`).
- Your hosting provider blocks outbound port 80 (rare, but some "filtered" plans do).
- Your nginx config has a syntax error and isn't running (`sudo nginx -t`).

Check certbot's logs:

```
sudo cat /var/log/letsencrypt/letsencrypt.log
sudo journalctl -u nginx -n 100
```

The error message usually points at the cause. After you fix the underlying issue, re-run:

```
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

### "Users say RPC connections fail in their browser console"

If you tightened your Content Security Policy to the explicit-allowlist form (the recommended one for fresh installs from May 2026 onward) and your users add custom Blurt RPC endpoints in Settings, the browser will block those custom endpoints with a `connect-src` violation. Two ways to handle:

- Add the specific RPC hostname to your CSP `connect-src` directive in your reverse-proxy config and reload nginx (`sudo nginx -t && sudo systemctl reload nginx`). See OPERATIONS.md §15 for the full directive.
- Or revert to the looser `connect-src 'self' https:` form if your community uses a wide and changing pool of community RPCs.

This is a deliberate tradeoff — the tighter CSP catches a class of XSS exfiltration attacks at the cost of less RPC flexibility.

### "I broke something and I don't know what"

The reset button: stop the services, check the logs for the most recent error, fix the configuration, restart.

```
sudo systemctl stop morphit-indexer morphit-relay
sudo journalctl -u morphit-indexer -n 50
# ...read the error, fix the config...
sudo systemctl start morphit-indexer morphit-relay
```

(There's only the two services — no `morphit-web` to restart, since the frontend is static files served by nginx. If the frontend itself is broken, run `sudo nginx -t && sudo systemctl reload nginx` after fixing the config.)

If you really can't figure it out, ask in the Matrix channel. Bring:
- The exact error message.
- What you were doing when it happened.
- The output of `sudo systemctl status morphit-indexer` (or whichever service is broken).

Most issues are config typos in the `.env` files.

### "My home server was reachable yesterday but isn't now" (home hosters)

Almost always one of three things:

1. **Your home IP changed and the DDNS update script failed.** Check the log:
   ```
   tail -20 /var/log/duckdns.log     # (or /var/log/dynu.log)
   ```
   If you see `KO` or curl errors, the cron job isn't reaching DuckDNS. Could be a transient internet glitch (try `sudo /etc/duckdns/update.sh` to force a re-run) or a typo in the script (re-check the token).
2. **Your modem rebooted and your router didn't re-establish the port forward.** Some consumer routers forget port-forward rules after a power blip. Log into the router's admin page; verify the rules from §3a.4 are still there. If they aren't, re-add them and look for a "save permanently" or "apply" button you might have missed last time.
3. **Your ISP rotated you onto a CGNAT range.** Rare but happens during major ISP infrastructure changes. Re-run the §3a.1 check (compare `whatismyip.com` to your router's WAN IP). If you've been silently moved to CGNAT, your options are the same as in §3a.1 (call ISP, switch to VPS, or use Cloudflare Tunnel).

### "Power went out and my home server didn't come back up" (home hosters)

Two common causes:

- **The BIOS/UEFI is set to "Stay Off after power loss"** (the default on many laptops). Boot into BIOS and set "AC Power Recovery" to "Power On" or "Last State". See §3a.6 for instructions.
- **The UPS battery died** during the outage and the machine didn't shut down cleanly. The next boot is usually fine; you may want to run `sudo systemctl status postgresql` and check for any database-corruption warnings. If you see any, run `sudo -u postgres pg_dumpall > /tmp/postcrash.sql` immediately to confirm Postgres can read the data, then consider replacing the UPS battery (UPS batteries last ~3–5 years and degrade silently).

If neither matches, treat it as the general "I broke something" case above.

### "I think I got hacked"

If you suspect the relay's active key has been compromised:

1. **Immediately** stop the relay: `sudo systemctl stop morphit-relay`.
2. Generate a new active key for `@your-relay-account` using any Blurt wallet, or follow OPERATIONS.md §8 ("Owner-key rotation ceremony" — uses your offline owner key to broadcast a new `account_update` op).
3. Update the active key on chain. This **requires the owner key** — which you've kept offline (paper, in a safe, off any networked machine). If the attacker has the owner key, the account is gone; restoration requires Blurt witness escalation, which is rare and slow.
4. Replace the contents of the file at `MORPHIT_RELAY_ACTIVE_KEY_FILE` (the path is set in `/etc/morphit/relay.env`; the default path is `/etc/morphit/keys/relay-active.key`) with the new active-key WIF (or re-encrypted envelope, if you use the encrypted form). Make sure the file mode stays at `0400` and is owned by the `morphit-relay` user.
5. Restart the relay: `sudo systemctl start morphit-relay`.

Full procedure with the safeguards is in OPERATIONS.md §7 ("Suspected relay compromise") and §8 ("Owner-key rotation ceremony"). Don't improvise — follow that doc step by step.

### "A user says they lost their 2FA — can you reset it?"

You cannot — and you should be glad you can't. Morphit's TOTP-based two-factor authentication is entirely client-side: the secret and backup-code hashes live inside the user's encrypted keystore, on the user's device, and your relay never sees them. There's no server-side switch to flip.

Direct the user at three recovery paths in this order:

1. **Backup code.** If they saved their 10 single-use backup codes at enrollment (which the UI made them acknowledge), they can type one of those at the unlock screen instead of the 6-digit authenticator code. Each works once.
2. **Seed phrase.** If they kept their 12-word recovery phrase, they sign out and choose "I have a seed phrase" on the welcome screen. This recovers their identity exactly and they can set a fresh password — and re-enroll 2FA from scratch if they want.
3. **Neither.** If they have neither backup codes nor seed phrase, the keystore is not recoverable. This is a fundamental property of non-custodial design; it's not a Morphit limitation we can work around.

See OPERATIONS.md §44 for the full operator-side rundown of how the 2FA flow works (spoiler: there is no operator-side rundown — it's user-side only). The user-facing FAQ entries `totp_2fa_what_is_it`, `totp_2fa_lost_authenticator`, and `totp_2fa_why_not_google_authenticator` cover the same ground from the user's angle.

---

## 13. Where to go from here

Congratulations. You're a Morphit operator.

Next things to learn:

- **Read `OPERATIONS.md`** (this guide's companion). It's denser than this guide, but now that you've done the hands-on setup, the references will make sense. The sections you'll touch most often are 11 (integration tests), 13 (price-feed alerts), and 16 (operator-balance alerts).

- **Read `FEES-AND-REWARDS.md`** for the complete fee schedule, reward triggers, and operator economics — the canonical source-of-truth (with source-code line references) for every monetary flow. Account creation is the operator's biggest cost (~100 BLURT per signup); listing fees are the main income. The doc explains the math and where it's tunable.

- **Read `SWITCHING-NETWORKS.md`** if you haven't gone live yet. It walks through standing up a staging instance to shake out bugs without polluting your production reputation, then how to wipe staging and switch to your real production account when you're ready for launch. Most operators benefit from doing this even when they're confident — staging takes ~30 minutes and finds at least one issue every time.

- **Set up monitoring.** The indexer exposes a `/v1/health` endpoint; point your favorite uptime monitor at it. We like UptimeKuma (self-hosted) or Better Uptime (free tier). If the endpoint stops responding, you want to know within minutes.

- **Set up the alerting.** OPERATIONS.md section 16 covers the operator-balance alert scanner — it pings you when your relay's BLURT runs low. Critical for avoiding signup outages.

- **Customize your instance.** Edit the i18n strings in `apps/web/src/lib/i18n/locales/` to brand the interface for your community. Set a custom logo by replacing `apps/web/static/brand/morphit-mark.svg`.

- **Tell your community.** Post to your blog, your community forum, your local meetup group. Your instance is just a domain until users find it. Word of mouth is the only marketing Morphit has.

- **Join the operators' channel.** `#agorise:matrix.org`. Other operators run their own instances and share tricks, mutual monitoring, occasional load-balancing.

The fact that you got through this guide and have a running instance puts you in a small group of people in the world keeping a non-custodial, non-KYC, federated trade marketplace alive. That genuinely matters. Thank you for running a node.

## 14. Running a second instance — DO NOT share relay accounts

If you decide later to spin up a second Morphit instance
(different domain, different VPS, perhaps even different
hosting provider), you might be tempted to reuse your
existing `@my-relay` and `@my-fees` accounts on both
deployments.  **Don't.**  It will silently corrupt signups
and double-spend welcome bonuses.  Generate a fresh
`@my-relay-2` (with its own active key) for the second
instance.  Sharing `@my-fees` for read-only fee collection
is fine; sharing the relay's signing account is not.

For the technical detail (concurrent signing race, drainer
double-spend, halved abuse defenses), see
`docs/OPERATIONS.md` §29.

---

## Trade-only assets: USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP, and your operator stance

Morphit ships with **USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, and XRP enabled by default**
as trade-only assets on a new node.  Users can buy/sell USDT
against any of the four supported networks (ERC-20, TRC-20,
SPL, BEP-20), and can buy/sell BCH (Bitcoin Cash, single-network
mainnet only), LTC (Litecoin, single-network mainnet only), and
DASH (Dash, single-network mainnet only, with optional wallet-side
PrivateSend mixing).  All listing fees are paid in BLURT, BTC, or
XMR — never USDT, never USDC, never DAI, never BCH, never LTC, never DASH, never DOGE, never ZEC, never ARRR, never DCR, never SOL, never ETH, never XRP (the
`fee_method` enum is wire-format-frozen at BLURT/BTC/XMR per
memory #23 and ADR-0011).

### Decide your operator stance

You have three paths to set the disabled-assets list, all of which
write the same `MORPHIT_INDEXER_DISABLED_ASSETS=...` line:

1. **CLI wizard** (the path this guide walks you through) — the
   `morphit-ops init` wizard, step 13 "Trade-only asset policy"
   (Part 122 cp22), prompts per-ticker whether to enable it on
   your instance.  Default is YES for each (per Memory #25).
   The wizard emits the line into `morphit.config.env`.

2. **Web setup-wizard** (Part 122 cp116) — once your instance is
   up and a browser can reach it, visit `/admin/setup-wizard` on
   your site.  Tick or untick each tradable asset to see the
   exact env line update live; click Copy and paste into your
   `morphit.config.env`, then restart the indexer
   (`docker compose restart indexer`).  Read-only — the page
   never mutates your server, so no auth-gating is needed (put
   it behind your reverse proxy's auth if you want one anyway).
   See "Browser setup-wizard" below for the full operator UX.

3. **Direct env-file edit** — open `morphit.config.env` in your
   editor of choice, find or add the
   `MORPHIT_INDEXER_DISABLED_ASSETS=` line, set the value, and
   restart the indexer.

All three paths write the exact same line; pick whichever is
fastest for you.  The CLI wizard is friendliest for first-time
setup (it walks per-ticker); the web wizard is friendliest for
"oops, I forgot to disable X" mid-deployment; the direct edit
is fastest if you already know what you want.

Reasonable positions for an operator:

1. **Accept USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, and XRP** (default) — the canonical
   morphit.io posture.  Users have asked for stablecoin trading
   and for wider Bitcoin-fork rails.  Pick the default "Y" at
   each prompt; the wizard emits
   `MORPHIT_INDEXER_DISABLED_ASSETS=""`.

2. **Refuse one specific asset instance-wide** — pick "n" for
   that asset at the wizard prompt; the wizard emits e.g.
   `MORPHIT_INDEXER_DISABLED_ASSETS="USDT"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="USDC"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="DAI"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="BCH"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="LTC"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="DASH"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="DOGE"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="ZEC"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="ARRR"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="DCR"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="SOL"`,
   `MORPHIT_INDEXER_DISABLED_ASSETS="ETH"`, or
   `MORPHIT_INDEXER_DISABLED_ASSETS="XRP"`.

   Equivalent post-deploy env-file edit:

   ```bash
   # Refuse USDT only
   MORPHIT_INDEXER_DISABLED_ASSETS="USDT"

   # Refuse USDC only (Part 122 cp30 — operators preferring to
   # avoid a Circle-custodial stablecoin while keeping USDT)
   MORPHIT_INDEXER_DISABLED_ASSETS="USDC"

   # Refuse DAI only (Part 122 cp31 — operators preferring to
   # keep stablecoin exposure to USDT/USDC and skip the
   # partly-decentralized DAI option; see ADR-0029 for the
   # full decentralization-trade-off discussion)
   MORPHIT_INDEXER_DISABLED_ASSETS="DAI"

   # Refuse BOTH stablecoins (operators going privacy-pure)
   MORPHIT_INDEXER_DISABLED_ASSETS="USDT,USDC"

   # Refuse BCH only (privacy-focused operators may prefer
   # BTC + XMR rails and skip Bitcoin Cash)
   MORPHIT_INDEXER_DISABLED_ASSETS="BCH"

   # Refuse LTC only (operators specializing in Bitcoin +
   # privacy-coin trading without BTC-fork variants)
   MORPHIT_INDEXER_DISABLED_ASSETS="LTC"

   # Refuse DASH only (operators preferring to limit the
   # surface to Bitcoin-family chains without masternode-
   # coordinated coins)
   MORPHIT_INDEXER_DISABLED_ASSETS="DASH"

   # Refuse DOGE only (Part 122 cp33 — operators specializing in
   # serious-money trading who'd rather not surface a meme-origin
   # coin to their users; DOGE itself is technically sound, this
   # is a brand/audience choice; see ADR-0030)
   MORPHIT_INDEXER_DISABLED_ASSETS="DOGE"
# Refuse only ZEC trades:
MORPHIT_INDEXER_DISABLED_ASSETS="ZEC"
# Refuse only ARRR trades:
MORPHIT_INDEXER_DISABLED_ASSETS="ARRR"
# Refuse only DCR trades:
MORPHIT_INDEXER_DISABLED_ASSETS="DCR"
# Refuse only SOL trades:
MORPHIT_INDEXER_DISABLED_ASSETS="SOL"
# Refuse only ETH trades:
MORPHIT_INDEXER_DISABLED_ASSETS="ETH"
# Refuse only XRP trades:
MORPHIT_INDEXER_DISABLED_ASSETS="XRP"
   ```

   You'll still see those orders from peer instances in your
   read-only orderbook feeds (the chain is shared), but your
   own users get an inline error if they try to post one.

3. **Refuse multiple assets** — pick "n" at multiple wizard
   prompts; the wizard alphabetizes and emits e.g.
   `MORPHIT_INDEXER_DISABLED_ASSETS="ARRR,BCH,DCR,DOGE,ZEC"`
   (or any subset of the 13 Category-B trade-only tickers).

   Equivalent post-deploy env-file edit:

   ```bash
   # Refuse BCH + LTC (keeps BTC + XMR + BLURT + USDT + USDC
   # + DAI + DASH + DOGE + ZEC + ARRR + DCR + SOL + ETH + XRP)
   MORPHIT_INDEXER_DISABLED_ASSETS="BCH,LTC"

   # Refuse all 13 Category-B trade-only assets (keeps only the
   # 3 Category-A fee-payable assets: BTC + XMR + BLURT)
   MORPHIT_INDEXER_DISABLED_ASSETS="ARRR,BCH,DAI,DASH,DCR,DOGE,ETH,LTC,SOL,USDC,USDT,XRP,ZEC"

   # Future-compat with assets not yet in the registry
   MORPHIT_INDEXER_DISABLED_ASSETS="USDT,USDC,DAI,BCH,LTC,DASH,DOGE,ZEC,ARRR,DCR,SOL,ETH,XRP,FUTUREASSET"
   ```

   (Unknown tickers are accepted in the env var for forward-
   compatibility — the indexer ignores tickers it doesn't
   recognize, which lets operators set the var preemptively
   for assets not yet in the registry.)

**Your users will see your stance directly.**  Whatever you
set above is published through your indexer's `/v1/instance`
endpoint as the `disabled_assets` field, and the frontend
renders it on `/about-this-instance` in a "This instance's
asset policy" section.  Empty list → users see "None — this
instance accepts every tradable asset"; populated list →
users see the operator-disabled tickers spelled out with the
federation reminder that peer-instance orders are still
visible in the orderbook.  No extra wiring needed on your
side; just set the env var and restart the indexer service.
Browsers see the change at most 5 minutes after restart
(`/v1/instance` carries a 5-minute Cache-Control header).

### Browser setup-wizard

If you'd rather not memorize env-var names, your instance hosts
a browser-based setup-wizard at `/admin/setup-wizard` (cp116).
Visit it from any browser that can reach your domain.

What the page lets you do:

- **Toggle which assets your instance lists.** A checkbox for
  each tradable asset, with BTC/XMR/BLURT locked enabled (the
  three "core" assets cannot be disabled — federation depends
  on them for listing-fee payment).  Tick or untick anything
  else; the page emits the exact
  `MORPHIT_INDEXER_DISABLED_ASSETS=...` line live.  Hit Copy,
  paste into `morphit.config.env`, restart the indexer
  (`docker compose restart indexer`).

- **Add a custom payment method.** If your region uses a payment
  method that isn't in Morphit's canonical list, fill in the
  form (machine key, display name, description, category,
  optional URL).  The page emits the exact
  `morphit-ops payment-method add ...` CLI command with all the
  flags pre-filled and POSIX-safe shell-escaped.  Hit Copy,
  paste into your terminal on the operator host, follow the
  prompts.  The CLI broadcasts a chain op — no service restart
  needed.

What the page does NOT do:

- **It never mutates your server.** Read-only by design.
  Nothing changes until you paste the output and apply it
  yourself.  This is the architectural choice — giving the web
  tier filesystem-write or service-restart privileges would
  expand attack surface significantly, so the wizard limits
  itself to generating the text you need.

- **It has no login requirement.** Anyone who can reach your
  domain can visit `/admin/setup-wizard` and see the form.
  That's fine because the form mutates nothing — but if you'd
  rather hide it from your users, put it behind your reverse
  proxy's auth (Nginx HTTP basic-auth, Caddy `basicauth`
  directive, or your favourite SSO middleware).  Documented
  examples in `docs/OPERATIONS.md` "Securing operator-only
  routes."

- **It doesn't preview your current state.** V1 only generates
  the lines you'd need to set; it doesn't read your current
  `morphit.config.env` to show what's already there.  V2 may
  add a live-preview endpoint.

When to use the browser wizard vs the CLI wizard:

| Situation                         | Best path                |
|-----------------------------------|--------------------------|
| First-time setup, fresh server    | `morphit-ops init` CLI   |
| Already-running instance changes  | `/admin/setup-wizard`    |
| Scripted/headless config          | Direct env-file edit     |

All three paths produce the same env file in the end.

### Per-network explorer URLs (multi-network assets)

Three multi-network assets (USDT, USDC, DAI) each have bundled-
default explorer URLs per network.  When a user shares a txid
in chat for any of these, the frontend renders a clickable link
via the appropriate explorer:

**USDT (4 networks):**

| Network | Bundled default explorer |
|---------|--------------------------|
| ERC-20 (Ethereum) | `https://etherscan.io/tx/{txid}` |
| TRC-20 (Tron) | `https://tronscan.org/#/transaction/{txid}` |
| SPL (Solana) | `https://solscan.io/tx/{txid}` |
| BEP-20 (BNB Smart Chain) | `https://bscscan.com/tx/{txid}` |

**USDC (4 networks):**

| Network | Bundled default explorer |
|---------|--------------------------|
| ERC-20 (Ethereum) | `https://etherscan.io/tx/{txid}` |
| SPL (Solana) | `https://solscan.io/tx/{txid}` |
| Base | `https://basescan.org/tx/{txid}` |
| Polygon | `https://polygonscan.com/tx/{txid}` |

**DAI (4 EVM networks):**

| Network | Bundled default explorer |
|---------|--------------------------|
| ERC-20 (Ethereum) | `https://etherscan.io/tx/{txid}` |
| Polygon | `https://polygonscan.com/tx/{txid}` |
| Base | `https://basescan.org/tx/{txid}` |
| Arbitrum One | `https://arbiscan.io/tx/{txid}` |

Operators running self-hosted explorers for any of these
chains can override per-network in the frontend env (see
`docs/OPERATIONS.md` §"Per-network explorer URL overrides").

### Single-network explorer URLs

BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, and XRP are single-network (mainnet only), so
each has just one chat-link explorer URL:

| Asset | Bundled default explorer |
|-------|--------------------------|
| BCH (mainnet) | `https://blockchair.com/bitcoin-cash/transaction/{txid}` |
| LTC (mainnet) | `https://litecoinspace.org/tx/{txid}` |
| DASH (mainnet) | `https://insight.dash.org/insight/tx/{txid}` |
| DOGE (mainnet) | `https://blockchair.com/dogecoin/transaction/{txid}` |

Override each via the matching env var:
- `MORPHIT_FRONTEND_BCH_CHAT_LINK_URL`
- `MORPHIT_FRONTEND_LTC_CHAT_LINK_URL`
- `MORPHIT_FRONTEND_DASH_CHAT_LINK_URL`
- `MORPHIT_FRONTEND_DOGE_CHAT_LINK_URL`

Same shape contract as `MORPHIT_FRONTEND_BTC_CHAT_LINK_URL` and
`MORPHIT_FRONTEND_XMR_CHAT_LINK_URL`: must start with `https://`,
must contain `{txid}`, must parse as a URL.  See
`docs/OPERATIONS.md` §"Single-network explorer URL overrides"
for alternatives.

### What trade-only assets cannot do on your node

- ❌ Cannot pay listing fees (BLURT/BTC/XMR only, enforced
  by sentinel smokes)
- ❌ Cannot pay cold-message / stranger fees (BLURT-only,
  unchanged)
- ❌ Cannot pay featured-slot bids (BLURT-only, unchanged)
- ❌ Cannot be the welcome-bonus / loyalty-reward currency
  (BLURT-denominated, unchanged)
- ❌ Cannot be an operator-payout currency

These are wire-format invariants, not config knobs.  Two
sentinel smokes (`fee-method-enum-frozen-smoke`,
`first-buy-waiver-payment-agnostic-smoke`) guard them in CI.

### Schema v32

The Part 121 schema bump adds `orders.asset_network TEXT` —
applies automatically on indexer startup.  Idempotent.  No
operator action.

---

## Payment methods: offering or disabling Barter (and other canonical methods)

Morphit ships with **every canonical payment method enabled** on a
new node — PayPal, Zelle, Wise, Revolut, cash in person, cash by
mail, the crypto "pay-with" methods, and **Barter**
(products/services, e.g. "sell XMR for a used bicycle" or a box of
kittens). Some operators prefer to keep their
instance money-only and not host goods-for-crypto trades; this
section is how you turn Barter — or any canonical method — off.

### Decide your operator stance

Two paths, both writing the same
`MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS=...` line:

1. **CLI wizard** (the path this guide walks you through) — the
   `morphit-ops init` wizard, step 14 "Payment-method policy",
   asks whether to offer Barter on your instance (the method
   operators most often disable). Default is YES. Answering "no"
   writes `barter_goods` into `morphit.config.env`. To disable
   methods *other* than Barter, use the direct env edit.

2. **Direct env-file edit** — open `morphit.config.env`, find or
   add the `MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS=` line, set a
   comma-separated list of canonical payment-method **keys**
   (lowercase), and restart the indexer
   (`docker compose restart indexer`). Browsers see the change at
   most 5 minutes after restart.

```bash
# Offer everything (default)
MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS=""

# Money-only instance — no Barter
MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS="barter_goods"

# Disable several (note: online methods have NO pay_ prefix —
# it's "paypal", not "pay_paypal"; only crypto methods do)
MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS="barter_goods,paypal,zelle"
```

The full list of canonical keys (in-person, online/bank, and the
`pay_*` crypto methods) is in **docs/OPERATIONS.md
§"Payment-method configuration"**. Your own region-specific
additions (`morphit-ops payment-method add`) are managed with
`morphit-ops payment-method remove`, not this knob.

### What disabling does

A disabled method disappears from your users' post-order payment
picker and the orderbook payment filter. The indexer refuses a
NEW order only when **all** of its payment methods are disabled —
an order that still offers one enabled method is kept. Like
disabled assets, this is operator-scoped: peer-instance orders
that use a method you disabled still appear in your read-only
orderbook (the chain history is shared across the federation);
your users just can't post orders that offer only disabled
methods. Users who want Barter (or any method you turned off) can
self-route to a different Morphit operator — federation is the
point.
