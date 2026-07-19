/**
 * Retrieves album metadata and temporary track URLs in the Yandex Music MAIN world.
 * The MP3 with ID3 tags is created in the extension background context.
 */
(() => {
    const config = globalThis.YMF_CONFIG;
    const {auth, api} = globalThis.YMF_PAGE_CONSTANTS;
    const app = globalThis.yaMaFisher ||= {};
    const albumTracksCache = new Map();

    async function generateSign(data) {
        const encoder = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            encoder.encode(api.fileInfoSignatureKey),
            {name: 'HMAC', hash: 'SHA-256'},
            false,
            ['sign']
        );
        const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
        return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=+$/, '');
    }

    function getToken() {
        const rawToken = localStorage.getItem(auth.storageKey);
        if (!rawToken) throw new Error('Yandex Music authorization is required');
        try {
            const token = JSON.parse(rawToken);
            if (!token.access_token) throw new Error('OAuth token has no access_token');
            return token;
        } catch (error) {
            if (error instanceof SyntaxError) {
                throw new Error('OAuth token is corrupted');
            }
            throw error;
        }
    }

    function getApiHeaders() {
        return {
            Authorization: `OAuth ${getToken().access_token}`,
            'X-Yandex-Music-Client': 'YandexMusicDesktopAppWindows/2'
        };
    }

    function fetchAlbumTracks(albumId) {
        const id = String(albumId);
        if (!albumTracksCache.has(id)) {
            const request = fetch(`${api.origin}albums/${id}/with-tracks`, {
                headers: getApiHeaders()
            }).then(async response => {
                if (!response.ok) {
                    throw new Error(`Album metadata API error: ${response.status}`);
                }
                const payload = await response.json();
                return payload.result?.volumes?.flat() || [];
            }).catch(error => {
                albumTracksCache.delete(id);
                throw error;
            });
            albumTracksCache.set(id, request);
        }
        return albumTracksCache.get(id);
    }

    async function fetchTrackInfo(trackId, albumId, headers) {
        if (albumId) {
            try {
                const albumTracks = await fetchAlbumTracks(albumId);
                const albumTrack = albumTracks.find(track => String(track.id) === trackId);
                if (albumTrack) return albumTrack;
            } catch (error) {
                console.warn('[YaMa Fisher page] Could not use album-specific track data', error);
            }
        }
        const contextualId = albumId ? `${trackId}:${albumId}` : trackId;
        const params = new URLSearchParams({trackIds: contextualId});
        const response = await fetch(`${api.origin}tracks?${params}`, {headers});
        if (!response.ok) throw new Error(`Track metadata API error: ${response.status}`);
        return (await response.json()).result?.[0];
    }

    function fetchTrackMetadata(trackId, albumId) {
        return fetchTrackInfo(String(trackId), albumId, getApiHeaders());
    }

    async function fetchTrackForDownload(trackId, albumId) {
        try {
            const plainTrackId = String(trackId).split(':')[0];
            const timestamp = Math.floor(Date.now() / 1000);
            const quality = config.audioQuality;
            const sign = await generateSign(`${timestamp}${plainTrackId}${quality}flacraw`);
            const params = new URLSearchParams({
                ts: timestamp,
                trackId: plainTrackId,
                quality,
                codecs: 'flac',
                transports: 'raw',
                sign
            });
            const headers = getApiHeaders();
            const [fileInfoResponse, trackinfo] = await Promise.all([
                fetch(`${api.origin}get-file-info?${params}`, {headers}),
                fetchTrackInfo(plainTrackId, albumId, headers)
            ]);
            if (!fileInfoResponse.ok) {
                throw new Error(`File info API error: ${fileInfoResponse.status}`);
            }

            const fileInfo = await fileInfoResponse.json();
            const audioUrl = fileInfo.result?.downloadInfo?.url;
            if (!trackinfo || !audioUrl) {
                throw new Error(`Could not retrieve track file ${trackId}`);
            }

            return JSON.stringify({download: audioUrl, trackinfo});
        } catch (error) {
            console.error('[YaMa Fisher page] Could not prepare track', {
                trackId, error: error.message, stack: error.stack
            });
            throw error;
        }
    }

    app.fetchAlbumTracks = fetchAlbumTracks;
    app.fetchTrackMetadata = fetchTrackMetadata;
    app.fetchTrackForDownload = fetchTrackForDownload;
})();
