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

// CSV Parser yang HANDLE MULTILINE dengan benar
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
      else { cell += char; }  // ← handle \n di dalam quotes
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
  // Ambil baris pertama saja (kalau multiline)
  const firstLine = text.split('\n')[0].trim();
  let label = firstLine.replace(/^\d+\.\s*/, '').replace(/\s+/g, ' ').trim();
  label = label.replace(/\w\S*/g, txt => 
    txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  );
  label = label.replace(/\bRfs\b/g, 'RFS').replace(/\bDrm\b/g, 'DRM');
  return label;
}

function parseSiteList(rows) {
  const KEYWORDS = ['site id', 'progress fo', 'progres fo', 'site priority', 'permit status', 'status', 'vendor'];
  
  // Auto-detect header (skip baris "1127")
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
  
  console.log('✅ Header di baris:', headerIdx + 1, '(score:', bestScore + ')');
  const header = rows[headerIdx];
  
  let progressFOIdx = -1, sitePriorityIdx = -1, permitStatusIdx = -1;
  
  for (let i = 0; i < header.length; i++) {
    const h = (header[i] || '').toString().trim().toLowerCase();
    if (h === 'progress fo' || h.includes('progress fo') || h === 'progres fo' || h.includes('progres fo')) progressFOIdx = i;
    if (h === 'site priority' || h.includes('site priority') || h.includes('priority')) sitePriorityIdx = i;
    if (h === 'permit status' || h.includes('permit status')) permitStatusIdx = i;
  }
  
  // Fallback: cari kolom yg isinya banyak status
  if (progressFOIdx === -1) {
    for (let col = 0; col < (header.length || 50); col++) {
      let hits = 0;
      for (let r = headerIdx + 1; r < Math.min(rows.length, headerIdx + 200); r++) {
        const v = (rows[r] && rows[r][col] ? rows[r][col] : '').toString().toLowerCase();
        if (v.includes('rfs') || v.includes('drm') || v.includes('permit') || v.includes('terminasi') || v.includes('pulling') || v.includes('takeout') || v.includes('drop') || v.includes('negosiasi') || v.includes('done') || v.includes('waiting')) hits++;
      }
      if (hits > 20) { progressFOIdx = col; console.log('📌 Fallback Progress FO di kolom:', col); break; }
    }
  }
  
  if (permitStatusIdx === -1) {
    for (let col = 0; col < (header.length || 50); col++) {
      let hits = 0;
      for (let r = headerIdx + 1; r < Math.min(rows.length, headerIdx + 200); r++) {
        const v = (rows[r] && rows[r][col] ? rows[r][col] : '').toString().toLowerCase();
        if (v.includes('permit') && !v.includes('progress') && !v.includes('progres')) hits++;
      }
      if (hits > 20) { permitStatusIdx = col; break; }
    }
  }
  
  console.log('📊 Index kolom:', { progressFOIdx, sitePriorityIdx, permitStatusIdx });
  
  if (progressFOIdx === -1) throw new Error('Kolom Progress FO tidak ditemukan');
  
  const statusCount = {}, priorityCount = {}, permitCount = {};
  let rowsProcessed = 0;
  
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    rowsProcessed++;
    
    const progress = (r[progressFOIdx] || '').toString().trim();
    if (progress && !progress.startsWith('#') && !progress.toLowerCase().includes('n/a')) {
      const label = normalizeLabel(progress);
      if (label) statusCount[label] = (statusCount[label] || 0) + 1;
    }
    
    if (sitePriorityIdx !== -1) {
      const prio = (r[sitePriorityIdx] || '').toString().trim();
      if (prio && !prio.startsWith('#') && prio.length < 10) {
        priorityCount[prio] = (priorityCount[prio] || 0) + 1;
      }
    }
    
    if (permitStatusIdx !== -1) {
      const permit = (r[permitStatusIdx] || '').toString().trim();
      if (permit && !permit.startsWith('#') && !permit.toLowerCase().includes('n/a')) {
        permitCount[permit] = (permitCount[permit] || 0) + 1;
      }
    }
  }
  
  console.log('📈 Rows processed:', rowsProcessed);
  
  const status = Object.keys(statusCount).map(k => ({ label: k, value: statusCount[k] }));
  const priority = Object.keys(priorityCount).map(k => ({ label: k, value: priorityCount[k] })).sort((a, b) => b.value - a.value);
  const permit = Object.keys(permitCount).map(k => ({ label: k, value: permitCount[k] })).sort((a, b) => b.value - a.value);
  
  return { status, priority, permit };
}

(async () => {
  try {
    console.log('Fetching:', SHEET_CSV_URL);
    const csvText = await fetchURL(SHEET_CSV_URL);
    console.log('Fetched', csvText.length, 'chars');
    
    const rows = parseCSV(csvText);
    console.log('Parsed', rows.length, 'rows dari CSV');
    console.log('Baris 1:', rows[0] ? rows[0].slice(0, 5) : 'KOSONG');
    console.log('Baris 2:', rows[1] ? rows[1].slice(0, 5) : 'KOSONG');
    console.log('Baris 3:', rows[2] ? rows[2].slice(0, 5) : 'KOSONG');
    
    const data = parseSiteList(rows);
    data.updatedAt = new Date().toISOString();
    data.total = data.status.reduce((s, d) => s + d.value, 0);
    
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
    console.log('✅ Saved data.json');
    console.log('Total sites:', data.total);
    console.log('Status distribution:', JSON.stringify(data.status, null, 2));
    console.log('Priority:', JSON.stringify(data.priority));
    console.log('Permit:', JSON.stringify(data.permit));
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
