// DWG → DXF conversion service. Runs LibreDWG's dwg2dxf in a temp folder for each upload.
// POST /convert  (multipart/form-data, field "file")  →  DXF text
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = +(process.env.PORT || 8080);
const MAX_BYTES = +(process.env.MAX_BYTES || 50 * 1024 * 1024);
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TIMEOUT_MS = +(process.env.TIMEOUT_MS || 90_000);

function cors(req, res) {
  const o = req.headers.origin;
  if (ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (o && ORIGINS.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}
const send = (res, code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };

// When Supabase is configured, only signed-in users of the app may convert files.
async function authorized(req) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return true;
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: auth, apikey: SUPABASE_ANON_KEY } });
  return r.ok;
}

function readBody(req) {
  return new Promise((ok, no) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BYTES) { no(Object.assign(new Error('檔案超過大小上限'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', no);
  });
}

// Minimal multipart parser: returns the bytes of the first file part.
function firstFile(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  let start = body.indexOf(boundary);
  while (start !== -1) {
    const headEnd = body.indexOf('\r\n\r\n', start);
    if (headEnd === -1) return null;
    const head = body.slice(start, headEnd).toString('utf8');
    const next = body.indexOf(boundary, headEnd);
    if (next === -1) return null;
    if (/filename=/i.test(head)) return body.slice(headEnd + 4, next - 2);
    start = next;
  }
  return null;
}

function run(cmd, args, cwd) {
  return new Promise((ok, no) => execFile(cmd, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => err ? no(Object.assign(err, { stderr })) : ok(stdout)));
}

createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, 'ok');
  if (req.method !== 'POST' || req.url !== '/convert') return send(res, 404, 'not found');
  let dir;
  try {
    if (!(await authorized(req))) return send(res, 401, '請先登入');
    const file = firstFile(await readBody(req), req.headers['content-type']);
    if (!file || !/^AC10\d\d/.test(file.slice(0, 6).toString('latin1'))) return send(res, 400, '這不是 DWG 檔');
    dir = await mkdtemp(join(tmpdir(), 'dwg-'));
    await writeFile(join(dir, 'in.dwg'), file);
    await run('dwg2dxf', ['-y', '-o', join(dir, 'out.dxf'), join(dir, 'in.dwg')], dir);
    send(res, 200, await readFile(join(dir, 'out.dxf')), 'application/dxf');
  } catch (e) {
    const code = e.code === 413 ? 413 : 422;
    console.error('convert failed', e.message, e.stderr || '');
    send(res, code, code === 413 ? e.message : 'DWG 轉檔失敗，檔案可能損毀或版本不支援');
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}).listen(PORT, () => console.log(`dwg-converter listening on ${PORT}`));
