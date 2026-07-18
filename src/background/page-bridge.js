/**
 * Firefox tab access and the bridge to Yandex Music's MAIN world.
 */
(() => {
    const background = globalThis.YMF_BACKGROUND ||= {};
    const {actions, collectionStateKind} = globalThis.YMF_PROTOCOL;

    function executeScript(details) {
        return new Promise((resolve, reject) => {
            chrome.scripting.executeScript(details, results => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                resolve(results || []);
            });
        });
    }

    async function injectPageAuth(tabId) {
        await executeScript({
            target: {tabId},
            files: [
                'src/protocol.js',
                'src/config.js',
                'src/page/service-constants.js',
                'src/page/auth.js'
            ],
            world: 'MAIN'
        });
    }

    async function injectCollectionTools(tabId) {
        await executeScript({
            target: {tabId},
            files: [
                'src/collection-types.js',
                'src/page/collection.js',
                'src/page/download.js',
                ...globalThis.YMF_COLLECTION_TYPES.getPageScripts()
            ],
            world: 'MAIN'
        });
    }

    async function ensurePageTools(tabId) {
        const results = await executeScript({
            target: {tabId},
            func: () => Boolean(
                globalThis.yaMaFisher?.fetchTrackForDownload
                && globalThis.yaMaFisher?.fetchAlbumTracks
                && globalThis.yaMaFisher?.registerCollectionSource
            ),
            world: 'MAIN'
        });
        if (results[0]?.result) return;
        await injectPageAuth(tabId);
        await injectCollectionTools(tabId);
    }

    function getActiveTab(callback) {
        chrome.tabs.query({active: true, currentWindow: true}, tabs => callback(tabs[0]));
    }

    function getCollectionMatch(tab) {
        return globalThis.YMF_COLLECTION_TYPES?.match(tab?.url || '') || null;
    }

    function requireCollectionTab(tab, sendResponse, response) {
        const match = getCollectionMatch(tab);
        if (!match) {
            sendResponse(response);
            return false;
        }
        if (!match.definition.implemented) {
            const message = match.definition.unavailableMessage;
            const title = match.definition.errorTitle || 'Could not load collection';
            sendResponse({
                kind: collectionStateKind.ERROR,
                authorized: false,
                error: message,
                message,
                title,
                retry: false
            });
            return false;
        }
        return true;
    }

    function getStateFromTab(tabId, action, sendResponse) {
        const isCollection = action === actions.GET_COLLECTION_STATE;
        const response = (auth, collection) => isCollection ? collection : auth;
        if (!Number.isInteger(tabId)) return sendResponse(response(
            {authorized: false, error: 'Open Yandex Music.'},
            {kind: collectionStateKind.ERROR, message: 'Open Yandex Music.'}
        ));
        chrome.tabs.sendMessage(tabId, {action}, state => {
            if (chrome.runtime.lastError) {
                chrome.tabs.get(tabId, tab => {
                    sendResponse(tab?.status === 'loading'
                        ? response({loading: true}, {kind: collectionStateKind.LOADING})
                        : response(
                            {
                                authorized: false,
                                error: 'Open a supported collection in Yandex Music.'
                            },
                            {
                                kind: collectionStateKind.ERROR,
                                message: 'Open a supported collection in Yandex Music.'
                            }
                        ));
                });
                return;
            }
            sendResponse(isCollection ? {...state, tabId} : state);
        });
    }

    background.pageBridge = Object.freeze({
        executeScript, injectPageAuth, injectCollectionTools, ensurePageTools,
        getActiveTab, getCollectionMatch, requireCollectionTab,
        getStateFromTab
    });
})();
