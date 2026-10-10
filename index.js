import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import QRCode from 'qrcode';
import pino from 'pino';
import baileysPkg, {
  useMultiFileAuthState, fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
const makeWASocket = baileysPkg.default || baileysPkg;

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

const TMP = '/tmp/mjapani-sessions';
fs.mkdirSync(TMP, { recursive: true });

// id -> { dir, clients:Set(res), status, sock }
const sessions = new Map();

function sendEvent(session, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of session.clients) { try { res.write(msg); } catch {} }
}

function destroySession(id, delay = 3000) {
  const s = sessions.get(id);
  if (!s) return;
  setTimeout(() => {
    try { s.sock?.end?.(); } catch {}
    fs.rm(s.dir, { recursive: true, force: true }, () => {});
    sessions.delete(id);
  }, delay);
}

async function startSession(id, { pairingNumber } = {}) {
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  const session = { dir, clients: new Set(), status: 'starting', sock: null };
  sessions.set(id, session);

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    printQRInTerminal: false, browser: ['MJAPANI SESSION', 'Chrome', '1.0.0']
  });
  session.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  if (pairingNumber) {
    setTimeout(async () => {
      try {
        if (!sock.authState.creds.registered) {
          const code = await sock.requestPairingCode(pairingNumber.replace(/\D/g, ''));
          session.status = 'code';
          sendEvent(session, 'code', { code });
        }
      } catch (e) {
        sendEvent(session, 'error', { message: 'Imeshindikana kutengeneza pairing code: ' + e.message });
        destroySession(id, 1000);
      }
    }, 2500);
  }

  sock.ev.on('connection.update', async (u) => {
    const { connection, qr, lastDisconnect } = u;
    if (qr && !pairingNumber) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
        session.status = 'qr';
        sendEvent(session, 'qr', { image: dataUrl });
      } catch {}
    }
    if (connection === 'open') {
      try {
        const credsPath = path.join(dir, 'creds.json');
        const json = fs.readFileSync(credsPath, 'utf8');
        const sid = 'MJAPANI~' + Buffer.from(json).toString('base64');
        session.status = 'connected';
        sendEvent(session, 'session', { sessionId: sid });
      } catch (e) {
        sendEvent(session, 'error', { message: 'Imeunganika lakini kusoma session kumeshindikana: ' + e.message });
      }
      destroySession(id, 4000);
    }
    if (connection === 'close' && session.status !== 'connected') {
      sendEvent(session, 'error', { message: 'Muunganiko umekatika. Bonyeza "Anza upya" ujaribu tena.' });
      destroySession(id, 1000);
    }
  });

  // usalama: futa session ikiwa haijakamilika ndani ya dakika 3
  destroySession(id, 3 * 60 * 1000);
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
