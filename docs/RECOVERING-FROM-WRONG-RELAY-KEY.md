# Recovering from a wrong relay key

This is the procedure for one situation: the relay holds a key that is not
the relay account's **active** key — most often the **posting** key was
pasted at install — so the chain rejects everything the relay sends
("missing required active authority").

The same command also rotates the key on purpose (after a key change on
the chain, or if the key may have been exposed).

## Why the active key

The relay signs these chain operations for the relay account:

- `account_create` — signs up a new Morphit user (and pays the fee)
- `transfer` — sends the welcome bonus
- `transfer_to_vesting` — powers up donated BLURT
- `delegate_vesting_shares` — delegates BP for posting

Every one of them needs the account's **active** authority. A posting key
can sign comments and votes, nothing else. An owner key can sign them too
(the relay accepts it and signs), but it is the account's master key and must
never be kept on a server, so `edit-active-key` does not save one.

The relay signs with one key. A key that is on the active authority but with
a weight below the authority's threshold (for example one of two keys that
must both sign) cannot sign alone, so it does not work for the relay either.

## How you notice

At startup — and every ten minutes after — the relay compares the public key
of the key it holds with the relay account's keys on the chain. The key is
right when it is one of the account's active keys, or its owner key. The relay
decides that the key is wrong only when two Blurt RPC operators agree: one node
cannot stop the relay by naming other keys or by saying the account does not
exist (a node that is still catching up with the chain says that about every
account). With only one RPC operator configured, that operator's answer is
enough to say the key is right, but never that it is wrong; the relay then
signs as normal and says why in its log.

When the key does not match, the relay **keeps running but signs nothing**:
new signups are refused ("signups unavailable") and queued payments wait in
the queue (none are lost; they go out once the key is right). It does not
exit, because the service would only be restarted over and over. It stays
that way until the chain says the key is right — a check that gets no answer
in between does not let it start signing again with a key the chain rejects.

The quickest way to see the result, on this server:

```
sudo morphit-ops status
```

The line **Relay key:** says whether the key matches the chain, and if not,
what is wrong and the exact commands that fix it.

The relay also writes one plain line to its log, again at every check while
the problem lasts. To see the lines from the last fifteen minutes, on this
server:

```
sudo journalctl -u morphit-relay --since "-15min" --no-pager | grep active_key
```

A mismatch is one long line. For a relay account `alice-relay` whose posting
key was pasted, it reads (the date, server name and number at the start
differ on your server):

```
Oct 29 14:02:11 example morphit-relay[1234]: [relay-key] active_key_not_on_chain account=alice-relay public_key=BLT6… problem="The key this relay holds is @alice-relay's POSTING key, not its ACTIVE key." effect="The relay is running but signs nothing: new signups are refused and queued payments wait (none are lost) until the key is right." fix="On this server: sudo morphit-ops edit-active-key — paste the ACTIVE private key of @alice-relay — then sudo systemctl restart morphit-relay"
```

`active_key_matches_chain` means the key is right. If the chain could not be
asked, the relay writes `active_key_check_unanswered`: with no earlier answer
it signs as normal and asks again shortly; after an answer that the key is
wrong, it stays stopped until the chain says otherwise.

When the problem is that **the account does not exist on the chain** (the
`problem` says so), the key is not the cause: the account name the relay is
set to sign as is wrong, usually a typo. `edit-active-key` cannot change it.
On this server, look at the line `MORPHIT_RELAY_ACCOUNT=…` in both files the
relay reads, then restart it:

```
sudo nano /etc/morphit/relay.env
sudo nano /opt/morphit/morphit.env
sudo systemctl restart morphit-relay
```

You can also check the saved key yourself, on this server:

```
sudo morphit-ops show-key
```

It prints the public key of the saved key (never the private key) and checks
it against the chain: **✓ Matches** or **✗ Does not match** (and which key it
is instead). When only one node could be asked, it says it could not check,
and what that node said.

## What you need

- The relay account's **active** private key: in your Blurt wallet, open the
  account → "Keys" or "Permissions" → the private ACTIVE key (51 characters,
  starts with `5`).
- A shell on the server, with sudo.

## The procedure

On the server, from any folder (the command finds the install itself):

```
sudo morphit-ops edit-active-key
```

or, from the menu (`sudo morphit-ops`): **Rotate the relay active key**.

1. It prints the relay account and where its key file is.
2. It asks for the new active key — paste it (nothing shows on screen; that is
   intentional). It then **checks the key against the chain before anything
   is written**:
   - **✓ Matches** — it goes on.
   - **✗ Does not match** (two RPC operators agree) — it says which key you
     pasted (the posting key, the memo key, another account's key, or a key
     that cannot sign alone), shows the account's active public key as the
     chain lists it, writes nothing, and offers to paste another. The owner
     key is refused the same way: paste the active key instead.
   - If the chain cannot be read, or only one node answered, it says so (and
     what that node said) and asks whether to save the key anyway (the answer
     defaults to **No**, which changes nothing).
3. **Keep the same unlock passphrase?** — answer **Yes** (the default). The
   key file is encrypted with a passphrase that is sealed to this server
   (`/etc/morphit/relay_passphrase.cred`), so the relay opens it by itself and
   you never type it. If you choose a new one, it is sealed for the relay, and
   the Tor / I2P / Lokinet address key files (encrypted with the same
   passphrase) are moved to the new passphrase and read back. An address key
   file that neither the old passphrase nor the sealed one opens is named
   before the last question, with what can be done about it (for Tor and I2P:
   store a new copy of the key the router on this server uses).
4. **Keep a copy of the old key file on this server, so you can go back if
   something is wrong?**
   - **Yes** (the default): the old file is copied next to it, with
     `.bak-<number>` added to its name (on a standard install
     `/etc/morphit/relay.keystore.bak-<number>`).
   - **No**: no copy is kept, and once the new key is in place the old key is
     overwritten (random bytes, then zeros). Choose this when the old key was
     exposed. For a posting key pasted by mistake either answer is fine.
5. **Replace the relay's active key for @<account> now?** — **Yes**.

It then writes the new key file in place — the same path, so every settings
file that names it still does — keeping the old file's owner and mode, so the
relay (which runs as its own user) can read it. An old unencrypted key file
is encrypted in place. It reads the new file back, and prints exactly what to
run next.

If you press Ctrl+C, or the input ends (Ctrl+D), at any question, it stops
("Stopped") and nothing is changed.

## After

On this server:

1. Restart the relay so it uses the new key:
   ```
   sudo systemctl restart morphit-relay
   ```
2. Look at the result of its key check:
   ```
   sudo morphit-ops status
   ```
   or its log:
   ```
   sudo journalctl -u morphit-relay --since "-15min" --no-pager | grep active_key
   ```
   `active_key_matches_chain` means all is well.
3. If you kept a copy of the old key file, delete it once the relay works
   (the command printed its exact name):
   ```
   sudo shred -u /etc/morphit/relay.keystore.bak-<number>
   ```

## What the overwrite cannot promise

Overwriting the old key file (the **No** answer in step 4) writes over the
file's bytes twice and syncs them to disk. On a plain ext4 or xfs file system
without snapshots, the old key can then no longer be read back. On btrfs, ZFS
or LVM thin pools with snapshots, or on an SSD that remaps blocks, old bytes
may still exist on the device; only full-disk encryption protects against
that.

## Options for scripts

```
sudo morphit-ops edit-active-key --wipe-prior     # no copy of the old key file
sudo morphit-ops edit-active-key --keep-backup    # always keep a copy
sudo morphit-ops edit-active-key --config-dir=/path/to/install   # another install folder
```

`--wipe-prior` and `--keep-backup` cannot be used together. The key itself is
always asked for and checked.
