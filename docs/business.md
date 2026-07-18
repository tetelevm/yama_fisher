# YaMa Fisher User Journey

## Why the project exists

YaMa Fisher saves a Yandex Music album to a computer without requiring the user
to download each track manually. The result is a ready-to-use directory with
numbered MP3 files, correct metadata, and a separate cover image.

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

### 2. Album selection

The user opens the desired album page at `/album/<id>`. Before downloading, the
popup displays the album title, artist, cover, and track list. Playlist, artist,
and individual-track links are recognized but cannot be downloaded yet. The
extension reports that these features are not implemented. The collection card
also provides the primary download action and a secondary link to the project's
GitHub page.

### 3. Starting a download

The user starts the whole album with one button. Tracks enter a queue and begin
downloading in parallel. As soon as one track finishes, the next one uses the
freed slot, so a slow file does not hold up the entire queue. Track titles are
visible as soon as the queue appears. The download button is disabled after the
first click, and an album that is already downloading cannot be queued again.
The parallel download limit is shared by all active albums and retried tracks.

### 4. Monitoring and control

Each track displays progress and a status:

- a gray dot means queued;
- a blue dot means downloading;
- a yellow dot means paused;
- a red dot means failed;
- a green dot means completed.

The user can pause all downloads, one album, or one track. A paused track keeps
its current progress but releases its active download slot, allowing the next
queued track to start. Resuming that track continues it when a slot becomes
available. Resuming one album after a global pause must not resume the other
albums. Failed tracks can be retried, and their failures do not prevent later
tracks from starting.
The toolbar badge shows the total number of queued, downloading, and paused
tracks across all albums. Completed and failed tracks are not counted.

### 5. Receiving the result

All tracks are saved in the selected album's directory. Even if a track also
belongs to another album or compilation, its order, cover, and metadata come
from the album page where the user started the download.

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

When every track finishes successfully, a green check appears before the album
title. A completed album can be hidden from history.

## History and returning to downloads

Recent download state remains available after the popup closes. The user can
view progress, errors, and results, retry failed tracks, or hide completed
entries. History is intended for current downloads and is retained for 24
hours. A fully successful collection has a subdued Hide action. A finished
collection with failed tracks instead has a prominent Delete action. Both
actions remove only the history entry and leave downloaded files on disk.

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

The extension currently downloads complete albums only. The current version
does not support:

- playlists;
- artist pages;
- individual tracks as a standalone workflow;
- settings through the user interface;
- browsers other than Firefox.
