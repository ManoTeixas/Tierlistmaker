// Copia os dados guardados em arquivos (DATA_DIR, padrão ./data) para o Postgres de DATABASE_URL.
// Uso:  DATABASE_URL=postgres://... node migrate.js
// Pode rodar mais de uma vez: o que já está no banco não é sobrescrito.
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error('Defina DATABASE_URL com o endereço do Postgres de destino.');
  process.exit(1);
}
const db = require('./store');
const files = db.fileStore();

(async () => {
  await db.ready;
  const q = db.query;
  const n = { contas: 0, sessoes: 0, listas: 0, publicacoes: 0, links: 0 };

  const users = await files.allUsers();
  for (const u of users) {
    const r = await q('insert into users (id, email, pass, created) values ($1,$2,$3,$4) on conflict do nothing returning id', [u.id, u.email, u.pass, u.created || Date.now()]);
    n.contas += r.length;
  }
  const uids = new Set((await q('select id from users')).map((r) => r.id));

  for (const [hash, s] of Object.entries(await files.allSessions())) {
    if (s.exp < Date.now() || !uids.has(s.uid)) continue;
    n.sessoes += (await q('insert into sessions (hash, uid, exp) values ($1,$2,$3) on conflict do nothing returning hash', [hash, s.uid, s.exp])).length;
  }

  for (const u of users) {
    const { rev, ...body } = await files.getBlob(u.id);
    if (!rev) continue;
    n.listas += (await q('insert into user_data (uid, rev, body) values ($1,$2,$3) on conflict do nothing returning uid', [u.id, rev, JSON.stringify(body)])).length;
  }

  for (const m of await files.allPosts()) {
    const body = await files.getPostBody(m.id);
    if (!body || !uids.has(m.uid)) continue;
    n.publicacoes += (await q('insert into posts (id, uid, meta, body) values ($1,$2,$3,$4) on conflict do nothing returning id', [m.id, m.uid, JSON.stringify(m), JSON.stringify(body)])).length;
  }

  const sharesDir = path.join(db.DATA_DIR, 'shares');
  for (const f of fs.existsSync(sharesDir) ? fs.readdirSync(sharesDir) : []) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5), rec = await files.getShare(id), img = await files.getShareImg(id);
    if (!rec || !img) continue;
    n.links += (await q('insert into shares (id, rec, img, img_type, updated) values ($1,$2,$3,$4,$5) on conflict do nothing returning id', [id, JSON.stringify(rec), img, rec.imgType, rec.updated || Date.now()])).length;
  }

  console.log(`Copiado de ${db.DATA_DIR} para o Postgres:`, n);
  await db.close();
})().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
