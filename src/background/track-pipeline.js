/**
 * Track preparation, tagging, and file creation.
 */
(() => {
    const background = globalThis.YMF_BACKGROUND ||= {};
    const state = background.downloadState;
    const pageBridge = background.pageBridge;
    const downloadsAdapter = background.downloadsAdapter;
    const config = globalThis.YMF_CONFIG;
    const {downloadStatus} = globalThis.YMF_PROTOCOL;

    function getArtists(track, fallback = 'Unknown artist') {
        return track.artists?.map(artist => artist.name).join(', ') || fallback;
    }

    function getAlbum(track, albumId) {
        return track.albums?.find(album => String(album.id) === String(albumId))
            || track.albums?.[0]
            || {};
    }

    function sanitize(value) {
        return String(value || 'unknown')
            .replace(/[^\p{L}\p{N}\s_-]/gu, '_')
            .replace(/\s+/g, ' ')
            .replace(/_+/g, '_')
            .trim() || 'unknown';
    }

    function createFolder(track, albumArtist, albumId) {
        const album = getAlbum(track, albumId);
        const values = {
            '%genre%': album.genre || 'Unknown',
            '%year%': album.year || 'Unknown year',
            '%artist%': albumArtist || getArtists(album, getArtists(track)),
            '%album%': album.title || 'Unknown album'
        };
        return Object.entries(values).reduce(
            (folder, [placeholder, value]) => folder.replaceAll(placeholder, sanitize(value)),
            config.downloadFolder.replace(/[/\\]+$/, '') || 'music'
        );
    }

    function createFilename(track, albumArtist, albumId) {
        const trackNumber = getAlbum(track, albumId).trackPosition?.index;
        const prefix = config.numberingTracks && trackNumber
            ? `${String(trackNumber).padStart(2, '0')}. `
            : '';
        return `${createFolder(track, albumArtist, albumId)}/${prefix}${sanitize(track.title)}.mp3`;
    }

    async function readAudioData(response, onProgress, controller) {
        const totalBytes = Number.parseInt(response.headers.get('content-length'), 10);
        const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null;
        onProgress(0, total);
        if (!response.body) {
            const data = new Uint8Array(await response.arrayBuffer());
            onProgress(data.byteLength, total || data.byteLength);
            return data;
        }

        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
            await state.waitWhilePaused(controller);
            const {done, value} = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            onProgress(received, total);
        }
        onProgress(received, total || received);
        return new Uint8Array(await new Blob(chunks).arrayBuffer());
    }

    function getTrackCoverUrl(track, albumId) {
        const coverUri = getAlbum(track, albumId).coverUri
            ?.replace(/%%/g, `${config.coverQuality}x${config.coverQuality}`);
        return coverUri ? `https://${coverUri}` : null;
    }

    function getCoverData(track, coverDataCache, albumId) {
        const coverUrl = getTrackCoverUrl(track, albumId);
        if (!coverUrl) return Promise.resolve(null);
        if (!coverDataCache.has(coverUrl)) {
            const coverDataPromise = fetch(coverUrl)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`Could not download cover: ${response.status}`);
                    }
                    return response.arrayBuffer();
                })
                .then(buffer => new Uint8Array(buffer))
                .catch(error => {
                    coverDataCache.delete(coverUrl);
                    throw error;
                });
            coverDataCache.set(coverUrl, coverDataPromise);
        }
        return coverDataCache.get(coverUrl);
    }

    async function createTaggedAudio(data, onProgress, controller, coverDataCache, albumId) {
        await state.waitWhilePaused(controller);
        const audioResponse = await fetch(data.download);
        if (!audioResponse.ok) throw new Error(`Could not download audio: ${audioResponse.status}`);
        const audioData = await readAudioData(audioResponse, onProgress, controller);

        const track = data.trackinfo;
        const album = getAlbum(track, albumId);
        await state.waitWhilePaused(controller);
        const coverData = await getCoverData(track, coverDataCache, albumId);

        await state.waitWhilePaused(controller);
        const writer = new ID3Writer(audioData);
        writer.setFrame('TIT2', track.title)
            .setFrame('TPE1', [getArtists(track, '')])
            .setFrame('TALB', album.title || '')
            .setFrame('TYER', String(album.year || ''))
            .setFrame('TCON', album.genre?.split(',') || ['Unknown'])
            .setFrame('TRCK', `${album.trackPosition?.index || 1}/${album.trackCount || 1}`);
        if (coverData) {
            writer.setFrame('APIC', {type: 3, data: coverData, description: 'Cover (front)'});
        }
        writer.addTag();
        return URL.createObjectURL(new Blob([writer.arrayBuffer], {type: 'audio/mpeg'}));
    }

    async function downloadCollectionCover(track, albumArtist, albumId) {
        const coverUrl = getTrackCoverUrl(track, albumId);
        if (!coverUrl) {
            console.warn('[YaMa Fisher background] Collection has no cover to save separately');
            return;
        }
        const folder = createFolder(track, albumArtist, albumId);
        await downloadsAdapter.downloadFile(coverUrl, `${folder}/cover.jpg`);
    }

    async function downloadTrack(jobId, tabId, trackId, coverDataCache, onTrackPrepared) {
        let waitingNotice;
        await state.waitUntilDownloadsResumed();
        await state.waitWhileJobPaused(jobId);
        const {job, track, controller} = state.createTrackController(jobId, trackId);
        if (!job || !track || !controller) {
            throw new Error('Download is no longer stored in extension history');
        }
        try {
            state.updateTrackState(jobId, trackId, {
                status: state.getProcessingStatus(job, track, controller),
                error: null
            });
            waitingNotice = setTimeout(() => console.warn(
                '[YaMa Fisher background] MAIN world is still preparing the track after 15 seconds',
                {trackId}
            ), 15_000);
            const results = await pageBridge.executeScript({
                target: {tabId},
                func: (id, albumId) => (
                    globalThis.yaMaFisher?.fetchTrackForDownload(id, albumId)
                ),
                args: [String(trackId), job.collectionId],
                world: 'MAIN'
            });
            clearTimeout(waitingNotice);
            const rawData = results[0]?.result;
            if (!rawData) {
                console.error(
                    '[YaMa Fisher background] MAIN world did not return track data',
                    {trackId, results}
                );
                throw new Error(`Could not prepare track ${trackId}`);
            }
            const data = JSON.parse(rawData);
            state.updateTrackState(jobId, trackId, {
                title: data.trackinfo?.title || `Track ${trackId}`,
                artist: getArtists(data.trackinfo, '')
            });
            await onTrackPrepared?.(data.trackinfo);
            const extensionBlobUrl = await createTaggedAudio(data,
                (received, total) => state.updateTrackProgress(jobId, trackId, received, total),
                controller, coverDataCache, job.collectionId);
            const downloadId = await downloadsAdapter.downloadFile(
                extensionBlobUrl,
                createFilename(data.trackinfo, job.collectionSubtitle, job.collectionId),
                id => state.updateTrackState(jobId, trackId, {downloadId: id})
            );
            state.readDownloadProgress(downloadId);
        } catch (error) {
            console.error('[YaMa Fisher background] Track download failed', {
                trackId, error: error.message, stack: error.stack
            });
            state.updateTrackState(jobId, trackId, {
                status: downloadStatus.FAILED,
                manualPaused: false,
                error: error.message
            });
            throw error;
        } finally {
            state.releaseTrackController(jobId, trackId);
            clearTimeout(waitingNotice);
        }
    }

    background.trackPipeline = Object.freeze({downloadTrack, downloadCollectionCover});
})();
