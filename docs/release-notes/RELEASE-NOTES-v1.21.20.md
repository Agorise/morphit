# Morphit v1.21.20

A fix release for servers, after a zero-clearnet instance lost Tor for two days and could not upgrade. Nothing about
fees, trades or the chain changes, and nothing changes for people using the site.

## For operators

**Tor 0.4.8 no longer connects: the upgrade now installs Tor 0.4.9.** Since 28 October 2026 the Tor network requires
protocols that Tor 0.4.8 does not have. A 0.4.8 Tor stops at "Bootstrapped 30%" and loads nothing: the instance's
.onion is unreachable, and hidden Blurt nodes and upgrades through Tor fail. Ubuntu 24.04 shipped 0.4.8.10 and
published 0.4.9.11 as a regular update (noble-updates) in August, which Ubuntu's automatic updates do not install. A
server that never ran `sudo apt upgrade` still has 0.4.8. Now:

- the upgrade installs Ubuntu's Tor 0.4.9 when the server's Tor is older, keeping your `/etc/tor/torrc` (your hidden
  service and bridges), and then checks that Tor connects (a hidden Blurt node must answer through it);
- the same check runs between upgrades, at the start of the Tor bridges check (half an hour after the server starts,
  then every 6 hours), so a server is not left on an old Tor until its next upgrade;
- on a zero-clearnet server apt goes through Tor, which works only while the old Tor still connects. When it no
  longer does, nothing is tried and the upgrade says how to bring the two packages on a USB stick
  (`sudo apt install ./tor_*.deb ./tor-geoipdb_*.deb`);
- installing with Ansible upgrades a Tor older than 0.4.9 as well (a fresh install already got the current one).

To see what a server has: `tor --version` (0.4.9 or newer is fine).

**A zero-clearnet upgrade downloads only the dependencies that changed, and can no longer wait forever.** v1.21.19
changed 5 of its 821 dependency packages. A zero-clearnet server threw all 821 away and downloaded every one through
Tor, with no time limit. With Tor not connected, npm waited for hours. Now:

- the installed dependencies are kept and only the changed ones are fetched through Tor (for v1.21.19: 5 packages,
  about 1 MB instead of about 70 MB); the result is checked against the release's lockfile, and only if that fails is
  everything fetched;
- the spinner shows how much has come through Tor so far;
- if nothing comes through Tor for 10 minutes, npm is stopped, the previous version is put back, and the upgrade says
  how to finish with the offline bundle;
- a request that Tor closed without answering no longer leaves npm waiting (it was never answered before).

The upgrade to v1.21.20 itself is still done by the version you have installed now. On a zero-clearnet server, make
sure its Tor connects first (`tor --version` shows 0.4.9 or newer); if it does not, use the offline bundle for this
one upgrade.

**Nothing Morphit sends through Tor or I2P can go around it.** curl uses the `no_proxy` setting even for a proxy
named on its command line, so a host listed there was fetched directly, not through Tor. Every curl that Morphit
sends through Tor or I2P now ignores `no_proxy`. This covers the upgrade's checks, the Tor bridges and zero-clearnet
firewall checks, Tor time sync, the first-online check, the IPFS seed check, the warrant canary's news fetch, the
reachability check, the fast-chat latency probe, the snapshot bootstrap, and the Ansible playbook.

**For the maintainer: the release payload builder's text.** Run as in Block 3 (no questions asked), it no longer says
"Enter values" and "Leave a field empty". It says which mirrors get what (every pinned mirror gets the commits and the
signed tag; codeberg.org and gitea.com also get the release page), and it names Block 4's `release-broadcast.ts` as
what broadcasts the payload. The payload itself is unchanged.

## For monitoring scripts: changed JSON

Nothing.
