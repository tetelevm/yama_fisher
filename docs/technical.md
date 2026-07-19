# YaMa Fisher Technical Architecture

## General model

YaMa Fisher is a buildless Firefox Manifest V3 extension. The browser loads its
JavaScript, HTML, and CSS directly. The architecture separates page data
access, download management, and the user interface.

Data flows in one direction:

```text
Yandex Music page → extension bridge → background → popup
```

The page obtains Yandex Music data, the background manages file processing and
saving, and the popup renders state and sends commands. Shared message and
status names form a common protocol between these contexts.

## Collection

A collection is the shared context from which the user starts a download.
Albums, playlists, and possible future sources are equal collection types.
Albums and individual tracks are implemented at present.

A collection has:

- a type and identifier;
- a title and additional description;
- cover art;
- type-specific metadata;
- an ordered list of tracks.

The collection is the source of contextual data. An album determines the
directory, track order, year, genre, cover, and album metadata in the resulting
files. A track collection retains its URL's album ID for metadata, but saves in
the common artist directory without an album subdirectory or track number.

## Track

A track is one queue and processing unit. It has its own identifier, title, and
artists, but it is always processed in the context of the selected collection.

Track-owned data describes the recording itself, such as its title and track
artists. The directory, number, cover, and other contextual metadata come from
the collection. Featured artists and reuse of the same recording therefore do
not change the structure of the selected album.

During a download, a track moves through queued, active, paused, successful, or
failed states. One track's failure does not stop the collection.

## Downloads and concurrency

The background stores download jobs and starts a limited number of tracks at
the same time. A free queue slot is filled as soon as any track finishes,
without waiting for the other tracks that started alongside it. The limit is
global: all active collections and manual retries share the same slots. Tracks
wait independently for a shared slot instead of remaining bound to a worker.

Collection startup is deduplicated by collection type and ID. An in-memory
reservation closes the race before a job is persisted, while active persisted
jobs prevent duplicates after the popup or background is reopened.

Track processing obtains audio and metadata, adds ID3 data and cover art,
builds a safe path, and hands the completed file to Firefox Downloads. The
album cover is also saved as a separate file. A single-track collection embeds
the cover in its MP3 but does not save a separate cover file.

Pause state exists internally at three levels: all jobs, one collection, and
one track. The popup exposes only track controls. During background recovery,
stored global and collection pauses from older versions are converted into
individual track pauses, so every paused Firefox download still has an
available Resume action. An in-memory track pipeline leases a global
concurrency slot only while it can make progress. Pausing the track releases
that lease without discarding its buffered data, so another queued track can
run. Resumed pipelines receive the next available slot before tracks that have
not started yet.

Worker stop is independent from pause state. The persisted `workersStopped`
flag prevents the scheduler from granting new leases. Active controllers stop
at the existing cooperative processing checkpoints, release their leases, and
retain already buffered audio. Their track status remains downloading and
Firefox Downloads is not paused. The transient per-track `workerStopped` flag
identifies only controllers held by this gate and is cleared when a controller
finishes or background state is reconciled. Resuming the workers lets held
controllers compete for slots with resume priority.

The toolbar badge is derived from background download state. It counts queued,
downloading, and paused tracks across every job, while completed and failed
tracks do not contribute to the displayed number.

## Metadata and files

The resulting MP3 combines two data sources:

- the track provides its title and artists;
- the selected collection provides album context, position, track count, year,
  genre, and cover art.

`downloadFolder` configures only the common download directory. Albums always
use its `artist/year album` subdirectory structure. A single track uses
`artist/track title.mp3` beneath that directory, without a number. Every dynamic
path segment is sanitized.

## Settings

Persistent settings are stored in `src/config.js` and edited manually. They
control audio quality, cover size, concurrency, the common download directory,
track numbering, and Firefox Downloads history behavior.

## Authorization and token storage

The OAuth token is stored only in the Yandex Music site's `localStorage`.
Authorized requests run in the page context. The token is not passed to the
popup, background, logs, or extension storage.

Other contexts receive only safe request results and authorization state. This
boundary limits the spread of sensitive data through the extension contexts.
Retry preserves this boundary: it runs through a suitable Yandex Music page
instead of copying the token into background state.

## State storage

The system has two independent kinds of state:

- the page temporarily stores open collection data alongside the token;
- the background stores the queue, progress, pauses, errors, and download
  history in extension-local storage.

Open collection data is removed after seven days, with cleanup running at most
once per day. Background job history is retained for 24 hours. After a restart,
the extension reconciles stored downloads with Firefox state and does not mark
lost unfinished work as successful.

New jobs retain only the safe optional `sourceOrigin` so retry can select the
same Yandex Music site. Existing jobs without this field remain compatible and
fall back to `music.yandex.ru` when no suitable open tab exists.

## Code map

Responsibilities are distributed as follows:

- `src/config.js` contains persistent settings;
- `src/protocol.js` contains shared commands, events, keys, and statuses;
- `src/collection-types.js` defines collection types, URL matching,
  normalization, and popup presentation;
- `src/page/album-parser.js` reconstructs album data from HTML;
- `src/page/album.js` obtains album data;
- `src/page/track.js` obtains individual-track data;
- `src/page/collection.js` manages the shared collection lifecycle;
- `src/page/download.js` performs authorized track-data and file requests;
- `src/background/downloads-adapter.js` isolates the Firefox Downloads API;
- `src/background/download-state.js` manages jobs, progress, pauses, worker
  stop state, the toolbar badge, and recovery;
- `src/background/page-bridge.js` manages tabs, temporary retry pages, and
  MAIN-world injection;
- `src/background/track-pipeline.js` processes one track;
- `src/background/download-scheduler.js` manages the queue, concurrency,
  worker gating, and retries;
- `src/background/background.js` routes messages;
- `popup/popup.html` contains the static popup shell, the upper-right GitHub
  text link, and template insertion points;
- `popup/collection-card.html` contains the collection card template;
- `popup/downloads.html` contains the downloads panel, collection, and track
  templates;
- `popup/popup.css` defines popup appearance;
- `src/popup/popup.js` loads and clones popup templates, fills dynamic data,
  and sends commands.

The background entry point remains a thin router. Before requesting state, the
popup loads both packaged HTML template files. It inserts the collection card
and downloads panel into the shell once, then clones collection and track
templates for download-state snapshots. Template loading does not require
network access. The GitHub link remains in the shell because it belongs to the
whole popup rather than the collection card.

Every user-facing value replaced at runtime has a representative valid example
in its HTML template; only containers that receive cloned children may be
empty. The track template owns separate Pause, Resume, and Retry controls. The
renderer keeps their labels and styles static and changes only visibility and
command binding for the current track state. Failed tracks use the existing
progress label and do not render a second error row.

The collection template owns separate Hide and Retry controls. Hide is visible
only when every track completed successfully. Retry is visible only when every
track is finished and at least one failed; there is no collection Pause,
Resume, or Delete control.

The downloads panel has only one history control, Hide all. It is visible only
when every stored collection independently qualifies for its Hide action. The
panel does not provide Pause all or Resume all controls.

The panel header also owns the square worker-stop toggle. Its pressed state
comes from `workersStopped`, and it is disabled when every stored track is in a
finished state. The track template owns a separate disabled Stopped control,
shown instead of Pause only while that downloading track has an active
controller held by the worker gate.

Download collection headings render the collection artist before its title.
The popup limits an artist longer than 33 Unicode characters to its first 30
characters plus `...`; the combined heading can wrap instead of being clipped
to one line.

## Data exchange contract

`src/protocol.js` is the only source of strings shared between contexts. A
command change requires coordinated changes to its sender, router, and
receiver. Stored-state formats retain backward compatibility or receive an
explicit migration.

`SET_WORKERS_STOPPED` changes only scheduler and controller gating. It does not
write the paused status or call the Firefox pause API.

A normalized collection has these fields:

```text
type
id
title
subtitle
coverUrl
metadata
entries
```

Each `entries` item contains:

```text
trackId
position
```

A parallel `trackIds` array is not passed between contexts. It may be derived
locally from `entries` when needed.

Initial queue titles live in `metadata.trackTitles` and are indexed by the
string form of the track ID. They are populated before processing starts.
`Track N` is used only as a fallback when no title is available.

For a `track` collection, `metadata.albumId` preserves the album context from
the track URL. It is copied to the stored job as `collectionMetadata` so retries
use the same metadata context and can reopen the original track URL.

## Loading order and dependencies

The background uses classic scripts. Their order in `manifest.json` is also
their dependency order:

```text
src/protocol.js
src/config.js
src/collection-types.js
assets/vendor/browser-id3-writer.6.0.0.mjs
src/background/downloads-adapter.js
src/background/download-state.js
src/background/page-bridge.js
src/background/track-pipeline.js
src/background/download-scheduler.js
src/background/background.js
```

The vendor filename ends in ASCII `.mjs`. A typo in this path causes failure
during ID3 writing.

`src/protocol.js` loads before every consumer in every context. During page
script injection, `src/page/download.js` loads before `src/page/album.js` and
`src/page/track.js`, which use its functions.

Classic background scripts publish services through
`globalThis.YMF_BACKGROUND`, while page scripts use
`globalThis.yaMaFisher`. Module imports are incompatible with the current
loaders unless those loaders are redesigned together.

## Download code invariants

The selected album ID is passed through to preparation of every track. For an
album collection it is the collection ID; for a single-track collection it is
stored in `metadata.albumId`. Album context is selected by comparing `album.id`
with that ID; `track.albums[0]` is not automatically considered authoritative.

If an identifier has the form `trackId:albumId`, the portion before the colon
is used for file signing. The requested collection ID remains separate and
continues to determine metadata context.

Every dynamic part of the final path passes through the existing sanitizer. A
retry does not implement a second download path; it reruns the shared
single-track pipeline.

Collection retry validates that the job is finished, snapshots all failed
tracks, and runs them through the same global slots as individual retries. The
tracks share one page context until their authorized preparation finishes, so
retrying a collection does not open one temporary tab per failed track.

Retry first prefers the original tab when it is still on the stored source
origin, then another ready tab on that origin. If neither exists, the page
bridge creates an inactive album or track tab, waits for it to load, and removes
only that extension-created tab once MAIN-world track preparation finishes or
fails.

An unfinished in-memory stage cannot resume after a background restart and is
not marked successful. Only state that can be reconciled with Firefox Downloads
is recovered.

## Firefox API and coding style

The project uses Manifest V3 and the `chrome.*` API form. WebExtension events
subscribe through `addListener` and unsubscribe through `removeListener`.
JetBrains deprecation warnings for these methods are false positives for this
API; the DOM methods `addEventListener` and `removeEventListener` are not
equivalent. The warning is suppressed with a targeted comment:

```js
// noinspection JSDeprecatedSymbols
```

For callback APIs, `chrome.runtime.lastError` is checked inside the callback
while it is available.

Project-owned JavaScript remains plain JavaScript without TypeScript or
transpilation. Project-owned JS, CSS, and HTML lines are limited to 100
characters; vendor files are exempt. Small named helpers clarify contracts and
remove duplication, while comments record non-obvious invariants.

## Main architectural limitations

The project depends on internal Yandex Music page data, so changes to its format
can break collection extraction. MP3 processing occurs in memory and consumes
more resources with higher concurrency. Paused pipelines retain their buffered
audio, so many individually paused tracks can also increase memory use.

The lack of a build step simplifies personal development and installation, but
makes script loading order part of the architecture. The project targets only
Firefox and has no dedicated automated browser environment.
