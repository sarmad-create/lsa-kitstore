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
app.use(express.static('public'));

const BASE_URL = process.env.SISO_BASE_URL || 'https://lsa.siso.co';
const AUTH_TOKEN = process.env.SISO_AUTH_TOKEN;
const AUTH_KEY = process.env.SISO_AUTH_KEY;

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
async function writeJson(file, obj) { await fs.writeFile(file, JSON.stringify(obj, null, 2)); }
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

/* FIX: LONDON TIME HELPERS */
function getLondonDay(offsetDays = 0) {
  const now = new Date();
  const londonStr = now.toLocaleDateString('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
  const d = new Date(londonStr + 'T00:00:00Z'); 
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}

function isSameLondonDate(dateStr, targetLondonDate) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const dStr = d.toLocaleDateString('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
  const targetStr = targetLondonDate.toISOString().split('T')[0];
  return dStr === targetStr;
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

app.get(["/today", "/today.html"], (req, res) => { res.sendFile(path.join(__dirname, "public", "today.html")); });
app.get( "/tech-94f02c77b8c149e8bb3b0f72d8f93fa2", (req, res) => { res.sendFile(path.join(__dirname, "public", "tech.html")); });

app.get("/api/bookings", async (req, res) => {
  try {
    const jwt = await getJwt();
    const todayLondon = getLondonDay(0);
    const { data } = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
      params: { limit: 2000, _: Date.now() }
    });
    let rows = (data?.response || []).filter(r => isSameLondonDate(r.startdatetime, todayLondon) && !String(r.currentstatus).toLowerCase().includes("booking request"));
    let expanded = await expandBookings(rows);
    res.json({ success: true, bookings: expanded.filter(b => !(b.statuses?.every(st => st.includes("collected")))) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get("/api/bookings-tech", async (req, res) => {
  try {
    const mode = req.query.day || "today";
    const jwt = await getJwt();
    const targetDate = mode === "today" ? getLondonDay(0) : getLondonDay(1);
    const { data } = await axios.get(`${BASE_URL}/scripts/api/v1/listbookings`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` },
      params: { limit: 2000, _: Date.now() }
    });
    let rows = (data?.response || []).filter(r => isSameLondonDate(r.startdatetime, targetDate) && !String(r.currentstatus).toLowerCase().includes("booking request"));
    let expanded = await expandBookings(rows);
    res.json({ success: true, bookings: expanded.filter(b => !(b.statuses?.every(st => st.includes("collected")))) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

async function expandBookings(rows) {
  const lists = await readLists();
  const statuses = await readStatuses();
  const readyIn = await readReadyIn();
  const grouped = {};
  for (const r of rows) {
    const bucket = getTimeBucket(r.startdatetime);
    const key = makeGroupKey(r.username, bucket);
    if (!grouped[key]) {
      grouped[key] = { username: r.username, startdatetime: bucket, assets: [], statuses: [] };
    }
    grouped[key].assets.push({ name: r.assetname, category: categoryFromLists(r.assetname, lists) });
    grouped[key].statuses.push(String(r.currentstatus).toLowerCase());
  }
  return Object.values(grouped).map(b => {
    let status = "Not Picked";
    const picked = b.statuses.filter(st => ["picked", "ready", "collected", "issued", "prepar"].some(w => st.includes(w))).length;
    if (picked > 0) status = picked < b.statuses.length ? "Preparing" : "Ready for Collection";
    const key = makeGroupKey(b.username, b.startdatetime);
    if (statuses[key]) status = statuses[key] === "ready" ? "Ready for Collection" : (statuses[key] === "preparing" ? "Preparing" : "Not Picked");
    return { ...b, status, readyInMinutes: readyIn[key] || 0, _groupKey: key };
  });
}

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

app.listen(process.env.PORT || 3000);