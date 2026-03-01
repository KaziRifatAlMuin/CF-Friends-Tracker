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
const CONCURRENCY     = 4;
const SUB_PAGE_SIZE   = 1000;             // CF API max per request
const MAX_SUBS        = 10000;            // safety cap per user

// ── State ─────────────────────────────────────────────────
let allSubmissions = [];   // best-verdict-dedup'd, all users, sorted newest first
let currentPage    = 1;
let userRatingMap  = {};   // handle.lower → { rating, display }
let lastUserStats  = {};   // handle.lower → { period10, period60 }
let charts             = {};   // named Chart.js instances
const chartCollapseState = {}; // boxId → collapsed boolean

// ── DOM Ready ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  buildHandleTable();
  loadHandlesFromStorage();
  if (getSavedHandles().some(Boolean)) fetchAndDisplay();
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
  } catch { return new Array(MAX_HANDLES).fill(''); }
}

function getActiveHandles() {
  return getSavedHandles().filter(h => h.trim()).map(h => h.trim());
}

function saveHandles() {
  const handles = [];
  for (let i = 0; i < MAX_HANDLES; i++)
    handles.push((document.getElementById(`handle_${i}`)?.value || '').trim());
  localStorage.setItem(LS_HANDLES, JSON.stringify(handles));
}

function saveAndLoad() { saveHandles(); fetchAndDisplay(); }

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
  setStatus('Cache cleared. Next load will fetch fresh data from the API.');
}

// ── API: fetch ALL submissions with pagination ────────────
async function fetchAllUserSubmissions(handle) {
  const cacheKey = `allsubs2_${handle.toLowerCase()}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;

  let allSubs = [];
  let from    = 1;

  while (true) {
    let json;
    try {
      const resp = await fetch(
        `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=${from}&count=${SUB_PAGE_SIZE}`
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      json = await resp.json();
    } catch (e) {
      console.warn(`[CF] page fetch failed for ${handle} (from=${from}):`, e.message);
      break;
    }

    if (json.status !== 'OK' || !json.result?.length) break;
    allSubs = allSubs.concat(json.result);
    if (json.result.length < SUB_PAGE_SIZE) break;   // last page
    from += SUB_PAGE_SIZE;
    if (allSubs.length >= MAX_SUBS) break;            // safety cap
  }

  writeCache(cacheKey, allSubs);
  return allSubs;
}

async function fetchUserInfo(handles) {
  const mapping = {};
  const CHUNK   = 10;
  const jobs    = [];
  for (let i = 0; i < handles.length; i += CHUNK) {
    const chunk  = handles.slice(i, i + CHUNK);
    const cKey   = `info_${chunk.map(h => h.toLowerCase()).sort().join(',')}`;
    const cached = getCached(cKey);
    if (cached) {
      cached.forEach(u => { mapping[u.handle.toLowerCase()] = { rating: u.rating || null, display: u.handle }; });
      continue;
    }
    jobs.push(
      fetch(`https://codeforces.com/api/user.info?handles=${chunk.map(encodeURIComponent).join(';')}`)
        .then(r => r.json())
        .then(json => {
          if (json.status === 'OK') {
            writeCache(cKey, json.result);
            json.result.forEach(u => {
              mapping[u.handle.toLowerCase()] = { rating: u.rating || null, display: u.handle };
            });
          }
        })
        .catch(e => console.warn('[CF] user.info:', e.message))
    );
  }
  await Promise.all(jobs);
  return mapping;
}

// ── Processing ────────────────────────────────────────────

/**
 * Dedup submissions per problem using BEST verdict logic:
 *  - If any submission for a problem has verdict OK → keep the earliest OK
 *    (so its timestamp correctly marks when the problem was first solved)
 *  - Otherwise keep the latest (most recent failed attempt)
 */
function deduplicateSubs(submissions, handle) {
  const map = {};
  for (const sub of submissions) {
    if (!sub.problem?.contestId || !sub.problem?.index) continue;
    const k = `${sub.problem.contestId}-${sub.problem.index}`;
    if (!map[k]) {
      map[k] = sub;
    } else {
      const prevOK = map[k].verdict === 'OK';
      const curOK  = sub.verdict    === 'OK';
      if (!prevOK && curOK) {
        map[k] = sub;                      // upgrade to first AC
      } else if (prevOK && curOK) {
        // Both AC — keep the EARLIEST (timestamp when problem was solved)
        if (sub.creationTimeSeconds < map[k].creationTimeSeconds) map[k] = sub;
      } else if (!prevOK && !curOK) {
        // Both non-AC — keep the latest
        if (sub.creationTimeSeconds > map[k].creationTimeSeconds) map[k] = sub;
      }
      // prevOK && !curOK → ignore non-AC
    }
  }
  return Object.values(map).map(s => ({ ...s, handle }));
}

/**
 * Compute stats for a period.
 * rawSubs    — all submissions (for total submission count)
 * uniqueSubs — deduplicated per-problem best-verdict list (for solved count)
 */
function computeStats(rawSubs, periodSec, uniqueSubs) {
  const cutoff         = Math.floor(Date.now() / 1000) - periodSec;
  const rawInPeriod    = rawSubs.filter(s => s.creationTimeSeconds >= cutoff);
  const uniqueInPeriod = uniqueSubs.filter(s => s.creationTimeSeconds >= cutoff);

  let totalSolved = 0, ratingSum = 0, ratedCount = 0;
  for (const s of uniqueInPeriod) {
    if (s.verdict === 'OK') {
      totalSolved++;
      if (s.problem.rating) { ratingSum += s.problem.rating; ratedCount++; }
    }
  }
  const avgRating = ratedCount > 0 ? +(ratingSum / ratedCount).toFixed(1) : 0;
  const score     = +(totalSolved * avgRating).toFixed(0);
  return { totalSubmissions: rawInPeriod.length, totalSolved, avgRating, score, ratedCount };
}

// ── Progress helpers ──────────────────────────────────────
function setProgress(done, total) {
  const bar  = document.getElementById('progressBar');
  const text = document.getElementById('progressText');
  const pct  = total > 0 ? Math.round((done / total) * 100) : 0;
  if (bar)  { bar.style.width = pct + '%'; bar.textContent = pct + '%'; }
  if (text) text.textContent = `${done} / ${total} users fetched`;
}

// ── Worker pool ───────────────────────────────────────────
async function processAllHandles(handles) {
  const userStats = {};
  let   combined  = [];
  let   idx       = 0;
  let   done      = 0;
  setProgress(0, handles.length);

  async function worker() {
    while (idx < handles.length) {
      const i      = idx++;
      const handle = handles[i];
      setLoadingMsg(`Fetching submissions for "${handle}"…`);
      const raw    = await fetchAllUserSubmissions(handle);
      const unique = deduplicateSubs(raw, handle);
      combined     = combined.concat(unique);
      userStats[handle.toLowerCase()] = {
        period10: computeStats(raw, PERIOD_10_SEC, unique),
        period60: computeStats(raw, PERIOD_60_SEC, unique),
        rawCount: raw.length,
      };
      done++;
      setProgress(done, handles.length);
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
  ['rankingSection', 'submissionSection'].forEach(hide);
  setStatus('');
  setProgress(0, handles.length);

  try {
    setLoadingMsg('Fetching user profiles…');
    userRatingMap = await fetchUserInfo(handles);

    const { userStats, combined } = await processAllHandles(handles);
    lastUserStats  = userStats;

    allSubmissions = combined.sort((a, b) => b.creationTimeSeconds - a.creationTimeSeconds);
    currentPage    = 1;

    setLoadingMsg('Rendering…');
    // Top stat cards removed per user request — keep summary hidden
    displayRanking(userStats);
    renderAllCharts(userStats);
    renderSubmissions();

    const ts       = new Date().toLocaleTimeString();
    const totalRaw = Object.values(userStats).reduce((s, v) => s + v.rawCount, 0);
    setStatus(
      `Loaded at ${ts}  ·  ${handles.length} user(s)  ·  ${totalRaw.toLocaleString()} total API submissions fetched  ·  ${allSubmissions.length.toLocaleString()} unique problems tracked`
    );
    ['rankingSection', 'submissionSection'].forEach(show);
  } catch (e) {
    console.error(e);
    alert('An error occurred: ' + e.message);
  } finally {
    showLoading(false);
  }
}

// ── Stat Cards ────────────────────────────────────────────
function renderStatCards(userStats) {
  const container = document.getElementById('statCardsContainer');
  if (!container) return;

  const entries     = Object.entries(userStats);
  const totalUnique = allSubmissions.filter(s => s.verdict === 'OK').length;

  let top60Handle = '', top60Val = -1;
  let active10Handle = '', active10Val = -1;
  let score60Handle  = '', score60Val  = -1;
  let totalRaw       = 0;

  for (const [handle, stats] of entries) {
    const ui = userRatingMap[handle] || { display: handle };
    totalRaw += stats.rawCount;
    if (stats.period60.avgRating   > top60Val)    { top60Val    = stats.period60.avgRating;   top60Handle    = ui.display; }
    if (stats.period10.totalSolved > active10Val) { active10Val = stats.period10.totalSolved; active10Handle = ui.display; }
    if (stats.period60.score       > score60Val)  { score60Val  = stats.period60.score;       score60Handle  = ui.display; }
  }

  const card = (icon, label, value, sub = '') => `
    <div class="stat-card">
      <div class="stat-icon">${icon}</div>
      <div class="stat-body">
        <div class="stat-val">${value}</div>
        <div class="stat-label">${label}</div>
        ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}
      </div>
    </div>`;

  container.innerHTML =
    card('', 'Best Avg Rating (60d)',   esc(top60Handle    || '—'), top60Val    > 0 ? `Avg rating ${top60Val}`      : '') +
    card('', 'Most Active (10d)',        esc(active10Handle || '—'), active10Val > 0 ? `${active10Val} problems solved` : '') +
    card('', 'Top Score (60d)',           esc(score60Handle  || '—'), score60Val  > 0 ? `Score ${score60Val}`         : '') +
    card('', 'Total Submissions Fetched', totalRaw.toLocaleString(),   `across ${entries.length} user(s)`)          +
    card('', 'Unique Problems Tracked',   totalUnique.toLocaleString(), 'deduplicated, all users');
}

// ── Ranking Table — sorted by Avg Rating 60d desc ─────────
function displayRanking(userStats) {
  const rows = Object.entries(userStats).map(([handle, stats]) => ({
    handle, s10: stats.period10, s60: stats.period60,
  }));

  // PRIMARY: score60 desc  →  SECONDARY: avgRating60 desc  →  TERTIARY: totalSolved60 desc
  rows.sort((a, b) =>
    b.s60.score       - a.s60.score       ||
    b.s60.avgRating   - a.s60.avgRating   ||
    b.s60.totalSolved - a.s60.totalSolved
  );

  const tbody = document.getElementById('rankingTableBody');
  if (!tbody) return;
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="10">No data found.</td></tr>'; return; }

  const medals = ['1st', '2nd', '3rd'];
  const frag   = document.createDocumentFragment();

  rows.forEach(({ handle, s10, s60 }, i) => {
    const ui    = userRatingMap[handle] || { rating: null, display: handle };
    const color = ratingColor(ui.rating);
    const tr    = document.createElement('tr');
    const selfHandle = getActiveHandles()[0]?.toLowerCase() || '';
  if (i < 3) tr.className = `rank-${i + 1}`;
  if (handle.toLowerCase() === selfHandle) tr.classList.add('self-row');

    tr.innerHTML = `
      <td class="num-col">${medals[i] || i + 1}</td>
      <td>
        <a href="https://codeforces.com/profile/${esc(ui.display)}"
           target="_blank" style="color:${color};font-weight:700">${esc(ui.display)}</a>
        ${ui.rating ? `<br><span style="color:${color};font-size:0.72rem">◉ ${ui.rating}</span>` : ''}
      </td>
      <td>${s10.totalSolved}</td>
      <td style="color:${ratingColor(s10.avgRating)}">${s10.avgRating || '—'}</td>
      <td>${s10.totalSubmissions}</td>
      <td>${s60.totalSolved}</td>
      <td style="color:${ratingColor(s60.avgRating)};font-weight:700">${s60.avgRating || '—'}</td>
      <td>${s60.totalSubmissions}</td>`;
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

// ── Charts ─────────────────────────────────────────────────
function renderAllCharts(userStats) {
  // Sort by avgRating60 desc (matches ranking table order)
  const sorted = Object.entries(userStats)
    .map(([handle, stats]) => ({ handle, s10: stats.period10, s60: stats.period60 }))
    .sort((a, b) =>
      b.s60.avgRating   - a.s60.avgRating   ||
      b.s60.score       - a.s60.score       ||
      b.s60.totalSolved - a.s60.totalSolved
    );

  const labels = sorted.map(d => (userRatingMap[d.handle] || { display: d.handle }).display);

  renderSolvedChart(sorted, labels);
  renderAvgRatingChart(sorted, labels);
  renderRatingHistoryChart(sorted);
  // Restore any collapsed chart boxes after re-render
  Object.entries(chartCollapseState).forEach(([boxId, collapsed]) => {
    if (!collapsed) return;
    const box  = document.getElementById(boxId);
    if (!box) return;
    const body = box.querySelector('.chart-body');
    const btn  = box.querySelector('.chart-toggle-btn');
    if (body) body.style.display = 'none';
    if (btn)  btn.textContent = 'Show';
  });
}

/* Chart 1 — Problems Solved (bars) + Score 60d (line) */
function renderSolvedChart(sorted, labels) {
  const canvas = document.getElementById('chart1');
  if (!canvas || typeof Chart === 'undefined') return;

  destroyChart('chart1');
  charts['chart1'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Solved — 10 days',
          data: sorted.map(d => d.s10.totalSolved),
          backgroundColor: 'rgba(33,150,243,0.8)',
          borderColor: '#2196f3',
          borderWidth: 1,
          yAxisID: 'ySolved',
          order: 2,
        },
        {
          label: 'Solved — 60 days',
          data: sorted.map(d => d.s60.totalSolved),
          backgroundColor: 'rgba(76,175,80,0.7)',
          borderColor: '#4caf50',
          borderWidth: 1,
          yAxisID: 'ySolved',
          order: 2,
        },
        {
          label: 'Score (Solved × Avg Rating) — 60d',
          data: sorted.map(d => d.s60.score),
          type: 'line',
          borderColor: '#ff9800',
          backgroundColor: 'rgba(255,152,0,0.1)',
          pointBackgroundColor: '#ff9800',
          pointRadius: 5,
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          yAxisID: 'yScore',
          order: 1,
        },
      ],
    },
    options: twoAxisOptions(
      'Problems Solved & Score (sorted by Avg Rating 60d)',
      'ySolved', 'Problems Solved', '#2196f3', '#90caf9',
      'yScore',  'Score (60d)',     '#ff9800', '#ff9800'
    ),
  });
}

/* Chart 2 — Avg Rating comparison, per-user colors */
function renderAvgRatingChart(sorted, labels) {
  const canvas = document.getElementById('chart2');
  if (!canvas || typeof Chart === 'undefined') return;

  const tc   = themeVars();
  const avg10 = sorted.map(d => d.s10.avgRating);
  const avg60 = sorted.map(d => d.s60.avgRating);
  // Distinct palette for first 10 users (visually different colors)
  const palette = ['#1f77b4','#ff7f0e','#9467bd','#2ca02c','#d62728','#8c564b','#e377c2','#7f7f7f','#bcbd22','#17becf'];
  const colorFor = (i, r) => i < palette.length ? palette[i] : ratingColor(r);

  destroyChart('chart2');
  charts['chart2'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Avg Problem Rating — 10 days',
          data: avg10,
          backgroundColor: avg10.map((r, i) => (colorFor(i, r) || '#999') + 'cc'),
          borderColor:      avg10.map((r, i) => (colorFor(i, r) || '#666')),
          borderWidth: 1.5,
        },
        {
          label: 'Avg Problem Rating — 60 days',
          data: avg60,
          backgroundColor: avg60.map((r, i) => (colorFor(i, r) || '#999') + 'dd'),
          borderColor:      avg60.map((r, i) => (colorFor(i, r) || '#666')),
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title:   { display: true, text: 'Average Problem Rating Solved (sorted by Avg Rating 60d)', color: tc.title, font: { size: 14 } },
        legend:  { labels: { color: tc.text, font: { size: 12 } } },
        tooltip: tc.tooltip,
      },
      scales: {
        x: { ticks: { color: tc.text, maxRotation: 45, font: { size: 12 } }, grid: { color: tc.grid } },
        y: {
          beginAtZero: false, min: 800,
          ticks: { color: tc.text, font: { size: 12 } },
          grid:  { color: tc.grid },
          title: { display: true, text: 'Avg Problem Rating', color: tc.sub, font: { size: 12 } },
        },
      },
    },
  });
}

/* Chart 3 — Skill curve: problems solved per rating tier (last 60d) */
// ── Chart 3 — Rating history per user (full timeline)
let curvesHidden = false; // master visibility flag for chart3

async function fetchUserRatingHistory(handle) {
  const key = `rating_${handle.toLowerCase()}`;
  const cached = getCached(key);
  if (cached) return cached;
  try {
    const resp = await fetch(`https://codeforces.com/api/user.rating?handle=${encodeURIComponent(handle)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.status !== 'OK' || !Array.isArray(json.result)) return [];
    const events = json.result.map(ev => ({ t: ev.ratingUpdateTimeSeconds * 1000, r: ev.newRating })).sort((a,b)=>a.t-b.t);
    writeCache(key, events);
    return events;
  } catch (e) {
    console.warn('[CF] rating history for', handle, e.message || e);
    return [];
  }
}

async function renderRatingHistoryChart(sorted) {
  const canvas = document.getElementById('chart3');
  if (!canvas || typeof Chart === 'undefined') return;
  const tc = themeVars();

  // Fetch rating events for each handle in parallel
  const histPromises = sorted.map(u => fetchUserRatingHistory(u.handle));
  const allHist = await Promise.all(histPromises);

  // Build set of all date keys (YYYY-MM-DD) across users
  const dateSet = new Set();
  const userMaps = allHist.map(arr => {
    const m = [];
    for (const ev of arr) {
      const ds = new Date(ev.t).toISOString().slice(0,10);
      m.push({ d: ds, t: ev.t, r: ev.r });
      dateSet.add(ds);
    }
    return m.sort((a,b)=>a.t-b.t);
  });

  const labels = Array.from(dateSet).sort();
  if (!labels.length) return; // nothing to show

  const palette = ['#2196f3','#4caf50','#e91e63','#ff9800','#9c27b0','#00bcd4','#ff5722','#8bc34a','#ffc107','#3f51b5','#009688','#f44336','#795548','#607d8b'];

  const selfHandle = getActiveHandles()[0]?.toLowerCase() || '';
  const datasets = userMaps.map((events, i) => {
    // fill-forward values across all labels
    const vals = [];
    let ei = 0, last = null;
    for (const lbl of labels) {
      while (ei < events.length && events[ei].d <= lbl) { last = events[ei].r; ei++; }
      vals.push(last === null ? null : last);
    }
    const ui     = userRatingMap[sorted[i].handle] || { display: sorted[i].handle };
    const color  = palette[i % palette.length];
    const isSelf = sorted[i].handle.toLowerCase() === selfHandle;
    return {
      label:           ui.display,
      data:            vals,
      borderColor:     color,
      backgroundColor: color + '22',
      borderWidth:     isSelf ? 3.5 : 2,
      pointRadius:     isSelf ? 4   : 2,
      borderDash:      [],
      tension:         0.15,
      spanGaps:        false,
      hidden:          curvesHidden,
      order:           isSelf ? 0 : 1,   // draw self on top
    };
  });

  destroyChart('chart3');
  charts['chart3'] = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: { display: true, text: 'Codeforces Rating History — full timeline', color: tc.title, font: { size: 14 }, padding: { bottom: 10 } },
        legend: { labels: { color: tc.text, font: { size: 12 } } },
        tooltip: tc.tooltip,
      },
      scales: {
        x: { ticks: { color: tc.text, maxRotation: 45, font: { size: 11 } }, grid: { color: tc.grid }, title: { display: true, text: 'Date', color: tc.sub, font: { size: 12 } } },
        y: { ticks: { color: tc.text, font: { size: 12 } }, grid: { color: tc.grid }, title: { display: true, text: 'Rating', color: tc.sub, font: { size: 12 } } },
      },
    },
  });
}

// ── Chart utility helpers ─────────────────────────────────
function themeVars() {
  const light = document.body.classList.contains('light-mode');
  return {
    text:    light ? '#444'    : '#ccc',
    title:   light ? '#111'    : '#e0e0e0',
    sub:     light ? '#1565c0' : '#90caf9',
    grid:    light ? '#e0e0e0' : '#2a2a2a',
    tooltip: light
      ? { backgroundColor: '#fff',    titleColor: '#333', bodyColor: '#555', borderColor: '#ccc', borderWidth: 1 }
      : { backgroundColor: '#1e1e1e', titleColor: '#eee', bodyColor: '#ccc', borderColor: '#444', borderWidth: 1 },
  };
}

function twoAxisOptions(title, id1, label1, tick1, title1, id2, label2, tick2, title2) {
  const tc = themeVars();
  return {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      title:   { display: true, text: title, color: tc.title, font: { size: 14 }, padding: { bottom: 12 } },
      legend:  { labels: { color: tc.text, font: { size: 12 } } },
      tooltip: tc.tooltip,
    },
    scales: {
      x: { ticks: { color: tc.text, maxRotation: 45, font: { size: 12 } }, grid: { color: tc.grid } },
      [id1]: { type: 'linear', position: 'left',  beginAtZero: true, ticks: { color: tick1, precision: 0, font: { size: 12 } }, grid: { color: tc.grid }, title: { display: true, text: label1, color: title1, font: { size: 12 } } },
      [id2]: { type: 'linear', position: 'right', beginAtZero: true, ticks: { color: tick2, font: { size: 12 } }, grid: { drawOnChartArea: false }, title: { display: true, text: label2, color: title2, font: { size: 12 } } },
    },
  };
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

// ── Submission Pagination ─────────────────────────────────
function renderSubmissions() {
  const tbody = document.getElementById('solvedTableBody');
  if (!tbody) return;

  const start    = (currentPage - 1) * PAGE_SIZE;
  const pageData = allSubmissions.slice(start, start + PAGE_SIZE);
  const frag     = document.createDocumentFragment();

  pageData.forEach((sub, i) => {
    const ui     = userRatingMap[sub.handle?.toLowerCase()] || { rating: null, display: sub.handle };
    const uColor = ratingColor(ui.rating);
    const pColor = ratingColor(sub.problem.rating);
    const vText  = verdictText(sub);
    const vColor = vText === 'Accepted' ? '#66bb6a' : '#ef5350';
    const tags   = sub.problem.tags?.join(', ') || '—';
    const time   = new Date(sub.creationTimeSeconds * 1000).toLocaleString();
    const tr     = document.createElement('tr');
    const selfHandle = getActiveHandles()[0]?.toLowerCase() || '';
    if (sub.handle?.toLowerCase() === selfHandle) tr.classList.add('self-row');
    tr.innerHTML = `
      <td class="num-col">${start + i + 1}</td>
      <td><a href="https://codeforces.com/profile/${esc(ui.display)}"
             target="_blank" style="color:${uColor};font-weight:600">${esc(ui.display)}</a></td>
      <td><a href="https://codeforces.com/contest/${sub.problem.contestId}/problem/${esc(String(sub.problem.index))}"
             target="_blank" style="color:${pColor}">
             ${sub.problem.contestId}-${esc(String(sub.problem.index))}: ${esc(sub.problem.name)}</a></td>
      <td><a href="https://codeforces.com/contest/${sub.problem.contestId}/submission/${sub.id}"
             target="_blank" style="color:${vColor}">${vText}</a></td>
      <td style="color:${pColor}">${sub.problem.rating || '—'}</td>
      <td class="tags-cell">${esc(tags)}</td>
      <td class="time-cell">${time}</td>`;
    frag.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(frag);
  renderPagination();
}

function renderPagination() {
  const total = allSubmissions.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  const html  = pages <= 1 ? '' : buildPaginationHTML(pages, total);
  ['paginationTop', 'paginationBottom'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

function buildPaginationHTML(pages, total) {
  const p   = currentPage;
  const btn = (label, page, active = false, disabled = false) =>
    `<button onclick="goToPage(${page})" class="${active ? 'pg-active' : ''}" ${disabled ? 'disabled' : ''}>${label}</button>`;

  let html = `<span class="page-info">Page ${p}/${pages} · ${total.toLocaleString()} submissions</span>`;
  html += btn('«', 1, false, p === 1) + btn('‹', p - 1, false, p === 1);
  const lo = Math.max(1, p - 2), hi = Math.min(pages, p + 2);
  if (lo > 1)     html += `<span style="color:#666;padding:0 4px">…</span>`;
  for (let i = lo; i <= hi; i++) html += btn(i, i, i === p);
  if (hi < pages) html += `<span style="color:#666;padding:0 4px">…</span>`;
  return html + btn('›', p + 1, false, p === pages) + btn('»', pages, false, p === pages);
}

function goToPage(page) {
  const pages = Math.ceil(allSubmissions.length / PAGE_SIZE);
  if (page < 1 || page > pages || page === currentPage) return;
  currentPage = page;
  renderSubmissions();
  document.getElementById('submissionSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Rating Colour (matches CF tier boundaries exactly) ────
function ratingColor(r) {
  r = parseFloat(r);
  if (!r || r <= 0) return '#9e9e9e';
  if (r < 1200)    return '#9e9e9e';   // Newbie
  if (r < 1400)    return '#30c030';   // Pupil
  if (r < 1600)    return '#00aaaa';   // Specialist
  if (r < 1900)    return '#427bf5';   // Expert
  if (r < 2100)    return '#aa00aa';   // Candidate Master
  if (r < 2400)    return '#ff8c00';   // Master
  if (r < 3000)    return '#ff3333';   // Grandmaster / IGM
  return '#aa0000';                    // Legendary Grandmaster
}

// ── Verdict Text ──────────────────────────────────────────
function verdictText(sub) {
  const v = sub.verdict;
  if (v === 'OK')                      return 'Accepted';
  if (v === 'WRONG_ANSWER')            return `WA on test ${(sub.passedTestCount ?? 0) + 1}`;
  if (v === 'TIME_LIMIT_EXCEEDED')     return 'TLE';
  if (v === 'MEMORY_LIMIT_EXCEEDED')   return 'MLE';
  if (v === 'COMPILATION_ERROR')       return 'CE';
  if (v === 'RUNTIME_ERROR')           return 'RTE';
  if (v === 'IDLENESS_LIMIT_EXCEEDED') return 'ILE';
  if (v === 'CHALLENGED')              return 'Hacked';
  return v || 'Unknown';
}

// ── Utility ───────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function show(id)  { const el = document.getElementById(id); if (el) el.style.display = ''; }
function hide(id)  { const el = document.getElementById(id); if (el) el.style.display = 'none'; }

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

// ── Theme ──────────────────────────────────────────────────
function applyTheme() {
  const saved = localStorage.getItem('cf_theme') || 'dark';
  document.body.classList.toggle('light-mode', saved === 'light');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = saved === 'light' ? 'Dark Mode' : 'Light Mode';
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('cf_theme', isLight ? 'light' : 'dark');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = isLight ? 'Dark Mode' : 'Light Mode';
  if (Object.keys(lastUserStats).length) renderAllCharts(lastUserStats);
}

// ── Chart Panel Toggle ─────────────────────────────────────
function toggleChart(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const body = box.querySelector('.chart-body');
  const btn  = box.querySelector('.chart-toggle-btn');
  chartCollapseState[boxId] = !chartCollapseState[boxId];
  if (body) body.style.display = chartCollapseState[boxId] ? 'none' : '';
  if (btn)  btn.textContent = chartCollapseState[boxId] ? 'Show' : 'Hide';
}

function toggleAllCurves() {
  const btn = document.getElementById('curveToggleBtn');
  curvesHidden = !curvesHidden;
  if (!charts['chart3']) {
    if (btn) btn.textContent = curvesHidden ? 'Show Curves' : 'Hide Curves';
    return;
  }
  charts['chart3'].data.datasets.forEach(ds => ds.hidden = curvesHidden);
  charts['chart3'].update();
  if (btn) btn.textContent = curvesHidden ? 'Show Curves' : 'Hide Curves';
}

// Toggle the whole Performance Overview (charts grid) visibility
function togglePerformance() {
  const grid = document.querySelector('#chartSection .charts-grid');
  const h2   = document.querySelector('#chartSection .section-toggle');
  if (!grid) return;
  const isHidden = grid.style.display === 'none';
  grid.style.display = isHidden ? '' : 'none';
  if (h2) h2.classList.toggle('open', isHidden);
}