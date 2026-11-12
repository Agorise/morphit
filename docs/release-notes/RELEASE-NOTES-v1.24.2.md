# Morphit v1.24.2

A chat message no longer fails with a frightening red error when the Blurt network is slow to answer.
Morphit deals with it in the background: it asks again by itself, keeps your messages in order, and
sends a waiting message as soon as the network answers. The person sending has nothing to do.

This release contains everything in v1.24.1. The deadline v1.23.5 set still stands: every site must
run v1.23.5 or later (so this release is fine) before **2026-11-22 00:00 UTC**.

## For people using the site

**Sending a message no longer fails on a slow network answer.** Before a message is sent, Morphit
looks up the other person's keys on the Blurt chain, through your site. If that lookup didn't
answer in time, the message showed at once in red as "Failed", with a long warning about the
blockchain, though you had done nothing wrong. A message sent soon after opening the conversation
could even fail without asking at all, because it reused an earlier miss.

Now all of this happens out of sight:

- The lookup starts when you open the conversation, while you type, and quietly asks again if it
  missed. The keys are usually in before you press Send.
- A send that still has to wait shows "sending…" while Morphit asks again.
- A message that had to wait is sent before the ones you write after it.
- If the network still doesn't answer, the message shows as **"Not sent yet"**, in its usual colour
  and without any red, with a short note that it is tried again automatically while the chat is
  open. It is: about half a minute after each attempt, as soon as your device is back online, and
  before any newer message you send. Retry sends it at once.
- Sharing an address or recording a payment works the same way: the window closes normally, and the
  message goes out by itself. "Share your address" doesn't come back while your address waits, so
  you can't end up sending it twice.
- After **Pay now**, if the receipt has to wait, the confirmation says that the BLURT was sent and
  that its receipt goes to the chat as soon as the network answers. It also shows the transaction
  id, in case you leave the chat first: you can then mark the funds sent with it.

Every other place that looks up an account's keys (Verify peer, sharing an address, leaving a review,
pairing your phone, an order's details) now also asks a second time, quietly, before it reports a
problem.

## For operators

Upgrade as usual. Nothing to configure.

When your indexer cannot answer a key lookup, it now logs why: `account_keys_unanswered` with a
`reason` and the time it took (`ms`). The account looked up is never logged. The reasons:

- `deadline`: no two node operators gave the same keys before the deadline (nodes slow, down or
  resting);
- `no_quorum`: the read ended before the deadline without two operators giving the same keys (they
  disagreed, or too few answered);
- `unreachable`: the read itself failed;
- `incomplete`: a node sent an account without all its keys.

A browser now asks for an account's keys up to twice per lookup (never again after a refused
request), and a chat with a waiting message asks again about every half minute while it is open. A
site whose Blurt nodes are slow sees a few more of these requests, never a flood.

## For developers

- **`blurt/accountKeys.ts`:**
  - `fetchAccountKeys` asks once more after a failure, after `ACCOUNT_KEYS_RETRY_WAIT_MS` (1.5 s),
    inside the shared, de-duplicated request.
  - A 404 is an answer, and a 4xx (`AccountKeysStatusError`) would be refused again: neither is
    asked again.
  - `fetchAccountKeysForSigning` is now the plain lookup (it used to be the only one that asked
    twice).
- **`chatService.ts`:**
  - **The warm-up** asks again in the background after each of `WARM_UP_KEY_LOOKUP_WAITS_MS` (5 s,
    15 s, 30 s) while the conversation is open.
  - **A send** looks up the keys through `postingPubsForSend`.
    - It never takes a cached miss for an answer.
    - It asks again after each of `SEND_KEY_LOOKUP_WAITS_MS` (3 s, 8 s), the message `pending`
      meanwhile.
    - It stops waiting once a single try took `SEND_KEY_LOOKUP_SLOW_TRY_MS` (20 s).
    - A pin verdict is an answer.
    - Closing the conversation stops it.
  - **One network verdict per round:** within `NETWORK_VERDICT_HOLD_MS` of a send that used up its
    waits, the sends queued behind it fail at once instead of each waiting again. Retry clears it.
  - **Order:** sends pass the key lookup and encryption one at a time, in order (`sealInOrder`).
    Their broadcasts then start in that order.
  - **A lock** while a send waited its turn or looked up keys ends it as `session_locked`; it is not
    kept as unsent.
  - **Background resend:** a message failed on `chain_unreachable` is sent again by itself, oldest
    first (`retryNotYetSent`):
    - `NOT_YET_SENT_RETRY_MS` (30 s) after each attempt while the conversation is open;
    - on `deps.onOnline` (default: the window's `online` event);
    - ahead of any new message.

    Only with a live session. Like any unsent message, it is kept in memory for this tab (not in
    "destroy" mode) and forgotten on a lock.

- **`ChatMessage.svelte`:** a message failed on `chain_unreachable` is `isNotYetSent`: its usual
  colours, dimmed as while sending, `chat.message.not_sent_label`, the reason in grey, and Retry.
  Every other failure stays red (`isHardFailed`). The message list's `role="log"` live region
  announces the change.
- **`ConversationView.svelte`:**
  - `waitingToSend`: a waiting message counts as still sending for "Share your address"
    (`myAddressSharedHere`) and in a two-leg trade's money facts.
  - `sendFromModal` returns whether the message went out, and does not throw on `chain_unreachable`:
    the modal closes, and the message waits in the chat.
  - "Pay now" shows `chat.pay_blurt.success_toast_receipt_pending`, with the txid. Any other failure
    still shows `success_toast_no_chat_with_txid`.
  - A send scrolls to the new message when it starts, not when it ends.
- **Copy, all 10 languages:**
  - `chat.security.chain_unreachable` is rewritten: calm, no Tor/I2P aside, no claim about charges
    (a payment receipt's money has already left), tried again automatically while the chat is open.
  - `chat.message.not_sent_label` and `chat.pay_blurt.success_toast_receipt_pending` are new.
- **Server:**
  - `api/accountKeys.ts` logs `account_keys_unanswered` (reason and ms, never the account) for each 502.
  - The quorum read decides nothing when fewer than two operators agree, whether they disagreed or
    too few answered (the pool swallows a node's failure). Only the deadline's signal can be told
    apart: `deadline` versus `no_quorum`.
- **Tests:**
  - `postingChat.test.ts`: the old "a failed lookup is asked again only after a pause" test pinned
    the cached miss a send hit. It is replaced by 17 tests covering the send, the warm-up, order,
    the per-round verdict, the background and online resend, locks during a wait, a lookup and a
    retry, the 20 s cap, closing, pin verdicts and Retry.
  - `accountKeys.test.ts`: the deadlines across both tries, the quiet second try, and a refused
    request not asked again.
  - `chatMessageGuards.test.ts`: the calm state, and a real failure staying red.
  - `ConversationView.auditFlows.test.ts`:
    - "Pay now" for each outcome;
    - "Mark sent" closing on a network miss;
    - the scroll at send;
    - the live log;
    - "Share your address" staying hidden for a waiting card, in a one-leg and in a two-leg trade.
  - `accountKeysQuorum.test.ts`: each log reason, never naming the account.
  - Every part, undone on its own, fails a test or a smoke: 26 mutations.
- **Smokes:** `chat-sent-state-smoke` requires the not-yet-sent bubble to be dimmed, and still never
  a sent one.
