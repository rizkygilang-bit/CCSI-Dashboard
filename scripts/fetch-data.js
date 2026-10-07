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
  
  console.log('✅ Header di baris:', headerIdx + 1);
  const header = rows[headerIdx];
  
  let progressFOIdx = -1, custPrioIdx = -1, permitStatusIdx = -1;
  
  for (let i = 0; i < header.length; i++) {
    const h = (header[i] || '').toString().trim().toLowerCase();
    if (h === 'progress fo' || h.includes('progress fo') || h === 'progres fo') progressFOIdx = i;
    if (h === 'cust prio' || h.includes('cust prio') || h.includes('customer priority') || h === 'priority') custPrioIdx = i;
    if (h === 'permit status' || h.includes('permit status')) permitStatusIdx = i;
  }
  
  // Fallback: cari kolom Cust PRIO yang isinya P1/P2/P3/P4
  if (custPrioIdx === -1) {
    for (let col = 0; col < (header.length || 50); col++) {
      let hits = 0;
      for (let r = headerIdx + 1; r < Math.min(rows.length, headerIdx + 100); r++) {
        const v = (rows[r] && rows[r][col] ? rows[r][col] : '').toString().trim().toUpperCase();
        if (v === 'P1' || v === 'P2' || v === 'P3' || v === 'P4' || v === 'DROP') hits++;
      }
      if (hits > 10) { custPrioIdx = col; console.log('📌 Fallback Cust PRIO di kolom:', col); break; }
    }
  }
  
  if (progressFOIdx === -1) {
    for (let col = 0; col < (header.length || 50); col++) {
      let hits = 0;
      for (let r = headerIdx + 1; r < Math.min(rows.length, headerIdx + 100); r++) {
        const v = (rows[r] && rows[r][col] ? rows[r][col] : '').toString().toLowerCase();
        if (v.includes('rfs') || v.includes('drm') || v.includes('permit') || v.includes('terminasi') || v.includes('pulling') || v.includes('takeout') || v.includes('drop')) hits++;
      }
      if (hits > 20) { progressFOIdx = col; break; }
    }
  }
  
  if (permitStatusIdx === -1) {
    for (let col = 0; col < (header.length || 50); col++) {
      let hits = 0;
      for (let r = headerIdx + 1; r < Math.min(rows.length, headerIdx + 100); r++) {
        const v = (rows[r] && rows[r][col] ? rows[r][col] : '').toString().toLowerCase();
        if (v.includes('permit') && !v.includes('progress')) hits++;
      }
      if (hits > 20) { permitStatusIdx = col; break; }
    }
  }
  
  console.log('📊 Index kolom:', { progressFOIdx, custPrioIdx, permitStatusIdx });
  
  if (progressFOIdx === -1) throw new Error('Kolom Progress FO tidak ditemukan');
  if (custPrioIdx === -1) throw new Error('Kolom Cust PRIO tidak ditemukan');
  
  const statusCount = {}, permitCount = {};
  
  // Priority per status — dari kolom "Cust PRIO"
  const priorityByStatus = {
    'permit': {},
    'pulling cable': {},
    'pulling done': {}
  };
  
  // Priority overall (untuk fallback)
  const priorityOverall = {};
  
  let rowsProcessed = 0;
  
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    rowsProcessed++;
    
    // === Progress FO ===
    const progressRaw = (r[progressFOIdx] || '').toString().trim();
    const progressNorm = normalizeStatus(progressRaw);
    
    // Status count
    if (progressRaw && !progressRaw.startsWith('#') && !progressRaw.toLowerCase().includes('n/a')) {
      const label = normalizeLabel(progressRaw);
      if (label) statusCount[label] = (statusCount[label] || 0) + 1;
    }
    
    // === Cust PRIO (P1, P2, P3, P4, DROP) ===
    const prioRaw = (r[custPrioIdx] || '').toString().trim().toUpperCase();
    const prio = prioRaw.length > 0 && prioRaw.length < 10 ? prioRaw : '';
    
    if (prio && !prio.startsWith('#')) {
      // Overall
      priorityOverall[prio] = (priorityOverall[prio] || 0) + 1;
      
      // Per status — cek 3 status target
      // Progress FO biasanya format: "4. Permit", "5. Pulling cable", "6. Pulling done"
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
    
    // === Permit Status ===
    if (permitStatusIdx !== -1) {
      const permit = (r[permitStatusIdx] || '').toString().trim();
      if (permit && !permit.startsWith('#') && !permit.toLowerCase().includes('n/a')) {
        permitCount[permit] = (permitCount[permit] || 0) + 1;
      }
    }
  }
  
  console.log('📈 Rows processed:', rowsProcessed);
  
  // Format output
  const status = Object.keys(statusCount).map(k => ({ label: k, value: statusCount[k] }));
  const permit = Object.keys(permitCount).map(k => ({ label: k, value: permitCount[k] })).sort((a, b) => b.value - a.value);
  
  // Priority per status — urutkan P1, P2, P3, P4, DROP
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
  
  console.log('⭐ Priority Permit:', JSON.stringify(priorityByStatusFinal['permit']));
  console.log('⭐ Priority Pulling Cable:', JSON.stringify(priorityByStatusFinal['pulling cable']));
  console.log('⭐ Priority Pulling Done:', JSON.stringify(priorityByStatusFinal['pulling done']));
  
  return {
    status,
    priority: priorityOverallFinal,
    priorityByStatus: priorityByStatusFinal,
    permit
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
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
