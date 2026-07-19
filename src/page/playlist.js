/**
 * Playlist collection extractor for the Yandex Music MAIN world.
 */
(() => {
    const config = globalThis.YMF_CONFIG;
    const app = globalThis.yaMaFisher ||= {};

    function getCoverUrl(playlist) {
        const coverUri = playlist?.cover?.uri
            || playlist?.cover?.itemsUri?.[0]
            || playlist?.coverUri;
        if (!coverUri) return null;
        const size = `${config.coverQuality}x${config.coverQuality}`;
        return `https://${coverUri.replace(/%%/g, size)}`;
    }

    function getTrackData(item) {
        const track = item?.track || item;
        const trackId = item?.id ?? track?.id;
        const albumId = item?.albumId ?? track?.albums?.[0]?.id;
        return {track, trackId, albumId};
    }

    async function readPlaylist({id}) {
        const playlist = await app.fetchPlaylist(id);
        const items = (Array.isArray(playlist?.tracks) ? playlist.tracks : [])
            .map(getTrackData)
            .filter(item => item.trackId != null);
        if (!playlist || !items.length) {
            throw new Error('Could not find playlist data or tracks');
        }

        let metadataTracks = [];
        if (items.some(item => !item.track?.title)) {
            try {
                metadataTracks = await app.fetchTracksMetadata(items);
            } catch (error) {
                console.warn('[YaMa Fisher page] Could not preload playlist track titles', error);
            }
        }
        const metadataById = new Map(
            metadataTracks.map(track => [String(track.id).split(':')[0], track])
        );
        const trackTitles = Object.fromEntries(items.flatMap(({track, trackId}) => (
            track?.title || metadataById.get(String(trackId))?.title
                ? [[String(trackId), track?.title || metadataById.get(String(trackId)).title]]
                : []
        )));
        return {
            id,
            title: playlist.title || 'Untitled',
            subtitle: '',
            coverUrl: getCoverUrl(playlist),
            metadata: {trackTitles},
            entries: items.map(({trackId, albumId}, index) => ({
                trackId,
                albumId,
                position: index + 1
            }))
        };
    }

    app.registerCollectionSource({type: 'playlist', read: readPlaylist});
})();
