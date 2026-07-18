/**
 * Runs in the Yandex Music page's MAIN world.
 * The token remains in the website's localStorage and is not passed to the extension.
 */
(() => {
    const {auth} = globalThis.YMF_PAGE_CONSTANTS;
    const {events} = globalThis.YMF_PROTOCOL;

    function notifyState() {
        window.dispatchEvent(new Event(events.AUTH_STATE_CHANGED));
    }

    const root = document.documentElement;
    root.dataset.yamaFisherAuthStorageKey = auth.storageKey;
    const authParams = new URLSearchParams({
        response_type: 'token', client_id: auth.clientId, redirect_uri: auth.redirectUri
    });
    root.dataset.yamaFisherAuthorizationUrl = `${auth.authorizationOrigin}/authorize?${authParams}`;

    function saveTokenFromRedirect() {
        if (window.location.pathname !== '/oauth' || !window.location.hash) return false;

        const token = Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)));
        if (!token.access_token) return false;

        localStorage.setItem(auth.storageKey, JSON.stringify(token));
        notifyState();
        window.location.replace(new URL('/', window.location.origin));
    }

    saveTokenFromRedirect();
    notifyState();
})();
