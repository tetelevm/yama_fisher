/**
 * Album-specific collection extractor for the Yandex Music MAIN world.
 */
(() => {
    const config = globalThis.YMF_CONFIG;
    const app = globalThis.yaMaFisher ||= {};

    function getCoverUrl(coverUri) {
        if (!coverUri) return null;
        const size = `${config.coverQuality}x${config.coverQuality}`;
        return `https://${coverUri.replace(/%%/g, size)}`;
    }

    function getArtistName(meta) {
        const artists = meta.artists || meta.artist ? (meta.artists || [meta.artist]) : [];
        return artists.map(artist => artist.name || artist)
            .filter(Boolean)
            .join(', ') || 'Unknown artist';
    }

    async function readAlbum({id, url}) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Album page is unavailable: ${response.status}`);
        const album = app.collectionParsers?.album?.parse(await response.text());
        if (!album) throw new Error('Album parser is unavailable or returned no data');
        const items = Array.isArray(album?.items) ? album.items : Object.values(album?.items || {});
        const tracks = items.filter(item => item?.id !== undefined && item?.id !== null);
        if (!album?.meta || !tracks.length) {
            throw new Error('Could not find album data on the page');
        }

        const {meta} = album;
        let apiTracks = [];
        try {
            apiTracks = await app.fetchAlbumTracks(id);
        } catch (error) {
            console.warn('[YaMa Fisher page] Could not preload album track titles', error);
        }
        const apiTracksById = new Map(apiTracks.map(track => [String(track.id), track]));
        const trackTitles = Object.fromEntries(tracks.flatMap(track => {
            const title = apiTracksById.get(String(track.id))?.title || track.title;
            return typeof title === 'string' && title ? [[String(track.id), title]] : [];
        }));
        return {
            id,
            title: meta.title || 'Untitled',
            subtitle: getArtistName(meta),
            coverUrl: getCoverUrl(meta.coverUri),
            metadata: {year: meta.year || '—', trackTitles},
            entries: tracks.map((track, index) => ({
                trackId: track.id,
                position: index + 1
            }))
        };
    }

    app.registerCollectionSource({type: 'album', read: readAlbum});
})();
