// Builds a role-specific (and, for teams, team-specific) projection of the
// authoritative state. This is the ONLY place secrets get filtered out
// before anything is sent over the wire: hidden answers, other teams'
// power hands, private payloads, unrevealed choices, unlocked bet
// amounts, and who used a sabotage power.
const { config } = require('./store');
const challenges = require('./challenges');

function currentChallengeDefRaw(state) {
  if (!state.currentChallenge.id) return null;
  return challenges.getChallengeDef(state.currentChallenge.id);
}
function currentInstanceRaw(state) {
  const def = currentChallengeDefRaw(state);
  if (!def) return null;
  const list = challenges.getInstances(def.id);
  const order = state.currentChallenge.order;
  const idx = order ? order[state.currentChallenge.instanceIndex] : state.currentChallenge.instanceIndex;
  return list[idx] || null;
}
function effectiveTrackIdRaw(state, def, inst) {
  if (def && def.randomFromTags) return state.currentChallenge.resolvedTrackId || null;
  return inst ? inst.trackId : null;
}
function safeTrack(trackId, revealYear) {
  const t = challenges.tracksById[trackId];
  if (!t) return null;
  const out = { title: t.title, artist: t.artist, album: t.album };
  if (revealYear) out.year = t.year;
  if (t.spotifyUri) out.spotifyUri = t.spotifyUri;
  return out;
}

function projectQuestion(state, role, viewerTeamId) {
  const def = currentChallengeDefRaw(state);
  const inst = currentInstanceRaw(state);
  if (!def || !inst) return null;

  if (role === 'host') {
    const trackId = effectiveTrackIdRaw(state, def, inst);
    const track = trackId ? challenges.tracksById[trackId] : null;
    const tracks = inst.trackIds ? inst.trackIds.map(id => challenges.tracksById[id]) : null;
    return Object.assign({}, inst, { track, tracks });
  }

  const revealed = !!state.reveal.shown;
  const hintAllowed = role === 'team' && state.oracleTeams.includes(viewerTeamId);
  const out = { id: inst.id, challenge: def.id, number: inst.number };

  if (def.hasClue) out.clue = inst.clue;
  if (def.mode === 'choice') {
    out.options = (inst.options || []).map(o => {
      const opt = { label: o.label || '' };
      if (o.trackId) {
        const t = challenges.tracksById[o.trackId];
        if (t) { opt.title = t.title; opt.artist = t.artist; if (revealed) opt.year = t.year; }
      }
      return opt;
    });
    if (inst.criterion) out.criterion = inst.criterion;
    if (revealed) out.correctIndex = inst.correctIndex;
  }
  if (def.mode === 'perform' && inst.action) out.action = inst.action;
  if (def.mode === 'panic' && inst.theme) out.theme = inst.theme;
  if (hintAllowed && inst.hint) out.hint = inst.hint;

  // LE PARI FINAL: year + genre are shown from the moment betting opens
  // (that's the whole point, betting blind with zero information was the
  // playability complaint), well before `revealed` is set at final_reveal
  // for the actual title/artist below.
  if (def.mode === 'bet') {
    const trackId = effectiveTrackIdRaw(state, def, inst);
    const t = trackId ? challenges.tracksById[trackId] : null;
    if (t) {
      if (t.year) out.year = t.year;
      if (t.genre) out.genre = t.genre;
    }
  }

  if (revealed) {
    if (def.mode === 'buzzer_compound') {
      if (inst.trackIds) out.tracks = inst.trackIds.map(id => safeTrack(id, true)).filter(Boolean);
      else if (inst.trackId) {
        const t = safeTrack(inst.trackId, true);
        if (t) Object.assign(out, t);
      }
      if (inst.extra) out.extra = inst.extra;
    }
    else if (def.multiTrack) {
      out.tracks = (inst.trackIds || []).map(id => safeTrack(id, true)).filter(Boolean);
      if (inst.link) out.link = inst.link;
    } else if (def.id === 'spotify_roulette' && inst.trackId) {
      // JOUEUR A, JOUEUR B OU LES DEUX ? is `choice` mode: its options are the
      // three fixed answer labels, not tracks, so the single track being
      // guessed about lives at inst.trackId instead. The generic
      // choice-mode branch below deliberately skips revealing a top-level
      // title/artist (nothing needs it there), so this challenge needs its
      // own case to actually reveal what was played.
      const t = safeTrack(inst.trackId, true);
      if (t) Object.assign(out, t);
    } else if (def.id === 'movie_soundtrack' && inst.trackId) {
      // FILM OU SÉRIE ? scores the movie/series name, not the song title
      // or composer: the generic buzzer reveal below would show the wrong
      // thing. Poster comes pre-resolved (data/tracks.json), not fetched
      // live, so it's just a plain <img src>, no album-art proxy needed.
      const t = challenges.tracksById[inst.trackId];
      if (t) {
        out.movieTitle = t.movieTitle || t.title;
        if (t.posterUrl) out.posterUrl = t.posterUrl;
      }
    } else if (def.mode !== 'choice') {
      const trackId = effectiveTrackIdRaw(state, def, inst);
      const t = trackId ? safeTrack(trackId, true) : null;
      if (t) { out.title = t.title; out.artist = t.artist; }
    }
  }
  return out;
}

function projectMyPayload(state, role, viewerTeamId) {
  if (role !== 'team' || !viewerTeamId) return null;
  return state.privateAssignments[viewerTeamId] || null;
}

function projectChoices(state, role, viewerTeamId) {
  const revealed = role === 'host' || state.phase === 'choice_reveal';
  return {
    answeredTeamIds: Object.keys(state.choices),
    myChoice: (role === 'team' && viewerTeamId && state.choices[viewerTeamId] != null) ? state.choices[viewerTeamId] : null,
    revealed: revealed ? state.choices : null
  };
}

function projectSelection(state) {
  const s = state.selection;
  const withDetails = (ids) => (ids || []).map(id => challenges.getChallengeDef(id)).filter(Boolean);
  return {
    active: s.active,
    policy: s.policy,
    chooserTeamId: s.chooserTeamId,
    secondChooserTeamId: s.secondChooserTeamId,
    options: withDetails(s.options),
    optionsB: withDetails(s.optionsB),
    duelPicks: s.duelPicks,
    history: s.history
  };
}

function projectProgress(state) {
  const playedMinutes = state.selection.history.reduce((sum, id) => {
    const def = challenges.getChallengeDef(id);
    return sum + (def ? def.estimatedMinutes : 0);
  }, 0);
  return {
    challengesPlayed: state.challengesPlayed,
    maxChallenges: state.setup.maxChallenges,
    targetDurationMinutes: state.setup.targetDurationMinutes,
    estimatedMinutesPlayed: playedMinutes
  };
}

function projectTeam(t, role, viewerTeamId) {
  // sessionIds itself is never sent to clients (join flow is auth-worthy
  // internal state, see lib/actions.js), but "has this slot ever had a
  // real phone join it" is a stable, reconnect-proof signal the UI needs
  // to stop showing untouched team slots once the game is under way:
  // unlike `connected`, it doesn't flicker false during a brief Wi-Fi
  // drop for a team that's genuinely playing.
  const everJoined = t.sessionIds.length > 0;
  const base = { id: t.id, name: t.name, emoji: t.emoji, color: t.color, customized: t.customized, score: t.score, connected: t.connected > 0, everJoined, cardCount: t.powers.length };
  if (role === 'host') return Object.assign({}, base, { connectedCount: t.connected, powers: t.powers });
  if (role === 'team' && t.id === viewerTeamId) return Object.assign({}, base, { powers: t.powers, mine: true });
  return base;
}

function projectBets(state, role, viewerTeamId) {
  const open = role === 'host' || state.phase === 'final_reveal' || state.phase === 'challenge_results' || state.phase === 'victory';
  const out = {};
  Object.keys(state.bets).forEach(tid => {
    const b = state.bets[tid];
    out[tid] = (open || tid === viewerTeamId) ? b : { locked: b.locked };
  });
  return out;
}

function projectEffects(state, role, viewerTeamId) {
  if (role === 'host') return state.effects;
  if (role === 'team' && viewerTeamId) {
    return {
      double: !!state.effects.double[viewerTeamId],
      shield: !!state.effects.shield[viewerTeamId],
      silence: !!state.effects.silence[viewerTeamId]
    };
  }
  return {};
}

function projectEvents(state, role) {
  if (role === 'host') return state.events;
  return state.events.map(e => {
    if (e.type === 'POWER_USED') { const { teamId, ...rest } = e; return rest; }
    return e;
  });
}

function buildView(state, role, viewerTeamId) {
  return {
    gameId: state.gameId,
    joinCode: state.joinCode,
    phase: state.phase,
    setup: state.setup,
    challenge: state.currentChallenge.id ? currentChallengeDefRaw(state) : null,
    challengeIndex: state.currentChallenge.instanceIndex,
    // How many questions THIS playthrough will actually ask, not the size
    // of the question bank: state.currentChallenge.order is already capped
    // to the challenge's def.drawCount when set (see lib/actions.js
    // beginChallenge), so "QUESTION X/Y" reflects the round, not the bank.
    challengeTotal: state.currentChallenge.id ? state.currentChallenge.order.length : 0,
    // Who won the Mayhem card for the round that just ended, and which one
    // (see lib/actions.js's awardRoundWinnerCard): null if that challenge
    // didn't award powers at all (allowsPowers:false) or ended before a
    // single question was played (skipChallenge from the intro screen).
    // Not secret (every screen shows the same reveal), so passed through
    // unfiltered for every role.
    roundResult: state.roundResult || null,
    progress: projectProgress(state),
    selection: projectSelection(state),
    question: projectQuestion(state, role, viewerTeamId),
    myPayload: projectMyPayload(state, role, viewerTeamId),
    privateAssignments: role === 'host' ? state.privateAssignments : undefined,
    choices: projectChoices(state, role, viewerTeamId),
    teams: state.teams.map(t => projectTeam(t, role, viewerTeamId)),
    buzzer: {
      open: state.buzzer.open,
      lockedTeamId: state.buzzer.lockedTeamId,
      wrongTeamIds: state.buzzer.wrongTeamIds,
      tierIndex: state.buzzer.tierIndex || 0
    },
    performTimer: state.performTimer || { running: false, endsAt: null },
    answerTimer: state.answerTimer || { running: false, endsAt: null },
    playTimer: state.playTimer || { running: false, endsAt: null, remainingMs: null, positionMs: null },
    reveal: state.reveal,
    chaos: state.chaos,
    panic: state.panic,
    bets: projectBets(state, role, viewerTeamId),
    effects: projectEffects(state, role, viewerTeamId),
    events: projectEvents(state, role),
    role: role || null,
    viewerTeamId: viewerTeamId || null,
    demoRunning: !!state.demoRunning,
    updatedAt: state.updatedAt,
    meta: {
      title: config.title, tagline: config.tagline, powers: config.powers, palette: config.palette,
      // instanceCount is computed fresh each view, not stored on the
      // catalog object itself, so the config screen's question counts
      // update live right after host:addQuestion without a restart.
      challenges: challenges.catalog.map(c => Object.assign({}, c, { instanceCount: challenges.getInstances(c.id).length }))
    }
  };
}

module.exports = { buildView };
