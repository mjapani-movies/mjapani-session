# MJAPANI SESSION

Link a WhatsApp account (phone number code or QR) and get a `SESSION_ID`.

- The Session ID is shown on the page **and** sent to the user's own WhatsApp chat.
- Temporary files are deleted right after linking.
- Limits: 6 attempts per IP per 10 min, 15 active links at once.
- Health check: `/health`

Deploy: push to GitHub, create a Railway service from the repo, generate a domain. No variables needed.
