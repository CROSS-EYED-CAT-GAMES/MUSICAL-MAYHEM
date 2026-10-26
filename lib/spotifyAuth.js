// Spotify USER login (Authorization Code flow), separate from
// lib/spotify.js's Client Credentials search, which never needs a user.
// This one exists for a single purpose: let the Screen tab become a
// controllable Spotify Connect device via the Web Playback SDK, and let
// the server drive play/pause/seek on it through the Connect REST API.
// Requires the host's Spotify Premium account (Spotify 403s playback
// otherwise). If never connected, lib/musicSource.js falls back to the
// manual source and the game plays exactly as it did before this file
// existed, nothing breaks.
//
// This server runs locally on the host's machine, so the client secret
// stays server-side (a "confidential client" in OAuth terms), no need
// for PKCE. The exchange/refresh calls mirror lib/spotify.js's Basic-auth
// pattern.
const fs = require('fs');
const path = require('path');
const spotify = require('./spotify');

const TOKEN_FILE = path.join(__dirname, '..', 'data', 'spotify-token.json');
const SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';

const pendingStates = new Map(); // csrf state -> expiry ms

let cache = null; // { refreshToken, accessToken, expiresAt } once loaded

function loadToken() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {
    cache = null;
  }
  return cache;
}

function saveToken(data) {
  cache = data;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

function isAuthorized() {
  const t = loadToken();
  return !!(t && t.refreshToken);
}

function disconnect() {
  cache = { refreshToken: null, accessToken: null, expiresAt: 0 };
  try { fs.unlinkSync(TOKEN_FILE); } catch (e) { /* already gone */ }
}

function buildAuthorizeUrl(redirectUri) {
  const { clientId } = spotify.getCredentials();
  if (!clientId) throw Object.assign(new Error('Spotify non configuré (data/spotify.json vide).'), { code: 'not_configured' });
  const state = require('crypto').randomBytes(12).toString('hex');
  pendingStates.set(state, Date.now() + 5 * 60 * 1000);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state
  });
  return 'https://accounts.spotify.com/authorize?' + params.toString();
}

function consumeState(state) {
  const expiry = pendingStates.get(state);
  pendingStates.delete(state);
  return !!expiry && Date.now() < expiry;
}

async function handleCallback(code, state, redirectUri) {
  if (!consumeState(state)) {
    throw Object.assign(new Error('État OAuth invalide ou expiré.'), { code: 'bad_state' });
  }
  const { clientId, clientSecret } = spotify.getCredentials();
  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error('Échange du code Spotify refusé (' + res.status + '). ' + text), { code: 'auth_error' });
  }
  const data = await res.json();
  saveToken({
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000
  });
}

async function refresh() {
  const t = loadToken();
  if (!t || !t.refreshToken) {
    throw Object.assign(new Error('Spotify non connecté : utilisez "Connecter Spotify" côté host.'), { code: 'not_authorized' });
  }
  const { clientId, clientSecret } = spotify.getCredentials();
  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken }).toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error('Rafraîchissement du token Spotify échoué (' + res.status + '). ' + text), { code: 'auth_error' });
  }
  const data = await res.json();
  saveToken({
    refreshToken: data.refresh_token || t.refreshToken,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000
  });
  return cache.accessToken;
}

async function getValidAccessToken() {
  const t = loadToken();
  if (!t || !t.refreshToken) {
    throw Object.assign(new Error('Spotify non connecté : utilisez "Connecter Spotify" côté host.'), { code: 'not_authorized' });
  }
  if (t.accessToken && Date.now() < t.expiresAt - 10000) return t.accessToken;
  return refresh();
}

module.exports = { isAuthorized, disconnect, buildAuthorizeUrl, handleCallback, getValidAccessToken };
