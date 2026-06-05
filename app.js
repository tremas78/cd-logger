// ── CONFIG ────────────────────────────────────────────────────────────────────
const CLIENT_ID    = '467117745013-5vd0ap9gab4gda8srqmllatj458v8se1.apps.googleusercontent.com';
const DRIVE_FILE_NAME = 'cd-logger-catalogue.json';
const SHARED_FILE_ID  = '1BdLiiLLiDpjUua00uadzVsWjuKLOILG4';
const SCOPE        = 'https://www.googleapis.com/auth/drive';
const STORAGE_KEY  = 'cd_catalogue_v1';
const TOKEN_KEY    = 'cd_logger_token';
const FILE_ID_KEY  = 'cd_logger_file_id';

// ── STATE ─────────────────────────────────────────────────────────────────────
let catalogue      = [];
let pendingLookup  = null;
let scannerRunning = false;
let stickyLocation = '';
let accessToken    = null;
let driveFileId    = null;
let isSaving       = false;
let saveQueued     = false;
let offlineMode    = false;

// ── GOOGLE SIGN IN ────────────────────────────────────────────────────────────
function signIn() {
  const client = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: async (response) => {
      if (response.error) {
        document.getElementById('signin-error').style.display = 'block';
        return;
      }
      accessToken = response.access_token;
      sessionStorage.setItem(TOKEN_KEY, accessToken);
      await startApp();
    }
  });
  client.requestAccessToken();
}

async function refreshFromDrive() {
  if (offlineMode) { toast('Not connected to Drive', 'error'); return; }
  const btn = document.getElementById('refresh-btn');
  btn.textContent = '↻ Syncing…';
  btn.disabled = true;
  await loadFromDrive();
  renderCatalogue();
  updateCount();
  btn.textContent = '↻ Sync';
  btn.disabled = false;
}

function signOut() {
  if (accessToken) google.accounts.oauth2.revoke(accessToken);
  accessToken  = null;
  driveFileId  = null;
  offlineMode  = false;
  sessionStorage.removeItem(TOKEN_KEY);
  catalogue = [];
  document.getElementById('app').style.display = 'none';
  document.getElementById('signin-screen').style.display = 'flex';
  setSyncStatus('idle', 'Signed out');
}

function startOfflineMode() {
  offlineMode = true;
  document.getElementById('signin-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('sync-email').textContent = 'Offline mode';
  setSyncStatus('error', 'Not connected to Google Drive');
  // Load from local cache
  try { catalogue = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch(e) { catalogue = []; }
  renderCatalogue();
  updateCount();
}

async function startApp() {
  document.getElementById('signin-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  // Show user email
  try {
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    const info = await resp.json();
    document.getElementById('sync-email').textContent = info.email || '';
  } catch(e) {}

  await loadFromDrive();
  renderCatalogue();
  updateCount();
}

// ── SYNC STATUS ───────────────────────────────────────────────────────────────
function setSyncStatus(state, text) {
  const dot  = document.getElementById('sync-dot');
  const label = document.getElementById('sync-text');
  dot.className = 'syncing error synced'.includes(state) ? state : '';
  if (state === 'syncing') dot.classList.add('syncing');
  else if (state === 'synced') dot.classList.add('synced');
  else if (state === 'error') dot.classList.add('error');
  label.textContent = text;
}

// ── DRIVE READ ────────────────────────────────────────────────────────────────
// Search Drive for our file by name (only finds files this app created)
async function findDriveFile() {
  const name = encodeURIComponent(DRIVE_FILE_NAME);
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=name='${DRIVE_FILE_NAME}'+and+trashed=false&spaces=drive&fields=files(id,name)`,
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );
  if (!resp.ok) throw new Error('Could not search Drive');
  const data = await resp.json();
  return (data.files && data.files.length > 0) ? data.files[0].id : null;
}

// Create a new empty catalogue file in Drive
async function createDriveFile() {
  // Step 1: create the file metadata (no content yet)
  const metaResp = await fetch(
    'https://www.googleapis.com/drive/v3/files?fields=id',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: DRIVE_FILE_NAME, mimeType: 'application/json' })
    }
  );
  if (!metaResp.ok) throw new Error('Could not create Drive file');
  const meta = await metaResp.json();
  const newId = meta.id;

  // Step 2: upload the initial empty content
  const body = JSON.stringify({ version: 1, catalogue: [] });
  const uploadResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files/' + newId + '?uploadType=media',
    {
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: body
    }
  );
  if (!uploadResp.ok) throw new Error('Could not initialise Drive file');
  return newId;
}

async function loadFromDrive() {
  setSyncStatus('syncing', 'Connecting to Google Drive…');
  try {
    // Always use the shared file ID first — falls back to search if needed
    driveFileId = SHARED_FILE_ID || localStorage.getItem(FILE_ID_KEY) || null;

    if (!driveFileId) {
      setSyncStatus('syncing', 'Looking for collection file…');
      driveFileId = await findDriveFile();
    }

    if (!driveFileId) {
      setSyncStatus('syncing', 'Creating collection file…');
      driveFileId = await createDriveFile();
      localStorage.setItem(FILE_ID_KEY, driveFileId);
      catalogue = [];
      const t = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
      setSyncStatus('synced', `Ready — new file created at ${t}`);
      return;
    }

    // File found — store ID locally and load content
    localStorage.setItem(FILE_ID_KEY, driveFileId);
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
      { headers: { 'Authorization': 'Bearer ' + accessToken } }
    );
    if (!resp.ok) {
      // Stored ID may be stale — clear it and try searching again
      localStorage.removeItem(FILE_ID_KEY);
      driveFileId = await findDriveFile();
      if (!driveFileId) driveFileId = await createDriveFile();
      localStorage.setItem(FILE_ID_KEY, driveFileId);
      const resp2 = await fetch(
        `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
        { headers: { 'Authorization': 'Bearer ' + accessToken } }
      );
      if (!resp2.ok) throw new Error('HTTP ' + resp2.status);
      const data2 = await resp2.json();
      catalogue = data2.catalogue || [];
    } else {
      const data = await resp.json();
      catalogue = data.catalogue || [];
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(catalogue));
    const t = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    setSyncStatus('synced', `Synced at ${t}`);

  } catch(e) {
    console.error('loadFromDrive failed:', e);
    try { catalogue = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch(e2) { catalogue = []; }
    setSyncStatus('error', 'Drive unavailable — using local cache');
    toast('Could not reach Google Drive — showing cached data', 'error');
  }
}

// ── DRIVE WRITE ───────────────────────────────────────────────────────────────
async function saveToDrive() {
  if (isSaving) { saveQueued = true; return; }
  isSaving = true;
  setSyncStatus('syncing', 'Saving…');

  // Also update local cache
  localStorage.setItem(STORAGE_KEY, JSON.stringify(catalogue));

  try {
    const body = JSON.stringify({ version: 1, updated: new Date().toISOString(), catalogue }, null, 2);
    if (!driveFileId) throw new Error('No file ID — try reloading');
    const resp = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body
      }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Drive save error', resp.status, errText);
      throw new Error('HTTP ' + resp.status);
    }
    const t = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    setSyncStatus('synced', `Saved at ${t}`);
  } catch(e) {
    setSyncStatus('error', 'Save failed — changes kept locally');
    toast('Could not save to Drive — data kept locally', 'error');
  }

  isSaving = false;
  if (saveQueued) { saveQueued = false; saveToDrive(); }
}

function save() {
  updateCount();
  if (offlineMode) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(catalogue));
    setSyncStatus('error', 'Offline — changes saved locally only');
    return;
  }
  saveToDrive();
}

function updateCount() {
  const n = catalogue.length;
  document.getElementById('header-count').textContent = n === 1 ? '1 disc' : `${n} discs`;
}

// ── UI ────────────────────────────────────────────────────────────────────────
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  const idx = ['catalogue','add','data'].indexOf(name);
  document.querySelectorAll('.nav-btn')[idx].classList.add('active');
  if (name === 'catalogue') renderCatalogue();
}

function switchAddTab(tab, btn) {
  document.querySelectorAll('.add-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.add-sub').forEach(s => s.classList.remove('active'));
  document.getElementById('sub-' + tab).classList.add('active');
  if (btn) btn.classList.add('active');
  if (tab !== 'scan') stopScanner();
}

function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  renderCatalogue();
}

function updateClearBtn() {
  const hasText = document.getElementById('search-input').value.length > 0;
  document.getElementById('search-clear').style.display = hasText ? 'block' : 'none';
}

function syncLocation(val) {
  stickyLocation = val.toUpperCase();
  const scanEl   = document.getElementById('scan-location');
  const manualEl = document.getElementById('m-location');
  if (scanEl   && scanEl.value.toUpperCase()   !== stickyLocation) scanEl.value   = stickyLocation;
  if (manualEl && manualEl.value.toUpperCase() !== stickyLocation) manualEl.value = stickyLocation;
}

// ── CATALOGUE ─────────────────────────────────────────────────────────────────
function renderCatalogue() {
  const q    = document.getElementById('search-input').value.trim().toLowerCase();
  const sort = document.getElementById('sort-select').value;
  let items  = catalogue.filter(cd =>
    !q || cd.artist.toLowerCase().includes(q) || cd.title.toLowerCase().includes(q) || (cd.location||'').toLowerCase().includes(q)
  );
  items.sort((a,b) => {
    if (sort==='artist') return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
    if (sort==='title')  return a.title.localeCompare(b.title);
    if (sort==='year')   return (a.year||'9999').localeCompare(b.year||'9999');
    return (b.added||0) - (a.added||0);
  });
  const listEl  = document.getElementById('cd-list');
  const rowsEl  = document.getElementById('cd-rows');
  const emptyEl = document.getElementById('empty-state');
  if (items.length === 0) { listEl.style.display='none'; emptyEl.style.display='block'; return; }
  emptyEl.style.display = 'none';
  listEl.style.display  = 'block';
  rowsEl.innerHTML = items.map(cd => `
    <div class="cd-row">
      <div class="cd-row-artist">${esc(cd.artist)}</div>
      <div class="cd-row-title">${esc(cd.title)}</div>
      <div class="cd-row-year">${esc(cd.year)}</div>
      <div class="cd-row-label">${esc(cd.label)}</div>
      <div class="cd-row-actions">
        <button class="cd-row-btn edit" data-cdid="${esc(cd.id)}" title="View / Edit">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </button>
        <button class="cd-row-btn del" data-cdid="${esc(cd.id)}" title="Remove">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>`).join('');
}

document.addEventListener('click', function(e) {
  const btn = e.target.closest('.cd-row-btn');
  if (!btn) return;
  const rawId = btn.getAttribute('data-cdid');
  const id = rawId.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
  if (btn.classList.contains('del'))  deleteCD(id);
  if (btn.classList.contains('edit')) openEditModal(id);
});

function deleteCD(id) {
  if (!confirm('Remove this CD from your catalogue?')) return;
  catalogue = catalogue.filter(cd => cd.id !== id);
  save(); renderCatalogue();
  toast('Removed from collection');
}

// ── EDIT MODAL ────────────────────────────────────────────────────────────────
function openEditModal(id) {
  const cd = catalogue.find(c => c.id === id);
  if (!cd) return;
  document.getElementById('edit-id').value      = id;
  document.getElementById('edit-artist').value  = cd.artist;
  document.getElementById('edit-title').value   = cd.title;
  document.getElementById('edit-year').value    = cd.year    || '';
  document.getElementById('edit-label').value   = cd.label   || '';
  document.getElementById('edit-barcode').value = cd.barcode || '';
  document.getElementById('edit-location').value= cd.location|| '';
  document.getElementById('edit-notes').value   = cd.notes   || '';
  document.getElementById('edit-modal').classList.add('open');
}

function closeEditModal(e) {
  if (e && e.target !== document.getElementById('edit-modal')) return;
  document.getElementById('edit-modal').classList.remove('open');
}

function saveEdit() {
  const id     = document.getElementById('edit-id').value;
  const artist = document.getElementById('edit-artist').value.trim();
  const title  = document.getElementById('edit-title').value.trim();
  if (!artist || !title) { toast('Artist and title are required', 'error'); return; }
  const cd = catalogue.find(c => c.id === id);
  if (!cd) return;
  cd.artist   = artist;
  cd.title    = title;
  cd.year     = document.getElementById('edit-year').value.trim();
  cd.label    = document.getElementById('edit-label').value.trim();
  cd.barcode  = document.getElementById('edit-barcode').value.trim();
  cd.location = document.getElementById('edit-location').value.trim().toUpperCase();
  cd.notes    = document.getElementById('edit-notes').value.trim();
  save(); renderCatalogue();
  document.getElementById('edit-modal').classList.remove('open');
  toast('Changes saved', 'success');
}

// ── SCANNER ───────────────────────────────────────────────────────────────────
function startScanner() {
  const viewport = document.getElementById('scanner-viewport');
  viewport.style.display = 'block';
  document.getElementById('scan-btn').style.display = 'none';
  document.getElementById('stop-btn').style.display = 'inline-block';
  document.getElementById('scan-result').className = 'scan-result';
  Quagga.init({
    inputStream: {
      name: 'Live', type: 'LiveStream', target: viewport,
      constraints: { facingMode: 'environment', width: { min: 400 }, height: { min: 300 } }
    },
    decoder: { readers: ['ean_reader','ean_8_reader','upc_reader','upc_e_reader'] },
    locate: true
  }, err => {
    if (err) { showScanResult('Camera error: ' + err.message + '. Try entering the barcode manually.', false); stopScanner(); return; }
    Quagga.start(); scannerRunning = true;
    try {
      const video = document.querySelector('#scanner-viewport video');
      if (video && video.srcObject) window._cdLoggerStream = video.srcObject;
    } catch(e) {}
  });
  Quagga.offDetected();
  Quagga.onDetected(result => {
    const code = result.codeResult.code;
    stopScanner();
    document.getElementById('barcode-input').value = code;
    lookupBarcode();
  });
}

function stopScanner() {
  if (scannerRunning) { try { Quagga.stop(); } catch(e){} scannerRunning = false; }
  try {
    if (window._cdLoggerStream) { window._cdLoggerStream.getTracks().forEach(t => t.stop()); window._cdLoggerStream = null; }
  } catch(e) {}
  const viewport = document.getElementById('scanner-viewport');
  viewport.querySelectorAll('video, canvas').forEach(el => {
    try { if (el.srcObject) { el.srcObject.getTracks().forEach(t => t.stop()); el.srcObject = null; } } catch(e) {}
    el.remove();
  });
  document.querySelectorAll('canvas[class*="drawingBuffer"]').forEach(c => c.remove());
  viewport.style.display = 'none';
  document.getElementById('scan-btn').style.display = 'inline-block';
  document.getElementById('stop-btn').style.display = 'none';
}

// ── LOOKUP ────────────────────────────────────────────────────────────────────
async function lookupBarcode() {
  const barcode = document.getElementById('barcode-input').value.trim().replace(/\D/g,'');
  if (!barcode) { toast('Please enter a barcode', 'error'); return; }
  document.getElementById('loading-indicator').style.display = 'block';
  document.getElementById('lookup-confirm').style.display = 'none';
  document.getElementById('scan-result').className = 'scan-result';
  pendingLookup = null;
  try {
    let data = await fetchMusicBrainz(barcode);
    if (!data) data = await fetchUPCitemdb(barcode);
    document.getElementById('loading-indicator').style.display = 'none';
    if (data) {
      pendingLookup = { ...data, barcode };
      showLookupPreview(data);
    } else {
      showScanResult(`No match found for barcode ${barcode}. Add it manually.`, false);
      document.getElementById('m-barcode').value = barcode;
    }
  } catch(e) {
    document.getElementById('loading-indicator').style.display = 'none';
    showScanResult('Lookup failed — check your connection.', false);
  }
}

async function fetchMusicBrainz(barcode) {
  const url  = `https://musicbrainz.org/ws/2/release/?query=barcode:${barcode}&fmt=json&limit=1`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'CDCatalogue/1.0 (personal)' } });
  if (!resp.ok) return null;
  const json = await resp.json();
  if (!json.releases || !json.releases.length) return null;
  const r      = json.releases[0];
  const artist = r['artist-credit'] ? r['artist-credit'].map(a => a.name||(a.artist&&a.artist.name)||'').filter(Boolean).join(', ') : '';
  const year   = r.date ? r.date.substring(0,4) : '';
  const labelInfo = r['label-info'];
  const label  = (labelInfo && labelInfo[0] && labelInfo[0].label) ? labelInfo[0].label.name : '';
  if (!artist && !r.title) return null;
  return { artist: artist||'Unknown Artist', title: r.title||'Unknown Title', year, label };
}

async function fetchUPCitemdb(barcode) {
  try {
    const resp = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`);
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json.items || !json.items.length) return null;
    const item = json.items[0];
    let artist = item.brand || '';
    let title  = item.title || '';
    if (!artist && title.includes(' - ')) {
      const parts = title.split(' - ');
      artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim();
    }
    if (!title) return null;
    return { artist: artist||'Unknown Artist', title, year:'', label:'' };
  } catch(e) { return null; }
}

function showLookupPreview(data) {
  document.getElementById('lookup-preview').innerHTML = `
    <div class="lp-artist">${esc(data.artist)}</div>
    <div class="lp-title">${esc(data.title)}</div>
    <div class="lp-meta">${[data.year, data.label].filter(Boolean).join(' · ') || 'Match found'}</div>`;
  document.getElementById('lookup-confirm').style.display = 'block';
  document.getElementById('scan-result').className = 'scan-result success show';
  document.getElementById('scan-result').textContent = '✓ Found a match — confirm below or edit details';
}

function showScanResult(msg, success) {
  const el = document.getElementById('scan-result');
  el.textContent = msg;
  el.className = 'scan-result show ' + (success ? 'success' : 'error');
}

function confirmLookup() {
  if (!pendingLookup) return;
  addCD({ ...pendingLookup, location: stickyLocation }); pendingLookup = null;
  document.getElementById('lookup-confirm').style.display = 'none';
  document.getElementById('barcode-input').value = '';
  document.getElementById('scan-result').className = 'scan-result';
}

function editLookup() {
  if (!pendingLookup) return;
  document.getElementById('m-artist').value   = pendingLookup.artist  || '';
  document.getElementById('m-title').value    = pendingLookup.title   || '';
  document.getElementById('m-year').value     = pendingLookup.year    || '';
  document.getElementById('m-label').value    = pendingLookup.label   || '';
  document.getElementById('m-barcode').value  = pendingLookup.barcode || '';
  document.getElementById('m-location').value = stickyLocation;
  document.querySelectorAll('.add-tab')[1].click();
  switchAddTab('manual', document.querySelectorAll('.add-tab')[1]);
  pendingLookup = null;
}

function cancelLookup() {
  pendingLookup = null;
  document.getElementById('lookup-confirm').style.display = 'none';
  document.getElementById('barcode-input').value = '';
  document.getElementById('scan-result').className = 'scan-result';
}

// ── MANUAL ADD ────────────────────────────────────────────────────────────────
function addManual() {
  const artist   = document.getElementById('m-artist').value.trim();
  const title    = document.getElementById('m-title').value.trim();
  const year     = document.getElementById('m-year').value.trim();
  const label    = document.getElementById('m-label').value.trim();
  const barcode  = document.getElementById('m-barcode').value.trim();
  const location = document.getElementById('m-location').value.trim().toUpperCase();
  if (!artist || !title) { toast('Artist and title are required', 'error'); return; }
  if (location) syncLocation(location);
  addCD({ artist, title, year, label, barcode, location });
  ['m-artist','m-title','m-year','m-label','m-barcode'].forEach(id => document.getElementById(id).value = '');
}

function addCD(data) {
  if (data.barcode && catalogue.some(cd => cd.barcode === data.barcode)) {
    toast('CD Already in Collection!', 'error'); return;
  }
  catalogue.push({
    id:       Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    artist:   data.artist,   title:    data.title,
    year:     data.year   || '', label:    data.label   || '',
    barcode:  data.barcode|| '', location: data.location|| '',
    notes:    data.notes   || '',
    added:    Date.now()
  });
  save();
  toast(`Added: ${data.artist} — ${data.title}`, 'success');
}

// ── EXPORT / IMPORT ───────────────────────────────────────────────────────────
function exportJSON() {
  if (!catalogue.length) { toast('Nothing to export yet', 'error'); return; }
  const filename = 'cd-catalogue-' + new Date().toISOString().slice(0,10) + '.json';
  const blob = new Blob([JSON.stringify({ version:1, exported: new Date().toISOString(), catalogue }, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  document.getElementById('export-confirm').style.display = 'block';
  document.getElementById('export-filename').textContent = filename;
}

function importJSON(input) {
  const file = input.files[0];
  if (!file) return;
  const resultEl = document.getElementById('import-confirm');
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data  = JSON.parse(e.target.result);
      const items = data.catalogue || (Array.isArray(data) ? data : null);
      if (!items) throw new Error('Unrecognised format.');
      let added = 0;
      items.forEach(cd => {
        if (!cd.artist || !cd.title) return;
        if (!cd.id) cd.id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
        if (!catalogue.some(x => x.id === cd.id)) { catalogue.push(cd); added++; }
      });
      save(); renderCatalogue();
      resultEl.style.cssText = 'display:block;padding:0.9rem 1rem;border-radius:8px;font-size:0.85rem;background:var(--surface2);border:1px solid var(--success);border-left:3px solid var(--success);color:var(--text2);';
      resultEl.innerHTML = `<span style="color:var(--success);font-weight:500;">✓ Imported!</span> Added ${added} CDs. Collection now has ${catalogue.length} in total.`;
    } catch(err) {
      resultEl.style.cssText = 'display:block;padding:0.9rem 1rem;border-radius:8px;font-size:0.85rem;background:var(--surface2);border:1px solid var(--danger);color:var(--danger);';
      resultEl.textContent = 'Import failed: ' + err.message;
    }
    input.value = '';
  };
  reader.readAsText(file);
}

function clearAll() {
  if (!catalogue.length) { toast('Collection is already empty'); return; }
  if (!confirm(`Delete all ${catalogue.length} CDs? This cannot be undone.`)) return;
  catalogue = [];
  localStorage.removeItem(STORAGE_KEY);
  save(); renderCatalogue();
  toast('Collection cleared');
}

// ── INIT ──────────────────────────────────────────────────────────────────────
// Check for existing session token
window.addEventListener('load', () => {
  const cached = sessionStorage.getItem(TOKEN_KEY);
  // ── FLOATING CD WALLPAPER ──
  (function() {
    const canvas = document.getElementById('cd-canvas');
    const COUNT  = 9;
    const COLOR  = 'rgba(232, 210, 120, 0.15)';
    const STROKE = 'rgba(232, 210, 120, 0.28)';

    function makeSVG(size) {
      const r = size / 2, hole = r * 0.12, inner = r * 0.38;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${r}" cy="${r}" r="${r-1}" fill="none" stroke="${STROKE}" stroke-width="1.2"/>
        <circle cx="${r}" cy="${r}" r="${inner}" fill="none" stroke="${COLOR}" stroke-width="0.8"/>
        <circle cx="${r}" cy="${r}" r="${hole}" fill="none" stroke="${STROKE}" stroke-width="1"/>
      </svg>`;
    }

    function rand(min, max) { return min + Math.random() * (max - min); }

    function createCD() {
      const size = 30 + Math.random() * 10;
      const el = document.createElement('div');
      el.className = 'cd-float';
      el.innerHTML = makeSVG(size);
      el.style.width  = size + 'px';
      el.style.height = size + 'px';
      canvas.appendChild(el);

      const margin = 20;
      const vw = () => window.innerWidth  - size - margin;
      const vh = () => window.innerHeight - size - margin;

      let x = rand(margin, vw());
      let y = rand(margin, vh());
      let tx = rand(margin, vw());
      let ty = rand(margin, vh());
      let angle = 0;
      const speed = rand(0.15, 0.35);

      const fadeDur   = rand(8, 14) * 1000;
      const fadeDelay = rand(0, fadeDur);
      el.style.animation = `cdFade ${fadeDur}ms ease-in-out ${-fadeDelay}ms infinite`;
      el.style.left = x + 'px';
      el.style.top  = y + 'px';

      function move() {
        const dx = tx - x;
        const dy = ty - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 2) {
          tx = rand(margin, vw());
          ty = rand(margin, vh());
        } else {
          x += (dx / dist) * speed;
          y += (dy / dist) * speed;
          angle += 0.06;
          el.style.left      = x + 'px';
          el.style.top       = y + 'px';
          el.style.transform = `rotate(${angle}deg)`;
        }
        requestAnimationFrame(move);
      }

      setTimeout(move, rand(0, 2000));
    }

    for (let i = 0; i < COUNT; i++) createCD();
  })();

  // ── BACK TO TOP ──
  (function() {
    const btn = document.getElementById('back-to-top');
    window.addEventListener('scroll', () => {
      btn.classList.toggle('visible', window.scrollY > 300);
    }, { passive: true });
    btn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  })();

  if (cached) {
    accessToken = cached;
    startApp();
  }
});
