/**
 * Common collection-page lifecycle in the Yandex Music MAIN world.
 * Type-specific modules only register URL-matched data extractors.
 */
(() => {
    const app = globalThis.yaMaFisher ||= {};
    if (app.collectionMonitoringActive) return;
    app.collectionMonitoringActive = true;

    const {events, storageKeys, collectionStateKind} = globalThis.YMF_PROTOCOL;
    const STORAGE_KEY_PREFIX = storageKeys.COLLECTION_PREFIX;
    const CLEANUP_STORAGE_KEY = storageKeys.COLLECTION_LAST_CLEANUP;
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const STORAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    const sources = new Map();
    let observedUrl = window.location.href;
    let readSequence = 0;

    function notify(storageKey, state) {
        document.documentElement.dataset.yamaFisherCollectionStorageKey = storageKey;
        localStorage.setItem(storageKey, JSON.stringify({...state, storedAt: Date.now()}));
        window.dispatchEvent(new Event(events.COLLECTION_STATE_CHANGED));
    }

    function cleanupStoredCollections() {
        const now = Date.now();
        const lastCleanup = Number(localStorage.getItem(CLEANUP_STORAGE_KEY));
        if (Number.isFinite(lastCleanup) && now - lastCleanup < CLEANUP_INTERVAL_MS) return;

        const oldestAllowedTime = now - STORAGE_RETENTION_MS;
        for (let index = localStorage.length - 1; index >= 0; index -= 1) {
            const key = localStorage.key(index);
            if (!key?.startsWith(STORAGE_KEY_PREFIX)) continue;
            try {
                const state = JSON.parse(localStorage.getItem(key) || 'null');
                if (!Number.isFinite(state?.storedAt) || state.storedAt < oldestAllowedTime) {
                    localStorage.removeItem(key);
                }
            } catch {
                localStorage.removeItem(key);
            }
        }
        localStorage.setItem(CLEANUP_STORAGE_KEY, String(now));
    }

    async function readOpenCollection() {
        const match = globalThis.YMF_COLLECTION_TYPES?.match(window.location.href);
        const source = match && sources.get(match.definition.type);
        if (!match || !source) {
            delete document.documentElement.dataset.yamaFisherCollectionStorageKey;
            window.dispatchEvent(new Event(events.COLLECTION_STATE_CHANGED));
            return;
        }

        const requestedUrl = window.location.href;
        const sequence = ++readSequence;
        const storageKey = `${STORAGE_KEY_PREFIX}${match.definition.type}.${match.id}`;
        document.documentElement.dataset.yamaFisherCollectionStorageKey = storageKey;
        notify(storageKey, {kind: collectionStateKind.LOADING});

        try {
            const result = await source.read({id: match.id, url: requestedUrl});
            if (sequence !== readSequence || window.location.href !== requestedUrl) return;
            const collection = globalThis.YMF_COLLECTION_TYPES?.normalize(
                match.definition.type, result, match.id
            );
            if (!collection) {
                throw new Error(`${match.definition.type} source returned an invalid collection`);
            }
            notify(storageKey, {kind: collectionStateKind.COLLECTION, collection});
        } catch (error) {
            if (sequence !== readSequence || window.location.href !== requestedUrl) return;
            console.error(`[YaMa Fisher page] Could not read ${match.definition.type}:`, error);
            notify(storageKey, {
                kind: collectionStateKind.ERROR,
                collectionType: match.definition.type,
                message: error.message || 'Could not load collection data.'
            });
        }
    }

    app.registerCollectionSource = source => {
        if (!source?.type || typeof source.read !== 'function') {
            throw new TypeError('A collection source requires a type and read function');
        }
        sources.set(source.type, source);
        void readOpenCollection();
    };
    app.readOpenCollection = readOpenCollection;

    cleanupStoredCollections();

    new MutationObserver(() => {
        if (window.location.href === observedUrl) return;
        observedUrl = window.location.href;
        void readOpenCollection();
    }).observe(document, {childList: true, subtree: true});
})();
