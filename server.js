#!/usr/bin/env node
'use strict';

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { execFile, exec } = require('child_process');
const os       = require('os');
const Database = require('better-sqlite3');

const PORT    = 3847;
const GP_EXTS = new Set(['.gp', '.gp3', '.gp4', '.gp5', '.gp6', '.gpx', '.gp7']);
const DB_PATH = path.join(__dirname, 'gpi.db');

// ── Database ──────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    path        TEXT PRIMARY KEY,
    artist      TEXT,
    song        TEXT,
    tuning      TEXT,
    strings     INTEGER,
    favorite    INTEGER NOT NULL DEFAULT 0,
    groups      TEXT    NOT NULL DEFAULT '[]',
    notes       TEXT    NOT NULL DEFAULT '',
    last_opened TEXT
  );
  CREATE TABLE IF NOT EXISTS dirs (
    path       TEXT    NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS grps (
    name       TEXT    NOT NULL PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
`);

function dbGetDirs() {
  return db.prepare('SELECT path FROM dirs ORDER BY sort_order').all().map(r => r.path);
}
function dbGetGroups() {
  return db.prepare('SELECT name FROM grps ORDER BY sort_order').all().map(r => r.name);
}
function dbGetMeta() {
  const out = {};
  for (const r of db.prepare('SELECT * FROM meta').all()) {
    r.groups   = JSON.parse(r.groups || '[]');
    r.favorite = !!r.favorite;
    out[r.path] = r;
  }
  return out;
}

const _setDirsStmt  = db.prepare('INSERT INTO dirs (path, sort_order) VALUES (?, ?)');
const _clearDirs    = db.prepare('DELETE FROM dirs');
const dbSetDirs = db.transaction(dirs => {
  _clearDirs.run();
  dirs.forEach((p, i) => _setDirsStmt.run(p, i));
});

const _setGrpStmt = db.prepare('INSERT OR IGNORE INTO grps (name, sort_order) VALUES (?, ?)');
const _clearGrps  = db.prepare('DELETE FROM grps');
const dbSetGroups = db.transaction(groups => {
  _clearGrps.run();
  groups.forEach((g, i) => _setGrpStmt.run(g, i));
});

function dbUpsertMeta(filePath, updates) {
  const existing = db.prepare('SELECT * FROM meta WHERE path = ?').get(filePath) || {};
  const record = {
    path:     filePath,
    artist:   updates.artist   !== undefined ? updates.artist   : existing.artist   ?? null,
    song:     updates.song     !== undefined ? updates.song     : existing.song     ?? null,
    tuning:   updates.tuning   !== undefined ? updates.tuning   : existing.tuning   ?? null,
    strings:  updates.strings  !== undefined ? updates.strings  : existing.strings  ?? null,
    favorite: updates.favorite !== undefined ? (updates.favorite ? 1 : 0) : existing.favorite || 0,
    groups:   updates.groups   !== undefined ? JSON.stringify(updates.groups) : existing.groups || '[]',
    notes:    updates.notes    !== undefined ? updates.notes    : existing.notes    || '',
    last_opened: existing.last_opened ?? null
  };
  db.prepare(`
    INSERT INTO meta (path,artist,song,tuning,strings,favorite,groups,notes,last_opened)
    VALUES (@path,@artist,@song,@tuning,@strings,@favorite,@groups,@notes,@last_opened)
    ON CONFLICT(path) DO UPDATE SET
      artist=excluded.artist, song=excluded.song, tuning=excluded.tuning,
      strings=excluded.strings, favorite=excluded.favorite, groups=excluded.groups,
      notes=excluded.notes, last_opened=excluded.last_opened
  `).run(record);
}

function dbSetLastOpened(filePath) {
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT INTO meta (path, last_opened) VALUES (?, ?)
    ON CONFLICT(path) DO UPDATE SET last_opened = excluded.last_opened
  `).run(filePath, ts);
  return ts;
}

// ── GP metadata parsing ──────────────────────────────────────────────────────

const TUNING_PITCHES = [
  { id:'standard_e',   n:6, hi:[64,59,55,50,45,40] },
  { id:'eb_standard',  n:6, hi:[63,58,54,49,44,39] },
  { id:'drop_d',       n:6, hi:[64,59,55,50,45,38] },
  { id:'d_standard',   n:6, hi:[62,57,53,48,43,38] },
  { id:'drop_c',       n:6, hi:[62,57,53,48,43,36] },
  { id:'cs_standard',  n:6, hi:[61,56,52,47,42,37] },
  { id:'drop_b',       n:6, hi:[61,56,52,47,42,35] },
  { id:'c_standard',   n:6, hi:[60,55,51,46,41,36] },
  { id:'drop_bb',      n:6, hi:[60,55,51,46,41,34] },
  { id:'b_standard',   n:6, hi:[59,54,50,45,40,35] },
  { id:'drop_a_6',     n:6, hi:[59,54,50,45,40,33] },
  { id:'7_standard',   n:7, hi:[64,59,55,50,45,40,35] },
  { id:'7_drop_a',     n:7, hi:[64,59,55,50,45,40,33] },
  { id:'7_a_standard', n:7, hi:[63,58,54,49,44,39,34] },
  { id:'7_drop_gs',    n:7, hi:[63,58,54,49,44,39,32] },
  { id:'8_standard',   n:8, hi:[64,59,55,50,45,40,35,30] },
  { id:'8_drop_e',     n:8, hi:[64,59,55,50,45,40,35,28] },
  { id:'8_e_standard', n:8, hi:[62,57,53,48,43,38,33,28] },
];

function pitchesToTuningId(pitches) {
  if (!pitches || pitches.length < 6) return { tuning: '', strings: 0 };
  const count = Math.min(pitches.length, 8);
  const arr   = pitches.slice(0, count);
  const rev   = [...arr].reverse();
  for (const candidate of [arr, rev]) {
    const m = TUNING_PITCHES.find(t => t.n === count && t.hi.every((p, i) => p === candidate[i]));
    if (m) return { tuning: m.id, strings: count };
  }
  return { tuning: 'custom', strings: count };
}

function readSizedString(buf, offset) {
  if (offset + 5 > buf.length) return { str: '', next: buf.length };
  const maxLen = buf.readUInt32LE(offset);
  const len    = Math.min(buf[offset + 4], maxLen, buf.length - offset - 5);
  const str    = buf.toString('latin1', offset + 5, offset + 5 + len).trim();
  return { str, next: offset + 4 + 1 + maxLen };
}

function parseGp345Header(buf) {
  try {
    const { str: title,    next: o1 } = readSizedString(buf, 31);
    const { str: subtitle, next: o2 } = readSizedString(buf, o1); // eslint-disable-line no-unused-vars
    const { str: artist              } = readSizedString(buf, o2);
    return { title, artist };
  } catch { return {}; }
}

const GP7_SCRIPT = `
import zipfile, re, json, sys

def cdata(s):
    if not s: return ''
    s = str(s).strip()
    m = re.search(r'<!\\[CDATA\\[(.*?)\\]\\]>', s, re.DOTALL)
    return m.group(1).strip() if m else s

def get_tag(xml, tag):
    m = re.search(r'<' + tag + r'>(.*?)</' + tag + r'>', xml, re.DOTALL)
    return cdata(m.group(1)) if m else ''

try:
    z = zipfile.ZipFile(sys.argv[1])
    names = z.namelist()
    title, artist = '', ''
    if 'meta.json' in names:
        meta = json.loads(z.read('meta.json').decode('utf-8', errors='ignore'))
        title  = cdata(meta.get('title',  meta.get('Title',  meta.get('name', ''))))
        artist = cdata(meta.get('artist', meta.get('Artist', meta.get('author', ''))))
    xml = None
    for n in names:
        if n.endswith('score.gpif') or n.endswith('.gpif'):
            xml = z.read(n).decode('utf-8', errors='ignore'); break
    pitches = []
    if xml:
        if not title:  title  = get_tag(xml, 'Title')
        if not artist: artist = get_tag(xml, 'Artist')
        for t_xml in re.findall(r'<Track\\s+id="\\d+">(.*?)</Track>', xml, re.DOTALL):
            m = re.search(r'<Property\\s+name="Tuning">\\s*<Pitches>([\\d\\s]+)</Pitches>', t_xml)
            if m:
                pp = [int(x) for x in m.group(1).split()]
                if 6 <= len(pp) <= 8:
                    pitches = pp; break
    print(json.dumps({'title': title, 'artist': artist, 'pitches': pitches}))
except Exception as e:
    sys.stderr.write(str(e) + '\\n')
    print('{}')
`.trim();

async function readGp7Meta(filePath) {
  return new Promise(resolve => {
    execFile('python3', ['-c', GP7_SCRIPT, filePath], { timeout: 8000 }, (err, stdout) => {
      try {
        const { title = '', artist = '', pitches = [] } = JSON.parse(stdout.trim() || '{}');
        resolve({ title, artist, ...pitchesToTuningId(pitches) });
      } catch { resolve({}); }
    });
  });
}

async function readGpMeta(filePath, ext) {
  try {
    const fd     = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(800);
    const n      = fs.readSync(fd, header, 0, 800, 0);
    fs.closeSync(fd);
    const buf    = header.slice(0, n);
    const isZip  = buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
    return isZip ? await readGp7Meta(filePath) : parseGp345Header(buf);
  } catch (e) {
    console.error(`[readGpMeta] ${path.basename(filePath)}: ${e.message}`);
  }
  return {};
}

// ── Platform helpers ──────────────────────────────────────────────────────────

function openFile(filePath, cb) {
  if (process.platform === 'win32')
    execFile('cmd', ['/c', 'start', '', filePath], cb);
  else if (process.platform === 'linux')
    execFile('xdg-open', [filePath], cb);
  else
    execFile('open', [filePath], cb);
}

function openUrl(url) {
  if (process.platform === 'win32')      exec(`start ${url}`);
  else if (process.platform === 'linux') exec(`xdg-open ${url}`);
  else                                   exec(`open ${url}`);
}

// ── File scanning ─────────────────────────────────────────────────────────────

function scanDir(dirPath, out = []) {
  try {
    for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (e.name[0] === '.') continue;
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) {
        scanDir(full, out);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (GP_EXTS.has(ext)) {
          const st = fs.statSync(full);
          out.push({ path: full, name: e.name, ext: ext.slice(1), dir: dirPath,
                     size: st.size, mtime: st.mtime.toISOString() });
        }
      }
    }
  } catch (_) { /* skip inaccessible dirs */ }
  return out;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function sendJson(res, status, data) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function sendHtml(res, status, body) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pn  = url.pathname;

  if (req.method === 'OPTIONS') { setCors(res); res.writeHead(204); res.end(); return; }

  // GET / — serve index.html
  if (req.method === 'GET' && (pn === '/' || pn === '/index.html')) {
    const p = path.join(__dirname, 'index.html');
    try   { sendHtml(res, 200, fs.readFileSync(p, 'utf8')); }
    catch { sendHtml(res, 500, '<h1>index.html not found</h1>'); }
    return;
  }

  // GET /api/data — all persistent state
  if (req.method === 'GET' && pn === '/api/data') {
    sendJson(res, 200, { dirs: dbGetDirs(), groups: dbGetGroups(), meta: dbGetMeta() });
    return;
  }

  // POST /api/scan  { dirs: string[] }
  if (req.method === 'POST' && pn === '/api/scan') {
    try {
      const { dirs } = await readBody(req);
      const files = [];
      for (const d of (dirs || [])) {
        const expanded = String(d).replace(/^~/, os.homedir());
        if (fs.existsSync(expanded)) scanDir(expanded, files);
      }
      for (let i = 0; i < files.length; i += 6) {
        await Promise.all(files.slice(i, i + 6).map(async f => {
          f.fileMeta = await readGpMeta(f.path, f.ext);
        }));
      }
      sendJson(res, 200, files);
    } catch (e) { sendJson(res, 400, { error: e.message }); }
    return;
  }

  // POST /api/meta  { path, ...fields }
  if (req.method === 'POST' && pn === '/api/meta') {
    try {
      const { path: filePath, ...updates } = await readBody(req);
      if (!filePath) { sendJson(res, 400, { error: 'path required' }); return; }
      dbUpsertMeta(filePath, updates);
      sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
    return;
  }

  // POST /api/dirs  { dirs: string[] }
  if (req.method === 'POST' && pn === '/api/dirs') {
    try {
      const { dirs } = await readBody(req);
      dbSetDirs(Array.isArray(dirs) ? dirs : []);
      sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
    return;
  }

  // POST /api/groups  { groups: string[] }
  if (req.method === 'POST' && pn === '/api/groups') {
    try {
      const { groups } = await readBody(req);
      dbSetGroups(Array.isArray(groups) ? groups : []);
      sendJson(res, 200, { ok: true });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
    return;
  }

  // POST /api/open  { file: string }
  if (req.method === 'POST' && pn === '/api/open') {
    try {
      const { file } = await readBody(req);
      if (!file || !fs.existsSync(file)) {
        sendJson(res, 404, { error: 'File not found: ' + file }); return;
      }
      const ext = path.extname(file).toLowerCase();
      if (!GP_EXTS.has(ext)) {
        sendJson(res, 403, { error: 'Not a Guitar Pro file' }); return;
      }
      const ts = dbSetLastOpened(file);
      openFile(file, err => {
        if (err) sendJson(res, 500, { error: err.message });
        else     sendJson(res, 200, { ok: true, last_opened: ts });
      });
    } catch (e) { sendJson(res, 400, { error: e.message }); }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🎸  Guitar Pro Index`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`    DB: ${DB_PATH}`);
  console.log('    Press Ctrl+C to stop\n');
  openUrl(`http://localhost:${PORT}`);
});
