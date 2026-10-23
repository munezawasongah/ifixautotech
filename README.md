# jFIX-TECHS Sync Server

Backend for device & data synchronisation for the jFIX-TECHS Workshop
Manual & Management System. It implements the single-endpoint sync API
the app already documents inside its own **Account & sync** panel:

```
POST /sync
body: { "account": "<email>", "device": "<deviceId>", "bundle": {...} }
```

Job cards, quotes/invoices, workshop settings, price memory, favourites
and the verified-device list are merged and stored in PostgreSQL, then
returned so every device converges on the same data.

## Deploy to Railway

1. **Push this folder to a GitHub repo** (or use `railway up` from inside
   this folder with the Railway CLI - either works).

2. **Create the service on Railway**
   - New Project -> Deploy from GitHub repo -> select this repo
   - Railway auto-detects Node.js (via `package.json`) and runs `npm start`

3. **Add a PostgreSQL database**
   - In the same Railway project: **New -> Database -> PostgreSQL**
   - Railway automatically injects `DATABASE_URL` into this service - you
     don't need to copy/paste anything. The server creates its one table
     (`accounts`) automatically on first boot.

4. **Deploy**
   - Railway builds and starts the service. Check the deploy logs for:
     `jFIX-TECHS sync server listening on <port>`
   - Visit `https://<your-service>.up.railway.app/health` - it should
     return `{"ok":true,"db":"connected"}`

5. **Get your public URL**
   - Settings -> Networking -> **Generate Domain** (if not already public)
   - Copy the `https://...up.railway.app` URL

## Wire it into the app

In jFIX-TECHS, open **Workshop settings row -> Account & sync**, sign in
or create an account, then under **Sync between devices**:

1. Paste the Railway URL into **Sync server URL** (e.g.
   `https://jfix-sync-production.up.railway.app`)
2. Click **Save server**
3. Click **Sync now**

Repeat on every device you want kept in sync (up to 3 verified devices
per account, same limit the app already enforces for offline sync files).
The first device to sync becomes the account owner; devices added later
need to be verified with their 6-digit code, exactly as the in-app
sync-file flow already works today - the server just automates the
exchange instead of emailing/AirDropping a `.json` file between devices.

## Local testing (optional)

```bash
npm install
cp .env.example .env   # point DATABASE_URL at a local Postgres
npm start
```

## Notes on the trust model

This mirrors the security model the app already states plainly in its
own UI: the passphrase hash is generated client-side and never leaves
the device as plaintext, but it isn't a full auth system (no email
verification, no password reset flow). The server enforces that:

- a given email's data can only be updated by someone who already knows
  that account's passphrase (matching salt+hash), and
- only devices already on the account's device list can push/pull data,

but, as the app already tells users, "anyone with access to the device
can read local data." Treat the passphrase as a shared workshop
credential, not a personal login.
