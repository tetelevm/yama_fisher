/**
 * Collection type registry shared by the background, popup, and page MAIN world.
 *
 * Adding a new source requires a URL matcher and popup presenter here, plus a
 * page extractor that registers itself through yaMaFisher.registerCollectionSource.
 */
(() => {
    const MUSIC_HOST_PATTERN = /^music\.yandex\.(?:ru|com|kz|by|uz)$/;

    function normalizeEntry(entry, index) {
        const source = entry && typeof entry === 'object' ? entry : {trackId: entry};
        const trackId = source.trackId ?? source.id;
        if (trackId === undefined || trackId === null || trackId === '') return null;
        const position = Number(source.position);
        const normalizedEntry = {
            trackId: String(trackId),
            position: Number.isInteger(position) && position > 0 ? position : index + 1
        };
        if (source.albumId !== undefined && source.albumId !== null && source.albumId !== '') {
            normalizedEntry.albumId = String(source.albumId);
        }
        return normalizedEntry;
    }

    function normalizeCollection(type, collection, fallbackId) {
        if (!collection || typeof collection !== 'object') return null;
        const entries = (Array.isArray(collection.entries) ? collection.entries : [])
            .map(normalizeEntry)
            .filter(Boolean);
        if (!entries.length) return null;

        const metadata = collection.metadata && typeof collection.metadata === 'object'
            ? {...collection.metadata}
            : {};
        return {
            type,
            id: String(collection.id ?? fallbackId ?? ''),
            title: collection.title || 'Untitled',
            subtitle: collection.subtitle || '',
            coverUrl: collection.coverUrl || null,
            metadata,
            entries
        };
    }

    function matchPath(url, pattern, mapMatch = match => ({id: match[1]})) {
        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.protocol !== 'https:'
                || !MUSIC_HOST_PATTERN.test(parsedUrl.hostname)) return null;
            const match = parsedUrl.pathname.match(pattern);
            return match ? mapMatch(match) : null;
        } catch {
            return null;
        }
    }

    function unsupportedDefinition(type, pattern, errorTitle, mapMatch) {
        return Object.freeze({
            type,
            implemented: false,
            matchUrl: url => matchPath(url, pattern, mapMatch),
            errorTitle,
            unavailableMessage: 'This is not implemented in the current version.'
        });
    }

    const definitions = Object.freeze({
        album: Object.freeze({
            type: 'album',
            implemented: true,
            pageScripts: ['src/page/album-parser.js', 'src/page/album.js'],
            matchUrl: url => matchPath(url, /^\/album\/(\d+)\/?$/),
            present(collection) {
                const trackCount = collection.entries.length;
                return {
                    eyebrow: 'Album',
                    title: collection.title || 'Untitled',
                    subtitle: collection.subtitle || 'Unknown artist',
                    meta: `${trackCount} ${trackCount === 1 ? 'track' : 'tracks'} · `
                        + (collection.metadata.year || '—'),
                    downloadLabel: 'Download album',
                    coverLabel: `Album cover: ${collection.title || 'Untitled'}`
                };
            }
        }),
        playlist: Object.freeze({
            type: 'playlist',
            implemented: true,
            pageScripts: ['src/page/playlist.js'],
            matchUrl: url => matchPath(
                url,
                /^\/playlists\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/?$/i
            ),
            present(collection) {
                const trackCount = collection.entries.length;
                return {
                    eyebrow: 'Playlist',
                    title: collection.title || 'Untitled',
                    subtitle: '',
                    meta: `${trackCount} ${trackCount === 1 ? 'track' : 'tracks'}`,
                    downloadLabel: 'Download playlist',
                    coverLabel: `Playlist cover: ${collection.title || 'Untitled'}`
                };
            }
        }),
        artist: unsupportedDefinition('artist', /^\/artist\/(\d+)\/?$/, 'Could not load artist'),
        track: Object.freeze({
            type: 'track',
            implemented: true,
            pageScripts: ['src/page/track.js'],
            matchUrl: url => matchPath(
                url,
                /^\/album\/(\d+)\/track\/(\d+)\/?$/,
                match => ({id: match[2], albumId: match[1]})
            ),
            present(collection) {
                return {
                    eyebrow: 'Track',
                    title: collection.title || 'Untitled',
                    subtitle: collection.subtitle || 'Unknown artist',
                    meta: '1 track',
                    downloadLabel: 'Download track',
                    coverLabel: `Track cover: ${collection.title || 'Untitled'}`
                };
            }
        }),
        'artist-top-tracks': Object.freeze({
            type: 'artist-top-tracks',
            implemented: true,
            pageScripts: ['src/page/artist-top-tracks.js'],
            matchUrl: url => matchPath(url, /^\/artist\/(\d+)\/tracks\/?$/),
            present(collection) {
                const trackCount = collection.entries.length;
                return {
                    eyebrow: 'Artist',
                    title: collection.title || 'Untitled',
                    subtitle: collection.subtitle || 'Unknown artist',
                    meta: `${trackCount} ${trackCount === 1 ? 'track' : 'tracks'}`,
                    downloadLabel: 'Download top tracks',
                    coverLabel: `Artist cover: ${collection.subtitle || 'Unknown artist'}`
                };
            }
        })
    });

    globalThis.YMF_COLLECTION_TYPES = Object.freeze({
        get(type) {
            return definitions[type] || null;
        },
        getPageScripts() {
            return Object.values(definitions).flatMap(definition => definition.pageScripts || []);
        },
        normalize(type, collection, fallbackId) {
            return definitions[type] ? normalizeCollection(type, collection, fallbackId) : null;
        },
        match(url) {
            for (const definition of Object.values(definitions)) {
                const match = definition.matchUrl(url);
                if (match) return {definition, ...match};
            }
            return null;
        }
    });
})();
