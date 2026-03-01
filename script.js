/* ======================================================
   Codeforces Friends Tracker — script.js
   ====================================================== */

'use strict';

// ── Constants ────────────────────────────────────────────
const PAGE_SIZE       = 200;
const CACHE_TTL_MS    = 5 * 60 * 1000;   // 5 minutes
const MAX_HANDLES     = 15;
const LS_HANDLES      = 'cf_handles_v2';
const LS_CACHE        = 'cf_cache_v2';
const PERIOD_10_SEC   = 10 * 86400;
const PERIOD_60_SEC   = 60 * 86400;
const CONCURRENCY     = 5;

// ── State ─────────────────────────────────────────────────
let allSubmissions   = [];   // deduplicated, sorted newest first
let currentPage      = 1;
let userRatingMap    = {};   // handle.lower → {rating, display}
let perfChart        = null;

// ── DOM Ready ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildHandleTable();
  loadHandlesFromStorage();
  const saved = getSavedHandles().filter(Boolean);
  if (saved.length > 0) fetchAndDisplay();
});

// ── Handle Table ──────────────────────────────────────────
function buildHandleTable() {
  const tbody = document.getElementById('handleTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (let i = 0; i < MAX_HANDLES; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><input class="handle-input" id="handle_${i}" type="text"
           placeholder="e.g. tourist" autocomplete="off" spellcheck="false"
           onkeydown="if(event.key==='Enter') saveAndLoad()"></td>`;
    tbody.appendChild(tr);
  }
}

function loadHandlesFromStorage() {
  const handles = getSavedHandles();
  for (let i = 0; i < MAX_HANDLES; i++) {
    const el = document.getElementById(`handle_${i}`);
    if (el) el.value = handles[i] || '';
  }
}

function getSavedHandles() {
  try {
    const raw = localStorage.getItem(LS_HANDLES);
    const arr = raw ? JSON.parse(raw) : [];
    while (arr.length < MAX_HANDLES) arr.push('');
    return arr.slice(0, MAX_HANDLES);
  } catch {
    return new Array(MAX_HANDLES).fill('');
  }
}

function getActiveHandles() {
  return getSavedHandles().filter(h => h.trim().length > 0).map(h => h.trim());
}

function saveHandles() {
  const handles = [];
  for (let i = 0; i < MAX_HANDLES; i++) {
    handles.push((document.getElementById(`handle_${i}`)?.value || '').trim());
  }
  localStorage.setItem(LS_HANDLES, JSON.stringify(handles));
}

function saveAndLoad() {
  saveHandles();
  fetchAndDisplay();
}

// ── Cache ─────────────────────────────────────────────────
function readCache() {
  try { return JSON.parse(localStorage.getItem(LS_CACHE) || '{}'); }
  catch { return {}; }
}

function writeCache(key, data) {
  let cache = readCache();
  cache[key] = { data, ts: Date.now() };
  try {
    localStorage.setItem(LS_CACHE, JSON.stringify(cache));
  } catch {
    // Storage quota exceeded — clear old entries and retry once
    try {
      localStorage.removeItem(LS_CACHE);
      localStorage.setItem(LS_CACHE, JSON.stringify({ [key]: { data, ts: Date.now() } }));
    } catch { /* ignore */ }
  }
}

function getCached(key) {
  const entry = readCache()[key];
  if (entry && (Date.now() - entry.ts) < CACHE_TTL_MS) return entry.data;
  return null;
}

function clearCache() {
  localStorage.removeItem(LS_CACHE);
  setStatus('Cache cleared.');
}

// ── API Helpers ───────────────────────────────────────────
async function apiFetch(url, cacheKey) {
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.status !== 'OK') throw new Error(json.comment || 'API error');
  writeCache(cacheKey, json.result);
  return json.result;
}

async function fetchUserSubmissions(handle) {
  try {
    return await apiFetch(
      `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=1000`,
      `subs_${handle.toLowerCase()}`
    );
  } catch (e) {
    console.warn(`[CF] subs for ${handle}:`, e.message);
    return [];
  }
}

async function fetchUserInfo(handles) {
  const mapping = {};
  const CHUNK = 10;
  const promises = [];
  for (let i = 0; i < handles.length; i += CHUNK) {
    const chunk = handles.slice(i, i + CHUNK);
    const key = `info_${chunk.map(h => h.toLowerCase()).sort().join(',')}`;
    promises.push(
      apiFetch(
        `https://codeforces.com/api/user.info?handles=${chunk.map(encodeURIComponent).join(';')}`,
        key
      ).then(users => {
        users.forEach(u => {
          mapping[u.handle.toLowerCase()] = { rating: u.rating || null, display: u.handle };
        });
      }).catch(e => console.warn('[CF] user.info:', e.message))
    );
  }
  await Promise.all(promises);
  return mapping;
}

// ── Processing ────────────────────────────────────────────

/* Keep only last submission per problem (dedup by contestId+index). */
function deduplicateSubs(submissions, handle) {
  const map = {};
  for (const sub of submissions) {
    if (!sub.problem?.contestId || !sub.problem?.index) continue;
    const k = `${sub.problem.contestId}-${sub.problem.index}`;
    if (!map[k] || sub.creationTimeSeconds > map[k].creationTimeSeconds) map[k] = sub;
  }
  return Object.values(map).map(s => ({ ...s, handle }));
}

function computeStats(rawSubs, periodSec, uniqueSubs) {
  const cutoff = Math.floor(Date.now() / 1000) - periodSec;
  const inPeriodRaw    = rawSubs.filter(s => s.creationTimeSeconds >= cutoff);
  const inPeriodUnique = uniqueSubs.filter(s => s.creationTimeSeconds >= cutoff);

  let totalSolved = 0, ratingSum = 0, ratedCount = 0;
  for (const s of inPeriodUnique) {
    if (s.verdict === 'OK') {
      totalSolved++;
      if (s.problem.rating) { ratingSum += s.problem.rating; ratedCount++; }
    }
  }
  const avgRating = ratedCount > 0 ? (ratingSum / ratedCount).toFixed(2) : '0';
  const score     = (totalSolved * parseFloat(avgRating)).toFixed(2);
  return { totalSubmissions: inPeriodRaw.length, totalSolved, avgRating, score };
}

async function processAllHandles(handles) {
  const userStats = {};
  let combined    = [];
  let idx         = 0;

  async function worker() {
    while (idx < handles.length) {
      const i      = idx++;
      const handle = handles[i];
      setLoadingMsg(`Fetching ${handle}… (${i + 1} / ${handles.length})`);
      const raw    = await fetchUserSubmissions(handle);
      const unique = deduplicateSubs(raw, handle);
      combined     = combined.concat(unique);
      userStats[handle.toLowerCase()] = {
        period10: computeStats(raw, PERIOD_10_SEC, unique),
        period60: computeStats(raw, PERIOD_60_SEC, unique),
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, handles.length) }, worker));
  return { userStats, combined };
}

// ── Main Fetch & Display ──────────────────────────────────
async function fetchAndDisplay() {
  const handles = getActiveHandles();
  if (handles.length === 0) {
    document.getElementById('settingsPanel').open = true;
    alert('Please enter at least one Codeforces handle in the settings table.');
    return;
  }

  showLoading(true);
  hide('rankingSection');
  hide('submissionSection');
  hide('chartSection');
  setStatus('');

  try {
    setLoadingMsg('Fetching user profiles…');
    userRatingMap = await fetchUserInfo(handles);

    setLoadingMsg('Fetching submissions…');
    const { userStats, combined } = await processAllHandles(handles);

    allSubmissions = combined.sort((a, b) => b.creationTimeSeconds - a.creationTimeSeconds);
    currentPage    = 1;

    setLoadingMsg('Rendering…');
    displayRanking(userStats);
    renderChart(userStats);
    renderSubmissions();

    const ts = new Date().toLocaleTimeString();
    setStatus(`Last loaded: ${ts} · ${allSubmissions.length} unique submissions across ${handles.length} handle(s)`);
    show('rankingSection');
    show('submissionSection');
    show('chartSection');
  } catch (e) {
    console.error(e);
    alert('An error occurred: ' + e.message);
  } finally {
    showLoading(false);
  }
}

// ── Ranking Table ─────────────────────────────────────────
function displayRanking(userStats) {
  const rows = Object.entries(userStats).map(([handle, stats]) => ({
    handle,
    s10: stats.period10,
    s60: stats.period60,
  }));
  rows.sort((a, b) => parseFloat(b.s10.score) - parseFloat(a.s10.score));

  const tbody = document.getElementById('rankingTableBody');
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10">No data found.</td></tr>';
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach(({ handle, s10, s60 }, i) => {
    const ui    = userRatingMap[handle] || { rating: null, display: handle };
    const color = ratingColor(ui.rating);
    const tr    = document.createElement('tr');
    tr.innerHTML = `
      <td class="num-col">${i + 1}</td>
      <td><a href="https://codeforces.com/profile/${esc(ui.display)}"
             target="_blank" style="color:${color}">${esc(ui.display)}</a></td>
      <td>${s10.totalSolved}</td>
      <td style="color:${ratingColor(parseFloat(s10.avgRating))}">${s10.avgRating}</td>
      <td>${s10.totalSubmissions}</td>
      <td><b>${s10.score}</b></td>
      <td>${s60.totalSolved}</td>
      <td style="color:${ratingColor(parseFloat(s60.avgRating))}">${s60.avgRating}</td>
      <td>${s60.totalSubmissions}</td>
      <td><b>${s60.score}</b></td>`;
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

// ── Chart (Chart.js) ──────────────────────────────────────
function renderChart(userStats) {
  const canvas = document.getElementById('performanceChart');
  if (!canvas || typeof Chart === 'undefined') return;

  // Sort by 10-day score descending (same as ranking)
  const sorted = Object.entries(userStats)
    .map(([handle, stats]) => ({ handle, s10: stats.period10, s60: stats.period60 }))
    .sort((a, b) => parseFloat(b.s10.score) - parseFloat(a.s10.score));

  const labels   = sorted.map(d => (userRatingMap[d.handle] || { display: d.handle }).display);
  const sold10   = sorted.map(d => d.s10.totalSolved);
  const sold60   = sorted.map(d => d.s60.totalSolved);
  const score10  = sorted.map(d => parseFloat(d.s10.score));

  if (perfChart) perfChart.destroy();

  perfChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Solved — Last 10 days',
          data: sold10,
          backgroundColor: 'rgba(33, 150, 243, 0.75)',
          borderColor: '#2196f3',
          borderWidth: 1,
          yAxisID: 'ySolved',
        },
        {
          label: 'Solved — Last 60 days',
          data: sold60,
          backgroundColor: 'rgba(76, 175, 80, 0.65)',
          borderColor: '#4caf50',
          borderWidth: 1,
          yAxisID: 'ySolved',
        },
        {
          label: 'Score — Last 10 days',
          data: score10,
          type: 'line',
          borderColor: '#ff9800',
          backgroundColor: 'rgba(255,152,0,0.15)',
          pointBackgroundColor: '#ff9800',
          borderWidth: 2,
          fill: false,
          tension: 0.3,
          yAxisID: 'yScore',
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#ccc', font: { size: 12 } } },
        tooltip: { backgroundColor: '#222', titleColor: '#eee', bodyColor: '#ccc' },
      },
      scales: {
        x: {
          ticks: { color: '#ccc', maxRotation: 45 },
          grid:  { color: '#2a2a2a' },
        },
        ySolved: {
          type: 'linear',
          position: 'left',
          beginAtZero: true,
          ticks: { color: '#2196f3', precision: 0 },
          grid:  { color: '#2a2a2a' },
          title: { display: true, text: 'Problems Solved', color: '#90caf9' },
        },
        yScore: {
          type: 'linear',
          position: 'right',
          beginAtZero: true,
          ticks: { color: '#ff9800' },
          grid:  { drawOnChartArea: false },
          title: { display: true, text: 'Score (10d)', color: '#ff9800' },
        },
      },
    },
  });
}

// ── Submission Pagination ─────────────────────────────────
function renderSubmissions() {
  const tbody   = document.getElementById('solvedTableBody');
  if (!tbody) return;

  const start   = (currentPage - 1) * PAGE_SIZE;
  const pageData = allSubmissions.slice(start, start + PAGE_SIZE);
  const frag    = document.createDocumentFragment();

  pageData.forEach((sub, i) => {
    const ui          = userRatingMap[sub.handle?.toLowerCase()] || { rating: null, display: sub.handle };
    const uColor      = ratingColor(ui.rating);
    const pColor      = ratingColor(sub.problem.rating);
    const vText       = verdictText(sub);
    const vColor      = vText === 'Accepted' ? '#66bb6a' : '#ef5350';
    const tags        = sub.problem.tags?.join(', ') || 'N/A';
    const timeStr     = new Date(sub.creationTimeSeconds * 1000).toLocaleString();

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="num-col">${start + i + 1}</td>
      <td><a href="https://codeforces.com/profile/${esc(ui.display)}"
             target="_blank" style="color:${uColor}">${esc(ui.display)}</a></td>
      <td><a href="https://codeforces.com/contest/${sub.problem.contestId}/problem/${sub.problem.index}"
             target="_blank" style="color:${pColor}">
             ${sub.problem.contestId}-${sub.problem.index}: ${esc(sub.problem.name)}</a></td>
      <td><a href="https://codeforces.com/contest/${sub.problem.contestId}/submission/${sub.id}"
             target="_blank" style="color:${vColor}">${vText}</a></td>
      <td>${sub.problem.rating || 'N/A'}</td>
      <td class="tags-cell">${esc(tags)}</td>
      <td class="time-cell">${timeStr}</td>`;
    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);
  renderPagination();
  scrollTo(document.getElementById('submissionSection'));
}

function renderPagination() {
  const total    = allSubmissions.length;
  const pages    = Math.ceil(total / PAGE_SIZE);
  const html     = pages <= 1 ? '' : buildPaginationHTML(pages, total);
  const topEl    = document.getElementById('paginationTop');
  const botEl    = document.getElementById('paginationBottom');
  if (topEl) topEl.innerHTML = html;
  if (botEl) botEl.innerHTML = html;
}

function buildPaginationHTML(pages, total) {
  const p   = currentPage;
  const btn = (label, page, active = false, disabled = false) =>
    `<button onclick="goToPage(${page})"
      class="${active ? 'pg-active' : ''}"
      ${disabled ? 'disabled' : ''}>${label}</button>`;

  let html = `<span class="page-info">Page ${p}/${pages} · ${total} submissions</span>`;
  html += btn('«', 1, false, p === 1);
  html += btn('‹', p - 1, false, p === 1);

  const lo = Math.max(1, p - 2);
  const hi = Math.min(pages, p + 2);
  if (lo > 1)     html += `<span style="color:#666;padding:0 4px">…</span>`;
  for (let i = lo; i <= hi; i++) html += btn(i, i, i === p);
  if (hi < pages) html += `<span style="color:#666;padding:0 4px">…</span>`;

  html += btn('›', p + 1, false, p === pages);
  html += btn('»', pages, false, p === pages);
  return html;
}

function goToPage(page) {
  const pages = Math.ceil(allSubmissions.length / PAGE_SIZE);
  if (page < 1 || page > pages || page === currentPage) return;
  currentPage = page;
  renderSubmissions();
}

// ── Rating Colour ─────────────────────────────────────────
function ratingColor(r) {
  if (!r || r <= 0) return '#9e9e9e';
  if (r < 1200) return '#9e9e9e';
  if (r < 1400) return '#27ae60';
  if (r < 1600) return '#16a085';
  if (r < 1900) return '#427bf5';
  if (r < 2100) return '#c039d4';
  if (r < 2400) return '#d35400';
  return '#e74c3c';
}

// ── Verdict Text ──────────────────────────────────────────
function verdictText(sub) {
  const v = sub.verdict;
  if (v === 'OK')                     return 'Accepted';
  if (v === 'WRONG_ANSWER')           return `WA on test ${(sub.passedTestCount ?? 0) + 1}`;
  if (v === 'TIME_LIMIT_EXCEEDED')    return 'TLE';
  if (v === 'MEMORY_LIMIT_EXCEEDED')  return 'MLE';
  if (v === 'COMPILATION_ERROR')      return 'CE';
  if (v === 'RUNTIME_ERROR')          return 'RTE';
  if (v === 'IDLENESS_LIMIT_EXCEEDED') return 'ILE';
  return v || 'Unknown';
}

// ── Utility ───────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function show(id) { const el = document.getElementById(id); if (el) el.style.display = ''; }
function hide(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

function showLoading(on) {
  const el = document.getElementById('loading');
  if (el) el.style.display = on ? 'block' : 'none';
}

function setLoadingMsg(msg) {
  const el = document.getElementById('loadingMsg');
  if (el) el.textContent = msg;
}

function setStatus(msg) {
  const el = document.getElementById('statusBar');
  if (el) el.textContent = msg;
}
