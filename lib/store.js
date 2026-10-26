// Loads static content (config) and owns the authoritative game state:
// creating it fresh, persisting it to disk, and restoring it on boot so a
// crashed/restarted server doesn't lose an in-progress party.
const fs = require('fs');
const path = require('path');
const challenges = require('./challenges');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SAVE_FILE = path.join(DATA_DIR, 'save.json');

const config = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));

function genCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function freshTeams() {
  return config.teams.map(t => ({
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    color: t.color,
    customized: false,
    score: 0,
    connected: 0,
    sessionIds: [],
    powers: []
  }));
}

function defaultEnabledChallengeIds() {
  return challenges.catalog.filter(c => c.implemented !== false && c.enabledByDefault).map(c => c.id);
}

function freshSetup() {
  return {
    enabledChallengeIds: defaultEnabledChallengeIds(),
    selection: {
      policy: config.selection.policy,
      allowRepeat: config.selection.allowRepeat,
      comebackEnabled: config.selection.comebackEnabled,
      maxConsecutiveSelections: config.selection.maxConsecutiveSelections,
      optionsOffered: config.selection.optionsOffered
    },
    targetDurationMinutes: config.game.targetDurationMinutes,
    maxChallenges: config.game.maxChallenges,
    finalChallengeId: config.game.finalChallengeId,
    maxPlaySeconds: config.game.maxPlaySeconds || 30,
    answerSeconds: config.game.answerSeconds || 15
  };
}

function makeState() {
  return {
    gameId: 'g' + Date.now().toString(36),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    joinCode: genCode(),
    phase: 'lobby',
    teams: freshTeams(),
    setup: freshSetup(),
    selection: {
      active: false, policy: '', chooserTeamId: null, secondChooserTeamId: null,
      options: [], optionsB: [], duelPicks: {}, history: [], consecutiveCount: {}, lastChoseAt: {}
    },
    currentChallenge: { id: null, instanceIndex: -1, order: [], scoreAtStart: {}, startedAt: null },
    challengesPlayed: 0,
    roundResult: null,
    privateAssignments: {},
    choices: {},
    buzzer: { open: false, lockedTeamId: null, wrongTeamIds: [], openedAt: null },
    answerTimer: { running: false, endsAt: null },
    playTimer: { running: false, endsAt: null, remainingMs: null, positionMs: null, segStartedAt: null, segStartPositionMs: null },
    reveal: { shown: false },
    effects: { silence: {}, shield: {}, double: {} },
    chaos: { active: null },
    panic: { running: false, endsAt: null, submissions: {}, challenges: [] },
    bets: {},
    oracleTeams: [],
    finalRevealed: false,
    events: [],
    demoRunning: false,
    powerCardsIssued: 0
  };
}

let state = load() || makeState();
let saveTimer = null;

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(SAVE_FILE, JSON.stringify(state));
    } catch (e) {
      console.error('save failed', e.message);
    }
  }, 400);
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    if (!raw || !raw.gameId || !raw.setup) return null; // stale pre-challenge-engine save, start fresh
    // Migrate a save written before the play-timer feature (or its later
    // positionMs field) existed, rather than discarding an in-progress
    // party over new fields.
    if (!raw.playTimer) raw.playTimer = { running: false, endsAt: null, remainingMs: null, positionMs: null, segStartedAt: null, segStartPositionMs: null };
    else {
      if (raw.playTimer.positionMs === undefined) raw.playTimer.positionMs = null;
      if (raw.playTimer.segStartedAt === undefined) raw.playTimer.segStartedAt = null;
      if (raw.playTimer.segStartPositionMs === undefined) raw.playTimer.segStartPositionMs = null;
    }
    if (raw.setup.maxPlaySeconds == null) raw.setup.maxPlaySeconds = config.game.maxPlaySeconds || 30;
    if (raw.setup.answerSeconds == null) raw.setup.answerSeconds = config.game.answerSeconds || 15;
    if (!raw.answerTimer) raw.answerTimer = { running: false, endsAt: null };
    if (raw.roundResult === undefined) raw.roundResult = null;
    return raw;
  } catch (e) {
    console.error('load failed', e.message);
    return null;
  }
}

function getState() { return state; }
function setState(next) { state = next; state.updatedAt = Date.now(); persist(); }
function resetState() { state = makeState(); persist(); return state; }

module.exports = {
  config, getState, setState, resetState, persist, genCode
};
