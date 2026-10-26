// Shared WebSocket client: reconnect loop + persistent session id.
// Every page (host/team/screen) uses this the same way:
//   const client = MM.connect(state => render(state));
//   client.send({ type: '...' });
window.MM = (function () {
  function getSessionId() {
    let id = localStorage.getItem('mm_session');
    if (!id) {
      id = 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('mm_session', id);
    }
    return id;
  }

  function connect(onState, onError) {
    let ws = null;
    let openHandlers = [];
    let closed = false;

    function open() {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
      ws.onopen = () => { setConnBadge(true); openHandlers.forEach(fn => fn()); };
      ws.onclose = () => { setConnBadge(false); if (!closed) setTimeout(open, 1000); };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
      ws.onmessage = e => {
        let m;
        try { m = JSON.parse(e.data); } catch (e2) { return; }
        if (m.type === 'state') onState(m.state);
        else if (m.type === 'error' && onError) onError(m.msg);
      };
    }

    function setConnBadge(ok) {
      const el = document.getElementById('connBadge');
      if (el) { el.textContent = ok ? '🟢 connecté' : '🔴 reconnexion...'; el.className = 'badge ' + (ok ? 'on' : 'off'); }
    }

    open();
    return {
      send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
      onOpen(fn) { openHandlers.push(fn); },
      close() { closed = true; if (ws) ws.close(); }
    };
  }

  function toast(text, ms) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

  function fmt(n) { return (n > 0 ? '+' : '') + n; }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Each Mayhem power reimagined as a Major Arcana card, picked for how the
  // card's own meaning already matches the power's effect (no relation to
  // tarot cartomancy's real fortune-telling use, purely a visual/flavor
  // skin for this game's card catalog in data/config.json).
  const TAROT = {
    chaos: { numeral: '0', name: 'LE FOU', sub: 'le hasard', grad: ['#7C3AED', '#FF3D9A'], flavor: "Rien n'est jamais sûr." },
    shield: { numeral: 'XI', name: 'LA FORCE', sub: 'la protection', grad: ['#23C16B', '#FFD23D'], flavor: 'Ce qui frappe ne passe pas.' },
    silence: { numeral: 'XII', name: 'LE PENDU', sub: 'le silence', grad: ['#2A1B4D', '#7C3AED'], flavor: 'Le silence est une arme.' },
    bomb: { numeral: 'XVI', name: 'LA TOUR', sub: 'la chute', grad: ['#FF7A3D', '#FF3D6E'], flavor: 'Tout ce qui monte redescend.' },
    oracle: { numeral: 'XVIII', name: 'LA LUNE', sub: 'le mystère', grad: ['#1B1140', '#2BB6FF'], flavor: 'Ce qui est caché se révèle.' },
    double: { numeral: 'XIX', name: 'LE SOLEIL', sub: 'la fortune', grad: ['#FFD23D', '#FF7A3D'], flavor: 'La chance sourit deux fois.' }
  };

  // powerDef: one entry from state.meta.powers ({id, name, emoji, description}).
  // opts.size: 'lg' (full reveal, default) or 'sm' (compact, e.g. a hand list).
  function tarotCardHtml(powerDef, opts) {
    opts = opts || {};
    const t = TAROT[powerDef.id] || { numeral: '?', name: powerDef.name, sub: '', grad: ['#8A7FA0', '#2A1B4D'], flavor: '' };
    const sm = opts.size === 'sm';
    return `<div class="tarot-card${sm ? ' sm' : ''}" style="--tarot-g1:${t.grad[0]};--tarot-g2:${t.grad[1]}">
      <div class="crack-overlay"></div>
      <div class="tarot-numeral">${escHtml(t.numeral)}</div>
      <div class="tarot-symbol">${powerDef.emoji || '🃏'}</div>
      <div class="tarot-body">
        <div class="tarot-name">${escHtml(t.name)}</div>
        <div class="tarot-sub">${escHtml(t.sub)}</div>
        <div class="tarot-power">✦ ${escHtml(powerDef.name)} ✦</div>
        ${sm ? '' : `<div class="tarot-desc">${escHtml(powerDef.description)}</div>${t.flavor ? `<div class="tarot-flavor">« ${escHtml(t.flavor)} »</div>` : ''}`}
      </div>
    </div>`;
  }

  return { getSessionId, connect, toast, fmt, tarotCardHtml };
})();
