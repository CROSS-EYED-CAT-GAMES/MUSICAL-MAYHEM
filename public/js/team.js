(function () {
  const sessionId = MM.getSessionId();
  const joinScreen = document.getElementById('joinScreen');
  const gameScreen = document.getElementById('gameScreen');
  const codeInput = document.getElementById('codeInput');
  const teamPickList = document.getElementById('teamPickList');
  const joinError = document.getElementById('joinError');
  const myTeamChip = document.getElementById('myTeamChip');
  const myScore = document.getElementById('myScore');
  const myEffects = document.getElementById('myEffects');
  const myPayloadEl = document.getElementById('myPayload');
  const phaseArea = document.getElementById('phaseArea');
  const powersList = document.getElementById('powersList');

  let myTeamId = localStorage.getItem('mm_team_id') || null;
  let storedTeamId = myTeamId;
  let screenShown = null;
  // The CONTRE LA MONTRE focus-guard below exists only to stop a real
  // on-screen virtual keyboard from being dismissed by an unrelated async
  // DOM write while it's up, a touch-device-only browser quirk. On a
  // PC/laptop there's no virtual keyboard to protect, so the same guard
  // was just silently hiding a team's own submissions from their own list
  // for as long as the input stayed focused, which on a physical keyboard
  // is continuously, since nothing blurs it between answers. Confirmed
  // server-side the submission always landed correctly; only this client's
  // own feedback was suppressed.
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  let lastState = null;
  let targeting = null; // instId of a power card awaiting a target pick
  let tickTimer = null;
  let panicDraft = '';
  let showCustomize = false;
  let dismissedCustomize = false;
  let profileDraft = { name: '', color: '' };

  const params = new URLSearchParams(location.search);
  if (params.get('code')) codeInput.value = params.get('code');

  function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // Once the game has left the lobby, team slots nobody ever joined just
  // clutter the leaderboard/victory ranking for the rest of the night.
  // everJoined (not `connected`) so a team stays ranked through a brief
  // Wi-Fi drop instead of vanishing from its own final ranking.
  function inPlayTeams(state) {
    return state.phase === 'lobby' ? state.teams : state.teams.filter(t => t.everJoined);
  }

  const client = MM.connect(render, onError);
  client.onOpen(() => { if (myTeamId) client.send({ type: 'join', sessionId, teamId: myTeamId, code: codeInput.value || '' }); });

  // A power card that silently fails to do anything (no toast, nothing
  // visibly different, just the card still sitting in hand) reads to a
  // player exactly like a power that does nothing at all, same complaint
  // as a card with no real effect. These were already refused server-side
  // all along; nothing ever told the team why.
  const POWER_ERROR_MESSAGES = {
    powers_disabled: 'Les pouvoirs sont désactivés pour cette épreuve.',
    power_not_allowed: "Ce pouvoir n'est pas autorisé pour cette épreuve.",
    no_question: 'Aucune question en cours.',
    no_hint: "Aucun indice pour cette question : gardez la carte pour une autre !",
    already_tried: 'Votre équipe a déjà tenté cette question.',
    bad_target: 'Choisissez une équipe cible valide.'
  };

  function onError(msg) {
    if (msg === 'bad_code' || msg === 'bad_team') {
      joinError.textContent = msg === 'bad_code' ? 'Code incorrect.' : 'Équipe introuvable.';
      joinError.classList.remove('hidden');
    }
    if (msg === 'color_taken') MM.toast('Cette couleur est déjà prise, choisissez-en une autre.');
    if (msg === 'bad_color') MM.toast('Choisissez une couleur dans la palette.');
    if (POWER_ERROR_MESSAGES[msg]) MM.toast('⚠️ ' + POWER_ERROR_MESSAGES[msg]);
  }

  window.mmJoin = function (teamId) {
    myTeamId = teamId;
    client.send({ type: 'join', sessionId, teamId, code: codeInput.value.trim() });
  };

  window.mmBuzz = function () {
    if (navigator.vibrate) navigator.vibrate(40);
    client.send({ type: 'buzz', teamId: myTeamId });
  };

  window.mmUsePower = function (instId, powerId) {
    if (powerId === 'silence' || powerId === 'bomb') { targeting = targeting === instId ? null : instId; render(lastState); return; }
    client.send({ type: 'usePower', teamId: myTeamId, instId });
  };

  window.mmPickTarget = function (instId, targetTeamId) {
    client.send({ type: 'usePower', teamId: myTeamId, instId, targetTeamId });
    targeting = null;
  };

  window.mmPanicInput = function (val) { panicDraft = val; };
  window.mmPanicSubmit = function () {
    const text = (panicDraft || '').trim();
    if (!text) return;
    client.send({ type: 'panicSubmit', teamId: myTeamId, text });
    panicDraft = '';
    const el = document.getElementById('panicInput');
    if (el) el.value = '';
  };
  window.mmPanicChallenge = function (targetTeamId, itemIndex) {
    client.send({ type: 'panicChallenge', teamId: myTeamId, targetTeamId, itemIndex });
  };

  window.mmPickChallenge = function (challengeId) {
    client.send({ type: 'pickChallenge', teamId: myTeamId, challengeId });
  };

  window.mmSubmitChoice = function (optionIndex) {
    if (navigator.vibrate) navigator.vibrate(30);
    client.send({ type: 'submitChoice', teamId: myTeamId, optionIndex });
  };

  window.mmBetInput = function (val) {
    const amount = Math.max(0, Math.floor(Number(val) || 0));
    client.send({ type: 'betSet', teamId: myTeamId, amount });
  };
  window.mmBetGuess = function (val) { client.send({ type: 'betGuess', teamId: myTeamId, text: val }); };
  window.mmBetLock = function () { client.send({ type: 'betLock', teamId: myTeamId }); };

  window.mmProfileName = function (v) { profileDraft.name = v; };
  window.mmProfileColor = function (c) { profileDraft.color = c; renderGame(lastState); };
  window.mmSaveProfile = function () {
    if (!profileDraft.name.trim()) { MM.toast('Donnez un nom à votre équipe !'); return; }
    client.send({ type: 'setTeamProfile', teamId: myTeamId, name: profileDraft.name, color: profileDraft.color });
    showCustomize = false;
  };
  window.mmSkipProfile = function () {
    dismissedCustomize = true;
    showCustomize = false;
    renderGame(lastState);
  };
  window.mmEditProfile = function () {
    const t = me(lastState);
    if (!t) return;
    profileDraft = { name: t.name, color: t.color };
    showCustomize = true;
    renderGame(lastState);
  };

  function render(state) {
    lastState = state;
    const joined = state.role === 'team' && state.viewerTeamId;
    if (joined) {
      myTeamId = state.viewerTeamId;
      // Every OTHER team's action also rebroadcasts the full state to us
      // (server is authoritative, one broadcast reaches everyone), and this
      // was unconditionally re-writing localStorage on EVERY single one,
      // even when the value never changed. localStorage.setItem is
      // synchronous and on iOS Safari round-trips through the storage
      // process (real, measurable main-thread latency per call) - during
      // beat_the_clock several teams can submit every ~150ms-1s each,
      // easily dozens of these writes per second. A tap that lands while
      // the main thread is busy with a synchronous storage write can fail
      // to register as a clean, uninterrupted gesture, and iOS will not
      // reliably show the on-screen keyboard for a focus() outside of one.
      if (storedTeamId !== myTeamId) { localStorage.setItem('mm_team_id', myTeamId); storedTeamId = myTeamId; }
      // gameScreen is a direct ancestor of #panicInput (gameScreen >
      // phaseArea > .card > .row > #panicInput). This ran unconditionally
      // on every broadcast even when already in the right state, an
      // ancestor class mutation on every single message, for the whole
      // life of this bug, never touched by any earlier round of this fix.
      if (screenShown !== 'game') { joinScreen.classList.add('hidden'); gameScreen.classList.remove('hidden'); screenShown = 'game'; }
      renderGame(state);
    } else {
      if (screenShown !== 'join') { gameScreen.classList.add('hidden'); joinScreen.classList.remove('hidden'); screenShown = 'join'; }
      renderJoin(state);
    }
    // Once a second is plenty for a countdown a human is reading, and
    // it's a lot less local polling overhead than 4x/sec on a phone that
    // may already be busy handling broadcasts from other teams.
    if (!tickTimer) tickTimer = setInterval(() => {
      if (!lastState) return;
      if (lastState.phase === 'panic_running') renderGame(lastState);
      if (lastState.phase === 'perform_active' && lastState.performTimer && lastState.performTimer.running) renderGame(lastState);
      if (lastState.phase === 'final_guess') renderGame(lastState);
      if (lastState.phase === 'buzzed' && lastState.answerTimer && lastState.answerTimer.running) renderGame(lastState);
    }, 1000);
  }

  function renderJoin(state) {
    teamPickList.innerHTML = state.teams.map(t => `
      <button class="team-pick" style="background:${t.color}22" onclick="mmJoin('${t.id}')">
        <span class="emoji">${t.emoji}</span>${esc(t.name)}
      </button>`).join('');
  }

  function me(state) { return state.teams.find(t => t.id === myTeamId); }

  function renderGame(state) {
    const t = me(state);
    if (!t) return;

    // Mobile browsers can dismiss the on-screen keyboard the instant ANY
    // part of the page mutates via script while an input has focus, not
    // just the input itself, or its ancestors, ANY element anywhere on
    // the page. Rewriting the team chip / effects / powers list on every
    // broadcast (which arrives constantly here: every OTHER team's
    // submission also rebroadcasts to us) was enough to reproduce
    // "keyboard closes the instant I tap it" on a real phone, even though
    // document.activeElement stayed correctly on the input the whole
    // time in testing, the element itself was never touched, something
    // ELSE on the page mutating was enough. None of the skipped fields
    // can actually change here anyway (beat_the_clock forces
    // allowsPowers:false, so no power cards or effects can appear
    // mid-round, and it carries no private payload), so there is nothing
    // to lose by not touching them until the round ends.
    if (state.phase === 'panic_running' && document.getElementById('panicInput')) {
      updatePanicRunning(state, t);
      return;
    }

    // LE PARI FINAL's guess step (final_guess, see finalGuessHtml) opens
    // only once every bet is locked, and hits the same keyboard-jump risk
    // while typing, but unlike the amount step below there IS something
    // that must keep updating here even while the input has focus: the 30s
    // countdown (state.playTimer, shared with every buzzer challenge's own
    // clock). So this gets the same surgical, timer-digit-only update as
    // CONTRE LA MONTRE above (updatePanicRunning), not a blanket skip.
    if (state.phase === 'final_guess' && document.getElementById('finalGuessInput')) {
      updateFinalGuess(state, t);
      return;
    }

    // LE PARI FINAL's amount step hit the exact same class of bug as
    // CONTRE LA MONTRE above: typing in betAmountInput sends betSet to the
    // server on every keystroke (see mmBetInput), which rebroadcasts state
    // to every client including this one, and rebuilding phaseArea.innerHTML
    // from that broadcast recreates the input mid-keystroke, dropping
    // focus, closing the on-screen keyboard on every character
    // ("impossible de taper au téléphone"). Nothing else in this view can
    // change during betting (final_bet disables powers, and no other
    // team's status is shown here, unlike screen.html), so it's safe to
    // just skip the rebuild outright while the amount input has focus.
    if (state.phase === 'final_betting') {
      const active = document.activeElement;
      if (active && active.id === 'betAmountInput') return;
    }

    myTeamChip.innerHTML = `<span class="dot" style="background:${t.color}"></span>${t.emoji} ${esc(t.name)}
      <button class="btn ghost" style="padding:4px 9px;font-size:12px" onclick="mmEditProfile()">✏️</button>`;
    myScore.textContent = t.score;

    const shouldCustomize = (!t.customized && !dismissedCustomize) || showCustomize;
    if (shouldCustomize) {
      if (!profileDraft.color) profileDraft = { name: t.name, color: t.color };
      myEffects.innerHTML = '';
      renderCustomize(state, t);
      return;
    }

    const eff = state.effects || {};
    const badges = [];
    if (eff.double) badges.push('<span class="badge on">2️⃣ DOUBLE prêt</span>');
    if (eff.shield) badges.push('<span class="badge on">🛡️ SHIELD actif</span>');
    if (eff.silence) badges.push('<span class="badge off">🤫 SILENCE</span>');
    myEffects.innerHTML = badges.join(' ');

    myPayloadEl.innerHTML = myPayloadHtml(state);
    // Reached either for a phase other than panic_running, or the very
    // first render entering it (the early return above only fires once
    // #panicInput already exists), either way this is a real phase
    // change, so a full rebuild is correct, and any stale panic diff
    // cache from a previous round needs clearing.
    panicLastRemaining = null;
    panicLastMineCount = null;
    finalGuessLastRemaining = null;
    phaseArea.innerHTML = phaseHtml(state, t);
    renderPowers(state, t);
  }

  // Every OTHER team's submission also broadcasts a state update to us
  // (server is authoritative, one broadcast reaches everyone), which can
  // happen dozens of times over a 30s round with several teams racing.
  // Even a "surgical" DOM write on each one adds up on a real phone's
  // CPU as the answers list grows through the round, exactly the kind of
  // jank that can make a tap fail to register (not reproducible with
  // synthetic/instant test taps, which never land in that busy window).
  // Skip the write entirely unless the value we'd show actually changed.
  let panicLastRemaining = null;
  let panicLastMineCount = null;

  function updatePanicRunning(state, t) {
    // The countdown digit changes via textContent roughly once a second for
    // the whole round, no matter how many teams are playing or how fast
    // they submit, this is the one write none of the earlier rounds of
    // this fix ever actually removed. Reported still broken with only 2
    // teams (one on a PC barely producing any traffic), which rules out
    // broadcast volume as the driver and points squarely at this recurring
    // per-second write instead. While the input has focus, skip writing to
    // the DOM anywhere on this page from this async path entirely, values
    // aren't lost, they're just not painted until the input blurs, at
    // which point the diff below naturally catches up to the latest state.
    if (isTouchDevice && document.activeElement && document.activeElement.id === 'panicInput') return;

    const remaining = Math.max(0, Math.ceil((state.panic.endsAt - Date.now()) / 1000));
    const mine = state.panic.submissions[myTeamId] || [];
    if (remaining !== panicLastRemaining) {
      const timerEl = document.getElementById('panicTimerValue');
      if (timerEl) timerEl.textContent = remaining;
      panicLastRemaining = remaining;
    }
    if (mine.length !== panicLastMineCount) {
      const listEl = document.getElementById('panicList');
      if (listEl) listEl.innerHTML = mine.map(it => `<div class="panic-row">${esc(it.text)}</div>`).join('') || '<p class="muted small">Vos réponses apparaîtront ici.</p>';
      panicLastMineCount = mine.length;
    }
  }

  let finalGuessLastRemaining = null;

  function updateFinalGuess(state, t) {
    if (isTouchDevice && document.activeElement && document.activeElement.id === 'finalGuessInput') return;
    const pt = state.playTimer;
    const remaining = (pt && pt.running && pt.endsAt) ? Math.max(0, Math.ceil((pt.endsAt - Date.now()) / 1000)) : 0;
    if (remaining !== finalGuessLastRemaining) {
      const el = document.getElementById('finalGuessTimerValue');
      if (el) el.textContent = remaining;
      finalGuessLastRemaining = remaining;
    }
  }

  function myPayloadHtml(state) {
    const p = state.myPayload;
    if (!p) return '';
    if (p.kind === 'forbidden_word') {
      return `<div class="card center" style="margin-top:14px;border-color:var(--pink)"><div class="muted small">❌ MOT INTERDIT : NE BUZZEZ PAS SI LA CHANSON Y CORRESPOND</div><div style="font-size:26px;font-weight:900">${esc(p.word || '-')}</div></div>`;
    }
    if (p.kind === 'banned_words') {
      return `<div class="card center" style="margin-top:14px;border-color:var(--pink)"><div class="muted small">🤐 MOTS INTERDITS POUR DÉCRIRE</div><div style="font-size:18px;font-weight:800">${esc((p.words || []).join(' · ') || '-')}</div></div>`;
    }
    return '';
  }

  function renderCustomize(state, t) {
    const palette = state.meta.palette || [];
    const takenByOthers = new Set(state.teams.filter(x => x.id !== myTeamId && x.customized).map(x => x.color.toLowerCase()));
    phaseArea.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">🎨 Personnalisez votre équipe</h3>
        <input type="text" id="teamNameInput" maxlength="18" placeholder="Nom de l'équipe" value="${esc(profileDraft.name)}" oninput="mmProfileName(this.value)">
        <div class="muted small" style="margin-top:14px">Choisissez une couleur</div>
        <div class="row" style="margin-top:8px">
          ${palette.map(p => {
            const taken = takenByOthers.has(p.color.toLowerCase());
            const selected = profileDraft.color.toLowerCase() === p.color.toLowerCase();
            return `<button class="swatch-btn" ${taken ? 'disabled title="Déjà prise"' : `onclick="mmProfileColor('${p.color}')"`}
              style="background:${p.color};${selected ? 'box-shadow:0 0 0 4px var(--ink)' : ''}">${taken ? '🚫' : p.emoji}</button>`;
          }).join('')}
        </div>
        <button class="btn primary block" style="margin-top:16px" onclick="mmSaveProfile()">✅ C'EST PARTI</button>
        <button class="btn ghost block" style="margin-top:8px" onclick="mmSkipProfile()">Garder « ${esc(t.name)} »</button>
      </div>`;
    powersList.innerHTML = '';
  }

  function phaseHtml(state, t) {
    switch (state.phase) {
      case 'lobby': return `<div class="card center"><div style="font-size:40px">🎧</div><p class="muted">En attente du lancement par l'animateur...</p></div>`;
      case 'selection': return selectionHtml(state, t);
      case 'challenge_intro': return introHtml(state, t);
      case 'challenge_results': return leaderboardHtml(state, t);
      case 'victory': return victoryHtml(state, t);
      case 'panic_running': return panicRunningHtml(state, t);
      case 'panic_review': return panicReviewHtml(state, t);
      case 'final_betting': return finalBettingHtml(state, t);
      case 'final_guess': return finalGuessHtml(state, t);
      case 'final_reveal': return finalRevealHtml(state, t);
      case 'choice_active': return choiceActiveHtml(state, t);
      case 'choice_reveal': return choiceRevealHtml(state, t);
      case 'perform_active': return performActiveHtml(state, t);
      default: return questionHtml(state, t);
    }
  }

  function selectionCardHtml(c) {
    return `<button class="option-card" onclick="mmPickChallenge('${c.id}')">
      <div class="row between"><span style="font-size:24px">${c.icon}</span><span class="badge">${c.estimatedMinutes} min</span></div>
      <b>${esc(c.name)}</b><div class="muted small">${esc(c.description)}</div>
    </button>`;
  }

  function selectionHtml(state, t) {
    const sel = state.selection;
    if (sel.policy === 'chaos' || sel.policy === 'final') {
      return `<div class="card center"><div style="font-size:40px">${sel.policy === 'chaos' ? '🌀' : '🏁'}</div><h3>${sel.policy === 'chaos' ? 'CHAOS choisit...' : 'ÉPREUVE FINALE'}</h3><p class="muted">Préparez-vous !</p></div>`;
    }
    if (sel.policy === 'duel') {
      const isChooser = t.id === sel.chooserTeamId, isSecond = t.id === sel.secondChooserTeamId;
      if (!isChooser && !isSecond) {
        const chooser = state.teams.find(x => x.id === sel.chooserTeamId);
        const second = state.teams.find(x => x.id === sel.secondChooserTeamId);
        return `<div class="card center"><div style="font-size:34px">⚔️</div><h3>DUEL</h3><p class="muted">${esc(chooser ? chooser.name : '')} vs ${esc(second ? second.name : '')} choisissent...</p></div>`;
      }
      const myOptions = isChooser ? sel.options : sel.optionsB;
      const alreadyPicked = sel.duelPicks[t.id];
      if (alreadyPicked) return `<div class="card center glow"><p class="acid">✅ Choix envoyé !</p><p class="muted">En attente de l'autre équipe...</p></div>`;
      return `<div class="card center"><h3 style="margin:0">⚔️ Choisissez votre épreuve</h3></div>${myOptions.map(selectionCardHtml).join('')}`;
    }
    const isChooser = t.id === sel.chooserTeamId;
    if (!isChooser) {
      const chooser = state.teams.find(x => x.id === sel.chooserTeamId);
      return `<div class="card center"><div style="font-size:34px">🤔</div><h3 class="team-text" style="color:${chooser ? chooser.color : ''}">${esc(chooser ? chooser.name : '')} choisit...</h3></div>`;
    }
    return `<div class="card center"><h3 style="margin:0">🎯 Choisissez la prochaine épreuve</h3></div>${sel.options.map(selectionCardHtml).join('')}`;
  }

  function introHtml(state) {
    const c = state.challenge;
    return `<div class="card center"><div style="font-size:40px">${c.icon}</div><h2 style="margin:6px 0">${esc(c.name)}</h2><p class="muted">${esc(c.description)}</p></div>`;
  }

  function choiceActiveHtml(state, t) {
    const q = state.question;
    if (!q) return `<div class="card center"><p class="muted">En attente...</p></div>`;
    const myChoice = state.choices.myChoice;
    const opts = (q.options || []).map((o, i) => {
      const label = o.title ? `${esc(o.title)} · ${esc(o.artist)}` : esc(o.label || ('Option ' + (i + 1)));
      const picked = myChoice === i;
      return `<button class="choice-option ${picked ? 'picked' : ''}" ${myChoice != null ? 'disabled' : ''} onclick="mmSubmitChoice(${i})">${i + 1}. ${label}</button>`;
    }).join('');
    const criterionBlock = q.criterion ? `<div class="card center"><div class="muted small">Critère: ${esc(q.criterion)}</div></div>` : '';
    return `${criterionBlock}${opts}
      ${myChoice != null ? '<p class="center" style="margin-top:10px;font-weight:800;color:var(--ink)">Réponse envoyée, en attente des autres équipes...</p>' : ''}`;
  }

  function choiceRevealHtml(state, t) {
    const q = state.question;
    const myChoice = state.choices.myChoice;
    const opts = (q.options || []).map((o, i) => {
      const label = o.title ? `${esc(o.title)} · ${esc(o.artist)}` : esc(o.label || ('Option ' + (i + 1)));
      const correct = q.correctIndex === i;
      const picked = myChoice === i;
      return `<button class="choice-option ${correct ? 'correct' : ''}" disabled>${i + 1}. ${label}${correct ? ' ✓' : ''}${picked ? ' (votre choix)' : ''}</button>`;
    }).join('');
    const won = myChoice === q.correctIndex;
    // JOUEUR A, JOUEUR B OU LES DEUX ? reveals the actual song here (title/
    // artist + cover): the options above are only the three fixed answer
    // labels, not the track. Cover art is best-effort and drops itself via
    // onerror if unavailable.
    const trackReveal = q.title ? `<div class="card float-in center" style="margin-top:10px">
      ${q.spotifyUri ? `<img src="/api/spotify/album-art?uri=${encodeURIComponent(q.spotifyUri)}" alt="" style="width:100px;height:100px;object-fit:cover;border-radius:10px;border:3px solid var(--ink);margin-bottom:8px" onerror="this.remove()">` : ''}
      <b style="font-size:18px">${esc(q.title)}</b><div class="muted">${esc(q.artist)}</div>
    </div>` : '';
    return `<div class="card center">${myChoice == null ? '<p class="muted">Vous n\'avez pas répondu à temps.</p>' : `<div class="${won ? 'acid' : 'pink'}" style="font-weight:900">${won ? '✅ CORRECT' : '❌ RATÉ'}</div>`}</div>${opts}${trackReveal}`;
  }

  function performActiveHtml(state, t) {
    const q = state.question;
    if (!q) return `<div class="card center"><p class="muted">En attente...</p></div>`;
    let timer = '';
    if (state.performTimer && state.performTimer.running) {
      const remaining = Math.max(0, Math.ceil((state.performTimer.endsAt - Date.now()) / 1000));
      timer = `<div class="timer" style="font-size:60px">${remaining}</div>`;
    }
    return `<div class="card center">
      ${q.action ? `<div class="score" style="font-size:clamp(28px,10vw,56px);word-break:break-word">${esc(q.action)}</div>` : '<div style="font-size:40px">🎵</div>'}
      ${timer}
      <p class="muted" style="margin-top:8px">L'animateur note les meilleures équipes.</p>
    </div>`;
  }

  function questionHtml(state, t) {
    const q = state.question;
    const c = state.challenge;
    if (c && c.mode === 'panic') {
      return `<div class="card center"><div style="font-size:40px">⏳</div><p class="muted">Le chrono va démarrer...</p></div>`;
    }
    const wrongAlready = state.buzzer.wrongTeamIds.includes(myTeamId);
    const silenced = state.effects && state.effects.silence;
    const iAmLocked = state.buzzer.lockedTeamId === myTeamId;
    const otherLocked = state.buzzer.lockedTeamId && !iAmLocked;

    let clueBlock = '';
    if (q && q.clue) clueBlock = `<div class="card center" style="margin-bottom:10px"><div class="muted small">TRADUCTION</div><div style="font-size:22px;font-weight:800">"${esc(q.clue)}"</div></div>`;
    if (q && q.hint) clueBlock += `<div class="card center" style="margin-bottom:10px;border-color:var(--yellow)"><div class="muted small">🔮 INDICE</div><div>${esc(q.hint)}</div></div>`;
    if (c && c.mode === 'buzzer_tiered' && q) {
      const tiers = c.scoring.tiers;
      const idx = state.buzzer.tierIndex || 0;
      clueBlock += `<div class="card center" style="margin-bottom:10px"><span class="badge warn">${esc(tiers[idx].label)} → +${tiers[idx].points}</span></div>`;
    }

    let revealBlock = '';
    if (state.reveal.shown && q) {
      if (q.tracks) revealBlock = `<div class="card float-in">${q.tracks.map(tr => `<b>${esc(tr.title || '-')}</b> · ${esc(tr.artist || '')}`).join('<br>')}</div>`;
      else if (c && c.id === 'album_detective') {
        // Scores album+année here (data/challenges.json), not title+artist,
        // so that's what the reveal should show. Cover art is best-effort
        // (needs Spotify configured) and silently drops via onerror.
        const art = q.spotifyUri ? `<img src="/api/spotify/album-art?uri=${encodeURIComponent(q.spotifyUri)}" alt="" style="width:120px;height:120px;object-fit:cover;border-radius:12px;border:3px solid var(--ink);margin-bottom:8px" onerror="this.remove()">` : '';
        revealBlock = `<div class="card float-in center">${art}<b style="font-size:20px">${esc(q.album || '?')}</b>${q.year ? `<div class="muted">${esc(String(q.year))}</div>` : ''}</div>`;
      }
      else if (c && c.id === 'movie_soundtrack') {
        const poster = q.posterUrl ? `<img src="${esc(q.posterUrl)}" alt="" style="width:110px;height:165px;object-fit:cover;border-radius:10px;border:3px solid var(--ink);margin-bottom:8px" onerror="this.remove()">` : '';
        revealBlock = `<div class="card float-in center">${poster}<b style="font-size:20px">${esc(q.movieTitle || '?')}</b></div>`;
      }
      else if (q.title) {
        const art = q.spotifyUri ? `<img src="/api/spotify/album-art?uri=${encodeURIComponent(q.spotifyUri)}" alt="" style="width:90px;height:90px;object-fit:cover;border-radius:10px;border:3px solid var(--ink)" onerror="this.remove()">` : '';
        revealBlock = `<div class="card float-in"><div class="row" style="gap:12px;align-items:center">${art}<div><b style="font-size:20px">${esc(q.title)}</b><div class="muted">${esc(q.artist)}</div></div></div></div>`;
      }
    }

    const at = state.answerTimer;
    const answerRemaining = (at && at.running && at.endsAt) ? Math.max(0, Math.ceil((at.endsAt - Date.now()) / 1000)) : null;
    const answerTimerHtml = answerRemaining != null ? `<div class="timer" style="font-size:48px;margin-top:6px">${answerRemaining}</div>` : '';

    if (iAmLocked) {
      return `${clueBlock}<div class="card center glow"><div style="font-size:44px">🎤</div><h2 class="acid">À VOUS !</h2><p class="muted">Répondez à l'oral, l'animateur valide.</p>${answerTimerHtml}</div>${revealBlock}`;
    }
    if (otherLocked) {
      const other = state.teams.find(x => x.id === state.buzzer.lockedTeamId);
      return `${clueBlock}<div class="card center"><div style="font-size:34px">⚡</div><h3 class="team-text" style="color:${other ? other.color : ''}">${esc(other ? other.name : '')} A BUZZÉ</h3>${answerTimerHtml}</div>${revealBlock}`;
    }

    let caption = 'Buzzer fermé';
    let captionColor = 'var(--ink)';
    if (silenced) { caption = '🤫 Vous êtes réduit au silence sur cette question'; captionColor = 'var(--pink)'; }
    else if (wrongAlready) { caption = 'Vous avez déjà tenté cette question'; }
    else if (state.buzzer.open) { caption = 'BUZZEZ !'; captionColor = 'var(--acid)'; }

    const disabled = !state.buzzer.open || wrongAlready || silenced;
    // Deliberately not .muted here: that color is tuned for secondary
    // text on a white card, and this caption sits directly on the vivid
    // gradient background, where it was nearly illegible despite being
    // the single most important status ("can I buzz right now?").
    return `${clueBlock}
      <button class="buzz-btn ${state.buzzer.open && !disabled ? 'open' : ''}" ${disabled ? 'disabled' : ''} onclick="mmBuzz()">🔴 BUZZ</button>
      <p class="center" style="margin-top:10px;font-weight:800;color:${captionColor}">${caption}</p>
      ${revealBlock}`;
  }

  function panicRunningHtml(state, t) {
    const remaining = Math.max(0, Math.ceil((state.panic.endsAt - Date.now()) / 1000));
    const mine = state.panic.submissions[myTeamId] || [];
    return `
      <div class="card center"><div class="muted small" id="panicTheme">${esc(state.question ? state.question.theme : '')}</div><div class="timer" style="font-size:64px" id="panicTimerValue">${remaining}</div></div>
      <div class="card" style="margin-top:10px">
        <div class="row">
          <input type="text" id="panicInput" placeholder="Votre réponse..." oninput="mmPanicInput(this.value)" onkeydown="if(event.key==='Enter'){mmPanicSubmit()}">
          <button class="btn primary" onclick="mmPanicSubmit()">+</button>
        </div>
        <div id="panicList">${mine.map(it => `<div class="panic-row">${esc(it.text)}</div>`).join('') || '<p class="muted small">Vos réponses apparaîtront ici.</p>'}</div>
      </div>`;
  }

  function panicReviewHtml(state, t) {
    const rows = state.teams.filter(x => x.connected).map(team => {
      const items = (state.panic.submissions[team.id] || []).map((it, idx) => {
        const mineTeam = team.id === myTeamId;
        const canChallenge = !mineTeam && it.status !== 'invalid';
        return `<div class="panic-row"><span class="${it.status}">${esc(it.text)} ${it.status === 'valid' ? '✓' : it.status === 'invalid' ? '✗' : ''}</span>
          ${canChallenge ? `<button class="btn ghost" style="padding:4px 10px;font-size:11px" onclick="mmPanicChallenge('${team.id}',${idx})">CONTESTER</button>` : ''}</div>`;
      }).join('') || '<p class="muted small">-</p>';
      return `<div style="margin-bottom:10px"><b class="team-text" style="color:${team.color}">${esc(team.name)}</b>${items}</div>`;
    }).join('');
    return `<div class="card"><div class="badge warn">JUGEMENT EN COURS</div>${rows}</div>`;
  }

  // The guess field used to sit right here from the start of betting, with
  // zero information to go on (not even the year): a pure guess of how
  // confident you feel, not a real wager. Betting is now informed by the
  // year+style hint below, and the title guess itself only appears once
  // everyone has locked their amount, at the same moment the audio starts
  // (see finalGuessHtml) — that's the actual game, not typed in blind.
  function finalHintHtml(state) {
    const q = state.question;
    if (!q || (!q.year && !q.genre)) return '';
    return `<div class="row" style="justify-content:center;gap:8px;flex-wrap:wrap;margin-top:6px">
      ${q.year ? `<span class="badge warn">📅 ${esc(String(q.year))}</span>` : ''}
      ${q.genre ? `<span class="badge warn">🎵 ${esc(q.genre)}</span>` : ''}
    </div>`;
  }

  function finalBettingHtml(state, t) {
    const bet = state.bets[myTeamId];
    const hint = finalHintHtml(state);
    if (bet && bet.locked) {
      return `<div class="card center glow"><div class="muted small">MISE VERROUILLÉE</div><div class="score big">${bet.amount}</div>
        ${hint}
        <p class="muted" style="margin-top:10px">En attente des autres équipes...</p></div>`;
    }
    return `<div class="card center">
      ${hint}
      <div class="muted small" style="margin-top:10px">VOTRE SCORE</div><div class="score">${t.score}</div>
      <div class="muted small" style="margin-top:14px;text-align:left">VOTRE MISE</div>
      <div style="margin-top:6px"><input type="number" id="betAmountInput" min="0" max="${Math.max(0, t.score)}" value="${bet ? bet.amount : 0}" oninput="mmBetInput(this.value)"></div>
      <button class="btn primary block" style="margin-top:12px" onclick="mmBetLock()">🔒 VERROUILLER LA MISE</button>
    </div>`;
  }

  function finalGuessHtml(state, t) {
    const bet = state.bets[myTeamId] || { amount: 0, guess: '' };
    const pt = state.playTimer;
    const remaining = (pt && pt.running && pt.endsAt) ? Math.max(0, Math.ceil((pt.endsAt - Date.now()) / 1000)) : null;
    return `<div class="card center">
      <div class="muted small">🎧 ÉCOUTEZ ET DEVINEZ LE TITRE</div>
      ${remaining != null ? `<div class="timer" id="finalGuessTimerValue">${remaining}</div>` : ''}
      <div class="muted small" style="margin-top:10px">VOTRE MISE : ${bet.amount}</div>
      <div class="muted small" style="margin-top:14px;text-align:left">TITRE DE LA CHANSON</div>
      <input type="text" id="finalGuessInput" maxlength="80" placeholder="Votre réponse..." value="${esc(bet.guess || '')}" oninput="mmBetGuess(this.value)" style="margin-top:6px">
    </div>`;
  }

  function finalRevealHtml(state, t) {
    const bet = state.bets[myTeamId] || { amount: 0 };
    const q = state.question;
    let verdict = '<p class="muted">En attente du verdict...</p>';
    if (bet.resolved) verdict = bet.correct ? `<div class="acid" style="font-size:28px;font-weight:800">✅ +${bet.amount}</div>` : `<div class="pink" style="font-size:28px;font-weight:800">❌ -${bet.amount}</div>`;
    return `<div class="card center">
      ${q && q.title ? `<b>${esc(q.title)}</b><div class="muted">${esc(q.artist)}</div>` : ''}
      ${bet.guess ? `<div class="muted small" style="margin-top:10px">VOTRE RÉPONSE : ${esc(bet.guess)}</div>` : ''}
      <div class="muted small" style="margin-top:6px">VOTRE MISE : ${bet.amount}</div>
      ${verdict}
    </div>`;
  }

  function leaderboardHtml(state, t) {
    const sorted = [...inPlayTeams(state)].sort((a, b) => b.score - a.score);
    const rows = sorted.map((team, i) => `<div class="line" style="${team.id === myTeamId ? 'font-weight:900' : ''}"><span>${i + 1}. ${team.emoji} ${esc(team.name)}</span><span>${team.score}</span></div>`).join('');
    return `<div class="card">${rows}</div>`;
  }

  function victoryHtml(state, t) {
    const sorted = [...inPlayTeams(state)].sort((a, b) => b.score - a.score);
    const rank = sorted.findIndex(x => x.id === myTeamId) + 1;
    if (rank === 1) return `<div class="card center glow"><div style="font-size:60px">🏆</div><h2 class="acid">VOUS AVEZ GAGNÉ !</h2><div class="score big">${t.score}</div></div>`;
    return `<div class="card center"><div style="font-size:40px">🎉</div><h3>Terminé ${rank}ème</h3><div class="score">${t.score} pts</div></div>`;
  }

  function renderPowers(state, t) {
    const catalog = {};
    (state.meta.powers || []).forEach(p => { catalog[p.id] = p; });
    if (!t.powers || !t.powers.length) { powersList.innerHTML = '<p class="muted small">Aucune carte pour le moment.</p>'; return; }
    const cardsHtml = t.powers.map(card => {
      const def = catalog[card.powerId] || { id: card.powerId, name: card.powerId, emoji: '🃏', description: '' };
      const isTargeting = targeting === card.instId;
      let targetsHtml = '';
      if (isTargeting) {
        const others = state.teams.filter(x => x.id !== myTeamId && x.connected);
        targetsHtml = `<div class="target-list">${others.map(o => `<button class="btn ghost" onclick="mmPickTarget('${card.instId}','${o.id}')">${o.emoji} ${esc(o.name)}</button>`).join('')}</div>`;
      }
      // Each card + its own target picker (if any) stay grouped as one
      // flex item, so the target buttons land under that specific card
      // rather than as a sibling card in the wrapping hand row below.
      return `<div style="min-width:112px">
        <div style="cursor:pointer" onclick="mmUsePower('${card.instId}','${card.powerId}')">${MM.tarotCardHtml(def, { size: 'sm' })}</div>
        ${targetsHtml}
      </div>`;
    }).join('');
    powersList.innerHTML = `<div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-start">${cardsHtml}</div>`;
  }
})();
