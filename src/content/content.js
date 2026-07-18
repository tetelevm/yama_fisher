/**
 * Connects the MAIN world and background. The OAuth token never leaves the page:
 * the extension receives only the authorization state and sign-in URL.
 */
(() => {
    const {actions, events, collectionStateKind} = globalThis.YMF_PROTOCOL;
    function getAuthState() {
        const storageKey = document.documentElement.dataset.yamaFisherAuthStorageKey;
        const authorizationUrl = document.documentElement.dataset.yamaFisherAuthorizationUrl;
        if (!storageKey || !authorizationUrl) {
            return {loading: true};
        }
        try {
            const token = JSON.parse(localStorage.getItem(storageKey) || 'null');
            return {authorized: Boolean(token?.access_token), authorizationUrl};
        } catch {
            return {authorized: false, authorizationUrl};
        }
    }

    function getCollectionState() {
        const storageKey = document.documentElement.dataset.yamaFisherCollectionStorageKey;
        if (!storageKey) return {kind: collectionStateKind.LOADING};
        try {
            const rawState = localStorage.getItem(storageKey);
            return rawState ? JSON.parse(rawState) : {kind: collectionStateKind.LOADING};
        } catch {
            return {
                kind: collectionStateKind.ERROR,
                message: 'Collection data is corrupted. Reload the page.'
            };
        }
    }

    const requests = {
        [actions.GET_AUTH_STATE]: ['yamaFisherAuthStorageKey', getAuthState],
        [actions.GET_COLLECTION_STATE]: ['yamaFisherCollectionStorageKey', getCollectionState]
    };
    const reporters = [
        [events.AUTH_STATE_CHANGED, actions.AUTH_STATE_CHANGED, getAuthState],
        [events.COLLECTION_STATE_CHANGED, actions.COLLECTION_STATE_CHANGED, getCollectionState]
    ];
    reporters.forEach(([event, action, getState]) => {
        window.addEventListener(event, () => {
            chrome.runtime.sendMessage({action, state: getState()});
        });
    });
    // noinspection JSDeprecatedSymbols -- WebExtension events still use addListener.
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const [datasetKey, getState] = requests[message?.action] || [];
        if (!getState) return false;
        const respond = () => sendResponse(getState());
        document.documentElement.dataset[datasetKey] ? respond() : window.setTimeout(respond, 100);
        return true;
    });

    chrome.runtime.sendMessage({action: actions.INJECT_PAGE_TOOLS});
    reporters.forEach(([, action, getState]) => {
        chrome.runtime.sendMessage({action, state: getState()});
    });
})();
