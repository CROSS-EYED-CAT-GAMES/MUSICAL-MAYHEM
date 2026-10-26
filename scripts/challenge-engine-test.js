// Scripted protocol test for the modular challenge engine: selection
// policies, per-mode scoring, private-payload isolation, skip/force-pick,
// and undo across a challenge-selection boundary.
// Usage: HOST_KEY=xxxxx node scripts/challenge-engine-test.js
const WebSocket = require('ws');
const HOST_KEY = process.env.HOST_KEY;
if (!HOST_KEY) { console.error('Set HOST_KEY env var'); process.exit(1); }
const URL = 'ws://localhost:8080';

function connect(label) {
  return new Promise(resolve => {
    const ws = new WebSocket(URL);
    ws.label = label; ws.lastState = null; ws.lastError = null;
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'state') ws.lastState = m.state;
      if (m.type === 'error') { ws.lastError = m.msg; }
    });
    ws.on('open', () => resolve(ws));
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
let failures = 0;
function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); failures++; } else console.log('ok  :', msg); }

(async () => {
  const host = await connect('HOST');
  const a = await connect('A'), b = await connect('B'), c = await connect('C');
  const wsForTeam = { t0: a, t1: b, t2: c };
  await wait(100);
  send(host, { type: 'hello', role: 'host', hostKey: HOST_KEY });
  await wait(100);
  send(host, { type: 'host:reset' });
  await wait(150);
  const code = host.lastState.joinCode;
  send(a, { type: 'join', sessionId: 'ceA', teamId: 't0', code });
  send(b, { type: 'join', sessionId: 'ceB', teamId: 't1', code });
  send(c, { type: 'join', sessionId: 'ceC', teamId: 't2', code });
  await wait(150);

  // give the teams distinct scores to exercise winner/last policies unambiguously
  send(host, { type: 'host:award', teamId: 't0', delta: 5 });  // t0 highest
  send(host, { type: 'host:award', teamId: 't1', delta: 2 });
  send(host, { type: 'host:award', teamId: 't2', delta: -3 }); // t2 lowest
  await wait(150);

  // --- selection policy: winner ---
  send(host, { type: 'host:configureGame', selection: { policy: 'winner', allowRepeat: true, comebackEnabled: false, maxConsecutiveSelections: 5, optionsOffered: 3 }, maxChallenges: 10 });
  await wait(100);
  send(host, { type: 'host:startSelection' });
  await wait(150);
  let sel = host.lastState.selection;
  assert(sel.active === true, 'selection becomes active');
  assert(sel.chooserTeamId === 't0', 'winner policy picks the highest-score team as chooser');
  assert(sel.options.length === 3, 'offers 3 options');
  assert(new Set(sel.options.map(o => o.id)).size === 3, 'options are distinct');
  assert(a.lastState.selection.chooserTeamId === 't0', 'team view also sees the chooser/options');

  // team B (not the chooser) cannot pick
  send(b, { type: 'pickChallenge', teamId: 't1', challengeId: sel.options[0].id });
  await wait(100);
  assert(b.lastError === 'not_chooser', 'non-chooser team cannot pick a challenge');

  // chooser picks -> challenge begins
  const picked = sel.options[0].id;
  send(a, { type: 'pickChallenge', teamId: 't0', challengeId: picked });
  await wait(150);
  assert(host.lastState.phase === 'challenge_intro', 'phase moves to challenge_intro after pick');
  assert(host.lastState.challenge && host.lastState.challenge.id === picked, 'currentChallenge matches the pick');
  assert(host.lastState.selection.history.includes(picked), 'selection history records the played challenge');

  // --- selection policy: last (comeback) ---
  send(host, { type: 'host:configureGame', selection: { policy: 'last', allowRepeat: true, comebackEnabled: false, maxConsecutiveSelections: 5, optionsOffered: 3 } });
  await wait(100);
  send(host, { type: 'host:skipChallenge' }); // end the winner-picked challenge without playing it, for speed
  await wait(150);
  send(host, { type: 'host:startSelection' });
  await wait(150);
  assert(host.lastState.selection.chooserTeamId === 't2', 'last policy picks the lowest-score team as chooser');

  // --- selection policy: chaos (no chooser, auto-pick) ---
  send(host, { type: 'host:configureGame', selection: { policy: 'chaos', allowRepeat: true, comebackEnabled: false, maxConsecutiveSelections: 5, optionsOffered: 3 } });
  await wait(100);
  const chosenIdB = host.lastState.selection.options[0] ? host.lastState.selection.options[0].id : (host.lastState.selection.options[0]);
  send(host, { type: 'host:startSelection' });
  await wait(150);
  assert(host.lastState.selection.chooserTeamId === null, 'chaos policy has no chooser');
  assert(host.lastState.selection.options.length === 1, 'chaos policy offers exactly one auto-pick');
  send(host, { type: 'host:confirmAutoPick' });
  await wait(150);
  assert(host.lastState.phase === 'challenge_intro', 'chaos auto-pick starts a challenge');
  send(host, { type: 'host:skipChallenge' });
  await wait(100);

  // --- selection policy: roulette (random chooser) ---
  send(host, { type: 'host:configureGame', selection: { policy: 'roulette', allowRepeat: true, comebackEnabled: false, maxConsecutiveSelections: 5, optionsOffered: 3 } });
  await wait(100);
  send(host, { type: 'host:startSelection' });
  await wait(150);
  assert(['t0', 't1', 't2'].includes(host.lastState.selection.chooserTeamId), 'roulette policy still picks a connected team as chooser');
  send(host, { type: 'host:skipChallenge' });
  await wait(100);

  // --- selection policy: duel (two choosers) ---
  send(host, { type: 'host:configureGame', selection: { policy: 'duel', allowRepeat: true, comebackEnabled: false, maxConsecutiveSelections: 5, optionsOffered: 3 } });
  await wait(100);
  send(host, { type: 'host:startSelection' });
  await wait(150);
  sel = host.lastState.selection;
  assert(sel.chooserTeamId === 't0' && sel.secondChooserTeamId === 't1', 'duel policy picks the top-2 scoring teams as the two choosers');
  const duelPickA = sel.options[0].id, duelPickB = sel.optionsB[0].id;
  send(a, { type: 'pickChallenge', teamId: 't0', challengeId: duelPickA });
  send(b, { type: 'pickChallenge', teamId: 't1', challengeId: duelPickB });
  await wait(150);
  send(host, { type: 'host:resolveDuel', challengeId: duelPickA });
  await wait(150);
  assert(host.lastState.challenge && host.lastState.challenge.id === duelPickA, 'host resolves the duel by starting one of the two submitted picks');
  send(host, { type: 'host:skipChallenge' });
  await wait(100);

  // --- maxConsecutiveSelections enforcement ---
  send(host, { type: 'host:configureGame', selection: { policy: 'winner', allowRepeat: true, comebackEnabled: false, maxConsecutiveSelections: 1, optionsOffered: 3 } });
  await wait(100);
  send(host, { type: 'host:award', teamId: 't0', delta: 50 }); // make t0 an overwhelming, repeated "winner"
  await wait(100);
  send(host, { type: 'host:startSelection' });
  await wait(150);
  const firstChooser = host.lastState.selection.chooserTeamId;
  send(wsForTeam[firstChooser], { type: 'pickChallenge', teamId: firstChooser, challengeId: host.lastState.selection.options[0].id });
  await wait(150);
  send(host, { type: 'host:skipChallenge' });
  await wait(100);
  send(host, { type: 'host:startSelection' });
  await wait(150);
  const secondChooser = host.lastState.selection.chooserTeamId;
  assert(secondChooser !== firstChooser, 'maxConsecutiveSelections prevents the same team choosing twice in a row');
  send(host, { type: 'host:skipChallenge' });
  await wait(100);

  // ================= per-mode scoring =================

  async function startNamedChallenge(id) {
    send(host, { type: 'host:configureGame', selection: { policy: 'winner', allowRepeat: true, comebackEnabled: false, maxConsecutiveSelections: 1, optionsOffered: 3 } });
    await wait(80);
    send(host, { type: 'host:startSelection' });
    await wait(120);
    // forcePick is the mode-secours escape valve: starts any enabled
    // challenge directly, regardless of what was randomly offered, used
    // here to deterministically test one specific mode at a time.
    send(host, { type: 'host:forcePick', challengeId: id });
    await wait(150);
  }

  // buzzer_compound: classic_blind_test, partial vs full credit
  await startNamedChallenge('classic_blind_test');
  assert(host.lastState.challenge.id === 'classic_blind_test', 'forcePick starts the exact requested challenge (classic_blind_test)');
  send(host, { type: 'host:nextQuestion' });
  await wait(100);
  send(host, { type: 'host:openBuzzer' });
  await wait(80);
  send(a, { type: 'buzz', teamId: 't0' });
  await wait(100);
  let scoreBefore = host.lastState.teams.find(t => t.id === 't0').score;
  send(host, { type: 'host:markAnswer', teamId: 't0', parts: { title: true, artist: false } });
  await wait(100);
  assert(host.lastState.teams.find(t => t.id === 't0').score === scoreBefore + 1, 'buzzer_compound: partial credit (title only) awards the title points');

  // Note: the private-payload isolation mechanism (banned_words/forbidden_word,
  // see README §6) has no current challenge exercising it, so it has no
  // coverage here either, same as forbidden_word already didn't. Revisit
  // if a future challenge uses hasPrivatePayload again.

  // --- choice mode scoring + reveal gating ---
  await startNamedChallenge('spotify_roulette');
  send(host, { type: 'host:nextQuestion' });
  await wait(120);
  assert(host.lastState.phase === 'choice_active', 'choice mode enters choice_active phase');
  send(a, { type: 'submitChoice', teamId: 't0', optionIndex: 0 });
  await wait(100);
  assert(b.lastState.choices.answeredTeamIds.includes('t0'), 'other teams see that t0 has answered (progress only)');
  assert(b.lastState.choices.revealed === null, 'other teams cannot see WHAT t0 answered before reveal');
  scoreBefore = host.lastState.teams.find(t => t.id === 't0').score;
  send(host, { type: 'host:revealChoices' });
  await wait(120);
  assert(host.lastState.phase === 'choice_reveal', 'revealChoices moves to choice_reveal');
  assert(a.lastState.choices.revealed !== null, 'choices are visible to everyone after reveal');
  const inst = host.lastState.question; // host sees full instance incl. correctIndex
  const gotItRight = inst.correctIndex === 0;
  const scoreAfter = host.lastState.teams.find(t => t.id === 't0').score;
  assert(gotItRight ? scoreAfter > scoreBefore : scoreAfter === scoreBefore, 'choice mode auto-scores correctly against correctIndex');

  // Note: track-tiered buzzer_tiered coverage (manual advanceTier,
  // musicPlay(index) syncing buzzer.tierIndex to the track slot) lost its
  // only real content when C'EST QUI ? (whos_next) was removed from the
  // catalog. The mechanism itself is kept in lib/actions.js as generic,
  // not-id-specific infrastructure (see syncTierToTrackIndex) for a future
  // challenge of that shape; re-add coverage here once one exists.

  // --- buzzer_tiered: time-tiered challenges (five_seconds, tiers with a
  // `seconds` threshold) advance on their own from real elapsed playback
  // time, no manual click at all, and manual advanceTier is now refused ---
  await startNamedChallenge('five_seconds');
  send(host, { type: 'host:nextQuestion' });
  await wait(120);
  send(host, { type: 'host:openBuzzer' }); // starts playback, schedules the auto-advance
  await wait(80);
  assert(host.lastState.buzzer.tierIndex === 0, 'time-tiered challenge starts at tier 0');
  send(host, { type: 'host:advanceTier' });
  await wait(80);
  assert(host.lastState.buzzer.tierIndex === 0, 'manual advanceTier is refused for a time-tiered challenge (no state change)');
  const fiveSecondsTiers = require('../data/challenges.json').find(c => c.id === 'five_seconds').scoring.tiers;
  await wait(fiveSecondsTiers[0].seconds * 1000 + 400); // cross the first threshold with zero manual action
  assert(host.lastState.buzzer.tierIndex === 1, 'time-tiered challenge auto-advances from elapsed playback time alone');
  send(a, { type: 'buzz', teamId: 't0' });
  await wait(80);
  scoreBefore = host.lastState.teams.find(t => t.id === 't0').score;
  send(host, { type: 'host:markAnswer', teamId: 't0', correct: true });
  await wait(100);
  assert(host.lastState.teams.find(t => t.id === 't0').score === scoreBefore + fiveSecondsTiers[1].points, 'time-tiered scoring matches the tier actually reached by the clock');

  // --- answer timer: a locked buzz nobody judges in time auto-resolves as
  // wrong (0 points, same path a manual RATÉ takes), so a team can't hold
  // the buzzer forever and the round moves itself on to the next team ---
  send(host, { type: 'host:configureGame', answerSeconds: 3 }); // configureGame clamps below 3s, so this is also the floor
  await wait(80);
  await startNamedChallenge('classic_blind_test');
  send(host, { type: 'host:nextQuestion' });
  await wait(100);
  send(host, { type: 'host:openBuzzer' });
  await wait(80);
  send(a, { type: 'buzz', teamId: 't0' });
  await wait(80);
  assert(host.lastState.answerTimer.running === true, 'buzzing starts the answer timer');
  assert(host.lastState.buzzer.lockedTeamId === 't0', 'team is locked in while answering');
  scoreBefore = host.lastState.teams.find(t => t.id === 't0').score;
  await wait(3300); // past the 3s answerSeconds
  assert(host.lastState.buzzer.lockedTeamId !== 't0', 'answer timer expiring auto-resolves the locked buzz');
  assert(host.lastState.answerTimer.running === false, 'answer timer stops once resolved');
  const classicWrongPenalty = require('../data/challenges.json').find(c => c.id === 'classic_blind_test').wrongPenalty || 0;
  assert(host.lastState.teams.find(t => t.id === 't0').score === scoreBefore - classicWrongPenalty, 'timing out applies the same wrong-answer penalty as a manual RATÉ');
  send(host, { type: 'host:configureGame', answerSeconds: 15 }); // restore default

  // Note: perform mode (host free-awards, no buzzer) also has no current
  // challenge exercising it, so no coverage here either; see note above.

  // --- Mayhem card: one per round, awarded at the end to whoever improved
  // their score the most during it (not handed to every team at the start
  // anymore). a is clearly ahead of b/c here, so it should get the card. ---
  await startNamedChallenge('classic_blind_test');
  send(host, { type: 'host:nextQuestion' });
  await wait(100);
  const cardsBeforeA = host.lastState.teams.find(x => x.id === 't0').powers.length;
  send(host, { type: 'host:openBuzzer' });
  await wait(80);
  send(a, { type: 'buzz', teamId: 't0' });
  await wait(80);
  send(host, { type: 'host:markAnswer', teamId: 't0', parts: { title: true, artist: true } });
  await wait(100);
  send(host, { type: 'host:skipChallenge' }); // ends the round right here, deterministically
  await wait(120);
  assert(host.lastState.phase === 'challenge_results', 'ending a round (even via skip, once at least one question played) lands on challenge_results');
  const rr = host.lastState.roundResult;
  assert(!!rr && rr.teamId === 't0', "the team that improved its score the most this round wins its Mayhem card, not every team at the challenge's start");
  const cardsAfterA = host.lastState.teams.find(x => x.id === 't0').powers.length;
  assert(cardsAfterA === cardsBeforeA + 1, 'the winning team actually receives exactly one more card');
  assert(!!a.lastState.roundResult && a.lastState.roundResult.powerId === rr.powerId, "the round result (who won, which card) isn't host-only, every screen needs it for the reveal");

  // --- SILENCE used to never expire: nothing ever cleared it once applied,
  // so a silenced team stayed silenced for the rest of the game, not just
  // "sur cette question" like the card itself claims ---
  await startNamedChallenge('classic_blind_test');
  send(host, { type: 'host:nextQuestion' });
  await wait(100);
  send(host, { type: 'host:grantPower', teamId: 't0', powerId: 'silence' });
  await wait(80);
  const silenceCard = host.lastState.teams.find(x => x.id === 't0').powers.find(p => p.powerId === 'silence');
  send(a, { type: 'usePower', teamId: 't0', instId: silenceCard.instId, targetTeamId: 't1' });
  await wait(80);
  send(host, { type: 'host:openBuzzer' });
  await wait(80);
  b.lastError = null;
  send(b, { type: 'buzz', teamId: 't1' });
  await wait(80);
  assert(b.lastError === 'silenced', 'SILENCE blocks the targeted team from buzzing on this question');
  send(host, { type: 'host:nextQuestion' }); // next question in the same challenge
  await wait(100);
  send(host, { type: 'host:openBuzzer' });
  await wait(80);
  b.lastError = null;
  send(b, { type: 'buzz', teamId: 't1' });
  await wait(80);
  assert(host.lastState.buzzer.lockedTeamId === 't1', "SILENCE no longer applies once that question is over, as its own description already claimed");

  // --- ORACLE used to always succeed (and consume the card) even when the
  // current question has no hint written in data/challenge-content.json,
  // which most of the catalog doesn't: the card was spent for literally
  // nothing, silently. movie_soundtrack never has hints (any hint there
  // risks leaking the movie/series name); five_seconds now does. ---
  await startNamedChallenge('movie_soundtrack');
  send(host, { type: 'host:nextQuestion' });
  await wait(100);
  send(host, { type: 'host:grantPower', teamId: 't0', powerId: 'oracle' });
  await wait(80);
  const oracleCardNoHint = host.lastState.teams.find(x => x.id === 't0').powers.find(p => p.powerId === 'oracle');
  a.lastError = null;
  send(a, { type: 'usePower', teamId: 't0', instId: oracleCardNoHint.instId });
  await wait(80);
  assert(a.lastError === 'no_hint', 'oracle refuses outright on a question with no hint, rather than silently doing nothing');
  assert(host.lastState.teams.find(x => x.id === 't0').powers.some(p => p.instId === oracleCardNoHint.instId), 'a refused oracle leaves the card in hand instead of wasting it');

  await startNamedChallenge('five_seconds');
  send(host, { type: 'host:nextQuestion' });
  await wait(100);
  send(host, { type: 'host:grantPower', teamId: 't0', powerId: 'oracle' });
  await wait(80);
  const oracleCardHinted = host.lastState.teams.find(x => x.id === 't0').powers.find(p => p.powerId === 'oracle');
  send(a, { type: 'usePower', teamId: 't0', instId: oracleCardHinted.instId });
  await wait(80);
  assert(!!a.lastState.question.hint, 'oracle actually reveals the hint to the team that played it, once one exists');
  assert(!host.lastState.teams.find(x => x.id === 't0').powers.some(p => p.instId === oracleCardHinted.instId), 'a successful oracle does consume the card');

  // --- skip challenge mid-play (mode secours) ---
  await startNamedChallenge('lost_in_translation');
  send(host, { type: 'host:nextQuestion' });
  await wait(100);
  const beforeSkipPlayed = host.lastState.progress.challengesPlayed;
  send(host, { type: 'host:skipChallenge' });
  await wait(120);
  assert(host.lastState.progress.challengesPlayed === beforeSkipPlayed + 1, 'skipChallenge advances challengesPlayed even mid-question');
  assert(host.lastState.phase === 'challenge_results' || host.lastState.phase === 'victory', 'skipChallenge moves out of the challenge cleanly');

  // --- undo across a selection boundary ---
  // Only host:-prefixed actions are undo-snapshotted (by design, same as
  // buzzes in the original engine: a team's own action isn't itself
  // undoable, only the host's subsequent judgment call is). So undo
  // rewinds the host's own host:startSelection, not a team's pick that
  // came after it; the correct recovery from an unwanted pick is
  // host:skipChallenge (tested above), which is why it's a prominent,
  // always-visible host control.
  send(host, { type: 'host:configureGame', selection: { policy: 'winner', allowRepeat: true, comebackEnabled: false, maxConsecutiveSelections: 5, optionsOffered: 3 } });
  await wait(80);
  const phaseBeforeSelection = host.lastState.phase;
  send(host, { type: 'host:startSelection' });
  await wait(120);
  assert(host.lastState.selection.active === true, 'startSelection activates selection');
  send(host, { type: 'host:undo' });
  await wait(120);
  assert(host.lastState.selection.active === false, 'undo rewinds the host\'s own host:startSelection');
  assert(host.lastState.phase === phaseBeforeSelection, 'undo restores the pre-selection phase');

  // and a team's bad pick recovers cleanly via skipChallenge, not undo
  send(host, { type: 'host:startSelection' });
  await wait(120);
  const chooser = host.lastState.selection.chooserTeamId;
  const pickedId = host.lastState.selection.options[0].id;
  send(wsForTeam[chooser], { type: 'pickChallenge', teamId: chooser, challengeId: pickedId });
  await wait(120);
  assert(host.lastState.phase === 'challenge_intro' && host.lastState.challenge.id === pickedId, 'team pick starts the challenge');
  send(host, { type: 'host:skipChallenge' });
  await wait(120);
  assert(host.lastState.phase === 'challenge_results' || host.lastState.phase === 'victory', 'skipChallenge is the recovery path for an unwanted pick');

  console.log(failures === 0 ? '\nALL CHALLENGE ENGINE CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  host.close(); a.close(); b.close(); c.close();
  process.exit(failures === 0 ? 0 : 1);
})();
