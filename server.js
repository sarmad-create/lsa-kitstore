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

const BASE_URL = process.env.SISO_BASE_URL || 'https://lsa.siso.co';
const AUTH_TOKEN = process.env.SISO_AUTH_TOKEN || 'L2Mwz8gUdd';
const AUTH_KEY = process.env.SISO_AUTH_KEY || '13b3dc30-971c-440a-81ee-4f99026d44e7';
const STATUS_FILE = path.join(__dirname, 'statuses.json');

if (!AUTH_TOKEN || !AUTH_KEY) {
  console.error('❌ Missing SISO_AUTH_TOKEN or SISO_AUTH_KEY in .env');
  process.exit(1);
}

// Cache JWT
let cachedJwt = null;
let jwtExpiry = 0;

async function getJwt() {
  const now = Date.now();
  if (cachedJwt && now < jwtExpiry - 3000) return cachedJwt;
  const url = `${BASE_URL}/scripts/api/v1/jwt_request`;

  const res = await axios.post(url, {}, {
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

function formatDateForApi(dateObj) {
  const dd = String(dateObj.getDate()).padStart(2, '0');
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const yyyy = dateObj.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function getTimeBucket(datetimeString, minutes = 5) {
  if (!datetimeString) return 'Unknown';
  const d = new Date(datetimeString.replace(' ', 'T'));
  if (isNaN(d)) return datetimeString;
  const ms = minutes * 60 * 1000;
  const bucketTime = new Date(Math.floor(d.getTime() / ms) * ms);
  return bucketTime.toISOString();
}

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

function makeGroupKey(username, startdatetime) {
  const name = (username || 'Unknown').trim();
  const start = (startdatetime || 'Unknown').trim();
  return `${name}_${start}`;
}

app.get('/tech', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tech.html'));
});

// 🧠 Category detector (now includes lighting)
function getCategory(assetName) {
  const lower = assetName.toLowerCase();
  if (lower.includes('mic') || lower.includes('audio') || lower.includes('sound')) return 'Sound';
  if (lower.includes('camera') || lower.includes('lens') || lower.includes('video') || lower.includes('sony')) return 'Video';
  if (lower.includes('light') || lower.includes('panel') || lower.includes('led') || lower.includes('aputure')) return 'Lighting';
  if (lower.includes('grip') || lower.includes('stand') || lower.includes('tripod') || lower.includes('rig')) return 'Grip';
  return 'Uncategorised';
}

app.get('/api/bookings', async (req, res) => {
  try {
    const apiDate = formatDateForApi(new Date());
    const jwt = await getJwt();
    const url = `${BASE_URL}/scripts/api/v1/listbookings`;

    const response = await axios.get(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${jwt}`,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      params: { date: apiDate, limit: 1000, _: Date.now() },
      timeout: 10000,
    });

    let bookings = response?.data?.response || [];

    // Remove collected/completed from both dashboards
    bookings = bookings.filter(b => {
      const s = b.currentstatus?.toLowerCase() || '';
      return !s.includes('collected') && !s.includes('complete');
    });

    // Ignore booking requests
    bookings = bookings.filter(b =>
      b.currentstatus &&
      !b.currentstatus.toLowerCase().includes('booking request')
    );

    const grouped = {};
    for (const b of bookings) {
      const name = (b.username || b.userbarcode || 'Unknown').trim();
      const bucketStart = getTimeBucket(b.startdatetime, 5);
      const key = makeGroupKey(name, bucketStart);

      if (!grouped[key]) {
        grouped[key] = {
          username: name,
          startdatetime: bucketStart,
          assets: [],
          statuses: [],
        };
      }

      if (b.assetname) grouped[key].assets.push(b.assetname.trim());
      if (b.currentstatus) grouped[key].statuses.push(b.currentstatus.toLowerCase());
    }

    const overrides = await readStatuses();

    let groupedBookings = Object.values(grouped).map((g) => {
      const counts = {};
      g.assets.forEach(a => counts[a] = (counts[a] || 0) + 1);

      let assetList = Object.entries(counts).map(([name, count]) => {
        const displayName = count > 1 ? `${name} (x${count})` : name;
        const category = getCategory(name);
        return { name: displayName, category };
      });

      if (assetList.length > 5) {
        assetList = assetList.slice(0, 5);
        assetList.push({ name: '...', category: 'Uncategorised' });
      }

      const statusesLower = g.statuses;
      const pickedKeywords = ['picked', 'ready', 'issued'];
      const pickedOrReady = statusesLower.filter(s =>
        pickedKeywords.some(k => s.includes(k))
      ).length;
      const total = statusesLower.length;

      let autoStatus = 'Not Picked';
      if (pickedOrReady === 0) autoStatus = 'Not Picked';
      else if (pickedOrReady < total) autoStatus = 'Preparing';
      else autoStatus = 'Ready for Collection';

      const key = makeGroupKey(g.username, g.startdatetime);
      if (overrides[key]) {
        const o = overrides[key].toLowerCase();
        if (o === 'preparing') autoStatus = 'Preparing';
        else if (o === 'ready') autoStatus = 'Ready for Collection';
        else if (o === 'notpicked' || o === 'not picked') autoStatus = 'Not Picked';
      }

      return {
        username: g.username,
        startdatetime: g.startdatetime,
        assets: assetList,
        status: autoStatus,
        _groupKey: key,
      };
    });

    res.json({ success: true, bookings: groupedBookings });
  } catch (err) {
    console.error('Error /api/bookings', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/update-status', async (req, res) => {
  try {
    const { key, status } = req.body;
    if (!key || !status) return res.status(400).json({ success: false, error: 'Missing key or status' });

    const allowed = ['preparing', 'ready', 'notpicked', 'not picked', 'clear'];
    if (!allowed.includes(status.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Invalid status value' });
    }

    const statuses = await readStatuses();
    if (status.toLowerCase() === 'clear') delete statuses[key];
    else statuses[key] = status.toLowerCase();

    await writeStatuses(statuses);
    return res.json({ success: true, key, status: statuses[key] || null });
  } catch (err) {
    console.error('Error /api/update-status', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/overrides', async (req, res) => {
  const statuses = await readStatuses();
  res.json({ success: true, overrides: statuses });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SISO dashboard backend running at http://localhost:${PORT}`);
});
