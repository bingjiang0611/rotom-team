# Session delivery, history and transport

Detailed contract sections from [CONFIGURATION.md](CONFIGURATION.md).

## Recover an existing member's browser sign-in

The owner can open **Settings → People → Recover sign-in** beside an existing non-owner member.
Check the member name and ID (names may repeat), then send the recovery link only to that person.
Anyone holding it can sign in as that member, including using their connected personal model/MCP accounts.
This is trusted-owner account recovery, not anonymous self-service identity verification.

Recovery links expire after 15 minutes and work once, only after an explicit confirmation POST.
Replacing a displayed recovery link cancels it; closing the sheet leaves a delivered link valid until expiry.
Only a hash is persisted. Unused links and redeemed device credentials survive ordinary server restarts.
Deleting the member or rotating the owner login token invalidates pending recovery links.
Recovery creates a revocable device credential for the same member ID. It does not rename the member, reset
permissions/session scope/tunnel binding, copy credentials, or sign out existing devices. Use the member's
original access address when it has a tunnel restriction. This is not model OAuth reauthentication and does
not reconcile unknown model/tool outcomes. Device credentials are managed in the member's Profile; the
existing 32-device limit still applies. At capacity, redemption returns an error without spending the link;
revoke an old device from a signed-in member device before retrying.

Do not roll back to a version without recovery support while recovery links remain live: cancel them or
wait 15 minutes first. This feature does not diagnose or prevent browser Cookie deletion.

## Stored image previews

On macOS, the server uses the system `sips` tool to generate smaller copies of stored-message images: 480 px
thumbnails in the transcript and 1600 px previews in the full-screen viewer. **Open** still opens the unmodified
original. GIF animation and small images are preserved; unsupported platforms or resize failures use originals.
Generation does not use a model account and does not change what the model originally received.

Private cached copies, now including byte-identical originals, live under `<data>/media/`, sharing a cap of 256 MiB
and 8192 files. They can be regenerated from stored entries; Durable remains authoritative. Do not share that
directory: it contains conversation images. The existing offline backup includes these files. Fork visibility and
session permissions are checked on every request, including conditional GET/HEAD. Damaged/missing copies are rebuilt,
and cache failure falls back to the source. Images support content ETag, single byte Range and HEAD; invalid/multipart
range units or stale If-Range fall back to full responses. Unsatisfiable byte ranges return 416. Range/304 still read
and verify the entire cached file, rather than providing zero-copy disk streaming.

Large static PNG/JPEG clipboard images are bounded to 2000 px before upload, preserving aspect ratio/transparency.
Only a smaller PNG is substituted; the original is **not** separately uploaded/retained. Ordinary file selection,
small/animated/unknown images, unsupported browsers and failed/unhelpful conversions are unchanged. This does not
raise the 5 MiB per-model-image limit: a noisy PNG may still be too large to send.

Live event streams and large long-poll responses negotiate gzip when accepted. Events flush immediately; an SSE
client with more than 8 MiB of buffered data is disconnected so it can reconnect for a fresh view. A long-poll
connection likewise retains at most 8 MiB of serialized UTF-8 event data (including separators, plus a fixed response
envelope). Each event is serialized once; unacknowledged responses reuse those bytes. Overflow closes and detaches
the poller instead of returning a partial view; the next poll receives a new session and full view. An individual
initial event larger than the limit cannot be delivered through that connection. Use the supported history tail/pages
below; supporting an oversized single event requires a separately designed bounded event protocol.

## Session subscriptions

Each new web tab keeps one SSE connection or long-poll session while switching conversations, including Back/Forward
and returning home. `subscriptions=1&generation=N` opts in on the initial GET; `hello.subscriptions` confirms support.
`POST /api/subscribe` carries the authenticated connection id, a strictly newer safe-integer generation, a numeric
`conversationId` (or `null` for home), and an optional saved-view `have` claim. It uses the normal authenticated,
`X-Pocket: 1` write guard. It changes only the read subscription, not a user's send or native execution.

The server checks connection ownership, removes the previous room synchronously, and checks access both before and
after opening the new room. Older/equal generations cannot undo a newer selection. An ordered `subscription` event
acknowledges the generation and target before its full view or missing result; home needs only the ACK. Room events
(`view`, `missing`, `chat`, `notes`, `browser`, `presence`, `changes`) use `{ generation, data }` envelopes. The tab
rejects events from another generation or room, including an old A snapshot after A→B→A. Global events remain unwrapped;
normal switches do not repeat hello or reset the session-list version. Poll queues freeze the generation at enqueue,
retain their transport sequence across switches, and reject invalid/future sequence ACKs without discarding data.

Old tabs keep their original unwrapped format and reconnect behavior. A new tab also reconnects when an older server
does not negotiate support. Saved-copy reads do not paint after the member/access key changes. A lost subscription
response or six seconds without its completed view/ACK replaces only the read connection; the POST and user send are
not replayed. SSE network errors reconnect with the latest route, not the original EventSource URL. After poll expiry
or server restart, the client discards the replacement batch for the obsolete URL, closes that poller and opens a fresh
connection for the current route. This exceptional recovery can require an extra handshake; normal switches do not.

## Session-list updates

The web app opts into versioned session lists on its event stream or long-poll connection. It receives a full list
first, then only changed/removed rows; unchanged refreshes send nothing. A missed version requests a fresh full list
on the same connection. Permissions are checked when each member's list is prepared, and permission changes force a
filtered full list. Reconnects start a new version namespace. Old clients and `GET /api/sessions` retain full arrays.

The server still scans the member's visible catalogue to compare rows; server-side catalogue pagination is not
implemented. Per-connection comparison baselines are capped at 2048 rows and 2,097,152 JSON characters; larger lists
fall back to full snapshots without retaining that baseline.

## Saved session copies

The web app keeps a copy of the 10 sessions this browser opened most recently, in IndexedDB (`rotom-views`). Each
copy holds the newest transcript entries the tab holds, up to 400, the session's title information and message authors. It does not hold
live state, approvals, queued messages or rotom payer/segment state. Coming back to a session shows its copy at once,
marked "saved copy · checking for changes…", with no message box. The server's own view then replaces it.

When a tab connects, it names the run of entries it holds, and the server sends only the rest. This also applies to
ordinary reconnects without a saved copy. The claim names the server's run, so after a restart everything is sent
again. It can only reduce what that tab receives; access checks are unchanged. A tab that turns out to lack part of
the named run reconnects for the full view.

Copies belong to one person and one level of access. Signing out (Settings or an expired sign-in) clears all of them.
So does a change of the signed-in person, role or session grants. A session the server says is missing loses its copy,
and copies of sessions no longer in the person's list are dropped. Anyone using the same browser profile before
sign-out could read the copies. Where IndexedDB is unavailable, nothing is saved.

## Streaming Markdown

Live text/thinking/tool updates refresh the transcript locally when busy and all non-live data are unchanged.
Busy, permission/account, native status/dialog/widget, cost and persisted-entry changes still refresh the whole UI.
This does not filter store notifications, change subscription order or alter transport/authorization behavior.

Growing Markdown text updates are combined per browser animation frame. The first text and completed result render
without waiting for a frame; completion still uses the full parser and sanitizer, including final code folding.
A paused/background frame may delay intermediate text, never the completed result's render. Conversation or document
base-path changes invalidate immediately, and unmounting cancels pending work. No stream versions are persisted.
The transcript keeps following content height while the reader is at the bottom; scrolling up still stops following.

## Long sessions

Opening a session, the web app asks for its newest 240 entries (`tail=240` on the event connection). The view still
names every entry in order, but sends only those, plus anything new later. Scrolling up near the top, or "Show earlier
messages", reads the entries before them 200 at a time (`GET /api/c/:id/entries?before=<entry id>`); the rows on screen
stay where they are. Find in session, the Outputs list and a jump to a message the tab does not hold read the rest of
the history first; the Outputs badge reads `n+` until it is all here. Export reads the whole history on the server as
before. Each page is checked like any other read of the session, and comes from the same projection as the view, so it
is identical to what an unpaged view sends. Connections that do not ask for a tail (older tabs, other clients) get
every entry, as before. History before a compaction or a new context still loads separately, as before.

## Changes view freshness

While a tab has a session open, the server watches that session's Git repository (on macOS and Windows, where the
system watches a folder tree cheaply; elsewhere nothing is watched). A tab that may read Changes gets a small
`changes` event saying only that something moved; it then reads Changes with its own permissions, as before. An
open Changes tab therefore shows a person's or a tool's file edits within about a second, and no longer re-reads after
every entry. It still re-reads after write/edit/codemode results, when shown, after a reconnect, and every 30 s while
the tab is visible, because watches can miss events (for example on network file systems). Without watching, the old
re-read after entries remains. The server keeps each recently used session's Pi-edit list in memory (at most 32
sessions) and reads only new entries per listing; concurrent listings of one folder share a Git run that started
after they asked.

## Optional TLS and HTTP/2

The default listener is still plain HTTP/1.1 on loopback. For a private, explicitly selected HTTPS route, pass both
`--tls-cert /absolute/certificate-chain.pem` and `--tls-key /absolute/private-key.pem` to `node bin/rotom-team.js`,
alongside the usual explicit `--data`, `--cwd` and non-production test port. Use a certificate trusted by the client
and valid for the hostname; protect the key. Do **not** use the repository's self-signed test fixture for deployment.
TLS enables HTTP/2 multiplexing with HTTP/1.1 fallback on the same port. Certificate changes require a normal server
restart. The legacy tunnel launcher does not support these flags and fails explicitly rather than printing HTTP URLs.
Nothing automatically changes the running listener, binds another address or obtains a certificate.

HTTP/2 requests use the same redacted journal schema, excluding held streams/polls. Their `wireBytes` is `null`
(unavailable): streams share a connection, so a socket byte delta cannot be attributed to one request.

A remote tab falls back to polling if its initial event stream does not deliver a complete view/session list within
six seconds. While polling, it actively retries the stream after one hour without needing navigation. Hidden/offline
tabs defer an overdue retry until visible/online. The poll closes before the stream opens; another incomplete stream
starts a fresh one-hour polling period. A complete stream clears the saved fallback choice. Local loopback addresses
keep using event streams. No journal fields or collection semantics change: fallback reasons are not yet journaled.
A private trusted HTTPS/HTTP2 route can avoid HTTP/1 connection limits, but cannot force a buffering proxy to flush SSE.

New tabs negotiate live text deltas with `live=delta` on either transport. Each connection keeps one bounded live
baseline; append-only text/thinking blocks send only their suffix, while replacements, tool calls, retries and other
metadata remain snapshots. Full views/reconnects always carry complete live text. A missing/wrong patch baseline
causes read-only full resynchronization, never a send retry. Older tabs that do not negotiate still receive full text.
