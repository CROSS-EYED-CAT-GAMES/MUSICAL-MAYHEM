const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const store = require('./lib/store');
const views = require('./lib/views');
const actions = require('./lib/actions');
const spotify = require('./lib/spotify');
const spotifyAuth = require('./lib/spotifyAuth');
const musicSource = require('./lib/musicSource');

const PORT = process.env.PORT || store.config.port || 8080;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MEDIA_DIR = path.join(ROOT, 'media');
// Spotify requires an exact-match redirect URI, registered in the app's
// dashboard settings. Their current policy requires the loopback literal
// "127.0.0.1" rather than "localhost" for non-HTTPS redirects.
const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:' + PORT + '/auth/spotify/callback';

// The QR code (and the console hint below) must point phones at the LAN
// IP, never at whatever host the requesting browser happens to be using.
// Screen.html itself is often opened via "localhost" (Spotify's Web
// Playback SDK requires it, see README §7): if the QR code just mirrored
// that request's Host header, it would encode "localhost" too, which
// means something different on every other phone on the Wi-Fi. Override
// with LAN_IP=x.x.x.x if auto-detection ever picks the wrong adapter
// (VPN, Docker, multiple NICs...).
const VIRTUAL_ADAPTER_NAME = /virtual|vmware|virtualbox|hyper-v|docker|veth|tailscale|zerotier|wireguard|\btap\b|\bppp\b|bluetooth|loopback/i;
function detectLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push({ name, address: net.address });
    }
  }
  // Prefer an actual Wi-Fi/Ethernet adapter over VPNs and virtual-machine
  // adapters (Tailscale, VMware...): those otherwise "win" by just
  // enumerating first, and their address is only reachable from that same
  // VPN/host, not from a phone on the room's real Wi-Fi.
  const real = candidates.filter(c => !VIRTUAL_ADAPTER_NAME.test(c.name));
  const pick = (real.length ? real : candidates)[0];
  return pick ? pick.address : null;
}
const LAN_IP = (process.env.LAN_IP && process.env.LAN_IP.trim()) || detectLanIp();

// Fixed key beats a local override file beats a fresh random one each
// boot (today's default). Locking it means a browser that already has
// the key saved (host.html stores it in localStorage) keeps working
// across server restarts instead of needing the console re-checked.
const HOST_KEY_FILE = path.join(ROOT, 'data', 'host-key.json');
function resolveHostKey() {
  if (process.env.HOST_KEY && process.env.HOST_KEY.trim()) {
    return { key: process.env.HOST_KEY.trim().toUpperCase(), fixed: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(HOST_KEY_FILE, 'utf8'));
    if (raw && raw.key && String(raw.key).trim()) {
      return { key: String(raw.key).trim().toUpperCase(), fixed: true };
    }
  } catch (e) { /* file missing/empty/invalid -> fall back to random */ }
  return { key: crypto.randomBytes(3).toString('hex').toUpperCase(), fixed: false };
}
const { key: HOST_KEY, fixed: hostKeyFixed } = resolveHostKey();
console.log('================================================');
console.log(' MUSICAL MAYHEM V5');
console.log(' HOST KEY : ' + HOST_KEY + '   (entrez cette clé dans host.html)' + (hostKeyFixed ? '  [fixe]' : '  [aléatoire, voir README pour la verrouiller]'));
console.log('================================================');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4'
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const cleaned = decoded.replace(/\.\./g, '').replace(/^\/+/, '');
  return path.join(root, cleaned);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    // No ETag/Last-Modified is sent, so without this a browser's own
    // heuristic caching can serve a stale public/js/*.js from a previous
    // server run after a restart (same URL, no validator to notice it
    // changed) — exactly how a fix could land in the code but a reload
    // still show the old behavior. Static assets here change often enough
    // during iteration, and this is a LAN party app, not a page under real
    // traffic, that always refetching is the safer default.
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function csvEscape(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url === '/' || url === '') {
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  if (url.startsWith('/media/')) {
    const f = safeJoin(MEDIA_DIR, url.slice('/media'.length));
    serveFile(res, f);
    return;
  }

  if (url.startsWith('/api/qr')) {
    const state = store.getState();
    const host = LAN_IP ? (LAN_IP + ':' + PORT) : (req.headers.host || ('localhost:' + PORT));
    const joinUrl = 'http://' + host + '/team.html?code=' + state.joinCode;
    QRCode.toBuffer(joinUrl, { margin: 1, width: 320, color: { dark: '#0b0b12', light: '#f8f8fb' } })
      .then(buf => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(buf); })
      .catch(() => { res.writeHead(500); res.end('qr error'); });
    return;
  }

  if (url.startsWith('/api/spotify/search')) {
    const parsed = new URL(req.url, 'http://internal');
    const key = parsed.searchParams.get('key');
    const q = (parsed.searchParams.get('q') || '').trim();
    if (!key || key.toUpperCase() !== HOST_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'missing_query' }));
      return;
    }
    if (!spotify.isConfigured()) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_configured', message: 'Renseignez data/spotify.json (voir README).' }));
      return;
    }
    spotify.searchTracks(q, 8)
      .then(results => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ results })); })
      .catch(err => {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.code || 'spotify_error', message: err.message }));
      });
    return;
  }

  // Cover art for the DÉTECTIVE D'ALBUM reveal on screen.html. Not
  // host-key gated, same reasoning as the playback-token route just below:
  // Team/Screen have no auth in this game's model, and this only ever
  // exposes the art for a track the server has already broadcast (title,
  // artist, album, year) to everyone as part of that reveal, nothing new
  // is disclosed. Redirects straight to Spotify's own CDN instead of
  // proxying bytes, so a missing/unconfigured case is just a 404 the
  // <img onerror> on the page quietly drops.
  if (url.startsWith('/api/spotify/album-art')) {
    const parsed = new URL(req.url, 'http://internal');
    const uri = (parsed.searchParams.get('uri') || '').trim();
    if (!uri || !spotify.isConfigured()) { res.writeHead(404); res.end(); return; }
    spotify.getAlbumArt(uri)
      .then(artUrl => {
        if (!artUrl) { res.writeHead(404); res.end(); return; }
        res.writeHead(302, { Location: artUrl });
        res.end();
      })
      .catch(() => { res.writeHead(404); res.end(); });
    return;
  }

  // Host clicks "Connecter Spotify" -> here -> Spotify's consent screen ->
  // /auth/spotify/callback. Host-key gated so only the host can kick off a
  // login against their own account.
  if (url.startsWith('/auth/spotify/login')) {
    const parsed = new URL(req.url, 'http://internal');
    const key = parsed.searchParams.get('key');
    if (!key || key.toUpperCase() !== HOST_KEY) { res.writeHead(401); res.end('unauthorized'); return; }
    try {
      const authorizeUrl = spotifyAuth.buildAuthorizeUrl(SPOTIFY_REDIRECT_URI);
      res.writeHead(302, { Location: authorizeUrl });
      res.end();
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<p>Spotify non configuré : renseignez data/spotify.json (voir README).</p>');
    }
    return;
  }

  if (url.startsWith('/auth/spotify/callback')) {
    const parsed = new URL(req.url, 'http://internal');
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    const error = parsed.searchParams.get('error');
    const page = (msg) => `<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <p>${msg}</p><p><small>Vous pouvez fermer cette fenêtre.</small></p>
      <script>setTimeout(()=>window.close(),1800)</script></body></html>`;
    if (error || !code || !state) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('❌ Connexion Spotify annulée ou refusée.'));
      return;
    }
    spotifyAuth.handleCallback(code, state, SPOTIFY_REDIRECT_URI)
      .then(() => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page('✅ Spotify connecté !')); })
      .catch(err => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page('❌ ' + err.message)); });
    return;
  }

  if (url.startsWith('/api/spotify/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ authorized: spotifyAuth.isAuthorized(), deviceReady: !!musicSource.getActiveDeviceId() }));
    return;
  }

  // Bearer token handed to the Screen tab's Web Playback SDK. Unlike other
  // host actions this isn't host-key gated: Screen/Team already have no
  // auth in this app's model (LAN party game, trusted room), and the
  // token itself is short-lived and playback-scoped only.
  if (url.startsWith('/api/spotify/playback-token')) {
    spotifyAuth.getValidAccessToken()
      .then(accessToken => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ accessToken })); })
      .catch(err => { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: err.code || 'auth_error', message: err.message })); });
    return;
  }

  if (url.startsWith('/api/export.json')) {
    const state = store.getState();
    const payload = {
      title: store.config.title,
      exportedAt: new Date().toISOString(),
      teams: state.teams.map(t => ({ name: t.name, score: t.score })).sort((a, b) => b.score - a.score),
      events: state.events
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="musical-mayhem-scores.json"' });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  if (url.startsWith('/api/export.csv')) {
    const state = store.getState();
    const sorted = [...state.teams].sort((a, b) => b.score - a.score);
    const lines = ['Rang,Equipe,Score', ...sorted.map((t, i) => [i + 1, csvEscape(t.name), t.score].join(','))];
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="musical-mayhem-scores.csv"' });
    res.end(lines.join('\n'));
    return;
  }

  serveFile(res, safeJoin(PUBLIC_DIR, url));
});

const wss = new WebSocket.Server({ server });
const clients = new Set();

function broadcastAll() {
  const state = store.getState();
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    try {
      const view = views.buildView(state, ws.role, ws.teamId);
      ws.send(JSON.stringify({ type: 'state', state: view }));
    } catch (e) { console.error('broadcast failed', e.message); }
  }
}

wss.on('connection', ws => {
  ws.role = null;
  ws.isHost = false;
  ws.teamId = null;
  ws.sessionId = null;
  clients.add(ws);

  try {
    const view = views.buildView(store.getState(), ws.role, ws.teamId);
    ws.send(JSON.stringify({ type: 'state', state: view }));
  } catch (e) {}

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === 'hello' && m.role === 'host') {
      ws.isHost = !!m.hostKey && String(m.hostKey).toUpperCase() === HOST_KEY;
    }
    actions.handleMessage(ws, raw, broadcastAll);
  });

  ws.on('close', () => {
    actions.onClose(ws);
    clients.delete(ws);
    broadcastAll();
  });
});

// Independent of any play attempt or the Screen tab noticing on its own,
// see lib/musicSource.js's verifyActiveDevice for why this exists: closes
// the gap where the Host panel kept showing "prêt" for a Connect session
// that had actually already died, so ▶ silently did nothing audible.
setInterval(() => { musicSource.verifyActiveDevice().catch(() => {}); }, 30000);

server.listen(PORT, () => {
  console.log('MUSICAL MAYHEM V5 → http://localhost:' + PORT);
  if (LAN_IP) {
    console.log('Sur le même Wi-Fi, les joueurs utilisent : http://' + LAN_IP + ':' + PORT);
  } else {
    console.log('IP locale non détectée automatiquement, vérifiez votre connexion réseau, ou fixez-la avec LAN_IP=x.x.x.x.');
  }
});
