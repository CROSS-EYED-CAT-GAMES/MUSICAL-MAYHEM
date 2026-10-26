// MusicSource abstraction: separates the game engine from how a track
// actually gets played. `ManualMusicSource` is the fallback: the host
// plays the track themselves (their own Spotify app, or a local file via
// the existing audio panel), so the game stays 100% playable with zero
// external dependency. `SpotifyMusicSource` is the real one: once the
// host has connected their Premium account (lib/spotifyAuth.js) and the
// Screen tab has registered itself as a Spotify Connect device (via the
// Web Playback SDK, see public/js/screen.js), getMusicSource() switches
// to it automatically and every call below drives real playback through
// the Spotify Connect REST API. Every call returns a uniform
// `{ok, mode, ...}` shape so a caller never needs to know which source is
// behind it, and losing the connection just degrades back to manual.
const spotifyAuth = require('./spotifyAuth');

class ManualMusicSource {
  constructor() { this.mode = 'manual'; }
  describe(track) {
    return {
      mode: 'manual',
      spotifyUri: (track && track.spotifyUri) || '',
      audioRef: (track && track.audioRef) || '',
      title: (track && track.title) || '',
      artist: (track && track.artist) || ''
    };
  }
  async play() { return { ok: true, mode: 'manual' }; }
  async pause() { return { ok: true, mode: 'manual' }; }
  async resume() { return { ok: true, mode: 'manual' }; }
  async seek() { return { ok: true, mode: 'manual' }; }
  async stop() { return { ok: true, mode: 'manual' }; }
  async getCurrentPosition() { return { ok: true, mode: 'manual', positionMs: null }; }
}

let activeDeviceId = null;
function setActiveDeviceId(id) { activeDeviceId = id || null; }
function getActiveDeviceId() { return activeDeviceId; }

// Until now, activeDeviceId only ever got cleared reactively: a real play/
// pause call 404ing, or the Screen tab itself telling us via 'not_ready'.
// Between an actual Connect-session drop and one of those, the Host panel
// kept reporting "Écran : prêt" and every ▶ press quietly took the
// ManualMusicSource no-op path (getMusicSource() below only hands out
// SpotifyMusicSource while activeDeviceId is set) — "ça marche" with zero
// sound and no error, which is what made this read as an intermittent,
// hard-to-pin-down bug rather than a clear failure. Polling Spotify's own
// device list lets the server notice a dead device on its own, independent
// of anyone actually trying to play something or the Screen tab noticing.
async function verifyActiveDevice() {
  if (!activeDeviceId) return;
  try {
    const token = await spotifyAuth.getValidAccessToken();
    const res = await fetch('https://api.spotify.com/v1/me/player/devices', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return; // transient (rate limit, network hiccup): leave it, retry next tick rather than clear on a fluke
    const data = await res.json();
    const stillThere = (data.devices || []).some(d => d.id === activeDeviceId);
    if (!stillThere) {
      console.error('Spotify device check: "Musical Mayhem · Écran" is no longer in Spotify\'s device list, clearing it (Host panel will show "not ready" on its next poll).');
      activeDeviceId = null;
    }
  } catch (e) { /* transient: leave activeDeviceId as-is, retry next tick */ }
}

class SpotifyMusicSource {
  constructor() { this.mode = 'spotify'; }
  describe(track) {
    return {
      mode: 'spotify',
      spotifyUri: (track && track.spotifyUri) || '',
      audioRef: (track && track.audioRef) || '',
      title: (track && track.title) || '',
      artist: (track && track.artist) || ''
    };
  }
  async _call(method, urlPath, body) {
    if (!activeDeviceId) throw Object.assign(new Error('Aucun écran connecté comme appareil Spotify.'), { code: 'no_device' });
    const token = await spotifyAuth.getValidAccessToken();
    const sep = urlPath.includes('?') ? '&' : '?';
    const url = 'https://api.spotify.com/v1' + urlPath + sep + 'device_id=' + encodeURIComponent(activeDeviceId);
    const res = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => '');
      if (res.status === 404) {
        // Spotify no longer recognizes this device (Screen tab reloaded,
        // backgrounded long enough for the browser to throttle it, or a
        // network hiccup dropped the Connect session). Drop it now rather
        // than leaving deviceReady stuck on a stale "true" that would
        // keep silently failing every play/pause call until someone
        // happens to reload screen.html.
        activeDeviceId = null;
      }
      throw Object.assign(new Error('Commande de lecture Spotify refusée (' + res.status + '). ' + text), { code: 'playback_error', deviceLost: res.status === 404 });
    }
  }
  async play(track, opts) {
    opts = opts || {};
    if (!track || !track.spotifyUri) return { ok: false, mode: 'spotify', error: 'no_uri' };
    await this._call('PUT', '/me/player/play', { uris: [track.spotifyUri], position_ms: opts.positionMs || 0 });
    return { ok: true, mode: 'spotify' };
  }
  async pause() { await this._call('PUT', '/me/player/pause'); return { ok: true, mode: 'spotify' }; }
  async resume() { await this._call('PUT', '/me/player/play'); return { ok: true, mode: 'spotify' }; }
  async seek(positionMs) { await this._call('PUT', '/me/player/seek?position_ms=' + Math.max(0, Math.round(positionMs))); return { ok: true, mode: 'spotify' }; }
  async stop() { return this.pause(); }
  async getCurrentPosition() {
    if (!activeDeviceId) return { ok: false, mode: 'spotify', positionMs: null };
    const token = await spotifyAuth.getValidAccessToken();
    const res = await fetch('https://api.spotify.com/v1/me/player', { headers: { Authorization: 'Bearer ' + token } });
    // 204 legitimately means "nothing playing right now", not an error.
    // Anything else non-ok (429 rate limit, 401, 5xx...) used to be
    // treated the same silent way, which is exactly how a resume-position
    // fetch could keep failing with zero visible symptom.
    if (res.status === 204) return { ok: true, mode: 'spotify', positionMs: null };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error('Lecture de la position Spotify refusée (' + res.status + '). ' + text), { code: 'position_error' });
    }
    const data = await res.json();
    return { ok: true, mode: 'spotify', positionMs: data.progress_ms || 0 };
  }
}

const manualSource = new ManualMusicSource();
const spotifySource = new SpotifyMusicSource();

// Only hands out the Spotify source once BOTH the host is connected AND a
// Screen tab has actually registered a device, otherwise every play/
// pause call would immediately fail with 'no_device'/'not_authorized'.
function getMusicSource() {
  return (spotifyAuth.isAuthorized() && activeDeviceId) ? spotifySource : manualSource;
}

module.exports = { ManualMusicSource, SpotifyMusicSource, getMusicSource, setActiveDeviceId, getActiveDeviceId, verifyActiveDevice };
