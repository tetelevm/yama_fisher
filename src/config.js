/**
 * Persistent extension settings.
 *
 * Change values in this file and reload the extension in Firefox.
 * These settings are not stored in the browser and have no dedicated page.
 */
globalThis.YMF_CONFIG = Object.freeze({
    // Cover size for the popup and the image embedded in audio files.
    coverQuality: 600,

    // Quality requested from Yandex Music: lq, nq, or lossless.
    audioQuality: 'lossless',

    // Number of tracks to download at once.
    downloadCount: 4,

    // Track directory template based on its album metadata.
    // Available placeholders: %genre%, %year%, %artist%, %album%.
    downloadFolder: 'music/%artist%/%year% %album%',

    // Add the track number to each filename.
    numberingTracks: true,

    // Keep completed downloads in the Firefox download manager.
    saveHistory: true,
});
