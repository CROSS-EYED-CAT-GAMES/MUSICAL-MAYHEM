(function () {
  const gate = document.getElementById('gate');
  const cockpit = document.getElementById('cockpit');
  const gateError = document.getElementById('gateError');
  const phaseBadge = document.getElementById('phaseBadge');
  const codeBadge = document.getElementById('codeBadge');
  const progressBadge = document.getElementById('progressBadge');
  const skipBtn = document.getElementById('skipBtn');
  const controlPanel = document.getElementById('controlPanel');
  const spotifyPanel = document.getElementById('spotifyPanel');
  const audioPanel = document.getElementById('audioPanel');
  const teamsGrid = document.getElementById('teamsGrid');
  const eventLog = document.getElementById('eventLog');

  let hostKey = localStorage.getItem('mm_host_key') || '';
  let lastState = null;
  let tickTimer = null;

  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function challengeName(state, id) { const c = (state.meta.challenges || []).find(x => x.id === id); return c ? c.name : id; }
  // Once the game has left the lobby, team slots nobody ever joined just
  // clutter the scoreboard/leaderboard for the rest of the night, so
  // score/roster displays switch to showing only teams a phone actually
  // joined. Still all 6 during the lobby itself, so people can see every
  // slot available to pick. everJoined (not `connected`) so a team stays
  // listed through a brief Wi-Fi drop instead of flickering out.
  function inPlayTeams(state) {
    return state.phase === 'lobby' ? state.teams : state.teams.filter(t => t.everJoined);
  }

  const client = MM.connect(render, onError);
  client.onOpen(() => { if (hostKey) client.send({ type: 'hello', role: 'host', hostKey }); });

  window.mmSetHostKey = function () {
    hostKey = document.getElementById('hostKeyInput').value.trim().toUpperCase();
    localStorage.setItem('mm_host_key', hostKey);
    client.send({ type: 'hello', role: 'host', hostKey });
    setTimeout(() => { if (lastState && lastState.role !== 'host') { gateError.classList.remove('hidden'); } }, 400);
  };

  const ERROR_MESSAGES = {
    no_challenges_enabled: 'Aucune épreuve cochée : cochez-en au moins une avant de démarrer.',
    bad_challenge: 'Épreuve invalide.',
    need_track: 'Il manque une piste.',
    need_more_tracks: 'Il manque des pistes pour cette épreuve.',
    need_more_options: 'Remplissez toutes les options.',
    need_original_artist: "L'artiste original est obligatoire.",
    need_clue: 'La traduction affichée est obligatoire.',
    need_word_pool: 'Ajoutez au moins un mot interdit.',
    need_banned_words: 'Ajoutez au moins un mot banni.',
    need_category: 'Choisissez une catégorie.',
    spotify_device_lost: "L'écran Spotify s'est déconnecté : rouvrez screen.html pour retrouver le son.",
    spotify_playback_failed: 'La commande Spotify a échoué, réessayez.',
    buzzer_locked: "Impossible de changer de palier pendant qu'une équipe répond.",
    auto_tiered: 'Les paliers de cette épreuve défilent automatiquement avec le temps.'
  };

  function onError(msg) {
    if (msg === 'not_host') { gateError.classList.remove('hidden'); gate.classList.remove('hidden'); cockpit.classList.add('hidden'); return; }
    if (ERROR_MESSAGES[msg]) MM.toast('⚠️ ' + ERROR_MESSAGES[msg]);
  }

  function send(obj) { client.send(obj); }
  window.mmUndo = () => send({ type: 'host:undo' });
  window.mmReset = () => { if (confirm('Réinitialiser toute la partie ? Les scores et connexions seront perdus.')) send({ type: 'host:reset' }); };
  window.mmDemo = () => { if (confirm('Lancer une partie de démonstration automatique (~90s) ? Cela réinitialise la partie en cours.')) send({ type: 'host:startDemo' }); };
  window.mmSkipChallenge = () => { if (confirm('Passer ce défi sans le terminer ?')) send({ type: 'host:skipChallenge' }); };
  window.mmNextQuestion = () => send({ type: 'host:nextQuestion' });
  window.mmOpenBuzzer = () => send({ type: 'host:openBuzzer' });
  window.mmCloseBuzzer = () => send({ type: 'host:closeBuzzer' });
  window.mmReveal = () => send({ type: 'host:reveal' });
  window.mmAdvanceTier = () => send({ type: 'host:advanceTier' });
  window.mmMark = (payload) => send(Object.assign({ type: 'host:markAnswer' }, payload));
  window.mmMarkParts = function (teamId) {
    const c = lastState.challenge;
    const parts = {};
    (c.scoring.parts || []).forEach(p => { const el = document.getElementById('part_' + p.key); parts[p.key] = !!(el && el.checked); });
    send({ type: 'host:markAnswer', teamId, parts });
  };
  // One click for "fully wrong, no partial credit": skips reading the
  // checkboxes entirely (VALIDER with all of them left unchecked already
  // resolves to the same 0 points, but this is the unambiguous, can't
  // forget one still-checked box, way to say it).
  window.mmMarkNone = (teamId) => send({ type: 'host:markAnswer', teamId, parts: {} });
  window.mmAwardBonus = (teamId) => send({ type: 'host:awardBonus', teamId });
  window.mmMarkViolation = (teamId) => send({ type: 'host:markViolation', teamId });
  window.mmAward = (teamId, delta) => send({ type: 'host:award', teamId, delta });
  window.mmAwardCustom = (teamId) => {
    const el = document.getElementById('custom_' + teamId);
    const v = Math.floor(Number(el.value));
    if (Number.isFinite(v) && v !== 0) send({ type: 'host:award', teamId, delta: v });
    el.value = '';
  };
  window.mmGrantPower = (teamId) => {
    const sel = document.getElementById('grant_' + teamId);
    send({ type: 'host:grantPower', teamId, powerId: sel.value });
  };
  window.mmRevokePower = (teamId, instId) => send({ type: 'host:revokePower', teamId, instId });
  window.mmRenameTeam = (teamId, currentName) => {
    const name = prompt('Nouveau nom pour cette équipe :', currentName);
    if (name && name.trim()) send({ type: 'host:renameTeam', teamId, name: name.trim() });
  };
  window.mmTriggerChaos = () => send({ type: 'host:triggerChaos' });
  window.mmClearChaos = () => send({ type: 'host:clearChaos' });

  // --- selection / configuration -----------------------------------------

  window.mmToggleChallenge = function (id, checked) {
    const current = new Set(lastState.setup.enabledChallengeIds);
    if (checked) current.add(id); else current.delete(id);
    send({ type: 'host:configureGame', enabledChallengeIds: [...current] });
  };
  window.mmToggleAllChallenges = function (checked) {
    const ids = checked ? (lastState.meta.challenges || []).filter(c => c.implemented !== false).map(c => c.id) : [];
    send({ type: 'host:configureGame', enabledChallengeIds: ids });
  };
  window.mmApplySelectionCfg = function () {
    send({
      type: 'host:configureGame',
      selection: {
        policy: document.getElementById('cfgPolicy').value,
        allowRepeat: document.getElementById('cfgRepeat').checked,
        comebackEnabled: document.getElementById('cfgComeback').checked,
        maxConsecutiveSelections: lastState.setup.selection.maxConsecutiveSelections,
        optionsOffered: lastState.setup.selection.optionsOffered
      },
      maxChallenges: Number(document.getElementById('cfgMax').value) || lastState.setup.maxChallenges,
      maxPlaySeconds: Number(document.getElementById('cfgPlaySeconds').value) || lastState.setup.maxPlaySeconds,
      answerSeconds: Number(document.getElementById('cfgAnswerSeconds').value) || lastState.setup.answerSeconds
    });
  };
  window.mmStartSelection = () => send({ type: 'host:startSelection' });
  window.mmForcePick = (id) => send({ type: 'host:forcePick', challengeId: id });
  window.mmConfirmAutoPick = () => send({ type: 'host:confirmAutoPick' });
  window.mmResolveDuel = (id) => send({ type: 'host:resolveDuel', challengeId: id });

  // --- panic / bet / perform ----------------------------------------------

  window.mmStartPanic = () => {
    const sec = Number(document.getElementById('panicSeconds').value) || 30;
    send({ type: 'host:startPanicTimer', seconds: sec });
  };
  window.mmMarkPanicItem = (teamId, itemIndex, valid) => send({ type: 'host:markPanicItem', teamId, itemIndex, valid });
  window.mmResolvePanicChallenge = (challengeId, accept) => send({ type: 'host:resolveChallenge', challengeId, accept });
  window.mmStartFinalReveal = () => send({ type: 'host:startFinalReveal' });
  window.mmMarkBet = (teamId, correct) => send({ type: 'host:markBet', teamId, correct });
  window.mmEndGame = () => { if (confirm('Terminer la partie et afficher le champion ?')) send({ type: 'host:endGame' }); };
  window.mmRevealChoices = () => send({ type: 'host:revealChoices' });
  window.mmStartPerformTimer = () => send({ type: 'host:startPerformTimer' });

  window.mmAudio = function (action, idx) {
    const el = document.getElementById('audioPlayer' + (idx || 0));
    if (!el) return;
    // Local playback is entirely client-side (this <audio> element), so
    // the server has no way to know a play/restart happened unless we
    // tell it, needed so it can also open the buzzer (see
    // ensureBuzzerOpenForPlayback in lib/actions.js). The music side of
    // these calls is a no-op while ManualMusicSource is active.
    if (action === 'play') { el.play().catch(() => {}); send({ type: 'host:musicPlay', index: idx || 0 }); }
    if (action === 'pause') { el.pause(); send({ type: 'host:musicPause' }); }
    if (action === 'restart') { el.currentTime = 0; el.play().catch(() => {}); send({ type: 'host:musicRestart', index: idx || 0 }); }
    if (action === 'back3') { el.currentTime = Math.max(0, el.currentTime - 3); el.play().catch(() => {}); }
  };

  // --- Spotify playback (real audio, no local files) ---------------------
  // Separate from the search panel below: this drives actual play/pause/
  // seek through the Screen tab's Web Playback SDK device, once the host
  // has connected their Premium account. Status is polled over plain
  // HTTP (not part of the WS game state) since it's account-level, not
  // per-game.
  let spotifyStatus = { authorized: false, deviceReady: false };

  function refreshSpotifyStatus() {
    fetch('/api/spotify/status').then(r => r.json()).then(s => {
      // A silent "Écran : 🔴 en attente" in a panel the host isn't staring
      // at is exactly how a Connect session dying mid-party went unnoticed
      // until someone actually pressed ▶ and heard nothing. Surface the
      // drop proactively (not the other direction: coming back ready is
      // self-evident the moment playback is tried, no toast needed for it).
      if (spotifyStatus.deviceReady && !s.deviceReady) {
        MM.toast('⚠️ Écran Spotify déconnecté — rechargez screen.html', 4000);
      }
      spotifyStatus = s;
      renderSpotifyPanel();
      if (lastState) renderAudioPanel(lastState);
    }).catch(() => {});
  }

  function renderSpotifyPanel() {
    if (!spotifyStatus.authorized) {
      spotifyPanel.innerHTML = `<div class="row between">
        <div><b>🎧 Spotify</b><div class="muted small">Compte Premium non connecté : lecture manuelle uniquement.</div></div>
        <button class="btn primary mini-btn" onclick="mmConnectSpotify()">Connecter Spotify</button>
      </div>`;
      return;
    }
    const deviceOn = spotifyStatus.deviceReady;
    spotifyPanel.innerHTML = `<div class="row between">
      <div><b>🎧 Spotify · ✅ connecté</b>
        <div class="muted small">Écran : ${deviceOn ? '🟢 prêt à jouer le son' : '🔴 en attente (ouvrez screen.html)'}</div>
      </div>
      <button class="btn ghost mini-btn" onclick="mmDisconnectSpotify()">Déconnecter</button>
    </div>`;
  }

  window.mmConnectSpotify = function () {
    window.open('/auth/spotify/login?key=' + encodeURIComponent(hostKey), '_blank', 'width=480,height=720');
    setTimeout(refreshSpotifyStatus, 4000);
  };
  window.mmDisconnectSpotify = function () {
    send({ type: 'host:disconnectSpotify' });
    setTimeout(refreshSpotifyStatus, 300);
  };

  window.mmSpotifyAudio = function (action, idx) {
    if (action === 'play') send({ type: 'host:musicPlay', index: idx });
    if (action === 'pause') send({ type: 'host:musicPause' });
    if (action === 'restart') send({ type: 'host:musicRestart', index: idx });
    if (action === 'back3') send({ type: 'host:musicSeekBack', ms: 3000 });
  };

  refreshSpotifyStatus();
  setInterval(refreshSpotifyStatus, 5000);

  function render(state) {
    lastState = state;
    if (state.role !== 'host') {
      gate.classList.remove('hidden');
      cockpit.classList.add('hidden');
      return;
    }
    gate.classList.add('hidden');
    cockpit.classList.remove('hidden');

    phaseBadge.textContent = state.phase.toUpperCase();
    codeBadge.textContent = 'CODE ' + state.joinCode;
    progressBadge.textContent = state.progress.challengesPlayed + '/' + state.progress.maxChallenges + ' défis · ~' +
      state.progress.estimatedMinutesPlayed + '/' + state.progress.targetDurationMinutes + ' min';
    skipBtn.hidden = !state.challenge;

    renderControlPanel(state);
    renderAudioPanel(state);
    renderTeams(state);
    renderLog(state);
    // Rendered once, not on every state broadcast: it holds in-progress
    // typing/track picks the host is actively building, which a periodic
    // re-render would otherwise wipe (same class of bug as the config
    // checklist scroll reset). It only redraws itself in response to its
    // own interactions (challenge switch, slot pick, submit).
    if (!addQuestionReady) { addQuestionReady = true; renderAddQuestionPanel(); }

    if (!tickTimer) {
      tickTimer = setInterval(() => {
        if (!lastState) return;
        if (lastState.phase === 'panic_running') renderControlPanel(lastState);
        if (lastState.phase === 'perform_active' && lastState.performTimer.running) renderControlPanel(lastState);
        if (lastState.playTimer && lastState.playTimer.running) renderControlPanel(lastState);
        // Surgical, not a renderControlPanel() call like the others above:
        // the answer-timer ticks while a buzzer_compound answer is being
        // judged, and that panel's part checkboxes are pure client-side DOM
        // state (never round-tripped until VALIDER is clicked). A full
        // rebuild here every 500ms would silently uncheck whatever the host
        // had already ticked mid-judgment.
        if (lastState.answerTimer && lastState.answerTimer.running) updateAnswerTimerBadge(lastState);
      }, 500);
    }
  }

  // Same 30s play-timer badge shown on Screen, so the host can pace
  // without looking away from the cockpit.
  function playTimerBadge(state) {
    const pt = state.playTimer;
    if (!pt) return '';
    if (pt.running && pt.endsAt) {
      const remaining = Math.max(0, Math.ceil((pt.endsAt - Date.now()) / 1000));
      return `<span class="badge ${remaining <= 5 ? 'warn' : ''}">⏱ ${remaining}s</span>`;
    }
    if (pt.remainingMs != null && pt.remainingMs > 0) {
      return `<span class="badge">⏸ ${Math.ceil(pt.remainingMs / 1000)}s</span>`;
    }
    return '';
  }

  // How long the locked-in team has left to answer out loud before it
  // auto-resolves as wrong (host:configureGame's answerSeconds, see the
  // Configuration screen). Rendered with a stable id so the 500ms tick
  // above can update just this text node instead of the whole panel.
  function answerTimerBadge(state) {
    const at = state.answerTimer;
    if (!at || !at.running || !at.endsAt) return '';
    const remaining = Math.max(0, Math.ceil((at.endsAt - Date.now()) / 1000));
    return ` <span class="badge ${remaining <= 3 ? 'off' : 'warn'}" id="answerTimerBadge">⏱ ${remaining}s</span>`;
  }
  function updateAnswerTimerBadge(state) {
    const el = document.getElementById('answerTimerBadge');
    if (!el) return;
    const remaining = Math.max(0, Math.ceil((state.answerTimer.endsAt - Date.now()) / 1000));
    el.textContent = '⏱ ' + remaining + 's';
    el.classList.toggle('off', remaining <= 3);
    el.classList.toggle('warn', remaining > 3);
  }

  function renderControlPanel(state) {
    if (state.phase === 'lobby') {
      // Every checkbox toggle round-trips through the server (so all
      // hosts/reconnects stay in sync) and comes back as a full re-render,
      // which would otherwise snap the scrollable challenge list back to
      // the top on every click. Preserve it across the innerHTML swap.
      const prevGrid = controlPanel.querySelector('.config-grid');
      const scrollTop = prevGrid ? prevGrid.scrollTop : 0;
      controlPanel.innerHTML = configHtml(state);
      const newGrid = controlPanel.querySelector('.config-grid');
      if (newGrid) newGrid.scrollTop = scrollTop;
      return;
    }
    if (state.phase === 'selection') { controlPanel.innerHTML = selectionHtml(state); return; }
    if (state.phase === 'challenge_intro') { controlPanel.innerHTML = introHtml(state); return; }
    if (state.phase === 'challenge_results') { controlPanel.innerHTML = resultsHtml(state); return; }
    if (state.phase === 'victory') { controlPanel.innerHTML = victoryHtml(state); return; }
    const c = state.challenge;
    if (!c) { controlPanel.innerHTML = '<p class="muted">En attente...</p>'; return; }
    if (c.mode === 'panic') { controlPanel.innerHTML = panicControlHtml(state); return; }
    if (c.mode === 'bet') { controlPanel.innerHTML = betControlHtml(state); return; }
    if (c.mode === 'choice') { controlPanel.innerHTML = choiceHtml(state); return; }
    if (c.mode === 'perform') { controlPanel.innerHTML = performHtml(state); return; }
    controlPanel.innerHTML = buzzerFamilyHtml(state);
  }

  function configHtml(state) {
    const setup = state.setup;
    const catalog = (state.meta.challenges || []).filter(c => c.implemented !== false);
    const rows = catalog.map(c => `
      <label class="challenge-row ${c.legacy ? 'legacy' : ''}">
        <input type="checkbox" ${setup.enabledChallengeIds.includes(c.id) ? 'checked' : ''} onchange="mmToggleChallenge('${c.id}', this.checked)">
        <span style="font-size:20px">${c.icon}</span>
        <span style="flex:1">
          <div><b>${esc(c.name)}</b> <span class="muted small">· ${c.estimatedMinutes} min · difficulté ${c.difficulty}${c.requiresLocalAudio ? ' · 🎵 audio local requis' : ''}</span></div>
          <div class="muted small">${esc(c.description)}</div>
        </span>
      </label>`).join('');
    const noneEnabled = setup.enabledChallengeIds.length === 0;
    return `
      <h2 style="margin-top:0">⚙️ Configuration de la partie</h2>
      <div class="row between" style="align-items:baseline">
        <p class="muted small" style="margin:0">Cochez les épreuves disponibles ce soir, réglez la sélection, puis lancez.</p>
        <span class="row" style="gap:6px">
          <button class="btn ghost mini-btn" onclick="mmToggleAllChallenges(true)">Tout cocher</button>
          <button class="btn ghost mini-btn" onclick="mmToggleAllChallenges(false)">Tout décocher</button>
        </span>
      </div>
      <div class="config-grid">${rows}</div>
      ${noneEnabled ? '<p class="pink small" style="margin-top:6px">Aucune épreuve cochée : cochez-en au moins une pour pouvoir démarrer.</p>' : ''}
      <div class="row" style="margin-top:12px">
        <div class="col" style="flex:1;min-width:180px">
          <label class="muted small">Qui choisit la prochaine épreuve ?</label>
          <select id="cfgPolicy" onchange="mmApplySelectionCfg()">
            <option value="winner" ${setup.selection.policy === 'winner' ? 'selected' : ''}>🏆 Le gagnant du défi</option>
            <option value="last" ${setup.selection.policy === 'last' ? 'selected' : ''}>🔄 Le dernier au classement</option>
            <option value="roulette" ${setup.selection.policy === 'roulette' ? 'selected' : ''}>🎲 Roulette aléatoire</option>
            <option value="duel" ${setup.selection.policy === 'duel' ? 'selected' : ''}>⚔️ Duel (top 2)</option>
            <option value="chaos" ${setup.selection.policy === 'chaos' ? 'selected' : ''}>🌀 Chaos (automatique)</option>
          </select>
        </div>
        <div class="col" style="flex:1;min-width:140px">
          <label class="muted small">Nombre d'épreuves</label>
          <input type="number" id="cfgMax" value="${setup.maxChallenges}" min="3" max="15" onchange="mmApplySelectionCfg()">
        </div>
        <div class="col" style="flex:1;min-width:140px">
          <label class="muted small">Durée max par musique (s)</label>
          <input type="number" id="cfgPlaySeconds" value="${setup.maxPlaySeconds || 30}" min="5" max="120" onchange="mmApplySelectionCfg()">
        </div>
        <div class="col" style="flex:1;min-width:140px">
          <label class="muted small">Temps pour répondre après un buzz (s)</label>
          <input type="number" id="cfgAnswerSeconds" value="${setup.answerSeconds || 15}" min="3" max="60" onchange="mmApplySelectionCfg()">
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <label class="btn ghost mini-btn"><input type="checkbox" id="cfgRepeat" ${setup.selection.allowRepeat ? 'checked' : ''} onchange="mmApplySelectionCfg()"> Autoriser les répétitions</label>
        <label class="btn ghost mini-btn"><input type="checkbox" id="cfgComeback" ${setup.selection.comebackEnabled ? 'checked' : ''} onchange="mmApplySelectionCfg()"> Comeback dernier de la partie</label>
      </div>
      <button class="btn primary xl block" style="margin-top:16px" onclick="mmStartSelection()" ${noneEnabled ? 'disabled' : ''}>🚀 DÉMARRER LA SÉLECTION</button>`;
  }

  function optionCard(c, fn) {
    return `<button class="option-card" onclick="${fn}('${c.id}')">
      <div class="row between"><span style="font-size:24px">${c.icon}</span><span class="badge">${c.estimatedMinutes} min</span></div>
      <b>${esc(c.name)}</b><div class="muted small">${esc(c.description)}</div>
    </button>`;
  }

  function selectionHtml(state) {
    const sel = state.selection;
    const chooser = state.teams.find(t => t.id === sel.chooserTeamId);
    const second = state.teams.find(t => t.id === sel.secondChooserTeamId);

    if (sel.policy === 'chaos' || sel.policy === 'final') {
      const c = sel.options[0];
      return `<h2 style="margin-top:0">${sel.policy === 'chaos' ? '🌀 CHAOS choisit...' : '🏁 ÉPREUVE FINALE'}</h2>
        ${c ? optionCard(c, 'mmForcePick') : ''}
        <button class="btn primary lg block" style="margin-top:10px" onclick="mmConfirmAutoPick()">▶ CONTINUER</button>`;
    }

    if (sel.policy === 'duel') {
      const pickA = sel.duelPicks[sel.chooserTeamId];
      const pickB = sel.duelPicks[sel.secondChooserTeamId];
      const colA = `<div class="col" style="flex:1"><b class="team-text" style="color:${chooser ? chooser.color : ''}">${esc(chooser ? chooser.name : '')}</b>
        ${pickA ? `<p class="acid">✅ a choisi ${esc(challengeName(state, pickA))}</p>` : sel.options.map(c => optionCard(c, 'mmForcePick')).join('')}</div>`;
      const colB = `<div class="col" style="flex:1"><b class="team-text" style="color:${second ? second.color : ''}">${esc(second ? second.name : '')}</b>
        ${pickB ? `<p class="acid">✅ a choisi ${esc(challengeName(state, pickB))}</p>` : sel.optionsB.map(c => optionCard(c, 'mmForcePick')).join('')}</div>`;
      let resolve = '';
      if (pickA && pickB) {
        resolve = `<div class="row" style="margin-top:12px">
          <button class="btn primary block" onclick="mmResolveDuel('${pickA}')">JOUER : ${esc(challengeName(state, pickA))}</button>
          <button class="btn cyan block" onclick="mmResolveDuel('${pickB}')">JOUER : ${esc(challengeName(state, pickB))}</button>
        </div>`;
      }
      return `<h2 style="margin-top:0">⚔️ DUEL</h2><div class="row" style="align-items:flex-start">${colA}${colB}</div>${resolve}`;
    }

    return `<h2 class="team-text" style="margin-top:0;color:${chooser ? chooser.color : ''}">${esc(chooser ? chooser.name : '')} choisit la prochaine épreuve</h2>
      <div class="grid" style="margin-top:10px">${sel.options.map(c => optionCard(c, 'mmForcePick')).join('')}</div>
      <p class="muted small" style="margin-top:10px">En attente du choix sur le téléphone de ${esc(chooser ? chooser.name : '')}. En cas de souci, cliquez directement une carte pour forcer le choix.</p>`;
  }

  function introHtml(state) {
    const c = state.challenge;
    return `<h2 style="margin-top:0">${c.icon} ${esc(c.name)}</h2><p class="muted">${esc(c.description)}</p>
      <button class="btn primary lg block" onclick="mmNextQuestion()">▶ COMMENCER</button>`;
  }
  // Took `state` as a parameter at every call site but never actually used
  // it: the host's own panel showed nothing about a round's Mayhem card,
  // so nothing here ever prompted the host to pause and let screen.html's
  // own reveal (public/js/screen.js) actually be seen before clicking
  // straight through to the next selection.
  function resultsHtml(state) {
    return `<h2 style="margin-top:0">Défi terminé</h2>${roundResultCardHtml(state)}<button class="btn primary lg block" onclick="mmStartSelection()">SÉLECTION SUIVANTE ▶</button>`;
  }
  function roundResultCardHtml(state) {
    const rr = state.roundResult;
    if (!rr) return '';
    const t = state.teams.find(x => x.id === rr.teamId);
    const powerDef = (state.meta.powers || []).find(p => p.id === rr.powerId) || {};
    return `<div class="card tight" style="margin:10px 0;border-color:${t ? t.color : 'var(--ink)'}">
      <b>🃏 ${t ? esc(t.name) : ''} remporte ${powerDef.emoji || ''} ${esc(powerDef.name || rr.powerId)}</b>
      <div class="muted small">${esc(powerDef.description || '')}</div>
    </div>`;
  }
  function victoryHtml(state) {
    return `<h2 style="margin-top:0">🏆 Partie terminée</h2>${roundResultCardHtml(state)}<p class="muted">Utilisez RESET pour une nouvelle partie.</p>`;
  }

  function buzzerFamilyHtml(state) {
    const c = state.challenge, q = state.question;
    if (!q) return `<button class="btn primary lg block" onclick="mmNextQuestion()">▶ QUESTION 1</button>`;
    let head = `<div class="row between"><h3 style="margin:0">Q${state.challengeIndex + 1}/${state.challengeTotal} · ${esc(c.name)}</h3><span class="row" style="gap:6px">${playTimerBadge(state)}<span class="badge">${state.buzzer.open ? '🔴 OUVERT' : '🔒 FERMÉ'}</span></span></div>`;

    let answerKey = '';
    if (c.mode === 'buzzer_compound') {
      if (q.tracks) {
        answerKey = q.tracks.map((t, i) => `<div class="muted small">${esc((c.scoring.parts[i] || {}).label || ('Chanson ' + (i + 1)))}: <b>${esc(t.title || '-')}</b> · ${esc(t.artist || '')}</div>`).join('');
      } else if (c.id === 'cover_original') {
        answerKey = `<div class="muted small">Reprise jouée par: <b>${esc(q.track ? q.track.artist : '-')}</b><br>Originale par: <b>${esc((q.extra && q.extra.original) || '-')}</b></div>`;
      } else if (q.track) {
        answerKey = c.scoring.parts.map(p => `<div class="muted small">${esc(p.label)}: <b>${esc(q.track[p.key] || '-')}</b></div>`).join('');
      }
    } else if (c.hasClue) {
      answerKey = `<div class="muted small">Indice affiché: "${esc(q.clue)}"<br>Réponse: <b>${esc(q.track ? q.track.title : '-')}</b> · ${esc(q.track ? q.track.artist : '')}</div>`;
    } else if (c.multiTrack) {
      answerKey = (q.tracks || []).map(t => `<div class="muted small"><b>${esc(t.title || '-')}</b> · ${esc(t.artist || '')}</div>`).join('') +
        `<div class="muted small">🔗 Lien: <b>${esc(q.link || '-')}</b></div>`;
    } else if (c.randomFromTags) {
      answerKey = `<div class="muted small">Catégorie: <b>${esc(q.category)}</b><br>Réponse: <b>${esc(q.track ? q.track.title : '-')}</b> · ${esc(q.track ? q.track.artist : '')}</div>`;
    } else if (c.id === 'movie_soundtrack') {
      answerKey = `<div class="muted small">Film / Série: <b>${esc(q.track ? (q.track.movieTitle || '-') : '-')}</b><br>Musique: ${esc(q.track ? q.track.title : '-')} · ${esc(q.track ? q.track.artist : '')}</div>`;
    } else {
      answerKey = `<div class="muted small">Réponse: <b>${esc(q.track ? q.track.title : '-')}</b> · ${esc(q.track ? q.track.artist : '')}</div>`;
    }
    if (q.hint) answerKey += `<div class="muted small">🔮 Indice: ${esc(q.hint)}</div>`;

    let payloadPanel = '';
    if (c.hasPrivatePayload && c.privatePayloadKind === 'forbidden_word') {
      const rows = state.teams.filter(t => t.connected).map(t => {
        const p = (state.privateAssignments || {})[t.id];
        return `<div class="line"><span class="team-text" style="color:${t.color}">${t.emoji} ${esc(t.name)}</span>
          <span class="row"><span class="muted small">mot: <b>${esc(p ? p.word : '-')}</b></span>
          <button class="btn danger mini-btn" onclick="mmMarkViolation('${t.id}')">🚫 violation</button></span></div>`;
      }).join('');
      payloadPanel = `<div class="card tight" style="margin-top:8px;border-color:var(--pink)"><b class="small">🔒 MOTS INTERDITS (privé, vu par vous seul)</b>${rows}</div>`;
    }

    let tierControl = '';
    if (c.mode === 'buzzer_tiered') {
      const tiers = c.scoring.tiers;
      const idx = state.buzzer.tierIndex || 0;
      const autoTiered = tiers.every(t => typeof t.seconds === 'number');
      tierControl = `<div class="row" style="margin-top:8px;align-items:center">
        <span class="badge warn">${esc(tiers[idx].label)} → +${tiers[idx].points}${autoTiered ? ' ⏱' : ''}</span>
        ${autoTiered
          ? '<span class="muted small">défile automatiquement avec la lecture</span>'
          : `<button class="btn ghost mini-btn" onclick="mmAdvanceTier()" ${idx >= tiers.length - 1 || state.buzzer.lockedTeamId ? 'disabled' : ''}>⏭ PALIER SUIVANT</button>`}
      </div>`;
    }

    const controls = `<div class="row" style="margin-top:10px">
      <button class="btn danger" onclick="mmOpenBuzzer()" ${state.buzzer.open || state.buzzer.lockedTeamId ? 'disabled' : ''}>🔴 OUVRIR BUZZER</button>
      <button class="btn ghost" onclick="mmCloseBuzzer()">🔒 FERMER</button>
      <button class="btn ghost" onclick="mmReveal()">👁 RÉVÉLER / PASSER</button>
    </div>`;

    let answerPanel = '';
    if (state.buzzer.lockedTeamId) {
      const t = state.teams.find(x => x.id === state.buzzer.lockedTeamId);
      if (c.mode === 'buzzer_compound') {
        const checks = c.scoring.parts.map(p => `<label class="btn ghost"><input type="checkbox" id="part_${p.key}"> ${esc(p.label)} +${p.points}</label>`).join('');
        answerPanel = `<div class="card glow" style="margin-top:10px"><b>⚡ ${esc(t.name)}</b>${answerTimerBadge(state)}
          <div class="row" style="margin-top:8px">${checks}</div>
          <div class="row" style="margin-top:8px">
            <button class="btn primary" onclick="mmMarkParts('${t.id}')">VALIDER</button>
            <button class="btn danger" onclick="mmMarkNone('${t.id}')">❌ AUCUN POINT</button>
          </div></div>`;
      } else {
        answerPanel = `<div class="card glow" style="margin-top:10px"><b>⚡ ${esc(t.name)}</b>${answerTimerBadge(state)}
          <div class="row" style="margin-top:8px">
            <button class="btn primary" onclick="mmMark({teamId:'${t.id}',correct:true})">✅ CORRECT</button>
            <button class="btn danger" onclick="mmMark({teamId:'${t.id}',correct:false})">❌ FAUX</button>
          </div></div>`;
      }
    }

    let bonusPanel = '';
    if (c.hasBonusStep && state.phase === 'reveal') {
      const rows = state.teams.filter(t => t.connected).map(t => `<button class="btn ghost mini-btn" onclick="mmAwardBonus('${t.id}')">${t.emoji} +${c.bonusPoints} bonus</button>`).join(' ');
      bonusPanel = `<div class="row" style="margin-top:8px">${rows}</div>`;
    }

    const nextBtn = `<button class="btn primary lg block" style="margin-top:10px" onclick="mmNextQuestion()">SUIVANTE ⏭</button>`;
    return head + `<div style="margin-top:6px">${answerKey}</div>` + payloadPanel + tierControl + controls + answerPanel + bonusPanel + nextBtn;
  }

  function choiceHtml(state) {
    const c = state.challenge, q = state.question;
    if (!q) return `<button class="btn primary lg block" onclick="mmNextQuestion()">▶ QUESTION 1</button>`;
    let head = `<h3 style="margin:0">Q${state.challengeIndex + 1}/${state.challengeTotal} · ${esc(c.name)}</h3>`;
    if (q.criterion) head += `<div class="muted small">Critère: ${esc(q.criterion)}</div>`;
    // JOUEUR A, JOUEUR B OU LES DEUX ? has a single track at the top level (the
    // options are fixed answer labels, not tracks, so they never carry
    // their own title/artist); this only shows up where relevant.
    if (q.track && q.track.title) head += `<div class="muted small">🎵 ${esc(q.track.title)} · ${esc(q.track.artist)}</div>`;

    const optsHtml = (q.options || []).map((o, i) => {
      const label = o.title ? `${esc(o.title)} · ${esc(o.artist)}` : esc(o.label || ('Option ' + (i + 1)));
      const isCorrect = state.phase === 'choice_reveal' && q.correctIndex === i;
      return `<div class="line" style="${isCorrect ? 'color:var(--acid);font-weight:900' : ''}">${i + 1}. ${label}${isCorrect ? ' ✓' : ''}</div>`;
    }).join('');

    const answered = state.choices.answeredTeamIds.length;
    const total = state.teams.filter(t => t.connected).length;
    let body = `<div style="margin-top:8px">${optsHtml}</div><div class="muted small" style="margin-top:8px">${answered}/${total} équipes ont répondu</div>`;

    let action = '';
    if (state.phase === 'choice_active') {
      action = `<button class="btn primary lg block" style="margin-top:10px" onclick="mmRevealChoices()">👁 RÉVÉLER</button>`;
    } else {
      const rows = state.teams.filter(t => t.connected).map(t => {
        const picked = state.choices.revealed ? state.choices.revealed[t.id] : null;
        const correct = picked === q.correctIndex;
        return `<div class="line"><span>${t.emoji} ${esc(t.name)}</span><span>${picked != null ? (correct ? '✅' : '❌') + ' opt.' + (picked + 1) : '-'}</span></div>`;
      }).join('');
      action = `<div style="margin-top:8px">${rows}</div><button class="btn primary lg block" style="margin-top:10px" onclick="mmNextQuestion()">SUIVANTE ⏭</button>`;
    }
    return head + body + action;
  }

  function performHtml(state) {
    const c = state.challenge, q = state.question;
    if (!q) return `<button class="btn primary lg block" onclick="mmNextQuestion()">▶ QUESTION 1</button>`;
    let head = `<h3 style="margin:0">Q${state.challengeIndex + 1}/${state.challengeTotal} · ${esc(c.name)}</h3>`;
    if (q.action) head += `<div class="score" style="margin-top:6px">${esc(q.action)}</div>`;

    let timerHtml = '';
    if (c.durationSeconds) {
      if (state.performTimer.running) {
        const remaining = Math.max(0, Math.ceil((state.performTimer.endsAt - Date.now()) / 1000));
        timerHtml = `<div class="timer" style="font-size:50px">${remaining}</div>`;
      } else {
        timerHtml = `<button class="btn ghost" onclick="mmStartPerformTimer()">▶ LANCER LE CHRONO (${c.durationSeconds}s)</button>`;
      }
    }

    let payloadHtml = '';
    if (c.hasPrivatePayload) {
      const rows = state.teams.filter(t => t.connected).map(t => {
        const p = (state.privateAssignments || {})[t.id];
        if (!p) return '';
        const text = p.kind === 'banned_words' ? (p.words || []).join(', ') : p.word;
        return `<div class="line"><span class="team-text" style="color:${t.color}">${esc(t.name)}</span>
          <span class="row"><span class="muted small">${esc(text)}</span>
          <button class="btn danger mini-btn" onclick="mmMarkViolation('${t.id}')">🚫 mot dit (-${c.violationPenalty || 2})</button></span></div>`;
      }).join('');
      payloadHtml = `<div class="card tight" style="margin-top:8px;border-color:var(--pink)"><b class="small">🔒 CONTENU PRIVÉ (vu par vous seul)</b>${rows}</div>`;
    }

    const points = (c.scoring && c.scoring.points) || 2;
    const awardRows = state.teams.filter(t => t.connected).map(t => `
      <div class="line"><span>${t.emoji} ${esc(t.name)}</span>
        <span class="row"><button class="btn primary mini-btn" onclick="mmAward('${t.id}',${points})">+${points}</button>
        <button class="btn danger mini-btn" onclick="mmAward('${t.id}',-1)">-1</button></span></div>`).join('');

    return head + timerHtml + payloadHtml + `<div style="margin-top:8px">${awardRows}</div>
      <button class="btn primary lg block" style="margin-top:10px" onclick="mmNextQuestion()">SUIVANTE ⏭</button>`;
  }

  function panicControlHtml(state) {
    const c = state.challenge, q = state.question;
    if (!q) return `<button class="btn primary lg block" onclick="mmNextQuestion()">▶ QUESTION 1</button>`;
    let head = `<h3 style="margin:0">Q${state.challengeIndex + 1}/${state.challengeTotal} · ${esc(q.theme || c.name)}</h3>`;
    if (state.phase === 'question') {
      return head + `<div class="row" style="margin-top:10px">
        <input type="number" id="panicSeconds" value="${c.durationSeconds || 30}" style="max-width:100px">
        <button class="btn primary" onclick="mmStartPanic()">▶ LANCER LE CHRONO</button>
      </div>`;
    }
    if (state.phase === 'panic_running') {
      const remaining = Math.max(0, Math.ceil((state.panic.endsAt - Date.now()) / 1000));
      return head + `<div class="timer" style="font-size:60px">${remaining}</div>
        <button class="btn ghost" onclick="send({type:'host:endPanicNow'})">⏹ ARRÊTER MAINTENANT</button>`;
    }
    const teamsHtml = state.teams.filter(t => t.connected).map(t => {
      const items = (state.panic.submissions[t.id] || []).map((it, idx) => `
        <div class="line" style="padding:6px 0">
          <span class="${it.status === 'valid' ? 'acid' : it.status === 'invalid' ? 'pink' : ''}">${esc(it.text)}</span>
          <span class="row">
            <button class="btn primary mini-btn" onclick="mmMarkPanicItem('${t.id}',${idx},true)">✓</button>
            <button class="btn danger mini-btn" onclick="mmMarkPanicItem('${t.id}',${idx},false)">✗</button>
          </span>
        </div>`).join('') || '<p class="muted small">Aucune réponse</p>';
      return `<div style="margin-top:8px"><b class="team-text" style="color:${t.color}">${esc(t.name)}</b>${items}</div>`;
    }).join('');
    const pending = state.panic.challenges.filter(ch => ch.status === 'pending');
    const challengesHtml = pending.length ? `<div class="card tight" style="margin-top:10px;border-color:var(--yellow)"><b>⚔️ Défis en attente</b>${pending.map(ch => {
      const from = state.teams.find(x => x.id === ch.fromTeamId);
      const target = state.teams.find(x => x.id === ch.targetTeamId);
      const item = (state.panic.submissions[ch.targetTeamId] || [])[ch.itemIndex];
      return `<div class="line"><span>${esc(from ? from.name : '')} conteste "${esc(item ? item.text : '')}" de ${esc(target ? target.name : '')}</span>
        <span class="row"><button class="btn primary mini-btn" onclick="mmResolvePanicChallenge('${ch.id}',true)">Défi valide (+2)</button>
        <button class="btn danger mini-btn" onclick="mmResolvePanicChallenge('${ch.id}',false)">Défi invalide (-1)</button></span></div>`;
    }).join('')}</div>` : '';
    return head + teamsHtml + challengesHtml + `<button class="btn primary lg block" style="margin-top:12px" onclick="mmNextQuestion()">SUIVANTE ⏭</button>`;
  }

  function betControlHtml(state) {
    const c = state.challenge, q = state.question;
    if (!q) return `<button class="btn primary lg block" onclick="mmNextQuestion()">▶ QUESTION 1</button>`;
    let head = `<h3 style="margin:0">Q${state.challengeIndex + 1}/${state.challengeTotal} · ${esc(c ? c.name : 'LE PARI FINAL')}</h3><div class="muted small">Réponse: <b>${esc(q.track ? q.track.title : '-')}</b> · ${esc(q.track ? q.track.artist : '')}</div>`;
    if (state.phase === 'final_betting') {
      const rows = state.teams.filter(t => t.connected).map(t => {
        const b = state.bets[t.id];
        const guessPart = b && b.guess ? ` · <span class="muted small">"${esc(b.guess)}"</span>` : '';
        return `<div class="line"><span>${t.emoji} ${esc(t.name)}${guessPart}</span><span>${b ? (b.locked ? '🔒 ' + b.amount : '⏳ ' + b.amount) : '⏳ -'}</span></div>`;
      }).join('');
      return head + `<div style="margin-top:8px">${rows}</div>
        <button class="btn primary lg block" style="margin-top:12px" onclick="mmStartFinalReveal()">👁 FORCER LA RÉVÉLATION</button>`;
    }
    if (state.phase === 'final_guess') {
      const rows = state.teams.filter(t => t.connected).map(t => {
        const b = state.bets[t.id] || { amount: 0, guess: '' };
        return `<div class="line"><span>${t.emoji} ${esc(t.name)} (mise ${b.amount})</span><span class="muted small">${b.guess ? '"' + esc(b.guess) + '"' : '…'}</span></div>`;
      }).join('');
      return head + `<div class="row" style="margin-top:8px;align-items:center">${playTimerBadge(state)}<span class="muted small">🎧 les équipes écoutent et devinent le titre...</span></div>
        <div style="margin-top:8px">${rows}</div>
        <button class="btn primary lg block" style="margin-top:12px" onclick="mmStartFinalReveal()">👁 FORCER LA RÉVÉLATION</button>`;
    }
    const rows = state.teams.filter(t => t.connected).map(t => {
      const b = state.bets[t.id] || { amount: 0 };
      if (b.resolved) return `<div class="line"><span>${t.emoji} ${esc(t.name)}</span><span>${b.correct ? '✅ +' + b.amount : '❌ -' + b.amount}</span></div>`;
      const guessLine = b.guess ? `<div class="muted small">a répondu : "${esc(b.guess)}"</div>` : `<div class="muted small">aucune réponse écrite</div>`;
      return `<div class="line" style="align-items:flex-start"><span>${t.emoji} ${esc(t.name)} (mise ${b.amount})${guessLine}</span>
        <span class="row"><button class="btn primary mini-btn" onclick="mmMarkBet('${t.id}',true)">✓ TROUVÉ</button>
        <button class="btn danger mini-btn" onclick="mmMarkBet('${t.id}',false)">✗ RATÉ</button></span></div>`;
    }).join('');
    const isLast = state.challengeIndex >= state.challengeTotal - 1;
    return head + `<div style="margin-top:8px">${rows}</div>
      <button class="btn primary lg block" style="margin-top:12px" onclick="${isLast ? 'mmEndGame()' : 'mmNextQuestion()'}">${isLast ? '🏆 TERMINER LA PARTIE' : 'SUIVANTE ⏭'}</button>`;
  }

  function renderAudioPanel(state) {
    const q = state.question, c = state.challenge;
    if (!q || !c) { audioPanel.innerHTML = `<div class="muted small">🎧 Aucun défi en cours.</div>`; return; }
    const tracksToShow = q.tracks ? q.tracks : (q.track ? [q.track] : []);
    if (!tracksToShow.length) { audioPanel.innerHTML = `<div class="muted small">🎧 Pas d'extrait pour cette question.</div>`; return; }
    const spotifyReady = spotifyStatus.authorized && spotifyStatus.deviceReady;
    audioPanel.innerHTML = tracksToShow.map((t, i) => {
      const label = tracksToShow.length > 1 ? 'PISTE ' + String.fromCharCode(65 + i) : 'AUDIO';
      if (t.spotifyUri && spotifyReady) {
        return `<div style="margin-top:${i > 0 ? '12' : '0'}px">
          <div class="muted small">🎧 ${label} · via Spotify (écran connecté)</div>
          <div class="row" style="margin-top:6px">
            <button class="btn primary mini-btn" onclick="mmSpotifyAudio('play',${i})">▶</button>
            <button class="btn ghost mini-btn" onclick="mmSpotifyAudio('pause',${i})">⏸</button>
            <button class="btn ghost mini-btn" onclick="mmSpotifyAudio('back3',${i})">⏪3s</button>
            <button class="btn ghost mini-btn" onclick="mmSpotifyAudio('restart',${i})">⏮</button>
          </div></div>`;
      }
      if (t.spotifyUri) {
        const trackId = t.spotifyUri.split(':').pop();
        return `<div class="muted small" style="margin-top:${i > 0 ? '10' : '0'}px">🎧 ${label} · Spotify pas encore prêt (voir le panneau ci-dessus), <a href="https://open.spotify.com/track/${trackId}" target="_blank">ouvrir sur Spotify</a></div>`;
      }
      const ref = t.audioRef || '';
      if (!ref) return `<div class="muted small" style="margin-top:${i > 0 ? '10' : '0'}px">🎧 ${label} : aucun audio_ref renseigné.</div>`;
      return `<div style="margin-top:${i > 0 ? '12' : '0'}px">
        <div class="muted small">🎧 ${label} : ${esc(ref)}</div>
        <audio id="audioPlayer${i}" src="/media/${encodeURIComponent(ref)}.mp3" preload="none"></audio>
        <div class="row" style="margin-top:6px">
          <button class="btn primary mini-btn" onclick="mmAudio('play',${i})">▶</button>
          <button class="btn ghost mini-btn" onclick="mmAudio('pause',${i})">⏸</button>
          <button class="btn ghost mini-btn" onclick="mmAudio('back3',${i})">⏪3s</button>
          <button class="btn ghost mini-btn" onclick="mmAudio('restart',${i})">⏮</button>
        </div></div>`;
    }).join('');
  }

  function renderTeams(state) {
    teamsGrid.innerHTML = inPlayTeams(state).map(t => `
      <div class="team-card">
        <div class="row between"><b class="team-text" style="color:${t.color}">${t.emoji} ${esc(t.name)}</b>
          <span class="row" style="gap:4px">
            <button class="btn ghost mini-btn" title="Renommer" onclick="mmRenameTeam('${t.id}','${esc(t.name).replace(/'/g, "\\'")}')">✏️</button>
            ${t.connected ? '' : '<span class="badge">hors ligne</span>'}
          </span>
        </div>
        <div class="score">${t.score}</div>
        <div class="row" style="margin-top:6px">
          <button class="btn ghost mini-btn" onclick="mmAward('${t.id}',1)">+1</button>
          <button class="btn ghost mini-btn" onclick="mmAward('${t.id}',2)">+2</button>
          <button class="btn ghost mini-btn" onclick="mmAward('${t.id}',-1)">-1</button>
          <input type="number" id="custom_${t.id}" placeholder="±" style="width:56px;padding:6px">
          <button class="btn ghost mini-btn" onclick="mmAwardCustom('${t.id}')">OK</button>
        </div>
        <div class="row" style="margin-top:6px">
          <select id="grant_${t.id}">${state.meta.powers.map(p => `<option value="${p.id}">${p.emoji} ${esc(p.name)}</option>`).join('')}</select>
          <button class="btn ghost mini-btn" onclick="mmGrantPower('${t.id}')">DONNER</button>
        </div>
        <div class="row" style="margin-top:6px;flex-wrap:wrap">
          ${(t.powers || []).map(c => {
            const def = state.meta.powers.find(p => p.id === c.powerId) || {};
            return `<span class="badge" title="révoquer" style="cursor:pointer" onclick="mmRevokePower('${t.id}','${c.instId}')">${def.emoji || '🃏'} ${esc((def.name || c.powerId))} ✕</span>`;
          }).join(' ')}
        </div>
      </div>`).join('');
  }

  function renderLog(state) {
    const items = state.events.slice(-40).reverse();
    eventLog.innerHTML = items.map(e => {
      const time = new Date(e.at).toLocaleTimeString();
      const { type, at, ...rest } = e;
      return `<div class="ev">${time} · <b>${type}</b> ${Object.keys(rest).length ? JSON.stringify(rest) : ''}</div>`;
    }).join('');
  }

  window.send = send; // used by inline onclick for endPanicNow

  // --- Spotify search (content-prep helper only, no playback) -----------

  let lastSpotifyResults = [];

  window.mmSpotifySearch = async function () {
    const input = document.getElementById('spotifyQuery');
    const resultsEl = document.getElementById('spotifyResults');
    const q = input.value.trim();
    if (!q) return;
    resultsEl.innerHTML = '<p class="muted small">Recherche...</p>';
    try {
      const res = await fetch('/api/spotify/search?key=' + encodeURIComponent(hostKey) + '&q=' + encodeURIComponent(q));
      const data = await res.json();
      if (data.error === 'not_configured') {
        resultsEl.innerHTML = '<p class="pink small">Spotify non configuré : renseignez <code>data/spotify.json</code> (voir README).</p>';
        return;
      }
      if (data.error) {
        resultsEl.innerHTML = '<p class="pink small">Erreur Spotify : ' + esc(data.message || data.error) + '</p>';
        return;
      }
      lastSpotifyResults = data.results || [];
      if (!lastSpotifyResults.length) { resultsEl.innerHTML = '<p class="muted small">Aucun résultat.</p>'; return; }
      resultsEl.innerHTML = lastSpotifyResults.map((t, i) => `
        <div class="line">
          <span class="row" style="gap:10px">
            ${t.albumArt ? `<img src="${t.albumArt}" width="40" height="40" style="border-radius:8px;border:2px solid var(--ink)">` : ''}
            <span><b>${esc(t.title)}</b><br><span class="muted small">${esc(t.artist)}</span></span>
          </span>
          <span class="row" style="gap:6px">
            <button class="btn primary mini-btn" onclick="mmUseSearchResult(${i})">➕ Utiliser</button>
            <button class="btn ghost mini-btn" onclick="mmCopyTrack(${i})">📋 Copier</button>
          </span>
        </div>`).join('');
    } catch (e) {
      resultsEl.innerHTML = '<p class="pink small">Erreur réseau lors de la recherche.</p>';
    }
  };

  window.mmCopyTrack = function (i) {
    const t = lastSpotifyResults[i];
    if (!t) return;
    const text = JSON.stringify({ title: t.title, artist: t.artist, spotify_uri: t.uri }, null, 2);
    copyText(text);
  };

  // --- Add a question to a challenge, live, from a search result --------
  // Each challenge mode needs a different-shaped instance (see README §8 /
  // scripts/gen-challenge-content.js, the canonical schema reference).
  // addQuestionRecipe below mirrors that exact branching so the form only
  // ever asks for what that challenge's format actually needs.
  const addQuestionPanel = document.getElementById('addQuestionPanel');
  let addQuestionReady = false;
  let addDraft = { challengeId: '', tracks: [], activeSlot: 0, fields: {} };

  function addQuestionRecipe(c) {
    if (!c) return { slots: [], fields: [] };
    if (c.mode === 'buzzer_tiered' && c.multiTrack) {
      const n = ((c.scoring && c.scoring.tiers) || []).length || 3;
      return { slots: Array.from({ length: n }, (_, i) => 'Morceau ' + (i + 1)), fields: ['hint'] };
    }
    if (c.mode === 'buzzer_tiered') return { slots: ['Piste'], fields: ['hint'] };
    if (c.mode === 'buzzer_compound') {
      if (c.id === 'cover_original') return { slots: ['Piste (la reprise jouée)'], fields: ['extraOriginal', 'hint'] };
      return { slots: ['Piste'], fields: ['hint'] };
    }
    if (c.mode === 'choice') {
      const n = (c.scoring && c.scoring.optionsCount) || 4;
      return { slots: ['Piste'], fields: ['criterion', 'options:' + n] };
    }
    if (c.mode === 'panic') return { slots: [], fields: ['theme', 'durationSeconds'] };
    if (c.mode === 'bet') return { slots: ['Piste'], fields: ['genre'] };
    if (c.mode === 'perform') {
      const fields = [];
      if (c.hasPrivatePayload && c.privatePayloadKind === 'banned_words') fields.push('bannedWords');
      return { slots: ['Piste'], fields };
    }
    if (c.mode === 'buzzer' && c.multiTrack) return { slots: ['Morceau 1', 'Morceau 2', 'Morceau 3'], fields: ['link', 'hint'] };
    if (c.randomFromTags) return { slots: ['Piste'], fields: ['category'] };
    if (c.hasPrivatePayload && c.privatePayloadKind === 'forbidden_word') return { slots: ['Piste'], fields: ['wordPool'] };
    if (c.hasClue) return { slots: ['Piste'], fields: ['clue', 'hint'] };
    return { slots: ['Piste'], fields: ['hint'] };
  }

  function addFieldHtml(key, c) {
    const v = k => esc(addDraft.fields[k] || '');
    if (key === 'hint') return `<div class="col" style="flex:1 1 220px"><label class="muted small">Indice (optionnel, visible via le pouvoir Oracle)</label><input type="text" value="${v('hint')}" oninput="mmSetAddField('hint',this.value)"></div>`;
    if (key === 'clue') return `<div class="col" style="flex:1 1 220px"><label class="muted small">Traduction affichée (obligatoire)</label><input type="text" placeholder='ex: "Parapluie"' value="${v('clue')}" oninput="mmSetAddField('clue',this.value)"></div>`;
    if (key === 'extraOriginal') return `<div class="col" style="flex:1 1 220px"><label class="muted small">Artiste original (obligatoire : la piste jouée est la reprise)</label><input type="text" placeholder="ex: Leonard Cohen" value="${v('extraOriginal')}" oninput="mmSetAddField('extraOriginal',this.value)"></div>`;
    if (key === 'link') return `<div class="col" style="flex:1 1 220px"><label class="muted small">Lien caché entre les morceaux (optionnel, révélé à la fin)</label><input type="text" value="${v('link')}" oninput="mmSetAddField('link',this.value)"></div>`;
    if (key === 'theme') return `<div class="col" style="flex:1 1 220px"><label class="muted small">Thème (ex: "villes de France")</label><input type="text" value="${v('theme')}" oninput="mmSetAddField('theme',this.value)"></div>`;
    if (key === 'durationSeconds') return `<div class="col" style="max-width:120px"><label class="muted small">Durée (s)</label><input type="number" min="10" max="120" value="${esc(addDraft.fields.durationSeconds || 30)}" oninput="mmSetAddField('durationSeconds',this.value)"></div>`;
    if (key === 'wordPool') return `<div class="col" style="flex:1 1 100%"><label class="muted small">Mots interdits, un par équipe (séparés par des virgules, obligatoire)</label><input type="text" placeholder="amour, coeur, danse..." value="${v('wordPoolRaw')}" oninput="mmSetAddField('wordPoolRaw',this.value)"></div>`;
    if (key === 'bannedWords') return `<div class="col" style="flex:1 1 100%"><label class="muted small">Mots bannis pour cette chanson (séparés par des virgules, obligatoire)</label><input type="text" placeholder="titre, artiste, refrain..." value="${v('bannedWordsRaw')}" oninput="mmSetAddField('bannedWordsRaw',this.value)"></div>`;
    if (key === 'category') return `<div class="col"><label class="muted small">Catégorie</label><select onchange="mmSetAddField('category',this.value)">${(c.categories || []).map(cat => `<option value="${cat}" ${addDraft.fields.category === cat ? 'selected' : ''}>${esc(cat)}</option>`).join('')}</select></div>`;
    if (key === 'genre') return `<div class="col" style="flex:1 1 220px"><label class="muted small">Style musical (affiché aux équipes avant la mise, avec l'année)</label><input type="text" placeholder="ex: Pop, Rap FR, Rock..." value="${v('genre')}" oninput="mmSetAddField('genre',this.value)"></div>`;
    if (key.indexOf('options:') === 0) {
      const n = Number(key.split(':')[1]) || 4;
      const opts = Array.from({ length: n }, (_, i) => `<input type="text" placeholder="Option ${i + 1}" style="margin-top:4px" value="${v('option' + i)}" oninput="mmSetAddField('option${i}',this.value)">`).join('');
      // Shows the label actually typed above instead of a generic "Option
      // N" once there is one, so picking the right answer for e.g. "Joueur A /
      // Joueur B / Les deux" doesn't mean cross-referencing option numbers.
      const idxOpts = Array.from({ length: n }, (_, i) => `<option value="${i}" ${addDraft.fields.correctIndex == i ? 'selected' : ''}>${esc(addDraft.fields['option' + i] || ('Option ' + (i + 1)))}</option>`).join('');
      return `<div class="col" style="flex:1 1 100%">
        <label class="muted small">Critère (ex: "Décennie de sortie")</label><input type="text" style="margin-bottom:6px" value="${v('criterion')}" oninput="mmSetAddField('criterion',this.value)">
        <label class="muted small">${n} options affichées (toutes obligatoires)</label>${opts}
        <label class="muted small" style="margin-top:6px;display:block">Bonne réponse</label>
        <select onchange="mmSetAddField('correctIndex',this.value)">${idxOpts}</select>
      </div>`;
    }
    return '';
  }

  function addSlotsHtml(slots) {
    return slots.map((label, i) => {
      const t = addDraft.tracks[i];
      const active = addDraft.activeSlot === i;
      return `<div class="line" style="cursor:pointer;border-radius:8px;${active ? 'outline:2px solid var(--acid)' : ''}" onclick="mmSetActiveSlot(${i})">
        <span class="row" style="gap:8px">
          ${t && t.albumArt ? `<img src="${t.albumArt}" width="32" height="32" style="border-radius:6px;border:2px solid var(--ink)">` : ''}
          <span class="small">${esc(label)}${t ? ` : <b>${esc(t.title)}</b> · ${esc(t.artist)}` : active ? ' → cherchez puis cliquez ➕ Utiliser sur un résultat' : ' (vide)'}</span>
        </span>
        ${t ? `<span class="row" style="gap:6px" onclick="event.stopPropagation()">
          <input type="number" placeholder="année" value="${t.year || ''}" style="width:88px" onchange="mmSetSlotYear(${i},this.value)">
          <button class="btn ghost mini-btn" onclick="mmClearSlot(${i})">✕</button>
        </span>` : ''}
      </div>`;
    }).join('');
  }

  function addableChallenges() {
    return (lastState.meta.challenges || []).filter(c => c.implemented !== false && !c.requiresLocalAudio);
  }

  function renderAddQuestionPanel() {
    if (!addQuestionPanel || !lastState || !lastState.meta) return;
    const catalog = addableChallenges();
    if (!catalog.length) { addQuestionPanel.innerHTML = '<p class="muted small">Aucune épreuve disponible.</p>'; return; }
    if (!addDraft.challengeId || !catalog.some(c => c.id === addDraft.challengeId)) addDraft.challengeId = catalog[0].id;
    const c = catalog.find(x => x.id === addDraft.challengeId);
    const recipe = addQuestionRecipe(c);
    if (addDraft.tracks.length !== recipe.slots.length) addDraft.tracks = recipe.slots.map((_, i) => addDraft.tracks[i] || null);
    if (addDraft.activeSlot >= recipe.slots.length) addDraft.activeSlot = 0;

    const options = catalog.map(x => `<option value="${x.id}" ${x.id === addDraft.challengeId ? 'selected' : ''}>${esc(x.name)} (${x.instanceCount} question${x.instanceCount > 1 ? 's' : ''})</option>`).join('');

    addQuestionPanel.innerHTML = `
      <select style="margin-top:8px" onchange="mmSelectAddChallenge(this.value)">${options}</select>
      <p class="muted small" style="margin:6px 0 0">${esc(c.description)}</p>
      ${recipe.slots.length ? `<div style="margin-top:8px">${addSlotsHtml(recipe.slots)}</div>` : '<p class="muted small" style="margin-top:6px">Pas de piste directe pour cette épreuve.</p>'}
      ${recipe.fields.length ? `<div class="row" style="margin-top:8px;flex-wrap:wrap;gap:10px">${recipe.fields.map(k => addFieldHtml(k, c)).join('')}</div>` : ''}
      <button class="btn primary block" style="margin-top:10px" onclick="mmSubmitAddQuestion()">➕ Ajouter à ${esc(c.shortName || c.name)}</button>
    `;
  }

  window.mmSelectAddChallenge = function (id) {
    // "JOUEUR A, JOUEUR B OU LES DEUX ?" always uses the same three answers: pre-
    // filling them means adding a question is just picking a track + the
    // right one, instead of retyping the same three labels every time.
    const fields = id === 'spotify_roulette' ? { option0: 'Joueur A', option1: 'Joueur B', option2: 'Les deux' } : {};
    addDraft = { challengeId: id, tracks: [], activeSlot: 0, fields };
    renderAddQuestionPanel();
  };
  window.mmSetActiveSlot = function (i) { addDraft.activeSlot = i; renderAddQuestionPanel(); };
  window.mmClearSlot = function (i) { addDraft.tracks[i] = null; addDraft.activeSlot = i; renderAddQuestionPanel(); };
  window.mmSetSlotYear = function (i, val) { if (addDraft.tracks[i]) addDraft.tracks[i].year = val ? Number(val) : null; };
  window.mmSetAddField = function (key, value) { addDraft.fields[key] = value; };

  window.mmUseSearchResult = function (i) {
    const t = lastSpotifyResults[i];
    if (!t || !lastState) return;
    const c = addableChallenges().find(x => x.id === addDraft.challengeId);
    const recipe = addQuestionRecipe(c);
    if (!recipe.slots.length) { MM.toast('⚠️ Cette épreuve ne prend pas de piste directement.'); return; }
    const slotIdx = addDraft.activeSlot;
    addDraft.tracks[slotIdx] = { title: t.title, artist: t.artist, album: t.album, spotifyUri: t.uri, albumArt: t.albumArt, year: (addDraft.tracks[slotIdx] && addDraft.tracks[slotIdx].year) || null };
    const nextEmpty = addDraft.tracks.findIndex(x => !x);
    addDraft.activeSlot = nextEmpty !== -1 ? nextEmpty : slotIdx;
    MM.toast('🎵 ' + t.title + ' → ' + recipe.slots[slotIdx]);
    renderAddQuestionPanel();
  };

  function buildAddSubmitFields(fieldKeys) {
    const d = addDraft.fields, fields = {};
    fieldKeys.forEach(key => {
      if (key === 'hint') fields.hint = d.hint || '';
      else if (key === 'clue') fields.clue = d.clue || '';
      else if (key === 'extraOriginal') fields.extraOriginal = d.extraOriginal || '';
      else if (key === 'link') fields.link = d.link || '';
      else if (key === 'theme') fields.theme = d.theme || '';
      else if (key === 'durationSeconds') fields.durationSeconds = Number(d.durationSeconds) || 30;
      else if (key === 'wordPool') fields.wordPool = (d.wordPoolRaw || '').split(',').map(s => s.trim()).filter(Boolean);
      else if (key === 'bannedWords') fields.bannedWords = (d.bannedWordsRaw || '').split(',').map(s => s.trim()).filter(Boolean);
      else if (key === 'category') fields.category = d.category || '';
      else if (key === 'genre') fields.genre = d.genre || '';
      else if (key.indexOf('options:') === 0) {
        const n = Number(key.split(':')[1]) || 4;
        fields.criterion = d.criterion || '';
        fields.options = Array.from({ length: n }, (_, i) => d['option' + i] || '');
        fields.correctIndex = Number(d.correctIndex) || 0;
      }
    });
    return fields;
  }

  function validateAddDraft(recipe, fields) {
    if (addDraft.tracks.filter(Boolean).length < recipe.slots.length) return 'Remplissez toutes les pistes.';
    if (recipe.fields.includes('clue') && !fields.clue) return 'La traduction affichée est obligatoire.';
    if (recipe.fields.includes('extraOriginal') && !fields.extraOriginal) return "L'artiste original est obligatoire.";
    if (recipe.fields.includes('wordPool') && !fields.wordPool.length) return 'Ajoutez au moins un mot interdit.';
    if (recipe.fields.includes('bannedWords') && !fields.bannedWords.length) return 'Ajoutez au moins un mot banni.';
    const optKey = recipe.fields.find(k => k.indexOf('options:') === 0);
    if (optKey) {
      const need = Number(optKey.split(':')[1]) || 4;
      if (fields.options.filter(o => o && o.trim()).length < need) return 'Remplissez toutes les options.';
    }
    return null;
  }

  window.mmSubmitAddQuestion = function () {
    const c = addableChallenges().find(x => x.id === addDraft.challengeId);
    if (!c) return;
    const recipe = addQuestionRecipe(c);
    const fields = buildAddSubmitFields(recipe.fields);
    const err = validateAddDraft(recipe, fields);
    if (err) { MM.toast('⚠️ ' + err); return; }
    send({
      type: 'host:addQuestion',
      challengeId: addDraft.challengeId,
      tracks: addDraft.tracks.filter(Boolean).map(t => ({ title: t.title, artist: t.artist, album: t.album, spotifyUri: t.spotifyUri, year: t.year })),
      fields
    });
    MM.toast('✅ Question ajoutée à ' + (c.shortName || c.name));
    addDraft = { challengeId: addDraft.challengeId, tracks: [], activeSlot: 0, fields: {} };
    renderAddQuestionPanel();
  };

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => MM.toast('📋 Copié !')).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); MM.toast('📋 Copié !'); }
    catch (e) { MM.toast('Copie impossible, sélectionnez le texte manuellement'); }
    document.body.removeChild(ta);
  }
})();
