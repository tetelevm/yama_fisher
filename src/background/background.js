/**
 * Background entry point: routes protocol messages to focused services.
 */
(() => {
    const {actions, collectionStateKind} = globalThis.YMF_PROTOCOL;
    const {downloadState, pageBridge, downloadScheduler} = globalThis.YMF_BACKGROUND;
    const stateRequests = new Set([actions.GET_AUTH_STATE, actions.GET_COLLECTION_STATE]);
    const commands = {
        [actions.SET_WORKERS_STOPPED]: message => (
            downloadState.setWorkersStopped(Boolean(message.stopped))
        ),
        [actions.SET_DOWNLOADS_PAUSED]: message => (
            downloadState.setDownloadsPaused(Boolean(message.paused))
        ),
        [actions.SET_COLLECTION_DOWNLOADS_PAUSED]: message => (
            downloadState.setCollectionDownloadsPaused(message.jobId, Boolean(message.paused))
        ),
        [actions.PAUSE_DOWNLOAD]: message => (
            downloadState.controlDownload(message.jobId, message.trackId, 'pause')
        ),
        [actions.RESUME_DOWNLOAD]: message => (
            downloadState.controlDownload(message.jobId, message.trackId, 'resume')
        ),
        [actions.RETRY_DOWNLOAD]: message => (
            downloadScheduler.retryTrack(message.jobId, message.trackId)
        ),
        [actions.RETRY_FAILED_COLLECTION_DOWNLOADS]: message => (
            downloadScheduler.retryFailedTracks(message.jobId)
        ),
        [actions.REMOVE_COMPLETED_TRACK]: message => (
            downloadState.removeCompletedTrack(message.jobId, message.trackId)
        ),
        [actions.REMOVE_COMPLETED_JOB]: message => (
            downloadState.removeCompletedJob(message.jobId)
        ),
        [actions.CANCEL_COLLECTION_DOWNLOADS]: message => (
            downloadScheduler.cancelCollection(message.jobId)
        ),
        [actions.CLEAR_COMPLETED_DOWNLOAD_HISTORY]: () => (
            downloadState.clearCompletedDownloadHistory()
        ),
        [actions.DOWNLOAD_COLLECTION]: message => (
            downloadScheduler.downloadCollection(message.tabId, message.collection)
        )
    };

    function respondWith(promise, sendResponse, errorContext) {
        promise.then(
            () => sendResponse({success: true}),
            error => {
                if (errorContext) console.error(errorContext, error);
                sendResponse({success: false, error: error.message});
            }
        );
        return true;
    }

    // noinspection JSDeprecatedSymbols -- WebExtension events still use addListener.
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action === actions.INJECT_PAGE_TOOLS) {
            const tabId = sender.tab?.id;
            pageBridge.injectPageAuth(tabId)
                .then(() => {
                    if (pageBridge.getCollectionMatch(sender.tab)?.definition.implemented) {
                        return pageBridge.injectCollectionTools(tabId);
                    }
                })
                .catch(error => console.error('Could not inject page scripts:', error));
            return false;
        }

        if (stateRequests.has(message?.action)) {
            pageBridge.getActiveTab(tab => {
                const isCollection = message.action === actions.GET_COLLECTION_STATE;
                const fallback = isCollection
                    ? {
                        kind: collectionStateKind.ERROR,
                        message: 'Switch to a tab with a supported Yandex Music collection.'
                    }
                    : {
                        authorized: false,
                        error: 'Switch to a tab with a supported Yandex Music collection.'
                    };
                if (pageBridge.requireCollectionTab(tab, sendResponse, fallback)) {
                    pageBridge.getStateFromTab(tab.id, message.action, sendResponse);
                }
            });
            return true;
        }

        if (message?.action === actions.OPEN_AUTHORIZATION) {
            chrome.tabs.create({url: message.authorizationUrl});
            return false;
        }

        const command = commands[message?.action];
        return command ? respondWith(
            command(message),
            sendResponse,
            message.action === actions.DOWNLOAD_COLLECTION
                ? '[YaMa Fisher background] download_collection command failed'
                : null
        ) : false;
    });
})();
