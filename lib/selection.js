// Decides who picks the next challenge and which options they're offered.
// Every policy narrows down to the same shape (a chooser + up to
// `optionsOffered` candidate challenge ids) except 'chaos' (no chooser,
// the system just picks one) and 'duel' (two choosers, host resolves).
const challenges = require('./challenges');

function connectedTeams(state) {
  return state.teams.filter(t => t.connected > 0);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function scoreOf(t) { return t.score; }

function teamWithHighestScore(teams) {
  if (!teams.length) return null;
  return teams.reduce((best, t) => (scoreOf(t) > scoreOf(best) ? t : best), teams[0]);
}
function teamWithLowestScore(teams) {
  if (!teams.length) return null;
  return teams.reduce((worst, t) => (scoreOf(t) < scoreOf(worst) ? t : worst), teams[0]);
}
function teamWithHighestDelta(state, teams) {
  const start = (state.currentChallenge && state.currentChallenge.scoreAtStart) || {};
  let best = null, bestDelta = -Infinity;
  teams.forEach(t => {
    const delta = t.score - (start[t.id] != null ? start[t.id] : t.score);
    if (delta > bestDelta) { bestDelta = delta; best = t; }
  });
  return best;
}

// Picks eligible challenge ids: enabled for this game, implemented,
// respecting allowRepeat (falls back to allowing repeats if the pool
// would otherwise be empty, so the game never gets stuck). The
// finalChallengeId is deliberately excluded here: it's reserved for the
// forced final slot (see HOST_ACTIONS.startSelection's isFinalSlot
// check, which bypasses this pool entirely), so it must never also turn
// up as a normal offered option earlier in the game.
function eligiblePool(state) {
  const enabledIds = state.setup.enabledChallengeIds;
  const pool = challenges.getEnabledChallenges(enabledIds).filter(c => c.id !== state.setup.finalChallengeId);
  const played = new Set(state.selection.history);
  if (!state.setup.selection.allowRepeat) {
    const notPlayed = pool.filter(c => !played.has(c.id));
    if (notPlayed.length > 0) return notPlayed;
  }
  return pool;
}

function pickOptions(state, count) {
  const pool = eligiblePool(state);
  return shuffle(pool).slice(0, Math.min(count, pool.length)).map(c => c.id);
}

// Guarantees the last-place team a turn to choose at least once every 3
// challenges when comebackEnabled: a simple, predictable comeback rule.
function comebackOverride(state, teams) {
  const cfg = state.setup.selection;
  if (!cfg.comebackEnabled || teams.length < 2) return null;
  const last = teamWithLowestScore(teams);
  if (!last) return null;
  const since = state.challengesPlayed - (state.selection.lastChoseAt[last.id] || -Infinity);
  return since >= 3 ? last : null;
}

// Prevents the same team from choosing more than maxConsecutiveSelections
// times in a row by falling back to the next-best candidate.
function respectMaxConsecutive(state, candidate, teams, fallbackFn) {
  const cfg = state.setup.selection;
  if (!candidate) return candidate;
  const consec = state.selection.consecutiveCount[candidate.id] || 0;
  if (consec < cfg.maxConsecutiveSelections) return candidate;
  const others = teams.filter(t => t.id !== candidate.id);
  return fallbackFn(others) || candidate;
}

function beginSelection(state) {
  const teams = connectedTeams(state);
  if (!teams.length) return { ok: false, msg: 'no_teams' };
  const policy = state.setup.selection.policy;
  const optionsCount = state.setup.selection.optionsOffered || 3;

  if (policy === 'chaos') {
    const options = pickOptions(state, 1);
    state.selection = Object.assign(state.selection, {
      active: true, policy, chooserTeamId: null, secondChooserTeamId: null,
      options, duelPicks: {}
    });
    return { ok: true };
  }

  if (policy === 'duel') {
    const sorted = [...teams].sort((a, b) => b.score - a.score);
    const first = sorted[0], second = sorted[1] || sorted[0];
    state.selection = Object.assign(state.selection, {
      active: true, policy,
      chooserTeamId: first.id, secondChooserTeamId: second.id !== first.id ? second.id : null,
      options: pickOptions(state, optionsCount),
      optionsB: pickOptions(state, optionsCount),
      duelPicks: {}
    });
    return { ok: true };
  }

  let chooser = comebackOverride(state, teams);
  if (!chooser) {
    if (policy === 'last') chooser = teamWithLowestScore(teams);
    else if (policy === 'roulette') chooser = shuffle(teams)[0];
    else chooser = teamWithHighestDelta(state, teams) || teamWithHighestScore(teams); // 'winner' (default)
  }
  chooser = respectMaxConsecutive(state, chooser, teams, (others) => {
    if (policy === 'last') return teamWithLowestScore(others);
    if (policy === 'roulette') return shuffle(others)[0];
    return teamWithHighestScore(others);
  });

  state.selection = Object.assign(state.selection, {
    active: true, policy, chooserTeamId: chooser ? chooser.id : null, secondChooserTeamId: null,
    options: pickOptions(state, optionsCount), duelPicks: {}
  });
  return { ok: true };
}

function recordChoice(state, teamId, challengeId) {
  state.selection.consecutiveCount = state.selection.consecutiveCount || {};
  state.selection.lastChoseAt = state.selection.lastChoseAt || {};
  if (teamId) {
    Object.keys(state.selection.consecutiveCount).forEach(id => {
      if (id !== teamId) state.selection.consecutiveCount[id] = 0;
    });
    state.selection.consecutiveCount[teamId] = (state.selection.consecutiveCount[teamId] || 0) + 1;
    state.selection.lastChoseAt[teamId] = state.challengesPlayed;
  }
  state.selection.history.push(challengeId);
  state.selection.active = false;
}

module.exports = { beginSelection, recordChoice, eligiblePool, connectedTeams };
