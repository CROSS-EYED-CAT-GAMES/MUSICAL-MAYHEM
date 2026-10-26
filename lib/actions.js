// All game-state mutations live here. The server is the sole authority:
// every message from a client is validated against session/role/phase
// before anything changes, and every mutation is logged to state.events.
const store = require('./store');
const { config } = store;
const challenges = require('./challenges');
const selection = require('./selection');
const musicSource = require('./musicSource');
const spotifyAuth = require('./spotifyAuth');

let undoStack = [];
let panicTimer = null;
let performTimer = null;
let playTimerHandle = null;
let tierAdvanceHandle = null;
let answerTimerHandle = null;
let finalGuessTimer = null;

function clone(x) { return JSON.parse(JSON.stringify(x)); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function log(state, type, payload) {
  state.events.push({ type, ...payload, at: Date.now() });
  if (state.events.length > config.maxEventLog) {
    state.events = state.events.slice(-config.maxEventLog);
  }
}

function findTeam(state, teamId) {
  return state.teams.find(t => t.id === teamId) || null;
}

function currentChallengeDef(state) {
  if (!state.currentChallenge.id) return null;
  return challenges.getChallengeDef(state.currentChallenge.id);
}

function currentInstance(state) {
  const def = currentChallengeDef(state);
  if (!def) return null;
  const list = challenges.getInstances(def.id);
  const order = state.currentChallenge.order;
  const idx = order ? order[state.currentChallenge.instanceIndex] : state.currentChallenge.instanceIndex;
  return list[idx] || null;
}

// Resolves the track actually being played this question: normally the
// instance's own trackId, but spotify_roulette resolves one at random
// from a tagged pool the first time the question begins, then caches the
// pick on state so reveal/host stay consistent for this play-through
// (the static content in challenge-content.json is shared and never
// mutated).
function effectiveTrackId(state, def, inst) {
  if (def && def.randomFromTags) return state.currentChallenge.resolvedTrackId || null;
  return inst ? inst.trackId : null;
}

// Resolves the actual track object(s) for the currently displayed
// question: single track for most modes, two for frankenstein-style
// `trackIds` compounds. Shared by the audio panel's play/pause/seek
// actions so they never have to know which mode they're in.
function currentTracks(state) {
  const def = currentChallengeDef(state);
  const inst = currentInstance(state);
  if (!def || !inst) return [];
  if (inst.trackIds) return inst.trackIds.map(id => challenges.resolveTrack(id)).filter(Boolean);
  const tid = effectiveTrackId(state, def, inst);
  const t = tid ? challenges.resolveTrack(tid) : null;
  return t ? [t] : [];
}

function connectedTeamCount(state) {
  return state.teams.filter(t => t.connected > 0).length;
}

function applyScore(state, teamId, delta, reason) {
  const t = findTeam(state, teamId);
  if (!t) return 0;
  let final = delta;
  if (delta > 0 && state.effects.double[teamId]) {
    final *= 2;
    delete state.effects.double[teamId];
    reason = reason + ' +DOUBLE';
  }
  t.score += final;
  log(state, 'SCORE_CHANGED', { teamId, delta: final, reason });
  return final;
}

function consumeShieldIfAny(state, targetTeamId) {
  if (state.effects.shield[targetTeamId]) {
    delete state.effects.shield[targetTeamId];
    return true;
  }
  return false;
}

function addPowerCard(state, teamId, powerId) {
  const t = findTeam(state, teamId);
  if (!t) return;
  const powerDef = config.powers.find(p => p.id === powerId);
  if (!powerDef) return;
  t.powers.push({ instId: 'p' + (++state.powerCardsIssued) + Math.random().toString(36).slice(2, 5), powerId });
  log(state, 'POWER_GRANTED', { teamId, powerId });
}

function randomAllowedPowerId(def) {
  const pool = (def.allowedPowers && def.allowedPowers.length) ? def.allowedPowers : config.powers.map(p => p.id);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Mayhem cards used to be handed out to every connected team at the start
// of each challenge (one freebie each, restricted to that challenge's own
// allowedPowers). Replaced with a single card for whoever improved their
// score the most DURING the challenge just played (ties broken randomly,
// not by team order), awarded once the challenge ends. The card is drawn
// from the full catalog, not the just-finished challenge's allowedPowers:
// it's for a FUTURE challenge, and usePower already checks the then-active
// challenge's own allowedPowers at use time regardless of where the card
// came from. Returns the award (for the challenge_results/victory screen's
// reveal) or null if nobody was eligible (no connected teams, or the
// challenge ended before a single question was asked).
function awardRoundWinnerCard(state) {
  const scoreAtStart = state.currentChallenge.scoreAtStart;
  const teams = state.teams.filter(t => t.connected > 0 && scoreAtStart[t.id] != null);
  if (!teams.length) return null;
  const withDelta = teams.map(t => ({ team: t, delta: t.score - scoreAtStart[t.id] }));
  const bestDelta = Math.max(...withDelta.map(x => x.delta));
  const contenders = withDelta.filter(x => x.delta === bestDelta).map(x => x.team);
  const winner = contenders[Math.floor(Math.random() * contenders.length)];
  const powerId = config.powers[Math.floor(Math.random() * config.powers.length)].id;
  addPowerCard(state, winner.id, powerId);
  log(state, 'ROUND_CARD_AWARDED', { teamId: winner.id, powerId, delta: bestDelta });
  return { teamId: winner.id, powerId, delta: bestDelta };
}

// --- challenge lifecycle -------------------------------------------------

// --- play timer ------------------------------------------------------
// Caps how long a track plays before auto-pausing, displayed as a
// countdown on Screen/Host. Pausing (a buzz, or the host's own pause
// button) freezes the remaining time instead of losing it, and resuming
// (a wrong answer, or the host resuming) continues from exactly there,
// rather than restarting the clip or the clock. Mirrors the panic/perform
// setTimeout pattern already used elsewhere in this file.
function clearPlayTimerHandle() {
  if (playTimerHandle) { clearTimeout(playTimerHandle); playTimerHandle = null; }
}

function schedulePlayTimerEnd(ms) {
  clearPlayTimerHandle();
  playTimerHandle = setTimeout(() => {
    const state = store.getState();
    if (state.playTimer && state.playTimer.running) {
      musicSource.getMusicSource().pause().catch(() => {});
      state.playTimer.running = false;
      state.playTimer.endsAt = null;
      state.playTimer.remainingMs = 0;
      store.setState(state);
      if (typeof global.__mmBroadcast === 'function') global.__mmBroadcast();
    }
  }, ms + 50);
}

// --- automatic buzzer_tiered progression (five_seconds: "de plus en plus
// longtemps, plus vous buzzez tot, plus ca rapporte") --------------------
// A tier auto-advances by real elapsed playback time only when every tier
// in its scoring config declares a `seconds` threshold (five_seconds:
// 5/7/10/15). whos_next's tiers ("Morceau 1/2/3") have no such threshold,
// they advance by which track is currently playing, not by a clock, so
// the host's manual PALIER SUIVANT still drives those, untouched here.
function timeTieredScoring(def) {
  const tiers = def && def.mode === 'buzzer_tiered' && def.scoring && def.scoring.tiers;
  if (!Array.isArray(tiers) || !tiers.length) return null;
  return tiers.every(t => typeof t.seconds === 'number') ? tiers : null;
}

function tierIndexForPosition(tiers, positionMs) {
  const idx = tiers.findIndex(t => positionMs < t.seconds * 1000);
  return idx === -1 ? tiers.length - 1 : idx;
}

// Mirrors segStartedAt/segStartPositionMs's role in pauseMusicAndTimer:
// the live position while actually playing, computed from wall-clock
// elapsed time so it never depends on any async call landing in time.
function currentPlaybackPositionMs(state) {
  if (!state.playTimer.running) return state.playTimer.positionMs || 0;
  const started = state.playTimer.segStartedAt || Date.now();
  const base = state.playTimer.segStartPositionMs || 0;
  return base + Math.max(0, Date.now() - started);
}

function clearTierAdvanceHandle() {
  if (tierAdvanceHandle) { clearTimeout(tierAdvanceHandle); tierAdvanceHandle = null; }
}

// Sets buzzer.tierIndex for the current live position and schedules the
// next automatic bump for the moment real playback time crosses into the
// following bracket. Re-fetches live state on fire (same pattern as
// schedulePlayTimerEnd) since this runs outside the normal request
// dispatch, then re-schedules itself for the threshold after that, so one
// call chains through the whole progression while play continues.
function scheduleTierAdvance(state) {
  clearTierAdvanceHandle();
  const tiers = timeTieredScoring(currentChallengeDef(state));
  if (!tiers || !state.playTimer.running) return;
  const positionMs = currentPlaybackPositionMs(state);
  state.buzzer.tierIndex = tierIndexForPosition(tiers, positionMs);
  if (state.buzzer.tierIndex >= tiers.length - 1) return; // already in the last bracket
  const nextThresholdMs = tiers[state.buzzer.tierIndex].seconds * 1000;
  const delay = Math.max(0, nextThresholdMs - positionMs);
  tierAdvanceHandle = setTimeout(() => {
    const live = store.getState();
    // A buzz pauses playback (playTimer.running -> false) and clears this
    // handle already, but a stray late timer firing right on that edge
    // should still no-op rather than bump the tier out from under a team
    // that's mid-answer.
    if (!live.playTimer.running || live.buzzer.lockedTeamId) return;
    const before = live.buzzer.tierIndex;
    scheduleTierAdvance(live);
    if (live.buzzer.tierIndex !== before) log(live, 'TIER_ADVANCED', { tierIndex: live.buzzer.tierIndex, auto: true });
    store.setState(live);
    if (typeof global.__mmBroadcast === 'function') global.__mmBroadcast();
  }, delay + 30);
}

function resetPlayTimer(state) {
  clearPlayTimerHandle();
  clearTierAdvanceHandle();
  state.playTimer = { running: false, endsAt: null, remainingMs: null, positionMs: null, segStartedAt: null, segStartPositionMs: null };
}

// Track-tiered buzzer_tiered challenges (whos_next's "Morceau 1/2/3", no
// `seconds` thresholds, see timeTieredScoring) score strictly by which
// numbered track is currently playing, one tier per track slot by
// position. The host's own "PISTE A/B/C" play buttons (audioPanel) and the
// tier value used to score a buzz were two separate pieces of state:
// pressing "PISTE B" never touched buzzer.tierIndex, only the dedicated
// "PALIER SUIVANT" button did. Forgetting that second click (easy to do
// mid-show) meant every correct buzz on track 2 or 3 still scored
// "Morceau 1 +5". Syncing the tier to whichever slot was just played
// removes the second control entirely for this case, one action instead
// of two that had to be kept in sync by hand.
function syncTierToTrackIndex(state, def, index) {
  if (!def || def.mode !== 'buzzer_tiered' || !def.multiTrack) return;
  if (timeTieredScoring(def)) return; // five_seconds-style: driven by the playback clock, not by track slot
  if (state.buzzer.lockedTeamId) return; // don't retag the tier a locked answer is being judged against
  const tiers = (def.scoring && def.scoring.tiers) || [];
  if (!tiers.length) return;
  const idx = Math.max(0, Math.min(tiers.length - 1, Number(index) || 0));
  if (idx !== (state.buzzer.tierIndex || 0)) {
    state.buzzer.tierIndex = idx;
    log(state, 'TIER_ADVANCED', { tierIndex: idx, auto: true });
  }
}

// LE PARI FINAL's new guessing window (see beginFinalGuess) reuses the same
// capped-playback + countdown machinery as every buzzer challenge, even
// though bet mode has no buzzer of its own.
function usesPlayTimer(def) {
  return !!(def && (def.usesBuzzer || def.mode === 'bet'));
}

function startPlayTimerFresh(state) {
  const def = currentChallengeDef(state);
  if (!usesPlayTimer(def)) return;
  // A challenge can declare its own maxPlaySeconds (whos_next: shorter,
  // snappier clips per track in the sequence) overriding the game-wide
  // default; most challenges have none and just fall back to the global
  // setting like before.
  const total = (def.maxPlaySeconds || state.setup.maxPlaySeconds || 30) * 1000;
  state.playTimer.running = true;
  state.playTimer.endsAt = Date.now() + total;
  state.playTimer.remainingMs = null;
  state.playTimer.positionMs = null;
  // Starting fresh from 0, so the next pause's synchronous elapsed-time
  // estimate (see pauseMusicAndTimer) has a known baseline to work from.
  state.playTimer.segStartedAt = Date.now();
  state.playTimer.segStartPositionMs = 0;
  schedulePlayTimerEnd(total);
  scheduleTierAdvance(state);
}

// A play/pause/seek call failing is silent by default (console.error
// only) so a flaky Spotify call never blocks the game loop. But silence
// is exactly how a stale device (Screen tab reloaded, backgrounded too
// long, network hiccup) went unnoticed: status kept reporting "ready"
// while every play kept 404ing. musicSource.js now clears the dead
// device id itself on a 404, so the very next broadcast already reflects
// reality (host.js's renderSpotifyPanel flips to "not ready"); this just
// also toasts the host immediately when we have their ws (a direct click
// on ▶/⏸/⏮/⏪), instead of waiting for their next 5s status poll.
function reportMusicError(err, ws) {
  console.error('music playback error:', err.message);
  // Broadcast regardless of whether there's a specific ws to toast (e.g.
  // beginFinalGuess's auto-triggered play has none): err.deviceLost means
  // musicSource.js already cleared activeDeviceId, and every client's
  // next render should reflect that promptly, not just whoever happened
  // to click the button that discovered it.
  if (typeof global.__mmBroadcast === 'function') global.__mmBroadcast();
  if (ws) sendError(ws, err.deviceLost ? 'spotify_device_lost' : 'spotify_playback_failed');
}

function pauseMusicAndTimer(state, ws) {
  const src = musicSource.getMusicSource();
  // The real Spotify position used to only arrive via getCurrentPosition(),
  // an async API round-trip. That's fine for a pause that sits for a
  // while, but 5 SECONDES CHRONO's whole point is pausing and resuming
  // within a second or two (host reacts to "nobody buzzed", pauses,
  // advances the tier, hits play again), often faster than that round-trip
  // completes. A resume that raced ahead of it found positionMs still
  // null and fell back to 0: the clip silently restarted from the top
  // instead of continuing, exactly the "PALIER SUIVANT redemarre la
  // chanson" symptom. Computing the position synchronously from wall-clock
  // elapsed time since the current play segment started removes that
  // dependency entirely: it's available immediately, before any network
  // call could ever return, and it's what resume always uses now, no
  // async refinement afterwards. That refinement used to overwrite this
  // with Spotify's own reported position once the fetch landed, but that
  // can reflect an unrelated/stale playback state on the account (no
  // active device, a hiccup, anything) and silently clobber a correct
  // local estimate with a wrong one; a wall-clock estimate of a few
  // hundred ms off is a far smaller risk than that.
  const elapsed = Math.max(0, Date.now() - (state.playTimer.segStartedAt || Date.now()));
  state.playTimer.positionMs = (state.playTimer.segStartPositionMs || 0) + elapsed;
  src.pause().catch(err => reportMusicError(err, ws));
  clearPlayTimerHandle();
  // Freeze the tier where it stands: no further auto-advance while paused,
  // otherwise a lengthy pause (host deliberating a mark) would keep
  // silently climbing tiers with no music playing to justify it.
  clearTierAdvanceHandle();
  if (state.playTimer.running && state.playTimer.endsAt) {
    state.playTimer.remainingMs = Math.max(0, state.playTimer.endsAt - Date.now());
  }
  state.playTimer.running = false;
  state.playTimer.endsAt = null;
}

function resumeMusicAndTimer(state, ws) {
  const def = currentChallengeDef(state);
  const ms = state.playTimer.remainingMs != null ? state.playTimer.remainingMs : (usesPlayTimer(def) ? ((def && def.maxPlaySeconds) || state.setup.maxPlaySeconds || 30) * 1000 : 0);
  if (ms <= 0) return; // clock already spent: stay paused, nothing left to cap
  const track = currentTracks(state)[0];
  const resumeFromMs = state.playTimer.positionMs || 0;
  if (track) {
    musicSource.getMusicSource().play(track, { positionMs: resumeFromMs }).catch(err => reportMusicError(err, ws));
  }
  state.playTimer.running = true;
  state.playTimer.endsAt = Date.now() + ms;
  state.playTimer.remainingMs = null;
  // This resumed segment now starts from resumeFromMs; the next pause's
  // synchronous estimate measures elapsed time from here, not from 0.
  state.playTimer.segStartedAt = Date.now();
  state.playTimer.segStartPositionMs = resumeFromMs;
  schedulePlayTimerEnd(ms);
  scheduleTierAdvance(state);
}

function resetQuestionRuntime(state) {
  musicSource.getMusicSource().stop().catch(() => {});
  resetPlayTimer(state);
  clearAnswerTimerHandle();
  clearFinalGuessTimer();
  state.buzzer = { open: false, lockedTeamId: null, wrongTeamIds: [], openedAt: null, tierIndex: 0 };
  state.answerTimer = { running: false, endsAt: null };
  state.reveal = { shown: false };
  state.oracleTeams = [];
  // SILENCE's own description says "sur cette question" (this question
  // only), but nothing ever actually cleared it: once applied, a team
  // stayed silenced for the rest of the game, with no way back short of
  // having pre-emptively held a SHIELD. shield/double are left alone here
  // on purpose: their own descriptions say "le prochain sabotage" / "la
  // prochaine récompense", i.e. deliberately meant to carry across
  // questions until consumed, unlike SILENCE's explicit per-question scope.
  state.effects.silence = {};
  state.chaos.active = null;
  state.panic = { running: false, endsAt: null, submissions: {}, challenges: [] };
  state.performTimer = { running: false, endsAt: null };
  state.bets = {};
  state.finalRevealed = false;
  state.choices = {};
  state.privateAssignments = {};
  // Shown on the challenge_results/victory screen for the round that just
  // ended (see endCurrentChallenge); cleared the moment real gameplay (a
  // new question, in a new or the same challenge) actually resumes, so it
  // never lingers into the next round's own screens.
  state.roundResult = null;
}

function assignPrivatePayloads(state, def, inst) {
  const teams = state.teams.filter(t => t.connected > 0);
  if (def.privatePayloadKind === 'forbidden_word') {
    const words = shuffle((inst.wordPool || []).filter(Boolean));
    teams.forEach((t, i) => {
      state.privateAssignments[t.id] = { kind: 'forbidden_word', word: words.length ? words[i % words.length] : '' };
    });
  } else if (def.privatePayloadKind === 'banned_words') {
    teams.forEach(t => { state.privateAssignments[t.id] = { kind: 'banned_words', words: inst.bannedWords || [] }; });
  }
}

function beginChallengeQuestion(state) {
  const def = currentChallengeDef(state);
  if (!def) return null;
  resetQuestionRuntime(state);
  if (def.mode === 'bet') state.phase = 'final_betting';
  else if (def.mode === 'choice') state.phase = 'choice_active';
  else if (def.mode === 'perform') state.phase = 'perform_active';
  else state.phase = 'question';

  const inst = currentInstance(state);
  state.currentChallenge.resolvedTrackId = null;
  if (def.randomFromTags && inst) {
    const t = challenges.pickRandomTrackByTag(inst.category);
    state.currentChallenge.resolvedTrackId = t ? t.id : null;
  }
  log(state, 'QUESTION_STARTED', { challenge: def.id, number: state.currentChallenge.instanceIndex + 1 });

  if (def.hasPrivatePayload && inst) assignPrivatePayloads(state, def, inst);
  return inst;
}

function beginChallenge(state, challengeId) {
  const def = challenges.getChallengeDef(challengeId);
  if (!def || def.implemented === false) return { ok: false, msg: 'bad_challenge' };
  // Shuffled fresh every time this challenge starts (not just once ever),
  // so a challenge replayed later in the same game, or in a future game,
  // doesn't always open on the same song. instanceIndex still counts
  // 0,1,2... sequentially for "Question X/Y" and tier bookkeeping; order
  // only changes which instance that position actually points to.
  const instanceCount = challenges.getInstances(challengeId).length;
  const shuffled = shuffle(Array.from({ length: instanceCount }, (_, i) => i));
  // Some challenges deliberately keep a question bank bigger than any
  // single playthrough should use (classic_blind_test: a pool of songs to
  // draw from, not a fixed setlist) via def.drawCount: a fresh random
  // subset of that size every time, rather than the whole bank in some
  // shuffled order. Unset (the default) means "play the whole bank",
  // unchanged from before this existed.
  const order = (def.drawCount && def.drawCount < shuffled.length) ? shuffled.slice(0, def.drawCount) : shuffled;
  state.currentChallenge = { id: challengeId, instanceIndex: -1, order, scoreAtStart: {}, startedAt: Date.now(), resolvedTrackId: null };
  state.teams.forEach(t => { state.currentChallenge.scoreAtStart[t.id] = t.score; });
  state.phase = 'challenge_intro';
  resetQuestionRuntime(state);
  log(state, 'CHALLENGE_STARTED', { challenge: def.id });
  return { ok: true };
}

function nextChallengeQuestion(state) {
  const def = currentChallengeDef(state);
  if (!def) return { ok: false, msg: 'no_challenge' };
  // Not the full question bank: state.currentChallenge.order is already
  // capped to def.drawCount when set (see beginChallenge above), so this
  // playthrough ends after exactly that many, however big the bank is.
  const total = state.currentChallenge.order.length;
  const isLast = state.currentChallenge.instanceIndex >= total - 1;
  if (!isLast) {
    state.currentChallenge.instanceIndex += 1;
    beginChallengeQuestion(state);
    return { ok: true };
  }
  return endCurrentChallenge(state);
}

function endCurrentChallenge(state) {
  musicSource.getMusicSource().stop().catch(() => {});
  resetPlayTimer(state);
  const def = currentChallengeDef(state);
  // skipChallenge can end a challenge before host:nextQuestion was ever
  // called once (instanceIndex still -1): nothing was actually played, so
  // nobody "won" this round, no card.
  const challengeWasPlayed = state.currentChallenge.instanceIndex >= 0;
  state.roundResult = (def && def.allowsPowers && challengeWasPlayed) ? awardRoundWinnerCard(state) : null;
  state.challengesPlayed += 1;
  log(state, 'CHALLENGE_ENDED', { challenge: def ? def.id : null });
  const maxReached = state.challengesPlayed >= state.setup.maxChallenges;
  const wasFinal = def && def.id === state.setup.finalChallengeId;
  state.currentChallenge = { id: null, instanceIndex: -1, order: [], scoreAtStart: {}, startedAt: null, resolvedTrackId: null };
  if (wasFinal || maxReached) {
    state.phase = 'victory';
    log(state, 'GAME_ENDED', {});
  } else {
    state.phase = 'challenge_results';
  }
  return { ok: true };
}

function endQuestion(state) {
  pauseMusicAndTimer(state);
  // HOST_ACTIONS.reveal (RÉVÉLER / PASSER) calls this directly as a
  // mode-secours skip, possibly while a team is still locked in and never
  // actually judged: clear the lock rather than leaving it dangling, or
  // the host's answer panel (rendered off buzzer.lockedTeamId alone, see
  // buzzerFamilyHtml) would keep showing CORRECT/RATÉ for a question
  // that's already moved on to 'reveal', and marking it from there would
  // incorrectly flip the phase back.
  state.buzzer.lockedTeamId = null;
  state.phase = 'reveal';
  state.reveal.shown = true;
  log(state, 'QUESTION_ENDED', {});
}

function resolveAnswer(state, def, teamId, pointsAwarded) {
  // Every way a locked buzz gets resolved (the host marking it, or the
  // answer-timer itself expiring, see scheduleAnswerTimeout) funnels through
  // here, so this is the one place that needs to stop the pending timeout
  // rather than every caller remembering to.
  clearAnswerTimerHandle();
  state.answerTimer = { running: false, endsAt: null };
  if (pointsAwarded > 0) {
    applyScore(state, teamId, pointsAwarded, 'ANSWER_CORRECT');
    log(state, 'ANSWER_CORRECT', { teamId, points: pointsAwarded });
    // Clear the lock so the host's validate panel (which renders whenever
    // buzzer.lockedTeamId is set) disappears the instant the answer is
    // marked, instead of lingering through the reveal phase.
    state.buzzer.lockedTeamId = null;
    endQuestion(state);
    return;
  }
  log(state, 'ANSWER_WRONG', { teamId });
  if (def.wrongPenalty) {
    applyScore(state, teamId, -def.wrongPenalty, 'WRONG_ANSWER');
  }
  state.buzzer.lockedTeamId = null;
  if (!state.buzzer.wrongTeamIds.includes(teamId)) state.buzzer.wrongTeamIds.push(teamId);
  const remaining = state.teams.filter(t => t.connected > 0 && !state.buzzer.wrongTeamIds.includes(t.id));
  // remainingMs is only ever null when the clip's timer was never actually
  // running at the moment of the buzz (e.g. the buzzer was opened without
  // ever pressing ▶): treat that as "no info, assume there's time", the
  // same fallback resumeMusicAndTimer itself already uses.
  const timeLeft = state.playTimer.remainingMs == null || state.playTimer.remainingMs > 0;
  if (remaining.length > 0 && timeLeft) {
    state.buzzer.open = true;
    state.phase = 'question';
    // The song resumes exactly where the buzz paused it, not from the
    // start, and the play-timer clock picks back up with whatever time
    // was left rather than granting a fresh 30s.
    resumeMusicAndTimer(state);
  } else {
    endQuestion(state);
  }
}

// --- handlers keyed by message type ------------------------------------

const handlers = {};

handlers['join'] = (state, m, ws) => {
  if (!m.sessionId || !m.teamId) return { ok: false, msg: 'missing' };
  let existing = state.teams.find(t => t.sessionIds.includes(m.sessionId));
  if (existing) {
    ws.role = 'team'; ws.teamId = existing.id; ws.sessionId = m.sessionId;
    existing.connected++;
    log(state, 'TEAM_CONNECTED', { teamId: existing.id });
    return { ok: true, teamId: existing.id };
  }
  if (String(m.code) !== state.joinCode) return { ok: false, msg: 'bad_code' };
  const team = findTeam(state, m.teamId);
  if (!team) return { ok: false, msg: 'bad_team' };
  team.sessionIds.push(m.sessionId);
  team.connected++;
  ws.role = 'team'; ws.teamId = team.id; ws.sessionId = m.sessionId;
  log(state, 'JOIN', { teamId: team.id });
  return { ok: true, teamId: team.id };
};

function authTeam(state, ws, teamId) {
  if (ws.role !== 'team' || ws.teamId !== teamId) return null;
  const t = findTeam(state, teamId);
  if (!t || !t.sessionIds.includes(ws.sessionId)) return null;
  return t;
}

// Shared by the team-initiated profile edit (restricted to the curated
// palette, so the show always stays visually legible) and the host
// override (trusted, no palette restriction: an escape hatch for a
// name that needs fixing live).
function applyTeamProfile(state, team, name, color, opts) {
  opts = opts || {};
  if (!opts.freeColor) {
    const swatch = config.palette.find(p => p.color.toLowerCase() === String(color || '').toLowerCase());
    if (!swatch) return { ok: false, msg: 'bad_color' };
    const taken = state.teams.some(o => o.id !== team.id && o.customized && o.color.toLowerCase() === swatch.color.toLowerCase());
    if (taken) return { ok: false, msg: 'color_taken' };
    team.color = swatch.color;
    team.emoji = swatch.emoji;
  } else if (color) {
    team.color = color;
  }
  const clean = String(name || '').trim().slice(0, 18);
  if (clean) team.name = clean;
  team.customized = true;
  log(state, 'TEAM_RENAMED', { teamId: team.id, name: team.name, color: team.color });
  return { ok: true };
}

handlers['setTeamProfile'] = (state, m, ws) => {
  const t = authTeam(state, ws, m.teamId);
  if (!t) return { ok: false, msg: 'auth' };
  return applyTeamProfile(state, t, m.name, m.color);
};

handlers['buzz'] = (state, m, ws) => {
  const t = authTeam(state, ws, m.teamId);
  if (!t) return { ok: false, msg: 'auth' };
  if (!state.buzzer.open) return { ok: false, msg: 'closed' };
  if (state.buzzer.lockedTeamId) return { ok: false, msg: 'already_locked' };
  if (state.buzzer.wrongTeamIds.includes(t.id)) return { ok: false, msg: 'already_tried' };
  if (state.effects.silence[t.id]) return { ok: false, msg: 'silenced' };
  state.buzzer.open = false;
  state.buzzer.lockedTeamId = t.id;
  state.phase = 'buzzed';
  pauseMusicAndTimer(state);
  startAnswerTimer(state);
  log(state, 'BUZZ', { teamId: t.id });
  return { ok: true };
};

handlers['submitChoice'] = (state, m, ws) => {
  const t = authTeam(state, ws, m.teamId);
  if (!t) return { ok: false, msg: 'auth' };
  if (state.phase !== 'choice_active') return { ok: false, msg: 'not_active' };
  if (state.choices[t.id] != null) return { ok: false, msg: 'already_answered' };
  const inst = currentInstance(state);
  const idx = Number(m.optionIndex);
  if (!inst || !inst.options || !Number.isInteger(idx) || idx < 0 || idx >= inst.options.length) return { ok: false, msg: 'bad_option' };
  state.choices[t.id] = idx;
  log(state, 'CHOICE_SUBMITTED', { teamId: t.id });
  return { ok: true };
};

handlers['pickChallenge'] = (state, m, ws) => {
  const t = authTeam(state, ws, m.teamId);
  if (!t) return { ok: false, msg: 'auth' };
  if (!state.selection.active) return { ok: false, msg: 'not_selecting' };
  const def = challenges.getChallengeDef(m.challengeId);
  if (!def || def.implemented === false) return { ok: false, msg: 'bad_option' };

  if (state.selection.policy === 'duel') {
    const isFirst = t.id === state.selection.chooserTeamId;
    const isSecond = t.id === state.selection.secondChooserTeamId;
    if (!isFirst && !isSecond) return { ok: false, msg: 'not_chooser' };
    const validOptions = isFirst ? state.selection.options : state.selection.optionsB;
    if (!validOptions.includes(m.challengeId)) return { ok: false, msg: 'bad_option' };
    state.selection.duelPicks[t.id] = m.challengeId;
    log(state, 'CHALLENGE_PICKED', { teamId: t.id, challenge: m.challengeId });
    return { ok: true };
  }

  if (t.id !== state.selection.chooserTeamId) return { ok: false, msg: 'not_chooser' };
  if (!state.selection.options.includes(m.challengeId)) return { ok: false, msg: 'bad_option' };
  selection.recordChoice(state, t.id, m.challengeId);
  log(state, 'CHALLENGE_PICKED', { teamId: t.id, challenge: m.challengeId });
  beginChallenge(state, m.challengeId);
  return { ok: true };
};

handlers['panicSubmit'] = (state, m, ws) => {
  const t = authTeam(state, ws, m.teamId);
  if (!t) return { ok: false, msg: 'auth' };
  if (!state.panic.running || Date.now() > state.panic.endsAt) return { ok: false, msg: 'closed' };
  const text = String(m.text || '').trim().slice(0, 60);
  if (!text) return { ok: false, msg: 'empty' };
  if (!state.panic.submissions[t.id]) state.panic.submissions[t.id] = [];
  if (state.panic.submissions[t.id].length >= 30) return { ok: false, msg: 'too_many' };
  state.panic.submissions[t.id].push({ text, status: 'pending' });
  return { ok: true };
};

handlers['panicChallenge'] = (state, m, ws) => {
  const t = authTeam(state, ws, m.teamId);
  if (!t) return { ok: false, msg: 'auth' };
  if (state.phase !== 'panic_review') return { ok: false, msg: 'not_review' };
  const target = state.panic.submissions[m.targetTeamId];
  if (!target || !target[m.itemIndex] || t.id === m.targetTeamId) return { ok: false, msg: 'bad_item' };
  if (target[m.itemIndex].status === 'invalid') return { ok: false, msg: 'already_invalid' };
  const dup = state.panic.challenges.find(c => c.status === 'pending' && c.targetTeamId === m.targetTeamId && c.itemIndex === m.itemIndex);
  if (dup) return { ok: false, msg: 'already_challenged' };
  state.panic.challenges.push({
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    fromTeamId: t.id, targetTeamId: m.targetTeamId, itemIndex: m.itemIndex, status: 'pending'
  });
  log(state, 'CHALLENGE', { fromTeamId: t.id, targetTeamId: m.targetTeamId });
  return { ok: true };
};

handlers['betSet'] = (state, m, ws) => {
  const t = authTeam(state, ws, m.teamId);
  if (!t) return { ok: false, msg: 'auth' };
  if (state.phase !== 'final_betting') return { ok: false, msg: 'not_betting' };
  if (state.bets[t.id] && state.bets[t.id].locked) return { ok: false, msg: 'locked' };
  let amount = Math.floor(Number(m.amount));
  if (!Number.isFinite(amount) || amount < 0) amount = 0;
  amount = Math.min(amount, Math.max(0, t.score));
  const guess = (state.bets[t.id] && state.bets[t.id].guess) || '';
  state.bets[t.id] = { amount, locked: false, guess };
  return { ok: true };
};

// The bet AMOUNT alone never told the host what a team actually thought
// the answer was: verifying who "got it" required teams to say their
// guess out loud or on paper, which isn't private and can tip off other
// teams before the reveal. A typed guess travels through the same
// redaction as the rest of the bet object (projectBets hides the whole
// entry from other teams until reveal), so it's just as discreet as the
// amount already was.
//
// The guess field only appears once every team has locked their amount
// (final_guess, see beginFinalGuess): `locked` therefore only pins the
// wager now, not the guess, so it's deliberately NOT checked here the way
// betSet checks it for the amount.
handlers['betGuess'] = (state, m, ws) => {
  const t = authTeam(state, ws, m.teamId);
  if (!t) return { ok: false, msg: 'auth' };
  if (state.phase !== 'final_betting' && state.phase !== 'final_guess') return { ok: false, msg: 'not_betting' };
  const guess = String(m.text || '').slice(0, 80);
  const current = state.bets[t.id] || { amount: 0, locked: false };
  state.bets[t.id] = Object.assign({}, current, { guess });
  return { ok: true };
};

handlers['betLock'] = (state, m, ws) => {
  const t = authTeam(state, ws, m.teamId);
  if (!t) return { ok: false, msg: 'auth' };
  if (state.phase !== 'final_betting') return { ok: false, msg: 'not_betting' };
  const current = state.bets[t.id] || { amount: 0, locked: false, guess: '' };
  current.locked = true;
  state.bets[t.id] = current;
  log(state, 'BET_LOCKED', { teamId: t.id, amount: current.amount });
  const connected = state.teams.filter(x => x.connected > 0);
  const allLocked = connected.every(x => state.bets[x.id] && state.bets[x.id].locked);
  if (allLocked && connected.length > 0) beginFinalGuess(state);
  return { ok: true };
};

const POWER_HANDLERS = {
  double: (state, t) => { state.effects.double[t.id] = true; return { ok: true }; },
  shield: (state, t) => { state.effects.shield[t.id] = true; return { ok: true }; },
  oracle: (state, t) => {
    const inst = currentInstance(state);
    if (!inst) return { ok: false, msg: 'no_question' };
    // Nothing silently refused this before: a team could spend the card on
    // a question whose content never got a hint written in (most of the
    // catalog, in practice, see data/challenge-content.json) and get
    // nothing back for it, no error, card gone. Refusing means the card
    // stays in hand to try again on a question that actually has one,
    // instead of being wasted on an empty reveal.
    if (!inst.hint || !String(inst.hint).trim()) return { ok: false, msg: 'no_hint' };
    if (!state.oracleTeams.includes(t.id)) state.oracleTeams.push(t.id);
    return { ok: true };
  },
  silence: (state, t, targetTeamId) => {
    if (!targetTeamId || targetTeamId === t.id) return { ok: false, msg: 'bad_target' };
    if (consumeShieldIfAny(state, targetTeamId)) {
      log(state, 'SHIELD_BLOCKED', { targetTeamId });
      return { ok: true };
    }
    state.effects.silence[targetTeamId] = true;
    return { ok: true };
  },
  bomb: (state, t, targetTeamId) => {
    if (!targetTeamId || targetTeamId === t.id) return { ok: false, msg: 'bad_target' };
    if (!findTeam(state, targetTeamId)) return { ok: false, msg: 'bad_target' };
    if (consumeShieldIfAny(state, targetTeamId)) {
      log(state, 'SHIELD_BLOCKED', { targetTeamId });
      return { ok: true };
    }
    applyScore(state, targetTeamId, -2, 'BOMB');
    return { ok: true };
  },
  chaos: (state, t) => {
    const pick = config.chaos[Math.floor(Math.random() * config.chaos.length)];
    state.chaos.active = { id: pick.id, text: pick.text };
    log(state, 'CHAOS_TRIGGERED', { text: pick.text });
    return { ok: true };
  }
};

handlers['usePower'] = (state, m, ws) => {
  const t = authTeam(state, ws, m.teamId);
  if (!t) return { ok: false, msg: 'auth' };
  const card = t.powers.find(p => p.instId === m.instId);
  if (!card) return { ok: false, msg: 'no_card' };
  const def = currentChallengeDef(state);
  if (def && def.allowsPowers === false) return { ok: false, msg: 'powers_disabled' };
  if (def && def.allowedPowers && def.allowedPowers.length && !def.allowedPowers.includes(card.powerId)) return { ok: false, msg: 'power_not_allowed' };
  const fn = POWER_HANDLERS[card.powerId];
  if (!fn) return { ok: false, msg: 'unknown_power' };
  const result = fn(state, t, m.targetTeamId);
  if (!result.ok) return result;
  t.powers = t.powers.filter(p => p.instId !== m.instId);
  log(state, 'POWER_USED', { teamId: t.id, powerId: card.powerId, targetTeamId: m.targetTeamId || null });
  return { ok: true };
};

// Playing a track always guarantees the buzzer is live for challenges
// that use one, so the host never needs a separate "open buzzer" click.
// Used by HOST_ACTIONS.musicPlay/musicRestart below. Left alone while a
// team is already being judged (locked), and a no-op if the buzzer was
// already open, so it never fights the normal buzz/mark/reopen flow.
// musicPlay/musicRestart always mutate state (they also restart the play
// timer), so unlike before this no longer needs to manage its own undo
// snapshot: the normal dispatch snapshot covers it.
function ensureBuzzerOpenForPlayback(state, def) {
  if (!def || !def.usesBuzzer || state.buzzer.lockedTeamId || state.buzzer.open) return;
  state.buzzer.open = true;
  state.buzzer.openedAt = Date.now();
  state.phase = 'question';
  log(state, 'BUZZER_OPENED', { auto: true });
}

// --- host handlers -------------------------------------------------------

const HOST_ACTIONS = {
  configureGame: (state, m) => {
    // Always allowed, including mid-challenge: enabledChallengeIds/policy
    // are only read when a NEW selection begins, so tweaking them now
    // never disturbs whatever is currently being played.
    if (Array.isArray(m.enabledChallengeIds)) {
      // Zero is allowed here (the host's "Tout désélectionner" button needs
      // to actually reach an empty list before cherry-picking a few):
      // startSelection is what refuses to start a game with nothing
      // enabled, not this.
      state.setup.enabledChallengeIds = m.enabledChallengeIds.filter(id => { const d = challenges.getChallengeDef(id); return d && d.implemented !== false; });
    }
    if (m.selection) {
      Object.assign(state.setup.selection, {
        policy: m.selection.policy || state.setup.selection.policy,
        allowRepeat: !!m.selection.allowRepeat,
        comebackEnabled: !!m.selection.comebackEnabled,
        maxConsecutiveSelections: Math.max(1, Number(m.selection.maxConsecutiveSelections) || 1),
        optionsOffered: Math.max(2, Math.min(4, Number(m.selection.optionsOffered) || 3))
      });
    }
    if (m.maxChallenges) state.setup.maxChallenges = Math.max(1, Math.min(15, Number(m.maxChallenges)));
    if (m.targetDurationMinutes) state.setup.targetDurationMinutes = Math.max(5, Number(m.targetDurationMinutes));
    if (m.finalChallengeId) state.setup.finalChallengeId = m.finalChallengeId;
    if (m.maxPlaySeconds) state.setup.maxPlaySeconds = Math.max(5, Math.min(120, Number(m.maxPlaySeconds)));
    if (m.answerSeconds) state.setup.answerSeconds = Math.max(3, Math.min(60, Number(m.answerSeconds)));
    log(state, 'GAME_CONFIGURED', {});
    return { ok: true };
  },
  startSelection: (state) => {
    if (!state.setup.enabledChallengeIds.length) return { ok: false, msg: 'no_challenges_enabled' };
    const isFinalSlot = state.challengesPlayed >= state.setup.maxChallenges - 1 &&
      !state.selection.history.includes(state.setup.finalChallengeId) &&
      state.setup.enabledChallengeIds.includes(state.setup.finalChallengeId);
    if (isFinalSlot) {
      state.selection = Object.assign(state.selection, {
        active: true, policy: 'final', chooserTeamId: null, secondChooserTeamId: null,
        options: [state.setup.finalChallengeId], optionsB: [], duelPicks: {}
      });
      state.phase = 'selection';
      log(state, 'SELECTION_STARTED', { policy: 'final' });
      return { ok: true };
    }
    const result = selection.beginSelection(state);
    if (result.ok) { state.phase = 'selection'; log(state, 'SELECTION_STARTED', { policy: state.selection.policy }); }
    return result;
  },
  confirmAutoPick: (state) => {
    if (!state.selection.active || !['chaos', 'final'].includes(state.selection.policy)) return { ok: false, msg: 'not_auto' };
    const challengeId = state.selection.options[0];
    selection.recordChoice(state, null, challengeId);
    beginChallenge(state, challengeId);
    return { ok: true };
  },
  resolveDuel: (state, m) => {
    if (state.selection.policy !== 'duel' || !state.selection.active) return { ok: false, msg: 'not_duel' };
    if (!m.challengeId) return { ok: false, msg: 'missing' };
    selection.recordChoice(state, state.selection.chooserTeamId, m.challengeId);
    beginChallenge(state, m.challengeId);
    return { ok: true };
  },
  // Mode secours: lets the host start ANY enabled challenge directly,
  // whether or not a selection is in progress and whether or not it was
  // one of the offered options: the escape valve for "the chooser's
  // phone died" or "the selection UI is stuck, I'll just pick manually".
  forcePick: (state, m) => {
    const def = challenges.getChallengeDef(m.challengeId);
    if (!def || def.implemented === false || !state.setup.enabledChallengeIds.includes(m.challengeId)) return { ok: false, msg: 'bad_option' };
    selection.recordChoice(state, state.selection.chooserTeamId || null, m.challengeId);
    beginChallenge(state, m.challengeId);
    return { ok: true };
  },
  nextQuestion: (state) => nextChallengeQuestion(state),
  // Playback controls: the actual audio call is a side-effect on
  // whichever MusicSource is active (Spotify once connected, otherwise a
  // no-op manual source) and is fire-and-forget, so a flaky Spotify call
  // never blocks the game. Failures still need to reach the host though
  // (silently swallowing a 404 "device not found" is exactly what made a
  // stale Spotify device look connected while every play kept failing
  // with no visible symptom), reportMusicError below toasts the host and
  // rebroadcasts so a device MusicSource just dropped shows up as
  // "not ready" immediately instead of on the next 5s status poll.
  // play/pause/restart also drive the buzzer and the 30s play-timer
  // (state.playTimer), which ARE real state and get the normal undo
  // snapshot; only musicSeekBack has no state effect to snapshot, see
  // HOST_SNAPSHOT_SKIP below.
  //
  // The ▶ button is one control for two different intents: starting a
  // fresh clip, and resuming one that was paused (by the host's own ⏸,
  // or by a buzz). Only the caller knows which happened: a leftover
  // playTimer.remainingMs means something was paused and never spent, so
  // this continues it (resume, timer picks up where it left off) rather
  // than reloading the track from position 0 with a full fresh 30s.
  musicPlay: (state, m, ws) => {
    const def = currentChallengeDef(state);
    const track = currentTracks(state)[m.index || 0];
    if (!track) return { ok: false };
    syncTierToTrackIndex(state, def, m.index || 0);
    if (state.playTimer.remainingMs != null && state.playTimer.remainingMs > 0) {
      resumeMusicAndTimer(state, ws);
    } else {
      musicSource.getMusicSource().play(track).catch(err => reportMusicError(err, ws));
      startPlayTimerFresh(state);
    }
    ensureBuzzerOpenForPlayback(state, def);
    return { ok: true };
  },
  musicPause: (state, m, ws) => {
    pauseMusicAndTimer(state, ws);
    return { ok: true };
  },
  musicResume: (state, m, ws) => {
    resumeMusicAndTimer(state, ws);
    return { ok: true };
  },
  musicRestart: (state, m, ws) => {
    const def = currentChallengeDef(state);
    const track = currentTracks(state)[m.index || 0];
    if (track) musicSource.getMusicSource().play(track, { positionMs: 0 }).catch(err => reportMusicError(err, ws));
    syncTierToTrackIndex(state, def, m.index || 0);
    ensureBuzzerOpenForPlayback(state, def);
    startPlayTimerFresh(state);
    return { ok: true };
  },
  musicSeekBack: (state, m, ws) => {
    const src = musicSource.getMusicSource();
    const ms = Number(m.ms) || 3000;
    src.getCurrentPosition()
      .then(pos => src.seek(Math.max(0, (pos.positionMs || 0) - ms)))
      .catch(err => reportMusicError(err, ws));
    return { ok: true, noSnapshot: true };
  },
  disconnectSpotify: () => {
    spotifyAuth.disconnect();
    musicSource.setActiveDeviceId(null);
    return { ok: true, noSnapshot: true };
  },
  // Lets the host build content live from the Spotify search panel
  // instead of hand-editing challenge-content.json. Writes straight to
  // disk via lib/challenges.js (addTrack/addInstance), not `state`, so
  // there's nothing for undo to meaningfully revert; it still goes
  // through the normal snapshot path anyway (it does touch state.events
  // via log()), and failures must NOT be noSnapshot or the dispatcher
  // would return before ever calling sendError. The branching below
  // mirrors scripts/gen-challenge-
  // content.js's per-mode shapes exactly; that script stays the reference
  // if a new challenge mode is ever added and this needs updating too.
  addQuestion: (state, m) => {
    const def = challenges.getChallengeDef(m.challengeId);
    if (!def || def.implemented === false) return { ok: false, msg: 'bad_challenge' };
    const tracksIn = Array.isArray(m.tracks) ? m.tracks : [];
    const fields = m.fields || {};
    const n = challenges.nextInstanceNumber(m.challengeId);
    const prefix = (def.shortName || def.id).replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase() || 'Q';
    const instId = prefix + String(n).padStart(3, '0');
    // On failure this must NOT be noSnapshot: that flag makes the
    // dispatcher return before it ever calls sendError, so the host would
    // never learn why nothing happened. Only the success path skips the
    // snapshot (nothing on `state` changed, only the on-disk content).
    const fail = (msg) => ({ ok: false, msg });

    let inst = null;
    if (def.mode === 'buzzer_tiered' && def.multiTrack) {
      const need = (def.scoring && def.scoring.tiers || []).length || 3;
      if (tracksIn.length < need) return fail('need_more_tracks');
      const ids = tracksIn.slice(0, need).map(t => challenges.addTrack(t).id);
      inst = { id: instId, challenge: def.id, number: n, trackIds: ids, hint: fields.hint || '' };
    } else if (def.mode === 'buzzer_tiered') {
      if (!tracksIn[0]) return fail('need_track');
      const t = challenges.addTrack(tracksIn[0]);
      inst = { id: instId, challenge: def.id, number: n, trackId: t.id, hint: fields.hint || '' };
    } else if (def.mode === 'buzzer_compound') {
      if (def.id === 'cover_original') {
        if (!tracksIn[0]) return fail('need_track');
        if (!fields.extraOriginal) return fail('need_original_artist');
        const t = challenges.addTrack(tracksIn[0]);
        inst = { id: instId, challenge: def.id, number: n, trackId: t.id, extra: { original: fields.extraOriginal }, hint: fields.hint || '' };
      } else {
        if (!tracksIn[0]) return fail('need_track');
        const t = challenges.addTrack(tracksIn[0]);
        inst = { id: instId, challenge: def.id, number: n, trackId: t.id, hint: fields.hint || '' };
      }
    } else if (def.mode === 'choice') {
      if (!tracksIn[0]) return fail('need_track');
      const optionsCount = (def.scoring && def.scoring.optionsCount) || 4;
      const labels = (Array.isArray(fields.options) ? fields.options : []).map(l => String(l || '').trim()).filter(Boolean);
      if (labels.length < optionsCount) return fail('need_more_options');
      const t = challenges.addTrack(tracksIn[0]);
      const options = labels.slice(0, optionsCount).map(l => ({ label: l.slice(0, 80) }));
      const correctIndex = Math.max(0, Math.min(optionsCount - 1, Number(fields.correctIndex) || 0));
      inst = { id: instId, challenge: def.id, number: n, trackId: t.id, options, correctIndex, criterion: fields.criterion || '' };
    } else if (def.mode === 'panic') {
      inst = { id: instId, challenge: def.id, number: n, theme: fields.theme || '', durationSeconds: Number(fields.durationSeconds) || def.durationSeconds || 30 };
    } else if (def.mode === 'bet') {
      if (!tracksIn[0]) return fail('need_track');
      const t = challenges.addTrack(Object.assign({}, tracksIn[0], { genre: fields.genre || '' }));
      inst = { id: instId, challenge: def.id, number: n, trackId: t.id };
    } else if (def.mode === 'perform') {
      if (!tracksIn[0]) return fail('need_track');
      if (def.hasPrivatePayload && def.privatePayloadKind === 'banned_words') {
        const words = (Array.isArray(fields.bannedWords) ? fields.bannedWords : []).map(w => String(w || '').trim()).filter(Boolean);
        if (!words.length) return fail('need_banned_words');
        const t = challenges.addTrack(tracksIn[0]);
        inst = { id: instId, challenge: def.id, number: n, trackId: t.id, bannedWords: words };
      } else {
        const t = challenges.addTrack(tracksIn[0]);
        inst = { id: instId, challenge: def.id, number: n, trackId: t.id };
      }
    } else if (def.mode === 'buzzer' && def.multiTrack) {
      if (tracksIn.length < 2) return fail('need_more_tracks');
      const ids = tracksIn.map(t => challenges.addTrack(t).id);
      inst = { id: instId, challenge: def.id, number: n, trackIds: ids, link: fields.link || '', hint: fields.hint || '' };
    } else if (def.randomFromTags) {
      const category = fields.category || (def.categories || [])[0];
      if (!category) return fail('need_category');
      if (!tracksIn[0]) return fail('need_track');
      // Roulette draws randomly from the shared pool by tag at play time,
      // so "adding a question" here just means tagging a new track for
      // that category, there's no numbered instance to author.
      const t = challenges.addTrack(Object.assign({}, tracksIn[0], { tags: [category] }));
      log(state, 'TRACK_ADDED', { challenge: def.id, trackId: t.id, category });
      return { ok: true, trackId: t.id };
    } else if (def.hasPrivatePayload && def.privatePayloadKind === 'forbidden_word') {
      if (!tracksIn[0]) return fail('need_track');
      const words = (Array.isArray(fields.wordPool) ? fields.wordPool : []).map(w => String(w || '').trim()).filter(Boolean);
      if (!words.length) return fail('need_word_pool');
      const t = challenges.addTrack(tracksIn[0]);
      inst = { id: instId, challenge: def.id, number: n, trackId: t.id, wordPool: words };
    } else if (def.hasClue) {
      if (!tracksIn[0]) return fail('need_track');
      if (!fields.clue) return fail('need_clue');
      const t = challenges.addTrack(tracksIn[0]);
      inst = { id: instId, challenge: def.id, number: n, trackId: t.id, clue: fields.clue, hint: fields.hint || '' };
    } else {
      if (!tracksIn[0]) return fail('need_track');
      const t = challenges.addTrack(tracksIn[0]);
      inst = { id: instId, challenge: def.id, number: n, trackId: t.id, hint: fields.hint || '' };
    }

    challenges.addInstance(def.id, inst);
    log(state, 'QUESTION_ADDED', { challenge: def.id, instanceId: inst.id });
    return { ok: true, instanceId: inst.id };
  },
  skipChallenge: (state) => {
    if (!state.currentChallenge.id) return { ok: false, msg: 'no_challenge' };
    log(state, 'CHALLENGE_SKIPPED', { challenge: state.currentChallenge.id });
    return endCurrentChallenge(state);
  },
  openBuzzer: (state) => {
    const def = currentChallengeDef(state);
    if (!def || !def.usesBuzzer) return { ok: false, msg: 'wrong_mode' };
    state.buzzer.open = true;
    state.buzzer.lockedTeamId = null;
    state.buzzer.openedAt = Date.now();
    state.phase = 'question';
    startPlayTimerFresh(state);
    log(state, 'BUZZER_OPENED', {});
    return { ok: true };
  },
  closeBuzzer: (state) => {
    state.buzzer.open = false;
    log(state, 'BUZZER_CLOSED', {});
    return { ok: true };
  },
  advanceTier: (state) => {
    const def = currentChallengeDef(state);
    if (!def || def.mode !== 'buzzer_tiered') return { ok: false, msg: 'wrong_mode' };
    // Time-tiered challenges (five_seconds) advance on their own from real
    // elapsed playback time now, see scheduleTierAdvance; a manual bump
    // here would just fight that schedule and desync from what's actually
    // playing. Track-tiered ones (whos_next, "Morceau 1/2/3") have no
    // seconds thresholds and still rely entirely on this manual action.
    if (timeTieredScoring(def)) return { ok: false, msg: 'auto_tiered' };
    // A team locked in mid-answer is being judged against the tier that
    // was active when they buzzed; advancing it now would silently change
    // the point value markAnswer awards once the host validates them.
    if (state.buzzer.lockedTeamId) return { ok: false, msg: 'buzzer_locked' };
    const max = ((def.scoring && def.scoring.tiers) || []).length - 1;
    state.buzzer.tierIndex = Math.min(max, (state.buzzer.tierIndex || 0) + 1);
    log(state, 'TIER_ADVANCED', { tierIndex: state.buzzer.tierIndex });
    return { ok: true };
  },
  markAnswer: (state, m) => {
    const def = currentChallengeDef(state);
    if (!def) return { ok: false, msg: 'no_challenge' };
    if (!m.teamId || state.buzzer.lockedTeamId !== m.teamId) return { ok: false, msg: 'not_locked' };
    let points = 0;
    if (def.mode === 'buzzer_compound') {
      const parts = def.scoring.parts;
      let sum = 0, allCorrect = true;
      parts.forEach(p => {
        const got = !!(m.parts && m.parts[p.key]);
        if (got) sum += p.points; else allCorrect = false;
      });
      points = (allCorrect && def.scoring.allBonus != null) ? def.scoring.allBonus : sum;
    } else if (def.mode === 'buzzer_tiered') {
      const tiers = def.scoring.tiers;
      const idx = Math.max(0, Math.min(tiers.length - 1, state.buzzer.tierIndex || 0));
      points = m.correct ? tiers[idx].points : 0;
    } else {
      points = m.correct ? ((def.scoring && def.scoring.points) || 1) : 0;
    }
    resolveAnswer(state, def, m.teamId, points);
    return { ok: true };
  },
  reveal: (state) => { endQuestion(state); return { ok: true }; },
  revealChoices: (state) => {
    const def = currentChallengeDef(state);
    const inst = currentInstance(state);
    if (!def || def.mode !== 'choice' || !inst) return { ok: false, msg: 'wrong_mode' };
    state.phase = 'choice_reveal';
    state.reveal.shown = true;
    const correctIndex = inst.correctIndex;
    const points = (def.scoring && def.scoring.correctPoints) || 1;
    state.teams.filter(t => t.connected > 0).forEach(t => {
      const picked = state.choices[t.id];
      if (picked === correctIndex) { applyScore(state, t.id, points, 'CHOICE_CORRECT'); log(state, 'ANSWER_CORRECT', { teamId: t.id, points }); }
      else if (picked != null) log(state, 'ANSWER_WRONG', { teamId: t.id });
    });
    log(state, 'QUESTION_ENDED', {});
    return { ok: true };
  },
  awardBonus: (state, m) => {
    const def = currentChallengeDef(state);
    if (!def || !def.hasBonusStep) return { ok: false, msg: 'no_bonus' };
    const t = findTeam(state, m.teamId);
    if (!t) return { ok: false, msg: 'bad_team' };
    applyScore(state, t.id, def.bonusPoints || 1, 'BONUS');
    return { ok: true };
  },
  // Shared by both private-payload kinds: CHANSON INTERDITE (a team must
  // not buzz on its secret word) and NE DIS PAS LE TITRE (the performer
  // must not say a banned word), same penalty mechanism, just a different
  // reason the host is watching for.
  markViolation: (state, m) => {
    const def = currentChallengeDef(state);
    if (!def || !def.hasPrivatePayload) return { ok: false, msg: 'no_payload' };
    const t = findTeam(state, m.teamId);
    if (!t) return { ok: false, msg: 'bad_team' };
    if (consumeShieldIfAny(state, t.id)) { log(state, 'SHIELD_BLOCKED', { targetTeamId: t.id }); return { ok: true }; }
    applyScore(state, t.id, -(def.violationPenalty || 2), 'PRIVATE_PAYLOAD_VIOLATION');
    return { ok: true };
  },
  startPerformTimer: (state, m) => {
    const def = currentChallengeDef(state);
    if (!def || def.mode !== 'perform') return { ok: false, msg: 'wrong_mode' };
    const seconds = Math.max(5, Math.min(180, Number(m.seconds) || def.durationSeconds || 60));
    state.performTimer = { running: true, endsAt: Date.now() + seconds * 1000 };
    log(state, 'PERFORM_TIMER_STARTED', { seconds });
    schedulePerformEnd(seconds * 1000);
    return { ok: true };
  },
  award: (state, m) => {
    const t = findTeam(state, m.teamId);
    if (!t) return { ok: false, msg: 'bad_team' };
    const delta = Math.max(-50, Math.min(50, Math.floor(Number(m.delta)) || 0));
    t.score += delta;
    log(state, 'SCORE_CHANGED', { teamId: t.id, delta, reason: 'manual' });
    return { ok: true };
  },
  renameTeam: (state, m) => {
    const t = findTeam(state, m.teamId);
    if (!t) return { ok: false, msg: 'bad_team' };
    return applyTeamProfile(state, t, m.name, m.color, { freeColor: true });
  },
  grantPower: (state, m) => {
    if (!findTeam(state, m.teamId)) return { ok: false, msg: 'bad_team' };
    addPowerCard(state, m.teamId, m.powerId);
    return { ok: true };
  },
  revokePower: (state, m) => {
    const t = findTeam(state, m.teamId);
    if (!t) return { ok: false, msg: 'bad_team' };
    t.powers = t.powers.filter(p => p.instId !== m.instId);
    log(state, 'POWER_REVOKED', { teamId: t.id });
    return { ok: true };
  },
  triggerChaos: (state) => POWER_HANDLERS.chaos(state, {}),
  clearChaos: (state) => { state.chaos.active = null; return { ok: true }; },
  startPanicTimer: (state, m) => {
    const def = currentChallengeDef(state);
    if (!def || def.mode !== 'panic') return { ok: false, msg: 'wrong_mode' };
    const seconds = Math.max(5, Math.min(120, Number(m.seconds) || def.durationSeconds || 30));
    state.panic.running = true;
    state.panic.endsAt = Date.now() + seconds * 1000;
    state.panic.submissions = {};
    state.panic.challenges = [];
    state.phase = 'panic_running';
    log(state, 'PANIC_STARTED', { seconds });
    schedulePanicEnd(seconds * 1000);
    return { ok: true };
  },
  endPanicNow: (state) => { endPanic(state); return { ok: true }; },
  markPanicItem: (state, m) => {
    if (state.phase !== 'panic_review') return { ok: false, msg: 'not_review' };
    const def = currentChallengeDef(state);
    const list = state.panic.submissions[m.teamId];
    if (!list || !list[m.itemIndex]) return { ok: false, msg: 'bad_item' };
    const item = list[m.itemIndex];
    const wasValid = item.status === 'valid';
    item.status = m.valid ? 'valid' : 'invalid';
    if (!wasValid && item.status === 'valid') applyScore(state, m.teamId, def.pointsPerItem, 'PANIC_ITEM');
    if (wasValid && item.status !== 'valid') applyScore(state, m.teamId, -def.pointsPerItem, 'PANIC_ITEM_UNDO');
    return { ok: true };
  },
  resolveChallenge: (state, m) => {
    const def = currentChallengeDef(state);
    const ch = state.panic.challenges.find(c => c.id === m.challengeId);
    if (!ch || ch.status !== 'pending') return { ok: false, msg: 'bad_challenge' };
    ch.status = m.accept ? 'accepted' : 'rejected';
    if (m.accept) {
      const item = state.panic.submissions[ch.targetTeamId][ch.itemIndex];
      if (item.status === 'valid') applyScore(state, ch.targetTeamId, -def.pointsPerItem, 'CHALLENGE_WIN_REVERT');
      item.status = 'invalid';
      applyScore(state, ch.fromTeamId, def.challengeCorrect, 'CHALLENGE_WIN');
    } else {
      applyScore(state, ch.fromTeamId, def.challengeWrong, 'CHALLENGE_LOSE');
    }
    log(state, 'CHALLENGE_RESOLVED', { challengeId: ch.id, accept: !!m.accept });
    return { ok: true };
  },
  // Mode secours: force the reveal from either final_betting (any
  // still-unlocked bets get force-locked as before) or final_guess (cuts
  // the 30s guessing window short) straight to final_reveal.
  startFinalReveal: (state) => {
    clearFinalGuessTimer();
    state.teams.forEach(t => {
      if (!state.bets[t.id] || !state.bets[t.id].locked) {
        const prev = state.bets[t.id];
        state.bets[t.id] = { amount: (prev && prev.amount) || 0, locked: true, guess: (prev && prev.guess) || '' };
        log(state, 'BET_LOCKED', { teamId: t.id, amount: state.bets[t.id].amount, forced: true });
      }
    });
    pauseMusicAndTimer(state);
    state.phase = 'final_reveal';
    state.reveal.shown = true;
    log(state, 'QUESTION_ENDED', {});
    return { ok: true };
  },
  markBet: (state, m) => {
    const bet = state.bets[m.teamId];
    if (!bet || bet.resolved) return { ok: false, msg: 'bad_bet' };
    bet.resolved = true;
    bet.correct = !!m.correct;
    const delta = m.correct ? bet.amount : -bet.amount;
    if (delta !== 0) applyScore(state, m.teamId, delta, m.correct ? 'BET_WIN' : 'BET_LOSE');
    log(state, m.correct ? 'ANSWER_CORRECT' : 'ANSWER_WRONG', { teamId: m.teamId, bet: bet.amount });
    return { ok: true };
  },
  endGame: (state) => { state.phase = 'victory'; log(state, 'GAME_ENDED', {}); return { ok: true }; },
  reset: () => { store.resetState(); undoStack = []; return { ok: true, noSnapshot: true }; },
  // Demo runs asynchronously (setTimeout-scheduled) and manages store state
  // itself across many ticks; noSnapshot tells the dispatcher to skip its
  // normal post-call store.setState(state), which would otherwise stomp
  // the demo's already-progressed state with the stale pre-call snapshot.
  startDemo: (state) => { const demo = require('./demo'); demo.start(state, { HOST_ACTIONS }); return { ok: true, noSnapshot: true }; },
  stopDemo: () => { const demo = require('./demo'); demo.stop(); return { ok: true, noSnapshot: true }; }
};

function schedulePanicEnd(ms) {
  if (panicTimer) clearTimeout(panicTimer);
  panicTimer = setTimeout(() => {
    const state = store.getState();
    if (state.panic.running) {
      endPanic(state);
      store.setState(state);
      if (typeof global.__mmBroadcast === 'function') global.__mmBroadcast();
    }
  }, ms + 50);
}

function endPanic(state) {
  state.panic.running = false;
  state.phase = 'panic_review';
  log(state, 'PANIC_ENDED', {});
}

function schedulePerformEnd(ms) {
  if (performTimer) clearTimeout(performTimer);
  performTimer = setTimeout(() => {
    const state = store.getState();
    if (state.performTimer && state.performTimer.running) {
      state.performTimer.running = false;
      log(state, 'PERFORM_TIMER_ENDED', {});
      store.setState(state);
      if (typeof global.__mmBroadcast === 'function') global.__mmBroadcast();
    }
  }, ms + 50);
}

// --- answer timer: how long a team gets to speak once they've buzzed -----
// Every buzzer-family challenge shares this: the host used to just wait as
// long as it took to mark CORRECT/RATÉ, with nothing forcing a decision.
// A team that buzzes still answers out loud, so the timer can't grade the
// answer itself, only enforce the deadline: if nobody has marked it by the
// time it expires, it's auto-resolved as wrong (0 points, same path a
// manual "RATÉ" takes), the buzzer reopens for the rest, and the clock
// keeps counting down toward the next team's turn. A host who marks it
// first (the normal case) reaches resolveAnswer first, which clears this
// timer itself.
function clearAnswerTimerHandle() {
  if (answerTimerHandle) { clearTimeout(answerTimerHandle); answerTimerHandle = null; }
}

function startAnswerTimer(state) {
  clearAnswerTimerHandle();
  const seconds = state.setup.answerSeconds || 15;
  state.answerTimer = { running: true, endsAt: Date.now() + seconds * 1000 };
  answerTimerHandle = setTimeout(() => {
    const live = store.getState();
    const teamId = live.buzzer.lockedTeamId;
    // The question (RÉVÉLER/PASSER) or the whole challenge (SKIP CHALLENGE)
    // can move on without this buzz ever being judged: only auto-resolve
    // while still genuinely mid-answer (phase 'buzzed'), never retroactively
    // mutate a phase the host has already left behind (e.g. flipping
    // 'challenge_results' back to 'question' from a timer nobody asked for
    // anymore).
    if (!live.answerTimer.running || live.phase !== 'buzzed' || !teamId) return;
    const def = currentChallengeDef(live);
    if (def) resolveAnswer(live, def, teamId, 0);
    store.setState(live);
    if (typeof global.__mmBroadcast === 'function') global.__mmBroadcast();
  }, seconds * 1000 + 50);
}

// --- LE PARI FINAL: the guessing window after every bet is locked -------
// Betting used to jump straight from "everyone locked their wager" to the
// full reveal, with no chance to actually listen and guess the title: the
// bet amount was the whole game. Now, once every connected team has locked
// their amount (see handlers['betLock']), this starts the track (through
// the same MusicSource/playTimer machinery every buzzer challenge already
// uses to cap playback and show a countdown, see usesPlayTimer) and gives
// everyone durationSeconds (data/challenges.json's final_bet.maxPlaySeconds)
// to type a guess at the title (handlers['betGuess'], now allowed during
// this phase regardless of the amount being locked). This timer is
// deliberately independent of the play-timer's own end-of-clip handler
// (schedulePlayTimerEnd): that one only knows how to pause playback, this
// one is the thing that actually moves the game on to final_reveal.
function beginFinalGuess(state) {
  state.phase = 'final_guess';
  const def = currentChallengeDef(state);
  const track = currentTracks(state)[0];
  if (track) musicSource.getMusicSource().play(track).catch(err => reportMusicError(err));
  startPlayTimerFresh(state);
  const seconds = (def && def.maxPlaySeconds) || state.setup.maxPlaySeconds || 30;
  log(state, 'FINAL_GUESS_STARTED', { seconds });
  scheduleFinalGuessEnd(seconds * 1000);
}

function clearFinalGuessTimer() {
  if (finalGuessTimer) { clearTimeout(finalGuessTimer); finalGuessTimer = null; }
}

function scheduleFinalGuessEnd(ms) {
  clearFinalGuessTimer();
  // Fires just after the play-timer's own auto-pause (ms + 50), so
  // playback has already stopped by the time this ends the round.
  finalGuessTimer = setTimeout(() => {
    const state = store.getState();
    if (state.phase === 'final_guess') {
      finishFinalGuess(state);
      store.setState(state);
      if (typeof global.__mmBroadcast === 'function') global.__mmBroadcast();
    }
  }, ms + 100);
}

function finishFinalGuess(state) {
  pauseMusicAndTimer(state);
  state.phase = 'final_reveal';
  state.reveal.shown = true;
  log(state, 'QUESTION_ENDED', {});
}

// --- dispatch ------------------------------------------------------------

const HOST_SNAPSHOT_SKIP = new Set(['reset', 'musicSeekBack', 'disconnectSpotify']);

function handleMessage(ws, raw, broadcast) {
  global.__mmBroadcast = broadcast;
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  const state = store.getState();

  if (m.type === 'hello') {
    ws.role = m.role === 'host' && ws.isHost ? 'host' : (m.role === 'screen' ? 'screen' : ws.role);
    broadcast();
    return;
  }

  if (m.type === 'join') {
    const result = handlers.join(state, m, ws);
    store.setState(state);
    broadcast();
    if (!result.ok) sendError(ws, result.msg);
    return;
  }

  // The Screen tab reports itself as the active Spotify Connect device
  // once its embedded Web Playback SDK player comes online (see
  // public/js/screen.js). No game-state change, no broadcast needed.
  if (m.type === 'screen:spotifyDevice' && ws.role === 'screen') {
    musicSource.setActiveDeviceId(m.deviceId || null);
    return;
  }

  if (typeof m.type === 'string' && m.type.indexOf('host:') === 0) {
    if (!ws.isHost) { sendError(ws, 'not_host'); return; }
    const action = m.type.slice(5);
    if (action === 'undo') {
      if (undoStack.length > 0) {
        const prev = undoStack.pop();
        log(prev, 'UNDO', {});
        store.setState(prev);
      }
      broadcast();
      return;
    }
    const fn = HOST_ACTIONS[action];
    if (!fn) return;
    if (!HOST_SNAPSHOT_SKIP.has(action)) {
      undoStack.push(clone(state));
      if (undoStack.length > config.maxUndoDepth) undoStack.shift();
    }
    const result = fn(state, m, ws);
    if (result && result.noSnapshot) { broadcast(); return; }
    store.setState(state);
    broadcast();
    if (result && !result.ok) sendError(ws, result.msg);
    return;
  }

  const fn = handlers[m.type];
  if (fn) {
    const result = fn(state, m, ws);
    store.setState(state);
    broadcast();
    if (!result.ok) sendError(ws, result.msg);
  }
}

function sendError(ws, msg) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', msg })); } catch (e) {}
}

function onClose(ws) {
  if (ws.teamId) {
    const state = store.getState();
    const t = findTeam(state, ws.teamId);
    if (t) t.connected = Math.max(0, t.connected - 1);
    store.setState(state);
  }
}

module.exports = { handleMessage, onClose, currentChallengeDef, currentInstance, effectiveTrackId, beginChallenge };
