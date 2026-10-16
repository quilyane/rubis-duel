// Test de bout en bout : deux faux joueurs jouent une partie complète contre un vrai serveur.
process.env.PORT = process.env.PORT || '3101';
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/rd-');
const { server } = require('../server');
const assert = require('assert');

function client(name) {
  const c = { name, msgs: [], room: null, friends: null, me: null, token: null };
  c.ws = new WebSocket(`ws://localhost:${process.env.PORT}/ws`);
  c.ready = new Promise((res) => { c.ws.onopen = res; });
  c.ws.onmessage = (e) => {
    const m = JSON.parse(e.data); c.msgs.push(m);
    if (m.type === 'welcome') { c.me = m.me; c.token = m.token; }
    if (m.type === 'room') c.room = m.room;
    if (m.type === 'friends') c.friends = m;
    if (c.onmsg) c.onmsg(m);
  };
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.until = (fn, ms = 4000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => { if (fn()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout ' + name + ' ' + fn)); } }, 20);
  });
  return c;
}

(async () => {
  await new Promise((r) => server.listen(process.env.PORT, r));
  const a = client('Killian'), b = client('Camille');
  await Promise.all([a.ready, b.ready]);
  a.send({ type: 'hello', name: 'Killian' }); b.send({ type: 'hello', name: 'Camille' });
  await Promise.all([a.until(() => a.me), b.until(() => b.me)]);
  console.log('connexion ok, codes ami', a.me.code, b.me.code);

  // amis
  a.send({ type: 'friend.add', code: b.me.code });
  await b.until(() => b.friends?.incoming.length === 1);
  b.send({ type: 'friend.accept', id: a.me.id });
  await a.until(() => a.friends.friends.length === 1 && a.friends.friends[0].online);
  console.log('amis ok');

  // salon
  a.send({ type: 'room.create', deck: 'naruto' });
  await a.until(() => a.room);
  const code = a.room.code;
  await b.until(() => b.friends.friends[0].joinable === code);
  console.log('salon', code, 'visible par l\'ami (joinable)');
  b.send({ type: 'room.join', code });
  await a.until(() => a.room.players.length === 2);
  b.send({ type: 'room.ready', ready: true });
  await a.until(() => a.room.players[1].ready);
  a.send({ type: 'room.start' });
  await a.until(() => a.room.phase === 'auction');

  // partie : stratégie aléatoire côté clients
  const clients = [a, b];
  let sales = 0;
  const act = (c) => {
    const r = c.room; if (!r || r.phase !== 'auction') return;
    const g = r.game; if (g.sold || g.turn !== r.you) return;
    const key = g.round + ':' + (g.high?.amount || 0) + ':' + g.turn;
    if (c.lastKey === key) return; c.lastKey = key;
    const min = g.high ? g.high.amount + 10 : 10, max = g.maxBid[r.you];
    assert(max >= min, 'le joueur actif doit toujours pouvoir miser au moins le minimum');
    if (g.high && Math.random() < 0.45) c.send({ type: 'game.pass' });
    else c.send({ type: 'game.bid', amount: Math.min(max, min + 10 * Math.floor(Math.random() * 4)) });
  };
  for (const c of clients) c.onmsg = (m) => { if (m.type === 'room') { if (m.room.game?.sold) sales++; act(c); } };

  // un mauvais coup doit être refusé
  const bad = clients.find((c) => c.room.game.turn !== c.room.you);
  bad.send({ type: 'game.bid', amount: 10 });
  await bad.until(() => bad.msgs.some((m) => m.type === 'error' && /tour/.test(m.message)));
  console.log('mise hors tour refusée ok');

  act(a); act(b);
  await a.until(() => a.room.phase === 'done', 60000);
  const g = a.room.game;
  assert.deepStrictEqual(g.teams.map((t) => t.length), [5, 5]);
  for (let s = 0; s < 2; s++) {
    const spent = g.teams[s].reduce((n, c) => n + c.price, 0);
    assert.strictEqual(500 - spent, g.rubis[s]); assert(g.rubis[s] >= 0);
    assert(g.teams[s].every((c) => c.price >= 10));
  }
  const ids = g.teams.flat().map((c) => c.id); assert.strictEqual(new Set(ids).size, 10, 'aucun doublon');
  console.log('partie finie', g.teams.map((t) => t.map((c) => `${c.name}(${c.price})`).join(', ')), 'reste', g.rubis);

  // votes : désaccord puis accord
  a.send({ type: 'game.vote', choice: 'me' }); b.send({ type: 'game.vote', choice: 'me' });
  await a.until(() => a.room.vote.verdict && a.room.vote.verdict.agreed === false);
  b.send({ type: 'game.vote', choice: 'them' });
  await a.until(() => a.room.vote.verdict?.agreed === true && a.room.vote.verdict.result === 0);
  console.log('vote ok');

  // reconnexion avec le jeton
  b.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  const b2 = client('Camille2'); await b2.ready; b2.send({ type: 'hello', token: b.token });
  await b2.until(() => b2.room && b2.room.phase === 'done');
  console.log('reconnexion ok, même identité :', b2.me.name);

  // rejouer
  a.send({ type: 'room.again' });
  await a.until(() => a.room.phase === 'lobby');
  console.log('TOUS LES TESTS PASSENT');
  process.exit(0);
})().catch((e) => { console.error('ÉCHEC', e); process.exit(1); });
