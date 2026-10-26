// Scripted protocol smoke test against a running server (node server.js).
// Usage: HOST_KEY=xxxxx node scripts/smoke-test.js
const WebSocket = require('ws');
const HOST_KEY = process.env.HOST_KEY;
if (!HOST_KEY) { console.error('Set HOST_KEY env var'); process.exit(1); }
const URL = 'ws://localhost:8080';

function connect(label) {
  return new Promise(resolve => {
    const ws = new WebSocket(URL);
    ws.label = label;
    ws.lastState = null;
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'state') ws.lastState = m.state;
      if (m.type === 'error') console.log('[' + label + '] ERROR:', m.msg);
    });
    ws.on('open', () => resolve(ws));
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok  :', msg);
}

(async () => {
  const host = await connect('HOST');
  const screen = await connect('SCREEN');
  const teamA = await connect('TEAM_A');
  const teamB = await connect('TEAM_B');
  await wait(100);

  send(host, { type: 'hello', role: 'host', hostKey: HOST_KEY });
  send(screen, { type: 'hello', role: 'screen' });
  await wait(100);
  send(host, { type: 'host:reset' }); // self-contained: safe to run after other test suites
  await wait(150);

  send(teamA, { type: 'join', sessionId: 'sessA', teamId: 't0', code: host.lastState.joinCode });
  send(teamB, { type: 'join', sessionId: 'sessB', teamId: 't1', code: host.lastState.joinCode });
  await wait(150);
  assert(host.lastState.teams.find(t => t.id === 't0').connected === true, 'team A shows connected on host view');
  assert(screen.lastState.teams.find(t => t.id === 't0').connected === true, 'team A shows connected on screen view');

  // bad code should be rejected for a brand-new session
  const teamBad = await connect('TEAM_BAD');
  await wait(50);
  send(teamBad, { type: 'join', sessionId: 'sessBad', teamId: 't2', code: '0000' });
  await wait(100);
  assert(host.lastState.teams.find(t => t.id === 't2').connected === false, 'wrong join code rejected');
  teamBad.close();

  // --- classic_blind_test challenge: buzzer + compound scoring ---
  send(host, { type: 'host:forcePick', challengeId: 'classic_blind_test' });
  send(host, { type: 'host:nextQuestion' });
  await wait(80);
  assert(host.lastState.phase === 'question', 'classic Q1 phase=question');
  assert(teamA.lastState.question.title === undefined, 'team view hides title before reveal');

  send(host, { type: 'host:openBuzzer' });
  await wait(60);
  assert(teamA.lastState.buzzer.open === true, 'buzzer open reaches team A');

  send(teamB, { type: 'buzz', teamId: 't1' });
  await wait(80);
  assert(host.lastState.buzzer.lockedTeamId === 't1', 'team B buzz locks buzzer');
  send(teamA, { type: 'buzz', teamId: 't0' });
  await wait(80);
  assert(host.lastState.buzzer.lockedTeamId === 't1', 'second buzz from team A ignored (still team B)');

  send(host, { type: 'host:markAnswer', teamId: 't1', parts: { title: true, artist: true } });
  await wait(80);
  assert(host.lastState.teams.find(t => t.id === 't1').score === 2, 'team B scores 2 for title+artist');
  assert(screen.lastState.question.title !== undefined, 'screen sees title after reveal');
  assert(host.lastState.phase === 'reveal', 'phase moves to reveal after correct answer');

  // wrong answer path: reopen buzzer, apply penalty
  send(host, { type: 'host:nextQuestion' });
  send(host, { type: 'host:openBuzzer' });
  await wait(60);
  send(teamA, { type: 'buzz', teamId: 't0' });
  await wait(60);
  send(host, { type: 'host:markAnswer', teamId: 't0', parts: { title: false, artist: false } });
  await wait(80);
  assert(host.lastState.teams.find(t => t.id === 't0').score === -1, 'wrong answer applies -1 penalty');
  assert(host.lastState.buzzer.open === true, 'buzzer reopens after wrong answer (other team remains)');
  assert(host.lastState.buzzer.wrongTeamIds.includes('t0'), 'team A marked as already tried');

  send(teamB, { type: 'buzz', teamId: 't1' });
  await wait(60);
  send(host, { type: 'host:markAnswer', teamId: 't1', parts: { title: true, artist: false } });
  await wait(80);
  assert(host.lastState.teams.find(t => t.id === 't1').score === 3, 'team B recovers the question for +1');

  // --- powers: grant + use bomb, shield blocks it ---
  send(host, { type: 'host:grantPower', teamId: 't0', powerId: 'bomb' });
  await wait(80);
  const bombCard = teamA.lastState.teams.find(t => t.id === 't0').powers.find(p => p.powerId === 'bomb');
  assert(!!bombCard, 'team A received bomb card');
  assert(teamB.lastState.teams.find(t => t.id === 't0').powers === undefined, 'team B cannot see team A hand');

  send(host, { type: 'host:grantPower', teamId: 't1', powerId: 'shield' });
  await wait(80);
  const shieldCard = teamB.lastState.teams.find(t => t.id === 't1').powers.find(p => p.powerId === 'shield');
  send(teamB, { type: 'usePower', teamId: 't1', instId: shieldCard.instId });
  await wait(80);
  const scoreBeforeBomb = host.lastState.teams.find(t => t.id === 't1').score;
  send(teamA, { type: 'usePower', teamId: 't0', instId: bombCard.instId, targetTeamId: 't1' });
  await wait(80);
  assert(host.lastState.teams.find(t => t.id === 't1').score === scoreBeforeBomb, 'shield blocks bomb, no score change');

  // bomb again without shield actually lands
  send(host, { type: 'host:grantPower', teamId: 't0', powerId: 'bomb' });
  await wait(80);
  const bombCard2 = teamA.lastState.teams.find(t => t.id === 't0').powers.find(p => p.powerId === 'bomb');
  const scoreBefore2 = host.lastState.teams.find(t => t.id === 't1').score;
  send(teamA, { type: 'usePower', teamId: 't0', instId: bombCard2.instId, targetTeamId: 't1' });
  await wait(80);
  assert(host.lastState.teams.find(t => t.id === 't1').score === scoreBefore2 - 2, 'unshielded bomb applies -2');

  // --- undo ---
  const scoreBeforeAward = host.lastState.teams.find(t => t.id === 't0').score;
  send(host, { type: 'host:award', teamId: 't0', delta: 5 });
  await wait(80);
  assert(host.lastState.teams.find(t => t.id === 't0').score === scoreBeforeAward + 5, 'manual award applied');
  send(host, { type: 'host:undo' });
  await wait(80);
  assert(host.lastState.teams.find(t => t.id === 't0').score === scoreBeforeAward, 'undo reverts manual award');

  // --- reconnection identity ---
  const teamAReload = await connect('TEAM_A_RELOAD');
  await wait(50);
  send(teamAReload, { type: 'join', sessionId: 'sessA', teamId: 'IGNORED', code: '0000' });
  await wait(100);
  assert(teamAReload.lastState.teams.find(t => t.id === 't0').connected === true, 'reload with known sessionId reconnects without code');
  teamAReload.close();

  // --- beat_the_clock challenge (panic mode) ---
  send(host, { type: 'host:forcePick', challengeId: 'beat_the_clock' });
  send(host, { type: 'host:nextQuestion' });
  send(host, { type: 'host:startPanicTimer', seconds: 5 }); // server enforces a 5s floor
  await wait(80);
  send(teamA, { type: 'panicSubmit', teamId: 't0', text: 'Yellow Submarine' });
  send(teamB, { type: 'panicSubmit', teamId: 't1', text: 'Purple Rain' });
  await wait(5300);
  assert(host.lastState.phase === 'panic_review', 'panic auto-ends into review after timer');
  send(host, { type: 'host:markPanicItem', teamId: 't0', itemIndex: 0, valid: true });
  await wait(80);
  send(teamB, { type: 'panicChallenge', teamId: 't1', targetTeamId: 't0', itemIndex: 0 });
  await wait(80);
  const pending = host.lastState.panic.challenges.find(c => c.status === 'pending');
  assert(!!pending, 'challenge recorded as pending for host to resolve');
  const t1ScoreBeforeChallenge = host.lastState.teams.find(t => t.id === 't1').score;
  send(host, { type: 'host:resolveChallenge', challengeId: pending.id, accept: false });
  await wait(80);
  assert(host.lastState.teams.find(t => t.id === 't1').score === t1ScoreBeforeChallenge - 1, 'rejected challenge costs challenger -1');

  // --- final_bet challenge (bet mode) ---
  send(host, { type: 'host:award', teamId: 't0', delta: 10 }); // fund team A so a bet of 3 isn't clamped to 0
  send(host, { type: 'host:forcePick', challengeId: 'final_bet' });
  send(host, { type: 'host:nextQuestion' });
  await wait(80);
  assert(host.lastState.phase === 'final_betting', 'final round enters betting phase');
  send(teamA, { type: 'betSet', teamId: 't0', amount: 3 });
  send(teamA, { type: 'betLock', teamId: 't0' });
  await wait(80);
  assert(teamB.lastState.bets['t0'].amount === undefined, 'team B cannot see team A locked bet amount before reveal');
  send(teamB, { type: 'betSet', teamId: 't1', amount: 2 });
  send(teamB, { type: 'betLock', teamId: 't1' });
  await wait(80);
  assert(host.lastState.phase === 'final_guess', 'all locked -> guessing window opens (audio + title entry)');
  assert(teamB.lastState.bets['t0'].amount === undefined, 'bet amount still hidden from other teams during the guess window');
  send(teamA, { type: 'betGuess', teamId: 't0', text: 'My Heart Will Go On' });
  await wait(80);
  assert(host.lastState.bets['t0'].guess === 'My Heart Will Go On', 'a locked team can still type its title guess during the guess window');
  send(host, { type: 'host:startFinalReveal' });
  await wait(80);
  assert(host.lastState.phase === 'final_reveal', 'host can force the reveal to skip the rest of the guess window');
  assert(teamB.lastState.bets['t0'].amount === 3, 'bet amounts visible to all after reveal');
  const scoreT0BeforeBet = host.lastState.teams.find(t => t.id === 't0').score;
  send(host, { type: 'host:markBet', teamId: 't0', correct: true });
  await wait(80);
  assert(host.lastState.teams.find(t => t.id === 't0').score === scoreT0BeforeBet + 3, 'winning bet adds the staked amount');

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  host.close(); screen.close(); teamA.close(); teamB.close();
  process.exit(failures === 0 ? 0 : 1);
})();
