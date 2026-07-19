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
    const activeJobRuns = new Map();
    const FINISHED_STATUSES = new Set([downloadStatus.COMPLETED, downloadStatus.FAILED]);
    const downloadLimit = Math.max(1, Math.min(Number(config.downloadCount) || 1, 8));
    const resumedSlotWaiters = [];
    const slotWaiters = [];
    let activeSlots = 0;

    function cancellationError(signal) {
        return signal?.reason instanceof Error
            ? signal.reason
            : new Error('Collection download cancelled');
    }

    function throwIfCancelled(signal) {
        if (signal?.aborted) throw cancellationError(signal);
    }

    function waitForDownloadSlot(waiters, signal) {
        throwIfCancelled(signal);
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = callback => {
                if (settled) return;
                settled = true;
                const index = waiters.indexOf(continueDownload);
                if (index !== -1) waiters.splice(index, 1);
                signal?.removeEventListener('abort', cancel);
                callback();
            };
            const continueDownload = () => finish(resolve);
            const cancel = () => finish(() => reject(cancellationError(signal)));
            waiters.push(continueDownload);
            signal?.addEventListener('abort', cancel, {once: true});
            if (signal?.aborted) cancel();
        });
    }

    function acquireDownloadSlot(resumed = false, signal) {
        throwIfCancelled(signal);
        if (activeSlots < downloadLimit) {
            activeSlots += 1;
            return Promise.resolve();
        }
        const waiters = resumed ? resumedSlotWaiters : slotWaiters;
        return waitForDownloadSlot(waiters, signal);
    }

    function releaseDownloadSlot() {
        const resume = resumedSlotWaiters.shift() || slotWaiters.shift();
        if (resume) {
            resume();
            return;
        }
        activeSlots = Math.max(0, activeSlots - 1);
    }

    function createDownloadSlotLease(jobId, signal) {
        let acquired = false;

        async function acquire(resumed) {
            if (acquired) return;
            while (true) {
                await state.waitUntilWorkersStarted(signal);
                await state.waitUntilDownloadsResumed(signal);
                await state.waitWhileJobPaused(jobId, signal);
                await acquireDownloadSlot(resumed, signal);
                if (signal?.aborted) {
                    releaseDownloadSlot();
                    throw cancellationError(signal);
                }
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

    async function withDownloadSlot(jobId, signal, callback) {
        const slotLease = createDownloadSlotLease(jobId, signal);
        await slotLease.acquire();
        try {
            throwIfCancelled(signal);
            return await callback(slotLease);
        } finally {
            slotLease.release();
        }
    }

    function beginJobRun(jobId) {
        if (!state.findJob(jobId)) {
            throw new Error('Collection is no longer stored in extension history');
        }
        let context = activeJobRuns.get(jobId);
        if (!context) {
            context = {controller: new AbortController(), users: 0};
            activeJobRuns.set(jobId, context);
        }
        context.users += 1;
        let released = false;
        return Object.freeze({
            signal: context.controller.signal,
            release() {
                if (released) return;
                released = true;
                context.users -= 1;
                if (!context.users && activeJobRuns.get(jobId) === context) {
                    activeJobRuns.delete(jobId);
                }
            }
        });
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
        if (!state.findJob(jobId)) return;
        const jobRun = beginJobRun(jobId);
        const {signal} = jobRun;
        try {
            const coverDataCache = new Map();
            let coverDownloadPromise = null;
            let failedTracks = 0;
            const saveCoverOnce = normalizedCollection.type === 'album'
                ? track => coverDownloadPromise ||= trackPipeline
                    .downloadCollectionCover(
                        jobId, track, normalizedCollection.subtitle,
                        normalizedCollection.id, signal
                    )
                    .catch(error => {
                        if (signal.aborted) return;
                        console.error(
                            '[YaMa Fisher background] Could not save separate collection cover',
                            error
                        );
                    })
                : null;
            const downloadTrack = async trackId => {
                try {
                    await withDownloadSlot(jobId, signal, slotLease => (
                        trackPipeline.downloadTrack(
                            jobId, tabId, trackId, coverDataCache, saveCoverOnce,
                            slotLease, signal
                        )
                    ));
                } catch {
                    if (!signal.aborted) failedTracks += 1;
                }
            };
            await Promise.all(trackIds.map(downloadTrack));
            await coverDownloadPromise;
            if (failedTracks && !signal.aborted) {
                console.warn(
                    '[YaMa Fisher background] Collection download finished with failed tracks',
                    {jobId, failedTracks, totalTracks: trackIds.length}
                );
            }
        } finally {
            jobRun.release();
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
        const jobRun = beginJobRun(job.id);
        const {signal} = jobRun;
        try {
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
            // Queued retries still need the shared page after earlier tracks are prepared.
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
                await state.waitUntilWorkersStarted(signal);
                await state.waitUntilDownloadsResumed(signal);
                retryTab = await pageBridge.acquireRetryTab(job);
                throwIfCancelled(signal);
                await pageBridge.ensurePageTools(retryTab.tabId);
                throwIfCancelled(signal);
                started = true;
                const results = await Promise.allSettled(tracks.map(async track => {
                    try {
                        await withDownloadSlot(job.id, signal, slotLease => (
                            trackPipeline.downloadTrack(
                                job.id, retryTab.tabId, track.id, coverDataCache,
                                () => finishPreparation(track.id), slotLease, signal
                            )
                        ));
                    } finally {
                        await finishPreparation(track.id);
                    }
                }));
                const failedResult = results.find(result => result.status === 'rejected');
                if (failedResult) throw failedResult.reason;
            } catch (error) {
                if (signal.aborted) return;
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
        } finally {
            jobRun.release();
        }
    }

    async function cancelCollection(jobId) {
        await state.ready;
        const job = state.findJob(jobId);
        if (!job) throw new Error('Collection is no longer stored in extension history');
        if (!(job.tracks || []).some(track => !FINISHED_STATUSES.has(track.status))) {
            throw new Error('Only an unfinished collection can be cancelled');
        }
        pendingCollections.delete(getCollectionKey({
            type: job.collectionType,
            id: job.collectionId
        }));
        activeJobRuns.get(jobId)?.controller.abort(
            new Error('Collection download cancelled')
        );
        await state.cancelCollectionJob(jobId);
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
        downloadCollection, retryTrack, retryFailedTracks, cancelCollection
    });
})();
