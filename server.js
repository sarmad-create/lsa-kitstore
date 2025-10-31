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

const STATUS_FILE              = path.join(__dirname, 'statuses.json');       // tech overrides for booking status
const CATEGORY_OVERRIDES_FILE  = path.join(__dirname, 'categories.json');     // per-asset manual category override
const LISTS_FILE               = path.join(__dirname, 'lists.json');          // curated category name lists

if (!AUTH_TOKEN || !AUTH_KEY) {
  console.error('❌ Missing SISO_AUTH_TOKEN or SISO_AUTH_KEY in .env');
  process.exit(1);
}

/* --------------------------
   Basic Auth for tech routes
   -------------------------- */
const TECH_PASSWORD = process.env.TECH_PASSWORD || 'tech123'; // change in .env

function techAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Technician Area"');
    return res.status(401).send('Authentication required.');
  }
  const base64 = authHeader.split(' ')[1];
  let user = '', pass = '';
  try {
    [user, pass] = Buffer.from(base64, 'base64').toString().split(':');
  } catch {
    res.setHeader('WWW-Authenticate', 'Basic realm="Technician Area"');
    return res.status(401).send('Invalid auth.');
  }
  if (pass === TECH_PASSWORD) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Technician Area"');
  return res.status(401).send('Access denied.');
}

/* --------------------------
   File helpers (JSON)
   -------------------------- */
async function readJson(file, fallbackObj) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw || 'null') ?? fallbackObj;
  } catch (e) {
    if (e.code === 'ENOENT' && typeof fallbackObj !== 'undefined') {
      await fs.writeFile(file, JSON.stringify(fallbackObj, null, 2), 'utf8');
      return fallbackObj;
    }
    console.error(`Error reading ${path.basename(file)}`, e);
    return fallbackObj ?? {};
  }
}
async function writeJson(file, obj) {
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

/* --------------------------
   categories.json (per-asset overrides)
   -------------------------- */
async function readCategoryOverrides() { return readJson(CATEGORY_OVERRIDES_FILE, {}); }
async function writeCategoryOverrides(map) { return writeJson(CATEGORY_OVERRIDES_FILE, map); }
function normalizeNameKey(name) { return (name || '').toString().trim().toLowerCase(); }

/* --------------------------
   lists.json (curated name lists)
   -------------------------- */
const DEFAULT_LISTS = {
  grip: [
    "C-Stand","DJI Ronin S","DJI RS 3","DJI RS 4","DJI RS4 PRO COMBO  Gimbal Stabiliser",
    "Easyrig","iFootage Slider","Libec Tripod","Manfrotto Autopole","Manfrotto Monopod",
    "Sachtler Tripods","Slider","SmallRig FreeBlazer Tripod","SmallRig Shoulder Rig","SmallRig Tripod"
  ],
  video: [
    "12-24mm",'12" SWIT Monitor',"28-135mm","28mm","35mm","50mm","A6000","A7IV","A7IV + Cage","A7SIII",
    "Anamorphic Blazer Lens kit",'BlackMagic 5" Monitor','BlackMagic 7" Monitor',"Bolex H16 Camera",
    "Clapperboard","Cooke S4 Lens kit (18-40mm)","Cooke S4 Lens kit (55-100mm)","Director's Monitor",
    "DJI Focus Pro","Fisheye Lens 7.5mm","G-MASTER 24-70mm","GM - FE 2.8/12-24 - Sony Lens",
    "Go Pro Hero10",'Monitor SmallHD Cine 13" Production Monitor',"ND Filters 49mm","ND Filters 55mm",
    "ND Filters 77mm","SAMYANG Lenses","Sirui Nightwalker Lens Set","Sony A7SII","Sony FE 24-105mm F4",
    "Sony FE 24-70mm F4","Sony FE 28-70mm F4","Sony FX30","Sony FX6 - Alumni Only","Sony FX9",
    "Sony NX 200 Camcorders","Swit 5.5' monitor","Tilta Nucleus Nano II","VAXIS","XEEN CF Lenses","ZV-E10 II"
  ],
  lighting: [
    "Amaran 200D","Amaran P60X Light","Amaran Tube Lights PT4C","Aputure Nova P300","Cambees Light Panels",
    "Dedo Boxes","LitePanels x3","Neewer LightPanel","Reflector","Sky Panel Lights","SmallRig M160",
    "Smallrig RC120B","Smallrig RC60B + Parabolic Softbox","Sony Top Shoe Light","Storm 80c"
  ],
  sound: [
    "4 Way Splitter","AKG Harman, C414 XLII","ALUMNI ONLY - Sony Radio Mic Set + XLR Transmitter",
    "Blimp mic w/ Dead cat","Boom pole","DJI Mic 1","DJI Mic 2","Headphones","K-TEK INDIE Cabled Boom Pole",
    "Long XLR (FtM)","RODECaster Pro II","RODE NTG-1","RODE NTH Headphones","Rode Pistol Grip",
    "Rode Top Shoe Video Mic","Short XLR (FtM)","SHURE SM58 Dynamic Microphone","Sony ECM Mic",
    "Sony Radio Boom Mic Receiver + Transmiter","Sony Radio Mic Kit","TONOR Wireless Smartphone Mic",
    "Zoom F6","Zoom H5","Zoom Mic Podcast Pack"
  ]
};
async function readLists() { return readJson(LISTS_FILE, DEFAULT_LISTS); }
async function writeLists(lists) { return writeJson(LISTS_FILE, lists); }

/* --------------------------
   Normalization & matching
   -------------------------- */
function norm(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[^\p{L}\p{N}\s'"-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function buildSetsFromLists(lists) {
  const toSet = arr => new Set((arr || []).map(norm));
  return {
    gripSet: toSet(lists.grip),
    videoSet: toSet(lists.video),
    lightingSet: toSet(lists.lighting),
    soundSet: toSet(lists.sound),
  };
}
function categoryFromProvidedLists(assetName, sets) {
  const n = norm(assetName);
  if (!n) return null;
  const { gripSet, videoSet, lightingSet, soundSet } = sets;

  if (gripSet.has(n)) return 'grip';
  if (videoSet.has(n)) return 'video';
  if (lightingSet.has(n)) return 'lighting';
  if (soundSet.has(n)) return 'sound';

  for (const v of gripSet)     { if (v && n.includes(v)) return 'grip'; }
  for (const v of videoSet)    { if (v && n.includes(v)) return 'video'; }
  for (const v of lightingSet) { if (v && n.includes(v)) return 'lighting'; }
  for (const v of soundSet)    { if (v && n.includes(v)) return 'sound'; }

  return null;
}
function strongLightingByName(assetName) {
  const n = norm(assetName);
  const patterns = [
    /\brm[-\s]?120b?\b/i,
    /\brm[-\s]?75b?\b/i,
    /\bpocket\s*light\b/i,
    /\bmini\s*led\b/i,
    /\bled\s*panel\b/i,
  ];
  return patterns.some(rx => rx.test(n)) || (n.includes('smallrig') && n.includes('rm'));
}
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

/* --------------------------
   JWT cache
   -------------------------- */
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

/* --------------------------
   Date & grouping helpers
   -------------------------- */
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

/* --------------------------
   Status file helpers
   -------------------------- */
async function readStatuses() { return readJson(STATUS_FILE, {}); }
async function writeStatuses(obj) { return writeJson(STATUS_FILE, obj); }

/* --------------------------
   Category decision priority
   1) categories.json override
   2) lists.json (your curated lists)
   3) strong lighting by name
   4) SISO fields (lighting→video→sound→grip)
   5) generic name heuristic
   -------------------------- */
function decideCategory(row, assetName, overridesMap, sets) {
  const override = (overridesMap || {})[normalizeNameKey(assetName)];
  if (override && ['video','sound','lighting','grip','uncategorised'].includes(override)) return override;

  const fromLists = categoryFromProvidedLists(assetName, sets);
  if (fromLists) return fromLists;

  if (strongLightingByName(assetName)) return 'lighting';

  const rawCandidates = [
    row.assetcategoryname, row.categoryname, row.assetcategory, row.category,
    row.assettypecategory, row.groupname, row.department, row.parentcategory, row.subcategory
  ].map(v => (v == null ? '' : String(v).trim().toLowerCase())).filter(Boolean);

  if (anyMatchesBucket(rawCandidates, 'lighting')) return 'lighting';
  if (anyMatchesBucket(rawCandidates, 'video'))    return 'video';
  if (anyMatchesBucket(rawCandidates, 'sound'))    return 'sound';
  if (anyMatchesBucket(rawCandidates, 'grip'))     return 'grip';

  const n = norm(assetName);
  if (/(camera|lens|a7|fx|fs|a6000)/i.test(n)) return 'video';
  if (/(mic|microphone|rode|ntg|shotgun|zoom h|tascam)/i.test(n)) return 'sound';
  if (/(light|aputure|amaran|nanlite|godox|led)/i.test(n)) return 'lighting';
  if (/(tripod|sachtler|manfrotto|smallrig|stand|c-stand|arm|clamp)/i.test(n)) return 'grip';
  return 'uncategorised';
}

/* --------------------------
   Routes
   -------------------------- */

// Secure the technician dashboard page
app.get('/tech', techAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tech.html'));
});

// Public: view lists.json
app.get('/api/lists', async (_req, res) => {
  const lists = await readLists();
  res.json({ success: true, lists });
});

// Secure: update lists.json
app.post('/api/lists', techAuth, async (req, res) => {
  try {
    const incoming = req.body || {};
    const lists = await readLists();
    const keys = ['grip','video','lighting','sound'];
    for (const k of keys) {
      if (Array.isArray(incoming[k])) lists[k] = incoming[k].map(v => String(v));
    }
    await writeLists(lists);
    res.json({ success: true, lists });
  } catch (e) {
    console.error('Error /api/lists', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Secure: manual category override
app.post('/api/category-override', techAuth, async (req, res) => {
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

// Public: bookings for today
app.get('/api/bookings', async (req, res) => {
  try {
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

    // Only real bookings
    rows = rows.filter(r =>
      r.currentstatus &&
      !String(r.currentstatus).toLowerCase().includes('booking request')
    );

    // Only today's date
    rows = rows.filter(r => isSameDayStart(r.startdatetime, today));

    const overridesMap = await readCategoryOverrides();
    const lists = await readLists();
    const sets = buildSetsFromLists(lists);

    // Group by user + 5-min time bucket
    const grouped = {};
    for (const r of rows) {
      const username = (r.username || r.userbarcode || 'Unknown').trim();
      const bucket = getTimeBucket(r.startdatetime, 5);
      const key = makeGroupKey(username, bucket);

      const decidedCat = decideCategory(r, r.assetname, overridesMap, sets);

      if (!grouped[key]) {
        grouped[key] = { username, startdatetime: bucket, assets: [], statuses: [] };
      }
      grouped[key].assets.push({ name: r.assetname, category: decidedCat });
      grouped[key].statuses.push(String(r.currentstatus).toLowerCase());
    }

    // compute status + apply tech overrides
    const techOverrides = await readStatuses();
    const bookings = Object.values(grouped).map(g => {
      const pickedKeywords = ['picked', 'ready', 'collected', 'complete', 'completed', 'returned', 'issued'];
      const pickedOrReady = g.statuses.filter(s => pickedKeywords.some(k => s.includes(k))).length;
      const total = g.statuses.length;

      let autoStatus = 'Not Picked';
      if (pickedOrReady === 0) autoStatus = 'Not Picked';
      else if (pickedOrReady < total) autoStatus = 'Preparing';
      else autoStatus = 'Ready for Collection';

      const key = makeGroupKey(g.username, g.startdatetime);
      if (techOverrides[key]) {
        const o = String(techOverrides[key]).toLowerCase();
        if (o === 'preparing') autoStatus = 'Preparing';
        else if (o === 'ready') autoStatus = 'Ready for Collection';
        else if (o === 'notpicked' || o === 'not picked') autoStatus = 'Not Picked';
      }

      return {
        username: g.username,
        startdatetime: g.startdatetime,
        assets: g.assets, // [{ name, category }]
        status: autoStatus,
        _groupKey: key
      };
    });

    res.json({ success: true, bookings });
  } catch (err) {
    console.error('Error /api/bookings', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// Secure: tech status override (buttons)
app.post('/api/update-status', techAuth, async (req, res) => {
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

// Debug: see tech overrides
app.get('/api/overrides', async (_req, res) => {
  const statuses = await readStatuses();
  res.json({ success: true, overrides: statuses });
});

/* --------------------------
   Start server
   -------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SISO dashboard backend running at http://localhost:${PORT}`);
  console.log('🔐 TECH_PASSWORD protection active on /tech and tech-only APIs');
});
