/**
 * Internal Yandex Music protocol constants.
 * These are not user settings: changing these values arbitrarily
 * will break authorization or file retrieval.
 */
globalThis.YMF_PAGE_CONSTANTS = Object.freeze({
    auth: Object.freeze({
        // OAuth application ID — a required hardcoded value.
        clientId: '97fe03033fa34407ac9bcf91d5afed5b',
        authorizationOrigin: 'https://oauth.yandex.ru',
        redirectUri: 'https://music.yandex.ru/oauth',
        storageKey: 'yaMaFisher.token'
    }),

    api: Object.freeze({
        origin: 'https://api.music.yandex.ru/',
        // File download request signing key — a required hardcoded value.
        fileInfoSignatureKey: 'kzqU4XhfCaY6B6JTHODeq5'
    })
});
