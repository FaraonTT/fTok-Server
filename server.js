// fTok-Server — сервер для приложения fTok (fOS Simulator). Node 22+, без зависимостей.
// Хранилище: ветка `storage` этого же GitHub-репозитория. Секрет — только в переменной GH_TOKEN.
import http from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GH_REPO || 'FaraonTT/fTok-Server';
const BRANCH = process.env.GH_BRANCH || 'storage';
const UPLOAD_KEY = process.env.UPLOAD_KEY || '';
const PORT = Number(process.env.PORT || 8080);
const MAX = 50 * 1024 * 1024;
if (!TOKEN) { console.error('GH_TOKEN не задан'); process.exit(1); }

const API = `https://api.github.com/repos/${REPO}`;
const gh = (path, init = {}) => fetch(API + path, {
  ...init,
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'fTok-Server', ...(init.headers || {}) },
});

let index = { videos: [] };
let indexSha = null;
let dirty = false;

async function ensureBranch() {
  const r = await gh(`/git/ref/heads/${BRANCH}`);
  if (r.ok) return;
  const repo = await (await gh('')).json();
  const base = await (await gh(`/git/ref/heads/${repo.default_branch}`)).json();
  const c = await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: base.object.sha }) });
  if (!c.ok) throw new Error('не удалось создать ветку ' + BRANCH + ': ' + await c.text());
}

async function loadIndex() {
  await ensureBranch();
  const r = await gh(`/contents/index.json?ref=${BRANCH}`);
  if (r.status === 404) { index = { videos: [] }; indexSha = null; return; }
  const j = await r.json();
  indexSha = j.sha;
  index = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
}

async function saveIndex() {
  const body = { message: 'index', branch: BRANCH, content: Buffer.from(JSON.stringify(index)).toString('base64') };
  if (indexSha) body.sha = indexSha;
  const r = await gh('/contents/index.json', { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw new Error('index: ' + await r.text());
  indexSha = (await r.json()).content.sha;
}

// лайки сохраняются пачкой раз в 10 с
setInterval(async () => { if (dirty) { dirty = false; try { await saveIndex(); } catch (e) { dirty = true; console.error(e.message); } } }, 10000);

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };

async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX) throw Object.assign(new Error('too large'), { code: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (u.pathname === '/health') return json(res, 200, { ok: true, videos: index.videos.length });

    if (u.pathname === '/api/videos' && req.method === 'GET') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const user = u.searchParams.get('user') || '';
      const limit = Math.min(Number(u.searchParams.get('limit') || 50), 100);
      const list = index.videos
        .filter(v => (!user || v.user === user) && (!q || v.title.toLowerCase().includes(q) || v.user.toLowerCase().includes(q)))
        .sort((a, b) => b.created - a.created).slice(0, limit);
      return json(res, 200, { videos: list });
    }

    if (u.pathname === '/api/videos' && req.method === 'POST') {
      if (UPLOAD_KEY && req.headers['x-upload-key'] !== UPLOAD_KEY) return json(res, 401, { error: 'bad upload key' });
      const data = await readBody(req);
      if (data.length < 1024) return json(res, 400, { error: 'empty file' });
      const id = randomBytes(6).toString('hex');
      const put = await gh(`/contents/videos/${id}.mp4`, { method: 'PUT',
        body: JSON.stringify({ message: 'video ' + id, branch: BRANCH, content: data.toString('base64') }) });
      if (!put.ok) return json(res, 502, { error: 'github: ' + (await put.text()).slice(0, 200) });
      const user = (u.searchParams.get('user') || 'guest').replace(/[^\w]/g, '').slice(0, 24) || 'guest';
      const title = (u.searchParams.get('title') || '').slice(0, 120);
      index.videos.push({ id, user, title, likes: 0, created: Date.now() });
      await saveIndex();
      return json(res, 201, { id });
    }

    let m = u.pathname.match(/^\/api\/videos\/(\w+)\/like$/);
    if (m && req.method === 'POST') {
      const v = index.videos.find(x => x.id === m[1]);
      if (!v) return json(res, 404, { error: 'not found' });
      v.likes++; dirty = true;
      return json(res, 200, { likes: v.likes });
    }

    m = u.pathname.match(/^\/v\/(\w+)$/);
    if (m && req.method === 'GET') {
      if (!index.videos.some(x => x.id === m[1])) return json(res, 404, { error: 'not found' });
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range;
      const up = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/videos/${m[1]}.mp4`, { headers });
      if (!up.ok && up.status !== 206) return json(res, 502, { error: 'upstream ' + up.status });
      const h = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', ...cors };
      for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) h[k] = up.headers.get(k);
      res.writeHead(up.status, h);
      return Readable.fromWeb(up.body).pipe(res);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, e.code === 413 ? 413 : 500, { error: String(e.message || e) });
  }
});

await loadIndex();
server.listen(PORT, () => console.log(`fTok-Server на :${PORT}, репо ${REPO}@${BRANCH}, видео: ${index.videos.length}`));
