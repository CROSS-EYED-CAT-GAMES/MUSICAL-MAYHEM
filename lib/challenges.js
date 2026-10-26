// Loads the challenge catalog + shared track pool + per-challenge question
// content, and resolves track references. This is the only place that
// knows about the on-disk content shape: the engine (actions.js) works
// with the resolved objects this module hands back.
//
// Also owns the one write path back to tracks.json/challenge-content.json:
// addTrack/addInstance, used by HOST_ACTIONS.addQuestion (lib/actions.js)
// to let the host build content live from the Spotify search panel
// instead of hand-editing JSON. The exact per-mode instance shape mirrors
// scripts/gen-challenge-content.js: that script is the canonical
// reference for "what does this challenge's content look like".
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRACKS_FILE = path.join(DATA_DIR, 'tracks.json');
const CONTENT_FILE = path.join(DATA_DIR, 'challenge-content.json');

const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'challenges.json'), 'utf8'));
const tracks = JSON.parse(fs.readFileSync(TRACKS_FILE, 'utf8'));
const content = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));

const catalogById = {};
catalog.forEach(c => { catalogById[c.id] = c; });

const tracksById = {};
tracks.forEach(t => { tracksById[t.id] = t; });

let trackSeq = tracks.reduce((max, t) => {
  const n = parseInt(String(t.id).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? Math.max(max, n) : max;
}, 0);

function getChallengeDef(id) {
  return catalogById[id] || null;
}

function getEnabledChallenges(enabledIds) {
  const set = new Set(enabledIds);
  return catalog.filter(c => c.implemented !== false && set.has(c.id));
}

function getInstances(challengeId) {
  return content[challengeId] || [];
}

function resolveTrack(trackId) {
  return tracksById[trackId] || null;
}

function pickRandomTrackByTag(tag) {
  const pool = tracks.filter(t => t.tags && t.tags.includes(tag));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function persistTracks() {
  fs.writeFileSync(TRACKS_FILE, JSON.stringify(tracks, null, 2) + '\n');
}

function persistContent() {
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(content, null, 2) + '\n');
}

// `fields` comes straight from a Spotify search result (title/artist/
// album/spotifyUri) plus whatever the host typed in (year isn't in
// Spotify's basic search response, so it's always host-entered). Pushed
// into the live in-memory pool AND persisted immediately: no server
// restart needed for the new track to be playable/selectable.
function addTrack(fields) {
  fields = fields || {};
  trackSeq++;
  const t = {
    id: 'trk_' + String(trackSeq).padStart(3, '0'),
    spotifyUri: fields.spotifyUri || '',
    audioRef: '',
    title: fields.title || '',
    artist: fields.artist || '',
    year: (fields.year != null && fields.year !== '') ? Number(fields.year) : null,
    album: fields.album || '',
    genre: fields.genre || '',
    tags: Array.isArray(fields.tags) ? fields.tags : []
  };
  tracks.push(t);
  tracksById[t.id] = t;
  persistTracks();
  return t;
}

function nextInstanceNumber(challengeId) {
  return (content[challengeId] || []).length + 1;
}

function addInstance(challengeId, instance) {
  if (!content[challengeId]) content[challengeId] = [];
  content[challengeId].push(instance);
  persistContent();
  return instance;
}

module.exports = {
  catalog, catalogById, tracksById,
  getChallengeDef, getEnabledChallenges, getInstances, resolveTrack, pickRandomTrackByTag,
  addTrack, nextInstanceNumber, addInstance
};
