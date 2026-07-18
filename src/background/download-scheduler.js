/**
 * Collection concurrency and retry orchestration around the single-track pipeline.
 */
(() => {
    const background = globalThis.YMF_BACKGROUND ||= {};
    const state = background.downloadState;
    const pageBridge = background.pageBridge;
    const trackPipeline = background.trackPipeline;
    const config = globalThis.YMF_CONFIG;
    const {downloadStatus} = globalThis.YMF_PROTOCOL;
    const pendingCollections = new Set();

    async function preloadTrackTitles(tabId, collection) {
        const titles = collection.metadata?.trackTitles || {};
        const missingTitle = collection.entries.some(entry => !titles[entry.trackId]);
        if (collection.type !== 'album' || !missingTitle) return collection;

        const results = await pageBridge.executeScript({
            target: {tabId},
            func: async albumId => {
                const tracks = await globalThis.yaMaFisher.fetchAlbumTracks(albumId);
                return Object.fromEntries(tracks.flatMap(track => (
                    track?.id != null && track.title
                        ? [[String(track.id), track.title]]
                        : []
                )));
            },
            args: [collection.id],
            world: 'MAIN'
        });
        return {
            ...collection,
            metadata: {...collection.metadata, trackTitles: {...titles, ...results[0]?.result}}
        };
    }

    function getCollectionKey(collection) {
        return `${collection.type}:${collection.id}`;
    }

    async function runCollectionDownload(tabId, collection) {
        let normalizedCollection = collection;
        try {
            await pageBridge.ensurePageTools(tabId);
        } catch (error) {
            const jobId = await state.createDownloadJob(normalizedCollection, tabId);
            state.markQueuedTracksFailed(jobId, error);
            throw error;
        }
        try {
            normalizedCollection = await preloadTrackTitles(tabId, normalizedCollection);
        } catch (error) {
            console.warn('[YaMa Fisher background] Could not preload track titles', error);
        }
        const trackIds = normalizedCollection.entries.map(entry => entry.trackId);
        const jobId = await state.createDownloadJob(normalizedCollection, tabId);

        const concurrency = Math.max(1, Math.min(Number(config.downloadCount) || 1, 8));
        const coverDataCache = new Map();
        let coverDownloadPromise = null;
        let failedTracks = 0;
        let nextTrackIndex = 0;
        const saveCoverOnce = track => coverDownloadPromise ||= trackPipeline
            .downloadCollectionCover(
                track, normalizedCollection.subtitle, normalizedCollection.id
            )
            .catch(error => {
                console.error(
                    '[YaMa Fisher background] Could not save separate collection cover', error
                );
            });
        const downloadNext = async () => {
            while (true) {
                const index = nextTrackIndex++;
                if (index >= trackIds.length) return;
                await state.waitUntilDownloadsResumed();
                try {
                    await trackPipeline.downloadTrack(
                        jobId, tabId, trackIds[index], coverDataCache, saveCoverOnce
                    );
                } catch {
                    failedTracks += 1;
                }
            }
        };
        await Promise.all(Array.from(
            {length: Math.min(concurrency, trackIds.length)},
            downloadNext
        ));
        await coverDownloadPromise;
        if (failedTracks) {
            console.warn(
                '[YaMa Fisher background] Collection download finished with failed tracks',
                {jobId, failedTracks, totalTracks: trackIds.length}
            );
        }
    }

    async function downloadCollection(tabId, collection) {
        const normalizedCollection = globalThis.YMF_COLLECTION_TYPES?.normalize(
            collection?.type,
            collection,
            collection?.id
        );
        if (!Number.isInteger(tabId) || !normalizedCollection) {
            throw new Error('A collection download requires a track list');
        }
        await state.ready;
        const collectionKey = getCollectionKey(normalizedCollection);
        if (pendingCollections.has(collectionKey)
            || state.hasActiveCollectionJob(normalizedCollection)) {
            throw new Error('This collection is already downloading');
        }
        pendingCollections.add(collectionKey);
        try {
            await runCollectionDownload(tabId, normalizedCollection);
        } finally {
            pendingCollections.delete(collectionKey);
        }
    }

    async function retryTrack(jobId, trackId) {
        await state.ready;
        const {job, track} = state.findTrack(jobId, trackId);
        if (!job || !track) throw new Error('Download is no longer stored in extension history');
        if (track.status !== downloadStatus.FAILED) {
            throw new Error('Only a failed download can be retried');
        }
        if (!Number.isInteger(job.tabId)) {
            throw new Error('Original Yandex Music tab is unavailable');
        }

        state.updateTrackState(jobId, trackId, {
            status: downloadStatus.QUEUED,
            manualPaused: false,
            error: null,
            downloadId: null,
            bytesReceived: 0,
            totalBytes: null
        });
        let started = false;
        try {
            await state.waitUntilDownloadsResumed();
            await pageBridge.ensurePageTools(job.tabId);
            started = true;
            await trackPipeline.downloadTrack(jobId, job.tabId, trackId, new Map());
        } catch (error) {
            if (!started) {
                state.updateTrackState(jobId, trackId, {
                    status: downloadStatus.FAILED,
                    error: error.message
                });
            }
            throw error;
        }
    }

    background.downloadScheduler = Object.freeze({downloadCollection, retryTrack});
})();
