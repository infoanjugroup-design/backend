const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { server, uploads, nocodb: nocodbConfig } = require('./config');
const nc = require('./nocodb');
const { route } = require('./actions');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // base64 file uploads ride in the JSON body

fs.mkdirSync(uploads.dir, { recursive: true });
app.use('/uploads', express.static(uploads.dir));

// This is the ONE endpoint your existing frontend already calls — it
// pastes this server's URL into the same "Database URL" box that used
// to hold the Apps Script /exec URL. Same request/response contract:
// POST { action, ...params } -> { status: 'success'|'error', message, data }
app.post(['/', '/exec'], async (req, res) => {
  try {
    const out = await route(req.body || {});
    res.json(out);
  } catch (e) {
    res.json({ status: 'error', message: 'Server error: ' + e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Manual trigger — visit this in the browser anytime to (re)run table
// setup without redeploying. ?baseId=xxxx overrides the configured base.
app.get('/setup-tables', async (req, res) => {
  try {
    const manualBaseId = req.query.baseId || null;
    const result = await nc.ensureAllTables(manualBaseId);
    res.json({ status: 'success', message: 'All tables ready in NocoDB.', data: result });
  } catch (e) {
    res.json({ status: 'error', message: e.message, details: e.details || e.response?.data || null });
  }
});

async function start() {
  console.log('Connecting to NocoDB and ensuring all tables exist...');
  try {
    await nc.ensureAllTables(nocodbConfig.baseId || null);
    console.log('✓ All tables ready in NocoDB.');
  } catch (e) {
    console.error('✗ Could not set up NocoDB tables on boot:', e.details || e.response?.data || e.message);
    console.error('  Server will still start. Visit /setup-tables in the browser to retry manually,');
    console.error('  or /setup-tables?baseId=YOUR_BASE_ID to override the base.');
  }
  app.listen(server.port, () => {
    console.log(`GATE99 backend listening on http://localhost:${server.port}`);
    console.log(`Paste this URL into the frontend's "Database URL" field.`);
  });
}

start();
