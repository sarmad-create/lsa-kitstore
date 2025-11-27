// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs').promises;
const fssync = require('fs');
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
const DEBUG_READY_LOG = String(process.env.DEBUG_READY_LOG || 'false').toLowerCase() === 'true';

// Writable data dir (Render-safe). Override with DATA_DIR if you mount a disk.
const DATA_DIR = process.env.DATA_DIR || '/tmp/siso-data';
if (!fssync.existsSync(DATA_DIR)) { fssync.mkdirSync(DATA_DIR, { recursive: true }); }

const STATUS_FILE  = path.join(DATA_DIR, 'statuses.json');  // tech overrides
const LISTS_FILE   = path.join(DATA_DIR, 'lists.json');     // category lists (optional overrides)
const READYIN_FILE = path.join(DATA_DIR, 'readyin.json');   // key -> minutes hint

// Seed lists.json on first run (if not present)
const DEFAULT_LISTS = { video:[], sound:[], lighting:[], grip:[] };

console.log('▶️ Using DATA_DIR:', DATA_DIR);

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
async function readStatuses()   { return readJson(STATUS_FILE, {}); }
async function writeStatuses(o) { return writeJson(STATUS_FILE, o); }
async function readLists()      { return readJson(LISTS_FILE, DEFAULT_LISTS); }
async function writeLists(l)    { return writeJson(LISTS_FILE, l); }
async function readReadyIn()    { return readJson(READYIN_FILE, {}); }
async function writeReadyIn(o)  { return writeJson(READYIN_FILE, o); }

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

/* ===== Category logic (dynamic + optional lists.json override) ===== */
function norm(s){ return (s||'').toString().trim().toLowerCase(); }

function inList(name, arr) {
  if (!name || !Array.isArray(arr)) return false;
  const n = norm(name);
  if (arr.some(x => norm(x) === n)) return true;   // exact match
  return arr.some(x => n.includes(norm(x)) || norm(x).includes(n)); // fuzzy
}

// Heuristic category from name if not explicitly listed
function inferCategoryFromName(assetName) {
  const n = norm(assetName);
  const has = (w) => n.includes(w);

  // Video
  if (has('camera') || has('camcorder') || has('a7') || has('fx3') || has('fx6') || has('fx9') ||
      has('lens') || has('anamorphic') || has('xeen') || has('g-master') || has('clapper') ||
      has('monitor') || has('director\'s monitor') || has('vaxis') || has('gopro') || has('hero'))
    return 'video';

  // Sound
  if (has('mic') || has('microphone') || has('ntg') || has('rode') || has('zoom ') || has('zoom h') ||
      has('zoom f') || has('shure') || has('sony radio') || has('ecm') || has('recorder') ||
      has('podcast') || has('boom pole') || has('blimp') || has('headphones'))
    return 'sound';

  // Lighting
  if (has('light') || has('panel') || has('tube') || has('aputure') || has('amaran') || has('novap') ||
      has('nova p') || has('storm 80c') || has('sky panel') || has('skypanel') || has('dedo') ||
      has('reflector') || has('softbox') || has('rc60') || has('rc120') || has('m160') || has('rm120'))
    return 'lighting';

  // Grip
  if (has('tripod') || has('stand') || has('c-stand') || has('c stand') || has('slider') || has('ronin') ||
      has('rs 3') || has('rs3') || has('rs4') || has('easyrig') || has('shoulder rig') ||
      has('shoulder') || has('smallrig') || has('libec') || has('monopod') || has('autopole') ||
      has('rig') || has('gimbal'))
    return 'grip';

  return 'uncategorised';
}

// Final category resolver: lists.json override -> heuristics -> uncategorised
function categoryForAsset(assetName, lists) {
  const name = assetName || '';
  // lists.json as explicit override
  if (inList(name, lists.video))    return 'video';
  if (inList(name, lists.sound))    return 'sound';
  if (inList(name, lists.lighting)) return 'lighting';
  if (inList(name, lists.grip))     return 'grip';
  // otherwise infer from name
  return inferCategoryFromName(name);
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

// health/version
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local',
    dataDir: DATA_DIR,
    time: new Date().toISOString()
  });
});

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
    else map[key] = Math.round(minutes);
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
      grouped[key].assets.push({
        name: assetName,
        category: categoryForAsset(assetName, lists)  // ⬅ dynamic + lists override
      });
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
  console.log('📦 Data dir:', DATA_DIR);
});
