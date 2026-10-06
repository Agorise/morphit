# Morphit v1.18.0

A major release. Chat between instances no longer waits for the blockchain,
and before release every part of Morphit was reviewed again from the ground
up: that closed a way for one hostile chain node to take over a node during
setup, several ways a Tor-only node could still reveal its home address, and
free fake "verified" listings. The rest of this page gives the details, fix by
fix.

Chat between two privacy-only instances now lands in about two seconds instead
of eight, plus fixes for people using Morphit over Tor or I2P, an orderbook
comparison that accused honest instances of hiding orders, and a page that
blurred itself on load. It also closes two ways a Tor-only instance was still
reaching the open internet, one of them through its relay. The upgrade fixes
instances that are already installed, not only new ones. No protocol or
consensus change.

## Added

- **Chat between two privacy-only instances is now fast enough to hold a
  conversation in.** If you and the person you are talking to are on different
  instances, your message used to travel to them through the blockchain — and
  the blockchain's own timings made that hopeless. Sending waits for the message
  to be written into a block, which takes three seconds; the other instance then
  waits up to two more for its next check of the chain before it even looks. That
  is five seconds of waiting before a single Tor or I2P round trip is counted,
  and a delivered message pays for three of those. No amount of faster or extra
  chain nodes helps, because none of that time is spent talking to them.

  So instances now hand each other chat messages directly, at the same moment the
  message goes to the chain rather than after it. The chain still receives every
  message and is still the permanent record — nothing about what Morphit
  publishes has changed, and the saved copy of your conversation still comes from
  it. What has changed is that the other person no longer waits for it to get
  there.

  The connections between instances are kept open in the background, refreshed
  every few minutes. This matters more than it sounds: opening a fresh Tor
  circuit or I2P tunnel takes half a minute or more, and if the first message of
  a conversation had to pay for that, the one message where the other person has
  no reason to be watching their screen would be the slowest one. Keeping the
  route ready means the first message is as quick as the rest.

  An instance accepts a handed-over message only if it carries a valid signature
  from the sender's own posting key, checked against the key it holds for that
  account — so a message cannot be forged or put in someone else's name, and
  this is true no matter who sends it or where they connect from. If the key no
  longer matches, it is re-read from the blockchain once (rate-limited), and that
  correction is held in memory rather than written to your database. Blocks are
  honoured exactly as before, and a first message from a stranger still shows up
  in an open conversation without ringing anyone's phone. No message handed over
  this way is written to the database; the permanent record still comes from the
  chain alone. There is one write, and an earlier draft of these notes said there
  was none: when a handed-over message may notify someone who has push turned on,
  one row goes into the push queue, keyed on the transaction so it is queued once
  however many routes deliver it. That row is a notification, not the message,
  and the queue's own janitor retires it.

  Measured the whole way — one person's browser to the other person's screen,
  across two instances, every leg over a slow privacy hop — delivery went from
  7.3 seconds, which was the old route's *best* possible case, to about 1.4.

  To be precise about what that is: the instances, routes, signatures and
  sockets are real, and the per-hop latency is a stated model (900ms for a
  privacy hop). It is a measurement of the software under an assumption about
  the network, not a measurement of Tor. Real timings depend on your own
  circuits, and `ops/fastchat-latency-probe.sh` measures them on your box and
  tells you where you stand.

- **Two people on the same instance now get fast chat too — and they were the
  slowest case of all.** The fast path hands messages to OTHER instances, and an
  instance is not its own peer, so when both people were on the same server
  neither of them got any of this: the message went to the blockchain and came
  back a block later, then waited for the next check of the chain, then a read
  to fetch it. Up to 6.8 seconds on a privacy-only instance for two people on
  one machine, which is very likely the most common conversation there is. An
  instance now delivers to its own users the moment it relays their message,
  with the same block-list and notification checks it applies to anything a
  peer hands it. To the recipient's inbox: 1,334ms privacy-only, 527ms
  clearnet.

- **A reply to someone who just messaged you now notifies them.** Fast
  notification requires evidence the conversation is wanted — the sender is
  answering your own live order, or you have written to them before. Both were
  read from the permanent record, which runs 45 to 63 seconds behind. That broke
  the ordinary marketplace exchange in the half that matters: a buyer messages a
  seller about the seller's order and the seller is told at once, but when the
  seller REPLIES the order is not the buyer's, and the buyer's own opening
  message is not in the permanent record yet. So the person who started the
  conversation thirty seconds ago got no notification at all until the chain
  caught up. Measured before the fix: the check returned "no".

  An instance now remembers, briefly, that it just relayed one of its own users'
  messages to someone — first-hand knowledge it had all along, minutes before
  the permanent record admits it. This widens nothing: it only ever says yes to
  a pair where the recipient demonstrably wrote first, which is the same thing
  the old check meant, established sooner and from a better source. A message is
  only remembered after the network accepts it, so a forged one records nothing.
  Someone who has never written to you is as much a stranger as before.

- **An instance hands over what it has queued before it shuts down.** A restart
  used to drop chat deliveries that were waiting to go out to other instances.
  They still arrived by the blockchain, so nothing was lost — they were just
  slow, for whoever happened to be mid-conversation when an operator restarted.
  Shutdown now passes them on first, with a two-second limit so one unreachable
  instance cannot hold up a restart.

- **The browser's half of the inbox is now tested too.** The part of the app
  that turns a "new message" ping into a lit badge and a card for a conversation
  you have never had before had no test of any kind. It does now, and so does
  the agreement between the two halves: the server sends four specific fields,
  and the browser lights nothing without the three that name the thread. Rename
  one of those on either side and chat badges stop working for everyone —
  silently, with no error anywhere,
  which is the worst way for something to break. Both sides are now pinned, so
  neither can drift without a test failing.

  The same is now true of the *broadcast* contract — the thing this release
  actually changed — which had no test of any kind either. See "an older browser
  tab" below for what that omission was hiding.

- **Every combination measured, both directions, to the inbox.** Same instance,
  clearnet to clearnet, clearnet to privacy, privacy to clearnet, privacy to
  privacy — a buyer's first contact and the seller's reply, each timed to the
  moment it reaches the other person's inbox rather than an already-open
  chatroom. Slowest of all twelve: **1,367ms**, against the six-second bar.

  Each of those timings is now held to a floor as well as the six-second
  ceiling. A result *faster* than the hops that case has to cross means the
  message skipped a leg, which is what a test passing for the wrong reason looks
  like — so the test now fails on it. Adding that floor found two defects in the
  test itself, described under Fixed.

- **Sending no longer waits for the blockchain either.** Getting the message to
  the other person quickly is only half of it: the sender was still watching
  their own message sit there. Every send waited for the message to be written
  into a block before the page was told it had gone — up to three seconds of
  pure waiting, on top of the round trip to their own instance. Chat messages now
  return as soon as the network has accepted the message rather than when it has
  been sealed into a block. Nothing is given up: the message is still checked and
  still rejected if there is anything wrong with it, and it still goes to the
  chain exactly as before. Everything that genuinely needs a block number —
  orders, transfers, account creation — is unchanged and still waits.

  On a fast connection this was never the problem; on a slow one it was decisive.
  A send that waits for a block crosses six seconds once a round trip passes
  about 2.6 seconds, which privacy networks reach regularly. Measured on a
  three-second hop, the old behaviour took 6.4 seconds and the new one 3.4.

  **An older browser tab is safe.** The page asks for the faster answer rather
  than the server deciding on its own, because a tab you left open can be older
  than the instance serving it — and a tab from before this release would have
  read the new reply as a failure, showing you a red message that had in fact
  been delivered, with a retry button that would send it twice. An older tab
  simply never asks, gets the old reply, and still benefits from the fast
  delivery on the other side. Both directions of that mismatch are now tested.

- **A sick blockchain node no longer stops conversations.** Because the message
  is handed to the other instance before it is sent to the chain, a Blurt node
  that has wedged or gone unreachable no longer takes chat down with it. Measured
  with a node deliberately stalled for twenty seconds, the message still reached
  the recipient in under one.

- **A hidden instance no longer throttles its own federation.** Requests are
  rate-limited per address, and over Tor or I2P every instance in the federation
  arrives at the same one — the local privacy daemon — so the whole federation
  shared a single allowance meant for one caller. On a privacy-only node so does
  every human visitor, since all traffic arrives that way. Measured: the 241st
  hand-off in a minute was refused no matter how many different instances sent
  them, which would have crippled fast chat on precisely the nodes it was built
  for. The allowance is now sized for a real federation, and the actual
  protection moved to something that works regardless of address: a fixed-size
  queue of pending work.

- **A busy instance no longer goes deaf.** Checking a message's signature costs
  real processor time — about four milliseconds each, measured — and a delivery
  can carry dozens. Done the obvious way that work would run in one solid block,
  during which the instance answers nobody: no chat updates, no page loads,
  nothing. Checking now happens after the sending instance has been answered,
  and pauses between messages so everything else keeps running. Measured: the
  instance never went quiet for more than 17 milliseconds while checking 64
  messages, and answered the sending instance in 2 milliseconds rather than the
  330 the checking itself takes.

  This also removes a subtle leak. An instance that took longer to answer for a
  message it cared about than for one it did not would be telling anyone with a
  stopwatch whether a particular person reads their messages there. Answering
  before doing the work means the reply reveals nothing either way.

- **Under real overload, fast chat steps aside instead of falling over.** There
  is a firm limit on how much pending work an instance will hold. Past it, extra
  hand-offs are dropped rather than queued — and dropping is the right answer,
  because every one of those messages is already on its way through the
  blockchain, which delivers it regardless. An overloaded instance quietly
  returns to ordinary blockchain timing instead of accumulating work it cannot
  finish in time. The `shed` counter in the health output is the thing to watch.

- **Fast chat holds up as the federation grows.** Every message is offered to
  every instance, so each instance has to keep up with the whole network's chat,
  not just its own users'. One message per delivery could not have done that: a
  privacy connection carries one exchange at a time, so a single instance would
  have topped out at well under one message a second no matter how many users
  were waiting. Messages that arrive while a delivery to an instance is already
  in progress now travel together in the next one. Nothing is ever held back
  waiting for company — a message to an idle instance leaves immediately, which
  is the ordinary case — so this costs nothing when things are quiet and does the
  work when they are not. Measured: forty messages that would have needed forty
  round trips took two, about eighteen times the throughput per instance, with a
  lone message still leaving in four milliseconds.

## Fixed

### Found by an independent review of this release

Everything in this section was written after four reviewers — none of whom had
seen the code being written — went over the new delivery path. It is listed
first because some of it is serious, and because a release that only tells you
what went right is not telling you much.

- **Ten requests a second could have stopped an instance accepting anything.**
  The new peer endpoint shared a rate-limit allowance with the ordinary write
  path, because the limiter groups requests by category rather than by limit. Six
  hundred peer messages in a minute — no key needed, nothing valid needed — and
  every user on that instance would have been refused: no chat, no orders, no
  transfers. On a privacy-only instance, where every visitor and every peer
  arrives through the same local daemon and therefore looks like one caller, that
  is one allowance for the entire world. Federation traffic now has its own.

- **Batching was switched off by the size limit it ran into.** Grouping messages
  is what makes a busy federation affordable, and a full group of long messages
  is a quarter of a megabyte against a limit of four kilobytes. Groups form only
  when an instance is already busy — so the fast path worked while idle and
  refused its own traffic under exactly the load it exists to carry, silently
  falling back to blockchain timing. The limit now matches what the endpoint
  carries, the sending side keeps itself under it, and an instance that refuses
  the size anyway is sent the messages one at a time instead of losing them.

- **One database hiccup could have turned the fast path off until the next
  message arrived.** A single failed lookup abandoned every message waiting to be
  checked, with nothing scheduled to come back for them — and they went on
  occupying the queue until it was permanently full and refusing everything. One
  failure now costs one message.

- **An older browser tab would have shown delivered messages as failed.** A tab
  left open from before this release reads the new, faster reply as malformed:
  the message reaches the other person, and the sender sees it in red with a
  retry button that sends a second copy. The faster reply is now something the
  page asks for, so an older tab never gets it.

- **A message could be shown as sent forever without ever reaching the chain.**
  Waiting for a block used to be the proof it had landed; without that wait,
  nothing replaced it, and an accepted-but-dropped message looked delivered
  indefinitely to both people. A send that is not confirmed within two and a half
  minutes is now marked so and can be resent — and if the real copy turns up
  late, the mark clears itself. (The window was two minutes until the last round
  of review showed that the slowest legitimate path takes up to 123 seconds.)

- **A lost reply could turn a delivered message red.** Your instance shows your
  own message to you before it answers the send, so a connection that dropped at
  the wrong moment stamped "failed" over a message already visible in the
  transcript. Retrying sent it twice.

- **The endpoint had no ceiling on several things anyone could inflate.** How
  many signatures one message carries (each costs real work to check), how far in
  the future a message may claim to expire (which decides how long a captured one
  can be replayed), and how large a group may be. All bounded now, and each bound
  has a test that was watched to fail without it.

- **A free, untraceable way to light someone's inbox badge.** Every other use of
  a fast message checked whether the sender was allowed to notify that person;
  the live badge did not. That mattered little when every message had to go
  through the blockchain — which costs resource credits and leaves a record — and
  a great deal once an instance could hand one over directly. The badge now obeys
  the same check as everything else, and first contact from the peer route is
  rate-limited per sender, per recipient — so a flooder exhausts only their own
  channel to that person, and the direct path is not a cheaper way to reach
  someone than the chain it runs alongside. Established conversations are not
  affected at all, and an open chatroom still receives everything unconditionally.

- **A stolen key kept working after its owner replaced it.** Posting keys were
  recorded once and never updated, which no previous feature depended on. This
  one does: the key is the only thing standing between a handed-over message
  and your screen. So a key the owner had replaced after it leaked still
  verified, which the blockchain itself would refuse. And the owner's own
  messages, signed with the new key, stopped verifying.

  Your instance now records a key change from the same blocks it already reads
  account creations from. It also forgets any copy of the old key it was holding
  in memory. That second step is not a detail. Without it, the leaked key would
  have kept working for up to half an hour, in exactly the case a key change is
  for. Tested against real key-change operations and a real database; removing
  only the forgetting step fails the leaked-key case.

  **Key changes made before you upgrade are covered too.** Recording changes
  from now on does nothing for an account whose owner replaced a leaked key
  last month: your database still holds the leaked key. So every key recorded
  before this release starts out unconfirmed. On its first start, your instance
  checks each one against the blockchain and corrects any that changed. Until
  an account's key is confirmed, a message handed over for it is checked
  against the blockchain first. If the blockchain can't be asked right then,
  the message travels by the blockchain as it always did.

- **Two defects in this release's own tests.** Adding a lower bound to the timing
  checks — a result *faster* than the hops it had to cross is a bug, not good
  news — immediately exposed them. The link between instances was being modelled
  in one direction only, so every reply figure quoted was short by half a hop;
  and the stand-in blockchain gave every message the same identifier, so the
  duplicate-suppression correctly discarded the second message in each case while
  the test, which only checked that notifications arrived, never noticed. Both
  fixed, and the figures in this document are the corrected ones.

  Worse, the four cross-instance cases were not crossing instances at all: both
  stood-up instances shared one in-process event channel, so the test passed with
  the entire federation deleted. It now fails 24 of 36 checks with the send side
  removed and 24 with the receiving side removed, and both of those deletions are
  permanent parts of the test suite.

- **The test of the notification check was answering the wrong question.** Its
  stand-in database returned an order in a shape the real query never produces,
  so the check said "no" in every scenario — meaning the headline promise of this
  release, that a stranger's first message reaches a seller whose browser is
  shut, was never actually tested. It is now, in both directions.

### Found by checking the release against what it was for

The feature is meant to be fast between instances **of every type, across every
network Morphit runs on**. Read strictly, that is a claim about three networks —
Tor, I2P and Lokinet — and it had been tested against one.

- **Federated chat did not work at all on an instance without a Tor daemon.**
  Which is most of them: a fresh install has no Tor, and the setting that points
  at one is filled in by default whether or not anything is behind it. So your
  instance picked the `.onion` of every peer that had published one, threw away
  the ordinary web address sitting right beside it, and failed to deliver a
  single message to those peers — instantly, silently, for as long as that
  configuration stood. Nothing errored, your peer count looked healthy, and the
  only symptom anyone could report was that chat was "sometimes slow", because
  every message quietly fell back to the blockchain's own timing.

  An instance now keeps **every address a peer has published** and picks one it
  can actually reach, preferring the private ones exactly as before. If a
  private route turns out to be unusable, the message goes by another road
  within the same send — a few milliseconds later, not a timeout later —
  and your instance remembers which network is down so the next message does not
  pay to find out again. When the daemon comes back, the next background check
  notices and the private route resumes on its own.

  Two instances that are both private-only, with no ordinary web address between
  them, fail over to each other's second private network instead. That is the
  case with nothing underneath it, and it is now the case with a test.

- **Your instance could mark healthy peers as unreachable when the fault was
  yours.** If your Tor daemon stopped, your instance went through the federation
  directory recording every `.onion` peer as unreachable — peers that were up the
  whole time. The protection against exactly this was written, and documented,
  and could never run, because of a detail of how failures are reported inside
  the browser-style request library. On I2P and Lokinet the protection had never
  existed at all. All three now work, and the test for it uses real failures from
  a real dead connection rather than ones written by hand, because a hand-written
  one would have agreed with the bug.

- **A connection setting could have quietly undone the whole point of keeping
  routes warm.** Your instance holds open a connection to each private peer and
  refreshes it every three minutes, so a message never waits for a new tunnel to
  be built — which on Tor or I2P takes half a minute or more. How long an unused
  connection is kept is a separate setting, in a different file, and nothing
  checked that it was longer than three minutes.

  Had it ever been set shorter, every single refresh would have found the
  connection already closed and built a new one: the loop that exists to remove
  that cost would have been paying it instead, on a timer, forever. Nothing
  would have looked wrong — messages still arrive and the refresh still reports
  success. Only the speed would have changed, on exactly the networks where it
  hurts most.

  Both settings are now checked against each other, and against the point where
  Tor discards an idle circuit at the other end. Separately, the I2P side now
  proves it reuses one tunnel across many messages rather than opening a new one
  each time — Tor has been checked that way since the start, I2P never had been,
  and it is the same setting that keeps the six-second promise on both.

- **If your I2P router is set to refuse tunnels, your instance now says so
  instead of blaming your peers.** Reaching another instance over I2P means
  asking your own I2P proxy to open a tunnel. The Java I2P router has a setting
  that refuses those outright — `i2ptunnel.httpclient.allowInternalSSL=false`,
  which despite its name blocks ordinary in-network destinations on every port.
  i2pd has no such setting and cannot be configured to refuse.

  When that refusal happened, your proxy was running and answering, so it did
  not look like anything being down. It was recorded as **the other instance
  refusing your message**. The result was a climbing failure count pointed at
  peers that were perfectly healthy, no mention anywhere of your own router,
  and federated chat over I2P simply not working.

  Your instance now recognises the refusal for what it is and reports it in
  `/v1/health`. It still waits for two different addresses to fail before
  blaming your router rather than the destination — a router refusing by policy
  refuses every address, so that happens immediately — and the operator guide
  explains which field to read when you have only one I2P peer.

- **One peer's out-of-date Lokinet address could push your other Lokinet
  traffic onto the ordinary web.** When a private route fails, your instance
  decides whether the fault was its own — and if it was, stops offering that
  network to every peer for a minute. On Tor and I2P it can tell: the failure
  names your own daemon. On Lokinet it cannot, because the failure is a name
  that would not resolve, and a peer whose published `.loki` address is stale or
  mistyped fails in exactly the way your own router being switched off fails.

  So one peer with an out-of-date address was read as your Lokinet being down.
  Every other `.loki` peer then lost that route for a minute, and any of them
  that also publish an ordinary web address had your messages sent that way
  instead — on an instance whose operator chose a private network precisely to
  avoid it. Nothing failed, so nothing was reported.

  Your instance now waits for **two different addresses** to fail before blaming
  its own router, which a router that really is off supplies immediately, since
  it fails every address it is given. A route that is proven to work clears the
  suspicion, and old evidence expires rather than accumulating. Tor and I2P are
  unchanged and still decide on the first failure, because there the failure
  says whose it is.

- **A censored instance is now found over whichever private network it
  published.** Your instance retries an unreachable peer over its hidden address
  — but it only ever tried `.onion`. An instance behind a national firewall that
  had published only an I2P destination, which is what an operator does where Tor
  itself is blocked, was recorded as unreachable and dropped out of the
  directory. All four published address types are tried now.

- **And `morphit-ops health` now shows it, which is where you would actually
  look.** All of the above went onto the health endpoint, and the tool you use
  to read that endpoint displayed none of it — it showed the blockchain-tailing
  half and stopped. The operator guide, meanwhile, told you to read these fields
  with the ops CLI.

  Running `morphit-ops health` now gives you a line for federated chat, with the
  reason underneath when there is one:

  ```
        Fed. chat:     degraded — tor unusable from this box (12 delivered, 40 failed)
              ↳ your tor is not answering — start it; the next warm-up clears this
  ```

  Forty failures that are not your peers' fault, and the fix on the next line.
  An instance older than this release has nothing to report here and the line is
  left out rather than shown as zeros, because during an upgrade "0 delivered"
  would read as a fault instead of a version difference.

- **When chat is slow, `/v1/health` now tells you whose fault it is.** A failure
  count sends you looking at the federation when the answer is a daemon on your
  own machine. Your instance now reports which of its own networks are down, by
  name, and marks each recent failure with whether the message ever left your
  box. The reasons were always recorded; until now only the tests could read
  them.

- **A growing federation would have spent its message fan-out on dead
  instances.** Every chat message goes to every other instance, so that list is
  capped — and which instances made the cut was decided by how recently your
  node had last checked on them, which says nothing about whether they are
  answering. An instance known to be down, checked a minute ago, outranked a
  healthy one checked an hour ago. Worse, a brand-new instance sorted below all
  of them, because it had never been checked at all — so the one place whose
  users have no established conversations to fall back on was the first to be
  left out.

  Instances are now ranked by health, with censored ones kept among the healthy
  (unreachable over the ordinary internet but demonstrably alive on the chain is
  the case Morphit is built for, not a sick node). Your node also now says how
  many instances the cap left out, so "healthy, reachable, and still slow" has
  an answer instead of being a mystery.

  Nothing is mis-served today — the federation is far smaller than the cap. It
  is fixed now because the failure it produces is invisible from the affected
  instance, and "we are far from the limit" is how a cliff goes unlit.

- **Message ordering does not depend on anybody's clock, and now cannot start
  to.** A message delivered directly carries no timestamp of its own; the
  receiving instance works one out from the transaction. If that had come from
  the sender's clock, two operators whose servers disagreed about the time would
  have shuffled each other's messages — and every operator would have needed to
  keep their clock in sync without ever being told so.

  It comes from the blockchain's own clock instead, which every instance shares,
  so this was never a problem. But the one number the calculation depends on was
  written down separately in the browser and in the server with nothing tying
  them together, and changing either alone would have quietly misdated every
  directly-delivered message — visible only as messages appearing in the wrong
  order next to ones that arrived the slow way. There is now a check that fails
  if the two ever drift apart.

- **A missing database index could switch off every push notification on your
  instance, and nothing would have told you.** A chat message is notified twice
  on purpose — once when your instance sees it, once when the chain makes it
  final — and exactly one of those is allowed to reach the phone. The mechanism
  is a uniqueness rule in the database that the second one collides with
  harmlessly.

  If that rule is absent, PostgreSQL does not quietly skip the check: it refuses
  the insert outright. Your instance catches the refusal so a notification
  failure can never take a chat message down with it — which is the right
  behaviour, and which means a database missing that one index delivers **no
  chat and no feedback notifications at all**, with no error page, no failing
  health check, and one log line per message. Outbid notifications carry on
  working, which makes it worse rather than better: push is evidently alive, so
  nobody would connect "my phone stopped buzzing for messages" to a schema
  problem.

  This is not hypothetical bookkeeping: the index is created by a migration, and
  a database restored from a dump taken with the wrong flags, or hand-repaired,
  or migrated by an interrupted run, arrives without it and looks completely
  healthy.

  `morphit-ops doctor` already compared your database's tables and columns
  against the shipped schema and would tell you about anything missing. It had
  never looked at indexes. It does now, and it names the ones you are missing.
  Getting that right needed one subtlety — the schema creates a handful of
  indexes and later replaces them, so counting those as missing would tell every
  healthy operator their database was broken, which is how a real warning gets
  trained into background noise. Verified against three live databases: a
  healthy one reports clean, one with the index dropped names it, and restoring
  it goes clean again.

- **On a slower server, your instance now knows how many messages it can take
  and still be fast.** Every message another instance hands you has its signature
  checked before it is shown, and those checks happen one at a time. So anything
  waiting in that line is waiting behind all the checks in front of it — which
  means the length of the line is really a length of *time*, and how much time
  depends entirely on how quick your hardware is.

  Your instance used to allow a fixed 500 messages to queue up, whatever kind of
  box it was running on. On a fast machine that is about three seconds and fine.
  On a modest VPS with the database in a container it can be ten — so your
  instance would accept a message, tell the sending instance it had it, and then
  deliver it well outside the six seconds this release is built around. That is
  worse than politely declining it, because a declined message travels by
  blockchain and arrives late in a way nobody was misled about.

  Your instance now times its own checks and allows exactly as many to queue as
  it can still clear in time. A fast box carries more than before; a slow one
  carries less and says so. `morphit-ops health` shows the figure when it is
  below the maximum, along with what a check is costing you:

  ```
        Fed. chat:     3 peer(s) (120 delivered, 8 failed)
              ↳ received 97 from peers, 61 shed
              ↳ intake queue held to 252 (18.2ms per check) so pushes still land inside 6s — extra pushes go by chain
  ```

  Nothing to configure. If you see that line, the overflow is going by blockchain
  exactly as it always did, and a faster disk or a less busy machine is what
  would raise the number.

- **And the line above it was broken since the last release.** `morphit-ops
  health` was written to read a field the indexer does not send, so "received N
  from peers" never appeared on anybody's terminal. It does now. The two sides
  are checked against each other from this release on, so a rename cannot quietly
  disconnect them again.

- **A captured message could have been re-delivered by flooding your instance.**
  Your instance remembers every message another instance hands it, so the same
  one cannot be shown to you twice. That memory is finite, and it used to make
  room by forgetting its oldest entry — which meant anybody could decide when it
  forgot, by sending enough of their own messages to push the rest out.

  The result would have been a real message from a real person appearing in a
  conversation a second time, minutes later. Not a forged message: nobody can
  write in someone else's name, and the blockchain copy remains the record of
  what was actually said. But a duplicate nobody sent, which is unsettling and
  looks like something worse than it is.

  Measured rather than assumed, and the surprising part is which instances were
  exposed: the memory holds fifty thousand messages, and the limit on filling it
  is how fast your server checks signatures — so **a fast server was more
  exposed than a slow one**, because it could be emptied sooner. On the hardware
  this was measured on it took under five minutes.

  Your instance now refuses new hand-offs rather than forgetting something it
  still needs to remember. Those refused messages arrive by blockchain as they
  always did. If it happens, `morphit-ops health` says so plainly, because at
  any volume it means somebody is trying:

  ```
              ↳ 41 push(es) refused to protect replay memory — a flood, or this box is busier than that table is sized for
  ```

  Nothing to configure, and the memory recovers by itself.

- **A just-restarted instance is now cautious about how much it takes on.** The
  limit described above — how many hand-offs your instance queues before
  declining — is worked out from how long its own signature checks take. Until
  it has done a few, it has to assume something, and it used to assume the speed
  of a fast machine with a local database.

  On anything slower that assumption is optimistic in the dangerous direction:
  for the first minute or so after a restart your instance would accept more
  than it could deliver in time. Which is precisely when a backlog is waiting —
  the messages that arrived while it was down.

  It now assumes the slow end to begin with and speeds up as it measures itself.
  A fast server reaches its true capacity within a few dozen messages; a slow one
  never over-promises in the first place. The only visible difference is that a
  busy instance may decline a few more hand-offs in the minute after a restart,
  and those arrive by blockchain as always.

### Found by following each fix to its edges

The last rounds of review took every open question left from earlier rounds and
read the code around it, not just the lines it named. The first two items are
the most serious in this release, and both are about a promise Morphit makes to
operators who run hidden-only.

- **A hidden-only instance contacted other instances over the open internet.**
  An instance set up to use no clearnet at all still looked up and connected
  directly to every peer that has a clearnet address, every time it checked the
  directory. That hands this box's real IP address to every one of those
  peers, which is the exposure hidden-only mode exists to prevent. The safety
  net that is meant to refuse any stray clearnet request was being bypassed by
  the one piece of code that made its own connections. It now refuses before it
  even looks the name up, since the lookup alone reveals which peer you are
  asking about. A peer your instance declines to contact is listed as "not
  checked", never as unreachable. Demonstrated with a real listener standing in
  for the peer: before the fix it was contacted; after, it is not.

- **The relay on a Tor-only install used clearnet blockchain nodes.** The relay
  is the part of Morphit that sends signups and transfers to the blockchain. It
  has its own list of blockchain nodes, and the Tor-only install never set it,
  so it used the public clearnet list from the box's own address. It also could
  not use a Tor or I2P node at all, and would not start without a clearnet
  one. The instance still said "Zero use of clearnet internet", because that
  claim only asked the indexer.

  The relay now uses the same Tor and I2P routing and the same fail-closed
  safety net as the indexer. A Tor-only install gives it only hidden nodes, and
  upgrading does the same for a node that is already installed. The
  "zero clearnet" claim now asks the relay as well, and is not made unless the
  relay confirms it. A hidden-only relay does not send phone or browser push
  notifications, because every push service in existence is a clearnet server.
  See Notes for what to configure.

- **…and turning push off there had two side effects, both fixed.** On a node
  where people had subscribed to push before upgrading, the queue of pushes
  waiting to go out would have grown for as long as the node ran, because only
  the push sender cleared it. It is now cleared by the same rules whether or not
  anything is sending. And those people's browsers kept saying "subscribed", or
  told them the operator had not turned push on "yet". Now the settings page
  says plainly why push is off on this instance, in all ten languages, and stops
  claiming a subscription that nothing will deliver to.

- **Prices on a hidden-only instance never came from the federation.** A
  hidden-only instance sets its prices from what its peers report. It had never
  received a single report: every request to a peer was sent through a function
  that refuses Tor and I2P addresses, and the price checker was off by default.
  So it priced everything from its own trades or the fixed minimum, while its
  public status said "federated". It now asks each peer at every hidden address
  that peer publishes, over I2P, Tor and Lokinet, and always runs on a
  hidden-only instance. Clearnet instances are unchanged.

- **A message the blockchain never recorded looked delivered.** The check that
  marks an unconfirmed message almost never ran. Your own instance
  shows you your message the moment it accepts it, and that moved the message
  past the state the check was looking at. It now covers that case. A resend
  inside an order conversation also dropped the order it belonged to, so it was
  charged as a message to a stranger and filed as a direct message; resends now
  keep it.

  On the other person's screen, a message that never reaches the blockchain is
  no longer shown as if it had. After two and a half minutes it is shown dashed
  and dimmed, with a note saying it was never recorded. The PDF export says the
  same instead of "pending". If the real copy arrives late, the note clears
  itself. A resend replaces the unrecorded copy only when the words are
  identical, so a resend cannot swap new words in behind old ones. The two
  error messages that were English-only now appear in all ten languages.

- **A review and a chat message in one transaction could cost a notification.**
  Both used the transaction's id to recognise their own duplicates, so the second
  one looked like a copy of the first and was silently skipped. Reviews now use
  their own key. Chat's key is unchanged, so the protection against being
  notified twice for one message still works exactly as before.

- **An I2P key handed over as text was saved in a form I2P cannot use.** The
  key import accepted a key written out as base64 text, checked it, said it was
  valid and named the address it hosts. Then it stored the text, not the key
  itself. Restored to i2pd, that hosts nothing and logs nothing about why. It now
  stores the key itself. Tested against a real i2pd: the restored key hosts the
  address the import promised. A file that holds only the public address still
  gets refused with nothing saved, as before.

  **If you imported an I2P key as base64 text on 1.17.15, it was stored that
  way.** Exporting it now writes the binary form i2pd can use, and prints a
  note saying so. To store it in that form too, import the exported file again.

- **Your instance now checks its own Tor, I2P and Lokinet directly.** It used to
  find out that one of them was down only when a message failed to go through
  it. It now checks at startup and every minute. For Lokinet it asks the name
  that always means "this machine", which proves Lokinet itself is working. That
  settled a question the instance could not answer before: when a Lokinet peer
  cannot be reached, is it that peer or our own Lokinet? Because it could not
  tell, a peer whose Lokinet address had died kept its place in the list of
  peers each message is sent to, indefinitely. Now it is recorded as failing
  and makes way for peers that work.

### Found by a final review, after the release was cut

1.18.0 was fully tested and ready to publish when five more reviewers read it,
each taking one part: the receiving side, the sending side and its transports,
the database and key handling, the browser and relay, and the upgrade and
operator scripts. None of them had seen the code written, and each was asked
to look for what the fifteen earlier rounds had missed. They found forty-four
things. Each finding was reproduced or traced before it was fixed. Each code
fix has a test, and each test was first run against the unfixed code and seen
to fail. What they found, most serious first:

- **Any chat message ever sent could be replayed as new.** Every chat
  transaction, signature included, is public on the chain. An instance checks
  a handed-over message's expiry time, but only when the time was written the
  usual way. The same time wrapped in a list skipped the check, and the
  signature still verified. Anyone, with no key, could take an old message
  between two people and hand it to an instance again, as often as every
  twelve minutes. It arrived stamped as new: at the bottom of the open
  chatroom, with the unread badge lit and possibly a phone notification. An
  old "pay to this address" message could become the newest message in a
  trade. An instance now accepts only a transaction in exactly the shape the
  chain writes. It rebuilds a clean copy from the checked fields and uses that
  copy for everything after, not the one it was sent.

- **A posting key the owner had disowned could keep working.** Your instance
  checks handed-over messages against the posting key it holds for the
  sender. Two kinds of account change did not update that key. One emptied the
  posting keys, which is a natural way to stop a leaked key. The other needed
  two keys to sign together. Either way the old single key stayed trusted for
  fast chat after the chain stopped accepting it. A key is now trusted only
  when it can sign alone, and any change to an account's posting authority
  updates the stored key, clearing it if no single key qualifies.

- **Keys were confirmed against a single chain node.** This release confirms
  every posting key recorded before it, and that confirmation believed the
  first node that answered. A node that was out of date could confirm a key
  the owner had already replaced, and it would stay confirmed. Keys are now
  confirmed only when two nodes agree. Four related gaps are closed with it:
  - a key missing from a node's answer is treated as no answer, not as "no
    key";
  - a failed confirmation is retried in the background, starting after a
    minute and backing off to half an hour, instead of waiting for the next
    restart;
  - a database restored from a snapshot has every key marked unconfirmed, so
    this node checks them itself instead of trusting the publisher's marks;
  - while this node's indexer is more than 200 blocks behind the chain, fast
    chat asks the chain instead of trusting the stored key.

- **One instance could stop your instance checking its peers.** When a peer
  on Tor, I2P or Lokinet answered with an error and a large page, the
  connection was never closed and the probe waited for it forever. From then
  on no peer was checked again until a restart, so the directory and fast-chat
  rankings froze. An error answer's body is now discarded, and closing the
  connection has a time limit.

- **One registration could switch I2P off for fast chat, everywhere.** An
  instance decides its own I2P is down when two different addresses fail in a
  way that points at its own router. Both addresses could belong to one peer,
  which can publish two. So a single registration with two dead I2P names made
  every instance that tried them drop I2P for a minute at a time, moving other
  peers' messages to Tor or the clearnet. It now takes two different
  instances. The same review found that peers listed without a check (a
  clearnet peer seen from a hidden-only node, for example) were ranked with
  the best-checked peers for fast chat. They now rank below every peer that
  was actually checked.

- **Tor-only servers were asking their internet provider about Lokinet.**
  Lokinet has no proxy, so a `.loki` name is looked up with the system's DNS.
  On a server without Lokinet, which is every server Morphit installs, that
  DNS is the internet provider's. The indexer asked it for `localhost.loki`
  once a minute, and for every peer's `.loki` address on each warm-up and
  send. That tells the provider the server runs Morphit. Lokinet is now off
  unless you publish a Lokinet address or set `MORPHIT_INDEXER_LOKINET=on`.
  The same review closed three more lookups a tor-only server should never
  make:
  - with its Tor or I2P proxy switched off, the indexer handed `.onion` and
    `.i2p` names to the ordinary connection, whose first step is a DNS lookup;
    they are now refused;
  - a `.onion` name of the wrong length was not treated as hidden, and went to
    DNS; it is now refused;
  - `morphit-ops doctor` fetched the node's own `.onion` address directly
    before trying the local port, which sent the node's own onion name to the
    provider's DNS; it now goes straight to the local port for a hidden
    address.

- **A trading partner could put words on your screen next to a blockchain
  proof they did not match.** Your browser merges two copies of the same
  message: the one delivered fast, and the one read from the chain. It matched
  them on a tag chosen by the sender, and never compared what they said. A
  sender could have one message delivered fast and never recorded, then record
  a different message under the same tag. Your screen, and the PDF export,
  then showed the first message's words with the second message's "Blockchain
  proof". Two copies are now merged only when their encrypted contents are
  identical.

- **Leaving a chat lost the "not sent — tap to retry" state.** A message the
  network accepted but that never reached the chain is marked failed after a
  while and offered for resending. That state lived only while the
  conversation stayed open. Leave and come back, and the message either
  restarted its wait or quietly disappeared. While the tab stays open, it is
  now kept until the message is confirmed or resent. (In the setting that keeps
  no copy of your own messages there is nothing to restore, so nothing
  changes there.) And before marking anything failed, the page now
  asks the chain for the transaction. A slow indexer used to make a message
  already on the chain look lost, and resending it put it there twice.

- **On a Tor-only relay you could not remove your push subscription.** Such a
  relay sends no web push, and it refused every push request, including
  "unsubscribe". The stored link between your account and your device's push
  address stayed, with nothing ever pruning it. Unsubscribing now works
  whether or not the relay sends push, and the settings page does it for you
  when it learns push is off there.

- **A message the chain had already accepted could be reported as rejected.**
  If a chain node took a transaction but the answer timed out, the next node
  answered "duplicate", and that was reported as a rejection, which invites a
  second copy. For chat, "duplicate" now counts as sent.

- **One slow chain lookup could hold up every incoming message.** When a
  sender's key needed re-reading from the chain, the single worker that checks
  incoming messages waited for it, for tens of seconds if the chain nodes were
  slow, while more messages were accepted behind it. Those checks now run
  beside the queue, at most sixteen at once and fifteen seconds each. A
  message that is not checked in time goes by the chain as usual.

- **Smaller things on the receiving side.** One malformed entry turned a whole
  batch into an error and dropped the good entries after it; it now costs only
  that entry. Queued messages kept whatever extra data the sender attached, up
  to about 128 MB for a full queue; only the checked copy is kept now. Two
  deliveries of the same message arriving together could both announce it;
  the second is now suppressed before either waits on anything.

- **Smaller things on the sending side.** A warm-up read a peer's reply with
  no size limit; it now stops at 64 KB. A connection to a peer was closed by
  the peer's web server after 75 seconds idle, but renewed every three minutes,
  so every renewal paid for a new tunnel. The frontend now keeps idle
  connections for five minutes and says so in its replies. Shutdown now has a
  time limit even with a warm-up in progress. The Tor connection code could
  report one failure twice. A failure while greeting your own proxy was blamed
  on the peer. A proxy that closed early was waited on for the full twenty
  seconds. A proxy reply of an unexpected length could leave stray bytes in
  the connection. And bytes that arrived with the proxy's reply could be lost.

- **`morphit-ops doctor` passed a broken push index.** If an attempt to create
  the push queue's unique index failed, Postgres left an index with the right
  name that it does not use. Doctor checked only the name, so it reported a
  healthy schema while every chat and feedback push failed to queue. It now
  checks that the index is valid and unique, and the repair steps in
  OPERATIONS.md drop a broken index before rebuilding it.

- **A very old database could not upgrade.** Migration 38 builds an index on
  a column that is only added after all migrations have run. A database old
  enough not to have that column stopped at migration 38 on every boot. The
  migration now adds the column first if it is missing.

- **The latency probe could report `PASS` for a peer it never reached.** The
  script you run after this release to measure real Tor and I2P timings
  counted an error page from your own I2P proxy as a fast answer. It also
  measured I2P on a different path from the indexer's, could run its three
  "cold" Tor samples on one existing circuit, read settings the indexer does
  not use, and, given a clearnet address, connected to it directly from your
  server. All fixed; see "Measuring real fast-chat latency to a peer" in
  OPERATIONS.md for what it does now.

- **The relay fix for Tor-only nodes now proves itself.** On a node that uses
  no clearnet, the upgrade moves the relay onto hidden services only. It used
  to announce "The relay now reaches the chain over hidden services only" as
  soon as it had edited the file, before any restart and without checking. It
  now restarts the relay and reads the relay's own health report. If the relay
  does not come back, it restores the file and restarts the relay on its old
  settings. It also runs first among the upgrade's self-repairs, each of which
  can now fail without stopping the others.

- **Automatic IPFS release pinning pinned nothing.** The pinner, the IPNS
  rebroadcast, their setup script and the desktop upgrade notice all asked for
  the release on port 8088, where nothing listens. The indexer is on 8081.
  Every run failed quietly and the timer looked healthy. They now use 8081,
  and the pinner and rebroadcast also try the indexer's Docker bridge
  addresses.

- **The release monitor could never report a release.** Its service blocked
  memory permissions Node needs to run. It looked for its tools from the
  wrong directory and went to the npm registry for them. When it did report,
  the version fields came out empty. And on a hidden-only node the check
  downloaded the whole release over Tor to learn one version number. All
  fixed: it uses the install's own tools, and a hidden-only node reads the
  version from its own indexer. UPGRADING.md also named an Ansible role for
  it that does not exist; it now gives the real steps.

- **Two old repair scripts could undo newer work.** `ops/apply-relay-fix.sh`
  and `ops/apply-federation-fix.sh` patched the indexer's code on a live
  server until a fix shipped. Both fixes shipped long ago, but the scripts
  still ship with every release. Run today, the first would replace a function
  with its old version and drop the rule that keeps a hidden-only node from
  looking up its relay's public name. Both now see that their fix is already
  installed and stop, changing nothing and restarting nothing.

Three smaller findings were looked at and deliberately left for later. They are
recorded in the audit with the reasoning:
- the chat hand-off to a clearnet peer does not use the probe's check against
  private addresses. Certificate checking stops anything being delivered to
  one, so the exposure is a connection attempt;
- an `https://` hidden-service address is dialled as plain HTTP on port 80;
- a cached key correction is dropped a few milliseconds before the database
  change that replaces it is committed.

### Found by the v1.18.0 deep audit

This release was renumbered from 1.17.16 to 1.18.0 because of how much it
changes. Before publishing it, six more reviewers went over the whole system,
not only this release's changes. Each took one area:
- the fast-chat path;
- keys, the database and the upgrade path;
- every outbound connection and the transports;
- the browser and the relay;
- installing, upgrading and the release pipeline;
- the marketplace itself, attacked as a whole.

They worked through each area threat by threat (spoofing, tampering,
repudiation, information disclosure, denial of service, elevation of
privilege), then attacked it the way a hostile peer, operator, counterparty or
RPC node would. About sixty findings came out. All are fixed except the three
named at the end of this section. Each fix has a test that was run against the
unfixed code and seen to fail first. The most serious, first:

- **A single hostile chain node could take over a new node during fast
  sync.** A new node can start from a published database snapshot instead of
  replaying the chain. It found the snapshot by asking ONE chain node for
  @morphit's history, checked no signature, and fed the downloaded file to
  the database tool, which also runs shell commands written into the file. One
  dishonest node among the twenty public ones could therefore run commands as
  root on any node being set up. Now:
  - the snapshot record must be agreed by two node operators (counted by node name);
  - it must be signed by @morphit's pinned key;
  - the file is refused if it contains any database command outside its data;
  - the restore runs as one transaction, so a failed restore leaves the
    existing database untouched;
  - any database code the snapshot adds that Morphit itself does not create
    is removed.

- **Published snapshots contained people's push subscriptions.** The relay
  shares the indexer's database, and the export copied all of it: every
  browser push subscription, which links an account to a device's push
  address, went out in a file published on IPFS. So did the relay's own
  payout queue. Snapshots now carry only what the chain can rebuild, and a
  restore wipes those tables if an older snapshot still carries them.

- **Registering a crafted address found out where Tor-only nodes are.** A node
  that uses no clearnet decided whether an address was "local" by how its
  name started. So an instance registered as `https://10.something.attacker`
  was looked up in the internet provider's DNS and connected to from the
  node's home address, every time a user sent a chat message. Only real IP
  addresses count as local now. Registration refuses names made to look like
  one, and a hidden-only node never gives a peer a clearnet address at all.

- **Tor-only nodes still used the clearnet in several places:**
  - the `morphit-ops` menu checked for new versions and the relay's balance
    over the clearnet;
  - `register` and payment-method changes were broadcast through clearnet
    chain nodes, putting the node's onion address and home IP in the same
    request;
  - the first-online helper tested clearnet nodes every five minutes;
  - the IPFS daemon joined the public IPFS network from the home address and
    announced itself as a host of Morphit releases, which anyone could list;
  - each upgrade's seeding step downloaded a file from git.agorise.net.

  All of these now go through the node's own indexer or its hidden
  transports. IPFS runs with no public network at all, sending no telemetry
  and making no DNS lookups, and it still serves releases over the node's
  onion and I2P addresses. Existing nodes are switched over by the upgrade,
  which then checks that IPFS came back.

- **"Two nodes agree" could mean one operator.** Keys and other trusted
  answers must be agreed by two chain nodes. Every privacy-network node is
  listed twice, once as an onion and once as I2P, so one operator answering
  on both counted as two. Agreement now counts operators, not addresses. The
  chat fast path's key re-check, which asked a single node, now asks for
  agreement too.

- **A local program could decide what an upgrade installs.** `morphit-ops
  upgrade` runs as root and took the release's fingerprint and download
  location from whatever answered first on the indexer's port. Any program on
  the machine that got there first chose what root would install.
  - The upgrade now reads the node's settings from its own root-owned
    configuration.
  - It asks only the indexer address configured there, and checks that the
    process answering really is the Morphit indexer service.
  - A node with a non-standard setup can set
    `MORPHIT_UPGRADE_TRUST_LOCAL_INDEXER=1` to skip only that last check.

- **A mirror could downgrade a node.** Any older signed release was accepted
  as an "upgrade". Now:
  - an upgrade must be strictly newer (use `--allow-downgrade` to go back on
    purpose);
  - the unpacked release must say it is the version that was asked for;
  - a known release fingerprint must match even when a signature checks out;
  - a signature that is present but wrong refuses the upgrade.

  The release pipeline also pins its one remaining unpinned build step to an
  exact commit, and checks the tarball, fingerprint and signature again before
  publishing.

- **The relay's per-address signup limits could be skipped with one header.**
  Each signup costs the relay about 102 BLURT. The relay believed whatever
  address a visitor wrote in a request header, so one person could look like
  a new visitor on every request. That got around every per-address limit, up
  to the daily ceiling of about 5,100 BLURT. The public firewall trusted the
  same header from anyone. The relay and the AI-agent endpoint now use only
  the address the proxy itself saw, and the proxies no longer pass the
  visitor's claim along. Existing BunkerWeb installs are corrected by the
  upgrade, which checks the running firewall afterwards.

- **Anyone could get free "verified" Bitcoin-fee listings.** When the block
  explorers reported a fee transaction as not existing, the order waited as
  "pending" instead of "unpaid". Two accounts, one of them the poster, could
  then vouch for it and make it verified, as often as they liked. Now:
  - "not found" by the explorers means unpaid;
  - the poster cannot vouch for their own order;
  - vouchers flagged as linked to the poster don't count;
  - the indexer re-checks pending and vouched-for orders with the explorers,
    whose answer always wins.

- **Someone else's Bitcoin fee payment could be claimed first.** The fee
  address is public, so a bot watching Bitcoin's pending transactions can
  claim a payment before the person who made it posts their order. Before,
  the real payer's order then silently disappeared. Now it appears, marked as
  a fee someone else already claimed. Tying each payment to the person who
  made it needs a change to how Bitcoin fees are paid, and it is being
  designed for a later release. Until then, post the order right after paying,
  or pay the fee in BLURT.

- **Privacy-only nodes could be told wrong prices.** A privacy-only node takes
  its price from the median of its peers' prices, and a peer is free to set
  up. Enough fake peers could move the median anywhere: users would be quoted
  a listing fee a hundred times too small (and lose it as "underpaid") or ten
  times too large. Now:
  - each operator counts once;
  - the result must stay within 15% of the fee price pinned on chain;
  - the page never quotes outside that range.

- **Fast chat could be jammed or misused:**
  - the send endpoint forwarded messages the chain would reject, however
    large, to every peer before the chain had seen them;
  - a quick-notification shortcut skipped the check that a message's order
    tag is real;
  - junk signatures could use up the key re-check allowance for everyone;
  - one sender could fill the replay memory and lock everyone else out for
    minutes;
  - messages that arrived while a key was being re-checked were dropped;
  - a sender-chosen time decided whether an order still counted as live.

  Each is fixed: only what a peer would accept is forwarded, one signer can
  only use its own share of the memory and the queue, and gates use the time
  a message actually arrived.

- **In the browser:**
  - a profile picture could cover the whole page with its own drawing. That
    could be a fake "payment verified" banner in the middle of a trade.
    Pictures are now shown as images, which cannot escape their frame;
  - signing out left notifications for that account arriving on that
    browser;
  - the idle lock left an open conversation readable;
  - a message that reached the chain but that indexers refused looked
    delivered forever. It now says so;
  - the chain lookup could wait forever.

- **Reputation and the directory:**
  - completed trades counted even when no listing fee was paid;
  - the free first-purchase listing could be cited in a review and trigger
    the relay's welcome bonus;
  - whoever registered a web address first owned it in the directory, so a
    squatter could get the real operator marked as an impostor. Ownership now
    follows the account the address itself names;
  - look-alike operator tags such as `m0rphit` or `morphit-io` were accepted.
    The network, the `morphit-ops register` command and the registration page
    now refuse them.

- **Operator tools:**
  - the snapshot check always reported a false "quarantined";
  - a restore under a different database user failed after dropping the
    database;
  - chain nodes could redirect the indexer and relay, and send replies of any
    size;
  - the relay fix for Tor-only nodes could undo itself on a slow Tor start;
  - a rollback did not restore the relay's settings;
  - exporting a privacy key could write into a file another user had
    prepared;
  - release-mirror file names were not checked;
  - the I2P proxy closing mid-handshake could jam I2P delivery until a
    restart;
  - the zero-clearnet claim ignored the Matrix alert bot;
  - the AI-agent order search always came back empty;
  - the release monitor's failure hint pointed at the wrong place on
    privacy-only nodes.

**Left for a later release, on purpose:**
- tying Bitcoin fee payments to the payer (above);
- a fee or rate limit on operator registrations;
- a reputation requirement for price-reporting peers.

The first upgrade to 1.18.0 is still run by the previous version's upgrade
program, so a few of these protections take effect from the next upgrade on.
OPERATIONS.md §25b lists which.

### Found by the release's first CI run

- **A snapshot export could leave out rows and still report success.** The
  export writes one table in two steps: the database dump, then that table's
  shared rows added by a second tool. If the second tool failed, its failure was
  swallowed and the snapshot was published without those rows. Every step now
  has to succeed, or the export stops and says so. A new test runs the export
  with each database tool broken in turn and expects it to refuse.
- **"Your psql is too old" was the answer to three different problems.**
  Restoring a snapshot needs a recent `psql` (August 2025 or later). When psql
  was not installed at all, or could not reach the database, the restore still
  said it was too old. It now says which of the three it is, so the fix it
  suggests is the right one. It still changes nothing in all three cases, and it
  never prints the database address (which can hold the password).
- **The test machine itself had an old psql.** Its restore tests died at that
  check before they read the snapshot. Some of them looked like passes, because
  "refused, and nothing changed" is also what those tests expect from a hostile
  snapshot. The test machine now installs the current PostgreSQL 16 client tools
  from PostgreSQL's own package repository. Their signing key is checked
  against its published fingerprint before anything is installed. Before any
  test runs, the machine also proves that psql accepts the safety mode the
  restore relies on. A check on the test setup keeps all of that in place, and a
  new test fails outright on any machine whose psql lacks it.

### Also fixed

- **Starting a chat now works on a privacy-only instance.** Opening a
  conversation with someone for the first time checks their chat key against the
  blockchain before trusting anything your instance says about it. Your browser
  gave that check fifteen seconds. Your instance is allowed a full minute for the
  same lookup, because reaching the chain over Tor or I2P means building a
  circuit or a tunnel first — so the browser kept giving up while the server it
  was waiting on was still perfectly on schedule. Worse, "no answer yet" was
  treated as "the blockchain says this person has no key", which is what Morphit
  reports when a key looks tampered with. So a slow connection told you your own
  instance might be fabricating data, and advised you to go and use a different
  one — the least useful advice possible if you are using a privacy-only instance
  because the others are blocked where you are. The wait now allows for the
  slower route, and a connection that does not complete is reported as exactly
  that: try again in a moment.

- **The rest of the site works there too.** That timeout was not the only one
  sized for an ordinary connection. The chain lookup every message send waits
  on, the account-name check, the profile fetch behind display names and
  avatars, the fee figures, account creation, the release check and the version
  poll were all capped at between five and thirty seconds — often less than a
  fresh Tor or I2P connection spends simply getting established. Each then
  reported the same underlying timeout as its own unrelated problem: a key that
  couldn't be verified, an instance that looked unreachable, avatars replaced by
  patterns, fees quietly falling back to defaults. Rather than adjust them one
  at a time, requests that cross a privacy network are now given the time that
  route needs, everywhere, automatically. Ordinary instances are unchanged and
  no slower.

- **A stalled connection now fails instead of hanging forever.** Timeouts
  covered only the moment of connecting — once a reply began arriving, the rest
  of it had no time limit at all. A connection that died halfway through, which
  is an everyday occurrence on Tor and I2P, left the page waiting with no error
  and nothing to retry: a spinner that never stopped, or a message stuck as
  sending. The limit now covers the whole exchange.

- **Comparing two instances no longer invents differences.** The comparison page
  fetches each instance's orders and shows what one has and the other does not,
  so you can tell whether orders are being hidden from you. But each instance
  returns at most a hundred orders, newest first — and a busy instance's hundred
  therefore reaches less far back in time. A few genuinely new orders at the top
  push an equal number off the bottom, and those pushed-out orders, sitting on
  both instances quite happily, were listed as missing from one of them. They
  always looked old, because the bottom of the list is where old orders are. The
  comparison is now limited to the range both instances could fully report on,
  matched the same way the orders themselves are ordered so that nothing inside
  that range is skipped, says plainly when it had to narrow the range, and
  states its conclusion outright instead of leaving you to read three numbers.
  Orders genuinely missing from one instance are still reported — including one
  sitting right at the edge of the range, which is where a hidden order would be
  easiest to miss.

- **The Settings page no longer loads blurred.** The language filter opened its
  menu whenever the field received focus, and an open menu dims and blurs the
  page behind it. Firefox restores focus to wherever it was when you reload — so
  once you had used that field in a tab, every later visit re-opened the menu and
  blurred the page before you had touched anything. Clicking anywhere cleared it,
  which made it look like a rendering fault rather than a real one. Menus now
  open when you press, type, or use the arrow keys, and never on focus alone. Two
  other filters had the same fault and are fixed with it.

- **Privacy-network nodes are no longer offered to browsers that cannot use
  them.** A secure page is not permitted to fetch anything over plain HTTP, and
  the Tor addresses Morphit tried first are plain HTTP — so on a normal instance
  every visitor's browser started by making two requests it was always going to
  refuse, and logged an error for each. They are no longer offered where they
  cannot work. Visitors on Tor are still pointed at the instance's own `.onion`
  address, where the privacy path applies properly and no ordinary connection is
  made at all.

## Notes

- No protocol/consensus change. Everything here is operator-facing or in the
  browser; nothing about what Morphit publishes to the chain has changed. The
  direct instance-to-instance chat delivery is an addition alongside the chain,
  not a replacement for it.
- **One thing to configure — and `morphit-ops doctor` now checks it for you.**
  `/v1/federation` carries a batch of chat messages from a peer and needs a
  larger body limit than the read default: `MORPHIT_INDEXER_MAX_FEDERATION_BODY_BYTES`
  (256 KB, documented in `ops/env/indexer.env.example`) **and a matching
  `client_max_body_size` on that location in your reverse proxy**, or the proxy
  rejects the batch before the indexer ever sees it.

  This matters most **if you are upgrading**, because your existing proxy config
  is by definition the old one. The shipped configs in `ops/nginx/` have the new
  block; a config you copied and edited months ago does not. And the failure is
  invisible in every way that matters — nothing errors, single messages keep
  working, and chat only goes slow when your instance is BUSY, which is when you
  are least likely to be reading logs.

  So `morphit-ops doctor` now sends an 8 KB batch-shaped body to your own public
  origin — above the 4 KB read default, far below the federation cap — and tells
  you whether it got through. The body is deliberately not a real transaction, so
  nothing is delivered and nothing is stored; the indexer refusing it on its
  contents is the PASS, because that proves the bytes arrived. It goes through the public origin
  deliberately: probing localhost would skip the proxy and report all-clear on
  exactly the box that has the problem. On a privacy-only instance whose own
  address the host cannot resolve, it says it could not check and gives you the
  command to run by hand, rather than guessing.
- **Database migrations v60 and v61** run by themselves on upgrade:
  - v60 only corrects the description stored on one column
    (`push_pending.source_trx_id`), which said something untrue;
  - v61 adds one column with a default (`accounts.posting_key_reconciled`).

  No existing data is rewritten and no table is rebuilt.
- **After upgrading, the indexer confirms every stored posting key against the
  blockchain once, in the background.** It reads 100 accounts per request.
  When it finishes, the startup log shows `posting_key_backfill_done` with a
  `reconciled` count. Until then, chat from an account whose key hasn't been
  confirmed yet may take the slower blockchain route.
- **The relay has three new settings, all with working defaults:**
  `MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS` (the public Tor and I2P blockchain nodes,
  the same list the indexer uses), `MORPHIT_RELAY_TOR_SOCKS` (`127.0.0.1:9050`)
  and `MORPHIT_RELAY_I2P_HTTP_PROXY` (`127.0.0.1:4444`). Documented in
  `ops/env/relay.env.example`.
  - **If your indexer already uses no clearnet, `morphit-ops upgrade` fixes the
    relay for you.** If your relay had no endpoint list of its own (which is
    what every Tor-only install had), the upgrade gives it none on clearnet.
    It also gives it the indexer's hidden endpoints and proxies, and says so.
    It writes a marked block at the end of `/etc/morphit/relay.env` (or
    `/opt/morphit/morphit.env` if there is no `relay.env`), which you can
    remove to undo it.
  - **If you set the relay's list yourself, the upgrade leaves it alone.** It
    warns you instead and names the line to change: `MORPHIT_RELAY_BLURT_RPC=`
    (empty).
  - **A hidden-only relay sends no push notifications,** because every push
    service is a clearnet server. It logs `push_disabled_hidden_only` at startup
    so that is never a surprise. Subscriptions your users took earlier are kept,
    in case push comes back. Meanwhile their queued pushes are expired and
    cleared on the usual schedule (`push_queue_janitor` in the relay log).
  - The relay now reports `hidden_only` on its `/v1/health`. The instance's
    "Zero use of clearnet internet" claim requires that to be true. If the relay
    has never answered, the claim is not made. If it answered and then went
    down, the last answer stands, because it describes configuration.
  - `morphit-ops edit` → RPC now updates the relay's list along with the
    indexer's. It used to change only the indexer's.
- **A hidden-only indexer now always runs the peer price checker,** whatever
  its setting says. Without it, a hidden-only instance has no federated prices.
- **Whether your own Tor, I2P and Lokinet are up** is in the local health output
  under `fastpath` → `federationDiagnostics` → `localTransports`. `null` means
  you do not run that one. `false` means it did not answer, and that network
  shows in `networksDown`.
- **For anyone working on the code:** `npm run lint` at the top of the
  repository is now a real check, and it runs with the tests. It fails on any
  new or changed file that is not formatted. Files that were unformatted before
  are listed in `scripts/prettier-ratchet-baseline.txt`; that list only ever
  shrinks. Running prettier anywhere in the repository now uses the project's
  own style. Before, it used prettier's defaults outside `apps/`.
- Nothing else to configure for fast chat. Instances discover each other through
  the directory they already share, and use whatever Tor or I2P proxy the
  instance is already configured with. An instance running an older version simply does not
  receive hand-offs, and its users fall back to chain delivery as before.
- To see whether it is working on your own node:
  `curl -s localhost:3000/v1/health -H 'X-Morphit-Local-Health: 1'` and look
  under `fastpath` → `federation` for how many peers are known, how many routes
  are warm, how many hand-offs have been delivered or failed, and how many
  travelled together; and under `fastpath` → `federationIntake` for what is
  waiting to be checked and whether anything is being dropped.
- Notifications to a phone or a closed browser were already checked and are
  unaffected: that queue is drained every two seconds, well inside the target.
- A message is no longer delivered twice. It could previously arrive once from
  the fast path and again when the instance read that block from the chain a few
  seconds later. Nobody saw double, because the app already collapsed the pair —
  but it was wasted work and double the traffic on the connections where that
  costs most. Failures are
  logged with the reason, not just a count.
- Both users having a fast VPN does not change the arithmetic above, and it is
  worth knowing why: an instance with no clearnet address has no clearnet address
  for anybody. Their browsers still reach it over Tor or I2P. A good connection
  makes those circuits healthier and faster — it does not skip them — so the
  three privacy hops a message crosses are the thing to measure, which is what
  the probe script does.
- Nothing needs reconfiguring. The longer waits apply automatically, and only to
  requests that actually travel over Tor or I2P.
- If you saw a red "chat key looks tampered with" warning on a `.onion` or `.i2p`
  instance, it was almost certainly this bug rather than a real tamper signal.
  That warning now means what it says.

- **This release was reviewed by fifteen independent passes** before it shipped —
  none of which had seen the code being written — and a good deal of what is
  under "Fixed" came out of them, including two defects in this release's own
  tests. The full record, including what those reviews checked and found sound,
  is in an internal audit record. The design decisions are in
  `docs/adr/0052-federated-fast-chat-delivery.md`.

- **The fixes were reviewed too.** The first review's remediation added a lot of
  new code, and nobody but its author had seen it — which is the same condition
  that produced the first round. So it got the same treatment, and that second
  pass found two more serious bugs, both introduced BY the fixes: a self-exclusion
  that would have cut the canonical instance out of every community instance's
  peer list, and an anti-spam cap keyed on the victim rather than the sender, so
  one hostile account could have denied a real buyer's first contact. Both are in
  an internal audit record under "Round two", along with one
  fix that was made and then deliberately reverted.

- **The safety rule this whole feature rests on is now checked against a real
  database, not by reading the code.** A chat message pushed between instances
  is *shown* to you, never *stored* — the blockchain remains the only record of
  what was said. That is what makes it acceptable to display a message before
  the chain has confirmed it: the worst a forged push can do is show something
  that quietly fails to appear a minute later.

  Until now that rule was verified by scanning the source for anything that
  writes. Useful, but not the same thing: it proves no write was *typed in those
  files*, where the rule says nothing anywhere should change. Those came apart
  once already during this release, when a fix corrected a stale key and saved
  it — spotted by reading, not by a test.

  There is now a test that photographs every table, pushes a real message
  through the real code against a real database, and checks that the message
  arrived **and** that not one row anywhere is different. It does the same for a
  forged push, because a stranger who cannot prove who they are should not be
  able to cause the smallest write. Both were confirmed to catch a deliberately
  planted one.

- **Review notifications are now held to the same rule, and were not being
  checked at all.** A review notifies you twice by design for exactly the same
  reason a chat message does — once when your instance sees it, once when the
  chain makes it final — and the same mechanism collapses the pair. That
  mechanism had never been run against a database. It works, and now there is a
  test saying so, including the interleaving that broke the chat version in
  v1.5.5.

  The reason it went unchecked is worth saying plainly: the test written for the
  chat half carried a note claiming review notifications were single-path and
  needed no such protection. That was simply wrong, and a wrong note beside a
  passing test is what stops the next person looking.

- **And so is the one-message-one-notification rule**, which has been broken in
  production before. In v1.5.5 a notification was deleted the moment it was
  sent, so when the slower of the two paths arrived a minute later there was
  nothing left for it to collide with and your phone buzzed twice. The fix was
  never to the uniqueness rule — that was always right — but to how long the
  record survives, and that is a property no amount of reading the code can
  check. It is now driven against a real database, including the exact
  interleaving that broke it: notify, deliver, then notify again.

  The first version of that test passed against the old bug, which is worth
  saying out loud. It counted rows, and the count is *one* either way — one
  surviving record when it works, one freshly-created record when it does not.
  It now counts what is still waiting to be delivered, which is what the phone
  actually reacts to, and replaying the v1.5.5 behaviour fails it.

- **Validation.** All 15 workspaces typecheck clean, and svelte-check reports
  861 files with no errors and no warnings. **2,700 unit tests** pass, plus
  **237 integration tests against a real PostgreSQL**. That suite was once
  recorded as runnable only on release hardware; it turns out to run here. The
  smoke battery (704 runners, 22,011 scenarios) was run three times
  end to end with identical results. It now includes a lint and formatting gate
  that actually runs.

  All 18 harnesses pass, 358 checks between them. Eight are MUTATION
  harnesses, and the number worth quoting is theirs: **216 deliberate bugs
  introduced into the source, 216 caught.** Two of the execution harnesses also
  plant bugs of their own (8 more, all caught), so the total is 224. The
  seventeenth harness is the first to need a real database, because what it
  guards is SQL and a migration. The eighteenth, added in the final review,
  runs the latency probe against stub proxies and a stub peer.

  (At the cut these figures were 2,466 unit and 159 integration tests, 17
  harnesses, 325 checks and 197 mutations. The two reviews that followed added
  the rest. The mutation count stayed at 216 through the deep audit: its fixes
  moved 18 mutations' targets, and each was re-aimed at where its property now
  lives and seen caught again, rather than dropped.)

  Two earlier drafts of this note got that number wrong, and both corrections
  are left visible rather than tidied away, because a number nobody can
  reproduce is worse than no number. The first said "167 deliberate bugs" —
  that was the total check count, which includes the nine execution harnesses
  that verify behaviour without mutating anything. The second said 102, which
  was not the count of anything: the harnesses held 96 mutations at that point.
  The figure above was taken by running all eighteen and counting the
  mutations each one reported, not by searching the harness sources. Counting
  the sources has been wrong every time it was tried.

  Every mutation added in this release was watched to fail against correct code
  first, because a test never seen to fail is not a test — and five of them
  SURVIVED on their first attempt, which is exactly what they are for. Two were
  real gaps in the second round's tests. Two more were gaps in the smoke that
  covered the transport work, where unit tests had the property and the smoke
  did not — and a unit test elsewhere is not an answer, because a harness's job
  is to prove the SMOKE is a test. The fifth was the new transport harness
  reporting five mutations as unguarded when in truth they had never been
  applied; that one is written up in the audit, because a mutation harness that
  can be wrong about whether its mutations reached the code is a harness whose
  green means nothing.

  The last rounds added two more of each kind:
  - **A survivor.** Flipping the new migration's default passed every test,
    because the test database is built from the full schema and the migration
    never ran there. An upgrading node gets the column only from the migration,
    so a case now runs the real migration on a database taken back to before
    it, and the flipped default is caught.
  - **A mutation that became equivalent.** The I2P import mutant stopped
    meaning anything once export learned to repair keys stored the old way. The
    exported bytes were right either way, so that check now keys on the repair
    notice instead.
