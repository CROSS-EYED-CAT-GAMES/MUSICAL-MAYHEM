(function () {
  const stage = document.getElementById('stage');
  const roundBadge = document.getElementById('roundBadge');
  const chaosBanner = document.getElementById('chaosBanner');
  const scoreStrip = document.getElementById('scoreStrip');

  let lastState = null;
  let lastEventCount = 0;
  let tickTimer = null;

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Challenge names used to break after every single word ("JOUEUR A, JOUEUR B
  // OU LES DEUX ?" → 7 stacked lines): fine for a 2-word name, not for
  // anything longer. This instead always wraps to exactly one <br> (two
  // lines total), picked at whichever word boundary leaves the two
  // halves closest in character count, so longer titles read as two
  // balanced phrases instead of a word-by-word column.
  function twoLineTitle(name) {
    const words = String(name || '').trim().split(/\s+/);
    if (words.length <= 1) return esc(name);
    let bestIdx = 1, bestDiff = Infinity, acc = 0;
    const total = words.join(' ').length;
    for (let i = 0; i < words.length - 1; i++) {
      acc += words[i].length + 1; // +1 for the space before the next word
      const diff = Math.abs(acc - total / 2);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i + 1; }
    }
    return esc(words.slice(0, bestIdx).join(' ')) + '<br>' + esc(words.slice(bestIdx).join(' '));
  }

  function teamById(state, id) { return state.teams.find(t => t.id === id); }
  // Once the game has left the lobby, team slots nobody ever joined just
  // clutter the score strip/leaderboard for the rest of the night (and
  // could even wrongly "win" a tied 0-0 game). everJoined (not
  // `connected`) so a team stays listed through a brief Wi-Fi drop.
  function inPlayTeams(state) {
    return state.phase === 'lobby' ? state.teams : state.teams.filter(t => t.everJoined);
  }

  const client = MM.connect(render);
  client.onOpen(() => client.send({ type: 'hello', role: 'screen' }));

  // --- Spotify Web Playback SDK -------------------------------------
  // Turns this tab into a real Spotify Connect device: once the host has
  // connected their Premium account, audio plays straight out of
  // whatever speakers this device (the TV/laptop showing the screen) is
  // on, no phone held up to a speaker, no local mp3s. If the host never
  // connects, none of this loads and the game plays exactly as before.
  let spotifyDeviceId = null;
  let spotifyPlayer = null;
  client.onOpen(() => { if (spotifyDeviceId) client.send({ type: 'screen:spotifyDevice', deviceId: spotifyDeviceId }); });

  window.onSpotifyWebPlaybackSDKReady = () => {
    const player = new Spotify.Player({
      name: 'Musical Mayhem · Écran',
      getOAuthToken: cb => {
        fetch('/api/spotify/playback-token').then(r => r.json()).then(d => cb(d.accessToken || '')).catch(() => cb(''));
      },
      volume: 0.85
    });
    spotifyPlayer = player;
    player.addListener('ready', ({ device_id }) => {
      spotifyDeviceId = device_id;
      client.send({ type: 'screen:spotifyDevice', deviceId: device_id });
    });
    player.addListener('not_ready', () => {
      // Tell the server too, not just this tab: leaving the old id
      // registered server-side is what made a dead device look "ready"
      // while every play attempt silently 404'd.
      spotifyDeviceId = null;
      client.send({ type: 'screen:spotifyDevice', deviceId: null });
    });
    player.addListener('initialization_error', ({ message }) => console.error('Spotify SDK init error:', message));
    player.addListener('authentication_error', ({ message }) => console.error('Spotify SDK auth error:', message));
    player.addListener('account_error', ({ message }) => console.error('Spotify SDK account error (Premium requis):', message));
    player.connect();
  };

  // Browser tabs get throttled/frozen when backgrounded or the machine
  // sleeps, which can silently drop the Connect session (or leave this
  // tab and the app server out of sync after a server restart) without
  // ever firing 'not_ready'. A periodic nudge means the screen recovers
  // on its own instead of needing someone to remember to reload it
  // mid-party: re-announce the device id if we still think we have one
  // (harmless if the server already agrees), or try reconnecting the
  // player if we don't.
  //
  // A previous version of this called player.connect() unconditionally
  // every cycle, even while already connected and possibly mid-playback,
  // to force the SDK to re-validate the session. Reverted: a forced
  // reconnect can itself re-negotiate the Connect session (a fresh
  // device_id via a new 'ready' event) while a play call elsewhere is
  // in flight against the old one, and that race lines up with "no sound
  // right after starting a new round" reports better than it fixed the
  // original staleness issue. The passive, read-only server-side check
  // below (verifyActiveDevice) covers the same staleness case without
  // touching anything live.
  setInterval(() => {
    if (spotifyDeviceId) client.send({ type: 'screen:spotifyDevice', deviceId: spotifyDeviceId });
    else if (spotifyPlayer) spotifyPlayer.connect();
  }, 20000);

  fetch('/api/spotify/status').then(r => r.json()).then(status => {
    if (!status.authorized) return;
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    document.head.appendChild(script);
  }).catch(() => {});

  function render(state) {
    lastState = state;
    roundBadge.textContent = (state.challenge && state.phase !== 'victory')
      ? ('DÉFI ' + (state.progress.challengesPlayed + 1) + '/' + state.progress.maxChallenges + ' · ' + state.challenge.name)
      : 'MUSICAL MAYHEM';
    if (state.chaos.active) { chaosBanner.classList.remove('hidden'); chaosBanner.textContent = '🌀 ' + state.chaos.active.text; }
    else chaosBanner.classList.add('hidden');

    handleToasts(state);
    renderStage(state);
    renderScoreStrip(state);

    if (!tickTimer) {
      tickTimer = setInterval(() => {
        if (!lastState) return;
        if (lastState.phase === 'panic_running') renderStage(lastState);
        if (lastState.phase === 'perform_active' && lastState.performTimer.running) renderStage(lastState);
        if (lastState.playTimer && lastState.playTimer.running) renderStage(lastState);
        if (lastState.answerTimer && lastState.answerTimer.running) renderStage(lastState);
      }, 250);
    }
  }

  // Countdown that caps how long a track plays (state.setup.maxPlaySeconds,
  // default 30s). Big enough to read from across the room (same .timer
  // class as the panic/perform countdowns, just a bit smaller since this
  // one shares the screen with the question badge and buzzer banner
  // instead of being the sole focus). Frozen (⏸, dimmed) rather than
  // hidden while a buzz has it paused, so the room sees the clock
  // waiting, not disappearing.
  function playTimerBadge(state) {
    const pt = state.playTimer;
    if (!pt) return '';
    if (pt.running && pt.endsAt) {
      const remaining = Math.max(0, Math.ceil((pt.endsAt - Date.now()) / 1000));
      return `<div class="timer ${remaining <= 5 ? 'pulse' : ''}" style="font-size:clamp(44px,9vw,100px);margin:2px 0">${remaining}</div>`;
    }
    if (pt.remainingMs != null && pt.remainingMs > 0) {
      return `<div class="timer" style="font-size:clamp(44px,9vw,100px);margin:2px 0;opacity:.55">⏸ ${Math.ceil(pt.remainingMs / 1000)}</div>`;
    }
    return '';
  }

  function handleToasts(state) {
    if (state.events.length > lastEventCount) {
      const fresh = state.events.slice(lastEventCount);
      lastEventCount = state.events.length;
      fresh.forEach(e => {
        if (e.type === 'BUZZ') { const t = teamById(state, e.teamId); MM.toast('⚡ ' + (t ? t.name : '') + ' BUZZ !'); flashOnce(); }
        else if (e.type === 'CHAOS_TRIGGERED') MM.toast('🌀 ' + e.text, 3000);
        else if (e.type === 'SHIELD_BLOCKED') MM.toast('🛡️ SHIELD ! Sabotage annulé');
        else if (e.type === 'GAME_ENDED') MM.toast('🏆 FIN DE PARTIE');
      });
    } else if (state.events.length < lastEventCount) {
      lastEventCount = state.events.length; // reset/undo happened
    }
  }

  // One bright flash (see .shatter-flash in style.css) for a buzz landing:
  // a dedicated, self-removing element on <body> rather than anything
  // inside #stage, since stage.innerHTML gets fully replaced on every
  // broadcast while a team stays locked in — mounting it there would
  // replay the animation on every one of those instead of firing once.
  function flashOnce() {
    const el = document.createElement('div');
    el.className = 'shatter-flash';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 500);
  }

  function renderStage(state) {
    stage.innerHTML = phaseHtml(state);
  }

  function phaseHtml(state) {
    switch (state.phase) {
      case 'lobby': return lobbyHtml(state);
      case 'selection': return selectionHtml(state);
      case 'challenge_intro': return challengeIntroHtml(state);
      case 'challenge_results': return challengeResultsHtml(state);
      case 'victory': return victoryHtml(state);
      case 'panic_running': return panicRunningHtml(state);
      case 'panic_review': return panicReviewHtml(state);
      case 'final_betting': return finalBettingHtml(state);
      case 'final_guess': return finalGuessHtml(state);
      case 'final_reveal': return finalRevealHtml(state);
      case 'choice_active': return choiceHtml(state);
      case 'choice_reveal': return choiceHtml(state);
      case 'perform_active': return performHtml(state);
      case 'question':
      case 'buzzed':
      case 'reveal':
      default: return questionHtml(state);
    }
  }

  function selectionHtml(state) {
    const sel = state.selection;
    if (sel.policy === 'chaos') return `<div class="logo pulse">🌀 CHAOS</div><div class="muted" style="letter-spacing:.1em">CHOISIT L'ÉPREUVE...</div>`;
    if (sel.policy === 'final') return `<div class="badge">FINALE</div><div class="logo">🏁 DERNIÈRE<br>ÉPREUVE</div>`;
    if (sel.policy === 'duel') {
      const a = teamById(state, sel.chooserTeamId), b = teamById(state, sel.secondChooserTeamId);
      return `<div class="badge">DUEL</div>
        <div class="logo team-text" style="color:${a ? a.color : ''}">${esc(a ? a.name : '')}</div>
        <div class="muted" style="font-size:22px">VS</div>
        <div class="logo team-text" style="color:${b ? b.color : ''}">${esc(b ? b.name : '')}</div>
        <div class="muted" style="margin-top:10px">choisissent chacun une épreuve...</div>`;
    }
    const chooser = teamById(state, sel.chooserTeamId);
    return `
      <div class="muted" style="letter-spacing:.2em">━━━━━━━━━━━━</div>
      <div class="logo team-text pulse" style="color:${chooser ? chooser.color : ''}">${esc(chooser ? chooser.name : '')}</div>
      <div class="badge">HAS THE POWER TO CHOOSE</div>
      <div class="muted" style="font-size:44px;margin-top:6px">↓</div>
      <div class="muted small" style="letter-spacing:.2em">NEXT CHALLENGE</div>
      <div class="muted" style="letter-spacing:.2em">━━━━━━━━━━━━</div>`;
  }

  function challengeIntroHtml(state) {
    const c = state.challenge;
    return `
      <div class="badge">DÉFI ${state.progress.challengesPlayed + 1} / ${state.progress.maxChallenges}</div>
      <div style="font-size:70px">${c.icon}</div>
      <div class="logo" style="font-size:clamp(34px,7.5vw,80px)">${twoLineTitle(c.name)}</div>
      <div class="muted" style="max-width:640px;font-size:24px">${esc(c.description)}</div>`;
  }

  function choiceHtml(state) {
    const q = state.question, c = state.challenge;
    if (!q) return `<div class="muted">En attente...</div>`;
    const answered = state.choices.answeredTeamIds.length;
    const total = state.teams.filter(t => t.connected).length;
    const revealed = state.phase === 'choice_reveal';
    const opts = (q.options || []).map((o, i) => {
      const label = o.title ? `${esc(o.title)} · ${esc(o.artist)}` : esc(o.label || ('Option ' + (i + 1)));
      const isCorrect = revealed && q.correctIndex === i;
      return `<div class="line" style="font-size:28px;${isCorrect ? 'color:var(--acid);font-weight:900' : ''}">${i + 1}. ${label}${isCorrect ? ' ✓' : ''}</div>`;
    }).join('');
    // JOUEUR A, JOUEUR B OU LES DEUX ? reveals the actual song (title/artist +
    // cover) once the answer is shown: the options above are only the
    // three fixed labels, not the track itself. Cover art is best-effort
    // (needs Spotify configured) and silently drops itself via onerror,
    // same as everywhere else it's used.
    let trackReveal = '';
    if (revealed && q.title) {
      const art = q.spotifyUri ? `<img src="/api/spotify/album-art?uri=${encodeURIComponent(q.spotifyUri)}" alt="" style="width:120px;height:120px;object-fit:cover;border-radius:12px;border:3px solid var(--ink)" onerror="this.remove()">` : '';
      trackReveal = `<div class="card float-in" style="max-width:600px;width:100%;margin-top:10px"><div class="row" style="gap:14px;align-items:center">${art}<div style="text-align:left"><b style="font-size:24px">${esc(q.title)}</b><div class="muted">${esc(q.artist)}</div></div></div></div>`;
    }
    return `
      <div class="badge">${esc(c.name)}</div>
      ${q.criterion ? `<div class="muted">Critère: ${esc(q.criterion)}</div>` : ''}
      <div class="card" style="max-width:600px;width:100%;margin-top:10px;text-align:left">${opts}</div>
      ${trackReveal}
      ${revealed ? '' : `<div class="muted" style="margin-top:10px">${answered}/${total} équipes ont répondu</div>`}`;
  }

  function performHtml(state) {
    const q = state.question, c = state.challenge;
    if (!q) return `<div class="muted">En attente...</div>`;
    let timer = '';
    if (state.performTimer && state.performTimer.running) {
      const remaining = Math.max(0, Math.ceil((state.performTimer.endsAt - Date.now()) / 1000));
      timer = `<div class="timer">${remaining}</div>`;
    }
    return `
      <div class="badge">${esc(c.name)}</div>
      ${q.action ? `<div class="logo pulse" style="font-size:clamp(40px,9vw,90px)">${esc(q.action)}</div>` : '<div style="font-size:70px">🎵</div>'}
      ${timer}`;
  }

  function lobbyHtml(state) {
    return `
      <div class="logo">MUSICAL<br><span class="acid pulse glitch-text" data-text="MAYHEM">MAYHEM</span></div>
      <div class="muted" style="letter-spacing:.14em;text-transform:uppercase">THE ULTIMATE TEAM MUSIC GAME</div>
      <div class="row" style="margin-top:26px;gap:46px;align-items:center;justify-content:center;flex-wrap:wrap">
        <div class="qr-box"><img src="/api/qr?c=${state.joinCode}" width="240" height="240" alt="QR code"/></div>
        <div class="col" style="align-items:flex-start;text-align:left">
          <div class="muted" style="letter-spacing:.1em">SCANNEZ LE QR CODE</div>
          <div class="code-huge">${esc(state.joinCode)}</div>
          <div class="muted small">ou allez sur /team.html et entrez le code</div>
        </div>
      </div>
      <div class="publisher" style="flex-direction:row;justify-content:center;gap:12px;margin:30px 0 0">
        <img src="/img/cross-eyed-cat.jpg" alt="Logo Cross-Eyed Cat" width="64" height="64">
        <span class="muted small">Une édition <b>Cross-Eyed Cat</b></span>
      </div>`;
  }

  function buzzerBanner(state) {
    if (state.buzzer.lockedTeamId) {
      const t = teamById(state, state.buzzer.lockedTeamId);
      const at = state.answerTimer;
      const timer = (at && at.running && at.endsAt)
        ? `<div class="timer" style="font-size:clamp(40px,8vw,80px)">${Math.max(0, Math.ceil((at.endsAt - Date.now()) / 1000))}</div>` : '';
      return `<div class="buzz-hero team-text shake" style="color:${t.color}">⚡ ${esc(t.name)} BUZZ !</div>${timer}`;
    }
    if (state.buzzer.open) return `<div class="buzz-hero pink">🔴 BUZZER OUVERT</div>`;
    return `<div class="badge">🔒 BUZZER FERMÉ</div>`;
  }

  function questionHtml(state) {
    const q = state.question, c = state.challenge;
    if (!q || !c) return `<div class="muted">En attente...</div>`;
    if (c.mode === 'panic') {
      // panic's own runtime phases (panic_running/panic_review) have
      // dedicated screens; 'question' here just means the host hasn't
      // started the chrono yet, no buzzer concept applies to this mode.
      return `<div class="badge">${esc(q.theme || c.name)}</div><div style="font-size:60px">⏳</div><div class="muted">Le chrono va démarrer...</div>`;
    }
    let promptBlock = `<div style="font-size:70px">🎵</div>`;
    if (c.hasClue && q.clue) promptBlock = `<div class="clue-box">"${esc(q.clue)}"</div>`;
    else if (c.multiTrack) promptBlock = `<div style="font-size:70px">🎧</div>`;
    else if (c.mode === 'buzzer_compound' && (c.scoring.parts || []).length > 1 && q.tracks) promptBlock = `<div style="font-size:70px">🧟</div>`;

    let revealBlock = '';
    if (state.reveal.shown) {
      if (q.tracks) {
        revealBlock = `<div class="card float-in" style="margin-top:10px"><div class="row" style="justify-content:center;gap:30px">
          ${q.tracks.map((t, i) => `<div><div class="muted small">${c.multiTrack ? ('MORCEAU ' + (i + 1)) : ('CHANSON ' + String.fromCharCode(65 + i))}</div><b style="font-size:24px">${esc(t.title || '-')}</b><div class="muted">${esc(t.artist || '')}</div></div>`).join('')}
        </div>${q.link ? `<div class="muted" style="margin-top:8px">🔗 ${esc(q.link)}</div>` : ''}</div>`;
      } else if (c.id === 'album_detective') {
        // DÉTECTIVE D'ALBUM scores album+année (data/challenges.json), not
        // title+artist: showing the song title here was just wrong for this
        // challenge, not a display nicety. Cover art is best-effort (needs
        // Spotify configured, see README §7) and silently drops itself via
        // onerror if unavailable, same "never blocks the game" rule as
        // every other optional Spotify feature here.
        const art = q.spotifyUri ? `<img src="/api/spotify/album-art?uri=${encodeURIComponent(q.spotifyUri)}" alt="" style="width:180px;height:180px;object-fit:cover;border-radius:14px;border:3px solid var(--ink);margin-bottom:10px" onerror="this.remove()">` : '';
        revealBlock = `<div class="card float-in" style="margin-top:10px">${art}<b style="font-size:28px">${esc(q.album || '?')}</b>${q.year ? `<div class="muted" style="font-size:20px">${esc(String(q.year))}</div>` : ''}</div>`;
      } else if (c.id === 'movie_soundtrack') {
        // FILM OU SÉRIE ?: shows the movie/series name + poster, not a
        // song title/artist. Poster is a direct, pre-resolved URL (no
        // proxy endpoint needed, unlike Spotify album art) and silently
        // drops itself via onerror if unavailable.
        const poster = q.posterUrl ? `<img src="${esc(q.posterUrl)}" alt="" style="width:160px;height:240px;object-fit:cover;border-radius:12px;border:3px solid var(--ink);margin-bottom:10px" onerror="this.remove()">` : '';
        revealBlock = `<div class="card float-in" style="margin-top:10px">${poster}<b style="font-size:28px">${esc(q.movieTitle || '?')}</b></div>`;
      } else if (q.title) {
        // Same cover-art treatment as album_detective/spotify_roulette
        // above: best-effort (needs Spotify configured) and silently
        // drops itself via onerror if unavailable.
        const art = q.spotifyUri ? `<img src="/api/spotify/album-art?uri=${encodeURIComponent(q.spotifyUri)}" alt="" style="width:120px;height:120px;object-fit:cover;border-radius:12px;border:3px solid var(--ink)" onerror="this.remove()">` : '';
        revealBlock = `<div class="card float-in" style="margin-top:10px"><div class="row" style="gap:16px;align-items:center;justify-content:center">${art}<div style="text-align:left"><b style="font-size:26px">${esc(q.title)}</b><div class="muted">${esc(q.artist)}</div></div></div></div>`;
      }
    }

    let resultBlock = '';
    if (state.phase === 'reveal') {
      const lastResult = [...state.events].reverse().find(e => e.type === 'ANSWER_CORRECT' || e.type === 'ANSWER_WRONG');
      if (lastResult && lastResult.type === 'ANSWER_CORRECT') {
        const t = teamById(state, lastResult.teamId);
        resultBlock = `<div class="acid" style="font-size:38px;font-weight:800">✅ CORRECT · ${esc(t ? t.name : '')} ${MM.fmt(lastResult.points)}</div>`;
      } else if (lastResult && lastResult.type === 'ANSWER_WRONG' && !state.buzzer.lockedTeamId && !state.buzzer.open) {
        resultBlock = `<div class="pink" style="font-size:32px;font-weight:800">❌ PERSONNE N'A TROUVÉ</div>`;
      }
    }

    let tierBadge = '';
    if (c.mode === 'buzzer_tiered') {
      const tiers = c.scoring.tiers, idx = state.buzzer.tierIndex || 0;
      tierBadge = `<div class="badge warn" style="margin-top:8px">${esc(tiers[idx].label)} → +${tiers[idx].points}</div>`;
    }

    return `
      <div class="badge">QUESTION ${state.challengeIndex + 1} / ${state.challengeTotal}</div>
      ${state.phase !== 'reveal' ? playTimerBadge(state) : ''}
      ${promptBlock}
      ${tierBadge}
      ${state.phase === 'reveal' ? resultBlock : buzzerBanner(state)}
      ${revealBlock}`;
  }

  function finalBettingHtml(state) {
    const q = state.question;
    const rows = state.teams.filter(t => t.connected).map(t => {
      const b = state.bets[t.id];
      const status = b && b.locked ? '🔒 VERROUILLÉ' : '⏳ EN COURS...';
      return `<div class="line"><span class="team-chip"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</span><span class="muted">${status}</span></div>`;
    }).join('');
    // Betting used to be completely blind (not even the year): the room
    // sees the same year+style hint as the teams' phones, so everyone is
    // wagering off the same information.
    const hint = (q && (q.year || q.genre)) ? `<div class="row" style="justify-content:center;gap:10px;margin-top:6px">
      ${q.year ? `<span class="badge warn">📅 ${esc(String(q.year))}</span>` : ''}
      ${q.genre ? `<span class="badge warn">🎵 ${esc(q.genre)}</span>` : ''}
    </div>` : '';
    return `
      <div class="logo" style="font-size:clamp(36px,7vw,70px)">FINAL<br><span class="acid">BET</span></div>
      <div class="muted">LOCK YOUR BET</div>
      ${hint}
      <div class="card" style="max-width:520px;width:100%;text-align:left;margin-top:10px">${rows}</div>`;
  }

  function finalGuessHtml(state) {
    return `
      <div class="logo" style="font-size:clamp(30px,6vw,58px)">🎧 DEVINEZ<br>LE TITRE</div>
      ${playTimerBadge(state)}
      <div class="muted" style="margin-top:6px">Tapez la réponse sur vos téléphones...</div>`;
  }

  function finalRevealHtml(state) {
    const q = state.question;
    const rows = state.teams.filter(t => t.connected).map(t => {
      const b = state.bets[t.id] || { amount: 0 };
      let verdict = `<span class="muted">⏳ en jugement...</span>`;
      if (b.resolved) verdict = b.correct ? `<span class="acid" style="font-weight:800">✅ +${b.amount}</span>` : `<span class="pink" style="font-weight:800">❌ -${b.amount}</span>`;
      return `<div class="line"><span class="team-chip"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</span><span>mise ${b.amount} · ${verdict}</span></div>`;
    }).join('');
    return `
      <div class="badge">RÉVÉLATION</div>
      ${q && q.title ? `<div class="card float-in"><b style="font-size:30px">${esc(q.title)}</b><div class="muted">${esc(q.artist)}</div></div>` : `<div style="font-size:60px">🎵</div>`}
      <div class="card" style="max-width:560px;width:100%;text-align:left;margin-top:10px">${rows}</div>`;
  }

  function panicRunningHtml(state) {
    const q = state.question;
    const remaining = Math.max(0, Math.ceil((state.panic.endsAt - Date.now()) / 1000));
    const teamsHtml = state.teams.filter(t => t.connected).map(t => {
      // Never show the submitted TEXT here: this is the public TV, every
      // team is looking at it at once while the chrono is still running,
      // so revealing answers live would let every team just read (and
      // copy) whatever any team has typed so far. Only a count, so the
      // room can still see who's racing without spoiling anyone's answer.
      // Full text only appears once judging starts, in panicReviewHtml
      // below (and it's always been visible to the Host panel throughout,
      // which is fine, that's the judge, not the public screen).
      const count = (state.panic.submissions[t.id] || []).length;
      const items = count ? `<div class="panic-item muted">${count} réponse${count > 1 ? 's' : ''} envoyée${count > 1 ? 's' : ''}</div>` : `<div class="muted small">...</div>`;
      return `<div class="panic-team"><h4 class="team-text" style="color:${t.color}">${esc(t.name)}</h4>${items}</div>`;
    }).join('');
    return `
      <div class="badge">${q ? esc(q.theme) : ''}</div>
      <div class="timer">${remaining}</div>
      <div class="grid" style="width:100%;margin-top:10px">${teamsHtml}</div>`;
  }

  function panicReviewHtml(state) {
    const teamsHtml = state.teams.filter(t => t.connected).map(t => {
      const items = (state.panic.submissions[t.id] || []).map(it => `<div class="panic-item ${it.status}">${esc(it.text)}</div>`).join('') || `<div class="muted small">-</div>`;
      return `<div class="panic-team"><h4 class="team-text" style="color:${t.color}">${esc(t.name)}</h4>${items}</div>`;
    }).join('');
    return `
      <div class="badge warn">JUGEMENT EN COURS</div>
      <div class="grid" style="width:100%;margin-top:10px">${teamsHtml}</div>`;
  }

  // The round that just ended hands out at most one Mayhem card, to
  // whoever improved their score the most (see lib/actions.js's
  // awardRoundWinnerCard). This used to reveal the card on a 6s client-side
  // timer, leaderboard first then the card: the host's own "SÉLECTION
  // SUIVANTE" button had (and still has) no idea that timer exists and was
  // always clickable immediately, so a host who moved at a normal pace —
  // not even quickly, just not deliberately sitting and waiting — could
  // leave the challenge_results phase before the card ever had its turn to
  // show, with nothing on the Host panel even telling them a card had been
  // won (see host.js's resultsHtml, fixed alongside this). Rather than
  // trying to choreograph a timer against a button on a different screen
  // the host can hit whenever they want, both pieces are shown together
  // from the moment this phase starts: nothing to race past, nothing to
  // miss by clicking too soon. "Score recap, then the card" is still true
  // as a reading order (top to bottom), just not as a time delay anymore.
  function challengeResultsHtml(state) {
    const rr = state.roundResult;
    return leaderboardHtml(state) + (rr ? roundExplainHtml(state, rr) : '');
  }

  function roundExplainHtml(state, rr) {
    const t = teamById(state, rr.teamId);
    const powerDef = (state.meta.powers || []).find(p => p.id === rr.powerId) || { id: rr.powerId, name: rr.powerId, emoji: '🃏', description: '' };
    return `
      <div class="badge warn" style="margin-top:24px">🃏 CARTE MAYHEM</div>
      <div class="logo team-text pulse" style="color:${t ? t.color : ''};font-size:clamp(24px,5vw,40px)">${esc(t ? t.name : '')}</div>
      <div class="muted" style="letter-spacing:.1em;margin-bottom:10px;text-transform:uppercase">remporte la manche !</div>
      <div class="row" style="gap:28px;align-items:center;justify-content:center;flex-wrap:wrap;margin-top:6px">
        ${MM.tarotCardHtml(powerDef)}
        <div class="card mayhem" style="max-width:420px;width:100%;text-align:left;padding:22px">
          <div class="crack-overlay"></div>
          <div class="row" style="gap:10px;align-items:center">
            <span style="font-size:40px">${powerDef.emoji || '🃏'}</span>
            <b style="font-size:26px">${esc(powerDef.name)}</b>
          </div>
          <div style="font-size:20px;margin-top:12px;line-height:1.4">${esc(powerDef.description)}</div>
        </div>
      </div>`;
  }

  function leaderboardHtml(state) {
    const sorted = [...inPlayTeams(state)].sort((a, b) => b.score - a.score);
    const max = Math.max(1, ...sorted.map(t => Math.abs(t.score)));
    const medals = ['🥇', '🥈', '🥉'];
    const rows = sorted.map((t, i) => `
      <div class="lead-row float-in" style="animation-delay:${i * 60}ms">
        <span class="rank">${medals[i] || (i + 1)}</span>
        <span class="team-chip" style="min-width:150px"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</span>
        <div style="flex:1"><div class="bar" style="width:${Math.max(4, Math.abs(t.score) / max * 100)}%;background:${t.score < 0 ? 'var(--pink)' : t.color}"></div></div>
        <span class="score">${t.score}</span>
      </div>`).join('');
    return `<div class="logo" style="font-size:clamp(30px,6vw,54px)">CLASSEMENT</div><div style="width:100%;max-width:640px;margin-top:10px">${rows}</div>`;
  }

  function victoryHtml(state) {
    const sorted = [...inPlayTeams(state)].sort((a, b) => b.score - a.score);
    const champion = sorted[0];
    const confetti = Array.from({ length: 26 }, (_, i) => {
      const left = Math.random() * 100;
      const delay = Math.random() * 1.6;
      const emoji = ['🎉', '🎊', '🎵', '⭐'][i % 4];
      return `<span class="confetti-piece" style="left:${left}%;animation-delay:${delay}s">${emoji}</span>`;
    }).join('');
    // The final round's own Mayhem card (if any: a challenge can disable
    // powers, see lib/actions.js's endCurrentChallenge) never gets its own
    // challenge_results stop to be revealed in, since the game jumps
    // straight here instead. A compact mention alongside the champion,
    // not a separate timed reveal, keeps the finale from being held up.
    const rr = state.roundResult;
    const rrTeam = rr ? teamById(state, rr.teamId) : null;
    const rrPower = rr ? (state.meta.powers || []).find(p => p.id === rr.powerId) : null;
    const roundResultLine = (rr && rrTeam && rrPower) ? `<div class="badge warn" style="margin-top:4px">🃏 Dernière carte Mayhem : ${esc(rrTeam.name)} remporte ${rrPower.emoji} ${esc(rrPower.name)}</div>` : '';
    return `
      ${confetti}
      <div class="badge">MUSICAL MAYHEM</div>
      <div class="card mayhem" style="padding:32px 28px;max-width:560px;width:100%">
        <div class="crack-overlay"></div>
        <div class="logo pulse glitch-text" data-text="CHAMPION" style="color:#fff">CHAMPION</div>
        <div style="font-size:80px">🏆</div>
        <div class="logo team-text" style="color:${champion.color}">${esc(champion.name)}</div>
        <div class="score big" style="color:#fff">${champion.score} pts</div>
      </div>
      ${roundResultLine}`;
  }

  function renderScoreStrip(state) {
    if (state.phase === 'victory') { scoreStrip.innerHTML = ''; return; }
    const sorted = [...inPlayTeams(state)].sort((a, b) => b.score - a.score);
    scoreStrip.innerHTML = sorted.map(t => `
      <div class="card tight" style="border-color:${t.connected ? t.color + '55' : 'var(--line)'};opacity:${t.connected ? 1 : .5}">
        <div class="row between"><span class="team-chip"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</span>${t.connected ? '' : '<span class="badge">hors ligne</span>'}</div>
        <div class="score" style="margin-top:6px">${t.score}</div>
      </div>`).join('');
  }
})();
