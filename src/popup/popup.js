/**
 * Popup UI renderer and download-state controls.
 */
const {
    actions: protocolActions,
    storageKeys,
    downloadStatus,
    collectionStateKind
} = globalThis.YMF_PROTOCOL;
const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [
    element.id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
    element
]));
const screens = Object.fromEntries(
    ['loading', 'authorization', 'collection', 'error'].map(kind => [
        kind, elements[`${kind}Screen`]
    ])
);
const DOWNLOAD_STATE_KEY = storageKeys.DOWNLOAD_STATE;
const CONTROLLABLE_STATUSES = new Set([
    downloadStatus.QUEUED, downloadStatus.DOWNLOADING, downloadStatus.PAUSED
]);
const FINISHED_STATUSES = new Set([downloadStatus.COMPLETED, downloadStatus.FAILED]);
let loadingRetryTimer = null;

export function renderPopup(state) {
    Object.values(screens).forEach(screen => { screen.hidden = true; });
    const screen = screens[state.kind] || screens.error;
    screen.hidden = false;
    elements.retry.hidden = state.kind === 'error' && state.retry === false;

    if (state.kind === 'authorization') {
        elements.authorizeLink.href = state.authorizationUrl || '#';
    }

    if (state.kind === 'collection') {
        const {collection} = state;
        const presentation = globalThis.YMF_COLLECTION_TYPES
            ?.get(collection.type)
            ?.present(collection);
        if (!presentation) {
            renderPopup({
                kind: 'error',
                message: `Unsupported collection type: ${collection.type || 'unknown'}`
            });
            return;
        }
        elements.collectionEyebrow.textContent = presentation.eyebrow;
        elements.collectionTitle.textContent = presentation.title;
        elements.collectionSubtitle.textContent = presentation.subtitle || '';
        elements.collectionSubtitle.hidden = !presentation.subtitle;
        elements.collectionMeta.textContent = presentation.meta || '';
        elements.collectionMeta.hidden = !presentation.meta;
        elements.downloadCollection.textContent = presentation.downloadLabel;
        elements.downloadCollection.disabled = false;
        elements.downloadCollection.onclick = () => {
            elements.downloadCollection.disabled = true;
            elements.downloadCollection.textContent = 'Download started';
            state.onDownload?.(collection.id, error => {
                if (error === 'This collection is already downloading') {
                    elements.downloadCollection.textContent = 'Already downloading';
                    return;
                }
                elements.downloadCollection.disabled = false;
                elements.downloadCollection.textContent = presentation.downloadLabel;
            });
        };
        setCover(collection.coverUrl, presentation.coverLabel);
    }

    if (state.kind === 'error') {
        elements.errorTitle.textContent = state.title || 'Could not load the collection';
        elements.errorMessage.textContent = state.message
            || 'Open a supported collection in Yandex Music and try again.';
    }
}

function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = value
        ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
        : 0;
    const amount = value / (1024 ** index);
    const formatted = amount.toLocaleString('en-US', {
        maximumFractionDigits: index ? 2 : 0
    });
    return `${formatted} ${units[index]}`;
}

function getTrackProgress(track) {
    if (track.status === downloadStatus.QUEUED) return 'Queued';
    if (track.status === downloadStatus.FAILED) return 'Failed';
    if (Number.isFinite(track.totalBytes) && track.totalBytes > 0) {
        return `${formatBytes(track.bytesReceived || 0)} / ${formatBytes(track.totalBytes)}`;
    }
    if (track.status === downloadStatus.PAUSED) return '';
    return track.status === downloadStatus.COMPLETED ? 'Downloaded' : 'Preparing…';
}

function requestControl(message, button) {
    button.disabled = true;
    chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError || !response?.success) {
            console.error('[YaMa Fisher popup] Could not update download state',
                chrome.runtime.lastError?.message || response?.error);
            button.disabled = false;
        }
    });
}

const TRACK_CONTROLS = {
    [downloadStatus.DOWNLOADING]: [
        protocolActions.PAUSE_DOWNLOAD, 'Pause', 'download-control--pause'
    ],
    [downloadStatus.PAUSED]: [
        protocolActions.RESUME_DOWNLOAD, 'Resume', 'download-control--resume'
    ],
    [downloadStatus.FAILED]: [protocolActions.RETRY_DOWNLOAD, 'Retry', 'download-control--retry']
};

function createDownloadGroup(job) {
    const group = document.createElement('section');
    group.className = 'download-collection';
    group.innerHTML = `
        <div class="download-collection__header">
            <span class="download-collection__status" aria-hidden="true">✓</span>
            <h2 class="download-collection__title"></h2>
            <div class="download-collection__actions">
                <button class="download-control" type="button"></button>
                <button class="download-control download-control--remove"
                        type="button">Hide</button></div>
        </div>
        <div class="download-collection__tracks"></div>`;
    const [pauseControl, removeControl] = group.querySelectorAll('button');
    const collectionStatus = group.querySelector('.download-collection__status');
    const collectionTitle = job.collectionTitle || job.albumTitle
        || `Collection ${job.collectionId || job.albumId || 'untitled'}`;
    const collectionSubtitle = job.collectionSubtitle || job.albumArtist || '';
    group.querySelector('h2').textContent = collectionSubtitle
        ? `${collectionTitle} - ${collectionSubtitle}`
        : collectionTitle;
    const tracks = job.tracks || [];
    const hasControllableTracks = tracks.some(track => CONTROLLABLE_STATUSES.has(track.status));
    const canHide = tracks.length > 0 && tracks.every(track => FINISHED_STATUSES.has(track.status));
    collectionStatus.hidden = !tracks.length
        || !tracks.every(track => track.status === downloadStatus.COMPLETED);
    const shouldShowPauseControl = hasControllableTracks || job.isPaused;
    pauseControl.hidden = !shouldShowPauseControl;
    pauseControl.textContent = job.isPaused ? 'Resume' : 'Pause';
    pauseControl.className = `download-control download-control--${
        job.isPaused ? 'resume' : 'pause'
    }`;
    pauseControl.onclick = () => requestControl({
        action: protocolActions.SET_COLLECTION_DOWNLOADS_PAUSED,
        jobId: job.id,
        paused: !job.isPaused
    }, pauseControl);
    removeControl.hidden = shouldShowPauseControl || !canHide;
    removeControl.onclick = () => requestControl(
        {action: protocolActions.REMOVE_COMPLETED_JOB, jobId: job.id},
        removeControl
    );
    group.lastElementChild.replaceChildren(...tracks.map(track => createDownloadRow(job, track)));
    return group;
}

function createDownloadRow(job, track) {
    const row = document.createElement('div');
    row.innerHTML = `
        <div class="download-item__content">
            <div class="download-item__main">
                <span class="download-item__status" aria-hidden="true"></span>
                <span class="download-item__title"></span>
                <span class="download-item__progress"></span></div>
            <div class="download-item__error"></div></div>
        <div class="download-item__actions">
            <button class="download-control" type="button"></button></div>`;
    const control = row.querySelector('button');
    const [main, error] = row.firstElementChild.children;
    const [, title, progress] = main.children;
    row.className = `download-item download-item--${track.status}`;
    title.textContent = `${track.position}. ${track.title}`;
    progress.textContent = getTrackProgress(track);
    error.hidden = !track.error;
    error.textContent = track.error ? 'Download failed. Try again.' : '';
    const controlData = track.status === downloadStatus.PAUSED && !track.manualPaused
        ? null
        : TRACK_CONTROLS[track.status];
    control.hidden = !controlData;
    if (controlData) {
        const [action, label, modifier] = controlData;
        control.textContent = label;
        control.className = `download-control ${modifier}`;
        control.onclick = () => requestControl({action, jobId: job.id, trackId: track.id}, control);
    }
    return row;
}

function renderDownloads(state) {
    const jobs = state?.jobs || [];
    if (!jobs.length) {
        elements.downloadsPanel.hidden = true;
        elements.downloadsList.replaceChildren();
        return;
    }

    const tracks = jobs.flatMap(job => job.tracks || []);
    const completed = tracks.filter(track => track.status === downloadStatus.COMPLETED).length;
    const hasControllableTracks = tracks.some(track => CONTROLLABLE_STATUSES.has(track.status));
    const allCompleted = tracks.length > 0
        && tracks.every(track => track.status === downloadStatus.COMPLETED);
    const hasPausedCollections = jobs.some(job => job.isPaused);
    const allControlPaused = Boolean(state.isPaused || hasPausedCollections);
    elements.downloadsPanel.hidden = false;
    elements.downloadsSummary.textContent = `${completed} of ${tracks.length}`;
    const shouldShowGlobalPauseControl = hasControllableTracks || allControlPaused;
    const shouldShowGlobalHideControl = !shouldShowGlobalPauseControl && allCompleted;
    elements.downloadsGlobalControl.hidden = !shouldShowGlobalPauseControl
        && !shouldShowGlobalHideControl;
    elements.downloadsGlobalControl.disabled = false;
    elements.downloadsGlobalControl.textContent = shouldShowGlobalHideControl
        ? 'Hide all'
        : allControlPaused ? 'Resume all' : 'Pause all';
    elements.downloadsGlobalControl.dataset.paused = String(allControlPaused);
    elements.downloadsGlobalControl.dataset.action = shouldShowGlobalHideControl
        ? protocolActions.CLEAR_COMPLETED_DOWNLOAD_HISTORY
        : protocolActions.SET_DOWNLOADS_PAUSED;
    const globalControlModifier = shouldShowGlobalHideControl
        ? 'remove'
        : allControlPaused ? 'resume' : 'pause';
    elements.downloadsGlobalControl.className =
        `download-control download-control--${globalControlModifier}`;

    const scrollTop = elements.downloadsList.scrollTop;
    elements.downloadsList.replaceChildren(...jobs.map(createDownloadGroup));
    elements.downloadsList.scrollTop = scrollTop;
}

function loadDownloadState() {
    chrome.storage.local.get(DOWNLOAD_STATE_KEY, result => {
        if (!chrome.runtime.lastError) renderDownloads(result[DOWNLOAD_STATE_KEY]);
    });
}

function setCover(url, label) {
    elements.collectionCover.classList.toggle('has-image', Boolean(url));
    elements.collectionCover.style.backgroundImage = url ? `url("${url}")` : '';
    elements.collectionCover.setAttribute('aria-label', label || 'Collection cover');
}

function loadAuthorizationState() {
    chrome.runtime.sendMessage({action: protocolActions.GET_AUTH_STATE}, state => {
        if (state?.loading) {
            showLoadingAndRetry();
            return;
        }
        if (chrome.runtime.lastError || state?.error) {
            renderPopup({
                kind: 'error',
                title: state?.title,
                retry: state?.retry,
                message: state?.error || 'Could not connect to the Yandex Music page.'
            });
            return;
        }
        if (!state?.authorized) {
            renderPopup({kind: 'authorization', authorizationUrl: state?.authorizationUrl});
            return;
        }

        chrome.runtime.sendMessage({
            action: protocolActions.GET_COLLECTION_STATE
        }, collectionState => {
            if (collectionState?.kind === collectionStateKind.LOADING) {
                showLoadingAndRetry();
                return;
            }
            if (chrome.runtime.lastError || collectionState?.kind === collectionStateKind.ERROR) {
                renderPopup({
                    kind: 'error',
                    message: collectionState?.message
                        || 'Could not load the collection details.'
                });
                return;
            }
            if (collectionState?.kind !== collectionStateKind.COLLECTION) {
                renderPopup({
                    kind: 'error',
                    message: 'Open a supported collection in Yandex Music.'
                });
                return;
            }
            renderPopup({
                kind: 'collection',
                collection: collectionState.collection,
                onDownload: (_, onError) => {
                    chrome.runtime.sendMessage({
                        action: protocolActions.DOWNLOAD_COLLECTION,
                        tabId: collectionState.tabId,
                        collection: collectionState.collection
                    }, response => {
                        const error = chrome.runtime.lastError?.message || response?.error;
                        if (!error) return;
                        console.error(
                            '[YaMa Fisher popup] Download command failed:', error
                        );
                        onError(error);
                    });
                }
            });
        });
    });
}

function showLoadingAndRetry() {
    renderPopup({kind: 'loading'});
    clearTimeout(loadingRetryTimer);
    loadingRetryTimer = window.setTimeout(loadAuthorizationState, 500);
}

elements.authorizeLink.addEventListener('click', event => {
    event.preventDefault();
    chrome.runtime.sendMessage({
        action: protocolActions.OPEN_AUTHORIZATION,
        authorizationUrl: elements.authorizeLink.href
    });
    window.close();
});
elements.retry.addEventListener('click', loadAuthorizationState);
elements.downloadsGlobalControl.addEventListener('click', () => {
    const {action, paused} = elements.downloadsGlobalControl.dataset;
    requestControl({
        action,
        ...(action === protocolActions.SET_DOWNLOADS_PAUSED && {paused: paused !== 'true'})
    }, elements.downloadsGlobalControl);
});
// noinspection JSDeprecatedSymbols -- WebExtension events still use addListener.
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[DOWNLOAD_STATE_KEY]) {
        renderDownloads(changes[DOWNLOAD_STATE_KEY].newValue);
    }
});

loadDownloadState();
loadAuthorizationState();
