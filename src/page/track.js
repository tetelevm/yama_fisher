/**
 * Single-track collection extractor for the Yandex Music MAIN world.
 */
(() => {
    const config = globalThis.YMF_CONFIG;
    const app = globalThis.yaMaFisher ||= {};

    function getArtistName(track) {
        return track.artists?.map(artist => artist.name).filter(Boolean).join(', ')
            || 'Unknown artist';
    }

    function getAlbum(track, albumId) {
        return track.albums?.find(album => String(album.id) === String(albumId))
            || track.albums?.[0]
            || {};
    }

    function getCoverUrl(track, albumId) {
        const coverUri = getAlbum(track, albumId).coverUri;
        if (!coverUri) return null;
        const size = `${config.coverQuality}x${config.coverQuality}`;
        return `https://${coverUri.replace(/%%/g, size)}`;
    }

    async function readTrack({id, albumId}) {
        const track = await app.fetchTrackMetadata(id, albumId);
        if (!track) throw new Error('Could not find track data');
        return {
            id,
            title: track.title || 'Untitled',
            subtitle: getArtistName(track),
            coverUrl: getCoverUrl(track, albumId),
            metadata: {
                albumId: String(albumId),
                trackTitles: {[String(id)]: track.title || 'Untitled'}
            },
            entries: [{trackId: id, position: 1}]
        };
    }

    app.registerCollectionSource({type: 'track', read: readTrack});
})();
