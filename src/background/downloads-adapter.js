/**
 * Thin promise-based wrapper around Firefox's chrome.downloads API.
 */
(() => {
    const background = globalThis.YMF_BACKGROUND ||= {};
    const config = globalThis.YMF_CONFIG;
    const listeners = new Set();
    const eraseOnComplete = new Set();

    function handleChanged(delta) {
        const state = delta.state?.current;
        if (eraseOnComplete.has(delta.id) && ['complete', 'interrupted'].includes(state)) {
            eraseOnComplete.delete(delta.id);
            if (state === 'complete') chrome.downloads.erase({id: delta.id});
        }
        listeners.forEach(listener => listener(delta));
    }

    // noinspection JSDeprecatedSymbols -- WebExtension events still use addListener.
    chrome.downloads.onChanged.addListener(handleChanged);

    function call(method, ...args) {
        return new Promise((resolve, reject) => {
            chrome.downloads[method](...args, result => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                resolve(result);
            });
        });
    }

    async function find(downloadId) {
        const items = await call('search', {id: downloadId});
        return items?.[0] || null;
    }

    function control(downloadId, method) {
        return call(method, downloadId);
    }

    function cancellationError(signal) {
        return signal?.reason instanceof Error
            ? signal.reason
            : new Error('Collection download cancelled');
    }

    function throwIfCancelled(signal) {
        if (signal?.aborted) throw cancellationError(signal);
    }

    async function downloadFile(url, filename, onAccepted, signal) {
        let downloadId;
        let cancellationPromise;
        const cancelAcceptedDownload = () => {
            if (!Number.isInteger(downloadId)) return;
            cancellationPromise = control(downloadId, 'cancel').catch(() => {});
        };
        signal?.addEventListener('abort', cancelAcceptedDownload, {once: true});
        try {
            throwIfCancelled(signal);
            downloadId = await call('download', {
                url, filename, saveAs: false, conflictAction: 'overwrite'
            });
            if (signal?.aborted) {
                cancelAcceptedDownload();
                await cancellationPromise;
                throw cancellationError(signal);
            }
        } catch (error) {
            if (!signal?.aborted) {
                console.error('[YaMa Fisher background] Downloads API rejected the file', {
                    filename, error: error.message
                });
            }
            throw error;
        } finally {
            signal?.removeEventListener('abort', cancelAcceptedDownload);
        }
        onAccepted?.(downloadId);
        if (!config.saveHistory) eraseOnComplete.add(downloadId);
        return downloadId;
    }

    background.downloadsAdapter = Object.freeze({
        find,
        control,
        downloadFile,
        onChanged: listener => listeners.add(listener)
    });
})();
