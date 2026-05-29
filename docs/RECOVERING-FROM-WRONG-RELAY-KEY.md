# Recovering from a wrong relay key (cp167)

This document is the exact procedure for fixing one specific scenario:

> An operator ran `morphit-ops init`, the pre-cp167 wizard asked them
> for "your relay's posting key", they pasted the posting key
> (encrypted), and now the relay won't work because the chain rejects
> every operation with "missing required active authority".

It produces a **no-trace** recovery: no copy of the wrong key remains
on the server when you're done.

## Background

The Morphit relay broadcasts the following chain operations on the
relay account's behalf:

- `create_claimed_account` — signs up a new Morphit user
- `transfer` — sends the welcome bonus
- `transfer_to_vesting` — powers up donated BLURT
- `delegate_vesting_shares` — delegates BP for posting

Every one of those requires **active** authority. The posting key can
sign comments and votes, nothing else. If the relay has a posting key,
the chain rejects every relay op.

The cp167 wizard fix renames the prompt + the variables + the
internal commentary; any new operator running `morphit-ops init`
will be asked unambiguously for the **active** key. This document is
for operators who set up before that fix landed.

## Prerequisites on the server

1. The operator has the correct **active** key WIF for the relay
   account on hand (a 51-character string starting with `5`).
2. They have shell access to the server as the user that runs
   `morphit-ops` (the same user that ran the install).
3. `morphit-ops` itself is at the cp167 build or later. Check:
   ```
   morphit-ops --help | grep edit-active-key
   ```
   If that returns nothing, pull the latest source and rebuild:
   ```
   cd /path/to/morphit
   git pull
   npm install
   npm run build -w apps/ops-cli
   ```

## The procedure

Run from the same directory that contains `morphit.env` (the
directory you ran `morphit-ops init` in):

```
cd /path/to/morphit
morphit-ops edit-active-key
```

The command will:

1. Read `morphit.env`, locate the relay account name and the keystore
   path. It prints both back so you can sanity-check them.
2. Read the current keystore, detect that it's encrypted, and print
   the storage mode.
3. Ask: **"Was the previous key wrong or compromised?"**
   Answer **`y` (yes)** — this selects the no-trace rotation path.
4. Ask you to confirm: **"Rotate the active key for @<account>?"**
   Answer **`y` (yes)**.
5. Prompt for the new active key — paste the 51-character WIF starting
   with `5`. (It echoes nothing; that's intentional.)
6. Ask for the storage mode for the new key — choose **encrypted**
   (option 1, the default — same as before).
7. Ask for a new passphrase. You can reuse the prior passphrase or
   choose a fresh one. Type it twice.
8. The command then:
   - Overwrites the prior keystore file (the encrypted posting-key
     blob) with random bytes, then zeros, then `fsync`s, then
     `unlink`s it. No `.bak` file is created.
   - Atomically writes the new keystore (encrypted active-key
     envelope) into the same path with 0600 permissions.
   - If the storage mode changed (it shouldn't, both are encrypted),
     updates `MORPHIT_RELAY_ACTIVE_KEY_FILE` in `morphit.env`.

## Verifying after

When the command finishes, the relay account on this server now has:

- `apps/relay/keystore.json` — the **new** active-key envelope.
- No `.bak-*` files anywhere in `apps/relay/`. Verify with:
  ```
  ls -la apps/relay/keystore*
  ```
  You should see exactly one file: `keystore.json`.

Then restart the relay:

```
sudo systemctl restart morphit-relay.service
```

The relay's startup unlock step:

1. Prompts for the passphrase (whatever you typed in step 7 above).
2. Decrypts the envelope to get the active-key WIF.
3. Derives the public key from that WIF.
4. Fetches the current active authority of `@<account>` from chain.
5. Refuses to start if the derived pubkey doesn't appear in the
   on-chain active authority's `key_auths` array.

That last check is the hard wall. If you somehow pasted the wrong key
again (an active key for a different account, or a posting key by
mistake), the relay's startup logs will say something like:

```
relay: active pubkey BLT... does not appear in @<account>'s
active authority on chain.  Refusing to start.
```

If you see that, re-run `morphit-ops edit-active-key` with the correct
key. The prior bad key was already wiped — there's no rollback path.
Just paste the right key this time.

## What this CAN'T promise

The wipe is a best-effort secure delete at the filesystem level. It
overwrites the file's allocated bytes twice (random, then zeros),
`fsync`s, then unlinks. On a stock ext4 or xfs without snapshots or
LVM thin provisioning, that means the prior ciphertext is no longer
readable via the file's old path and the inode is freed. The blocks
themselves are returned to the free pool.

But: if the server uses btrfs, ZFS, or APFS, or if LVM thin pools
have snapshots, or if there is full-disk SSD wear-leveling with
unallocated reserve, the prior bytes may still exist physically on
the device. The only defense against that class of recovery is full
disk encryption — which is a baseline you should have anyway for any
server holding crypto keys.

For the scenario this document covers — a posting key encrypted by a
known passphrase, which is *also* the wrong type of key to be useful
for any attack on the relay account — the practical risk after the
wipe is effectively zero.

## What about just re-running `morphit-ops init` instead?

That works but it's heavier:

- It re-prompts for all 20 wizard steps (instance name, tagline,
  DB URL, fees account, daily ceiling, contact, origin, alt-networks,
  fee explorers, chat-link explorers, disabled assets, listing fee,
  SEO, backup, operator tag, Matrix, RPC endpoints, MCP server).
- It rewrites `morphit.env`, `morphit.config.env`, and the keystore.
- The old keystore file is replaced by atomic rename — same no-trace
  property as `edit-active-key --wipe-prior`.

The downside is that any post-launch customizations you made via
`morphit-ops edit` (origin override, alt-network addresses, SEO copy,
etc.) get overwritten by the wizard's interactive prompts unless you
re-enter them carefully. `edit-active-key` is the surgical
alternative.

## Quick reference

Non-interactive equivalent (CI/scripted):

```
morphit-ops edit-active-key --wipe-prior
```

This skips the interactive "was the previous key compromised?" prompt
but still asks for the new key, the storage mode, and the new
passphrase. (Those are required and have no safe default.)

To force the safe path (keep `.bak` even for a wrong-key scenario):

```
morphit-ops edit-active-key --keep-backup
```

Mutually exclusive with `--wipe-prior`.
