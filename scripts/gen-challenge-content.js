// Generates data/tracks.json (shared placeholder track pool) and
// data/challenge-content.json (per-challenge question instances) from
// data/challenges.json. All song data is empty placeholders, never
// fabricates real titles/artists/Spotify URIs; the organizer fills them
// in (optionally aided by the Host Spotify search panel).
// Run with: node scripts/gen-challenge-content.js
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const challenges = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'challenges.json'), 'utf8'));

let trackSeq = 0;
const tracks = [];
function pad(n) { return String(n).padStart(3, '0'); }
function newTrack(tags) {
  trackSeq++;
  const t = { id: 'trk_' + pad(trackSeq), spotifyUri: '', audioRef: '', title: '', artist: '', year: null, album: '', tags: tags || [] };
  tracks.push(t);
  return t;
}

const categoryPool = ['80s', '90s', 'french', 'party', 'roadtrip', 'guilty_pleasure'];
// seed a few explicitly-tagged tracks per spotify_roulette category so the
// random-from-tag picker has something to draw from out of the box.
categoryPool.forEach(cat => { for (let i = 0; i < 3; i++) newTrack([cat]); });

const content = {};

function addTrackRefInstance(chal, n) {
  const t = newTrack();
  return { id: chal.shortName.replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase() + pad(n), challenge: chal.id, number: n, trackId: t.id, hint: '' };
}

challenges.forEach(chal => {
  if (chal.implemented === false) { content[chal.id] = []; return; }
  const count = chal.recommendedQuestions || 4;
  const list = [];

  for (let n = 1; n <= count; n++) {
    if (chal.mode === 'buzzer_tiered' && chal.multiTrack) {
      // Several tracks revealed in sequence, one tier per track slot by
      // position (score decreasing the later the right track is reached).
      // No challenge currently in the catalog uses this shape, but it's
      // generic (not tied to a specific id), kept ready for one that will.
      const tierCount = (chal.scoring.tiers || []).length || 3;
      const trackIds = Array.from({ length: tierCount }, () => newTrack().id);
      const prefix = chal.shortName.replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase() || 'MT';
      list.push({ id: prefix + pad(n), challenge: chal.id, number: n, trackIds, hint: '' });
    } else if (chal.mode === 'buzzer_tiered') {
      list.push(addTrackRefInstance(chal, n));
    } else if (chal.mode === 'buzzer_compound') {
      // Parts scoring is a host judgment call (checkboxes), not a string
      // match, so the reference data the host judges against should
      // come from the track itself wherever possible, not a duplicated
      // copy. Only truly track-external facts (e.g. cover_original's
      // "who did the ORIGINAL", the track is the cover being played)
      // get an extra manually-authored field.
      if (chal.id === 'cover_original') {
        const t = newTrack();
        list.push({ id: 'CO' + pad(n), challenge: chal.id, number: n, trackId: t.id, extra: { original: '' }, hint: '' });
      } else {
        const t = newTrack();
        const prefix = chal.id === 'album_detective' ? 'AD' : 'CL';
        list.push({ id: prefix + pad(n), challenge: chal.id, number: n, trackId: t.id, hint: '' });
      }
    } else if (chal.mode === 'choice') {
      const optionsCount = (chal.scoring && chal.scoring.optionsCount) || 4;
      const t = newTrack();
      const options = Array.from({ length: optionsCount }, () => ({ label: '' }));
      list.push({ id: 'ODB' + pad(n), challenge: chal.id, number: n, trackId: t.id, options, correctIndex: 0, criterion: '' });
    } else if (chal.mode === 'panic') {
      list.push({ id: 'BTC' + pad(n), challenge: chal.id, number: n, theme: '', durationSeconds: chal.durationSeconds || 30 });
    } else if (chal.mode === 'bet') {
      const t = newTrack();
      list.push({ id: 'FB' + pad(n), challenge: chal.id, number: n, trackId: t.id });
    } else if (chal.mode === 'perform') {
      const t = newTrack();
      const prefix = chal.shortName.replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase() || 'PF';
      const inst = { id: prefix + pad(n), challenge: chal.id, number: n, trackId: t.id };
      if (chal.actions) inst.action = chal.actions[n % chal.actions.length];
      if (chal.hasPrivatePayload && chal.privatePayloadKind === 'banned_words') inst.bannedWords = ['', '', ''];
      list.push(inst);
    } else if (chal.mode === 'buzzer' && chal.multiTrack) {
      // Generic (not tied to a specific id): kept ready for a future
      // "several tracks, find the hidden theme/link" challenge even
      // though none is currently in the catalog.
      const trackIds = [newTrack().id, newTrack().id, newTrack().id];
      const prefix = chal.shortName.replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase() || 'MT';
      list.push({ id: prefix + pad(n), challenge: chal.id, number: n, trackIds, link: '', hint: '' });
    } else if (chal.randomFromTags) {
      list.push({ id: 'SR' + pad(n), challenge: chal.id, number: n, category: (chal.categories || categoryPool)[n % (chal.categories || categoryPool).length], hint: '' });
    } else if (chal.hasPrivatePayload && chal.privatePayloadKind === 'forbidden_word') {
      const t = newTrack();
      list.push({ id: 'FS' + pad(n), challenge: chal.id, number: n, trackId: t.id, wordPool: ['', '', '', '', '', ''] });
    } else if (chal.hasClue) {
      const t = newTrack();
      list.push({ id: 'LIT' + pad(n), challenge: chal.id, number: n, trackId: t.id, clue: '', hint: '' });
    } else {
      list.push(addTrackRefInstance(chal, n));
    }
  }
  content[chal.id] = list;
});

fs.writeFileSync(path.join(DATA_DIR, 'tracks.json'), JSON.stringify(tracks, null, 2) + '\n');
fs.writeFileSync(path.join(DATA_DIR, 'challenge-content.json'), JSON.stringify(content, null, 2) + '\n');
console.log('Wrote', tracks.length, 'placeholder tracks and content for', Object.keys(content).length, 'challenges.');
