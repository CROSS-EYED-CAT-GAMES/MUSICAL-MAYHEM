const WebSocket = require('ws');
const HOST_KEY = process.env.HOST_KEY;
const URL = 'ws://localhost:8080';

function connect(label) {
  return new Promise(resolve => {
    const ws = new WebSocket(URL);
    ws.label = label; ws.lastState = null;
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'state') ws.lastState = m.state;
      if (m.type === 'error') { ws.lastError = m.msg; console.log('[' + label + '] ERROR:', m.msg); }
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
  const a = await connect('A');
  const b = await connect('B');
  await wait(100);
  send(host, { type: 'hello', role: 'host', hostKey: HOST_KEY });
  await wait(100);
  send(host, { type: 'host:reset' }); // self-contained: safe to run after other test suites
  await wait(150);

  send(a, { type: 'join', sessionId: 'pA', teamId: 't0', code: host.lastState.joinCode });
  await wait(100);
  assert(a.lastState.teams.find(t => t.id === 't0').customized === false, 'fresh team starts uncustomized');

  const palette = a.lastState.meta.palette;
  assert(Array.isArray(palette) && palette.length >= 6, 'palette exposed with enough colors');

  send(a, { type: 'setTeamProfile', teamId: 't0', name: 'LES CHAMPIONS', color: palette[3].color });
  await wait(100);
  const t0 = a.lastState.teams.find(t => t.id === 't0');
  assert(t0.name === 'LES CHAMPIONS', 'name updated');
  assert(t0.color.toLowerCase() === palette[3].color.toLowerCase(), 'color updated to palette choice');
  assert(t0.customized === true, 'customized flag set');
  assert(t0.emoji === palette[3].emoji, 'emoji paired from palette');
  assert(host.lastState.teams.find(t => t.id === 't0').name === 'LES CHAMPIONS', 'host view sees the rename too');

  // team B tries to steal the same color
  send(b, { type: 'join', sessionId: 'pB', teamId: 't1', code: host.lastState.joinCode });
  await wait(100);
  send(b, { type: 'setTeamProfile', teamId: 't1', name: 'LES RIVAUX', color: palette[3].color });
  await wait(100);
  const t1 = b.lastState.teams.find(t => t.id === 't1');
  assert(t1.customized === false, 'duplicate color rejected, team B stays uncustomized');
  assert(b.lastError === 'color_taken', 'server reports color_taken');

  // arbitrary non-palette color rejected
  send(b, { type: 'setTeamProfile', teamId: 't1', name: 'LES RIVAUX', color: '#123456' });
  await wait(100);
  assert(b.lastState.teams.find(t => t.id === 't1').customized === false, 'non-palette color rejected');

  // valid distinct color works
  send(b, { type: 'setTeamProfile', teamId: 't1', name: 'LES RIVAUX', color: palette[5].color });
  await wait(100);
  assert(b.lastState.teams.find(t => t.id === 't1').customized === true, 'distinct palette color accepted');

  // a non-team client cannot rename a team it doesn't own
  const outsider = await connect('OUTSIDER');
  await wait(50);
  send(outsider, { type: 'setTeamProfile', teamId: 't0', name: 'HACKED', color: palette[0].color });
  await wait(100);
  assert(host.lastState.teams.find(t => t.id === 't0').name === 'LES CHAMPIONS', 'unauthenticated client cannot rename team it did not join');

  // host override bypasses palette restriction
  send(host, { type: 'host:renameTeam', teamId: 't0', name: 'RENOMMÉ PAR HOST' });
  await wait(100);
  assert(host.lastState.teams.find(t => t.id === 't0').name === 'RENOMMÉ PAR HOST', 'host can rename any team');
  assert(host.lastState.teams.find(t => t.id === 't0').color.toLowerCase() === palette[3].color.toLowerCase(), 'host rename without color keeps existing color');

  console.log(failures === 0 ? '\nALL PROFILE CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  host.close(); a.close(); b.close(); outsider.close();
  process.exit(failures === 0 ? 0 : 1);
})();
