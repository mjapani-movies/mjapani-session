# MJAPANI SESSION

Link a WhatsApp account (phone number code or QR) and get a `SESSION_ID` for the MJAPANI bot.

- The page shows the Session ID **and** sends it to the user's own WhatsApp chat.
- The session is stored on this server (encrypted with AES-256-GCM) and the bot downloads it from `/json/<SESSION_ID>/...`.
- A Session ID expires after 24 hours or 5 downloads.
- Temporary linking files are deleted right after linking.
- Limits: 6 linking attempts per IP per 10 min, 15 active links at once.
- Health check: `/health`

## Deploy (Railway)

1. Create a service from this repo and generate a domain.
2. Add a **Volume** and mount it at `/data`.
3. Variables: `DATA_DIR=/data`, `SESSION_SECRET=<long random text>`.
4. Optional: `SESSION_TTL_HOURS` (default 24), `SESSION_MAX_FETCH` (default 5).

Without a Volume, stored sessions are lost on every redeploy.
