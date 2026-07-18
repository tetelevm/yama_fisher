/**
 * Global concurrency, worker stopping, collection queues, and track retries.
 */
(() => {
    const background = globalThis.YMF_BACKGROUND ||= {};
    const state = background.downloadState;
    const pageBridge = background.pageBridge;
    const trackPipeline = background.trackPipeline;
    const config = globalThis.YMF_CONFIG;
    const {downloadStatus} = globalThis.YMF_PROTOCOL;
    const pendingCollections = new Set();
    const FINISHED_STATUSES = new Set([downloadStatus.COMPLETED, downloadStatus.FAILED]);
    const downloadLimit = Math.max(1, Math.min(Number(config.downloadCount) || 1, 8));
    const resumedSlotWaiters = [];
    const slotWaiters = [];
    let activeSlots = 0;

    function acquireDownloadSlot(resumed = false) {
        if (activeSlots < downloadLimit) {
            activeSlots += 1;
            return Promise.resolve();
        }
        const waiters = resumed ? resumedSlotWaiters : slotWaiters;
        return new Promise(resolve => waiters.push(resolve));
    }

    function releaseDownloadSlot() {
        const resume = resumedSlotWaiters.shift() || slotWaiters.shift();
        if (resume) {
            resume();
            return;
        }
        activeSlots = Math.max(0, activeSlots - 1);
    }

    function createDownloadSlotLease(jobId) {
        let acquired = false;

        async function acquire(resumed) {
            if (acquired) return;
            while (true) {
                await state.waitUntilWorkersStarted();
                await state.waitUntilDownloadsResumed();
                await state.waitWhileJobPaused(jobId);
                await acquireDownloadSlot(resumed);
                // A scheduling block set while queued must return the claimed slot.
                if (!state.isDownloadSchedulingBlocked(jobId)) break;
                releaseDownloadSlot();
            }
            acquired = true;
        }

        function release() {
            if (!acquired) return;
            acquired = false;
            releaseDownloadSlot();
        }

        return Object.freeze({
            acquire: () => acquire(false),
            reacquire: () => acquire(true),
            release
        });
    }

    async function withDownloadSlot(jobId, callback) {
        const slotLease = createDownloadSlotLease(jobId);
        await slotLease.acquire();
        try {
            return await callback(slotLease);
        } finally {
            slotLease.release();
        }
    }

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
        const sourceOrigin = await pageBridge.getMusicTabOrigin(tabId);
        try {
            await pageBridge.ensurePageTools(tabId);
        } catch (error) {
            const jobId = await state.createDownloadJob(
                normalizedCollection, tabId, sourceOrigin
            );
            state.markQueuedTracksFailed(jobId, error);
            throw error;
        }
        try {
            normalizedCollection = await preloadTrackTitles(tabId, normalizedCollection);
        } catch (error) {
            console.warn('[YaMa Fisher background] Could not preload track titles', error);
        }
        const trackIds = normalizedCollection.entries.map(entry => entry.trackId);
        const jobId = await state.createDownloadJob(
            normalizedCollection, tabId, sourceOrigin
        );

        const coverDataCache = new Map();
        let coverDownloadPromise = null;
        let failedTracks = 0;
        const saveCoverOnce = track => coverDownloadPromise ||= trackPipeline
            .downloadCollectionCover(
                track, normalizedCollection.subtitle, normalizedCollection.id
            )
            .catch(error => {
                console.error(
                    '[YaMa Fisher background] Could not save separate collection cover', error
                );
            });
        const downloadTrack = async trackId => {
            try {
                await withDownloadSlot(jobId, slotLease => trackPipeline.downloadTrack(
                    jobId, tabId, trackId, coverDataCache, saveCoverOnce, slotLease
                ));
            } catch {
                failedTracks += 1;
            }
        };
        await Promise.all(trackIds.map(downloadTrack));
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

    async function retryTracks(job, tracks) {
        tracks.forEach(track => state.updateTrackState(job.id, track.id, {
            status: downloadStatus.QUEUED,
            manualPaused: false,
            workerStopped: false,
            error: null,
            downloadId: null,
            bytesReceived: 0,
            totalBytes: null
        }));
        let started = false;
        let retryTab = null;
        // Queued retries still need the shared page, even after earlier tracks are prepared.
        const pendingPreparations = new Set(tracks.map(track => track.id));
        const coverDataCache = new Map();
        const releaseRetryTab = async () => {
            const acquiredTab = retryTab;
            retryTab = null;
            await acquiredTab?.release();
        };
        const finishPreparation = async trackId => {
            if (!pendingPreparations.delete(trackId) || pendingPreparations.size) return;
            await releaseRetryTab();
        };
        try {
            await state.waitUntilWorkersStarted();
            await state.waitUntilDownloadsResumed();
            retryTab = await pageBridge.acquireRetryTab(job);
            await pageBridge.ensurePageTools(retryTab.tabId);
            started = true;
            const results = await Promise.allSettled(tracks.map(async track => {
                try {
                    await withDownloadSlot(job.id, slotLease => trackPipeline.downloadTrack(
                        job.id, retryTab.tabId, track.id, coverDataCache,
                        () => finishPreparation(track.id), slotLease
                    ));
                } finally {
                    await finishPreparation(track.id);
                }
            }));
            const failedResult = results.find(result => result.status === 'rejected');
            if (failedResult) throw failedResult.reason;
        } catch (error) {
            if (!started) {
                tracks.forEach(track => state.updateTrackState(job.id, track.id, {
                    status: downloadStatus.FAILED,
                    error: error.message
                }));
            }
            throw error;
        } finally {
            await releaseRetryTab();
        }
    }

    async function retryTrack(jobId, trackId) {
        await state.ready;
        const {job, track} = state.findTrack(jobId, trackId);
        if (!job || !track) throw new Error('Download is no longer stored in extension history');
        if (track.status !== downloadStatus.FAILED) {
            throw new Error('Only a failed download can be retried');
        }
        await retryTracks(job, [track]);
    }

    async function retryFailedTracks(jobId) {
        await state.ready;
        const job = state.findJob(jobId);
        if (!job) throw new Error('Collection is no longer stored in extension history');
        const tracks = job.tracks || [];
        const failedTracks = tracks.filter(track => track.status === downloadStatus.FAILED);
        const allTracksFinished = tracks.length > 0
            && tracks.every(track => FINISHED_STATUSES.has(track.status));
        if (!allTracksFinished || !failedTracks.length) {
            throw new Error('Only a finished collection with failed tracks can be retried');
        }
        await retryTracks(job, failedTracks);
    }

    background.downloadScheduler = Object.freeze({
        downloadCollection, retryTrack, retryFailedTracks
    });
})();
