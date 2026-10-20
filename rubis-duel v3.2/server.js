'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const miniws = require('./miniws');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
const DECK_DIR = path.join(__dirname, 'decks');

// ---------------------------------------------------------------- règles
const RULES = {
  startRubis: 500, // budget de chaque joueur
  step: 10,        // mise minimale et pas minimum de chaque surenchère
  slots: 5,        // taille d'une équipe
  turnSeconds: 30, // temps pour répondre à une enchère
  soldMs: Number(process.env.SOLD_MS) || 3500 // durée d'affichage de l'adjugé
};
const KI = { name: 'Ki', start: 200, win: 20, loss: 20 }; // classement du mode Bluff uniquement
const MODES = ['classic', 'bluff'];
const MAX_PLAYERS = 4;
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 10000; // déconnexion pendant les enchères : partie annulée après ce délai

// ---------------------------------------------------------------- decks
let DECKS = {};
function loadDecks() {
  const decks = {};
  for (const f of fs.readdirSync(DECK_DIR).filter((x) => x.endsWith('.json')).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(DECK_DIR, f), 'utf8'));
    const files = {};
    try {
      for (const file of fs.readdirSync(path.join(PUBLIC, 'img', d.id))) {
        const m = file.match(/^(.+)\.(webp|png|jpe?g|avif|gif)$/i);
        if (m) files[m[1].toLowerCase()] = file;
      }
    } catch { /* pas encore de dossier d'images */ }
    d.characters = d.characters.map((c) => ({
      id: c.id, name: c.name, tier: c.tier,
      img: files[c.id.toLowerCase()] ? `/img/${d.id}/${files[c.id.toLowerCase()]}` : null
    }));
    decks[d.id] = d;
  }
  return decks;
}
DECKS = loadDecks();
const deckInfo = (id) => {
  const d = DECKS[id];
  return d && { id: d.id, name: d.name, tagline: d.tagline, color: d.color, count: d.characters.length };
};

// ---------------------------------------------------------------- utilisateurs
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { users = {}; }
const byToken = new Map();
const byCode = new Map();
for (const u of Object.values(users)) { byToken.set(u.token, u); byCode.set(u.code, u); u.roomCode = null; if (typeof u.ki !== 'number') u.ki = KI.start; }

let saveTimer = null;
function saveUsers() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = USERS_FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(users, (k, v) => (k === 'leaveTimer' ? undefined : v))); fs.renameSync(tmp, USERS_FILE); } catch (e) { console.error('save', e.message); }
  }, 500);
}

const rnd = (alphabet, n) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

function createUser(name) {
  let id; do { id = rnd('abcdefghijklmnopqrstuvwxyz0123456789', 10); } while (users[id]);
  let code; do { code = rnd(CODE_ALPHA, 6); } while (byCode.has(code));
  const u = { id, token: crypto.randomBytes(24).toString('hex'), name, code, ki: KI.start, friends: [], incoming: [], outgoing: [], roomCode: null };
  users[id] = u; byToken.set(u.token, u); byCode.set(code, u);
  saveUsers();
  return u;
}

// ---------------------------------------------------------------- sockets
const sockets = new Map(); // userId -> Set<ws>
const isOnline = (id) => (sockets.get(id)?.size || 0) > 0;
const send = (ws, type, payload = {}) => ws.send(JSON.stringify({ type, ...payload }));
const sendUser = (id, type, payload) => { for (const ws of sockets.get(id) || []) send(ws, type, payload); };

// ---------------------------------------------------------------- amis
function friendsView(u) {
  const friend = (id) => {
    const f = users[id];
    const r = f.roomCode && rooms.get(f.roomCode);
    return {
      id: f.id, name: f.name, ki: f.ki, online: isOnline(f.id),
      joinable: r && r.phase === 'lobby' && r.seats.length < MAX_PLAYERS ? r.code : null,
      inGame: !!(r && r.phase !== 'lobby')
    };
  };
  const mini = (id) => ({ id, name: users[id].name });
  return {
    friends: u.friends.filter((i) => users[i]).map(friend)
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    incoming: u.incoming.filter((i) => users[i]).map(mini),
    outgoing: u.outgoing.filter((i) => users[i]).map(mini)
  };
}
const pushFriends = (id) => { if (users[id] && isOnline(id)) sendUser(id, 'friends', friendsView(users[id])); };
const pushFriendsAround = (id) => { for (const f of users[id]?.friends || []) pushFriends(f); };
const dropFrom = (arr, id) => { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); };

function friendAction(u, msg, ws) {
  const err = (m) => send(ws, 'error', { message: m });
  if (msg.type === 'friend.add') {
    const t = byCode.get(String(msg.code || '').trim().toUpperCase());
    if (!t) return err('Aucun joueur avec ce code ami.');
    if (t.id === u.id) return err('C\'est ton propre code !');
    if (u.friends.includes(t.id)) return err(`${t.name} est déjà dans tes amis.`);
    if (u.outgoing.includes(t.id)) return err('Demande déjà envoyée.');
    if (u.incoming.includes(t.id)) { acceptFriend(u, t); return; }
    u.outgoing.push(t.id); t.incoming.push(u.id);
    saveUsers(); pushFriends(u.id); pushFriends(t.id);
    sendUser(t.id, 'toast', { message: `${u.name} t'a envoyé une demande d'ami.` });
    send(ws, 'toast', { message: `Demande envoyée à ${t.name}.` });
  } else if (msg.type === 'friend.accept') {
    const t = users[msg.id];
    if (t && u.incoming.includes(t.id)) acceptFriend(u, t);
  } else if (msg.type === 'friend.decline') {
    const t = users[msg.id];
    if (!t) return;
    dropFrom(u.incoming, t.id); dropFrom(t.outgoing, u.id); dropFrom(u.outgoing, t.id); dropFrom(t.incoming, u.id);
    saveUsers(); pushFriends(u.id); pushFriends(t.id);
  } else if (msg.type === 'friend.remove') {
    const t = users[msg.id];
    if (!t) return;
    dropFrom(u.friends, t.id); dropFrom(t.friends, u.id);
    saveUsers(); pushFriends(u.id); pushFriends(t.id);
  }
}
function acceptFriend(u, t) {
  for (const [a, b] of [[u, t], [t, u]]) {
    dropFrom(a.incoming, b.id); dropFrom(a.outgoing, b.id);
    if (!a.friends.includes(b.id)) a.friends.push(b.id);
  }
  saveUsers(); pushFriends(u.id); pushFriends(t.id);
  sendUser(t.id, 'toast', { message: `${u.name} est maintenant ton ami !` });
  sendUser(u.id, 'toast', { message: `${t.name} est maintenant ton ami !` });
}

// ---------------------------------------------------------------- salons
const rooms = new Map();
const SLOTS = RULES.slots, STEP = RULES.step;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const maxBid = (g, seat) => g.rubis[seat] - STEP * (SLOTS - g.teams[seat].length - 1);

// Majorité stricte des votes (un joueur, ou 'draw'). Avec 2 joueurs : il faut être d'accord.
function majority(votes, n) {
  const count = new Map();
  for (const x of votes) if (x !== null && x !== undefined) count.set(x, (count.get(x) || 0) + 1);
  for (const [x, c] of count) if (c * 2 > n) return x;
  return undefined;
}

function roomView(room, uid) {
  const g = room.game;
  const you = room.seats.findIndex((s) => s.id === uid);
  const v = room.votes;
  const n = room.seats.length;
  const allVoted = room.phase === 'done' && v.length === n && v.every((x) => x !== null);
  const maj = room.phase === 'done' ? majority(v, n) : undefined; // dès qu'un choix a la majorité absolue
  // Mode Bluff : seul le joueur qui ouvre voit la carte, jusqu'à l'adjugé. L'autre ne la reçoit jamais.
  const hidden = !!(g && room.mode === 'bluff' && !g.sold && g.current && you !== g.opener);
  return {
    code: room.code,
    mode: room.mode,
    deck: deckInfo(room.deck),
    phase: room.phase,
    you,
    hostId: room.seats[0]?.id,
    players: room.seats.map((s) => ({ id: s.id, name: users[s.id].name, ki: users[s.id].ki, ready: s.ready, online: isOnline(s.id) })),
    game: g && {
      round: g.round, rubis: g.rubis, teams: g.teams, current: hidden ? null : g.current, hidden, high: g.high, turn: g.turn,
      opener: g.opener, deadline: g.deadline, sold: g.sold, trail: g.trail, poolLeft: g.pool.length,
      active: g.active, maxBid: g.rubis.map((_, i) => maxBid(g, i)), serverNow: Date.now()
    },
    vote: room.phase === 'done' ? {
      mine: you >= 0 ? v[you] : null,
      voted: room.seats.map((_, i) => v[i] !== null && v[i] !== undefined),
      verdict: maj !== undefined ? { agreed: true, result: maj } : allVoted ? { agreed: false } : null,
      ki: room.kiApplied
    } : null,
    chat: room.chat.slice(-40),
    rules: RULES
  };
}

function broadcastRoom(room) {
  for (const s of room.seats) sendUser(s.id, 'room', { room: roomView(room, s.id) });
  for (const s of room.seats) pushFriendsAround(s.id);
}

function newRoom(hostId, deck, mode = 'classic') {
  let code; do { code = rnd(CODE_ALPHA, 5); } while (rooms.has(code));
  const room = { code, deck, mode, kiApplied: null, phase: 'lobby', seats: [{ id: hostId, ready: true }], game: null, votes: [null, null], chat: [], timer: null };
  rooms.set(code, room);
  users[hostId].roomCode = code;
  return room;
}

function joinRoom(room, uid) {
  if (!room.seats.some((s) => s.id === uid)) room.seats.push({ id: uid, ready: false });
  users[uid].roomCode = room.code;
}

function leaveRoom(uid, notify = true, reason = 'a quitté') {
  const u = users[uid];
  const room = u && u.roomCode && rooms.get(u.roomCode);
  if (!u) return;
  u.roomCode = null;
  if (!room) { sendUser(uid, 'room', { room: null }); return; }
  const i = room.seats.findIndex((s) => s.id === uid);
  if (i >= 0) room.seats.splice(i, 1);
  clearTimeout(room.timer);
  if (room.phase !== 'lobby') {
    room.phase = 'lobby'; room.game = null; room.votes = [null, null]; room.kiApplied = null;
    room.seats.forEach((s) => { s.ready = false; });
    if (room.seats[0]) { room.seats[0].ready = true; sendUser(room.seats[0].id, 'toast', { message: reason === 'déconnecté' ? `${u.name} s'est déconnecté : la partie est annulée.` : `${u.name} a quitté la partie.` }); }
  } else if (room.seats[0]) {
    room.seats[0].ready = true; room.seats.forEach((s, k) => { if (k) s.ready = false; });
    sendUser(room.seats[0].id, 'toast', { message: `${u.name} a quitté le salon.` });
  }
  if (!room.seats.length) rooms.delete(room.code);
  else broadcastRoom(room);
  if (notify) { sendUser(uid, 'room', { room: null }); pushFriendsAround(uid); pushFriends(uid); }
}

// --- Ki (mode Bluff) : +20 au vainqueur, -20 à chaque autre joueur, jamais sous 0
function applyKi(room, winner) {
  const us = room.seats.map((st) => users[st.id]);
  const before = us.map((u) => u.ki);
  us.forEach((u, i) => { u.ki = i === winner ? u.ki + KI.win : Math.max(0, u.ki - KI.loss); });
  room.kiApplied = { winner, before, after: us.map((u) => u.ki) };
  saveUsers();
  for (const u of us) { sendUser(u.id, 'me', { me: meView(u) }); pushFriendsAround(u.id); }
}

// --- déroulement des enchères
function startGame(room) {
  DECKS = loadDecks();
  const deck = DECKS[room.deck];
  const n = room.seats.length;
  room.phase = 'auction';
  room.votes = Array(n).fill(null); room.kiApplied = null;
  room.game = {
    pool: shuffle([...deck.characters]), round: 0, rubis: Array(n).fill(RULES.startRubis),
    teams: Array.from({ length: n }, () => []), current: null, high: null, turn: null, opener: crypto.randomInt(n),
    active: [], deadline: null, sold: null, trail: []
  };
  nextRound(room);
}

// Prochain siège (dans le sens des aiguilles d'une montre) qui vérifie pred ; peut renvoyer `from` si c'est le seul.
function nextSeat(g, from, pred) {
  const n = g.rubis.length;
  for (let k = 1; k <= n; k++) { const i = (from + k) % n; if (pred(i)) return i; }
  return -1;
}

function nextRound(room) {
  const g = room.game;
  clearTimeout(room.timer);
  g.sold = null; g.high = null; g.trail = []; g.active = [];
  const open = g.teams.map((t, i) => i).filter((i) => g.teams[i].length < SLOTS); // joueurs qui ont encore une place
  if (!open.length) {
    room.phase = 'done'; g.current = null; g.turn = null; g.deadline = null;
    return broadcastRoom(room);
  }
  g.round++;
  g.current = g.pool.pop();
  if (g.round > 1) g.opener = nextSeat(g, g.opener, (i) => open.includes(i));
  if (open.length === 1) return sell(room, open[0], STEP, true); // un seul acheteur possible : prix d'ouverture
  g.active = open;
  g.turn = g.opener;
  armTimer(room);
  broadcastRoom(room);
}

function armTimer(room) {
  const g = room.game;
  clearTimeout(room.timer);
  g.deadline = Date.now() + RULES.turnSeconds * 1000;
  room.timer = setTimeout(() => {
    if (room.phase !== 'auction' || g.turn === null) return;
    if (!g.high) doBid(room, g.turn, STEP); else doPass(room, g.turn);
  }, RULES.turnSeconds * 1000 + 300);
}

function sell(room, winner, price, auto = false) {
  const g = room.game;
  clearTimeout(room.timer);
  g.rubis[winner] -= price;
  g.teams[winner].push({ ...g.current, price });
  g.sold = { char: g.current, winner, price, auto };
  g.turn = null; g.deadline = null; g.high = null;
  room.timer = setTimeout(() => nextRound(room), RULES.soldMs);
  broadcastRoom(room);
}

// Passe la main au prochain joueur encore en lice et capable de surenchérir ; les autres sont retirés d'office.
function advance(room, from) {
  const g = room.game;
  for (;;) {
    if (g.active.length === 1) return sell(room, g.high.by, g.high.amount);
    const nx = nextSeat(g, from, (i) => g.active.includes(i));
    if (nx === g.high.by) return sell(room, g.high.by, g.high.amount);
    if (maxBid(g, nx) < g.high.amount + STEP) {
      g.active = g.active.filter((i) => i !== nx);
      g.trail.push({ seat: nx, amount: null });
      from = nx;
      continue;
    }
    g.turn = nx;
    armTimer(room);
    return broadcastRoom(room);
  }
}

function doBid(room, seat, amount) {
  const g = room.game;
  if (room.phase !== 'auction' || g.sold || g.turn !== seat) return 'Ce n\'est pas ton tour.';
  amount = Math.floor(Number(amount));
  const min = g.high ? g.high.amount + STEP : STEP;
  if (!Number.isFinite(amount) || amount < min) return `Mise minimale : ${min} rubis.`;
  if (amount > maxBid(g, seat)) return `Mise maximale : ${maxBid(g, seat)} rubis (il faut garder ${STEP} rubis par place restante).`;
  g.high = { amount, by: seat };
  g.trail.push({ seat, amount });
  advance(room, seat);
  return null;
}

function doPass(room, seat) {
  const g = room.game;
  if (room.phase !== 'auction' || g.sold || g.turn !== seat) return 'Ce n\'est pas ton tour.';
  if (!g.high) return 'Tu dois ouvrir les enchères (10 rubis minimum).';
  g.trail.push({ seat, amount: null });
  g.active = g.active.filter((i) => i !== seat);
  advance(room, seat);
  return null;
}

// ---------------------------------------------------------------- messages
function handle(ws, msg) {
  if (msg.type === 'ping') return send(ws, 'pong');
  if (msg.type === 'hello') return hello(ws, msg);
  const u = ws.userId && users[ws.userId];
  if (!u) return send(ws, 'need-login');
  const err = (m) => send(ws, 'error', { message: m });
  const room = u.roomCode ? rooms.get(u.roomCode) : null;
  const seat = room ? room.seats.findIndex((s) => s.id === u.id) : -1;

  switch (msg.type) {
    case 'name': {
      const n = cleanName(msg.name);
      if (n.length < 2) return err('Le pseudo doit faire au moins 2 caractères.');
      u.name = n; saveUsers();
      sendUser(u.id, 'me', { me: meView(u) });
      pushFriendsAround(u.id);
      if (room) broadcastRoom(room);
      return;
    }
    case 'room.create': {
      if (!DECKS[msg.deck]) return err('Deck inconnu.');
      if (room) leaveRoom(u.id, false);
      const r = newRoom(u.id, msg.deck, MODES.includes(msg.mode) ? msg.mode : 'classic');
      return broadcastRoom(r);
    }
    case 'room.join': {
      const r = rooms.get(String(msg.code || '').trim().toUpperCase());
      if (!r) return err('Ce salon n\'existe plus ou le code est incorrect.');
      if (r.seats.some((s) => s.id === u.id)) return broadcastRoom(r);
      if (r.phase !== 'lobby') return err('Une partie est déjà en cours dans ce salon.');
      if (r.seats.length >= MAX_PLAYERS) return err('Ce salon est complet.');
      if (room) leaveRoom(u.id, false);
      joinRoom(r, u.id);
      sendUser(r.seats[0].id, 'toast', { message: `${u.name} a rejoint le salon.` });
      return broadcastRoom(r);
    }
    case 'room.leave': return leaveRoom(u.id);
    case 'room.sync': return sendUser(u.id, 'room', { room: room ? roomView(room, u.id) : null });
    case 'room.deck': {
      if (!room || room.phase !== 'lobby' || seat !== 0 || !DECKS[msg.deck]) return;
      room.deck = msg.deck; room.seats.forEach((s, i) => { s.ready = i === 0; });
      return broadcastRoom(room);
    }
    case 'room.mode': {
      if (!room || room.phase !== 'lobby' || seat !== 0 || !MODES.includes(msg.mode)) return;
      room.mode = msg.mode; room.seats.forEach((s, i) => { s.ready = i === 0; });
      return broadcastRoom(room);
    }
    case 'room.ready': {
      if (!room || room.phase !== 'lobby' || seat < 1) return;
      room.seats[seat].ready = !!msg.ready; return broadcastRoom(room);
    }
    case 'room.invite': {
      const f = users[msg.id];
      if (!room || room.phase !== 'lobby' || !f || !u.friends.includes(f.id)) return;
      if (!isOnline(f.id)) return err(`${f.name} n'est pas en ligne.`);
      sendUser(f.id, 'invite', { from: u.name, code: room.code, deck: deckInfo(room.deck)?.name });
      return send(ws, 'toast', { message: `Invitation envoyée à ${f.name}.` });
    }
    case 'room.start': {
      if (!room || room.phase !== 'lobby' || seat !== 0) return;
      if (room.seats.length < 2) return err('Il faut au moins deux joueurs.');
      if (room.seats.some((st, i) => i && !st.ready)) return err('Tous les joueurs doivent être prêts.');
      if (!DECKS[room.deck] || DECKS[room.deck].characters.length < SLOTS * room.seats.length) return err('Ce deck est trop petit pour cette partie.');
      return startGame(room);
    }
    case 'game.bid': { if (!room || seat < 0) return; const e = doBid(room, seat, msg.amount); if (e) err(e); return; }
    case 'game.pass': { if (!room || seat < 0) return; const e = doPass(room, seat); if (e) err(e); return; }
    case 'game.vote': {
      if (!room || room.phase !== 'done' || seat < 0) return;
      const n = room.seats.length;
      let val = msg.choice;
      if (val === 'me') val = seat;
      else if (val === 'them' && n === 2) val = 1 - seat; // anciens clients
      if (val !== 'draw' && !(Number.isInteger(val) && val >= 0 && val < n)) return;
      if (room.kiApplied) return; // résultat classé : les votes sont verrouillés
      room.votes[seat] = val;
      if (room.mode === 'bluff') {
        const maj = majority(room.votes, n);
        if (typeof maj === 'number') applyKi(room, maj);
      }
      return broadcastRoom(room);
    }
    case 'room.again': {
      if (!room || room.phase !== 'done') return;
      clearTimeout(room.timer);
      room.phase = 'lobby'; room.game = null; room.votes = [null, null]; room.kiApplied = null;
      room.seats.forEach((s, i) => { s.ready = i === 0; });
      return broadcastRoom(room);
    }
    case 'chat': {
      const text = String(msg.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140);
      if (!room || seat < 0 || !text) return;
      room.chat.push({ seat, text, t: Date.now() });
      if (room.chat.length > 80) room.chat.shift();
      return broadcastRoom(room);
    }
    default:
      if (msg.type?.startsWith('friend.')) return friendAction(u, msg, ws);
  }
}

const meView = (u) => ({ id: u.id, name: u.name, code: u.code, ki: u.ki });

function hello(ws, msg) {
  let u = msg.token && byToken.get(String(msg.token));
  if (!u) {
    const n = cleanName(msg.name);
    if (n.length < 2) return send(ws, 'need-login');
    u = createUser(n);
  }
  ws.userId = u.id;
  if (!sockets.has(u.id)) sockets.set(u.id, new Set());
  sockets.get(u.id).add(ws);
  clearTimeout(u.leaveTimer);
  send(ws, 'welcome', { me: meView(u), token: u.token, decks: Object.values(DECKS).map((d) => deckInfo(d.id)), rules: RULES, ki: KI });
  send(ws, 'friends', friendsView(u));
  const room = u.roomCode && rooms.get(u.roomCode);
  if (u.roomCode && !room) u.roomCode = null;
  send(ws, 'room', { room: room ? roomView(room, u.id) : null });
  if (room) broadcastRoom(room);
  pushFriendsAround(u.id);
}

function onClose(ws) {
  const id = ws.userId;
  if (!id) return;
  const set = sockets.get(id);
  set?.delete(ws);
  if (set && set.size) return;
  sockets.delete(id);
  const u = users[id];
  pushFriendsAround(id);
  const room = u.roomCode && rooms.get(u.roomCode);
  if (room) {
    broadcastRoom(room);
    // Pendant les enchères, une déconnexion annule la partie après un court délai
    // (laisse le temps d'actualiser la page ou de traverser un trou de réseau).
    // Hors enchères, on libère la place plus tard.
    const delay = room.phase === 'auction' ? DISCONNECT_GRACE_MS : room.phase === 'lobby' ? 45000 : 2 * 60000;
    u.leaveTimer = setTimeout(() => { if (!isOnline(id)) leaveRoom(id, false, 'déconnecté'); }, delay);
  }
}

// ---------------------------------------------------------------- HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (p === '/' || p.startsWith('/r/')) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/img/') ? 'public, max-age=3600' : 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
});

miniws.attach(server, '/ws', (ws) => {
  let tokens = 20, last = Date.now();
  ws.on('message', (raw) => {
    const now = Date.now();
    tokens = Math.min(20, tokens + (now - last) / 100); last = now; // 10 messages/s en régime continu, rafale de 20
    if (tokens < 1) return; // anti-spam
    tokens -= 1;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try { handle(ws, msg); } catch (e) { console.error('handle', e); }
  });
  ws.on('close', () => onClose(ws));
});

// Détecte les connexions mortes (les proxys coupent les sockets silencieuses)
setInterval(() => {
  for (const set of sockets.values()) for (const ws of set) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 25000);

// Nettoie les salons abandonnés
setInterval(() => {
  for (const [code, r] of rooms) if (!r.seats.some((s) => isOnline(s.id))) {
    r.idle = (r.idle || 0) + 1;
    if (r.idle > 20) { clearTimeout(r.timer); for (const s of r.seats) users[s.id].roomCode = null; rooms.delete(code); }
  } else r.idle = 0;
}, 60000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Rubis Duel sur http://localhost:${PORT}`));
}
module.exports = { server };
