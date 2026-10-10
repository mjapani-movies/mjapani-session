import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import QRCode from 'qrcode';
import pino from 'pino';
import baileysPkg, {
  useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers, jidNormalizedUser
} from '@whiskeysockets/baileys';
const makeWASocket = baileysPkg.default || baileysPkg;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2kb' }));
app.use(express.static(path.join(process.cwd(), 'public'), { maxAge: '1h' }));

const TMP = '/tmp/mjapani-sessions';
fs.mkdirSync(TMP, { recursive: true });

const MAX_ACTIVE = 15;           // max simultaneous linking attempts
const PER_IP_PER_10MIN = 6;      // max attempts per IP
const SESSION_TTL_MS = 3 * 60 * 1000;

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
  const { version } = await fetchLatestBaileysVersion();
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
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, qr, lastDisconnect } = u;

    // WhatsApp sends a "qr" once the handshake is ready: that is the right moment to ask for a pairing code
    if (qr && session.status !== 'connected') {
      if (session.pairingNumber) {
        if (!session.pairingRequested && !sock.authState.creds.registered) {
          session.pairingRequested = true;
          try {
            const raw = await sock.requestPairingCode(session.pairingNumber);
            const code = raw.match(/.{1,4}/g).join('-');
            session.status = 'code';
            sendEvent(session, 'code', { code });
          } catch (e) {
            sendEvent(session, 'fail', { message: 'Could not create a pairing code. Please try again.' });
            killSession(id, 500);
          }
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
      if (session.status === 'connected') return;
      session.status = 'connected';
      try {
        // make sure creds are on disk before reading them
        await saveCreds();
        const json = fs.readFileSync(path.join(session.dir, 'creds.json'), 'utf8');
        const sid = 'MJAPANI~' + Buffer.from(json).toString('base64');
        sendEvent(session, 'session', { sessionId: sid });

        // Also deliver it straight to the user's own WhatsApp chat
        try {
          const me = jidNormalizedUser(sock.user.id);
          await sock.sendMessage(me, { text: sid });
          await sock.sendMessage(me, {
            text: '✅ *MJAPANI SESSION*\nThe message above is your SESSION ID.\nPaste it in your bot as the variable *SESSION_ID*.\n⚠️ Never share it with anyone.'
          });
        } catch {}
      } catch (e) {
        sendEvent(session, 'fail', { message: 'Linked, but the session could not be read. Please try again.' });
      }
      killSession(id, 8000);
      return;
    }

    if (connection === 'close') {
      if (session.status === 'connected' || session.killed) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        sendEvent(session, 'fail', { message: 'WhatsApp rejected the link. Please start again.' });
        killSession(id, 500);
        return;
      }
      // Normal restart during linking (e.g. after the code is accepted): reconnect quietly
      setTimeout(() => connect(id).catch(() => {}), 1200);
    }
  });
}

async function startSession(id, { pairingNumber } = {}) {
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  const session = {
    dir, clients: new Set(), status: 'starting', sock: null, last: null,
    pairingNumber: pairingNumber || null, pairingRequested: false, killed: false
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

app.get('/health', (_req, res) => res.json({ ok: true, active: sessions.size }));

process.on('unhandledRejection', e => console.log('unhandledRejection:', e?.message || e));
process.on('uncaughtException', e => console.log('uncaughtException:', e?.message || e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('MJAPANI SESSION listening on ' + PORT));
