// Verifies lib/spotify.js's token handling, response normalization, and
// error propagation against realistic Spotify API response shapes,
// without needing real credentials or network access.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const credFile = path.join(__dirname, '..', 'data', 'spotify.json');
// null when there's no local spotify.json (fresh clone): restore = delete.
const backup = fs.existsSync(credFile) ? fs.readFileSync(credFile, 'utf8') : null;
function restoreCreds() { if (backup === null) fs.rmSync(credFile, { force: true }); else restoreCreds(); }
fs.writeFileSync(credFile, JSON.stringify({ clientId: 'fake-id', clientSecret: 'fake-secret' }));

let failures = 0;
function ok(cond, msg) { if (!cond) { console.error('FAIL:', msg); failures++; } else console.log('ok  :', msg); }

const originalFetch = global.fetch;
let tokenCalls = 0;

global.fetch = async (url, opts) => {
  if (String(url).includes('accounts.spotify.com/api/token')) {
    tokenCalls++;
    return { ok: true, json: async () => ({ access_token: 'tok_' + tokenCalls, expires_in: 3600 }) };
  }
  if (String(url).includes('api.spotify.com/v1/search')) {
    return {
      ok: true,
      json: async () => ({
        tracks: {
          items: [
            {
              id: '1a2b3c', uri: 'spotify:track:1a2b3c', name: 'I Will Survive',
              artists: [{ name: 'Gloria Gaynor' }],
              album: { name: 'Love Tracks', images: [{ url: 'big.jpg' }, { url: 'small.jpg' }] },
              duration_ms: 198000,
              external_urls: { spotify: 'https://open.spotify.com/track/1a2b3c' }
            }
          ]
        }
      })
    };
  }
  throw new Error('unexpected fetch: ' + url);
};

(async () => {
  delete require.cache[require.resolve('../lib/spotify')];
  const spotify = require('../lib/spotify');

  ok(spotify.isConfigured(), 'reports configured once data/spotify.json has creds');

  const results = await spotify.searchTracks('I will survive');
  ok(Array.isArray(results) && results.length === 1, 'search returns normalized array');
  const t = results[0];
  ok(t.title === 'I Will Survive', 'title mapped from name');
  ok(t.artist === 'Gloria Gaynor', 'artist joined from artists[]');
  ok(t.uri === 'spotify:track:1a2b3c', 'uri passed through (for spotify_uri field)');
  ok(t.albumArt === 'small.jpg', 'albumArt picks smallest image for thumbnail');
  ok(t.durationMs === 198000, 'durationMs mapped');

  // second search should reuse the cached token, not fetch a new one
  await spotify.searchTracks('another query');
  ok(tokenCalls === 1, 'access token is cached across searches, not refetched');

  // error path: search endpoint returns non-ok
  global.fetch = async (url) => {
    if (String(url).includes('accounts.spotify.com')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    return { ok: false, status: 429, text: async () => 'rate limited' };
  };
  delete require.cache[require.resolve('../lib/spotify')];
  const spotify2 = require('../lib/spotify');
  try {
    await spotify2.searchTracks('x');
    ok(false, 'should have thrown on non-ok search response');
  } catch (e) {
    ok(e.code === 'search_error', 'search error carries a code for the HTTP layer to report');
  }

  console.log(failures === 0 ? '\nALL SPOTIFY MOCK CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  global.fetch = originalFetch;
  restoreCreds();
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => {
  console.error(e);
  restoreCreds();
  process.exit(1);
});
