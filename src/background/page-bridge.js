/**
 * Firefox tab access and the bridge to Yandex Music's MAIN world.
 */
(() => {
    const background = globalThis.YMF_BACKGROUND ||= {};
    const {actions, collectionStateKind} = globalThis.YMF_PROTOCOL;
    const MUSIC_HOST_PATTERN = /^music\.yandex\.(?:ru|com|kz|by|uz)$/;
    const DEFAULT_MUSIC_ORIGIN = 'https://music.yandex.ru';
    const RETRY_TAB_READY_TIMEOUT_MS = 30_000;
    const temporaryRetryTabIds = new Set();

    function callTabs(method, ...args) {
        return new Promise((resolve, reject) => {
            chrome.tabs[method](...args, result => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                resolve(result);
            });
        });
    }

    function parseMusicUrl(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && MUSIC_HOST_PATTERN.test(url.hostname)
                ? url
                : null;
        } catch {
            return null;
        }
    }

    async function getTabOrNull(tabId) {
        if (!Number.isInteger(tabId)) return null;
        try {
            return await callTabs('get', tabId);
        } catch {
            return null;
        }
    }

    async function getMusicTabOrigin(tabId) {
        const tab = await getTabOrNull(tabId);
        return parseMusicUrl(tab?.url)?.origin || null;
    }

    function waitForTabReady(tabId) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeoutId = setTimeout(() => finish(
                new Error('Timed out while opening a Yandex Music tab for retry')
            ), RETRY_TAB_READY_TIMEOUT_MS);

            function cleanup() {
                clearTimeout(timeoutId);
                // noinspection JSDeprecatedSymbols -- WebExtension events use removeListener.
                chrome.tabs.onUpdated.removeListener(onUpdated);
                // noinspection JSDeprecatedSymbols -- WebExtension events use removeListener.
                chrome.tabs.onRemoved.removeListener(onRemoved);
            }

            function finish(error, tab) {
                if (settled) return;
                settled = true;
                cleanup();
                error ? reject(error) : resolve(tab);
            }

            function onUpdated(updatedTabId, changeInfo, tab) {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                    finish(null, tab);
                }
            }

            function onRemoved(removedTabId) {
                if (removedTabId === tabId) {
                    finish(new Error('Yandex Music tab was closed while preparing retry'));
                }
            }

            // noinspection JSDeprecatedSymbols -- WebExtension events still use addListener.
            chrome.tabs.onUpdated.addListener(onUpdated);
            // noinspection JSDeprecatedSymbols -- WebExtension events still use addListener.
            chrome.tabs.onRemoved.addListener(onRemoved);
            getTabOrNull(tabId).then(tab => {
                if (!tab) return finish(new Error('Yandex Music tab is unavailable'));
                if (tab.status === 'complete') finish(null, tab);
            });
        });
    }

    async function getReadyMusicTab(tab, preferredOrigin) {
        if (!tab || tab.discarded || !Number.isInteger(tab.id)
            || temporaryRetryTabIds.has(tab.id)) return null;
        const initialOrigin = parseMusicUrl(tab.url)?.origin;
        if (!initialOrigin || (preferredOrigin && initialOrigin !== preferredOrigin)) return null;
        try {
            const readyTab = tab.status === 'complete' ? tab : await waitForTabReady(tab.id);
            const readyOrigin = parseMusicUrl(readyTab?.url)?.origin;
            return readyOrigin && (!preferredOrigin || readyOrigin === preferredOrigin)
                ? readyTab
                : null;
        } catch {
            return null;
        }
    }

    function getRetryUrl(job, origin) {
        if (job.collectionType === 'album' && job.collectionId) {
            return `${origin}/album/${encodeURIComponent(job.collectionId)}`;
        }
        return `${origin}/`;
    }

    async function closeTemporaryTab(tabId) {
        try {
            await callTabs('remove', tabId);
        } catch {
            // The user may have already closed the temporary tab.
        } finally {
            temporaryRetryTabIds.delete(tabId);
        }
    }

    function openTemporaryTab(url) {
        return new Promise((resolve, reject) => {
            chrome.tabs.create({url, active: false}, tab => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                if (!Number.isInteger(tab?.id)) {
                    return reject(new Error('Could not open a retry tab'));
                }
                temporaryRetryTabIds.add(tab.id);
                resolve(tab);
            });
        });
    }

    async function createTemporaryRetryTab(job, origin) {
        const tab = await openTemporaryTab(getRetryUrl(job, origin));
        try {
            const readyTab = tab.status === 'complete' ? tab : await waitForTabReady(tab.id);
            if (parseMusicUrl(readyTab?.url)?.origin !== origin) {
                throw new Error('Temporary retry tab left Yandex Music');
            }
            let released = false;
            return {
                tabId: tab.id,
                temporary: true,
                async release() {
                    if (released) return;
                    released = true;
                    await closeTemporaryTab(tab.id);
                }
            };
        } catch (error) {
            await closeTemporaryTab(tab.id);
            throw error;
        }
    }

    async function acquireRetryTab(job) {
        const preferredOrigin = parseMusicUrl(job.sourceOrigin)?.origin || null;
        const originalTab = await getTabOrNull(job.tabId);
        const readyOriginal = await getReadyMusicTab(originalTab, preferredOrigin);
        if (readyOriginal) {
            return {tabId: readyOriginal.id, temporary: false, release: async () => {}};
        }

        const tabs = await callTabs('query', {});
        for (const tab of tabs || []) {
            const readyTab = await getReadyMusicTab(tab, preferredOrigin);
            if (readyTab) {
                return {tabId: readyTab.id, temporary: false, release: async () => {}};
            }
        }

        return createTemporaryRetryTab(job, preferredOrigin || DEFAULT_MUSIC_ORIGIN);
    }

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
        getMusicTabOrigin, acquireRetryTab, getActiveTab, getCollectionMatch,
        requireCollectionTab, getStateFromTab
    });
})();
