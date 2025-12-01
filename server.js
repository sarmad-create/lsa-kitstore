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

const STATUS_FILE = path.join(__dirname, 'statuses.json');
const LISTS_FILE  = path.join(__dirname, 'lists.json');
const READYIN_FILE = path.join(__dirname, 'readyin.json');

if (!AUTH_TOKEN || !AUTH_KEY) {
  console.error('❌ Missing SISO_AUTH_TOKEN or SISO_AUTH_KEY in .env');
  process.exit(1);
}

/* ===== JSON HELPERS ===== */
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

async function readLists() { 
  return readJson(LISTS_FILE, { video:[], sound:[], lighting:[], grip:[] }); 
}
async function writeLists(l){ return writeJson(LISTS_FILE, l); }

async function readReadyIn() { return readJson(READYIN_FILE, {}); }
async function writeReadyIn(o){ return writeJson(READYIN_FILE, o); }

/* ===== JWT CACHE ===== */
let cachedJwt = null, jwtExpiry = 0;

async function getJwt() {
  const now = Date.now();
  if (cachedJwt && now < jwtExpiry - 3000) return cachedJwt;

  const res = await axios.post(`${BASE_URL}/scripts/api/v1/jwt_request`, {}, {
    headers: { 
      Accept:'application/json',
      'Content-Type':'application/json',
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

/* ===== DATE HELPERS ===== */
function formatDateForApi(d) {
  const dd=String(d.getDate()).padStart(2,'0');
  const mm=String(d.getMonth()+1).padStart(2,'0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function parseStartDateParts(s) {
  if (!s) return null;
  const raw = String(s);
  const date = raw.split(' ')[0];

  if (date.includes('/')) {
    const [dd,mm,yyyy] = date.split('/');
    return { d:+dd, m:+mm, y:+yyyy };
  }
  if (date.includes('-')) {
    const [yyyy,mm,dd] = date.split('-');
    return { d:+dd, m:+mm, y:+yyyy };
  }

  const dt = new Date(raw.replace(' ','T'));
  if (!isNaN(dt)) return { d:dt.getDate(), m:dt.getMonth()+1, y:dt.getFullYear() };
  return null;
}

function isSameDayStart(startdatetime, day) {
  const p = parseStartDateParts(startdatetime);
  if (!p) return false;
  return p.y===day.getFullYear() && p.m===(day.getMonth()+1) && p.d===day.getDate();
}

function getTimeBucket(datetimeString, minutes = 5) {
  if (!datetimeString) return 'Unknown';
  let d = new Date(String(datetimeString).replace(' ','T'));
  if (isNaN(d)) return datetimeString;

  const ms = minutes*60*1000;
  return new Date(Math.floor(d.getTime()/ms) * ms).toISOString();
}

function makeGroupKey(username, startdatetime) {
  return `${(username||'Unknown').trim()}_${(startdatetime||'Unknown').trim()}`;
}

/* ===== CATEGORY ANALYSIS ===== */
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

/* ============================================================
      🔒 HIDDEN TECH ROUTE (security through obscurity)
   ============================================================ */

const TECH_PATH = "/tech-94f02c77b8c149e8bb3b0f72d8f93fa2";

/* Redirect old paths → new hidden path */
app.get(['/tech','/tech.html','/public/tech.html'], (req,res) => {
  res.redirect(302, TECH_PATH);
});

/* Serve the technician page */
app.get(TECH_PATH, (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'tech.html'));
});

/* PUBLIC frontend */
app.use('/', express.static(path.join(__dirname, 'public')));

/* ============================================================
   🔧 LISTS API (public GET, used internally)
   ============================================================ */
app.get('/api/lists', async (_req,res)=>{
  const lists = await readLists();
  res.json({ success:true, lists });
});

/* ============================================================
   🔧 BOOKINGS (public dashboard & tech dashboard)
   ============================================================ */
app.get('/api/bookings', async(req,res)=>{
  try{
    const today = new Date();
    const jwt = await getJwt();

    const { data } = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers:{ Accept:'application/json', Authorization:`Bearer ${jwt}` },
      params:{ date:formatDateForApi(today), limit:1000, _:Date.now() },
      timeout:12000
    });

    let rows = data?.response || [];

    rows = rows.filter(r =>
      r.currentstatus &&
      !String(r.currentstatus).toLowerCase().includes('booking request') &&
      isSameDayStart(r.startdatetime, today)
    );

    const lists = await readLists();
    const overrides = await readStatuses();
    const readyIn = await readReadyIn();

    const grouped = {};

    for(const r of rows){
      const user = (r.username || r.userbarcode || 'Unknown').trim();
      const bucket = getTimeBucket(r.startdatetime,5);
      const key = makeGroupKey(user, bucket);

      if(!grouped[key])
        grouped[key] = { username:user, startdatetime:bucket, assets:[], statuses:[] };

      const category = categoryFromLists(r.assetname, lists);

      grouped[key].assets.push({ name:r.assetname, category });
      grouped[key].statuses.push(String(r.currentstatus).toLowerCase());
    }

    const bookings = Object.values(grouped).map(g=>{
      let status = 'Not Picked';
      const lower = g.statuses;

      const pickedKeywords=['picked','ready','collected','returned','issued','complete','completed'];
      const picked = lower.filter(s => pickedKeywords.some(k=>s.includes(k))).length;
      const total  = lower.length;

      if (picked === 0) status='Not Picked';
      else if (picked < total) status='Preparing';
      else status='Ready for Collection';

      const key = makeGroupKey(g.username, g.startdatetime);

      if(overrides[key]){
        const o = overrides[key].toLowerCase();
        if(o==='preparing') status='Preparing';
        if(o==='ready')     status='Ready for Collection';
        if(o==='notpicked') status='Not Picked';
      }

      return {
        username:g.username,
        startdatetime:g.startdatetime,
        assets:g.assets,
        status,
        readyInMinutes: readyIn[key] || 0,
        _groupKey:key
      };
    });

    res.json({ success:true, bookings });
    
  }catch(e){
    console.error('Error /api/bookings', e.response?.data || e.message);
    res.status(500).json({ success:false, error:e.message });
  }
});

/* ============================================================
   🔧 TECH UPDATE STATUS (no password)
   ============================================================ */
app.post('/api/update-status', async(req,res)=>{
  try{
    const { key, status } = req.body || {};
    if(!key) return res.status(400).json({success:false,error:'Missing key'});

    const allowed = ['preparing','ready','notpicked','not picked','clear'];
    if(!allowed.includes(String(status).toLowerCase()))
      return res.status(400).json({success:false,error:'Invalid status'});

    const statuses = await readStatuses();

    if(String(status).toLowerCase()==='clear') delete statuses[key];
    else statuses[key] = String(status).toLowerCase();

    await writeStatuses(statuses);
    res.json({ success:true });
  }catch(e){
    res.status(500).json({ success:false, error:e.message });
  }
});

/* ============================================================
   🔧 TECH: READY IN MINUTES
   ============================================================ */
app.post('/api/ready-in', async(req,res)=>{
  try{
    const { key, minutes } = req.body || {};
    const readyIn = await readReadyIn();

    readyIn[key] = Math.max(0, Number(minutes || 0));

    await writeReadyIn(readyIn);
    res.json({ success:true });
  }catch(e){
    res.status(500).json({ success:false, error:e.message });
  }
});

/* ============================================================
   START SERVER
   ============================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🔧 Technician dashboard at: ${TECH_PATH}`);
});
