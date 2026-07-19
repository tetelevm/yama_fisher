# YaMa Fisher User Journey

## Why the project exists

YaMa Fisher saves Yandex Music albums and individual tracks to a computer. An
album becomes a ready-to-use directory with numbered MP3 files, correct
metadata, and a separate cover image.

The extension is intended for personal use in Firefox by someone with a Yandex
Music account. It works on the `.ru`, `.com`, `.kz`, `.by`, and `.uz` service
domains.

## Primary need

The user wants to move a selected album into a local music library so that:

- every album track is placed in one directory;
- track order, titles, and artists are preserved;
- files contain metadata and cover art from the selected album.

## User journey

### 1. Authorization

The user opens the extension popup. If they are not authorized, the extension
offers a Yandex sign-in. After signing in, the user can return to the music page
and start a download.

### 2. Album, track, or artist top selection

The user opens an album at `/album/<id>` or an individual track at
`/album/<albumId>/track/<trackId>`. Before downloading, the popup displays the
collection title, artist, and cover. A track is shown as a one-track collection:
its title replaces the album title and the same collection card starts its
download. Playlist and artist links are recognized but cannot be downloaded yet.
The extension reports that these features are not implemented. A small text
link to the project's GitHub page remains in the popup's upper-right corner.

The user can also open `/artist/<artistId>/tracks` to download the first top
tracks of an artist. The collection is named `artist - TOP N`, where `N` is the
configured top-track limit. If fewer tracks are available, the collection uses
all available tracks without changing its name.

### 3. Starting a download

The user starts an album or one track with one button. Tracks enter a queue and
begin downloading in parallel. As soon as one track finishes, the next one uses
the freed slot, so a slow file does not hold up the entire queue. Track titles
are visible as soon as the queue appears. The download button is disabled after
the first click, and a collection that is already downloading cannot be queued
again. The parallel download limit is shared by all active collections and
retried tracks.

### 4. Monitoring and control

Each track displays progress and a status:

- a gray dot means queued;
- a blue dot means downloading;
- a yellow dot means paused;
- a red dot means failed;
- a green dot means completed.

Failure is shown once in the track's status and progress area. The popup does
not add a second error line that changes the track row height.

The popup offers Pause and Resume only for individual tracks. It does not
provide global or collection-level pause controls. A paused track keeps its
current progress but releases its active download slot, allowing the next
queued track to start. Resuming that track continues it when a slot becomes
available. Failed tracks can be retried, and their failures do not prevent
later tracks from starting.

Track controls use muted action colors: Pause is dark blue-gray, Resume is
blue, and Retry is red-orange.

A square stop button appears before Downloads. It is dark gray while workers
are running and becomes light gray with a green outline while they are stopped.
Stopping workers does not put tracks into the paused state. Active workers keep
their downloaded data, release their slots at the next processing checkpoint,
and resume from the same data when the button is toggled off. No queued worker
starts while the stop is active. A downloading track held by this control keeps
its downloading status and shows a disabled Stopped control; other tracks do
not change. The stop button is disabled when no unfinished tracks remain.

The toolbar badge shows the total number of queued, downloading, and paused
tracks across all albums. Completed and failed tracks are not counted.

### 5. Receiving the result

All tracks are saved in the selected album's directory. Even if a track also
belongs to another album or compilation, its order, cover, and metadata come
from the album page where the user started the download.

An individually selected track is saved without a number or a separate album
directory: `music/artist/track title.mp3`. Its popup and history entry use the
track title as the collection title and the track artist as the collection artist.

Artist top tracks are saved in `music/artist/TOP N`. Their filenames contain
only track titles without numeric prefixes.

The extension owner sets only the common download directory in the source
configuration. Albums always use the nested `artist/year album` structure.
`artistTopTracksCount` sets the number of artist top tracks and defaults to 10.

The resulting structure looks like this:

```text
music/
- The Beatles
- - 1964 Beatles for Sale
- - - cover.jpg
- - - 01. No Reply.mp3
- - - 02. I_m a Loser.mp3
- - - ...
- - 1966 Revolver
- - - cover.jpg
- - - 01. Taxman.mp3
- - - ...
- The Rolling Stones
- - 1969 Let It Bleed
- - - cover.jpg
- - - 01. Gimme Shelter.mp3
- - - ...
```

When every track finishes successfully, a green check appears before the
collection title. Download history headings place the artist before the
collection title and wrap onto another line when needed. Artist names longer
than 33 characters are displayed as their first 30 characters followed by an
ellipsis. A completed collection can be hidden from history.

## History and returning to downloads

Recent download state remains available after the popup closes. The user can
view progress, errors, and results, retry failed tracks, or hide completed
entries. History is intended for current downloads and is retained for 24
hours. Only a fully successful collection has a Hide action, which removes the
history entry and leaves downloaded files on disk. A finished collection with
failed tracks instead has Retry. It restarts every failed track in that
collection. Failed collections do not have a Delete action. Hide all is the
only panel-level history action and appears only when every collection has its
own Hide action available.

A failed track can be retried after its original tab is closed or navigated
away. The extension reuses another suitable Yandex Music tab when possible. If
none exists, it briefly opens the album in an inactive tab and closes that tab
as soon as the track request is prepared. The Yandex Music authorization must
still be valid.

## Configuring the result

There is no settings screen. The extension owner can change settings manually
in the extension source. The extension must be reloaded after a settings
change.

## Current product boundaries

The extension currently downloads complete albums, individual tracks, and
artist top tracks. The current version does not support:

- playlists;
- artist pages other than their top-tracks view;
- settings through the user interface;
- browsers other than Firefox.
