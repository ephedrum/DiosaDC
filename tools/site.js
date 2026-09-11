#!/usr/bin/env node
/* Local editor for the encrypted data behind backstage.html.
 *
 *   node tools/site.js            pull, open the editor in the browser, publish on save
 *   node tools/site.js --no-push  same, but commits stay local (dry run)
 *   node tools/site.js --no-pull  skip the initial git pull (offline)
 *
 * The encrypted files under assets/ are the only copy of the data. This
 * server decrypts them in memory after you type the password in the browser,
 * and re-encrypts + commits + pushes when you hit "Guardar y publicar".
 * Nothing in plaintext is ever written to disk.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const DCrypt = require('../assets/crypto.js');
const Ledger = require('../assets/model.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'assets', 'site.bin');
const IMG_DIR = path.join(ROOT, 'assets', 'img');
const SHOWS_FILE = path.join(ROOT, 'shows.csv');
const GALLERY_FILE = path.join(ROOT, 'gallery.json');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const HERO_SRC = 'uploads/hero.webp';
const MAX_GALLERY_BYTES = 3 * 1024 * 1024;
const EDITOR_HTML = path.join(__dirname, 'site-editor.html');
const PORT = 4373;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const args = new Set(process.argv.slice(2));
const NO_PUSH = args.has('--no-push');
const NO_PULL = args.has('--no-pull');

// Per-process secrets: a token so only the page we opened can talk to us,
// and the ledger key once the user unlocks.
const TOKEN = Buffer.from(DCrypt.randomBytes(24)).toString('hex'); // hex: safe inside a URL
let session = null; // { key, salt }

function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function log(msg) { console.log('  ' + msg); }

/* ---------- git helpers ---------- */

function pull(lines) {
  try {
    const out = git('pull', '--ff-only');
    lines.push('git pull: ' + (out.split('\n').pop() || 'ok'));
    return true;
  } catch (e) {
    lines.push('git pull falló: ' + (e.stderr || e.message).trim());
    return false;
  }
}

function publish(lines, paths) {
  git('add', '-A', '--', ...paths);
  try { git('diff', '--cached', '--quiet', '--', ...paths); lines.push('Sin cambios que publicar'); return; }
  catch (_) { /* there are staged changes */ }
  git('commit', '-q', '-m', 'Update site');
  lines.push('Commit creado: ' + git('log', '-1', '--format=%h %s'));
  if (NO_PUSH) { lines.push('(--no-push: el commit quedó local, no se publicó)'); return; }
  try {
    git('push');
    lines.push('Publicado en GitHub. La página tarda ~1-2 minutos en actualizarse.');
  } catch (e) {
    lines.push('push rechazado, intentando rebase…');
    try {
      git('pull', '--rebase');
      git('push');
      lines.push('Publicado en GitHub después del rebase.');
    } catch (e2) {
      lines.push('No se pudo publicar: ' + (e2.stderr || e2.message).trim());
      lines.push('El commit quedó guardado localmente. Resolvé el problema y corré "git push".');
    }
  }
}

/* ---------- ledger file helpers ---------- */

function readLedgerFile() {
  return fs.existsSync(DATA_FILE) ? new Uint8Array(fs.readFileSync(DATA_FILE)) : null;
}

function writeAtomic(file, bytes) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

function imgPath(id) {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error('id de imagen inválido');
  return path.join(IMG_DIR, id + '.bin');
}

function listImageIds() {
  if (!fs.existsSync(IMG_DIR)) return [];
  return fs.readdirSync(IMG_DIR).filter(f => f.endsWith('.bin')).map(f => f.slice(0, -4));
}

async function saveLedger(libro, nuevaContrasena, lines) {
  let { key, salt } = session;
  const referenced = new Set(libro.movimientos.filter(m => m.imagen).map(m => m.imagen.id));

  if (nuevaContrasena) {
    const newSalt = DCrypt.randomBytes(DCrypt.SALT_LEN);
    const newKey = await DCrypt.deriveKey(nuevaContrasena, newSalt);
    for (const id of referenced) {
      const plain = await DCrypt.decryptBytes(key, new Uint8Array(fs.readFileSync(imgPath(id))));
      writeAtomic(imgPath(id), await DCrypt.encryptBytes(newKey, newSalt, plain));
    }
    key = newKey; salt = newSalt;
    session = { key, salt };
    lines.push('Contraseña cambiada; todos los archivos fueron re-encriptados.');
  }

  // Re-encrypting always yields new bytes (fresh IV), so only write when the
  // content actually changed; otherwise every save would create a commit.
  const previo = readLedgerFile() && !nuevaContrasena ? await DCrypt.decryptJSON(key, readLedgerFile()) : null;
  const sinFecha = l => JSON.stringify({ ...l, actualizado: undefined });
  if (previo && sinFecha(previo) === sinFecha(libro)) {
    lines.push('El libro no cambió');
  } else {
    libro.actualizado = new Date().toISOString();
    fs.mkdirSync(IMG_DIR, { recursive: true });
    writeAtomic(DATA_FILE, await DCrypt.encryptJSON(key, salt, libro));
    lines.push('Libro encriptado: ' + libro.movimientos.length + ' movimientos');
  }

  let pruned = 0;
  for (const id of listImageIds()) {
    if (!referenced.has(id)) { fs.unlinkSync(imgPath(id)); pruned++; }
  }
  if (pruned) lines.push('Imágenes sin usar eliminadas: ' + pruned);
}

/* ---------- shows.csv helpers ----------
 * Must stay compatible with the parser in index.html: it toggles on every
 * double quote and has no escape, so fields may never contain a quote. */

const SHOW_FIELDS = ['date', 'day', 'venue', 'city', 'status', 'link'];
const SHOW_STATUSES = ['upcoming', 'ended', ''];

function parseShows(text) {
  const [header, ...rows] = text.trim().split(/\r?\n/);
  const cols = header.split(',').map(h => h.trim());
  return rows.filter(r => r.trim()).map(row => {
    const fields = [];
    let cur = '', inQ = false;
    for (const ch of row) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    fields.push(cur.trim());
    const o = {};
    SHOW_FIELDS.forEach(f => { const i = cols.indexOf(f); o[f] = i >= 0 ? (fields[i] || '') : ''; });
    return o;
  });
}

function serializeShows(shows) {
  const cell = v => (v.includes(',') ? '"' + v + '"' : v);
  return [SHOW_FIELDS.join(','), ...shows.map(s => SHOW_FIELDS.map(f => cell(String(s[f] || '').trim())).join(','))].join('\n') + '\n';
}

function validarShows(shows) {
  const err = [];
  if (!Array.isArray(shows)) return ['shows debe ser una lista'];
  shows.forEach((s, i) => {
    const at = 'Show #' + (i + 1) + (s && s.venue ? ' (' + s.venue + ')' : '') + ': ';
    for (const f of SHOW_FIELDS) {
      const v = String((s || {})[f] || '');
      if (/["\r\n]/.test(v)) err.push(at + f + ' no puede contener comillas ni saltos de línea');
    }
    if (!String(s.date || '').trim()) err.push(at + 'falta la fecha');
    if (!String(s.venue || '').trim()) err.push(at + 'falta el lugar');
    if (!SHOW_STATUSES.includes(String(s.status || '').trim())) err.push(at + 'estado inválido "' + s.status + '" (upcoming, ended o vacío)');
  });
  return err;
}

/* ---------- gallery helpers ----------
 * gallery.json: [{ src: "uploads/<file>.webp", alt: "..." }] in display order.
 * The browser resizes/converts to WebP before uploading; the server only
 * checks the bytes really are WebP and keeps uploads/ free of orphans. */

function readGallery() {
  return fs.existsSync(GALLERY_FILE) ? JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf8')) : [];
}

function isWebp(buf) {
  return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}

function validarGaleria(items) {
  const err = [];
  if (!Array.isArray(items)) return ['La galería debe ser una lista'];
  const seen = new Set();
  items.forEach((it, i) => {
    const at = 'Foto #' + (i + 1) + ': ';
    if (!it || typeof it.src !== 'string' || !/^uploads\/[A-Za-z0-9._-]+\.webp$/.test(it.src)) { err.push(at + 'ruta inválida'); return; }
    if (seen.has(it.src)) err.push(at + 'repetida ' + it.src);
    seen.add(it.src);
    if (!fs.existsSync(path.join(ROOT, it.src))) err.push(at + 'no existe el archivo ' + it.src);
    if (typeof it.alt !== 'string') err.push(at + 'alt debe ser texto');
  });
  return err;
}

function slug(name) {
  return String(name || 'foto').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/\.[^.]*$/, '').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'foto';
}

/* Remove anything in uploads/ that neither the gallery nor the hero uses. */
function pruneUploads(items, lines) {
  const keep = new Set(items.map(it => path.basename(it.src)).concat([path.basename(HERO_SRC)]));
  let n = 0;
  for (const f of fs.readdirSync(UPLOADS_DIR)) {
    if (!keep.has(f) && fs.statSync(path.join(UPLOADS_DIR, f)).isFile()) { fs.unlinkSync(path.join(UPLOADS_DIR, f)); n++; }
  }
  if (n) lines.push('Archivos sin usar eliminados de uploads/: ' + n);
}

/* ---------- http plumbing ---------- */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Archivo demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(type ? body : JSON.stringify(body));
}

function needSession() {
  if (!session) throw Object.assign(new Error('Primero hay que desbloquear el libro'), { status: 401 });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') {
    const html = fs.readFileSync(EDITOR_HTML, 'utf8').replace('__TOKEN__', TOKEN);
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && p === '/model.js') {
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'assets', 'model.js')), 'text/javascript');
  }
  // <img> tags cannot set headers, so image previews pass the token as ?t=
  if (req.headers['x-caja-token'] !== TOKEN && url.searchParams.get('t') !== TOKEN) {
    return send(res, 403, { error: 'Token inválido; recargá la página' });
  }

  if (req.method === 'GET' && p.startsWith('/uploads/')) {
    const file = path.join(UPLOADS_DIR, path.basename(p));
    if (!fs.existsSync(file)) throw Object.assign(new Error('No existe'), { status: 404 });
    return send(res, 200, fs.readFileSync(file), 'image/webp');
  }

  if (req.method === 'GET' && p === '/api/galeria') {
    return send(res, 200, { items: readGallery(), hero: HERO_SRC + '?v=' + Date.now() });
  }

  if (req.method === 'POST' && p === '/api/galeria/imagen') {
    const bytes = await readBody(req, MAX_GALLERY_BYTES);
    if (!isWebp(bytes)) throw Object.assign(new Error('La imagen debe llegar como WebP'), { status: 400 });
    const base = slug(decodeURIComponent(req.headers['x-nombre'] || ''));
    let name, i = 0;
    do { name = base + '-' + Date.now().toString(36) + (i ? '-' + i : '') + '.webp'; i++; } while (fs.existsSync(path.join(UPLOADS_DIR, name)));
    writeAtomic(path.join(UPLOADS_DIR, name), bytes);
    return send(res, 200, { src: 'uploads/' + name, bytes: bytes.length });
  }

  if (req.method === 'POST' && p === '/api/galeria') {
    const { items, hero } = JSON.parse(await readBody(req, 2e6));
    const errores = validarGaleria(items);
    if (hero != null && !items.some(it => it.src === hero)) errores.push('La foto elegida como hero no está en la galería');
    if (errores.length) return send(res, 400, { error: 'La galería tiene errores', errores });
    const lines = [];
    if (!NO_PULL) pull(lines);
    const clean = items.map(it => ({ src: it.src, alt: it.alt.trim() || 'Low Expectations live' }));
    writeAtomic(GALLERY_FILE, JSON.stringify(clean, null, 2) + '\n');
    lines.push('gallery.json escrito: ' + clean.length + ' fotos');
    if (hero) { fs.copyFileSync(path.join(ROOT, hero), path.join(ROOT, HERO_SRC)); lines.push('Hero actualizado desde ' + hero); }
    pruneUploads(clean, lines);
    publish(lines, ['gallery.json', 'uploads']);
    return send(res, 200, { ok: true, log: lines });
  }

  if (req.method === 'GET' && p === '/api/shows') {
    const text = fs.existsSync(SHOWS_FILE) ? fs.readFileSync(SHOWS_FILE, 'utf8') : SHOW_FIELDS.join(',') + '\n';
    return send(res, 200, { shows: parseShows(text) });
  }

  if (req.method === 'POST' && p === '/api/shows') {
    const { shows } = JSON.parse(await readBody(req, 1e6));
    const errores = validarShows(shows);
    if (errores.length) return send(res, 400, { error: 'Los shows tienen errores', errores });
    const lines = [];
    if (!NO_PULL) pull(lines);
    writeAtomic(SHOWS_FILE, serializeShows(shows));
    lines.push('shows.csv escrito: ' + shows.length + ' shows');
    publish(lines, ['shows.csv']);
    return send(res, 200, { ok: true, log: lines });
  }

  if (req.method === 'GET' && p === '/api/estado') {
    return send(res, 200, { existe: !!readLedgerFile(), desbloqueado: !!session, noPush: NO_PUSH, repo: git('remote', 'get-url', 'origin') });
  }

  if (req.method === 'POST' && p === '/api/desbloquear') {
    const { contrasena } = JSON.parse(await readBody(req, 1e5));
    const file = readLedgerFile();
    if (!file) throw Object.assign(new Error('No existe el libro todavía'), { status: 404 });
    const salt = DCrypt.readSalt(file);
    const key = await DCrypt.deriveKey(contrasena || '', salt);
    const libro = await DCrypt.decryptJSON(key, file); // throws on wrong password
    session = { key, salt };
    return send(res, 200, { libro });
  }

  if (req.method === 'POST' && p === '/api/crear') {
    if (readLedgerFile()) throw Object.assign(new Error('El libro ya existe'), { status: 409 });
    const { contrasena } = JSON.parse(await readBody(req, 1e5));
    if (!contrasena || contrasena.length < 8) throw Object.assign(new Error('La contraseña debe tener al menos 8 caracteres'), { status: 400 });
    const salt = DCrypt.randomBytes(DCrypt.SALT_LEN);
    session = { key: await DCrypt.deriveKey(contrasena, salt), salt };
    return send(res, 200, { libro: Ledger.nuevoLibro() });
  }

  if (req.method === 'POST' && p === '/api/imagen') {
    needSession();
    const mime = req.headers['content-type'] || '';
    if (!Ledger.IMAGE_MIMES.includes(mime)) throw Object.assign(new Error('Formato de imagen no permitido: ' + mime), { status: 400 });
    const nombre = decodeURIComponent(req.headers['x-nombre'] || 'imagen');
    const bytes = await readBody(req, MAX_IMAGE_BYTES);
    const id = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    fs.mkdirSync(IMG_DIR, { recursive: true });
    writeAtomic(imgPath(id), await DCrypt.encryptBytes(session.key, session.salt, new Uint8Array(bytes)));
    return send(res, 200, { id, mime, nombre });
  }

  if (req.method === 'GET' && p.startsWith('/api/imagen/')) {
    needSession();
    const file = imgPath(p.slice('/api/imagen/'.length));
    if (!fs.existsSync(file)) throw Object.assign(new Error('Imagen no encontrada'), { status: 404 });
    const plain = await DCrypt.decryptBytes(session.key, new Uint8Array(fs.readFileSync(file)));
    return send(res, 200, Buffer.from(plain), url.searchParams.get('mime') || 'application/octet-stream');
  }

  if (req.method === 'POST' && p === '/api/guardar') {
    needSession();
    const { libro, nuevaContrasena } = JSON.parse(await readBody(req, 20e6));
    const errores = Ledger.validar(libro);
    if (errores.length) return send(res, 400, { error: 'El libro tiene errores', errores });
    if (nuevaContrasena != null && nuevaContrasena.length < 8) return send(res, 400, { error: 'La contraseña nueva debe tener al menos 8 caracteres' });
    for (const m of libro.movimientos) {
      if (m.imagen && !fs.existsSync(imgPath(m.imagen.id))) return send(res, 400, { error: 'Falta el archivo de la imagen de: ' + (m.evento || m.concepto) });
    }
    const lines = [];
    if (!NO_PULL) pull(lines);
    await saveLedger(libro, nuevaContrasena || null, lines);
    publish(lines, ['assets']);
    return send(res, 200, { ok: true, log: lines, resumen: Ledger.resumen(libro) });
  }

  send(res, 404, { error: 'Ruta desconocida' });
}

/* ---------- startup ---------- */

function openBrowser(u) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', u] : [u];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true }).unref(); } catch (_) { /* user opens it by hand */ }
}

(function main() {
  console.log('\nEditor local\n');
  try { git('rev-parse', '--is-inside-work-tree'); } catch (_) {
    console.error('Esta carpeta no es un repositorio git.'); process.exit(1);
  }
  const lines = [];
  if (NO_PULL) lines.push('(--no-pull) se omitió git pull');
  else pull(lines);
  lines.forEach(log);
  if (NO_PUSH) log('(--no-push) los cambios no se publicarán');

  const server = http.createServer((req, res) => {
    handle(req, res).catch(e => send(res, e.status || 500, { error: e.message }));
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error('El puerto ' + PORT + ' ya está en uso: ¿quedó otro editor abierto? Cerralo y volvé a intentar.');
    else console.error(e.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    const u = 'http://127.0.0.1:' + PORT + '/';
    log('Editor abierto en ' + u);
    log('Cerrá esta ventana (Ctrl+C) cuando termines.\n');
    openBrowser(u);
  });
})();
