import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import QRCode from 'qrcode';
import pino from 'pino';
import baileysPkg, {
  useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers, fetchLatestWaWebVersion, jidNormalizedUser, BufferJSON
} from 'baileys';
const makeWASocket = baileysPkg.default || baileysPkg;

// WhatsApp rejects linking from outdated client versions, so use the live WA Web version when possible
async function getWaVersion() {
  try { const r = await fetchLatestWaWebVersion(); if (r?.version) return r.version; } catch {}
  const { version } = await fetchLatestBaileysVersion();
  return version;
}


const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2kb' }));
app.use(express.static(path.join(process.cwd(), 'public'), { maxAge: '1h' }));

const TMP = '/tmp/mjapani-sessions';
fs.mkdirSync(TMP, { recursive: true });

// ---------- Persistent session store (encrypted at rest) ----------
// Mount a Railway Volume and set DATA_DIR to its path (e.g. /data) so sessions survive redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STORE_DIR = path.join(DATA_DIR, 'sessions');
fs.mkdirSync(STORE_DIR, { recursive: true });
const TTL_MS = Number(process.env.SESSION_TTL_HOURS || 24) * 3600 * 1000;
const MAX_FETCH = Number(process.env.SESSION_MAX_FETCH || 5);

function loadSecret() {
  if (process.env.SESSION_SECRET) return crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest();
  const f = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8')).digest();
}
const SECRET = loadSecret();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
function decrypt(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', SECRET, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
const ID_RE = /^mjapani_[a-f0-9]{36}$/;
const recPath = (id) => path.join(STORE_DIR, id + '.bin');
function writeRecord(id, rec) {
  const tmp = recPath(id) + '.tmp';
  fs.writeFileSync(tmp, encrypt(JSON.stringify(rec)), { mode: 0o600 });
  fs.renameSync(tmp, recPath(id));
}
function readRecord(id) {
  try { return JSON.parse(decrypt(fs.readFileSync(recPath(id)))); } catch { return null; }
}
function storeSession(json) {
  const id = 'mjapani_' + crypto.randomBytes(18).toString('hex');
  writeRecord(id, { created: Date.now(), fetches: 0, data: json });
  return id;
}
setInterval(() => { // remove expired sessions
  for (const f of fs.readdirSync(STORE_DIR)) {
    const p = path.join(STORE_DIR, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > TTL_MS + 3600 * 1000) fs.rmSync(p, { force: true }); } catch {}
  }
}, 30 * 60 * 1000).unref();

// Build the { creds, keys } document that Levanter expects, from the temporary auth folder
const KEY_TYPES = ['app-state-sync-version', 'app-state-sync-key', 'sender-key-memory', 'sender-key', 'lid-mapping', 'device-list', 'pre-key', 'session', 'tctoken'];
function snapshot(dir) {
  const creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'), BufferJSON.reviver);
  const keys = {};
  for (const f of fs.readdirSync(dir)) {
    if (f === 'creds.json' || !f.endsWith('.json')) continue;
    const base = f.slice(0, -5);
    const type = KEY_TYPES.find(t => base.startsWith(t + '-'));
    if (!type) continue;
    const kid = base.slice(type.length + 1).replace(/__/g, '/');
    try { (keys[type] ||= {})[kid] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'), BufferJSON.reviver); } catch {}
  }
  return JSON.stringify({ creds, keys }, BufferJSON.replacer);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fetchHits = new Map();
function fetchLimited(ip) {
  const now = Date.now();
  const list = (fetchHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now); fetchHits.set(ip, list);
  return list.length > 60;
}

const MAX_ACTIVE = 15;           // max simultaneous linking attempts
const PER_IP_PER_10MIN = 6;      // max attempts per IP
const SESSION_TTL_MS = 6 * 60 * 1000;
const CODE_REFRESH_MS = 50 * 1000; // issue a fresh pairing code regularly; only the newest one is valid

// id -> { dir, clients:Set(res), status, sock, pairingNumber, pairingRequested, killed }
const sessions = new Map();
const hits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > PER_IP_PER_10MIN;
}
setInterval(() => { // clean old entries
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some(t => now - t < 10 * 60 * 1000)) hits.delete(ip);
}, 5 * 60 * 1000).unref();

function sendEvent(session, event, data) {
  session.last = { event, data }; // so late SSE clients still get the latest state
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of session.clients) { try { res.write(msg); } catch {} }
}

function killSession(id, delay = 1000) {
  const s = sessions.get(id);
  if (!s || s.killed) return;
  s.killed = true;
  clearInterval(s.refreshTimer);
  setTimeout(() => {
    try { s.sock?.ws?.close(); } catch {}
    try { s.sock?.end?.(undefined); } catch {}
    for (const res of s.clients) { try { res.end(); } catch {} }
    fs.rm(s.dir, { recursive: true, force: true }, () => {});
    sessions.delete(id);
  }, delay);
}

async function connect(id) {
  const session = sessions.get(id);
  if (!session || session.killed) return;

  const { state, saveCreds } = await useMultiFileAuthState(session.dir);
  const version = await getWaVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    // Must be a standard browser identity, otherwise WhatsApp rejects pairing codes
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false
  });
  session.sock = sock;
  let socketPaired = false; // per socket: after a reconnect a fresh code is issued
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, qr, lastDisconnect } = u;

    // WhatsApp sends a "qr" once the handshake is ready: that is the right moment to ask for a pairing code
    if (qr && session.status !== 'connected') {
      if (session.pairingNumber) {
        if (!socketPaired && !sock.authState.creds.registered) {
          socketPaired = true;
          const issueCode = async () => {
            if (session.killed || session.status === 'connected' || session.sock !== sock) return clearInterval(session.refreshTimer);
            try {
              const raw = await sock.requestPairingCode(session.pairingNumber);
            console.log(`[${id}] pairing code issued for number ending ${session.pairingNumber.slice(-3)}`);
              session.status = 'code';
              sendEvent(session, 'code', { code: raw.match(/.{1,4}/g).join('-'), expiresIn: Math.round(CODE_REFRESH_MS / 1000) });
            } catch (e) {
              if (!session.status || session.status === 'starting') {
                sendEvent(session, 'fail', { message: 'Could not create a pairing code. Please try again.' });
                killSession(id, 500);
              }
            }
          };
          clearInterval(session.refreshTimer);
          await issueCode();
          session.refreshTimer = setInterval(issueCode, CODE_REFRESH_MS);
        }
      } else {
        try {
          const image = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
          session.status = 'qr';
          sendEvent(session, 'qr', { image });
        } catch {}
      }
    }

    if (connection === 'open') {
      console.log(`[${id}] linked OK`);
      if (session.status === 'connected') return;
      session.status = 'connected';
      sendEvent(session, 'linked', {});
      try {
        await sleep(8000); // let WhatsApp deliver the first sync keys before we take the snapshot
        await saveCreds();
        const sid = storeSession(snapshot(session.dir));
        sendEvent(session, 'session', { sessionId: sid });

        // Also deliver it straight to the user's own WhatsApp chat
        try {
          const me = jidNormalizedUser(sock.user.id);
          await sock.sendMessage(me, { text: sid });
          await sock.sendMessage(me, {
            text: '✅ *MJAPANI SESSION*\nThe message above is your SESSION_ID.\nPaste it in your bot as the variable *SESSION_ID*.\n⚠️ Never share it with anyone.'
          });
        } catch {}
      } catch (e) {
        console.log(`[${id}] snapshot error: ${e.message}`);
        sendEvent(session, 'fail', { message: 'Linked, but the session could not be saved. Please try again.' });
      }
      killSession(id, 8000);
      return;
    }

    if (connection === 'close') {
      if (session.status === 'connected' || session.killed) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${id}] closed: status=${code} msg=${lastDisconnect?.error?.message} mode=${session.pairingNumber ? 'pair' : 'qr'} state=${session.status}`);

      // Not paired yet (no account in creds). Reconnecting with half-made pairing creds makes WhatsApp
      // reject the login, so start again from a clean folder and issue a fresh code/QR.
      const notPaired = !sock.authState.creds.account;
      if (notPaired && (session.retries || 0) < 3) {
        session.retries = (session.retries || 0) + 1;
        session.pairingRequested = false;
        try { fs.rmSync(session.dir, { recursive: true, force: true }); fs.mkdirSync(session.dir, { recursive: true }); } catch {}
        console.log(`[${id}] restarting clean (attempt ${session.retries})`);
        setTimeout(() => connect(id).catch(e => console.log(`[${id}] reconnect error: ${e.message}`)), 1500);
        return;
      }
      if (notPaired || code === DisconnectReason.loggedOut) {
        sendEvent(session, 'fail', { message: 'Could not reach WhatsApp or the link was rejected. Please start again.' });
        killSession(id, 500);
        return;
      }
      // Normal restart after a successful pairing: reconnect quietly
      setTimeout(() => connect(id).catch(e => console.log(`[${id}] reconnect error: ${e.message}`)), 1200);
    }
  });
}

async function startSession(id, { pairingNumber } = {}) {
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  const session = {
    dir, clients: new Set(), status: 'starting', sock: null, last: null,
    pairingNumber: pairingNumber || null, refreshTimer: null, killed: false
  };
  sessions.set(id, session);
  await connect(id);
  setTimeout(() => {
    const s = sessions.get(id);
    if (s && s.status !== 'connected') {
      sendEvent(s, 'fail', { message: 'Time expired. Please start again.' });
      killSession(id, 500);
    }
  }, SESSION_TTL_MS);
  return session;
}

app.post('/api/start', async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
  if (sessions.size >= MAX_ACTIVE) return res.status(503).json({ error: 'Server is busy. Please try again in a minute.' });

  const { mode, number } = req.body || {};
  const digits = String(number || '').replace(/\D/g, '');
  if (mode === 'pair' && !/^[1-9]\d{8,14}$/.test(digits)) {
    return res.status(400).json({ error: 'Enter your number with country code, no + or 0 (e.g. 255712345678).' });
  }
  const id = crypto.randomBytes(8).toString('hex');
  try {
    await startSession(id, mode === 'pair' ? { pairingNumber: digits } : {});
    res.json({ id });
  } catch (e) {
    console.log('start error:', e.message);
    res.status(500).json({ error: 'Could not start. Please try again.' });
  }
});

app.get('/api/events/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  session.clients.add(res);
  if (session.last) res.write(`event: ${session.last.event}\ndata: ${JSON.stringify(session.last.data)}\n\n`);
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
  req.on('close', () => { clearInterval(beat); session.clients.delete(res); });
});

// Levanter fetches its session from here (see mjapani-preload.js in the bot repo)
app.get('/json/:id/:token?', (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(404).end();
  if (fetchLimited(req.ip)) return res.status(429).end();
  const rec = readRecord(id);
  if (!rec) return res.status(404).end();
  if (Date.now() - rec.created > TTL_MS || rec.fetches >= MAX_FETCH) {
    fs.rmSync(recPath(id), { force: true });
    return res.status(404).end();
  }
  rec.fetches += 1;
  writeRecord(id, rec);
  res.set('Cache-Control', 'no-store').type('application/json').send(rec.data);
});

app.get('/health', (_req, res) => res.json({ ok: true, active: sessions.size }));

process.on('unhandledRejection', e => console.log('unhandledRejection:', e?.message || e));
process.on('uncaughtException', e => console.log('uncaughtException:', e?.message || e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('MJAPANI SESSION listening on ' + PORT));
