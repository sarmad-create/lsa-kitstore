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

/* 1. SERVE STATIC FILES */
app.use(express.static(path.join(__dirname, 'public')));

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

async function readJson(file, fallback = {}) {
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

async function readStatuses() { return readJson(STATUS_FILE, {}); }
async function readReadyIn() { return readJson(READYIN_FILE, {}); }
async function readLists() { return readJson(LISTS_FILE, { video: [], sound: [], lighting: [], grip: [] }); }

/* ===== JWT CACHE ===== */
let cachedJwt = null, jwtExpiry = 0;

async function getJwt() {
  if (cachedJwt && Date.now() < jwtExpiry - 3000) return cachedJwt;
  const res = await axios.post(`${BASE_URL}/scripts/api/v1/jwt_request`, {}, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', AuthToken: AUTH_TOKEN, AuthKey: AUTH_KEY }
  });
  const token = res?.data?.token || res?.data?.response?.token;
  cachedJwt = token;
  jwtExpiry = Date.now() + 55_000;
  return token;
}

/* ===== HELPERS ===== */
function getUTCDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isSameUTCDate(dateStr, utcDay) {
  const d = new Date(dateStr);
  const stripped = getUTCDateOnly(d);
  return stripped.getTime() === utcDay.getTime();
}

function getTimeBucket(dt, minutes = 5) {
  const d = new Date(dt);
  return new Date(Math.floor(d.getTime() / (minutes * 60000)) * (minutes * 60000)).toISOString();
}

function makeGroupKey(user, start) { return `${user}_${start}`; }
function norm(s) { return String(s || "").trim().toLowerCase(); }
function inList(name, list) { return list.some(x => norm(x) === norm(name)); }

function categoryFromLists(name, lists) {
  if (inList(name, lists.video)) return "video";
  if (inList(name, lists.sound)) return "sound";
  if (inList(name, lists.lighting)) return "lighting";
  if (inList(name, lists.grip)) return "grip";
  return "uncategorised";
}

function pickEndDatetime(r) {
  return r.enddatetime || r.endDateTime || r.end_time || r.end || null;
}

/* ===== PAGE ROUTES ===== */
app.get(["/", "/index.html", "/home"], (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get(["/today", "/today.html"], (req, res) => res.sendFile(path.join(__dirname, "public", "today.html")));
app.get(["/teachers", "/teachers.html"], (req, res) => res.sendFile(path.join(__dirname, "public", "teachers.html")));
app.get(["/calendar", "/calendar.html"], (req, res) => res.sendFile(path.join(__dirname, "public", "calendar.html")));

const TECH_PATH = "/tech-94f02c77b8c149e8bb3b0f72d8f93fa2";
app.get(['/tech', '/tech.html'], (req, res) => res.redirect(302, TECH_PATH));
app.get(TECH_PATH, (req, res) => res.sendFile(path.join(__dirname, "public", "tech.html")));

/* ============================================================
   API ENDPOINTS
============================================================ */

/**
 * 1. TODAY DASHBOARD
 */
app.get("/api/bookings", async (req, res) => {
  try {
    const jwt = await getJwt();
    const todayUTC = getUTCDateOnly(new Date());
    const { data } = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
      params: { limit: 2000, _: Date.now() }
    });
    let rows = (data?.response || []).filter(r => 
      isSameUTCDate(r.startdatetime, todayUTC) && 
      !String(r.currentstatus).toLowerCase().includes("booking request")
    );
    let expanded = await expandBookings(rows);
    expanded = expanded.filter(b => !(b.statuses?.every(st => st.includes("collected"))));
    res.json({ success: true, bookings: expanded });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

/**
 * 2. TECH DASHBOARD (Fixed Overview Support)
 */
app.get("/api/bookings-tech", async (req, res) => {
  try {
    const mode = req.query.day || "today";
    const jwt = await getJwt();
    const todayUTC = getUTCDateOnly(new Date());

    const { data } = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
      params: { limit: 2000, _: Date.now() }
    });

    let rows = (data?.response || []).filter(r => !String(r.currentstatus).toLowerCase().includes("booking request"));
    let filteredRows = [];

    if (mode === "overview") {
      const startDate = req.query.start ? getUTCDateOnly(new Date(req.query.start)) : todayUTC;
      const endDate = new Date(startDate);
      endDate.setUTCDate(startDate.getUTCDate() + 7);
      filteredRows = rows.filter(r => {
        const bd = new Date(r.startdatetime);
        return bd >= startDate && bd < endDate;
      });
    } else {
      const targetDate = (mode === "tomorrow") ? new Date(todayUTC.getTime() + 86400000) : todayUTC;
      filteredRows = rows.filter(r => isSameUTCDate(r.startdatetime, targetDate));
    }

    let expanded = await expandBookings(filteredRows);
    if (mode !== "overview") {
      expanded = expanded.filter(b => !(b.statuses && b.statuses.every(st => st.includes("collected"))));
    }
    res.json({ success: true, bookings: expanded, totalCount: expanded.length });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

/**
 * 3. TEACHERS DASHBOARD
 */
app.get("/api/bookings-all", async (req, res) => {
  try {
    const jwt = await getJwt();
    const { data } = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
      params: { limit: 2000, _: Date.now() }
    });
    const ignore = ["returned", "complete", "completed", "cancel", "reject", "booking request"];
    let rows = (data?.response || []).filter(r => 
      !ignore.some(x => String(r.currentstatus).toLowerCase().includes(x))
    );
    res.json({ success: true, bookings: await expandBookings(rows) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

/**
 * 4. CALENDAR RANGE
 */
app.get("/api/bookings-range", async (req, res) => {
  try {
    const start = new Date(req.query.start);
    const end = new Date(req.query.end);
    if (isNaN(start) || isNaN(end)) return res.json({ success: false, error: "Invalid dates" });

    const jwt = await getJwt();
    const { data } = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
      params: { limit: 2000, _: Date.now() }
    });
    let rows = (data?.response || []).filter(r => {
      const sd = new Date(r.startdatetime);
      return !String(r.currentstatus).toLowerCase().includes("booking request") && sd >= start && sd < end;
    });
    let expanded = await expandBookings(rows);
    expanded = expanded.filter(b => !(b.statuses?.every(st => st.includes("collected"))));
    res.json({ success: true, bookings: expanded });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

/* ===== CORE LOGIC: GROUPING ===== */
async function expandBookings(rows) {
  const [lists, statuses, readyIn] = await Promise.all([readLists(), readStatuses(), readReadyIn()]);
  const grouped = {};

  for (const r of rows) {
    const user = r.username?.trim() || "Unknown";
    const bucket = getTimeBucket(r.startdatetime);
    const key = makeGroupKey(user, bucket);
    const rawEnd = pickEndDatetime(r);

    if (!grouped[key]) {
      grouped[key] = { 
        username: user, startdatetime: bucket, enddatetime: rawEnd, 
        originalStart: r.startdatetime, assets: [], statuses: [] 
      };
    } else {
      if (new Date(r.startdatetime) < new Date(grouped[key].originalStart)) {
        grouped[key].originalStart = r.startdatetime;
      }
      if (rawEnd && (!grouped[key].enddatetime || new Date(rawEnd) > new Date(grouped[key].enddatetime))) {
        grouped[key].enddatetime = rawEnd;
      }
    }
    grouped[key].assets.push({ name: r.assetname, category: categoryFromLists(r.assetname, lists) });
    grouped[key].statuses.push(String(r.currentstatus).toLowerCase());
  }

  return Object.values(grouped).map(b => {
    let status = "Not Picked";
    const pickedWords = ["picked", "ready", "collected", "issued", "prepar"];
    const pickedCount = b.statuses.filter(st => pickedWords.some(w => st.includes(w))).length;

    if (pickedCount === 0) status = "Not Picked";
    else if (pickedCount < b.statuses.length) status = "Preparing";
    else status = "Ready for Collection";

    const key = makeGroupKey(b.username, b.startdatetime);
    if (statuses[key]) {
      const manual = statuses[key].toLowerCase();
      if (manual === "preparing") status = "Preparing";
      else if (manual === "ready") status = "Ready for Collection";
      else if (manual === "notpicked") status = "Not Picked";
    }

    return { ...b, status, readyInMinutes: readyIn[key] || 0, _groupKey: key };
  });
}

/* ===== STATUS UPDATES ===== */
app.post("/api/update-status", async (req, res) => {
  const { key, status } = req.body;
  const s = await readStatuses();
  if (status === "clear") delete s[key]; else s[key] = status.toLowerCase();
  await writeJson(STATUS_FILE, s);
  res.json({ success: true });
});

app.post("/api/ready-in", async (req, res) => {
  const { key, minutes } = req.body;
  const r = await readReadyIn();
  r[key] = Math.max(0, Number(minutes));
  await writeJson(READYIN_FILE, r);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));