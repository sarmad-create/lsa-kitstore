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
const TECH_PASSWORD = process.env.TECH_PASSWORD || 'tech123'; // <-- set this in .env and Render

const STATUS_FILE = path.join(__dirname, 'statuses.json');
const CATEGORY_OVERRIDES_FILE = path.join(__dirname, 'categories.json');
const LISTS_FILE = path.join(__dirname, 'lists.json');

if (!AUTH_TOKEN || !AUTH_KEY) {
  console.error('❌ Missing SISO_AUTH_TOKEN or SISO_AUTH_KEY in .env');
  process.exit(1);
}

/* ===== UTIL: JSON file helpers ===== */
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
async function readCategoryOverrides(){ return readJson(CATEGORY_OVERRIDES_FILE, {}); }
async function writeCategoryOverrides(o){ return writeJson(CATEGORY_OVERRIDES_FILE, o); }
const DEFAULT_LISTS = { grip:[], video:[], lighting:[], sound:[] };
async function readLists(){ return readJson(LISTS_FILE, DEFAULT_LISTS); }
async function writeLists(l){ return writeJson(LISTS_FILE, l); }

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

/* ===== Category helper (short) ===== */
function norm(s){return (s||'').toString().toLowerCase().trim();}
function decideCategory(row, assetName, overrides) {
  const key = norm(assetName);
  if (overrides[key]) return overrides[key];
  const raw = [
    row.assetcategoryname,row.categoryname,row.assetcategory,row.category,
    row.assettypecategory,row.groupname,row.department,row.parentcategory,row.subcategory
  ].map(v=>norm(v)).filter(Boolean).join(' ');
  if (raw.includes('lighting')) return 'lighting';
  if (raw.includes('video')||raw.includes('camera')||raw.includes('lens')) return 'video';
  if (raw.includes('sound')||raw.includes('audio')||raw.includes('mic')) return 'sound';
  if (raw.includes('grip')||raw.includes('tripod')||raw.includes('stand')) return 'grip';
  return 'uncategorised';
}

/* ===== BASIC AUTH (applies to /tech and protected APIs) ===== */
function techAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) {
    console.log('🔐 techAuth: no header -> challenge');
    res.setHeader('WWW-Authenticate', 'Basic realm="Technician Area"');
    return res.status(401).send('Authentication required.');
  }
  try {
    const decoded = Buffer.from(hdr.split(' ')[1], 'base64').toString();
    const parts = decoded.split(':'); // [username, password]
    const pass = parts.slice(1).join(':'); // support ":" in username
    if (pass === TECH_PASSWORD) {
      console.log('✅ techAuth: success');
      return next();
    }
    console.log('⛔ techAuth: wrong password');
  } catch (e) {
    console.log('⛔ techAuth: decode error', e.message);
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Technician Area"');
  return res.status(401).send('Access denied.');
}

/* ===== Routes ===== */

/* Redirect any direct /tech.html access to /tech so auth runs */
app.get(['/tech.html','/public/tech.html'], (req,res)=> res.redirect(302, '/tech'));

/* PROTECT everything under /tech first */
app.use('/tech', techAuth);

/* Serve the protected tech page */
app.get('/tech', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tech.html'));
});

/* Public endpoints */
app.get('/api/lists', async (_req, res) => {
  const lists = await readLists();
  res.json({ success: true, lists });
});

/* PROTECT tech-only API endpoints */
app.post('/api/lists', techAuth, async (req, res) => {
  const incoming = req.body || {};
  const lists = await readLists();
  for (const k of ['grip','video','lighting','sound']) {
    if (Array.isArray(incoming[k])) lists[k] = incoming[k].map(String);
  }
  await writeLists(lists);
  res.json({ success: true, lists });
});
app.post('/api/category-override', techAuth, async (req,res)=>{
  const { assetName, category } = req.body || {};
  const allowed = ['video','sound','lighting','grip','uncategorised'];
  if (!assetName || !allowed.includes((category||'').toLowerCase()))
    return res.status(400).json({ success:false, error:'assetName and valid category required' });
  const map = await readCategoryOverrides();
  map[norm(assetName)] = category.toLowerCase();
  await writeCategoryOverrides(map);
  res.json({ success:true, overrides: map });
});
app.get('/api/category-override', techAuth, async (_req, res)=>{
  res.json({ success: true, overrides: await readCategoryOverrides() });
});

/* Public: bookings (today) */
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

    const overrides = await readCategoryOverrides();
    const grouped = {};
    for (const r of rows) {
      const username = (r.username || r.userbarcode || 'Unknown').trim();
      const bucket = getTimeBucket(r.startdatetime, 5);
      const key = makeGroupKey(username, bucket);
      const cat = decideCategory(r, r.assetname, overrides);

      if (!grouped[key]) grouped[key] = { username, startdatetime: bucket, assets: [], statuses: [] };
      grouped[key].assets.push({ name: r.assetname, category: cat });
      grouped[key].statuses.push(String(r.currentstatus).toLowerCase());
    }

    const techOverrides = await readStatuses();

    const bookings = Object.values(grouped).map(g => {
      const pickedKeywords = ['picked','ready','collected','complete','completed','returned','issued'];
      const pickedOrReady = g.statuses.filter(s => pickedKeywords.some(k => s.includes(k))).length;
      const total = g.statuses.length;
      let status = 'Not Picked';
      if (pickedOrReady === 0) status = 'Not Picked';
      else if (pickedOrReady < total) status = 'Preparing';
      else status = 'Ready for Collection';

      const key = makeGroupKey(g.username, g.startdatetime);
      if (techOverrides[key]) {
        const o = String(techOverrides[key]).toLowerCase();
        if (o==='preparing') status='Preparing';
        else if (o==='ready') status='Ready for Collection';
        else if (o==='notpicked' || o==='not picked') status='Not Picked';
      }

      return { username: g.username, startdatetime: g.startdatetime, assets: g.assets, status, _groupKey: key };
    });

    res.json({ success: true, bookings });
  } catch (e) {
    console.error('Error /api/bookings', e.response?.data || e.message);
    res.status(500).json({ success:false, error: e.response?.data || e.message });
  }
});

/* PROTECT tech status update */
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
    res.json({ success:true, key, status: statuses[key] || null });
  } catch (e) {
    console.error('Error /api/update-status', e);
    res.status(500).json({ success:false, error: e.message });
  }
});

/* Static AFTER protected routes so /tech cannot be shadowed */
app.use('/', express.static(path.join(__dirname, 'public')));

/* Start */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SISO dashboard backend running at http://localhost:${PORT}`);
  console.log('🔐 /tech and tech-only APIs are protected by Basic Auth');
});
