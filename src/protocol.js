/**
 * Shared message, event, storage, and status names for every extension context.
 */
(() => {
    if (globalThis.YMF_PROTOCOL) return;

    const enumOf = names => Object.freeze(Object.fromEntries(
        names.map(name => [name, name.toLowerCase()])
    ));
    const actions = enumOf([
        'INJECT_PAGE_TOOLS', 'GET_AUTH_STATE', 'AUTH_STATE_CHANGED', 'GET_COLLECTION_STATE',
        'COLLECTION_STATE_CHANGED', 'OPEN_AUTHORIZATION', 'DOWNLOAD_COLLECTION',
        'SET_DOWNLOADS_PAUSED', 'SET_COLLECTION_DOWNLOADS_PAUSED', 'PAUSE_DOWNLOAD',
        'RESUME_DOWNLOAD', 'RETRY_DOWNLOAD', 'REMOVE_COMPLETED_TRACK', 'REMOVE_COMPLETED_JOB',
        'CLEAR_COMPLETED_DOWNLOAD_HISTORY',
    ]);

    const events = Object.freeze({
        AUTH_STATE_CHANGED: 'yama-fisher:auth-state-changed',
        COLLECTION_STATE_CHANGED: 'yama-fisher:collection-state-changed'
    });

    const storageKeys = Object.freeze({
        DOWNLOAD_STATE: 'yaMaFisherDownloadState',
        COLLECTION_PREFIX: 'yaMaFisher.collection.',
        COLLECTION_LAST_CLEANUP: 'yaMaFisher.collectionLastCleanup'
    });

    const downloadStatus = enumOf(['QUEUED', 'DOWNLOADING', 'PAUSED', 'COMPLETED', 'FAILED']);
    const collectionStateKind = enumOf(['LOADING', 'COLLECTION', 'ERROR']);

    globalThis.YMF_PROTOCOL = Object.freeze({
        actions, events, storageKeys, downloadStatus, collectionStateKind
    });
})();
