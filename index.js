import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import QRCode from 'qrcode';
import pino from 'pino';
import baileysPkg, {
  useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason
} from '@whiskeysockets/baileys';
const makeWASocket = baileysPkg.default || baileysPkg;

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

const TMP = '/tmp/mjapani-sessions';
fs.mkdirSync(TMP, { recursive: true });

// id -> { dir, clients:Set(res), status, sock, pairingNumber, pairingRequested, killed }
const sessions = new Map();

function sendEvent(session, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of session.clients) { try { res.write(msg); } catch {} }
}

function killSession(id, delay = 1000) {
  const s = sessions.get(id);
  if (!s || s.killed) return;
  s.killed = true;
  setTimeout(() => {
    try { s.sock?.end?.(); } catch {}
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
    version, auth: state, logger: pino({ level: 'silent' }),
    printQRInTerminal: false, browser: ['MJAPANI SESSION', 'Chrome', '1.0.0']
  });
  session.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  if (session.pairingNumber && !sock.authState.creds.registered && !session.pairingRequested) {
    setTimeout(async () => {
      if (session.killed) return;
      try {
        const code = await sock.requestPairingCode(session.pairingNumber.replace(/\D/g, ''));
        session.pairingRequested = true;
        session.status = 'code';
        sendEvent(session, 'code', { code });
      } catch (e) {
        sendEvent(session, 'error', { message: 'Imeshindikana kutengeneza pairing code: ' + e.message });
        killSession(id, 500);
      }
    }, 2500);
  }

  sock.ev.on('connection.update', async (u) => {
    const { connection, qr, lastDisconnect } = u;

    if (qr && !session.pairingNumber && session.status !== 'connected') {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
        session.status = 'qr';
        sendEvent(session, 'qr', { image: dataUrl });
      } catch {}
    }

    if (connection === 'open') {
      try {
        const credsPath = path.join(session.dir, 'creds.json');
        const json = fs.readFileSync(credsPath, 'utf8');
        const sid = 'MJAPANI~' + Buffer.from(json).toString('base64');
        session.status = 'connected';
        sendEvent(session, 'session', { sessionId: sid });
      } catch (e) {
        sendEvent(session, 'error', { message: 'Imeunganika lakini kusoma session kumeshindikana: ' + e.message });
      }
      killSession(id, 4000);
      return;
    }

    if (connection === 'close') {
      if (session.status === 'connected' || session.killed) return; // tayari imekamilika au imefungwa
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        sendEvent(session, 'error', { message: 'Kiungo kimekataliwa na WhatsApp. Bonyeza "Anza upya".' });
        killSession(id, 500);
        return;
      }
      // Muunganiko wa kawaida unaokatika wakati wa mchakato wa QR/pairing - unganisha upya
      // kimya kimya, bila kumwambia mtumiaji ni hitilafu.
      setTimeout(() => connect(id), 1200);
    }
  });
}

async function startSession(id, { pairingNumber } = {}) {
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  const session = {
    dir, clients: new Set(), status: 'starting', sock: null,
    pairingNumber: pairingNumber || null, pairingRequested: false, killed: false
  };
  sessions.set(id, session);
  await connect(id);
  // usalama: futa session ikiwa haijakamilika ndani ya dakika 3
  setTimeout(() => {
    const s = sessions.get(id);
    if (s && s.status !== 'connected') {
      sendEvent(s, 'error', { message: 'Muda umeisha. Bonyeza "Anza upya" ujaribu tena.' });
      killSession(id, 500);
    }
  }, 3 * 60 * 1000);
  return session;
}

app.post('/api/start', async (req, res) => {
  const id = crypto.randomBytes(8).toString('hex');
  const { mode, number } = req.body || {};
  if (mode === 'pair' && !/^\d{9,15}$/.test((number || '').replace(/\D/g, ''))) {
    return res.status(400).json({ error: 'Namba si sahihi. Tumia mfano 255712345678 (bila +).' });
  }
  try {
    await startSession(id, mode === 'pair' ? { pairingNumber: number } : {});
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/events/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');
  session.clients.add(res);
  req.on('close', () => session.clients.delete(res));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MJAPANI SESSION seva inaendesha kwenye port ' + PORT));
