'use strict';
/* Rubis Duel — client. Tout l'état de jeu vient du serveur ; ce fichier ne fait qu'afficher et envoyer des intentions. */

// ------------------------------------------------------------------ utilitaires
const TIER = { S: 'Légendaire', A: 'Épique', B: 'Rare', C: 'Commun' };
const GEM_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12l4 6-10 12L2 9z" fill="currentColor"/><path d="M2 9h20M9 3l-3 6 6 12 6-12-3-6" stroke="rgba(255,255,255,.55)" stroke-width="1" fill="none" stroke-linejoin="round"/></svg>';

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const gem = () => { const s = h('span', { class: 'gem' }); s.innerHTML = GEM_SVG; return s; };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* navigation privée */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } }
};

// ------------------------------------------------------------------ état
const state = {
  ws: null, connected: false, booting: true,
  me: null, decks: [], rules: { step: 10, slots: 5, startRubis: 500, turnSeconds: 30 },
  friends: { friends: [], incoming: [], outgoing: [] },
  room: null, offset: 0,
  selectedDeck: null,
  pendingJoin: null
};
const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{3,8})/);
if (m) state.pendingJoin = m[1].toUpperCase();

// ------------------------------------------------------------------ réseau
let retry = 0;
function send(msg) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg)); }

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    retry = 0; state.connected = true; updateTop();
    ws.send(JSON.stringify({ type: 'hello', token: store.get('rd_token') || undefined }));
  };
  ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    state.connected = false; updateTop();
    setTimeout(connect, Math.min(5000, 700 * ++retry));
  };
}
setInterval(() => send({ type: 'ping' }), 20000);

function onMsg(msg) {
  switch (msg.type) {
    case 'welcome':
      store.set('rd_token', msg.token);
      Object.assign(state, { me: msg.me, decks: msg.decks, rules: msg.rules, booting: false });
      if (!state.selectedDeck || !state.decks.some((d) => d.id === state.selectedDeck)) state.selectedDeck = state.decks[0]?.id;
      if (state.pendingJoin) { send({ type: 'room.join', code: state.pendingJoin }); state.pendingJoin = null; history.replaceState(null, '', '/'); }
      break;
    case 'need-login': store.del('rd_token'); state.me = null; state.booting = false; break;
    case 'me': state.me = msg.me; break;
    case 'friends': state.friends = msg; break;
    case 'room':
      state.room = msg.room;
      if (msg.room?.game) state.offset = msg.room.game.serverNow - Date.now();
      history.replaceState(null, '', msg.room ? `/r/${msg.room.code}` : '/');
      break;
    case 'toast': toast(msg.message); return;
    case 'error': toast(msg.message, { error: true }); return;
    case 'invite':
      toast(`${msg.from} t'invite à jouer${msg.deck ? ` (${msg.deck})` : ''}.`, {
        ttl: 20000, action: 'Rejoindre', onAction: () => send({ type: 'room.join', code: msg.code })
      });
      return;
    default: return;
  }
  render();
}

// ------------------------------------------------------------------ toasts
function toast(text, opts = {}) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast${opts.error ? ' error' : ''}` }, h('span', {}, text));
  const close = () => el.remove();
  if (opts.action) el.append(h('button', { class: 'btn small primary', onclick: () => { opts.onAction(); close(); } }, opts.action));
  box.append(el);
  setTimeout(close, opts.ttl || 4200);
  while (box.children.length > 3) box.firstChild.remove();
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copié !'); }
  catch { toast('Copie impossible : sélectionne le texte à la main.', { error: true }); }
}

// ------------------------------------------------------------------ composants
function initials(name) { return name.split(/[\s.'-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }

function charCard(c, color, price) {
  const el = h('div', { class: 'card', 'data-tier': c.tier, style: `--dc:${color}` },
    h('div', { class: 'fallback' }, initials(c.name)));
  if (c.img) {
    const img = h('img', { src: c.img, alt: '', loading: 'lazy', draggable: false });
    img.addEventListener('error', () => img.remove());
    el.append(img);
  }
  el.append(h('span', { class: 'tier' }, TIER[c.tier]), h('div', { class: 'cap' }, h('b', {}, c.name)));
  if (price != null) el.append(h('span', { class: 'price num' }, price, gem()));
  return el;
}

function deckPicker(onPick) {
  const wrap = h('div', { class: 'decks' });
  const update = (selected) => {
    wrap.replaceChildren(...state.decks.map((d) => h('button', {
      class: 'deck', type: 'button', style: `--c:${d.color}`, 'aria-pressed': String(d.id === selected),
      onclick: () => onPick(d.id)
    }, h('b', {}, d.name), h('span', {}, d.tagline), h('span', { class: 'count' }, `${d.count} personnages`))));
  };
  return { el: wrap, update };
}

function chatBox() {
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  const input = h('input', { class: 'field', id: `chat-${Math.random().toString(36).slice(2, 6)}`, placeholder: 'Écrire un message…', maxlength: 140, autocomplete: 'off' });
  const form = h('form', {
    class: 'row',
    onsubmit: (e) => { e.preventDefault(); const t = input.value.trim(); if (t) { send({ type: 'chat', text: t }); input.value = ''; } }
  }, input, h('button', { class: 'btn', type: 'submit' }, 'Envoyer'));
  const quick = h('div', { class: 'quick' }, ['GG 👏', '😂', 'Trop cher !', 'Joli choix', 'Bien joué 😎'].map((t) =>
    h('button', { type: 'button', onclick: () => send({ type: 'chat', text: t }) }, t)));
  let key = '';
  return {
    el: h('div', { class: 'chat' }, log, quick, form),
    update() {
      const chat = state.room.chat;
      const k = `${chat.length}:${chat.at(-1)?.t}`;
      if (k === key) return;
      key = k;
      log.replaceChildren(...chat.map((c) => h('p', { class: c.seat === state.room.you ? 'you' : 'opp' },
        h('b', {}, `${state.room.players[c.seat]?.name || '?'} : `), c.text)));
      log.scrollTop = log.scrollHeight;
    }
  };
}

function friendList({ forInvite }) {
  const box = h('div');
  return {
    el: box,
    update() {
      const f = state.friends;
      const rows = [];
      for (const r of f.incoming) rows.push(h('div', { class: 'friend' }, h('span', { class: 'name' }, r.name, h('small', {}, ' veut devenir ton ami')),
        h('button', { class: 'btn small primary', onclick: () => send({ type: 'friend.accept', id: r.id }) }, 'Accepter'),
        h('button', { class: 'btn small ghost', onclick: () => send({ type: 'friend.decline', id: r.id }) }, 'Refuser')));
      let list = f.friends;
      if (forInvite) list = list.filter((x) => x.online && !x.inGame && !state.room.players.some((p) => p.id === x.id));
      for (const x of list) {
        const actions = [];
        if (forInvite) actions.push(h('button', { class: 'btn small primary', onclick: () => send({ type: 'room.invite', id: x.id }) }, 'Inviter'));
        else {
          if (x.joinable) actions.push(h('button', { class: 'btn small primary', onclick: () => send({ type: 'room.join', code: x.joinable }) }, 'Rejoindre'));
          actions.push(h('button', { class: 'linkbtn', title: 'Retirer de mes amis', onclick: () => send({ type: 'friend.remove', id: x.id }) }, 'retirer'));
        }
        rows.push(h('div', { class: 'friend' }, h('span', { class: `dot${x.online ? ' on' : ''}` }),
          h('span', { class: 'name' }, x.name, x.inGame ? h('small', {}, ' · en partie') : x.joinable ? h('small', {}, ' · salon ouvert') : null), actions));
      }
      if (!forInvite) for (const o of f.outgoing) rows.push(h('div', { class: 'friend' }, h('span', { class: 'dot' }),
        h('span', { class: 'name muted' }, o.name, h('small', {}, ' · demande envoyée')),
        h('button', { class: 'linkbtn', onclick: () => send({ type: 'friend.decline', id: o.id }) }, 'annuler')));
      if (!rows.length) rows.push(h('div', { class: 'empty' }, forInvite ? 'Aucun ami en ligne pour le moment.' : 'Pas encore d\'amis. Échange ton code ami avec quelqu\'un pour commencer.'));
      box.replaceChildren(...rows);
    }
  };
}

// ------------------------------------------------------------------ vues
const views = {};

views.loading = () => ({ el: h('div', { class: 'loader' }, 'Connexion au serveur…'), update() {} });

views.login = () => {
  const input = h('input', { class: 'field', id: 'pseudo', placeholder: 'Ton pseudo', maxlength: 20, autocomplete: 'nickname', required: true });
  const el = h('div', { class: 'login panel stack' },
    h('div', {}, h('h1', { style: 'font-size:34px' }, 'Bienvenue dans la salle des ventes'),
      h('p', { class: 'muted' }, 'Choisis un pseudo pour jouer. Il sera retenu sur cet appareil, pas besoin de mot de passe.')),
    h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); if (input.value.trim().length >= 2) send({ type: 'hello', name: input.value }); } },
      h('label', { for: 'pseudo' }, 'Pseudo'), input,
      h('button', { class: 'btn primary big', type: 'submit' }, 'Entrer')),
    h('p', { class: 'muted', id: 'login-hint' }));
  const hint = el.querySelector('#login-hint');
  return { el, update() { hint.textContent = state.pendingJoin ? `Tu as été invité dans le salon ${state.pendingJoin}. Tu le rejoindras juste après.` : ''; } };
};

views.home = () => {
  const picker = deckPicker((id) => { state.selectedDeck = id; render(); });
  const joinInput = h('input', { class: 'field num', id: 'join-code', placeholder: 'Code du salon', maxlength: 8, autocomplete: 'off', style: 'text-transform:uppercase;letter-spacing:.12em' });
  const friendInput = h('input', { class: 'field num', id: 'friend-code', placeholder: 'Code ami', maxlength: 8, autocomplete: 'off', style: 'text-transform:uppercase;letter-spacing:.12em' });
  const codeEl = h('strong');
  const fl = friendList({ forInvite: false });
  const join = () => { if (joinInput.value.trim()) send({ type: 'room.join', code: joinInput.value }); };
  const el = h('div', {},
    h('div', { class: 'hero' }, h('h1', {}, 'Un duel d\'enchères, ', h('em', {}, '500 rubis'), ' chacun.'),
      h('p', {}, 'Invite un ami, misez à tour de rôle sur des personnages de vos univers préférés et composez la meilleure équipe de 5.')),
    h('div', { class: 'home-grid' },
      h('div', { class: 'stack' },
        h('section', { class: 'panel' }, h('h2', {}, 'Nouveau duel'), h('h3', {}, 'Choisis un deck'), picker.el,
          h('div', { class: 'row', style: 'margin-top:18px' }, h('button', { class: 'btn primary big', onclick: () => send({ type: 'room.create', deck: state.selectedDeck }) }, 'Créer un salon privé'))),
        h('section', { class: 'panel' }, h('h2', {}, 'Rejoindre un salon'),
          h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); join(); } }, joinInput, h('button', { class: 'btn', type: 'submit' }, 'Rejoindre'))),
        h('section', { class: 'panel' }, h('h2', {}, 'Règles'),
          h('ol', { class: 'rules' },
            h('li', {}, h('b', {}, '500 rubis'), ' chacun, et ', h('b', {}, '5 places'), ' à remplir dans ton équipe.'),
            h('li', {}, 'Un personnage apparaît. Le joueur qui ouvre doit miser ', h('b', {}, '10 rubis minimum'), '.'),
            h('li', {}, 'L\'autre peut surenchérir (', h('b', {}, '+10 minimum'), ') ou passer. Qui passe laisse le personnage à la plus haute mise.'),
            h('li', {}, 'Garde toujours 10 rubis par place encore vide, sinon tu ne pourras pas finir ton équipe.'),
            h('li', {}, 'Quand les deux équipes sont pleines, vous décidez ensemble qui a gagné.')))),
      h('aside', { class: 'panel' }, h('h2', {}, 'Amis'),
        h('div', { class: 'mycode' }, h('div', {}, h('div', { class: 'muted', style: 'font-size:13px' }, 'Ton code ami'), codeEl),
          h('button', { class: 'btn small', onclick: () => copy(state.me.code) }, 'Copier')),
        h('form', { class: 'row', style: 'margin-bottom:12px', onsubmit: (e) => { e.preventDefault(); if (friendInput.value.trim()) { send({ type: 'friend.add', code: friendInput.value }); friendInput.value = ''; } } },
          friendInput, h('button', { class: 'btn', type: 'submit' }, 'Ajouter')),
        fl.el)));
  return { el, update() { picker.update(state.selectedDeck); codeEl.textContent = state.me.code; fl.update(); } };
};

views.lobby = () => {
  const link = h('input', { class: 'field', id: 'invite-link', readOnly: true, onfocus: (e) => e.target.select() });
  const deckBox = h('div');
  const picker = deckPicker((id) => send({ type: 'room.deck', deck: id }));
  const slots = h('div', { class: 'slots' });
  const actions = h('div', { class: 'row wrap' });
  const note = h('p', { class: 'muted', style: 'margin:12px 0 0' });
  const invite = friendList({ forInvite: true });
  const chat = chatBox();
  const title = h('div', { class: 'roomcode num' });
  const el = h('div', { class: 'lobby-grid' },
    h('div', { class: 'stack' },
      h('section', { class: 'panel' },
        h('div', { class: 'muted', style: 'font-weight:600' }, 'Salon privé'), title,
        h('div', { class: 'linkbox' }, link, h('button', { class: 'btn', onclick: () => copy(link.value) }, 'Copier le lien')),
        h('p', { class: 'muted', style: 'margin:10px 0 0;font-size:14px' }, 'Envoie ce lien à ton adversaire : il arrive directement dans ce salon.'),
        slots, actions, note),
      h('section', { class: 'panel' }, h('h2', {}, 'Deck'), deckBox)),
    h('div', { class: 'stack' },
      h('section', { class: 'panel' }, h('h2', {}, 'Inviter un ami'), invite.el),
      h('section', { class: 'panel' }, h('h2', {}, 'Discussion'), chat.el)));
  return {
    el,
    update() {
      const r = state.room, host = r.you === 0;
      title.textContent = r.code;
      link.value = `${location.origin}/r/${r.code}`;
      if (host) { picker.update(r.deck.id); deckBox.replaceChildren(picker.el); }
      else deckBox.replaceChildren(h('div', { class: 'deck', style: `--c:${r.deck.color};cursor:default` }, h('b', {}, r.deck.name), h('span', {}, r.deck.tagline), h('span', { class: 'count' }, `${r.deck.count} personnages · choisi par ${r.players[0].name}`)));
      slots.replaceChildren(...[0, 1].map((i) => {
        const p = r.players[i];
        if (!p) return h('div', { class: 'slot empty-slot' }, h('span', {}, 'En attente d\'un adversaire…'));
        return h('div', { class: 'slot' }, h('div', { class: 'who' }, p.name, i === r.you ? ' (toi)' : ''),
          h('span', { class: `pill ${p.ready ? 'ok' : 'wait'}` }, i === 0 ? 'Hôte' : p.ready ? 'Prêt' : 'Pas encore prêt'),
          p.online ? null : h('span', { class: 'muted', style: 'font-size:13px' }, 'Hors ligne'));
      }));
      const guest = r.players[1];
      if (host) {
        actions.replaceChildren(
          h('button', { class: 'btn primary big', disabled: !(guest && guest.ready), onclick: () => send({ type: 'room.start' }) }, 'Lancer la partie'),
          h('button', { class: 'btn ghost', onclick: () => send({ type: 'room.leave' }) }, 'Quitter'));
        note.textContent = !guest ? 'La partie se lance dès que ton adversaire est là et prêt.' : guest.ready ? '' : `${guest.name} n'est pas encore prêt.`;
      } else {
        const me = r.players[r.you];
        actions.replaceChildren(
          h('button', { class: `btn big${me.ready ? '' : ' primary'}`, onclick: () => send({ type: 'room.ready', ready: !me.ready }) }, me.ready ? 'Je ne suis plus prêt' : 'Je suis prêt'),
          h('button', { class: 'btn ghost', onclick: () => send({ type: 'room.leave' }) }, 'Quitter'));
        note.textContent = me.ready ? `En attente de ${r.players[0].name} pour lancer la partie.` : '';
      }
      invite.update(); chat.update();
    }
  };
};

views.game = () => {
  const mk = (cls) => {
    const name = h('div', { class: 'pname' });
    const purse = h('div', { class: 'purse num' });
    const team = h('div', { class: 'team' });
    const el = h('section', { class: `side ${cls}` }, h('header', {}, name, purse), team);
    return { el, name, purse, team };
  };
  const me = mk('side-me'), opp = mk('side-opp');
  const round = h('div', { class: 'round' });
  const cardBox = h('div');
  const bidNum = h('span', {});
  const bidNow = h('div', { class: 'bidnow num' }, bidNum, gem());
  const bidBy = h('div', { class: 'bidby' });
  const timerBar = h('i');
  const timerTxt = h('div', { class: 'turnline' });
  const trail = h('div', { class: 'trail' });
  const hint = h('div', { class: 'muted', style: 'font-size:14px' });
  const input = h('input', { class: 'field', id: 'bid-amount', type: 'number', inputMode: 'numeric', step: 1 });
  const submit = h('button', { class: 'btn primary big', type: 'button' });
  const pass = h('button', { class: 'btn big', type: 'button', onclick: () => send({ type: 'game.pass' }) }, 'Passer');
  const chips = h('div', { class: 'chips' });
  const controls = h('div', { class: 'controls' }, hint, h('div', { class: 'bidrow' }, input, submit, pass), chips);
  const sold = h('div', { class: 'sold' });
  const chat = chatBox();
  let cardId = null, bidKey = '', minV = 10, maxV = 10;

  const clamp = (v) => Math.max(minV, Math.min(maxV, Math.floor(Number(v) || minV)));
  const label = () => {
    const g = state.room.game;
    submit.replaceChildren(g.high ? `Surenchérir à ${clamp(input.value)}` : `Ouvrir à ${clamp(input.value)}`, gem());
  };
  input.addEventListener('input', label);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit.click(); } });
  submit.addEventListener('click', () => { input.value = clamp(input.value); label(); send({ type: 'game.bid', amount: Number(input.value) }); });

  const stagebox = h('div', { class: 'stagebox' }, cardBox,
    h('div', {}, round, bidNow, bidBy, h('div', { class: 'timer' }, timerBar), timerTxt, trail), controls, sold);
  const el = h('div', { class: 'game' }, me.el, h('div', { class: 'stage' }, stagebox), opp.el, h('section', { class: 'panel chatpanel' }, chat.el));

  function fillSide(s, seat, isYou) {
    const r = state.room, g = r.game;
    s.name.replaceChildren(r.players[seat].name, h('small', {}, isYou ? 'TOI' : 'ADVERSAIRE'));
    s.purse.replaceChildren(String(g.rubis[seat]), gem());
    s.el.classList.toggle('active', g.turn === seat);
    const rows = [];
    for (let i = 0; i < state.rules.slots; i++) {
      const c = g.teams[seat][i];
      rows.push(c ? h('div', { class: 'tslot filled', 'data-tier': c.tier }, h('span', { class: 'n' }, c.name), h('span', { class: 'p' }, c.price, ' ', gem()))
        : h('div', { class: 'tslot' }, 'Place libre'));
    }
    s.team.replaceChildren(...rows);
  }

  return {
    el,
    update() {
      const r = state.room, g = r.game, you = r.you, o = 1 - you;
      const oppName = r.players[o].name;
      fillSide(me, you, true); fillSide(opp, o, false);
      round.textContent = `Manche ${g.round} · ${g.teams[you].length + g.teams[o].length}/${state.rules.slots * 2} places prises`;
      if (g.current && g.current.id !== cardId) { cardId = g.current.id; cardBox.replaceChildren(charCard(g.current, r.deck.color)); }

      trail.replaceChildren(...g.trail.map((t) => h('span', { class: t.seat === you ? 'you' : 'opp' },
        `${r.players[t.seat].name} ${t.amount == null ? 'passe' : t.amount}`)));
      const isSold = !!g.sold;
      controls.hidden = isSold; sold.hidden = !isSold;
      if (isSold) {
        for (const b of [input, submit, pass]) b.disabled = true;
        const w = r.players[g.sold.winner].name;
        bidNum.textContent = g.sold.price;
        bidBy.replaceChildren('Adjugé à ', h('b', { style: `--pc:${g.sold.winner === you ? 'var(--you)' : 'var(--opp)'}` }, w));
        sold.replaceChildren(h('div', { class: 'stamp' }, 'Adjugé !'),
          h('p', {}, h('b', {}, w), ` emporte ${g.sold.char.name} pour `, h('b', { class: 'num' }, g.sold.price), ' rubis.',
            g.sold.auto ? h('span', { class: 'muted' }, ' (l\'autre équipe est complète : prix d\'ouverture)') : null));
        timerTxt.textContent = '';
        return;
      }
      const myTurn = g.turn === you;
      bidNum.textContent = g.high ? g.high.amount : '—';
      bidBy.replaceChildren(...(g.high
        ? ['Meilleure mise : ', h('b', { style: `--pc:${g.high.by === you ? 'var(--you)' : 'var(--opp)'}` }, r.players[g.high.by].name)]
        : [myTurn ? 'Tu dois ouvrir les enchères.' : `${oppName} doit ouvrir les enchères.`]));
      timerTxt.textContent = myTurn ? (g.high ? 'À toi de répondre.' : 'À toi de miser.') : `${oppName} réfléchit…`;

      minV = g.high ? g.high.amount + state.rules.step : state.rules.step;
      maxV = g.maxBid[you];
      const key = `${g.round}:${g.high ? g.high.amount : 0}:${g.turn}`;
      if (key !== bidKey) { bidKey = key; input.value = minV; }
      input.min = minV; input.max = maxV;
      for (const b of [input, submit]) b.disabled = !myTurn;
      pass.disabled = !myTurn; pass.hidden = !g.high;
      hint.textContent = myTurn
        ? `${g.high ? `Mise actuelle : ${g.high.amount}. Minimum pour surenchérir : ${minV}.` : `Minimum pour ouvrir : ${minV}.`} Maximum autorisé : ${maxV} (10 rubis gardés par place vide).`
        : 'Tu pourras miser quand ce sera ton tour.';
      const base = g.high ? g.high.amount : 0;
      chips.replaceChildren(...[10, 20, 50].map((inc) => h('button', {
        class: 'btn small', type: 'button', disabled: !myTurn || base + inc > maxV,
        onclick: () => { input.value = clamp(base + inc); label(); }
      }, `+${inc}`)), h('button', { class: 'btn small', type: 'button', disabled: !myTurn, onclick: () => { input.value = maxV; label(); } }, `Max (${maxV})`));
      label();
      chat.update();
    },
    tick() {
      const g = state.room?.game;
      if (!g || !g.deadline || g.sold) { timerBar.style.width = '0%'; return; }
      const left = Math.max(0, g.deadline - (Date.now() + state.offset));
      const total = state.rules.turnSeconds * 1000;
      timerBar.style.width = `${Math.min(100, (left / total) * 100)}%`;
      timerBar.classList.toggle('low', left < 8000);
      const s = Math.ceil(left / 1000);
      timerBar.parentElement.title = `${s} s`;
    }
  };
};

views.done = () => {
  const head = h('div', { class: 'done-head' }, h('h1', {}, 'Les équipes sont complètes'), h('p', { class: 'muted' }, 'Comparez vos équipes, puis dites qui a gagné.'));
  const teams = h('div', { class: 'teams-done' });
  const verdict = h('div', { class: 'verdict' });
  const chat = chatBox();
  const el = h('div', {}, head, teams, verdict, h('section', { class: 'panel', style: 'max-width:640px;margin:22px auto 0' }, chat.el));
  return {
    el,
    update() {
      const r = state.room, g = r.game, you = r.you, o = 1 - you;
      teams.replaceChildren(...[you, o].map((seat) => {
        const spent = g.teams[seat].reduce((n, c) => n + c.price, 0);
        return h('section', { class: 'panel', style: `--pc:${seat === you ? 'var(--you)' : 'var(--opp)'}` },
          h('h2', {}, r.players[seat].name, seat === you ? ' (toi)' : ''),
          h('div', { class: 'muted num' }, `${spent} dépensés · ${g.rubis[seat]} restants`),
          h('div', { class: 'cards5' }, g.teams[seat].map((c) => charCard(c, r.deck.color, c.price))));
      }));
      const v = r.vote;
      const btn = (choice, text) => h('button', { class: 'btn', 'aria-pressed': String(v.mine === ({ me: you, them: o, draw: 'draw' })[choice]), onclick: () => send({ type: 'game.vote', choice }) }, text);
      const parts = [h('h2', {}, 'Qui a la meilleure équipe ?'),
        h('div', { class: 'votes' }, btn('me', 'C\'est moi'), btn('them', r.players[o].name), btn('draw', 'Égalité'))];
      if (v.verdict?.agreed) {
        const res = v.verdict.result;
        parts.push(h('div', { class: `result ${res === 'draw' ? '' : res === you ? 'win' : 'lose'}` },
          res === 'draw' ? 'Égalité, bien joué à tous les deux !' : res === you ? 'Victoire ! 🏆' : `${r.players[o].name} remporte le duel.`));
      } else if (v.verdict) {
        parts.push(h('div', { class: 'result conflict' }, 'Vous n\'êtes pas d\'accord. Discutez, puis votez à nouveau.'));
      } else {
        parts.push(h('p', { class: 'muted' }, v.mine == null ? 'Vote à ton tour, le résultat s\'affichera quand vous aurez tous les deux voté.' : v.oppVoted ? '' : `En attente du vote de ${r.players[o].name}…`));
      }
      parts.push(h('div', { class: 'votes' },
        h('button', { class: 'btn primary', onclick: () => send({ type: 'room.again' }) }, 'Rejouer'),
        h('button', { class: 'btn ghost', onclick: () => send({ type: 'room.leave' }) }, 'Quitter')));
      verdict.replaceChildren(...parts);
      chat.update();
    }
  };
};

// ------------------------------------------------------------------ rendu
const root = document.getElementById('view');
let current = { name: null, view: null };

function pickView() {
  if (state.booting) return 'loading';
  if (!state.me) return 'login';
  if (!state.room) return 'home';
  return { lobby: 'lobby', auction: 'game', done: 'done' }[state.room.phase] || 'home';
}

function render() {
  const name = pickView();
  if (name !== current.name) {
    current = { name, view: views[name]() };
    root.replaceChildren(current.view.el);
    window.scrollTo(0, 0);
  }
  current.view.update();
  updateTop();
}

function updateTop() {
  const brand = document.getElementById('brand');
  if (!brand.firstChild) { brand.append(gem(), h('span', {}, 'Rubis ', h('b', {}, 'Duel'))); brand.firstChild.style.color = 'var(--ruby)'; }
  document.getElementById('offline').hidden = state.connected || state.booting && !state.ws;
  const meEl = document.getElementById('me');
  meEl.hidden = !state.me;
  if (state.me) meEl.replaceChildren(h('span', { class: `dot${state.connected ? ' on' : ''}` }), h('span', { class: 'me-name' }, state.me.name));
}

setInterval(() => { if (current.name === 'game') current.view.tick(); }, 250);
render();
connect();
