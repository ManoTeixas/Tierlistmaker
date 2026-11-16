// Armazenamento das contas, listas, comunidade e links.
// - Com DATABASE_URL definido: Postgres (Neon, Supabase, Render Postgres…). Precisa do pacote "pg" (npm install).
// - Sem DATABASE_URL: arquivos JSON em DATA_DIR (padrão ./data), sem nada para instalar.
// Todas as funções são assíncronas e têm o mesmo comportamento nos dois modos.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATABASE_URL = process.env.DATABASE_URL || '';

const EMPTY_BLOB = () => ({ rev: 0, projects: [], lib: {}, deleted: {} });

// ======================= Postgres =======================
const SCHEMA = `
create table if not exists users (
  id text primary key,
  email text not null unique,
  pass text not null,
  created bigint not null
);
create table if not exists sessions (
  hash text primary key,
  uid text not null references users(id) on delete cascade,
  exp bigint not null
);
create index if not exists sessions_uid on sessions(uid);
create table if not exists user_data (
  uid text primary key references users(id) on delete cascade,
  rev integer not null,
  body jsonb not null
);
create table if not exists posts (
  id text primary key,
  uid text not null references users(id) on delete cascade,
  meta jsonb not null,
  body jsonb not null
);
create index if not exists posts_uid on posts(uid);
create table if not exists shares (
  id text primary key,
  rec jsonb not null,
  img bytea not null,
  img_type text not null,
  updated bigint not null
);
`;

function pgStore() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch (_) {
    throw new Error('DATABASE_URL está definido, mas o pacote "pg" não está instalado. Rode: npm install');
  }
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX) || 5,
    // Bancos na nuvem exigem SSL; localhost normalmente não.
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) || /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (e) => console.error('Postgres:', e.message));
  const q = (text, params) => pool.query(text, params);
  const ready = q(SCHEMA);
  const run = async (text, params) => { await ready; return (await q(text, params)).rows; };

  return {
    kind: 'postgres',
    ready,
    close: () => pool.end(),
    query: run,   // SQL direto (migração, testes)

    // contas
    allUsers: async () => (await run('select id, email, pass, created::float8 as created from users')),
    putUser: (u) => run('insert into users (id, email, pass, created) values ($1,$2,$3,$4) on conflict (id) do update set email=excluded.email, pass=excluded.pass', [u.id, u.email, u.pass, u.created]),
    delUser: (id) => run('delete from users where id=$1', [id]),   // sessões, listas e publicações vão junto (cascade)

    // sessões
    allSessions: async () => {
      const out = {};
      for (const r of await run('select hash, uid, exp::float8 as exp from sessions where exp > $1', [Date.now()])) out[r.hash] = { uid: r.uid, exp: r.exp };
      return out;
    },
    putSession: (hash, s) => run('insert into sessions (hash, uid, exp) values ($1,$2,$3) on conflict (hash) do update set exp=excluded.exp', [hash, s.uid, s.exp]),
    delSession: (hash) => run('delete from sessions where hash=$1', [hash]),
    delExpiredSessions: (now) => run('delete from sessions where exp < $1', [now]),

    // listas sincronizadas de cada conta
    getBlob: async (uid) => {
      const [r] = await run('select rev, body from user_data where uid=$1', [uid]);
      return r ? { rev: r.rev, ...r.body } : EMPTY_BLOB();
    },
    // Grava só se a versão no banco ainda for baseRev. Retorna false se outro aparelho gravou antes.
    putBlob: async (uid, baseRev, data) => {
      const rows = await run(
        `insert into user_data (uid, rev, body) values ($1, $2 + 1, $3)
         on conflict (uid) do update set rev = excluded.rev, body = excluded.body where user_data.rev = $2
         returning rev`, [uid, baseRev, JSON.stringify(data)]);
      return rows.length > 0;
    },

    // comunidade
    allPosts: async () => (await run('select meta from posts')).map((r) => r.meta),
    putPostMeta: (m) => run('update posts set meta=$2 where id=$1', [m.id, JSON.stringify(m)]),
    putPost: (m, body) => run('insert into posts (id, uid, meta, body) values ($1,$2,$3,$4) on conflict (id) do update set meta=excluded.meta, body=excluded.body', [m.id, m.uid, JSON.stringify(m), JSON.stringify(body)]),
    getPostBody: async (id) => { const [r] = await run('select body from posts where id=$1', [id]); return r ? r.body : null; },
    delPost: (id) => run('delete from posts where id=$1', [id]),

    // links de compartilhamento
    getShare: async (id) => { const [r] = await run('select rec from shares where id=$1', [id]); return r ? r.rec : null; },
    shareExists: async (id) => (await run('select 1 from shares where id=$1', [id])).length > 0,
    getShareImg: async (id) => { const [r] = await run('select img from shares where id=$1', [id]); return r ? r.img : null; },
    putShare: (rec, img) => run('insert into shares (id, rec, img, img_type, updated) values ($1,$2,$3,$4,$5) on conflict (id) do update set rec=excluded.rec, img=excluded.img, img_type=excluded.img_type, updated=excluded.updated', [rec.id, JSON.stringify(rec), img, rec.imgType, rec.updated]),
    delShare: (id) => run('delete from shares where id=$1', [id]),
  };
}

// ======================= Arquivos =======================
// users.json (contas + sessões), blobs/<uid>.json, community.json (índice) + posts/<id>.json,
// shares/<id>.json + shares/<id>.img. Gravação atômica (arquivo temporário + rename) e em fila.
function fileStore() {
  const BLOBS = path.join(DATA_DIR, 'blobs'), POSTS = path.join(DATA_DIR, 'posts'), SHARES = path.join(DATA_DIR, 'shares');
  const USERS_FILE = path.join(DATA_DIR, 'users.json'), INDEX = path.join(DATA_DIR, 'community.json');
  for (const d of [BLOBS, POSTS, SHARES]) fs.mkdirSync(d, { recursive: true });

  const readJsonFile = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } };
  const db = Object.assign({ users: {}, sessions: {} }, readJsonFile(USERS_FILE, {}));
  const index = Object.assign({ posts: {} }, readJsonFile(INDEX, {}));

  let queue = Promise.resolve();
  function writeAtomic(file, data) {
    const p = queue.then(async () => {
      const tmp = file + '.' + process.pid + '.tmp';
      await fs.promises.writeFile(tmp, data, { mode: 0o600 });
      await fs.promises.rename(tmp, file);
    });
    queue = p.catch((e) => console.error('Erro ao gravar', file, e.message));
    return p;
  }
  const saveDb = () => writeAtomic(USERS_FILE, JSON.stringify(db));
  const saveIndex = () => writeAtomic(INDEX, JSON.stringify(index));
  const rm = (f) => fs.promises.rm(f, { force: true });
  const blobFile = (uid) => path.join(BLOBS, uid + '.json');
  const postFile = (id) => path.join(POSTS, id + '.json');
  const shareJson = (id) => path.join(SHARES, id + '.json');
  const shareImg = (id) => path.join(SHARES, id + '.img');

  return {
    kind: 'arquivos',
    ready: Promise.resolve(),
    close: () => queue,

    allUsers: async () => Object.values(db.users),
    putUser: async (u) => { db.users[u.id] = u; await saveDb(); },
    delUser: async (id) => {
      delete db.users[id];
      for (const [h, s] of Object.entries(db.sessions)) if (s.uid === id) delete db.sessions[h];
      await saveDb();
      await rm(blobFile(id));
      for (const m of Object.values(index.posts)) if (m.uid === id) { delete index.posts[m.id]; await rm(postFile(m.id)); }
      await saveIndex();
    },

    allSessions: async () => ({ ...db.sessions }),
    putSession: async (hash, s) => { db.sessions[hash] = s; await saveDb(); },
    delSession: async (hash) => { delete db.sessions[hash]; await saveDb(); },
    delExpiredSessions: async (now) => {
      let n = 0;
      for (const [h, s] of Object.entries(db.sessions)) if (s.exp < now) { delete db.sessions[h]; n++; }
      if (n) await saveDb();
    },

    getBlob: async (uid) => readJsonFile(blobFile(uid), EMPTY_BLOB()),
    putBlob: async (uid, baseRev, data) => {
      const cur = readJsonFile(blobFile(uid), EMPTY_BLOB());
      if (cur.rev !== baseRev) return false;
      await writeAtomic(blobFile(uid), JSON.stringify({ rev: baseRev + 1, ...data }));
      return true;
    },

    allPosts: async () => Object.values(index.posts),
    putPostMeta: async (m) => { index.posts[m.id] = m; await saveIndex(); },
    putPost: async (m, body) => { await writeAtomic(postFile(m.id), JSON.stringify(body)); index.posts[m.id] = m; await saveIndex(); },
    getPostBody: async (id) => readJsonFile(postFile(id), null),
    delPost: async (id) => { delete index.posts[id]; await rm(postFile(id)); await saveIndex(); },

    getShare: async (id) => readJsonFile(shareJson(id), null),
    shareExists: async (id) => fs.existsSync(shareJson(id)),
    getShareImg: async (id) => { try { return await fs.promises.readFile(shareImg(id)); } catch (_) { return null; } },
    putShare: async (rec, img) => { await writeAtomic(shareImg(rec.id), img); await writeAtomic(shareJson(rec.id), JSON.stringify(rec)); },
    delShare: async (id) => { await rm(shareJson(id)); await rm(shareImg(id)); },
  };
}

// Marca qualquer falha do armazenamento como interna: a API responde 500 sem mostrar a mensagem do banco.
function tagErrors(s) {
  for (const [k, fn] of Object.entries(s)) {
    if (typeof fn !== 'function' || k === 'close') continue;
    s[k] = (...a) => fn(...a).catch((e) => { e.internal = true; throw e; });
  }
  return s;
}

const store = tagErrors(DATABASE_URL ? pgStore() : fileStore());
store.where = DATABASE_URL ? 'Postgres' : DATA_DIR;
store.DATA_DIR = DATA_DIR;
store.fileStore = fileStore;   // usado pelo script de migração
module.exports = store;
