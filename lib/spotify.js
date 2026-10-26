// Spotify Web API: search/metadata only (Client Credentials flow, no user
// login, no playback). Used purely as a content-prep helper for the Host
// to look up exact titles/artists/URIs while filling data/tracks.json.
// Entirely optional: if no credentials are configured, callers get a
// clear 'not_configured' error instead of the game breaking.
const fs = require('fs');
const path = require('path');

const CRED_FILE = path.join(__dirname, '..', 'data', 'spotify.json');

function getCredentials() {
  let clientId = process.env.SPOTIFY_CLIENT_ID || '';
  let clientSecret = process.env.SPOTIFY_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    try {
      const raw = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
      clientId = clientId || raw.clientId || '';
      clientSecret = clientSecret || raw.clientSecret || '';
    } catch (e) { /* file missing/invalid -> stays unconfigured */ }
  }
  return { clientId, clientSecret };
}

function isConfigured() {
  const c = getCredentials();
  return !!(c.clientId && c.clientSecret);
}

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const { clientId, clientSecret } = getCredentials();
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error('Spotify non configuré (data/spotify.json vide).'), { code: 'not_configured' });
  }
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 5000) return tokenCache.token;

  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error('Auth Spotify refusée (' + res.status + '), vérifiez clientId/clientSecret. ' + text), { code: 'auth_error' });
  }
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

function normalize(item) {
  const images = (item.album && item.album.images) || [];
  return {
    id: item.id,
    uri: item.uri,
    title: item.name,
    artist: (item.artists || []).map(a => a.name).join(', '),
    album: item.album ? item.album.name : '',
    albumArt: images.length ? images[images.length - 1].url : '',
    durationMs: item.duration_ms,
    externalUrl: item.external_urls ? item.external_urls.spotify : null
  };
}

async function searchTracks(query, limit) {
  const token = await getAccessToken();
  const url = 'https://api.spotify.com/v1/search?type=track&limit=' + (limit || 8) + '&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error('Recherche Spotify échouée (' + res.status + '). ' + text), { code: 'search_error' });
  }
  const data = await res.json();
  return ((data.tracks && data.tracks.items) || []).map(normalize);
}

// Cover art for a single known track (DÉTECTIVE D'ALBUM reveal on
// screen.html). Cached in memory by track id since the same track can be
// revealed to a full room repeatedly over a night and this only needs to
// ever be fetched once per track per server run.
const albumArtCache = new Map();
function trackIdFromUri(uri) {
  const m = /^spotify:track:([A-Za-z0-9]+)$/.exec(String(uri || '').trim());
  return m ? m[1] : null;
}
async function getAlbumArt(spotifyUri) {
  const id = trackIdFromUri(spotifyUri);
  if (!id) return '';
  if (albumArtCache.has(id)) return albumArtCache.get(id);
  const token = await getAccessToken();
  const res = await fetch('https://api.spotify.com/v1/tracks/' + id, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) { albumArtCache.set(id, ''); return ''; }
  const data = await res.json();
  const images = (data.album && data.album.images) || [];
  // Middle size (typically 300x300) when Spotify offers one: plenty sharp
  // on a TV without pulling the full 640x640 for what's a few seconds on
  // screen; the largest available otherwise.
  const art = (images[1] || images[0] || {}).url || '';
  albumArtCache.set(id, art);
  return art;
}

module.exports = { isConfigured, searchTracks, getAlbumArt, getCredentials };
