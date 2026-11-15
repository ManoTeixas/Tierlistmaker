const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-share-'));
process.env.DATA_DIR = DATA;
const share = require('../share');
const PUBLIC = path.join(__dirname, '..', 'public');

// JPEG mínimo (só os bytes iniciais importam para a validação)
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
const tier = { title: 'Melhores <b>pizzas</b>', names: false, pool: [], tiers: [{ id: 't1', name: 'S', color: '#ff7f7f', items: [{ id: 'x1', name: 'Calabresa', x: 1 }, { id: 'u1', name: 'Foto', u: 1 }] }] };
const lib = { u1: { id: 'u1', name: 'Foto', src: 'data:image/png;base64,iVBORw0KGgo=' } };

let server, base;
before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!(await share.handle(req, res, url, PUBLIC))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;
});
after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

const call = (method, p, body, headers = {}) => fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json', ...headers } : headers, body: body ? JSON.stringify(body) : undefined });

test('cria, lê, atualiza com token e desativa um link de tierlist', async () => {
  let r = await call('POST', '/api/share', { mode: 'tier', cat: 'comida', data: tier, lib, image: JPEG });
  const created = await r.json();
  assert.equal(r.status, 200);
  assert.match(created.id, /^[A-Za-z0-9_-]{11}$/);
  assert.ok(created.token);

  r = await call('GET', '/api/share/' + created.id);
  const got = await r.json();
  assert.equal(got.title, 'Melhores bpizzas/b');   // < e > removidos
  assert.equal(got.n, 2);
  assert.ok(got.photos.u1, 'foto vai junto');
  assert.equal(got.data.tiers[0].items[0].name, 'Calabresa');

  const lite = await (await call('GET', '/api/share/' + created.id + '?lite=1')).json();
  assert.equal(lite.data, undefined);
  assert.equal(lite.photos, undefined);

  r = await call('PUT', '/api/share/' + created.id, { mode: 'tier', cat: 'comida', data: { ...tier, title: 'Nova' }, image: JPEG }, { 'X-Share-Token': 'errado' });
  assert.equal(r.status, 403);
  r = await call('PUT', '/api/share/' + created.id, { mode: 'tier', cat: 'comida', data: { ...tier, title: 'Nova' }, image: JPEG }, { 'X-Share-Token': created.token });
  assert.equal(r.status, 200);
  assert.equal((await (await call('GET', '/api/share/' + created.id)).json()).title, 'Nova');

  r = await fetch(base + '/s/' + created.id + '.img');
  assert.equal(r.headers.get('content-type'), 'image/jpeg');

  r = await call('DELETE', '/api/share/' + created.id, null, { 'X-Share-Token': created.token });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/share/' + created.id)).status, 404);
});

test('página /s/<id> traz título e prévia (Open Graph) com o texto escapado', async () => {
  const { id } = await (await call('POST', '/api/share', { mode: 'tier', data: { ...tier, title: 'Top "5" & cia' }, image: JPEG })).json();
  const html = await (await fetch(base + '/s/' + id)).text();
  assert.match(html, /<title>Top &quot;5&quot; &amp; cia · Tierlist — Escalação<\/title>/);
  assert.match(html, new RegExp(`og:image" content="http://localhost:\\d+/s/${id}\\.img`));
  const missing = await fetch(base + '/s/AAAAAAAAAAA');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /<html/);   // o site abre e mostra "link não encontrado"
});

test('escalação e chaveamento são aceitos e limpos; dados inválidos são recusados', () => {
  const pitch = share.cleanList('futebol', {
    title: 'Seleção', formation: 'f433', template: 'posicoes',
    slots: { f0: { id: 'a', name: 'Goleiro', x: 1 }, zz: { id: 'b', name: 'Intruso', x: 1 } },
    pos: { f0: { x: 50, y: 900 }, f1: { x: 'a', y: 1 } }, labels: { posicoes: { f0: 'Paredão' } }, pool: [],
  });
  assert.deepEqual(Object.keys(pitch.data.slots), ['f0']);
  assert.deepEqual(pitch.data.pos, { f0: { x: 50, y: 100 } });
  assert.equal(pitch.data.labels.posicoes.f0, 'Paredão');

  const br = share.cleanList('bracket', { title: 'Copa', size: 4, entries: [{ id: 'a', name: 'A', x: 1 }, null, { id: 'c', name: 'C', x: 1 }], picks: { '0-0': 0, '0-1': 7, 'x': 1 } });
  assert.equal(br.data.entries.length, 4);
  assert.deepEqual(br.data.picks, { '0-0': 0 });

  assert.throws(() => share.cleanList('tier', { ...tier, tiers: [{ id: 't', name: 'S', items: [] }] }), /pelo menos um item/);
  assert.throws(() => share.cleanList('outro', {}), /desconhecido/);
});

test('imagem precisa ser JPEG ou PNG de verdade', async () => {
  const fake = 'data:image/jpeg;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');
  const r = await call('POST', '/api/share', { mode: 'tier', data: tier, image: fake });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Imagem/);
});
