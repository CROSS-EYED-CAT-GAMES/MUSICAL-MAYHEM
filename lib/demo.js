// Scripted automatic playthrough so the organizer can verify the whole
// challenge engine solo (selection, every answer mode, powers, betting)
// without extra phones. Bypasses per-message auth on purpose: it is only
// reachable via host:startDemo, which already requires a valid host key.
//
// Uses real async/await against the same HOST_ACTIONS the live game uses
// (fire-and-forget from host:startDemo, which returns immediately) rather
// than a hand-rolled setTimeout queue, because the selection outcome is
// dynamic: which challenge plays next isn't known until the simulated
// pick happens, so a flat pre-built queue can't express it.
const store = require('./store');
const selection = require('./selection');
const challenges = require('./challenges');

let running = false;
let generation = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function broadcastNow() { if (typeof global.__mmBroadcast === 'function') global.__mmBroadcast(); }

function start(_state, api) {
  stop();
  const myGen = ++generation;
  running = true;

  store.resetState();
  const fresh = store.getState();
  fresh.demoRunning = true;
  fresh.teams.slice(0, 5).forEach(t => { t.connected = 1; t.sessionIds = ['demo-' + t.id]; });
  store.setState(fresh);
  broadcastNow();

  runDemo(api, myGen).catch(e => console.error('demo failed:', e.message));
}

function stop() {
  generation++; // invalidates any in-flight loop's "still my run" checks
  running = false;
  const s = store.getState();
  if (s.demoRunning) { s.demoRunning = false; store.setState(s); }
}

function alive(myGen) { return running && myGen === generation; }

async function runDemo(api, myGen) {
  api.HOST_ACTIONS.configureGame(store.getState(), { maxChallenges: 4 });
  store.persist();
  broadcastNow();
  await sleep(500);

  while (alive(myGen)) {
    let s = store.getState();
    if (s.phase === 'victory') break;

    api.HOST_ACTIONS.startSelection(store.getState());
    broadcastNow();
    await sleep(800);
    if (!alive(myGen)) return;
    await runSelectionPick(api);
    await sleep(700);
    if (!alive(myGen)) return;

    s = store.getState();
    const def = challenges.getChallengeDef(s.currentChallenge.id);
    if (!def) break;
    if (def.mode === 'bet') await runBetChallenge(api, myGen);
    else if (def.mode === 'panic') await runPanicChallenge(api, myGen);
    else if (def.mode === 'choice') await runChoiceChallenge(api, myGen);
    else if (def.mode === 'perform') await runPerformChallenge(api, def, myGen);
    else await runBuzzerChallenge(api, myGen);
    if (!alive(myGen)) return;
  }

  const s = store.getState();
  if (alive(myGen) && s.phase !== 'victory') { api.HOST_ACTIONS.endGame(store.getState()); broadcastNow(); }
  if (s.demoRunning) { s.demoRunning = false; store.setState(s); broadcastNow(); }
  running = false;
}

async function runSelectionPick(api) {
  const s = store.getState();
  const sel = s.selection;
  if (!sel.active) return;
  if (sel.policy === 'chaos' || sel.policy === 'final') {
    api.HOST_ACTIONS.confirmAutoPick(store.getState());
  } else if (sel.policy === 'duel') {
    const pickA = pick(sel.options);
    const pickB = pick(sel.optionsB.length ? sel.optionsB : sel.options);
    s.selection.duelPicks[sel.chooserTeamId] = pickA;
    s.selection.duelPicks[sel.secondChooserTeamId] = pickB;
    store.setState(s);
    broadcastNow();
    await sleep(300);
    // resolveDuel is the only place that calls recordChoice for a duel,
    // it both records the pick and starts the challenge.
    api.HOST_ACTIONS.resolveDuel(store.getState(), { challengeId: pick([pickA, pickB]) });
  } else if (sel.chooserTeamId && sel.options.length) {
    const chosen = pick(sel.options);
    const st = store.getState();
    selection.recordChoice(st, sel.chooserTeamId, chosen);
    require('./actions').beginChallenge(st, chosen);
    store.setState(st);
  }
  broadcastNow();
}

async function runBuzzerChallenge(api, myGen) {
  while (alive(myGen)) {
    api.HOST_ACTIONS.nextQuestion(store.getState());
    broadcastNow();
    await sleep(600);
    let s = store.getState();
    if (s.phase === 'challenge_results' || s.phase === 'victory') return;
    if (s.phase !== 'question') continue;

    const def = challenges.getChallengeDef(s.currentChallenge.id);
    if (def.mode === 'buzzer_tiered' && Math.random() < 0.5) {
      api.HOST_ACTIONS.advanceTier(store.getState());
      broadcastNow();
      await sleep(300);
    }

    api.HOST_ACTIONS.openBuzzer(store.getState());
    broadcastNow();
    await sleep(500);
    s = store.getState();
    const eligible = s.teams.filter(t => t.connected > 0 && !s.buzzer.wrongTeamIds.includes(t.id));
    if (eligible.length) {
      const team = pick(eligible);
      s.buzzer.open = false; s.buzzer.lockedTeamId = team.id; s.phase = 'buzzed';
      store.setState(s);
      broadcastNow();
      await sleep(600);
      const correct = Math.random() < 0.7;
      const payload = { teamId: team.id };
      if (def.mode === 'buzzer_compound') {
        payload.parts = {};
        def.scoring.parts.forEach(p => { payload.parts[p.key] = correct; });
      } else {
        payload.correct = correct;
      }
      api.HOST_ACTIONS.markAnswer(store.getState(), payload);
      broadcastNow();
      await sleep(500);
    }
    s = store.getState();
    if (s.phase === 'question' || s.phase === 'buzzed') {
      api.HOST_ACTIONS.reveal(store.getState());
      broadcastNow();
      await sleep(400);
    }
  }
}

async function runChoiceChallenge(api, myGen) {
  while (alive(myGen)) {
    api.HOST_ACTIONS.nextQuestion(store.getState());
    broadcastNow();
    await sleep(600);
    let s = store.getState();
    if (s.phase === 'challenge_results' || s.phase === 'victory') return;
    if (s.phase !== 'choice_active') continue;

    const order = s.currentChallenge.order;
    const instIdx = order ? order[s.currentChallenge.instanceIndex] : s.currentChallenge.instanceIndex;
    const inst = challenges.getInstances(s.currentChallenge.id)[instIdx];
    const optCount = (inst && inst.options && inst.options.length) || 2;
    s.teams.filter(t => t.connected > 0).forEach(t => { s.choices[t.id] = Math.floor(Math.random() * optCount); });
    store.setState(s);
    broadcastNow();
    await sleep(500);
    api.HOST_ACTIONS.revealChoices(store.getState());
    broadcastNow();
    await sleep(600);
  }
}

async function runPanicChallenge(api, myGen) {
  while (alive(myGen)) {
    api.HOST_ACTIONS.nextQuestion(store.getState());
    broadcastNow();
    await sleep(600);
    let s = store.getState();
    if (s.phase === 'challenge_results' || s.phase === 'victory') return;
    if (s.phase !== 'question') continue;

    api.HOST_ACTIONS.startPanicTimer(store.getState(), { seconds: 5 }); // server enforces a 5s floor
    broadcastNow();
    await sleep(1200);
    s = store.getState();
    s.teams.filter(t => t.connected > 0).forEach(t => {
      const n = 1 + Math.floor(Math.random() * 3);
      s.panic.submissions[t.id] = Array.from({ length: n }, (_, i) => ({ text: 'Réponse démo ' + (i + 1), status: 'pending' }));
    });
    store.setState(s);
    broadcastNow();
    await sleep(4200); // let the server's own panic timer fire endPanic()
    s = store.getState();
    Object.keys(s.panic.submissions).forEach(teamId => {
      s.panic.submissions[teamId].forEach((item, idx) => {
        api.HOST_ACTIONS.markPanicItem(s, { teamId, itemIndex: idx, valid: Math.random() < 0.7 });
      });
    });
    store.setState(s);
    broadcastNow();
    await sleep(500);
  }
}

async function runBetChallenge(api, myGen) {
  while (alive(myGen)) {
    api.HOST_ACTIONS.nextQuestion(store.getState());
    broadcastNow();
    await sleep(600);
    let s = store.getState();
    if (s.phase === 'challenge_results' || s.phase === 'victory') return;
    if (s.phase !== 'final_betting') continue;

    s.teams.filter(t => t.connected > 0).forEach(t => {
      const amount = Math.max(0, Math.min(t.score, Math.floor(Math.random() * 4) + 1));
      s.bets[t.id] = { amount, locked: true };
    });
    store.setState(s);
    broadcastNow();
    await sleep(600);
    api.HOST_ACTIONS.startFinalReveal(store.getState());
    broadcastNow();
    await sleep(600);
    s = store.getState();
    s.teams.filter(t => t.connected > 0).forEach(t => {
      api.HOST_ACTIONS.markBet(s, { teamId: t.id, correct: Math.random() < 0.5 });
    });
    store.setState(s);
    broadcastNow();
    await sleep(500);
  }
}

async function runPerformChallenge(api, def, myGen) {
  while (alive(myGen)) {
    api.HOST_ACTIONS.nextQuestion(store.getState());
    broadcastNow();
    await sleep(600);
    let s = store.getState();
    if (s.phase === 'challenge_results' || s.phase === 'victory') return;
    if (s.phase !== 'perform_active') continue;

    if (def.durationSeconds) {
      api.HOST_ACTIONS.startPerformTimer(store.getState(), { seconds: 5 });
      broadcastNow();
      await sleep(300);
    }
    s = store.getState();
    s.teams.filter(t => t.connected > 0).forEach(t => {
      if (Math.random() < 0.6) api.HOST_ACTIONS.award(s, { teamId: t.id, delta: (def.scoring && def.scoring.points) || 2 });
    });
    store.setState(s);
    broadcastNow();
    await sleep(600);
  }
}

module.exports = { start, stop };
