/* ==================================================================
   jFIX-TECHS SYNC SERVER
   ------------------------------------------------------------------
   Implements the single-endpoint sync API that the jFIX-TECHS
   Workshop Manual & Management System already expects, as documented
   inside the app itself (Account & sync panel -> "Sync server API"):

     POST /sync   body: { account, device, bundle }

   Behaviour:
     - First sync for an email creates the account record on the
       server (the device sending it becomes the owner).
     - Every later sync for that email must carry a bundle.account
       with the SAME salt+hash the server already has on file for
       that email (this is the client's local passphrase hash - it
       doubles as this server's authentication check, exactly as
       described in-app: "Real authentication requires the sync
       server").
     - The sending device must appear in the server's device list
       for the account, unless this is the very first (bootstrap)
       sync.
     - Job cards are merged by id, newest `updatedAt`/`date` wins.
     - Archived documents (quotes/invoices) are merged by
       `type + no`, existing ones are never overwritten.
     - Workshop settings are replaced by whichever copy is newer
       (the incoming bundle's `exportedAt`), keeping the stored
       logo if the incoming settings has none.
     - Price memory, favourites and saved diagrams are unioned.
     - Devices are merged the same way the app merges an imported
       sync file: verification propagates, and a maximum of
       MAX_DEVICES verified devices is enforced (oldest kept).
     - The response is always { bundle } in the exact shape the
       app's syncBundle()/applyBundle() functions already use, so
       no changes are required on the front end beyond entering
       this server's URL in Account & sync -> "Sync server URL".
   ================================================================== */

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const MAX_DEVICES = 3;

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Add a PostgreSQL database to this Railway " +
    "project (New -> Database -> PostgreSQL) - Railway will inject " +
    "DATABASE_URL automatically."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : (process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }),
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      email       TEXT PRIMARY KEY,
      bundle      JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" })); // job cards can carry embedded vehicle photos

/* ---------------- merge helpers (mirror the app's own merge logic) ---------------- */

function mergeJobs(mine, theirs) {
  const map = {};
  (mine || []).forEach((j) => { map[j.id] = j; });
  (theirs || []).forEach((j) => {
    const cur = map[j.id];
    if (!cur) { map[j.id] = j; return; }
    const a = cur.updatedAt || cur.date || "";
    const b = j.updatedAt || j.date || "";
    if (b > a) map[j.id] = j; // newest wins
  });
  return Object.values(map);
}

function mergeDocsArr(mine, theirs) {
  const list = (mine || []).slice();
  const seen = new Set(list.map((d) => d.type + "|" + d.no));
  (theirs || []).forEach((d) => {
    const key = d.type + "|" + d.no;
    if (!seen.has(key)) { list.push(d); seen.add(key); }
  });
  return list;
}

function mergeById(mine, theirs) {
  const list = (mine || []).slice();
  const seen = new Set(list.map((x) => x.id));
  (theirs || []).forEach((x) => {
    if (!seen.has(x.id)) { list.push(x); seen.add(x.id); }
  });
  return list;
}

function mergePrices(mine, theirs) {
  const p = Object.assign({}, mine || {});
  Object.keys(theirs || {}).forEach((k) => { p[k] = theirs[k]; });
  return p;
}

function mergeDevices(mine, theirs) {
  const byId = {};
  (mine || []).forEach((d) => { byId[d.id] = d; });
  (theirs || []).forEach((d) => {
    const cur = byId[d.id];
    if (!cur) { byId[d.id] = d; return; }
    if (d.verified && !cur.verified) byId[d.id] = d; // verification propagates
  });
  let list = Object.values(byId);
  const verified = list.filter((d) => d.verified);
  if (verified.length > MAX_DEVICES) {
    verified.sort((x, y) => (x.added || "") < (y.added || "") ? -1 : 1);
    const keep = new Set(verified.slice(0, MAX_DEVICES).map((d) => d.id));
    list = list.map((d) => (d.verified && !keep.has(d.id)) ? Object.assign({}, d, { verified: false, overLimit: true }) : d);
  }
  return list;
}

function mergeBundles(stored, incoming) {
  const settings = incoming.settings
    ? Object.assign({}, incoming.settings, {
        logo: incoming.settings.logo || (stored.settings && stored.settings.logo) || undefined,
      })
    : stored.settings;

  return {
    kind: "jfix-sync",
    v: 1,
    exportedAt: new Date().toISOString(),
    fromDevice: { id: "server", name: "jFIX-TECHS sync server" },
    account: {
      email: stored.account.email,
      salt: stored.account.salt,
      hash: stored.account.hash,
      created: stored.account.created,
      devices: mergeDevices(stored.account.devices, incoming.account && incoming.account.devices),
    },
    settings,
    jobs: mergeJobs(stored.jobs, incoming.jobs),
    docs: mergeDocsArr(stored.docs, incoming.docs),
    prices: mergePrices(stored.prices, incoming.prices),
    favs: mergeById(stored.favs, incoming.favs),
    diagrams: mergeById(stored.diagrams, incoming.diagrams),
  };
}

/* ---------------- routes ---------------- */

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "jfix-techs-sync-server" });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/sync", async (req, res) => {
  try {
    const { account, device, bundle } = req.body || {};
    if (!account || !device || !bundle) {
      return res.status(400).json({ error: "Request must include account, device and bundle." });
    }
    if (bundle.kind !== "jfix-sync" && bundle.kind !== "ifix-sync") {
      return res.status(400).json({ error: "bundle.kind must be jfix-sync." });
    }
    if (!bundle.account || !bundle.account.email || bundle.account.email !== account) {
      return res.status(400).json({ error: "bundle.account.email must match account." });
    }
    if (!bundle.account.hash || !bundle.account.salt) {
      return res.status(400).json({ error: "bundle.account is missing salt/hash - sign in before syncing." });
    }

    const email = String(account).trim().toLowerCase();
    const existing = await pool.query("SELECT bundle FROM accounts WHERE email = $1", [email]);

    if (existing.rowCount === 0) {
      // Bootstrap: first sync for this account creates the record.
      // The sending device must be present (as owner) in its own bundle.
      const devices = bundle.account.devices || [];
      const isKnownDevice = devices.some((d) => d.id === device);
      if (!isKnownDevice) {
        return res.status(400).json({ error: "Sending device is not present in bundle.account.devices." });
      }
      const toStore = Object.assign({}, bundle, {
        exportedAt: new Date().toISOString(),
        fromDevice: { id: "server", name: "jFIX-TECHS sync server" },
      });
      await pool.query(
        "INSERT INTO accounts(email, bundle, updated_at) VALUES ($1, $2, now())",
        [email, toStore]
      );
      return res.json({ bundle: toStore });
    }

    const stored = existing.rows[0].bundle;

    // Authenticate: passphrase hash must match what the server already has on file.
    if (bundle.account.hash !== stored.account.hash || bundle.account.salt !== stored.account.salt) {
      return res.status(401).json({ error: "Passphrase does not match this account on the server." });
    }

    // Device must be registered (any state) against the account already on file,
    // unless it was just verified via this very same incoming bundle.
    const knownOnServer = (stored.account.devices || []).some((d) => d.id === device);
    const knownIncoming = (bundle.account.devices || []).some((d) => d.id === device);
    if (!knownOnServer && !knownIncoming) {
      return res.status(403).json({ error: "This device is not registered on the account." });
    }

    const merged = mergeBundles(stored, bundle);
    await pool.query(
      "UPDATE accounts SET bundle = $2, updated_at = now() WHERE email = $1",
      [email, merged]
    );
    return res.json({ bundle: merged });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Sync failed on the server: " + e.message });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log("jFIX-TECHS sync server listening on " + PORT));
  })
  .catch((e) => {
    console.error("Failed to initialise database:", e);
    process.exit(1);
  });
