# F-08: server-side detection of a dead room socket

## What F-08 is

The Durable Object derives player presence entirely from `ctx.getWebSockets()` - the
set of currently-accepted WebSockets - and never persists it. That is correct as far
as it goes, but it assumes the accepted-WebSockets list is an accurate reflection of
who is actually still connected. It is not, in one specific case: when a client's TCP
connection dies without a close frame - a killed browser tab, a laptop that sleeps, a
network path that blackholes - the Durable Object is never told. The socket stays in
`ctx.getWebSockets()` forever.

User-visible symptom: the opponent's UI shows that player as "Connected" indefinitely,
`START_ROOM` and non-final `ADVANCE_ROUND` stay gated on a player who will never come
back, and the seat is never freed by the per-seat eviction logic in `acceptRoomSocket`
(that logic only fires when the *same seat* opens a *new* socket, which a truly dead
client will never do).

The client already has a heartbeat watchdog (`room-socket-supervisor.ts`) that declares
its own socket dead after missed pongs. That does not help here: a `send()` on a dead
TCP connection queues instead of throwing, so the client-side watchdog only catches a
socket that is dead *from the client's own vantage point* (e.g. the server closed it),
not a connection that is dead in the middle where neither endpoint's local API surfaces
an error. The server has to notice this independently.

## Mechanism chosen, and what was rejected

The Durable Object registers a hibernation auto-response pair (`"tt-ping"` ->
`"tt-pong"`) so the client's own ping is answered at the edge without waking the
object - that is what keeps idle sockets cheap. The consequence is that the object
never observes a client's ping directly, so it cannot use "did a message arrive
recently" as its liveness signal without giving up that cost saving.

Cloudflare exposes `ctx.getWebSocketAutoResponseTimestamp(ws)`, which returns the time
of the last auto-response sent for a given socket, without requiring the object to
wake for each one. This is the mechanism used: a periodic sweep (see below) compares
that timestamp (or, for a socket that has not yet had its first ping answered, its
acceptance time) against a threshold, and closes anything too old.

Rejected: **handling "tt-ping" manually inside `webSocketMessage`** instead of via the
auto-response pair. This would give the object a genuine per-ping wake to reason about,
but it defeats the entire point of registering the auto-response pair in the first
place - every client ping (every 20 seconds, for the lifetime of a connected socket)
would wake and bill the Durable Object, which is exactly what the auto-response pair
exists to avoid. The task explicitly asked to design around
`getWebSocketAutoResponseTimestamp` rather than defeat hibernation, and that is also
the technically better trade: the sweep needs to run only roughly once per threshold
window while a socket is connected, not once per ping.

Rejected: **a fixed polling interval independent of the alarm's other consumers**, e.g.
`ctx.storage.setAlarm` on a separate cadence. Durable Objects have exactly one alarm
slot; a second, independently-managed schedule is not available, and simulating one
(a setInterval-style loop re-arming itself) would either race the existing TTL/pending-
effect scheduling or require its own bespoke persisted state, in a codebase that
already has one one alarm multiplexer built for exactly this problem. Folding into it
was the direct extension of an existing pattern (see the alarm-slot analysis below),
not a new subsystem.

## The alarm-slot analysis

Before this change, `scheduleNextAlarm` computed `Math.min(ttlDeadline,
pendingEffect?.notBeforeMs)` - two concerns, one stored `PendingRoomEffect` marker.
The natural-looking extension would have been to give `PendingRoomEffect` a third
`kind` ("liveness-sweep") the way its own docstring invited for a future turn-timer
feature. That does not work here, and recognizing why shaped the whole design:
`PendingRoomEffect` is a single persisted marker - the code assumes at most one
non-TTL deadline is outstanding at a time. A liveness deadline is not mutually
exclusive with a pending settlement effect: a room can legitimately have a stuck
settlement retry *and* a connected-but-going-stale socket at the same time, and the
alarm has to be able to fire for either, independently, without one silently
overwriting the other's marker.

The design implemented instead does not persist a liveness deadline at all. Any
currently-connected socket's next staleness deadline is fully computable on demand
from live state: `ctx.getWebSockets()` plus
`ctx.getWebSocketAutoResponseTimestamp(ws)` (or the socket's attachment-carried
`acceptedAtMs` before its first ping has been answered). `scheduleNextAlarm` now
computes the minimum of up to three values - room TTL, the pending effect's
`notBeforeMs` (if any), and this freshly-recomputed liveness deadline (if any socket
is connected) - and arms the one alarm slot for whichever is soonest. Nothing new is
written to storage; the only alarm-related storage key is the same one that existed
before this change.

Two call sites had to change to keep this correct:

- **`scheduleNextAlarm` itself** (now a method, so it can read `ctx.getWebSockets()`)
  folds in the third term. `persistRoomEnvelope` is unchanged in shape - it still just
  delegates to `scheduleNextAlarm` - so every existing write path that already went
  through it automatically picks up the liveness term for free.
- **`acceptRoomSocket`** now calls `rearmAlarmForLiveSockets` immediately after
  accepting a new socket. This is the one genuinely new write path. Without it, a room
  that sits open with a live socket but no further command traffic (a lobby waiting on
  a second player, say) would keep whatever far-future TTL-only deadline was already
  armed, and the newly-connected socket would never be checked for staleness until the
  room itself expired - the alarm would be armed correctly *in principle* but never
  actually re-armed to reflect the new socket, because nothing else was scheduled to
  touch it.

`alarm()` itself now does two things on every wake: it unconditionally runs
`sweepStaleSockets` (cheap - a scan of this room's sockets plus timestamp
comparisons, no storage I/O), and then falls through, unmodified, into the existing
TTL/pending-effect transaction. The two are independent by construction: the sweep
never returns early out of `alarm()`, and the transaction's own due-effect logic does
not know or care whether a sweep just ran. A single alarm tick can therefore both
close a stale socket and resolve a due settlement effect, and neither one can silently
suppress the other - proven directly in the mutation table below (the "sweep does not
swallow the transaction" row simulates exactly the bug of returning early out of
`alarm()` after the sweep).

What is most likely to be subtly wrong, in order of how much I'd want a reviewer to
re-derive from first principles: (1) that `nextLivenessSweepDeadline` is recomputed
from scratch on every `scheduleNextAlarm` call rather than cached anywhere, which is
what makes the whole scheme self-correcting without needing to persist or invalidate
anything; (2) that closing a socket in `sweepStaleSockets` does not itself touch
presence or room storage - it relies on `webSocketClose` firing for *any* closed
socket, sweep-initiated or not, to do the actual rebroadcast, exactly the same path a
normal client-driven disconnect already takes.

## How an idle room settles back to quiescence

Two distinct meanings of "idle" matter here, and the design treats them differently on
purpose:

- **A vacant room (no connected sockets).** `nextLivenessSweepDeadline` returns `null`
  when `ctx.getWebSockets()` is empty, so `scheduleNextAlarm` falls back to exactly
  the TTL/pending-effect computation that existed before this change. Once the last
  socket disconnects, nothing eagerly re-arms the alarm early - the next time `alarm()`
  actually fires (at whatever liveness deadline was last armed while a socket was still
  connected, at most `ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS` in the future), the
  sweep finds nothing to close, and `scheduleNextAlarm` recomputes with no liveness
  term at all. From that point the Durable Object does not wake again until the TTL or
  a pending effect is actually due - i.e. it hibernates normally. This is a bounded,
  one-time extra wake, not a standing cost.
- **An occupied-but-otherwise-idle room (a socket is connected, nobody is doing
  anything).** This case *does* keep the Durable Object waking roughly once per
  threshold window for as long as the socket stays connected. That is not a bug to
  eliminate - it is the mechanism: there is no way to notice a connection has gone
  silent without periodically checking, and the entire point of F-08 is to catch a
  connection that looks exactly like this case from the outside. The cost is bounded
  (one cheap wake roughly every 60 seconds per room with a live socket, not per
  player-action) and stops the moment nobody is connected.

## The threshold

`ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS = DEFAULT_ROOM_SOCKET_HEARTBEAT.intervalMs * 3`,
computed from the client's existing heartbeat config
(`room-socket-supervisor.ts`), not an independently chosen number:

- The client pings every `intervalMs` = 20,000 ms while its socket is healthy, and the
  edge auto-responder answers each one, refreshing
  `getWebSocketAutoResponseTimestamp` without waking the Durable Object. Under normal
  operation the gap between two consecutive auto-responses for a live socket is
  therefore close to 20 seconds.
- The client's own watchdog tolerates two consecutive missed pongs
  (`missedPongThreshold = 2`) before declaring its own socket dead and reconnecting.
  The server threshold needs to tolerate at least that much jitter without evicting a
  socket the client itself still considers healthy - two missed cycles is 2 x 20,000 =
  40,000 ms.
- Multiplying by 3 instead of 2 gives one full extra cycle of margin (60,000 ms total)
  over the client's own two-miss tolerance, so the server sweep is strictly more
  patient than the client's own watchdog. A backgrounded tab that throttles timers, a
  transient edge hiccup, or ordinary network jitter that delays but does not kill a
  ping cycle is covered; a socket that has produced no signal at all for a full third
  cycle, on a connection that should be auto-responding without any application-level
  involvement, is not something a live TCP connection with hibernation auto-response
  enabled should ever legitimately do.
- For a socket that has not yet had its first ping answered (`getWebSocketAutoResponseTimestamp`
  returns `null` until then), the same threshold is measured from the socket's
  acceptance time instead, carried in the WebSocket's serialized attachment
  (`acceptedAtMs`). This is transport-layer bookkeeping alongside the attachment's
  existing `roomId`/`role`/`tokenHash` fields, not presence data, and is not part of
  the persisted room envelope. `acceptedAtMs` is optional on the attachment type and in
  `parseRoomSocketAttachment` - see "Deploy compatibility" below for why, and for the
  third fallback (a memoized first-observed time, written back onto the attachment via
  `serializeAttachment` the first time it's needed) that applies when a socket has
  neither signal.

Close code: `4001` (`ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE`), distinct from both the
terminal codes (`1000`, `1008`) the client's reconnect supervisor treats as
non-retryable, and from the client's own `HEARTBEAT_TIMEOUT_CLOSE_CODE` (`4000`), so a
close code alone identifies which side decided the connection was dead. Numerically it
lands on the same side of `isRetryableRoomSocketCloseCode` as every other non-1000/1008
code: the client reconnects with normal backoff.

## Deploy compatibility: a socket without `acceptedAtMs` must not be evicted

An earlier version of this change made `acceptedAtMs` a required field of
`RoomSocketAttachment`, enforced by `!isFiniteNonNegativeNumber(value.acceptedAtMs)` in
`parseRoomSocketAttachment`. A socket accepted by pre-deploy code - already connected
and hibernating at the moment this change ships - has an attachment with
`roomId`/`role`/`tokenHash` but no `acceptedAtMs`. Because hibernation does not re-run
`acceptRoomSocket`, that attachment is what `parseRoomSocketAttachment` keeps parsing
for the rest of that socket's life. Making the field required meant this function
returned `null` for such a socket everywhere it is called - including
`socketCanReceiveRoomSnapshot`, which `broadcastRoomSnapshot` uses to decide whether to
keep or force-close each socket on every snapshot broadcast (not just liveness-sweep
ticks). A `null` attachment made that check return `false`, and `broadcastRoomSnapshot`
responded by calling `closeSocketQuietly(socket, "Room seat changed.")` - close code
`1008`, which the client's own `isRetryableRoomSocketCloseCode` treats as terminal, on
par with an actual kick.

A review reproduced this directly: opened host and guest sockets, stripped
`acceptedAtMs` from the guest's live attachment via `runInDurableObject` +
`serializeAttachment` to simulate a pre-deploy socket, then had the host reconnect - an
ordinary, unrelated action with no bearing on the guest's own seat. The guest, who did
nothing and was never removed from the room, was closed with `{code: 1008, reason:
"Room seat changed."}`, confirmed non-retryable by the client's own supervisor logic.
On a real deploy, the first snapshot broadcast touching any room holding a pre-deploy
socket would force-close it with a code the client reads as "you were kicked," with no
retry - both players stuck in every in-progress game that had a socket open across the
deploy, until a manual reload. That is strictly worse than the F-08 bug this branch
exists to fix, and it shipped past a 55/55 green suite, clean typecheck, and clean lint
because nothing in the test suite constructed an attachment lacking `acceptedAtMs`.

The fix decouples liveness bookkeeping from attachment validity, rather than trying to
migrate the attachment shape:

- `RoomSocketAttachment.acceptedAtMs` is now optional (`acceptedAtMs?: UnixTimeMs`), and
  `parseRoomSocketAttachment` only validates it when present - a missing value no
  longer fails parsing. Every attachment-consuming path except liveness
  (`socketCanReceiveRoomSnapshot`, `currentRoomPresence`, the per-seat eviction match in
  `acceptRoomSocket`) never read this field in the first place, so none of them change
  behavior; they simply stop being collateral damage of a liveness-only concern.
- `socketLastSeenMs` becomes a three-way fallback instead of two. A socket that has
  answered at least one real ping uses `readSocketAutoResponseTimestamp(socket)`. A
  socket that hasn't but does carry `acceptedAtMs` (every socket accepted after this
  deploy) uses that, exactly as before. A socket with neither - the pre-deploy case -
  memoizes `nowMs` back onto its attachment as `acceptedAtMs` (via
  `socket.serializeAttachment({ ...attachment, acceptedAtMs: nowMs })`) the first time
  this is evaluated, and returns that value. See "Round two" below for why this is a
  write-back rather than a bare `?? nowMs` read.

This was chosen over the alternative of keeping the lenient "is this a room-socket
attachment" check for the presence/broadcast/eviction call sites and adding a second,
stricter accessor used only by liveness. That shape works too, but duplicates the
field-by-field parsing logic (`roomId`/`tokenHash`/`role` validation) across two
functions that must be kept consistent, for a difference that is really about one
field's meaning to one caller. Making `acceptedAtMs` optional in the single parser and
handling its absence at the one call site that assigns it meaning
(`socketLastSeenMs`) keeps the "is this a valid room-socket attachment" question
answered in exactly one place.

The invariant this establishes: a legacy socket is never force-closed with a terminal
code because something else in the room merely broadcast a snapshot. It survives one
full threshold window from the moment its liveness is first evaluated - not from an
assumed-ancient past - and from then on is swept exactly like any other socket, once
either a real auto-response arrives or that memoized first-observed time itself ages
out. It is functionally indistinguishable from any other connected socket from that
point on. (An earlier draft of this paragraph claimed this survives-then-ages-out
behavior "just happens" from the fallback read; it did not, until the fix described in
"Round two" below made it actually true - see that section for what was wrong and why
the wording above is now accurate rather than aspirational.)

## Round two: the `nowMs` fallback conferred permanent immunity, not decay

A second re-review rejected the deploy-compatibility fix above on a re-read of exactly
the invariant paragraph just above. As originally shipped, `socketLastSeenMs`'s third
fallback was a bare read:

```ts
return (
  this.readSocketAutoResponseTimestamp(socket)?.getTime() ??
  attachment.acceptedAtMs ??
  nowMs
);
```

`nowMs` is a parameter, recomputed by the caller (`sweepStaleSockets` or
`nextLivenessSweepDeadline`) on every invocation and never written back anywhere. For a
socket that has neither `acceptedAtMs` nor a completed auto-response - a pre-deploy
socket that was already TCP-dead before its first heartbeat ever landed - this fallback
evaluates to "now" on *every single call*, forever, so `nowMs - lastSeenMs` is always
`0` and the socket can never cross the staleness threshold. Not eventually - never. The
prior paragraph's claim that such a socket "survives until its own real staleness is
observed" was false as written: there was no path by which its own staleness would ever
be observed absent a real auto-response.

The reviewer proved this rather than inferring it: a probe called `sweepStaleSockets`
20 times with `nowMs` advancing by 10x `ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS` each
iteration (spanning roughly 3.3 simulated hours), and the socket survived every single
sweep - `readyState` stayed `OPEN`, no close event ever fired. The affected population
is narrow and self-limiting (only sockets alive within roughly one heartbeat interval of
the fix that ships `acceptedAtMs` that were already TCP-dead before their first
heartbeat completed - see "Deploy compatibility" above), and no player is ever locked
out of a seat, since the pre-existing per-seat eviction in `acceptRoomSocket` still
clears the seat the moment its owner reconnects. But until that reconnect happens, the
opponent's UI shows a wrong "connected" indicator for the life of the room, and the
object keeps re-arming a liveness alarm that can never usefully fire for that socket -
in miniature, the exact F-08 zombie-socket bug this whole branch exists to eliminate.

**The fix**: memoize the first observation. `socketLastSeenMs` now writes `nowMs` back
onto the socket's attachment as `acceptedAtMs` the first time this fallback branch is
reached, via `socket.serializeAttachment({ ...attachment, acceptedAtMs: nowMs })`,
mirroring how `acceptRoomSocket` sets the field at accept time. Every subsequent call
then takes the second branch (`attachment.acceptedAtMs !== undefined`) and reads a
fixed point in the past instead of recomputing "now," so the socket ages out normally
one threshold window after whichever moment this was first evaluated - exactly the
behavior the invariant paragraph above always claimed, now actually true. The
alternative option (leaving the immunity in place and only correcting the docs to
describe it honestly) was rejected: this is a small, local fix, and the code should be
right rather than merely documented as wrong.

The write-back spreads the full parsed `attachment` before adding `acceptedAtMs`, so it
cannot regress the first critical this branch fixed: `roomId`, `role`, and `tokenHash` -
the fields `socketCanReceiveRoomSnapshot`, `currentRoomPresence`, and the per-seat
eviction match in `acceptRoomSocket` all depend on - round-trip unchanged. It also
does not resurrect the requirement that broke legacy parsing the first time:
`parseRoomSocketAttachment` still treats `acceptedAtMs` as optional, this write only
ever *supplies* the field for a socket that lacked it, it never makes a missing value
fail to parse.

## Mutation evidence

Each mutation was applied, the named test(s) were run and confirmed failing, the
mutation was reverted, and `git diff` was confirmed clean before moving to the next
one. All mutations were applied to and reverted from `src/worker/index.ts` only.

| # | Mutation | Property | Result |
|---|---|---|---|
| 1 | `sweepStaleSockets`: flip the staleness comparison from `nowMs - lastSeenMs >= THRESHOLD` to `< THRESHOLD` (closes live sockets, spares stale ones) | (a) sweep closes stale, not live | `F-08 liveness sweep closes a socket that has gone stale, leaves a live one connected, and rebroadcasts presence for the closed one` fails: the guest socket (deliberately made stale) never closes within the test's wait window. |
| 2 | `closeStaleRoomSocket`: use `socket.close(1008, ...)` instead of `ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE` | (c) close code is retryable | Same test fails on the close-code assertion: observed `1008` instead of `4001`. |
| 3 | `scheduleNextAlarm`: gate the liveness term behind `if (false && livenessDeadline !== null)`, i.e. never fold it in | (b) liveness deadline actually reaches the alarm slot | `folds a connected socket's liveness deadline into the alarm ahead of a much later TTL, then reverts to the TTL once the socket disconnects` fails: the alarm armed right after connecting equals the (far-future) TTL deadline instead of the near liveness one. |
| 4 | `scheduleNextAlarm`: flip `Math.min(...deadlines)` to `Math.max(...deadlines)` - the exact regression this function's own docstring has warned about since before this change | (b) TTL/pending-effect not displaced by adding a third term | Two named tests fail: the pre-existing `schedules the nearer of the two deadlines while a pending effect is not yet due`, and the new `folds a connected socket's liveness deadline...` test. Catching it from both an old, liveness-unaware test and a new, liveness-aware one is direct evidence the three-term multiplexing did not change the min-selection contract. |
| 5 | `alarm()`: insert `return;` immediately after `this.sweepStaleSockets(nowMs)`, before the TTL/pending-effect transaction runs | (b) the sweep does not swallow the rest of the alarm tick | `resolves a due pending settlement effect and sweeps a stale socket in the same alarm tick, dropping neither` fails: the room stays in `settling` instead of resolving to `settlement`. |
| 6 | `acceptRoomSocket`: remove the `await this.rearmAlarmForLiveSockets(nowMs)` call after accepting the new socket | (b)/eager-rearm-on-connect | `folds a connected socket's liveness deadline...` fails identically to mutation 3: without an eager rearm, nothing schedules the new socket's liveness deadline until an unrelated room mutation happens to touch the alarm. |
| 7 | `socketLastSeenMs`: fall back to `0` instead of `attachment.acceptedAtMs` when no auto-response timestamp exists yet | acceptedAtMs fallback correctness | `folds a connected socket's liveness deadline...` fails: the resulting deadline (epoch 0 + threshold) is so far overdue that workerd fires it opportunistically before the test can read back the intended ~60-second-out value, and the test's tight bound on the armed alarm value catches the discrepancy. |
| 8 | `parseRoomSocketAttachment`: restore the required-`acceptedAtMs` check (`!isFiniteNonNegativeNumber(value.acceptedAtMs)` unconditionally, instead of only when the field is present) | deploy-compatibility: a legacy attachment must keep parsing | `does not force-close a pre-deploy socket lacking acceptedAtMs when an unrelated broadcast touches the room` fails: the guest's rebroadcast never arrives (it times out waiting for the message) because the guest was force-closed by the host's reconnect broadcast instead. This is the exact terminal-1008-on-unrelated-broadcast bug the review reproduced. |
| 9 | `socketLastSeenMs`: fall back to `0` instead of `nowMs` as the third term (`readSocketAutoResponseTimestamp(socket)?.getTime() ?? attachment.acceptedAtMs ?? 0`) | deploy-compatibility: a legacy socket with no signal at all reads as "just seen," not "stale since epoch" | `does not sweep-close a pre-deploy socket lacking acceptedAtMs before its first ping has ever been answered` fails: the sweep closes the socket immediately (`nowMs - 0` is always past the threshold) instead of leaving it open. |
| 10 | `sweepStaleSockets`: change the comparison from `nowMs - lastSeenMs >= THRESHOLD` to `> THRESHOLD` | staleness boundary is inclusive (`>=`), not exclusive (`>`) | `F-08 liveness sweep closes a socket exactly at the staleness boundary, not only strictly past it` fails: a socket whose last-seen time is pinned to exactly `nowMs - THRESHOLD` (via a direct `sweepStaleSockets(nowMs)` call, bypassing `alarm()`'s own wall-clock sampling so the gap is exact rather than padded) is never closed. The pre-existing "well past threshold" test (padded by a full second) does not catch this - it was the missing case the review flagged. |
| 11 | `socketLastSeenMs`: remove the `serializeAttachment` write-back from the third fallback branch, restoring the bare `?? nowMs` read | round two: a never-pinged legacy socket ages out instead of gaining permanent immunity | `eventually sweep-closes a pre-deploy socket lacking acceptedAtMs once its memoized first-seen time ages out, surviving many sweeps before then` fails: `sweepClosed` stays `false` through all 20 simulated sweeps spanning ~3.3 hours, reproducing exactly the immortality the second re-review proved. |
| 12 | `socketLastSeenMs`: reorder the fallback chain to check `attachment.acceptedAtMs` before the auto-response timestamp, so a memoized value permanently masks a later real ping-pong | a legacy socket must transition off the memoized fallback once it receives one real auto-response | `lets a legacy socket lacking acceptedAtMs transition off the memoized fallback once it receives one real auto-response, becoming sweepable relative to that instead` fails: the socket closes relative to the stale memoized boundary instead of surviving past it on the strength of the real, later auto-response. |
| 13 | `socketLastSeenMs`: write back only `{ kind, acceptedAtMs }` instead of spreading the full parsed `attachment`, dropping `roomId`/`role`/`tokenHash` from the memoized attachment | the write-back must not disturb the fields snapshot/presence/seat-eviction depend on - the exact coupling that caused the first critical | Three tests fail together: the broadcast-compatibility test (`guestSocketReadyState` reads `null` - the now-incomplete attachment fails `parseRoomSocketAttachment` entirely), the long-run test (the socket is silently skipped by every subsequent sweep instead of tracked, so it never closes), and the real-auto-response test (times out waiting for a close that never happens for the same reason). |

Full command output for each row is reproducible via `git stash` / targeted `sed`
edits followed by `npx vitest run --config vitest.worker.config.ts --configLoader
runner -t "<test name>"`; none of the mutations above are present in the committed
diff.

`ROOM_SOCKET_LIVENESS_STALE_THRESHOLD_MS` and `ROOM_SOCKET_LIVENESS_SWEEP_CLOSE_CODE`
are now exported from `src/worker/index.ts` and imported directly into the worker test
file, replacing a local `intervalMs * 3` / `4001` that had been independently
re-derived there. This is a single-source-of-truth fix rather than something a single
red/green mutation demonstrates cleanly: with the export in place, mutating the
threshold's formula in `src/worker/index.ts` (confirmed with `intervalMs * 3` changed
to `intervalMs * 2`, full worker-test suite re-run, then reverted) leaves every test
passing, because the test's own expectations are computed from the same constant the
production code uses rather than a hand-copied duplicate. Before this fix, that
same change could have left a stale, independently-maintained test constant silently
asserting against the wrong threshold value with no import-time signal that the two had
diverged.

## Left alone, deliberately

- **Room-expiry-driven socket teardown.** `purgeExpiredRoomState` (run when the room's
  TTL has actually elapsed) does not close any sockets still pointed at the now-purged
  room; that was true before this change and is unrelated to F-08, so it was left as
  is rather than folded into this slice.
- **Per-socket sweep granularity vs. per-room.** The sweep and its deadline computation
  operate over every socket in the room in one pass; a room with both a stale host and
  a stale guest socket closes both in the same tick, which is the correct and only
  behavior needed here, but is worth naming since it was not separately mutation-tested
  beyond the two-socket (one stale, one live) case above.

## Verification

- `npm run typecheck`: passes, no errors.
- `npm run lint`: passes, no errors or warnings.
- `npm run worker-test`: 60 passed (52 pre-existing + 3 from the original F-08 slice +
  3 added while closing the deploy-compatibility gap: the broadcast-compatibility test,
  the sweep-compatibility test, and the exact-boundary staleness test + 2 added in round
  two to close the permanent-immunity gap: the long-run eventually-closes test and the
  transitions-off-the-fallback-after-a-real-ping test - see "Deploy compatibility",
  "Round two", and the mutation table above), 0 failed.
- `npm test`: 227 passed, 0 failed (unchanged from before this change - this slice
  does not touch pure `src/lib/game` or `src/lib/room` code).

Three pre-existing worker tests asserted an exact `storedRoomAlarm` value while a room
socket they had opened (only to satisfy an unrelated presence gate earlier in the same
test) was still connected. Once the alarm legitimately started reflecting connected
sockets, those three needed to explicitly close and wait for that socket to be
recognized as offline before asserting on the alarm - this is a test-only change
(`closeSocketAndWaitOffline` helper plus moving three `.close()` calls earlier in the
test body); no test's asserted *behavior* changed, only when a no-longer-needed socket
gets closed relative to the alarm assertions that follow it.
