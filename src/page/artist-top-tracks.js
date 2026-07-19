/**
 * Artist top-tracks collection extractor for the Yandex Music MAIN world.
 */
(() => {
    const config = globalThis.YMF_CONFIG;
    const app = globalThis.yaMaFisher ||= {};

    function getTopTracksCount() {
        return Math.max(1, Math.floor(Number(config.artistTopTracksCount) || 10));
    }

    function getArtistName(artist, tracks) {
        return artist?.name
            || tracks[0]?.artists?.map(item => item.name).filter(Boolean).join(', ')
            || 'Unknown artist';
    }

    function getCoverUrl(artist) {
        const coverUri = artist?.cover?.uri || artist?.coverUri;
        if (!coverUri) return null;
        const size = `${config.coverQuality}x${config.coverQuality}`;
        return `https://${coverUri.replace(/%%/g, size)}`;
    }

    async function readArtistTopTracks({id}) {
        const [{artist: topArtist, tracks}, artist] = await Promise.all([
            app.fetchArtistTopTracks(id),
            app.fetchArtistMetadata(id).catch(() => null)
        ]);
        const trackCount = getTopTracksCount();
        const topTracks = tracks.filter(track => track?.id != null).slice(0, trackCount);
        if (!topTracks.length) throw new Error('This artist has no available top tracks');

        const artistData = topArtist || artist;
        const artistName = getArtistName(artistData, topTracks);
        const trackTitles = Object.fromEntries(topTracks.map(track => [
            String(track.id), track.title || `Track ${track.id}`
        ]));
        const collection = {
            id,
            title: `${artistName} - TOP ${trackCount}`,
            subtitle: artistName,
            coverUrl: getCoverUrl(artistData),
            metadata: {topTracksCount: trackCount, trackTitles},
            entries: topTracks.map((track, index) => ({
                trackId: track.id,
                position: index + 1
            }))
        };
        return collection;
    }

    app.registerCollectionSource({type: 'artist-top-tracks', read: readArtistTopTracks});
})();
