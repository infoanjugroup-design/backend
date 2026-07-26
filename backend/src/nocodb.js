const axios = require('axios');
const { nocodb } = require('./config');
const { TABLES } = require('./schema');

const http = axios.create({
  baseURL: nocodb.url,
  headers: { 'xc-token': nocodb.token, 'Content-Type': 'application/json' },
  timeout: 30000,
});

/* ---------------- resilience: retry transient failures ----------------
   NocoDB (like any network service) occasionally hiccups — a dropped
   connection, a 429 (rate limited), a brief 502/503 while it's busy.
   Without a retry, any one of those turns into a visible error for the
   student/admin even though the very next attempt would have worked.
   This wraps every NocoDB call so a single transient failure gets
   retried a couple of times with a short backoff before giving up. */
async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      const retriable = !status || status === 429 || status >= 500 || e.code === 'ECONNRESET' || e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT';
      if (!retriable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1))); // 300ms, 600ms, ...
    }
  }
  throw lastErr;
}

// In-memory cache of NocoDB's internal ids for our base + each table,
// so we hit the Meta API once at boot instead of on every request.
let baseId = null;
const tableIdByName = {};

/* ---------------- per-table read cache (mirrors the original
   Apps-Script CACHE_TTL_ idea) ----------------
   Tables that barely change (course/content structure) are cached
   longer — far fewer NocoDB round-trips under normal browsing load.
   Tables that change fast or gate security (OTPs, Attempts,
   Purchases) get a short TTL so nothing stale-serves past what's
   safe. Every write to a table invalidates that table's cache entry
   immediately, so a save/delete is always reflected on the very next
   read — this is a speed layer, never a staleness risk beyond its TTL. */
const CACHE_TTL_MS = {
  Courses: 30000, Subjects: 30000, Topics: 30000, Lectures: 30000, Books: 30000, FreeCourses: 30000,
  PaymentSettings: 60000, Admins: 20000, AdminLogs: 20000, Bills: 15000,
  Tests: 20000, Pyqs: 20000, Students: 10000, Enrollments: 10000, StudentBooks: 10000,
  Purchases: 8000, Feedbacks: 8000, Doubts: 6000, DoubtReplies: 6000, Attempts: 6000, OTPs: 5000,
  PerfSummary: 5000,
  default: 8000,
};
const rowCache = new Map(); // tableName -> { data, expiresAt }

function cacheGet(tableName) {
  const entry = rowCache.get(tableName);
  if (entry && entry.expiresAt > Date.now()) {
    // Deep-clone on the way out — callers sometimes mutate a row object
    // in place before saving it back; that must never corrupt the
    // shared cached copy other requests are also reading.
    return JSON.parse(JSON.stringify(entry.data));
  }
  return null;
}
function cacheSet(tableName, data) {
  const ttl = CACHE_TTL_MS[tableName] || CACHE_TTL_MS.default;
  rowCache.set(tableName, { data, expiresAt: Date.now() + ttl });
}
function invalidateCache(tableName) {
  rowCache.delete(tableName);
}

async function findOrCreateBase(manualBaseId) {
  // If we already know the base ID (env var, or passed in manually), use it
  // directly. NocoDB Cloud's fine-grained tokens frequently can't list/create
  // bases via /api/v2/meta/bases even with "Base" permission granted, so
  // skipping that call entirely avoids the ERR_FORBIDDEN it triggers.
  const known = manualBaseId || nocodb.baseId;
  if (known) {
    baseId = known;
    return baseId;
  }
  const { data } = await withRetry(() => http.get('/api/v2/meta/bases'));
  const list = data.list || [];
  let base = list.find((b) => b.title === nocodb.baseName);
  if (!base) {
    const res = await withRetry(() => http.post('/api/v2/meta/bases', { title: nocodb.baseName }));
    base = res.data;
  }
  baseId = base.id;
  return baseId;
}

async function findOrCreateTable(tableName, columns) {
  const { data } = await withRetry(() => http.get(`/api/v2/meta/bases/${baseId}/tables`));
  const list = data.list || [];
  let table = list.find((t) => t.title === tableName || t.table_name === tableName);

  if (!table) {
    const columnDefs = columns.map((c) => ({ column_name: c, title: c, uidt: 'SingleLineText' }));
    const res = await withRetry(() => http.post(`/api/v2/meta/bases/${baseId}/tables`, {
      table_name: tableName,
      title: tableName,
      columns: columnDefs,
    }));
    table = res.data;
  } else {
    // Migration: add any columns that exist in schema.js but not yet
    // in this NocoDB table (mirrors the original ensureTable_ behaviour
    // of appending missing headers without touching existing ones).
    const { data: full } = await withRetry(() => http.get(`/api/v2/meta/tables/${table.id}`));
    const existingCols = (full.columns || []).map((c) => c.title);
    const missing = columns.filter((c) => existingCols.indexOf(c) === -1);
    for (const col of missing) {
      try {
        await withRetry(() => http.post(`/api/v2/meta/tables/${table.id}/columns`, {
          column_name: col,
          title: col,
          uidt: 'SingleLineText',
        }));
      } catch (e) {
        // best-effort — don't fail boot over one column
      }
    }
  }
  tableIdByName[tableName] = table.id;
  return table.id;
}

// Call once at startup. Creates the base + every table in schema.js
// if they don't already exist. Safe to call again any time (e.g. a
// 'linkDatabase' action re-running it) — it's all idempotent.
async function ensureAllTables(manualBaseId) {
  await findOrCreateBase(manualBaseId);
  const failed = [];
  for (const [name, columns] of Object.entries(TABLES)) {
    try {
      await findOrCreateTable(name, columns);
    } catch (e) {
      failed.push({ table: name, error: e.response?.data || e.message });
    }
  }
  if (failed.length) {
    const err = new Error(
      `${failed.length} table(s) could not be set up: ` +
      failed.map((f) => `${f.table} (${f.error?.message || f.error})`).join(', ')
    );
    err.details = failed;
    throw err;
  }
  return getTableCounts();
}

async function getTableCounts() {
  const out = [];
  for (const name of Object.keys(TABLES)) {
    const rows = await getAllRows(name);
    out.push({ table: name, rows: rows.length });
  }
  return out;
}

function tableId(name) {
  const id = tableIdByName[name];
  if (!id) throw new Error(`Table "${name}" is not known yet — call ensureAllTables() first.`);
  return id;
}

// Strips NocoDB's internal Id / system fields from a record so the
// shape returned to the frontend matches the original Sheets rows
// exactly (only the columns declared in schema.js).
function toPlainRow(record, columns) {
  const obj = {};
  columns.forEach((c) => {
    obj[c] = record[c] !== undefined ? record[c] : '';
  });
  return obj;
}

async function getAllRows(tableName) {
  const cached = cacheGet(tableName);
  if (cached) return cached;

  const id = tableId(tableName);
  const columns = TABLES[tableName];
  let offset = 0;
  const limit = 1000;
  const rows = [];
  // NocoDB paginates; loop until pageInfo says we've read everything.
  for (;;) {
    const { data } = await withRetry(() => http.get(`/api/v2/tables/${id}/records`, {
      params: { limit, offset },
    }));
    const list = data.list || [];
    list.forEach((r) => rows.push(toPlainRow(r, columns)));
    const info = data.pageInfo || {};
    if (info.isLastPage !== false && (info.isLastPage || list.length < limit)) break;
    offset += limit;
  }
  cacheSet(tableName, rows);
  return rows;
}

// Finds the NocoDB internal record (with its numeric Id) matching
// keyCol=keyVal — needed to PATCH/DELETE a specific row. Always a
// live lookup (never cached) since saveRow/deleteRow need the exact
// current Id right before writing.
async function findRecordRaw(tableName, keyCol, keyVal) {
  const id = tableId(tableName);
  const where = `(${keyCol},eq,${String(keyVal).replace(/[()]/g, '')})`;
  const { data } = await withRetry(() => http.get(`/api/v2/tables/${id}/records`, {
    params: { where, limit: 1 },
  }));
  const list = data.list || [];
  return list[0] || null;
}

// Upsert: update the row if keyCol already exists, else insert.
async function saveRow(tableName, keyCol, row) {
  const id = tableId(tableName);
  const existing = row[keyCol] !== undefined && row[keyCol] !== '' && row[keyCol] !== null
    ? await findRecordRaw(tableName, keyCol, row[keyCol])
    : null;
  if (existing) {
    await withRetry(() => http.patch(`/api/v2/tables/${id}/records`, { Id: existing.Id, ...row }));
  } else {
    await withRetry(() => http.post(`/api/v2/tables/${id}/records`, row));
  }
  invalidateCache(tableName);
  return true;
}

// Always inserts a new row, never updates — for append-only logs
// (AdminLogs, Attempts, OTPs, Purchases, Feedbacks, Doubts, ...).
async function appendRow(tableName, row) {
  const id = tableId(tableName);
  await withRetry(() => http.post(`/api/v2/tables/${id}/records`, row));
  invalidateCache(tableName);
  return true;
}

async function deleteRow(tableName, keyCol, keyVal) {
  const existing = await findRecordRaw(tableName, keyCol, keyVal);
  if (!existing) return false;
  const id = tableId(tableName);
  await withRetry(() => http.delete(`/api/v2/tables/${id}/records`, { data: { Id: existing.Id } }));
  invalidateCache(tableName);
  return true;
}

module.exports = {
  ensureAllTables,
  getTableCounts,
  getAllRows,
  saveRow,
  appendRow,
  deleteRow,
  findRecordRaw,
  invalidateCache,
};
