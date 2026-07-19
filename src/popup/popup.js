/**
 * Popup UI renderer and download-state controls.
 */
const {
    actions: protocolActions,
    storageKeys,
    downloadStatus,
    collectionStateKind
} = globalThis.YMF_PROTOCOL;
const TEMPLATE_FILES = ['popup/collection-card.html', 'popup/downloads.html'];
let templates;

async function loadPopupTemplates() {
    const templateLists = await Promise.all(TEMPLATE_FILES.map(async path => {
        const response = await fetch(chrome.runtime.getURL(path));
        if (!response.ok) throw new Error(`Could not load ${path}: ${response.status}`);
        const templateDocument = new DOMParser().parseFromString(
            await response.text(), 'text/html'
        );
        return [...templateDocument.querySelectorAll('template')];
    }));
    const loadedTemplates = new Map();
    templateLists.flat().forEach(template => {
        if (!template.id || loadedTemplates.has(template.id)) {
            throw new Error(`Invalid or duplicate popup template: ${template.id || '(missing)'}`);
        }
        loadedTemplates.set(template.id, template);
    });
    return loadedTemplates;
}

function cloneTemplate(templateId) {
    const root = templates.get(templateId)?.content.firstElementChild;
    if (!root) throw new Error(`Popup template is missing: ${templateId}`);
    return document.importNode(root, true);
}

function showTemplateLoadError(error) {
    console.error('[YaMa Fisher popup] Could not load popup templates', error);
    document.getElementById('loading-screen').hidden = true;
    document.getElementById('error-screen').hidden = false;
    document.getElementById('error-title').textContent = 'Could not load the popup';
    document.getElementById('error-message').textContent =
        'Reload the extension and open the popup again.';
    document.getElementById('retry').hidden = true;
}

try {
    templates = await loadPopupTemplates();
    document.getElementById('collection-card-slot').replaceWith(
        cloneTemplate('collection-card-template')
    );
    document.getElementById('downloads-slot').replaceWith(
        cloneTemplate('downloads-panel-template')
    );
} catch (error) {
    showTemplateLoadError(error);
    throw error;
}

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
const FINISHED_STATUSES = new Set([downloadStatus.COMPLETED, downloadStatus.FAILED]);
const COLLECTION_ARTIST_MAX_LENGTH = 33;
const COLLECTION_ARTIST_VISIBLE_LENGTH = 30;
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

function canHideCollection(job) {
    const tracks = job.tracks || [];
    return tracks.length > 0
        && tracks.every(track => track.status === downloadStatus.COMPLETED);
}

function truncateCollectionArtist(value) {
    const characters = Array.from(value);
    if (characters.length <= COLLECTION_ARTIST_MAX_LENGTH) return value;
    return `${characters.slice(0, COLLECTION_ARTIST_VISIBLE_LENGTH).join('')}...`;
}

function createDownloadGroup(job) {
    const group = cloneTemplate('download-collection-template');
    const hideControl = group.querySelector('.download-collection__hide');
    const retryControl = group.querySelector('.download-collection__retry');
    const collectionStatus = group.querySelector('.download-collection__status');
    const title = group.querySelector('.download-collection__title');
    const trackList = group.querySelector('.download-collection__tracks');
    const collectionTitle = job.collectionTitle || job.albumTitle
        || `Collection ${job.collectionId || job.albumId || 'untitled'}`;
    const collectionSubtitle = job.collectionSubtitle || job.albumArtist || '';
    title.textContent = ['artist-top-tracks', 'playlist'].includes(job.collectionType)
        ? collectionTitle
        : collectionSubtitle
        ? `${truncateCollectionArtist(collectionSubtitle)} - ${collectionTitle}`
        : collectionTitle;
    const tracks = job.tracks || [];
    const allTracksCompleted = canHideCollection(job);
    const allTracksFinished = tracks.length > 0
        && tracks.every(track => FINISHED_STATUSES.has(track.status));
    const hasFailedTracks = tracks.some(track => track.status === downloadStatus.FAILED);
    collectionStatus.hidden = !allTracksCompleted;
    hideControl.hidden = !allTracksCompleted;
    retryControl.hidden = !allTracksFinished || !hasFailedTracks;
    hideControl.onclick = () => requestControl(
        {action: protocolActions.REMOVE_COMPLETED_JOB, jobId: job.id},
        hideControl
    );
    retryControl.onclick = () => requestControl(
        {action: protocolActions.RETRY_FAILED_COLLECTION_DOWNLOADS, jobId: job.id},
        retryControl
    );
    trackList.replaceChildren(...tracks.map(track => createDownloadRow(job, track)));
    return group;
}

function createDownloadRow(job, track) {
    const row = cloneTemplate('download-track-template');
    const title = row.querySelector('.download-item__title');
    const progress = row.querySelector('.download-item__progress');
    const stoppedControl = row.querySelector('.download-item__stopped');
    row.className = `download-item download-item--${track.status}`;
    title.textContent = job.collectionType === 'track'
        ? track.title
        : `${track.position}. ${track.title}`;
    progress.textContent = getTrackProgress(track);
    const workerStopped = track.status === downloadStatus.DOWNLOADING
        && Boolean(track.workerStopped);
    stoppedControl.hidden = !workerStopped;
    const controls = [
        [row.querySelector('.download-item__pause'), protocolActions.PAUSE_DOWNLOAD,
            track.status === downloadStatus.DOWNLOADING && !workerStopped],
        [row.querySelector('.download-item__resume'), protocolActions.RESUME_DOWNLOAD,
            track.status === downloadStatus.PAUSED && track.manualPaused],
        [row.querySelector('.download-item__retry'), protocolActions.RETRY_DOWNLOAD,
            track.status === downloadStatus.FAILED]
    ];
    controls.forEach(([control, action, visible]) => {
        control.hidden = !visible;
        control.onclick = () => requestControl({action, jobId: job.id, trackId: track.id}, control);
    });
    return row;
}

function renderDownloads(state) {
    const jobs = state?.jobs || [];
    const workersStopped = Boolean(state?.workersStopped);
    elements.downloadsWorkersToggle.classList.toggle(
        'downloads__workers-toggle--stopped', workersStopped
    );
    elements.downloadsWorkersToggle.dataset.stopped = String(workersStopped);
    elements.downloadsWorkersToggle.title = workersStopped ? 'Resume workers' : 'Stop workers';
    elements.downloadsWorkersToggle.setAttribute(
        'aria-label', workersStopped ? 'Resume workers' : 'Stop workers'
    );
    elements.downloadsWorkersToggle.setAttribute('aria-pressed', String(workersStopped));
    if (!jobs.length) {
        elements.downloadsWorkersToggle.disabled = true;
        elements.downloadsPanel.hidden = true;
        elements.downloadsList.replaceChildren();
        return;
    }

    const tracks = jobs.flatMap(job => job.tracks || []);
    const completed = tracks.filter(track => track.status === downloadStatus.COMPLETED).length;
    const allCollectionsCanHide = jobs.every(canHideCollection);
    const hasUnfinishedTracks = tracks.some(track => !FINISHED_STATUSES.has(track.status));
    elements.downloadsPanel.hidden = false;
    elements.downloadsWorkersToggle.disabled = !hasUnfinishedTracks;
    elements.downloadsSummary.textContent = `${completed} of ${tracks.length}`;
    elements.downloadsHideAll.hidden = !allCollectionsCanHide;
    elements.downloadsHideAll.disabled = false;

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
elements.downloadsWorkersToggle.addEventListener('click', () => {
    requestControl({
        action: protocolActions.SET_WORKERS_STOPPED,
        stopped: elements.downloadsWorkersToggle.dataset.stopped !== 'true'
    }, elements.downloadsWorkersToggle);
});
elements.downloadsHideAll.addEventListener('click', () => {
    requestControl({
        action: protocolActions.CLEAR_COMPLETED_DOWNLOAD_HISTORY
    }, elements.downloadsHideAll);
});
// noinspection JSDeprecatedSymbols -- WebExtension events still use addListener.
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[DOWNLOAD_STATE_KEY]) {
        renderDownloads(changes[DOWNLOAD_STATE_KEY].newValue);
    }
});

loadDownloadState();
loadAuthorizationState();
