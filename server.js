// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

/* ===== ENV ===== */
const BASE_URL   = process.env.SISO_BASE_URL || 'https://lsa.siso.co';
const AUTH_TOKEN = process.env.SISO_AUTH_TOKEN || 'L2Mwz8gUdd';
const AUTH_KEY   = process.env.SISO_AUTH_KEY   || '13b3dc30-971c-440a-81ee-4f99026d44e7';
const TECH_PASSWORD = process.env.TECH_PASSWORD || 'tech123';

// Optional debug
const DEBUG_READY_LOG = String(process.env.DEBUG_READY_LOG || 'false').toLowerCase() === 'true';

const STATUS_FILE   = path.join(__dirname, 'statuses.json');   // tech overrides
const LISTS_FILE    = path.join(__dirname, 'lists.json');      // category lists
const READYIN_FILE  = path.join(__dirname, 'readyin.json');    // key -> minutes

if (!AUTH_TOKEN || !AUTH_KEY) {
  console.error('❌ Missing SISO_AUTH_TOKEN or SISO_AUTH_KEY in .env');
  process.exit(1);
}

/* ===== JSON helpers ===== */
async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw || 'null') ?? fallback;
  } catch (e) {
    if (e.code === 'ENOENT' && typeof fallback !== 'undefined') {
      await fs.writeFile(file, JSON.stringify(fallback, null, 2), 'utf8');
      return fallback;
    }
    return fallback ?? {};
  }
}
async function writeJson(file, obj) {
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}
async function readStatuses() { return readJson(STATUS_FILE, {}); }
async function writeStatuses(o){ return writeJson(STATUS_FILE, o); }
const DEFAULT_LISTS = { video:[], sound:[], lighting:[], grip:[] };
async function readLists(){ return readJson(LISTS_FILE, DEFAULT_LISTS); }
async function writeLists(l){ return writeJson(LISTS_FILE, l); }
async function readReadyIn(){ return readJson(READYIN_FILE, {}); }
async function writeReadyIn(o){ return writeJson(READYIN_FILE, o); }

/* ===== Auth for /tech & tech APIs ===== */
function techAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Technician Area"');
    return res.status(401).send('Authentication required.');
  }
  try {
    const decoded = Buffer.from(hdr.split(' ')[1], 'base64').toString();
    const pass = decoded.split(':').slice(1).join(':');
    if (pass === TECH_PASSWORD) return next();
  } catch {}
  res.setHeader('WWW-Authenticate', 'Basic realm="Technician Area"');
  return res.status(401).send('Access denied.');
}

/* ===== JWT cache ===== */
let cachedJwt = null, jwtExpiry = 0;
async function getJwt() {
  const now = Date.now();
  if (cachedJwt && now < jwtExpiry - 3000) return cachedJwt;
  const res = await axios.post(`${BASE_URL}/scripts/api/v1/jwt_request`, {}, {
    headers: { Accept:'application/json','Content-Type':'application/json', AuthToken: AUTH_TOKEN, AuthKey: AUTH_KEY },
    timeout: 8000
  });
  const token = res?.data?.token || res?.data?.response?.token;
  if (!token) throw new Error('No token returned from jwt_request');
  cachedJwt = token; jwtExpiry = Date.now() + 55*1000; return cachedJwt;
}

/* ===== Date helpers ===== */
function formatDateForApi(d) {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear(); return `${dd}/${mm}/${yyyy}`;
}
function parseStartDateParts(startdatetime) {
  if (!startdatetime) return null;
  const s = String(startdatetime), datePart = s.split(' ')[0];
  if (datePart.includes('/')) {
    const [dd,mm,yyyy] = datePart.split('/');
    return { d:+dd, m:+mm, y:+yyyy };
  }
  if (datePart.includes('-')) {
    const [yyyy,mm,dd] = datePart.split('-');
    return { d:+dd, m:+mm, y:+yyyy };
  }
  const dt = new Date(s.replace(' ','T'));
  if (!isNaN(dt)) return { d: dt.getDate(), m: dt.getMonth()+1, y: dt.getFullYear() };
  return null;
}
function isSameDayStart(startdatetime, day) {
  const p = parseStartDateParts(startdatetime); if (!p) return false;
  return p.y===day.getFullYear() && p.m===(day.getMonth()+1) && p.d===day.getDate();
}
function getTimeBucket(datetimeString, minutes = 5) {
  if (!datetimeString) return 'Unknown';
  const raw = String(datetimeString);
  let d = new Date(raw.replace(' ', 'T'));
  if (isNaN(d)) {
    const p = parseStartDateParts(raw);
    if (p) {
      const time = raw.split(' ')[1] || '00:00:00';
      d = new Date(`${p.y}-${String(p.m).padStart(2,'0')}-${String(p.d).padStart(2,'0')}T${time}`);
    }
  }
  if (isNaN(d)) return raw;
  const ms = minutes*60*1000, bucket = new Date(Math.floor(d.getTime()/ms)*ms);
  return bucket.toISOString();
}
function makeGroupKey(username, startdatetime) {
  return `${(username||'Unknown').trim()}_${(startdatetime||'Unknown').trim()}`;
}

/* ===== Category from lists.json ===== */
function norm(s){ return (s||'').toString().trim().toLowerCase(); }
function inList(name, arr) {
  if (!name || !Array.isArray(arr)) return false;
  const n = norm(name);
  if (arr.some(x => norm(x) === n)) return true;
  return arr.some(x => n.includes(norm(x)) || norm(x).includes(n));
}
function categoryFromLists(assetName, lists) {
  if (inList(assetName, lists.video))    return 'video';
  if (inList(assetName, lists.sound))    return 'sound';
  if (inList(assetName, lists.lighting)) return 'lighting';
  if (inList(assetName, lists.grip))     return 'grip';
  return 'uncategorised';
}

/* ===== Collected / Picked detectors ===== */
const COLLECTED_PATTERNS = [
  'collected','collected in full','collected in part',
  'issued','on loan','checked out','checked-out','checkedout',
  'loan started','loan active','dispatched','handed over','taken',
  'returned','complete','completed'
];
const PICKED_PATTERNS = [
  'picked','prepped','prepared','preparing','staged','ready','ready for collection'
];
function containsAny(hay, needles){
  const s = String(hay).toLowerCase();
  return needles.some(k => s.includes(k));
}

/* ===== Routes ===== */

// redirect direct file hit to protected route
app.get(['/tech.html','/public/tech.html'], (req,res)=> res.redirect(302, '/tech'));

// protect /tech
app.use('/tech', techAuth);
app.get('/tech', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tech.html'));
});

// public static
app.use('/', express.static(path.join(__dirname, 'public')));

/* lists management */
app.get('/api/lists', async (_req, res) => {
  const lists = await readLists();
  res.json({ success: true, lists });
});
app.post('/api/lists', techAuth, async (req, res) => {
  const incoming = req.body || {};
  const current = await readLists();
  for (const k of ['video','sound','lighting','grip']) {
    if (Array.isArray(incoming[k])) current[k] = incoming[k].map(String);
  }
  await writeLists(current);
  res.json({ success: true, lists: current });
});

/* set / clear "ready in minutes" (TECH) */
app.post('/api/ready-in', techAuth, async (req, res) => {
  try {
    const { key, minutes } = req.body || {};
    if (!key || typeof minutes !== 'number') {
      return res.status(400).json({ success:false, error:'key and minutes (number) required' });
    }
    const map = await readReadyIn();
    if (minutes <= 0) delete map[key];
    else map[key] = Math.round(minutes); // store integer
    await writeReadyIn(map);
    res.json({ success:true, key, minutes: map[key] || 0 });
  } catch (e) {
    res.status(500).json({ success:false, error:e.message });
  }
});

/* bookings for today */
app.get('/api/bookings', async (req, res) => {
  try {
    const today = new Date();
    const jwt = await getJwt();
    const { data } = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers: { Accept:'application/json', Authorization:`Bearer ${jwt}` },
      params: { date: formatDateForApi(today), limit: 1000, _: Date.now() },
      timeout: 12000
    });

    let rows = data?.response || [];
    rows = rows.filter(r =>
      r.currentstatus &&
      !String(r.currentstatus).toLowerCase().includes('booking request') &&
      isSameDayStart(r.startdatetime, today)
    );

    const lists = await readLists();
    const grouped = {};
    for (const r of rows) {
      const username = (r.username || r.userbarcode || 'Unknown').trim();
      const bucket = getTimeBucket(r.startdatetime, 5);
      const key = makeGroupKey(username, bucket);

      if (!grouped[key]) grouped[key] = { username, startdatetime: bucket, assets: [], statuses: [] };

      const assetName = r.assetname || '';
      grouped[key].assets.push({ name: assetName, category: categoryFromLists(assetName, lists) });
      grouped[key].statuses.push(String(r.currentstatus).toLowerCase());
    }

    const techOverrides = await readStatuses();
    const readyInMap   = await readReadyIn();

    const bookings = Object.values(grouped).map(g => {
      const statusesLower = g.statuses.map(s => String(s).toLowerCase());
      const countCollected = statusesLower.filter(s => containsAny(s, COLLECTED_PATTERNS)).length;
      const countPickedOrBeyond = statusesLower.filter(s =>
        containsAny(s, PICKED_PATTERNS) || containsAny(s, COLLECTED_PATTERNS)
      ).length;
      const total = statusesLower.length;
      const allCollected = total > 0 && countCollected === total;

      let status = 'Not Picked';
      if (countPickedOrBeyond === 0) status = 'Not Picked';
      else if (countPickedOrBeyond < total) status = 'Preparing';
      else status = 'Ready for Collection';

      const key = makeGroupKey(g.username, g.startdatetime);
      if (!allCollected && techOverrides[key]) {
        const o = String(techOverrides[key]).toLowerCase();
        if (o==='preparing') status='Preparing';
        else if (o==='ready') status='Ready for Collection';
        else if (o==='notpicked' || o==='not picked') status='Not Picked';
      }

      if (DEBUG_READY_LOG && status === 'Ready for Collection' && !allCollected) {
        console.log('[DEBUG READY] Group:', key, 'statuses:', statusesLower);
      }

      return {
        username: g.username,
        startdatetime: g.startdatetime,
        assets: g.assets,
        status,
        readyInMinutes: Number(readyInMap[key] || 0),
        _groupKey: key,
        _allCollected: allCollected
      };
    })
    .filter(b => !b._allCollected); // hide fully collected groups

    res.json({ success: true, bookings });
  } catch (e) {
    console.error('Error /api/bookings', e.response?.data || e.message);
    res.status(500).json({ success:false, error: e.response?.data || e.message });
  }
});

/* status override (TECH) */
app.post('/api/update-status', techAuth, async (req, res) => {
  try {
    const { key, status } = req.body || {};
    const allowed = ['preparing','ready','notpicked','not picked','clear'];
    if (!key || !allowed.includes(String(status).toLowerCase()))
      return res.status(400).json({ success:false, error:'Missing key or invalid status' });

    // write override
    const statuses = await readStatuses();
    if (String(status).toLowerCase()==='clear') delete statuses[key];
    else statuses[key] = String(status).toLowerCase();
    await writeStatuses(statuses);

    // if set to ready, clear any "ready in" hint
    if (String(status).toLowerCase() === 'ready') {
      const map = await readReadyIn();
      if (map[key]) { delete map[key]; await writeReadyIn(map); }
    }

    res.json({ success:true, key, status: statuses[key] || null });
  } catch (e) {
    console.error('Error /api/update-status', e);
    res.status(500).json({ success:false, error: e.message });
  }
});

/* start */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SISO dashboard backend running at http://localhost:${PORT}`);
  console.log('🔐 /tech protected with Basic Auth');
});
