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

app.use(express.static(path.join(__dirname, 'public')));

const BASE_URL = process.env.SISO_BASE_URL || 'https://lsa.siso.co';
const AUTH_TOKEN = process.env.SISO_AUTH_TOKEN;
const AUTH_KEY = process.env.SISO_AUTH_KEY;

if (!AUTH_TOKEN || !AUTH_KEY) {
  console.error('❌ Missing SISO_AUTH_TOKEN or SISO_AUTH_KEY in .env');
  process.exit(1);
}

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

function getUTCDateOnly(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function isSameUTCDate(dateStr, utcDay) {
  const d = new Date(dateStr);
  return getUTCDateOnly(d).getTime() === utcDay.getTime();
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

app.get(["/", "/index.html", "/home"], (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get(["/today", "/today.html"], (req, res) => res.sendFile(path.join(__dirname, "public", "today.html")));
app.get(["/teachers", "/teachers.html"], (req, res) => res.sendFile(path.join(__dirname, "public", "teachers.html")));
app.get(["/calendar", "/calendar.html"], (req, res) => res.sendFile(path.join(__dirname, "public", "calendar.html")));
const TECH_PATH = "/tech-94f02c77b8c149e8bb3b0f72d8f93fa2";
app.get(['/tech', '/tech.html'], (req, res) => res.redirect(302, TECH_PATH));
app.get(TECH_PATH, (req, res) => res.sendFile(path.join(__dirname, "public", "tech.html")));

/* ============================================================
   API: UTILISATION DATA (Matching Smarthub Report Totals)
============================================================ */
app.get("/api/utilisation", async (req, res) => {
  try {
    const selectedYear = parseInt(req.query.year) || new Date().getFullYear();
    const jwt = await getJwt();
    
    // Sept to Aug sequence
    const monthSequence = [
      { m: 8, y: selectedYear }, { m: 9, y: selectedYear }, { m: 10, y: selectedYear }, { m: 11, y: selectedYear },
      { m: 0, y: selectedYear + 1 }, { m: 1, y: selectedYear + 1 }, { m: 2, y: selectedYear + 1 }, { m: 3, y: selectedYear + 1 },
      { m: 4, y: selectedYear + 1 }, { m: 5, y: selectedYear + 1 }, { m: 6, y: selectedYear + 1 }, { m: 7, y: selectedYear + 1 }
    ];

    const labels = [];
    const counts = [];

    for (const item of monthSequence) {
      const firstDay = new Date(Date.UTC(item.y, item.m, 1));
      const lastDay = new Date(Date.UTC(item.y, item.m + 1, 0));
      
      // FIX: Using ISO format (YYYY-MM-DD) which is more reliable for the API backend
      const dateFrom = firstDay.toISOString().split('T')[0];
      const dateTo = lastDay.toISOString().split('T')[0];

      let monthTotal = 0;

      try {
        const { data } = await axios.post(`${BASE_URL}/scripts/api/v1/report`, {
          report_uuid: "b497f2d6-5dbb-44a2-83a1-d5ad69e9b047",
          filters: [{ arg: "DATEFROMTO", value: `${dateFrom},${dateTo}` }]
        }, {
          headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
          timeout: 20000 
        });

        const rows = data?.response?.rows || data?.response?.results || [];
        
        // Match the "Finished" row count seen in Smarthub
        const finishedRows = rows.filter(r => {
            const status = String(r.status || r.currentstatus || "").toLowerCase();
            return status.includes("finished") || status.includes("restocked") || status.includes("returned");
        });

        monthTotal = finishedRows.length;
      } catch (err) {
        console.error(`Error in month ${item.m}:`, err.message);
      }

      labels.push(firstDay.toLocaleString('en-GB', { month: 'short' }));
      counts.push(monthTotal);
    }

    res.json({ success: true, labels, counts });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/* ===== API: TECH DASHBOARD ===== */
app.get("/api/bookings-tech", async (req, res) => {
  try {
    const mode = req.query.day || "today";
    const jwt = await getJwt();
    const todayUTC = getUTCDateOnly(new Date());

    const { data } = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
      params: { limit: 2000, _: Date.now() }
    });

    let rows = data?.response || [];
    rows = rows.filter(r => !String(r.currentstatus).toLowerCase().includes("booking request"));

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
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

async function expandBookings(rows) {
  const lists = await readLists();
  const statuses = await readStatuses();
  const readyIn = await readReadyIn();
  const grouped = {};

  for (const r of rows) {
    const user = r.username?.trim() || "Unknown";
    const bucket = getTimeBucket(r.startdatetime);
    const key = makeGroupKey(user, bucket);
    if (!grouped[key]) {
      grouped[key] = { username: user, startdatetime: bucket, assets: [], statuses: [] };
    }
    grouped[key].assets.push({ name: r.assetname, category: categoryFromLists(r.assetname, lists) });
    grouped[key].statuses.push(String(r.currentstatus).toLowerCase());
  }

  return Object.values(grouped).map(b => {
    let status = "Not Picked";
    const pickedWords = ["picked", "ready", "collected", "issued", "prepar"];
    const picked = b.statuses.filter(st => pickedWords.some(w => st.includes(w))).length;
    if (picked === 0) status = "Not Picked";
    else if (picked < b.statuses.length) status = "Preparing";
    else status = "Ready for Collection";

    const key = makeGroupKey(b.username, b.startdatetime);
    if (statuses[key]) {
      const o = statuses[key].toLowerCase();
      if (o === "preparing") status = "Preparing";
      if (o === "ready") status = "Ready for Collection";
      if (o === "notpicked") status = "Not Picked";
    }
    return { ...b, status, readyInMinutes: readyIn[key] || 0, _groupKey: key };
  });
}

app.post("/api/update-status", async (req, res) => {
  const { key, status } = req.body;
  const statuses = await readStatuses();
  if (status === "clear") delete statuses[key];
  else statuses[key] = status.toLowerCase();
  await writeJson(STATUS_FILE, statuses);
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