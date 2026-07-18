/**
 * Persistent download state, queue badge, Firefox reconciliation, and download controls.
 */
(() => {
    const background = globalThis.YMF_BACKGROUND ||= {};
    const downloadsAdapter = background.downloadsAdapter;
    const {storageKeys, downloadStatus} = globalThis.YMF_PROTOCOL;
    const DOWNLOAD_STATE_KEY = storageKeys.DOWNLOAD_STATE;
    const DOWNLOAD_STATE_RETENTION_MS = 24 * 60 * 60 * 1000;
    const PROGRESS_PERSIST_INTERVAL_MS = 1000;
    const ACTIVE_STATUSES = new Set([downloadStatus.DOWNLOADING, downloadStatus.PAUSED]);
    const PENDING_STATUSES = new Set([
        downloadStatus.QUEUED, downloadStatus.DOWNLOADING, downloadStatus.PAUSED
    ]);
    const FINISHED_STATUSES = new Set([downloadStatus.COMPLETED, downloadStatus.FAILED]);
    let downloadState = {jobs: [], isPaused: false, workersStopped: false};
    let persistQueue = Promise.resolve();
    let progressPersistTimer = null;
    let badgeText = null;
    const activeTrackControllers = new Map();
    const resumeWaiters = new Map();

    chrome.action.setBadgeBackgroundColor({color: '#ffcc00'});
    updateBadge();

    const ready = chrome.storage.local.get(DOWNLOAD_STATE_KEY).then(async result => {
        if (Array.isArray(result[DOWNLOAD_STATE_KEY]?.jobs)) {
            downloadState = result[DOWNLOAD_STATE_KEY];
        }
        downloadState.isPaused = Boolean(downloadState.isPaused);
        downloadState.workersStopped = Boolean(downloadState.workersStopped);
        await reconcileDownloadState();
        pruneExpiredJobs();
        await persistDownloadState();
    }).catch(error => {
        console.error('[YaMa Fisher background] Could not read download state', error);
    });

    function persistDownloadState() {
        clearTimeout(progressPersistTimer);
        progressPersistTimer = null;
        updateBadge();
        const snapshot = JSON.parse(JSON.stringify(downloadState));
        persistQueue = persistQueue
            .catch(() => {})
            .then(() => chrome.storage.local.set({[DOWNLOAD_STATE_KEY]: snapshot}));
        return persistQueue.catch(error => {
            console.error('[YaMa Fisher background] Could not save download state', error);
        });
    }

    function updateBadge() {
        const count = downloadState.jobs.reduce((total, job) => (
            total + (job.tracks || []).filter(track => PENDING_STATUSES.has(track.status)).length
        ), 0);
        const text = count ? String(count) : '';
        if (text === badgeText) return;
        badgeText = text;
        chrome.action.setBadgeText({text});
    }

    function scheduleProgressPersist() {
        if (progressPersistTimer) return;
        progressPersistTimer = setTimeout(() => {
            progressPersistTimer = null;
            void persistDownloadState();
        }, PROGRESS_PERSIST_INTERVAL_MS);
    }

    function pruneExpiredJobs() {
        const oldestAllowedTime = Date.now() - DOWNLOAD_STATE_RETENTION_MS;
        downloadState.jobs = downloadState.jobs.filter(job => job.createdAt >= oldestAllowedTime);
    }

    function findJob(jobId) {
        return downloadState.jobs.find(item => item.id === jobId);
    }

    function canHideCollection(job) {
        const tracks = job?.tracks || [];
        return tracks.length > 0
            && tracks.every(track => track.status === downloadStatus.COMPLETED);
    }

    function findTrack(jobId, trackId) {
        const job = findJob(jobId);
        const track = job?.tracks.find(item => item.id === String(trackId));
        return {job, track};
    }

    function hasActiveCollectionJob(collection) {
        const collectionType = collection?.type || 'unknown';
        const collectionId = String(collection?.id || '');
        return downloadState.jobs.some(job => (
            job.collectionType === collectionType
            && job.collectionId === collectionId
            && job.tracks.some(track => !FINISHED_STATUSES.has(track.status))
        ));
    }

    function getTrackKey(jobId, trackId) {
        return `${jobId}:${trackId}`;
    }

    function hasFirefoxDownload(track) {
        return Number.isInteger(track?.downloadId);
    }

    function isControllerPaused(controller) {
        return Boolean(
            controller?.manualPaused || controller?.globalPaused || controller?.collectionPaused
        );
    }

    function isControllerBlocked(controller) {
        return Boolean(controller?.workerStopped || isControllerPaused(controller));
    }

    function isTrackPaused(job, track, controller) {
        if (controller) return isControllerPaused(controller);
        return Boolean(track?.manualPaused || downloadState.isPaused || job?.isPaused);
    }

    function getProcessingStatus(job, track, controller) {
        if (isTrackPaused(job, track, controller)) return downloadStatus.PAUSED;
        if (controller?.workerStopped) return downloadStatus.DOWNLOADING;
        return controller?.waitingForSlot
            ? downloadStatus.QUEUED
            : downloadStatus.DOWNLOADING;
    }

    function resumeControllerIfReady(controller) {
        if (isControllerBlocked(controller)) return;
        const resume = controller.resume;
        controller.resume = null;
        resume?.();
    }

    async function waitWhileBlocked(controller) {
        if (!isControllerBlocked(controller)) return;
        if (!controller.slotLease) {
            while (isControllerBlocked(controller)) {
                await new Promise(resolve => { controller.resume = resolve; });
            }
            return;
        }

        controller.waitingForSlot = true;
        controller.slotLease.release();
        while (true) {
            while (isControllerBlocked(controller)) {
                await new Promise(resolve => { controller.resume = resolve; });
            }
            await controller.slotLease.reacquire();
            if (!isControllerBlocked(controller)) break;
            controller.slotLease.release();
        }
        controller.waitingForSlot = false;
        updateTrackState(controller.jobId, controller.trackId, {
            status: downloadStatus.DOWNLOADING
        });
    }

    async function waitForResume(key, isPaused) {
        while (isPaused()) {
            await new Promise(resolve => {
                if (!resumeWaiters.has(key)) resumeWaiters.set(key, new Set());
                resumeWaiters.get(key).add(resolve);
            });
        }
    }

    function resume(key) {
        resumeWaiters.get(key)?.forEach(resolve => resolve());
        resumeWaiters.delete(key);
    }

    function waitUntilDownloadsResumed() {
        return waitForResume('all', () => downloadState.isPaused);
    }

    function waitUntilWorkersStarted() {
        return waitForResume('workers', () => downloadState.workersStopped);
    }

    function waitWhileJobPaused(jobId) {
        return waitForResume(
            jobId,
            () => downloadState.jobs.find(job => job.id === jobId)?.isPaused
        );
    }

    function isJobSchedulingPaused(jobId) {
        const job = downloadState.jobs.find(item => item.id === jobId);
        return Boolean(downloadState.isPaused || job?.isPaused);
    }

    function isDownloadSchedulingBlocked(jobId) {
        return downloadState.workersStopped || isJobSchedulingPaused(jobId);
    }

    function createTrackController(jobId, trackId, slotLease) {
        const {job, track} = findTrack(jobId, trackId);
        if (!job || !track) return {job, track, controller: null};
        const controller = {
            jobId,
            trackId,
            manualPaused: Boolean(track.manualPaused),
            globalPaused: Boolean(downloadState.isPaused),
            collectionPaused: Boolean(job.isPaused),
            workerStopped: Boolean(downloadState.workersStopped),
            waitingForSlot: false,
            slotLease,
            resume: null
        };
        activeTrackControllers.set(getTrackKey(jobId, trackId), controller);
        return {job, track, controller};
    }

    function releaseTrackController(jobId, trackId) {
        activeTrackControllers.delete(getTrackKey(jobId, trackId));
        updateTrackState(jobId, trackId, {workerStopped: false});
    }

    function updateTrackState(jobId, trackId, changes) {
        const {track} = findTrack(jobId, trackId);
        if (!track) return;
        Object.assign(track, changes, {updatedAt: Date.now()});
        void persistDownloadState();
    }

    function updateTrackProgress(jobId, trackId, bytesReceived, totalBytes) {
        const {track} = findTrack(jobId, trackId);
        if (!track) return;
        Object.assign(track, {bytesReceived, totalBytes, updatedAt: Date.now()});
        scheduleProgressPersist();
    }

    async function createDownloadJob(collection, tabId, sourceOrigin = null) {
        await ready;
        const trackTitles = collection.metadata?.trackTitles || {};
        const job = {
            id: crypto.randomUUID(),
            collectionType: collection?.type || 'unknown',
            collectionId: String(collection?.id || ''),
            collectionTitle: collection?.title || 'Untitled',
            collectionSubtitle: collection?.subtitle || '',
            tabId,
            sourceOrigin,
            createdAt: Date.now(),
            isPaused: false,
            tracks: collection.entries.map((entry, index) => ({
                id: entry.trackId,
                position: entry.position,
                title: trackTitles[String(entry.trackId)] || `Track ${index + 1}`,
                status: downloadStatus.QUEUED,
                manualPaused: false,
                workerStopped: false,
                bytesReceived: 0,
                totalBytes: null
            }))
        };
        downloadState.jobs.unshift(job);
        pruneExpiredJobs();
        await persistDownloadState();
        return job.id;
    }

    function markQueuedTracksFailed(jobId, error) {
        const job = downloadState.jobs.find(item => item.id === jobId);
        if (!job) return;
        job.tracks.forEach(track => {
            if (track.status === downloadStatus.QUEUED) failTrack(track, error.message);
        });
        void persistDownloadState();
    }

    function findTrackByDownloadId(downloadId) {
        for (const job of downloadState.jobs) {
            const track = job.tracks.find(item => item.downloadId === downloadId);
            if (track) return {job, track};
        }
        return {};
    }

    function failedChanges(error) {
        return {
            status: downloadStatus.FAILED,
            manualPaused: false,
            workerStopped: false,
            error
        };
    }

    function failTrack(track, error) {
        Object.assign(track, failedChanges(error), {updatedAt: Date.now()});
    }

    function current(data, key) {
        const value = data[key];
        return value && typeof value === 'object' && 'current' in value ? value.current : value;
    }

    function syncDownloadProgress(downloadId, data = {}) {
        const {job, track} = findTrackByDownloadId(downloadId);
        if (!job || !track) return;
        const bytesReceived = current(data, 'bytesReceived');
        const totalBytes = current(data, 'totalBytes');
        const paused = current(data, 'paused');
        const firefoxState = current(data, 'state');
        const error = current(data, 'error');
        const changes = {};
        if (bytesReceived !== undefined) changes.bytesReceived = bytesReceived;
        if (totalBytes !== undefined) changes.totalBytes = totalBytes;
        if (paused === true) {
            changes.status = downloadStatus.PAUSED;
            if (!downloadState.isPaused && !job.isPaused) changes.manualPaused = true;
        }
        if (paused === false && track.status === downloadStatus.PAUSED) {
            changes.manualPaused = false;
            changes.status = downloadState.isPaused || job.isPaused
                ? downloadStatus.PAUSED
                : downloadStatus.DOWNLOADING;
        }
        if (firefoxState === 'complete') {
            changes.status = downloadStatus.COMPLETED;
            changes.manualPaused = false;
            changes.workerStopped = false;
            changes.error = null;
            changes.completedAt = Date.now();
            if (changes.totalBytes !== undefined) changes.bytesReceived = changes.totalBytes;
        }
        if (firefoxState === 'interrupted') {
            Object.assign(changes, failedChanges(error || 'Download interrupted'));
        }
        if (Object.keys(changes).length) updateTrackState(job.id, track.id, changes);
    }

    function readDownloadProgress(downloadId) {
        downloadsAdapter.find(downloadId).then(item => {
            if (item) syncDownloadProgress(downloadId, item);
        }).catch(() => {});
    }

    async function searchFirefoxDownload(downloadId) {
        try {
            return await downloadsAdapter.find(downloadId);
        } catch (error) {
            warnFirefoxDownload('inspect', downloadId, error);
            return null;
        }
    }

    function warnFirefoxDownload(action, downloadId, error) {
        console.warn(`[YaMa Fisher background] Could not ${action} Firefox download`, {
            downloadId, error: error.message
        });
    }

    async function reconcileDownloadState() {
        // Group pause controls are gone; preserve their paused downloads as track pauses.
        downloadState.isPaused = false;
        for (const job of downloadState.jobs) {
            job.isPaused = false;
            for (const track of job.tracks || []) {
                track.manualPaused = Boolean(track.manualPaused);
                track.workerStopped = false;
                if (FINISHED_STATUSES.has(track.status)) {
                    track.manualPaused = false;
                    continue;
                }

                if (!hasFirefoxDownload(track)) {
                    failTrack(
                        track,
                        'Extension background restarted before this track was handed to Firefox.'
                    );
                    continue;
                }

                const item = await searchFirefoxDownload(track.downloadId);
                if (!item) {
                    failTrack(track, 'Firefox download is no longer available.');
                    continue;
                }

                Object.assign(track, {
                    bytesReceived: item.bytesReceived,
                    totalBytes: item.totalBytes,
                    updatedAt: Date.now()
                });
                const terminalChanges = item.state === 'complete'
                    ? {status: downloadStatus.COMPLETED, manualPaused: false,
                        workerStopped: false, error: null,
                        completedAt: track.completedAt || Date.now()}
                    : item.state === 'interrupted'
                        ? failedChanges(item.error || 'Download interrupted')
                        : null;
                if (terminalChanges) {
                    Object.assign(track, terminalChanges);
                    continue;
                }

                track.error = null;
                if (item.paused) {
                    track.manualPaused = true;
                    track.status = downloadStatus.PAUSED;
                    continue;
                }

                track.manualPaused = false;
                track.status = downloadStatus.DOWNLOADING;
            }
        }
    }

    function changeFirefoxDownloadState(job, track, paused) {
        return downloadsAdapter.control(track.downloadId, paused ? 'pause' : 'resume')
            .then(() => updateTrackState(job.id, track.id, {
                status: getProcessingStatus(job, track)
            }))
            .catch(error => warnFirefoxDownload('change the state of', track.downloadId, error));
    }

    function controlDownload(jobId, trackId, method) {
        const {job, track} = findTrack(jobId, trackId);
        if (!job || !track) return Promise.reject(new Error('Download not found'));

        const controller = activeTrackControllers.get(getTrackKey(jobId, trackId));
        if (controller) {
            controller.manualPaused = method === 'pause';
            resumeControllerIfReady(controller);
            updateTrackState(jobId, trackId, {
                manualPaused: controller.manualPaused,
                status: getProcessingStatus(job, track, controller)
            });
            return Promise.resolve();
        }

        if (!hasFirefoxDownload(track)) {
            return Promise.reject(new Error('This download stage cannot be paused'));
        }

        if (method === 'resume' && (downloadState.isPaused || job.isPaused)) {
            updateTrackState(jobId, trackId, {manualPaused: false, status: downloadStatus.PAUSED});
            return Promise.resolve();
        }

        return downloadsAdapter.control(track.downloadId, method)
            .then(() => {
                updateTrackState(jobId, trackId, {
                    manualPaused: method === 'pause',
                    status: method === 'pause' ? downloadStatus.PAUSED : downloadStatus.DOWNLOADING
                });
                readDownloadProgress(track.downloadId);
            });
    }

    function collectPauseOperations(jobs, paused, ...controllerPauseKeys) {
        const operations = [];
        jobs.forEach(job => {
            job.tracks.forEach(track => {
                const controller = activeTrackControllers.get(getTrackKey(job.id, track.id));
                if (controller) {
                    controllerPauseKeys.forEach(key => { controller[key] = paused; });
                    resumeControllerIfReady(controller);
                    updateTrackState(job.id, track.id, {
                        status: getProcessingStatus(job, track, controller)
                    });
                    return;
                }
                if (!hasFirefoxDownload(track)) {
                    if ([downloadStatus.QUEUED, downloadStatus.PAUSED].includes(track.status)) {
                        updateTrackState(job.id, track.id, {
                            status: isTrackPaused(job, track)
                                ? downloadStatus.PAUSED
                                : downloadStatus.QUEUED
                        });
                    }
                    return;
                }
                if (!ACTIVE_STATUSES.has(track.status)) return;
                if (!paused && isTrackPaused(job, track)) {
                    updateTrackState(job.id, track.id, {status: downloadStatus.PAUSED});
                    return;
                }
                if (paused && track.status === downloadStatus.PAUSED) return;
                if (!paused && track.status === downloadStatus.DOWNLOADING) return;
                operations.push(changeFirefoxDownloadState(job, track, paused));
            });
        });
        return operations;
    }

    async function setWorkersStopped(stopped) {
        await ready;
        downloadState.workersStopped = stopped;
        activeTrackControllers.forEach(controller => {
            controller.workerStopped = stopped;
            const {track} = findTrack(controller.jobId, controller.trackId);
            if (track) {
                Object.assign(track, {workerStopped: stopped, updatedAt: Date.now()});
            }
            resumeControllerIfReady(controller);
        });
        if (!stopped) resume('workers');
        await persistDownloadState();
    }

    async function setDownloadsPaused(paused) {
        await ready;
        downloadState.isPaused = paused;
        downloadState.jobs.forEach(job => { job.isPaused = paused; });
        const operations = collectPauseOperations(
            downloadState.jobs, paused, 'globalPaused', 'collectionPaused'
        );
        if (!paused) {
            resume('all');
            downloadState.jobs.forEach(job => resume(job.id));
        }
        await Promise.all(operations);
        await persistDownloadState();
    }

    async function setCollectionDownloadsPaused(jobId, paused) {
        await ready;
        const job = downloadState.jobs.find(item => item.id === jobId);
        if (!job) throw new Error('Collection is no longer stored in extension history');
        let operations = [];
        if (!paused && downloadState.isPaused) {
            downloadState.jobs.forEach(item => { item.isPaused = true; });
            await Promise.all(collectPauseOperations(
                downloadState.jobs, true, 'collectionPaused'
            ));
            downloadState.isPaused = false;
            operations = collectPauseOperations(downloadState.jobs, false, 'globalPaused');
            resume('all');
        }
        job.isPaused = paused;
        operations.push(...collectPauseOperations([job], paused, 'collectionPaused'));
        if (!paused) resume(jobId);
        await Promise.all(operations);
        await persistDownloadState();
    }

    async function removeCompletedTrack(jobId, trackId) {
        await ready;
        const {job, track} = findTrack(jobId, trackId);
        if (!job || !track) throw new Error('Download is no longer stored in extension history');
        if (track.status !== downloadStatus.COMPLETED) {
            throw new Error('Only a downloaded track can be hidden');
        }
        job.tracks = job.tracks.filter(item => item.id !== track.id);
        if (!job.tracks.length) {
            downloadState.jobs = downloadState.jobs.filter(item => item.id !== job.id);
        }
        await persistDownloadState();
    }

    async function removeCompletedJob(jobId) {
        await ready;
        const job = findJob(jobId);
        if (!job) throw new Error('Collection is no longer stored in extension history');
        if (!canHideCollection(job)) {
            throw new Error('Only a successfully downloaded collection can be hidden');
        }
        downloadState.jobs = downloadState.jobs.filter(item => item.id !== jobId);
        await persistDownloadState();
    }

    async function clearCompletedDownloadHistory() {
        await ready;
        if (!downloadState.jobs.length || !downloadState.jobs.every(canHideCollection)) {
            throw new Error('History can be hidden only when every collection can be hidden');
        }
        downloadState.jobs = [];
        await persistDownloadState();
    }

    downloadsAdapter.onChanged(delta => {
        if (!Number.isInteger(delta.id)) return;
        syncDownloadProgress(delta.id, delta);
        readDownloadProgress(delta.id);
    });

    background.downloadState = Object.freeze({
        ready, findJob, findTrack, hasActiveCollectionJob, createTrackController,
        releaseTrackController, getProcessingStatus, waitWhileBlocked,
        waitUntilWorkersStarted, waitUntilDownloadsResumed, waitWhileJobPaused,
        isDownloadSchedulingBlocked,
        updateTrackState, updateTrackProgress, createDownloadJob, markQueuedTracksFailed,
        readDownloadProgress, controlDownload, setWorkersStopped, setDownloadsPaused,
        setCollectionDownloadsPaused,
        removeCompletedTrack, removeCompletedJob,
        clearCompletedDownloadHistory
    });
})();
