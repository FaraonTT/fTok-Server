// fTok-Server 1.1 — сервер для приложения fTok (fOS Simulator). Node 22+, без зависимостей.
// Хранилище (видео, индекс, аккаунты) — ветка `storage` GitHub-репозитория GH_REPO.
// Секрет только в переменной GH_TOKEN. Рекомендуется ПРИВАТНЫЙ репозиторий данных (GH_REPO).
import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GH_REPO || 'FaraonTT/fTok-Server';
const BRANCH = process.env.GH_BRANCH || 'storage';
const PORT = Number(process.env.PORT || 8080);
const MAX = 50 * 1024 * 1024;
if (!TOKEN) { console.error('GH_TOKEN не задан'); process.exit(1); }
const SIGN = createHmac('sha256', 'ftok-session').update(TOKEN).digest(); // ключ подписи сессий выводится из GH_TOKEN

const API = `https://api.github.com/repos/${REPO}`;
const gh = (path, init = {}) => fetch(API + path, {
  ...init,
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'fTok-Server', ...(init.headers || {}) },
});

// ---------- простое JSON-хранилище в ветке storage ----------
class Doc {
  constructor(path, empty) { this.path = path; this.data = empty(); this.empty = empty; this.sha = null; this.dirty = false; this.q = Promise.resolve(); }
  async load() {
    const r = await gh(`/contents/${this.path}?ref=${BRANCH}`);
    if (r.status === 404) return;
    const j = await r.json();
    this.sha = j.sha;
    this.data = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  }
  save() { // сохранения выстраиваются в очередь, чтобы не конфликтовал sha
    this.q = this.q.then(async () => {
      const body = { message: this.path, branch: BRANCH, content: Buffer.from(JSON.stringify(this.data)).toString('base64') };
      if (this.sha) body.sha = this.sha;
      const r = await gh(`/contents/${this.path}`, { method: 'PUT', body: JSON.stringify(body) });
      if (!r.ok) throw new Error(this.path + ': ' + await r.text());
      this.sha = (await r.json()).content.sha;
    });
    return this.q;
  }
}
const index = new Doc('index.json', () => ({ videos: [] }));
const users = new Doc('users.json', () => ({}));

async function ensureBranch() {
  if ((await gh(`/git/ref/heads/${BRANCH}`)).ok) return;
  const repo = await (await gh('')).json();
  const base = await (await gh(`/git/ref/heads/${repo.default_branch}`)).json();
  const c = await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: base.object.sha }) });
  if (!c.ok) throw new Error('не удалось создать ветку ' + BRANCH + ': ' + await c.text());
}

// лайки сохраняются пачкой раз в 10 с
setInterval(() => { if (index.dirty) { index.dirty = false; index.save().catch(e => { index.dirty = true; console.error(e.message); }); } }, 10000);

// ---------- аккаунты и сессии ----------
const hashPw = (pw, salt) => scryptSync(pw, salt, 32);
const b64u = b => Buffer.from(b).toString('base64url');
function makeToken(user) {
  const p = b64u(JSON.stringify({ u: user, e: Date.now() + 30 * 864e5 }));
  return p + '.' + createHmac('sha256', SIGN).update(p).digest('base64url');
}
function authUser(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const [p, sig] = t.split('.');
  if (!p || !sig) return null;
  const ok = createHmac('sha256', SIGN).update(p).digest('base64url');
  if (sig.length !== ok.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > Date.now() && users.data[o.u.toLowerCase()] ? users.data[o.u.toLowerCase()].user : null; } catch { return null; }
}
const hits = new Map(); // грубое ограничение попыток входа: 20 в минуту с IP
setInterval(() => hits.clear(), 60000);
const tooMany = ip => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 20; };

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };

async function readBody(req, limit = MAX) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error('too large'), { code: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (u.pathname === '/health') return json(res, 200, { ok: true, videos: index.data.videos.length });

    if ((u.pathname === '/api/register' || u.pathname === '/api/login') && req.method === 'POST') {
      if (tooMany(ip)) return json(res, 429, { error: 'too many attempts' });
      let b; try { b = JSON.parse((await readBody(req, 4096)).toString()); } catch { return json(res, 400, { error: 'bad json' }); }
      const name = String(b.user || ''), pw = String(b.password || '');
      if (u.pathname === '/api/register') {
        if (!/^[A-Za-z0-9_]{3,24}$/.test(name)) return json(res, 400, { error: 'Имя: 3–24 символа, буквы/цифры/_' });
        if (pw.length < 6 || pw.length > 128) return json(res, 400, { error: 'Пароль: от 6 символов' });
        if (users.data[name.toLowerCase()]) return json(res, 409, { error: 'Имя уже занято' });
        const salt = randomBytes(16);
        users.data[name.toLowerCase()] = { user: name, salt: salt.toString('hex'), hash: hashPw(pw, salt).toString('hex'), created: Date.now() };
        await users.save();
        return json(res, 201, { user: name, token: makeToken(name) });
      }
      const rec = users.data[name.toLowerCase()];
      const salt = rec ? Buffer.from(rec.salt, 'hex') : randomBytes(16);
      const h = hashPw(pw, salt);
      if (!rec || !timingSafeEqual(h, Buffer.from(rec.hash, 'hex'))) return json(res, 401, { error: 'Неверное имя или пароль' });
      return json(res, 200, { user: rec.user, token: makeToken(rec.user) });
    }

    if (u.pathname === '/api/videos' && req.method === 'GET') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const user = (u.searchParams.get('user') || '').toLowerCase();
      const limit = Math.min(Number(u.searchParams.get('limit') || 50), 100);
      const list = index.data.videos
        .filter(v => (!user || v.user.toLowerCase() === user) && (!q || v.title.toLowerCase().includes(q) || v.user.toLowerCase().includes(q)))
        .sort((a, b) => b.created - a.created).slice(0, limit)
        .map(({ by, ...v }) => v);
      return json(res, 200, { videos: list });
    }

    if (u.pathname === '/api/videos' && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return json(res, 401, { error: 'Нужно войти в аккаунт' });
      const data = await readBody(req);
      if (data.length < 1024) return json(res, 400, { error: 'empty file' });
      const id = randomBytes(6).toString('hex');
      const put = await gh(`/contents/videos/${id}.mp4`, { method: 'PUT',
        body: JSON.stringify({ message: 'video ' + id, branch: BRANCH, content: data.toString('base64') }) });
      if (!put.ok) return json(res, 502, { error: 'github: ' + (await put.text()).slice(0, 200) });
      index.data.videos.push({ id, user, title: (u.searchParams.get('title') || '').slice(0, 120), likes: 0, by: [], created: Date.now() });
      await index.save();
      return json(res, 201, { id });
    }

    let m = u.pathname.match(/^\/api\/videos\/(\w+)\/like$/);
    if (m && req.method === 'POST') {
      const user = authUser(req);
      if (!user) return json(res, 401, { error: 'Нужно войти в аккаунт' });
      const v = index.data.videos.find(x => x.id === m[1]);
      if (!v) return json(res, 404, { error: 'not found' });
      v.by ||= [];
      if (!v.by.includes(user)) { v.by.push(user); v.likes = v.by.length; index.dirty = true; }
      return json(res, 200, { likes: v.likes });
    }

    m = u.pathname.match(/^\/v\/(\w+)$/);
    if (m && req.method === 'GET') {
      if (!index.data.videos.some(x => x.id === m[1])) return json(res, 404, { error: 'not found' });
      const up = await gh(`/contents/videos/${m[1]}.mp4?ref=${BRANCH}`, { headers: { Accept: 'application/vnd.github.raw' } });
      if (!up.ok) return json(res, 502, { error: 'upstream ' + up.status });
      const buf = Buffer.from(await up.arrayBuffer());
      let start = 0, end = buf.length - 1, code = 200;
      const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', ...cors };
      const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (r) { start = r[1] ? Number(r[1]) : 0; end = r[2] ? Math.min(Number(r[2]), end) : end; code = 206; h['Content-Range'] = `bytes ${start}-${end}/${buf.length}`; }
      h['Content-Length'] = end - start + 1;
      res.writeHead(code, h);
      return res.end(buf.subarray(start, end + 1));
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.code === 413 ? 413 : 500, { error: String(e.message || e) });
  }
});

await ensureBranch();
await Promise.all([index.load(), users.load()]);
server.listen(PORT, () => console.log(`fTok-Server на :${PORT}, репо ${REPO}@${BRANCH}, видео: ${index.data.videos.length}, пользователей: ${Object.keys(users.data).length}`));
