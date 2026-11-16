// Contas, sincronização e comunidade pela API, usando o armazenamento configurado:
// arquivos numa pasta temporária, ou Postgres se TEST_DATABASE_URL estiver definido
// (use um banco vazio só para testes: as tabelas são apagadas no fim).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'esc-accounts-'));
process.env.DATA_DIR = DATA;
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else delete process.env.DATABASE_URL;

const store = require('../store');
const auth = require('../auth');
const community = require('../community');

let server, base;
before(async () => {
  await Promise.all([auth.ready, community.ready]);
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await auth.handle(req, res, url)) return;
    if (await community.handle(req, res, url)) return;
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;
});
after(async () => {
  server.close();
  if (store.kind === 'postgres') await store.query('drop table if exists shares, posts, user_data, sessions, users');
  await store.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

// "navegador" simples que guarda o cookie da sessão
function browser() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
}

const tier = { title: 'Pizzas', names: false, pool: [], tiers: [{ id: 't1', name: 'S', color: '#ff7f7f', items: [{ id: 'x1', name: 'Calabresa', x: 1 }] }] };
const project = (id, title) => ({ id, mode: 'tier', updated: Date.now(), data: { ...tier, title } });

test(`conta, sincronização, comunidade e exclusão (${store.kind})`, async () => {
  const a = browser(), b = browser();
  const email = 'ana' + Date.now() + '@exemplo.com';

  let r = await a('POST', '/api/auth/register', { email, password: 'senha-forte-123' });
  assert.equal(r.status, 200);
  assert.equal((await a('GET', '/api/auth/me')).body.user.email, email);
  assert.equal((await b('POST', '/api/auth/register', { email, password: 'outra-senha-1' })).status, 409);
  assert.equal((await b('POST', '/api/auth/login', { email, password: 'errada-errada' })).status, 401);
  assert.equal((await b('POST', '/api/auth/login', { email, password: 'senha-forte-123' })).status, 200);

  // sincronização com controle de versão
  r = await a('GET', '/api/sync');
  assert.equal(r.body.rev, 0);
  r = await a('PUT', '/api/sync', { baseRev: 0, projects: [project('p1', 'Pizzas')], lib: {}, deleted: {} });
  assert.deepEqual(r, { status: 200, body: { rev: 1 } });
  r = await b('PUT', '/api/sync', { baseRev: 0, projects: [], lib: {}, deleted: {} });   // aparelho desatualizado
  assert.equal(r.status, 409);
  assert.equal(r.body.rev, 1);
  assert.equal(r.body.projects[0].data.title, 'Pizzas');
  r = await b('PUT', '/api/sync', { baseRev: 1, projects: [project('p1', 'Pizzas 2')], lib: {}, deleted: {} });
  assert.equal(r.body.rev, 2);
  assert.equal((await a('GET', '/api/sync')).body.projects[0].data.title, 'Pizzas 2');

  // comunidade
  r = await a('POST', '/api/community', { pid: 'p1', author: 'Ana', category: 'Comida', data: tier, lib: {} });
  assert.equal(r.status, 200);
  const postId = r.body.id;
  r = await a('POST', '/api/community', { pid: 'p1', author: 'Ana', category: 'comida', data: { ...tier, title: 'Pizzas!' }, lib: {} });
  assert.equal(r.body.id, postId, 'publicar de novo atualiza a mesma publicação');
  r = await b('GET', '/api/community/' + postId);
  assert.equal(r.body.title, 'Pizzas!');
  assert.equal(r.body.data.tiers[0].items[0].name, 'Calabresa');

  // os dados sobrevivem a um "reinício": lidos direto do armazenamento
  assert.ok((await store.allUsers()).some((u) => u.email === email));
  assert.ok((await store.allPosts()).some((m) => m.id === postId && m.title === 'Pizzas!'));
  assert.equal(Object.values(await store.allSessions()).length >= 2, true);

  // sair invalida só aquela sessão
  await b('POST', '/api/auth/logout');
  assert.equal((await b('GET', '/api/auth/me')).body.user, null);
  assert.equal((await a('GET', '/api/auth/me')).body.user.email, email);

  // excluir a conta apaga tudo
  assert.equal((await a('POST', '/api/auth/delete', { password: 'errada-errada' })).status, 401);
  assert.equal((await a('POST', '/api/auth/delete', { password: 'senha-forte-123' })).status, 200);
  assert.equal((await a('GET', '/api/auth/me')).body.user, null);
  assert.equal((await b('GET', '/api/community/' + postId)).status, 404);
  assert.ok(!(await store.allUsers()).some((u) => u.email === email));
  assert.ok(!(await store.allPosts()).some((m) => m.id === postId));
  const uidLeft = Object.values(await store.allSessions()).length;
  assert.equal(uidLeft, 0);
  assert.equal((await b('POST', '/api/auth/login', { email, password: 'senha-forte-123' })).status, 401);
});
