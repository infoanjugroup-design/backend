
const axios = require('axios');
const { nocodb } = require('./config');
const { TABLES } = require('./schema');

const http = axios.create({
  baseURL: nocodb.url,
  headers: { 'xc-token': nocodb.token, 'Content-Type': 'application/json' },
  timeout: 30000,
});

const MIN_GAP_MS = 500;
let queueTail = Promise.resolve();
let lastCallAt = 0;
function enqueue(fn) {
  const run = async () => {
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  };
  const result = queueTail.then(run, run);
  queueTail = result.catch(() => {});
  return result;
}

async function withRetry(fn, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await enqueue(fn);
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      const isThrottle = status === 420 || status === 429;
      const retriable = !status || isThrottle || status >= 500 || e.code === 'ECONNRESET' || e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT';
      if (!retriable || i === attempts - 1) throw e;
      const delay = isThrottle ? 2500 * (i + 1) : 300 * (i + 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

let baseId = null;
const tableIdByName = {};

const CACHE_TTL_MS = {
  Courses: 30000, Subjects: 30000, Topics: 30000, Lectures: 30000, Books: 30000, FreeCourses: 30000,
  PaymentSettings: 60000, Admins: 20000, AdminLogs: 20000, Bills: 15000,
  Tests: 20000, Pyqs: 20000, Students: 10000, Enrollments: 10000, StudentBooks: 10000,
  Purchases: 8000, Feedbacks: 8000, Doubts: 6000, DoubtReplies: 6000, Attempts: 6000, OTPs: 5000,
  PerfSummary: 5000,
  default: 8000,
};
const rowCache = new Map();

function cacheGet(tableName) {
  const entry = rowCache.get(tableName);
  if (entry && entry.expiresAt > Date.now()) {
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
  const known = (manualBaseId || nocodb.baseId || '').trim();
  if (known) {
    console.log(`[nocodb] Using known base ID from config/param: "${known}" — skipping base list/create.`);
    baseId = known;
    return baseId;
  }
  console.log('[nocodb] No baseId configured — falling back to /api/v2/meta/bases list/create.');
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
      } catch (e) {}
    }
  }
  tableIdByName[tableName] = table.id;
  return table.id;
}

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

async function findRecordRaw(tableName, keyCol, keyVal) {
  const id = tableId(tableName);
  const where = `(${keyCol},eq,${String(keyVal).replace(/[()]/g, '')})`;
  const { data } = await withRetry(() => http.get(`/api/v2/tables/${id}/records`, {
    params: { where, limit: 1 },
  }));
  const list = data.list || [];
  return list[0] || null;
}

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
