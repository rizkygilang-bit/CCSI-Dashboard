// scripts/fetch-data.js
const fs = require('fs');
const https = require('https');

const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQsM2W-ixiIhBq4PTUfpbiY3DFzeMTDaHmxUvMfUDCn16d3s4NOLemY4JAbcA6FmgjdoUgGJy_7N-er/pub?gid=573014540&single=true&output=csv";

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    if (inQuotes) {
      if (char === '"' && nextChar === '"') { cell += '"'; i++; }
      else if (char === '"') { inQuotes = false; }
      else { cell += char; }
    } else {
      if (char === '"') { inQuotes = true; }
      else if (char === ',') { row.push(cell); cell = ''; }
      else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (char !== '\r') { cell += char; }
    }
  }
  if (cell || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

function normalizeLabel(text) {
  if (!text) return '';
  const firstLine = text.split('\n')[0].trim();
  let label = firstLine.replace(/^\d+\.\s*/, '').replace(/\s+/g, ' ').trim();
  label = label.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
  label = label.replace(/\bRfs\b/g, 'RFS').replace(/\bDrm\b/g, 'DRM');
  return label;
}

function normalizeStatus(text) {
  if (!text) return '';
  const firstLine = text.split('\n')[0].trim();
  return firstLine.replace(/^\d+\.\s*/, '').toLowerCase().trim();
}

function parseSiteList(rows) {
  const KEYWORDS = ['site id', 'progress fo', 'progres fo', 'site priority', 'permit status', 'status', 'vendor', 'cust prio', 'customer priority'];
  let headerIdx = -1, bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i] || [];
    let score = 0;
    for (const cell of row) {
      const c = (cell || '').toString().trim().toLowerCase();
      if (KEYWORDS.some(k => c === k || c.includes(k))) score++;
    }
    if (score > bestScore) { bestScore = score; headerIdx = i; }
  }
  if (headerIdx === -1 || bestScore < 2) throw new Error('Header tidak ditemukan');
  
  const header = rows[headerIdx];
  console.log('Header:', header.slice(0, 20));
  
  // Cari index kolom
  const colIdx = {};
  const COL_MAP = {
    'siteId': ['site id'],
    'ranVendor': ['ran vendor', 'vendor'],
    'siteName': ['site name'],
    'tp': ['tp'],
    'kota': ['kota'],
    'province': ['province', 'provinsi'],
    'topology': ['topology'],
    'progressFO': ['progress fo', 'progres fo'],
    'custPrio': ['cust prio', 'customer priority'],
    'permitStatus': ['permit status'],
    'rpm': ['rpm'],
    'monthPermit': ['month permit'],
    'monthAchievement': ['month achievement', 'month achivement']
  };
  
  Object.keys(COL_MAP).forEach(key => {
    const aliases = COL_MAP[key];
    for (let i = 0; i < header.length; i++) {
      const h = (header[i] || '').toString().trim().toLowerCase();
      if (aliases.some(a => h === a || h.includes(a))) {
        colIdx[key] = i;
        break;
      }
    }
  });
  
  console.log('Kolom terdeteksi:', colIdx);
  
  if (colIdx.progressFO === undefined) throw new Error('Kolom Progress FO tidak ditemukan');
  
  const statusCount = {}, permitCount = {};
  const priorityByStatus = { 'permit': {}, 'pulling cable': {}, 'pulling done': {} };
  const priorityOverall = {};
  
  // ✅ DATA PER-SITE (untuk tabel detail)
  const sites = [];
  
  let rowsProcessed = 0;
  
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    
    // Skip baris yang tidak punya Site ID
    const siteId = colIdx.siteId !== undefined ? (r[colIdx.siteId] || '').toString().trim() : '';
    if (!siteId || siteId.length < 3) continue;
    
    rowsProcessed++;
    
    const progressRaw = (r[colIdx.progressFO] || '').toString().trim();
    const progressNorm = normalizeStatus(progressRaw);
    const progressLabel = normalizeLabel(progressRaw);
    
    // Status count
    if (progressRaw && !progressRaw.startsWith('#') && !progressRaw.toLowerCase().includes('n/a')) {
      if (progressLabel) statusCount[progressLabel] = (statusCount[progressLabel] || 0) + 1;
    }
    
    // Priority
    let prio = '';
    if (colIdx.custPrio !== undefined) {
      prio = (r[colIdx.custPrio] || '').toString().trim().toUpperCase();
      if (prio.startsWith('#') || prio.length > 10) prio = '';
    }
    
    if (prio) {
      priorityOverall[prio] = (priorityOverall[prio] || 0) + 1;
      
      if (progressNorm.includes('permit') && !progressNorm.includes('pulling')) {
        priorityByStatus['permit'][prio] = (priorityByStatus['permit'][prio] || 0) + 1;
      }
      if (progressNorm.includes('pulling cable')) {
        priorityByStatus['pulling cable'][prio] = (priorityByStatus['pulling cable'][prio] || 0) + 1;
      }
      if (progressNorm.includes('pulling done')) {
        priorityByStatus['pulling done'][prio] = (priorityByStatus['pulling done'][prio] || 0) + 1;
      }
    }
    
    // Permit status
    if (colIdx.permitStatus !== undefined) {
      const permit = (r[colIdx.permitStatus] || '').toString().trim();
      if (permit && !permit.startsWith('#') && !permit.toLowerCase().includes('n/a')) {
        permitCount[permit] = (permitCount[permit] || 0) + 1;
      }
    }
    
    // ✅ SIMPAN DATA PER-SITE (untuk tabel)
    const site = {
      siteId: siteId,
      siteName: colIdx.siteName !== undefined ? (r[colIdx.siteName] || '').toString().trim() : '',
      ranVendor: colIdx.ranVendor !== undefined ? (r[colIdx.ranVendor] || '').toString().trim() : '',
      kota: colIdx.kota !== undefined ? (r[colIdx.kota] || '').toString().trim() : '',
      province: colIdx.province !== undefined ? (r[colIdx.province] || '').toString().trim() : '',
      topology: colIdx.topology !== undefined ? (r[colIdx.topology] || '').toString().trim() : '',
      progressFO: progressLabel,
      custPrio: prio,
      permitStatus: colIdx.permitStatus !== undefined ? (r[colIdx.permitStatus] || '').toString().trim() : '',
      rpm: colIdx.rpm !== undefined ? (r[colIdx.rpm] || '').toString().trim() : ''
    };
    
    sites.push(site);
  }
  
  console.log('📈 Rows processed:', rowsProcessed);
  console.log('📋 Sites saved:', sites.length);
  
  const status = Object.keys(statusCount).map(k => ({ label: k, value: statusCount[k] }));
  const permit = Object.keys(permitCount).map(k => ({ label: k, value: permitCount[k] })).sort((a, b) => b.value - a.value);
  
  const priorityOrder = ['P1', 'P2', 'P3', 'P4', 'DROP'];
  const priorityByStatusFinal = {};
  ['permit', 'pulling cable', 'pulling done'].forEach(key => {
    priorityByStatusFinal[key] = priorityOrder
      .filter(p => priorityByStatus[key][p] !== undefined)
      .map(p => ({ label: p, value: priorityByStatus[key][p] }));
  });
  
  const priorityOverallFinal = priorityOrder
    .filter(p => priorityOverall[p] !== undefined)
    .map(p => ({ label: p, value: priorityOverall[p] }));
  
  return {
    status,
    priority: priorityOverallFinal,
    priorityByStatus: priorityByStatusFinal,
    permit,
    sites  // ← DATA PER-SITE
  };
}

(async () => {
  try {
    console.log('Fetching:', SHEET_CSV_URL);
    const csvText = await fetchURL(SHEET_CSV_URL);
    console.log('Fetched', csvText.length, 'chars');
    
    const rows = parseCSV(csvText);
    console.log('Parsed', rows.length, 'rows');
    
    const data = parseSiteList(rows);
    data.updatedAt = new Date().toISOString();
    data.total = data.status.reduce((s, d) => s + d.value, 0);
    
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
    console.log('✅ Saved data.json');
    console.log('Total sites:', data.total);
    console.log('Sites array length:', data.sites.length);
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
