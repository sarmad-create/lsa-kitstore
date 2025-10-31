// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/', express.static(path.join(__dirname, 'public')));

const BASE_URL   = process.env.SISO_BASE_URL || 'https://lsa.siso.co';
const AUTH_TOKEN = process.env.SISO_AUTH_TOKEN || 'L2Mwz8gUdd';
const AUTH_KEY   = process.env.SISO_AUTH_KEY   || '13b3dc30-971c-440a-81ee-4f99026d44e7';
const STATUS_FILE = path.join(__dirname, 'statuses.json');
const CATEGORY_OVERRIDES_FILE = path.join(__dirname, 'categories.json');

if (!AUTH_TOKEN || !AUTH_KEY) {
  console.error('❌ Missing SISO_AUTH_TOKEN or SISO_AUTH_KEY in .env');
  process.exit(1);
}

// ---------- persisted category overrides ----------
async function readCategoryOverrides() {
  try {
    const raw = await fs.readFile(CATEGORY_OVERRIDES_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    console.error('Error reading categories.json', e);
    return {};
  }
}
async function writeCategoryOverrides(map) {
  try {
    await fs.writeFile(CATEGORY_OVERRIDES_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing categories.json', e);
  }
}
function normalizeNameKey(name) {
  return (name || '').toString().trim().toLowerCase();
}

// ---------- JWT cache ----------
let cachedJwt = null;
let jwtExpiry = 0;

async function getJwt() {
  const now = Date.now();
  if (cachedJwt && now < jwtExpiry - 3000) return cachedJwt;

  const res = await axios.post(`${BASE_URL}/scripts/api/v1/jwt_request`, {}, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      AuthToken: AUTH_TOKEN,
      AuthKey: AUTH_KEY
    },
    timeout: 8000
  });

  const token = res?.data?.token || res?.data?.response?.token;
  if (!token) throw new Error('No token returned from jwt_request');
  cachedJwt = token;
  jwtExpiry = Date.now() + 55 * 1000;
  return cachedJwt;
}

// ---------- helpers ----------
function formatDateForApi(dateObj) {
  const dd = String(dateObj.getDate()).padStart(2, '0');
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const yyyy = dateObj.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseStartDateParts(startdatetime) {
  if (!startdatetime) return null;
  const s = String(startdatetime);
  const datePart = s.split(' ')[0];

  if (datePart.includes('/')) {
    const [dd, mm, yyyy] = datePart.split('/');
    const d = Number(dd), m = Number(mm), y = Number(yyyy);
    if (!isNaN(d) && !isNaN(m) && !isNaN(y)) return { d, m, y };
  }
  if (datePart.includes('-')) {
    const [yyyy, mm, dd] = datePart.split('-');
    const d = Number(dd), m = Number(mm), y = Number(yyyy);
    if (!isNaN(d) && !isNaN(m) && !isNaN(y)) return { d, m, y };
  }
  const dt = new Date(s.replace(' ', 'T'));
  if (!isNaN(dt)) return { d: dt.getDate(), m: dt.getMonth() + 1, y: dt.getFullYear() };
  return null;
}

function isSameDayStart(startdatetime, day) {
  const p = parseStartDateParts(startdatetime);
  if (!p) return false;
  return p.y === day.getFullYear() && p.m === (day.getMonth() + 1) && p.d === day.getDate();
}

function getTimeBucket(datetimeString, minutes = 5) {
  if (!datetimeString) return 'Unknown';
  const raw = String(datetimeString);
  let d = new Date(raw.replace(' ', 'T'));
  if (isNaN(d)) {
    const p = parseStartDateParts(raw);
    if (p) {
      const { d: dd, m, y } = p;
      const time = raw.split(' ')[1] || '00:00:00';
      d = new Date(`${y}-${String(m).padStart(2,'0')}-${String(dd).padStart(2,'0')}T${time}`);
    }
  }
  if (isNaN(d)) return raw;
  const ms = minutes * 60 * 1000;
  const bucketTime = new Date(Math.floor(d.getTime() / ms) * ms);
  return bucketTime.toISOString();
}

function makeGroupKey(username, startdatetime) {
  return `${(username || 'Unknown').trim()}_${(startdatetime || 'Unknown').trim()}`;
}

// ---------- category logic ----------
const BUCKETS = ['video', 'sound', 'lighting', 'grip'];
const CATEGORY_SYNONYMS = {
  video:     ['video', 'camera', 'cameras', 'lens', 'lenses', 'optics'],
  sound:     ['sound', 'audio', 'microphone', 'microphones', 'mic', 'mics', 'recorder', 'recorders'],
  lighting:  ['lighting', 'light', 'lights', 'illumination', 'fixture', 'fixtures'],
  grip:      ['grip', 'support', 'rigging', 'stand', 'stands', 'tripod', 'tripods']
};
function anyMatchesBucket(candidates, bucket) {
  const syns = CATEGORY_SYNONYMS[bucket];
  return candidates.some(c => syns.some(s => c === s || c.includes(s)));
}

// NEW: strong Lighting name signal (applies BEFORE trusting "Grip" candidates)
function strongLightingByName(assetName) {
  const n = (assetName || '').toString().toLowerCase();
  // SmallRig RM lights & common pocket lights
  const patterns = [
    /\brm[-\s]?120b?\b/,
    /\brm[-\s]?75b?\b/,
    /\bpocket\s*light\b/,
    /\bmini\s*led\b/,
    /\bled\s*panel\b/,
  ];
  return patterns.some(rx => rx.test(n)) || (n.includes('smallrig') && n.includes('rm'));
}

function decideCategoryFromSisoFields(row, assetName, overridesMap) {
  // 0) explicit override by exact name
  const override = overridesMap[normalizeNameKey(assetName)];
  if (override && BUCKETS.includes(override)) return override;

  // 1) STRONG NAME HINT for lighting (beats a misleading 'Grip' candidate)
  if (strongLightingByName(assetName)) return 'lighting';

  // 2) aggregate SISO candidates
  const rawCandidates = [
    row.assetcategoryname,
    row.categoryname,
    row.assetcategory,
    row.category,
    row.assettypecategory,
    row.groupname,
    row.department,
    row.parentcategory,
    row.subcategory
  ];
  const candidates = rawCandidates
    .map(v => (v == null ? '' : String(v).trim().toLowerCase()))
    .filter(v => v.length > 0);

  // 3) choose by bucket priority Lighting → Video → Sound → Grip
  if (anyMatchesBucket(candidates, 'lighting')) return 'lighting';
  if (anyMatchesBucket(candidates, 'video'))    return 'video';
  if (anyMatchesBucket(candidates, 'sound'))    return 'sound';
  if (anyMatchesBucket(candidates, 'grip'))     return 'grip';

  // 4) general name heuristic (last resort)
  const n = (assetName || '').toString().toLowerCase();
  if (/(camera|lens|a7|fx|fs|a6000)/.test(n)) return 'video';
  if (/(mic|microphone|rode|ntg|shotgun|zoom h|tascam)/.test(n)) return 'sound';
  if (/(light|aputure|amaran|nanlite|godox|led)/.test(n)) return 'lighting';
  if (/(tripod|sachtler|manfrotto|smallrig|stand|c-stand|arm|clamp)/.test(n)) return 'grip';

  return 'uncategorised';
}

// ---------- statuses.json helpers ----------
async function readStatuses() {
  try {
    const raw = await fs.readFile(STATUS_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error('Error reading statuses.json', err);
    return {};
  }
}
async function writeStatuses(obj) {
  try {
    await fs.writeFile(STATUS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing statuses.json', err);
  }
}

// ---------- routes ----------
app.get('/tech', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tech.html'));
});

// Optional: set a permanent category override by asset name
// body: { assetName: "SmallRig RM120", category: "lighting" }
app.post('/api/category-override', async (req, res) => {
  try {
    const { assetName, category } = req.body || {};
    if (!assetName || !category) {
      return res.status(400).json({ success: false, error: 'assetName and category required' });
    }
    const normCat = String(category).toLowerCase().trim();
    const allowed = ['video','sound','lighting','grip','uncategorised'];
    if (!allowed.includes(normCat)) {
      return res.status(400).json({ success: false, error: 'Invalid category' });
    }
    const map = await readCategoryOverrides();
    map[normalizeNameKey(assetName)] = normCat;
    await writeCategoryOverrides(map);
    res.json({ success: true, overrides: map });
  } catch (e) {
    console.error('Error /api/category-override', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/category-override', async (_req, res) => {
  const map = await readCategoryOverrides();
  res.json({ success: true, overrides: map });
});

app.get('/api/bookings', async (req, res) => {
  try {
    const debug = String(req.query.debug || '0') === '1';
    const today = new Date();
    const apiDate = formatDateForApi(today);
    const jwt = await getJwt();

    const response = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${jwt}`,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      params: { date: apiDate, limit: 1000, _: Date.now() },
      timeout: 12000,
    });

    let rows = response?.data?.response || [];

    // only actual bookings
    rows = rows.filter(r =>
      r.currentstatus &&
      !String(r.currentstatus).toLowerCase().includes('booking request')
    );

    // only today's
    rows = rows.filter(r => isSameDayStart(r.startdatetime, today));

    const overridesMap = await readCategoryOverrides();

    // group by user + time bucket
    const grouped = {};
    for (const r of rows) {
      const username = (r.username || r.userbarcode || 'Unknown').trim();
      const bucket = getTimeBucket(r.startdatetime, 5);
      const key = makeGroupKey(username, bucket);

      const cat = decideCategoryFromSisoFields(r, r.assetname, overridesMap);

      if (!grouped[key]) {
        grouped[key] = { username, startdatetime: bucket, assets: [], statuses: [], debugRows: debug ? [] : undefined };
      }
      grouped[key].assets.push({ name: r.assetname, category: cat });
      grouped[key].statuses.push(String(r.currentstatus).toLowerCase());

      if (debug) {
        const cands = {
          assetcategoryname: r.assetcategoryname ?? null,
          categoryname:      r.categoryname ?? null,
          assetcategory:     r.assetcategory ?? null,
          category:          r.category ?? null,
          assettypecategory: r.assettypecategory ?? null,
          groupname:         r.groupname ?? null,
          department:        r.department ?? null,
          parentcategory:    r.parentcategory ?? null,
          subcategory:       r.subcategory ?? null
        };
        grouped[key].debugRows.push({ assetname: r.assetname, candidates: cands, decided: cat });
      }
    }

    const overrides = await readStatuses();

    const bookings = Object.values(grouped).map(g => {
      const pickedKeywords = ['picked', 'ready', 'collected', 'complete', 'completed', 'returned', 'issued'];
      const pickedOrReady = g.statuses.filter(s => pickedKeywords.some(k => s.includes(k))).length;
      const total = g.statuses.length;

      let autoStatus = 'Not Picked';
      if (pickedOrReady === 0) autoStatus = 'Not Picked';
      else if (pickedOrReady < total) autoStatus = 'Preparing';
      else autoStatus = 'Ready for Collection';

      const key = makeGroupKey(g.username, g.startdatetime);
      if (overrides[key]) {
        const o = String(overrides[key]).toLowerCase();
        if (o === 'preparing') autoStatus = 'Preparing';
        else if (o === 'ready') autoStatus = 'Ready for Collection';
        else if (o === 'notpicked' || o === 'not picked') autoStatus = 'Not Picked';
      }

      const out = {
        username: g.username,
        startdatetime: g.startdatetime,
        assets: g.assets,
        status: autoStatus,
        _groupKey: key
      };
      if (g.debugRows) out._debug = g.debugRows;
      return out;
    });

    res.json({ success: true, bookings });
  } catch (err) {
    console.error('Error /api/bookings', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// tech status buttons
app.post('/api/update-status', async (req, res) => {
  try {
    const { key, status } = req.body;
    if (!key || !status) return res.status(400).json({ success: false, error: 'Missing key or status' });
    const allowed = ['preparing', 'ready', 'notpicked', 'not picked', 'clear'];
    if (!allowed.includes(String(status).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Invalid status value' });
    }

    const statuses = await readStatuses();
    if (String(status).toLowerCase() === 'clear') delete statuses[key];
    else statuses[key] = String(status).toLowerCase();

    await writeStatuses(statuses);
    res.json({ success: true, key, status: statuses[key] || null });
  } catch (err) {
    console.error('Error /api/update-status', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// debug: tech overrides
app.get('/api/overrides', async (_req, res) => {
  const statuses = await readStatuses();
  res.json({ success: true, overrides: statuses });
});

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SISO dashboard backend running at http://localhost:${PORT}`);
});
