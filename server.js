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
const BASE_URL = process.env.SISO_BASE_URL || 'https://lsa.siso.co';
const AUTH_TOKEN = process.env.SISO_AUTH_TOKEN;
const AUTH_KEY = process.env.SISO_AUTH_KEY;

if (!AUTH_TOKEN || !AUTH_KEY) {
  console.error('❌ Missing SISO_AUTH_TOKEN or SISO_AUTH_KEY in .env');
  process.exit(1);
}

/* ===== JSON FILE HELPERS ===== */
const STATUS_FILE = path.join(__dirname, 'statuses.json');
const READYIN_FILE = path.join(__dirname, 'readyin.json');
const LISTS_FILE = path.join(__dirname, 'lists.json');

async function readJson(file, fallback={}) {
  try {
    const content = await fs.readFile(file, 'utf8');
    return JSON.parse(content || 'null') ?? fallback;
  } catch {
    await fs.writeFile(file, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}
async function writeJson(file, obj) {
  await fs.writeFile(file, JSON.stringify(obj, null, 2));
}

async function readStatuses(){ return readJson(STATUS_FILE, {}); }
async function readReadyIn(){ return readJson(READYIN_FILE, {}); }
async function readLists(){ return readJson(LISTS_FILE, {video:[],sound:[],lighting:[],grip:[]}); }

/* ===== JWT CACHE ===== */
let cachedJwt = null, jwtExpiry = 0;

async function getJwt() {
  if (cachedJwt && Date.now() < jwtExpiry - 3000) return cachedJwt;

  const res = await axios.post(`${BASE_URL}/scripts/api/v1/jwt_request`, {}, {
    headers:{
      Accept:'application/json',
      'Content-Type':'application/json',
      AuthToken:AUTH_TOKEN,
      AuthKey:AUTH_KEY
    }
  });

  const token = res?.data?.token || res?.data?.response?.token;
  cachedJwt = token;
  jwtExpiry = Date.now() + 55_000;
  return token;
}

/* ============================================================
   UTC DATE HELPERS
============================================================ */

function getUTCDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isSameUTCDate(dateStr, utcDay) {
  const d = new Date(dateStr);
  const stripped = getUTCDateOnly(d);
  return stripped.getTime() === utcDay.getTime();
}

/* ============================================================
   CATEGORY HELPERS
============================================================ */

function getTimeBucket(dt, minutes = 5) {
  const d = new Date(dt);
  return new Date(Math.floor(d.getTime() / (minutes * 60000)) * (minutes * 60000)).toISOString();
}

function makeGroupKey(user, start){ return `${user}_${start}`; }

function norm(s){ return String(s||"").trim().toLowerCase(); }
function inList(name, list){ return list.some(x => norm(x) === norm(name)); }

function categoryFromLists(name, lists){
  if (inList(name, lists.video)) return "video";
  if (inList(name, lists.sound)) return "sound";
  if (inList(name, lists.lighting)) return "lighting";
  if (inList(name, lists.grip)) return "grip";
  return "uncategorised";
}

/* ============================================================
   ROUTES — TEACHERS / TECH / STATIC
============================================================ */

app.get("/teachers", (req,res)=>{
  res.sendFile(path.join(__dirname, "public", "teachers.html"));
});

/* TECH DASHBOARD SECRET PATH */
const TECH_PATH = "/tech-94f02c77b8c149e8bb3b0f72d8f93fa2";

app.get(['/tech','/tech.html','/public/tech.html'], (req,res) => {
  res.redirect(302, TECH_PATH);
});

app.get(TECH_PATH, (req,res) => {
  res.sendFile(path.join(__dirname, "public", "tech.html"));
});

/* PUBLIC STATIC FILES */
app.use('/', express.static(path.join(__dirname, 'public')));

/* ============================================================
   API: INDEX DASHBOARD — TODAY ONLY
============================================================ */
app.get("/api/bookings", async (req,res)=>{
  try {
    const jwt = await getJwt();
    const todayUTC = getUTCDateOnly(new Date());

    const {data} = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers:{Accept:"application/json", Authorization:`Bearer ${jwt}`},
      params:{limit:2000, _:Date.now()}
    });

    let rows = data?.response || [];

    // Filter: today only, ignore request bookings
    rows = rows.filter(r =>
      isSameUTCDate(r.startdatetime, todayUTC) &&
      !String(r.currentstatus).toLowerCase().includes("booking request")
    );

    // Expand
    let expanded = await expandBookings(rows);

    // NEW: Hide truly collected bookings
    expanded = expanded.filter(b =>
      !(b.statuses && b.statuses.length > 0 && b.statuses.every(st => st.includes("collected")))
    );

    res.json({success:true, bookings: expanded});
  } catch (e) {
    res.json({success:false, error:e.message});
  }
});

/* ============================================================
   API: TECH DASHBOARD — TODAY OR TOMORROW
============================================================ */
app.get("/api/bookings-tech", async (req,res)=>{
  try {
    const mode = req.query.day || "today";
    const jwt = await getJwt();

    const todayUTC = getUTCDateOnly(new Date());
    const tomorrowUTC = new Date(todayUTC);
    tomorrowUTC.setUTCDate(todayUTC.getUTCDate() + 1);

    const {data} = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers:{Accept:"application/json", Authorization:`Bearer ${jwt}`},
      params:{limit:2000, _:Date.now()}
    });

    let rows = data?.response || [];

    rows = rows.filter(r => {
      const isToday = isSameUTCDate(r.startdatetime, todayUTC);
      const isTomorrow = isSameUTCDate(r.startdatetime, tomorrowUTC);
      const notRequest = !String(r.currentstatus).toLowerCase().includes("booking request");
      return (mode === "today" ? isToday : isTomorrow) && notRequest;
    });

    let expanded = await expandBookings(rows);

    // Hide truly collected bookings
    expanded = expanded.filter(b =>
      !(b.statuses && b.statuses.length > 0 && b.statuses.every(st => st.includes("collected")))
    );

    res.json({success:true, bookings: expanded});
  } catch (e) {
    res.json({success:false, error:e.message});
  }
});

/* ============================================================
   API: TEACHERS DASHBOARD — ALL ACTIVE
============================================================ */
app.get("/api/bookings-all", async (req,res)=>{
  try {
    const jwt = await getJwt();

    const {data} = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers:{Accept:"application/json", Authorization:`Bearer ${jwt}`},
      params:{limit:2000, _:Date.now()}
    });

    let rows = data?.response || [];
    const ignore = ["returned","complete","completed","cancel","reject","booking request"];

    rows = rows.filter(r =>
      !ignore.some(x=>String(r.currentstatus).toLowerCase().includes(x))
    );

    res.json({success:true, bookings:await expandBookings(rows)});
  } catch (e) {
    res.json({success:false, error:e.message});
  }
});

/* ============================================================
   EXPAND BOOKINGS
============================================================ */
async function expandBookings(rows){
  const lists = await readLists();
  const statuses = await readStatuses();
  const readyIn = await readReadyIn();

  const grouped = {};

  for (const r of rows){
    const user = r.username?.trim() || "Unknown";
    const bucket = getTimeBucket(r.startdatetime);
    const key = makeGroupKey(user, bucket);

    if (!grouped[key]) {
      grouped[key] = {
        username: user,
        originalStart: r.startdatetime,
        startdatetime: bucket,
        assets: [],
        statuses: []
      };
    }

    grouped[key].assets.push({
      name: r.assetname,
      category: categoryFromLists(r.assetname, lists)
    });

    grouped[key].statuses.push(String(r.currentstatus).toLowerCase());
  }

  return Object.values(grouped).map(b=>{
    let status = "Not Picked";
    const lower = b.statuses;

    const pickedWords = ["picked","ready","collected","issued","prepar"];
    const picked = lower.filter(st => pickedWords.some(w=>st.includes(w))).length;

    if (picked === 0) status = "Not Picked";
    else if (picked < lower.length) status = "Preparing";
    else status = "Ready for Collection";

    const key = makeGroupKey(b.username, b.startdatetime);

    if (statuses[key]) {
      const o = statuses[key].toLowerCase();
      if (o === "preparing") status = "Preparing";
      if (o === "ready") status = "Ready for Collection";
      if (o === "notpicked") status = "Not Picked";
    }

    return {
      ...b,
      status,
      readyInMinutes: readyIn[key] || 0,
      _groupKey: key
    };
  });
}

/* ============================================================
   STATUS & READY IN
============================================================ */
app.post("/api/update-status", async (req,res)=>{
  const {key, status} = req.body;
  const statuses = await readStatuses();
  if (status === "clear") delete statuses[key];
  else statuses[key] = status.toLowerCase();
  await writeJson(STATUS_FILE, statuses);
  res.json({success:true});
});

app.post("/api/ready-in", async (req,res)=>{
  const {key, minutes} = req.body;
  const r = await readReadyIn();
  r[key] = Math.max(0, Number(minutes));
  await writeJson(READYIN_FILE, r);
  res.json({success:true});
});

/* ============================================================
   START SERVER
============================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>{
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Tech dashboard uses /api/bookings-tech`);
  console.log(`Teachers dashboard uses /api/bookings-all`);
});