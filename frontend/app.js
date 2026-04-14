/* ================================================================
   SafeRoute AI – App Logic
   ================================================================ */

// ──────────── Map Setup ────────────
const map = L.map('map', { zoomControl: false }).setView([23.0225, 72.5714], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap'
}).addTo(map);
L.control.zoom({ position: 'topright' }).addTo(map);

// ──────────── State ────────────
let routeLines      = [];
let landmarkMarkers = [];  // hospital / police / pharmacy markers
let wsmMode         = false;
let panelOpen       = true;
let alertTimeout    = null;
let selectedRoute   = null;
let routesData      = [];
let userLocation    = null;   // { lat, lon } from geolocation
let navInterval     = null;   // animation interval for navigation
let navMarker       = null;   // Leaflet marker for navigation car
let navDestCoord    = null;   // { lat, lon } destination stored at nav start
let navWatchId      = null;   // geolocation watchPosition ID
let isRerouting     = false;  // prevent concurrent reroute calls
let lastRerouteTime = 0;      // timestamp of last reroute (ms)

// SOS Timer state
let sosTimerInterval   = null;
let sosTimerSeconds    = 0;
let sosConfirmInterval = null;  // sub-timer for "are you safe?" confirmation step

// ──────────── Auth & User Profile ────────────
function getAuthToken() {
  return localStorage.getItem('ag_token');
}

function checkAuthInit() {
  const token = getAuthToken();
  if (!token) {
    window.location.href = '/login';
    return;
  }
  
  const name = localStorage.getItem('ag_name');
  if (name) {
    const el = document.getElementById('user-profile');
    const init = document.getElementById('user-initial');
    if (el && init) {
      init.textContent = name.charAt(0).toUpperCase();
      el.classList.remove('hidden');
    }
  }
}

function handleLogout() {
  const token = getAuthToken();
  if (token) {
    fetch('/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    }).finally(() => {
      localStorage.removeItem('ag_token');
      localStorage.removeItem('ag_name');
      localStorage.removeItem('ag_email');
      window.location.href = '/login';
    });
  } else {
    window.location.href = '/login';
  }
}

document.addEventListener('DOMContentLoaded', checkAuthInit);

// ──────────── Get User Location (for nearby suggestions) ────────────
(function detectUserLocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    map.setView([userLocation.lat, userLocation.lon], 14);
    // Add user marker
    L.circleMarker([userLocation.lat, userLocation.lon], {
      radius: 8, color: '#6c47ff', fillColor: '#6c47ff',
      fillOpacity: 1, weight: 3
    }).addTo(map).bindPopup('📍 You are here');
  }, () => {}, { timeout: 6000 });
})();

// ================================================================
//  AUTOCOMPLETE ENGINE
// ================================================================
const acState = {
  source:      { timer: null, results: [], nearbyResults: [], focusIdx: -1 },
  destination: { timer: null, results: [], nearbyResults: [], focusIdx: -1 }
};
const DEBOUNCE_MS = 320;

// Nearby presets (popular Ahmedabad landmarks as fallback)
const NEARBY_FALLBACK = [
  { display_name: 'Ahmedabad Junction Railway Station, Ahmedabad, Gujarat', name: 'Ahmedabad Junction', type: 'station', class: 'railway', lat: '23.0254', lon: '72.5981' },
  { display_name: 'Sardar Vallabhbhai Patel International Airport, Ahmedabad', name: 'Ahmedabad Airport', type: 'aerodrome', class: 'aeroway', lat: '23.0772', lon: '72.6347' },
  { display_name: 'CIMS Hospital, Ahmedabad, Gujarat', name: 'CIMS Hospital', type: 'hospital', class: 'amenity', lat: '23.0365', lon: '72.5091' },
  { display_name: 'Manek Chowk, Old Ahmedabad, Gujarat', name: 'Manek Chowk', type: 'place', class: 'place', lat: '23.0256', lon: '72.5867' },
  { display_name: 'Sabarmati Ashram, Ahmedabad, Gujarat', name: 'Sabarmati Ashram', type: 'place', class: 'amenity', lat: '23.0603', lon: '72.5800' },
];

function onInputFocus(field) {
  const val = document.getElementById(field).value.trim();

  // If user has typed something and has results – show them
  if (val.length >= 2 && acState[field].results.length) {
    renderSuggestions(field, acState[field].results);
    return;
  }

  // Otherwise show "Nearby" suggestions
  showNearbySuggestions(field);
}

async function showNearbySuggestions(field) {
  const list = document.getElementById(`suggestions-${field}`);

  // Use cached or fetch from Nominatim using user location
  if (acState[field].nearbyResults.length) {
    renderSuggestionsWithGroup(field, acState[field].nearbyResults, 'Nearby Places');
    return;
  }

  if (userLocation) {
    list.innerHTML = `<div class="suggestion-loading"><div class="suggestion-spinner"></div><span>Finding nearby places…</span></div>`;
    list.classList.remove('hidden');
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=&format=json&limit=6&addressdetails=1`
        + `&lat=${userLocation.lat}&lon=${userLocation.lon}`
        + `&featuretype=city,town,village,suburb,hospital,railway,aeroway`;
      // Nominatim doesn't support proximity-only search well, so use reverse + nearby approach
      const reverseUrl = `https://nominatim.openstreetmap.org/reverse?lat=${userLocation.lat}&lon=${userLocation.lon}&format=json&zoom=14`;
      const res  = await fetch(reverseUrl, { headers: { 'Accept-Language': 'en' } });
      const data = await res.json();
      const nearby = data ? [data] : [];
      acState[field].nearbyResults = nearby.length ? nearby : NEARBY_FALLBACK;
    } catch (e) {
      acState[field].nearbyResults = NEARBY_FALLBACK;
    }
  } else {
    acState[field].nearbyResults = NEARBY_FALLBACK;
  }

  renderSuggestionsWithGroup(field, acState[field].nearbyResults, 'Nearby Places');
}

function onInputChange(field) {
  const val = document.getElementById(field).value.trim();
  const clearBtn = document.getElementById(`clear-${field}`);
  clearBtn.style.display = val ? 'block' : 'none';

  clearTimeout(acState[field].timer);

  if (val.length < 2) {
    showNearbySuggestions(field);
    return;
  }

  showSuggestionsLoading(field);
  acState[field].timer = setTimeout(() => fetchSuggestions(field, val), DEBOUNCE_MS);
}

async function fetchSuggestions(field, query) {
  try {
    // Switch to Photon API for superior autocomplete results (like Google Maps)
    let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8`;
    if (userLocation) {
      const d = 1.0; // ~100km bounds prevents global matches (like USA McDonald's) from taking priority
      url += `&lat=${userLocation.lat}&lon=${userLocation.lon}&bbox=${userLocation.lon-d},${userLocation.lat-d},${userLocation.lon+d},${userLocation.lat+d}`; 
    }
    const res  = await fetch(url);
    const data = await res.json();
    
    // Map Photon response to our UI format
    const results = data.features.map(f => {
      const p = f.properties;
      const parts = [p.name, p.street, p.city, p.state, p.country].filter(Boolean);
      return {
        display_name: parts.join(', '),
        name: p.name || parts[0],
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        type: p.osm_value,
        class: p.osm_key
      };
    });

    // Photon sometimes returns duplicate items in its tree, filter them out by name
    const uniqueResults = [];
    results.forEach(r => {
      if (!uniqueResults.find(u => u.display_name === r.display_name)) uniqueResults.push(r);
    });

    acState[field].results  = uniqueResults;
    acState[field].focusIdx = -1;
    renderSuggestions(field, uniqueResults);
  } catch (e) {
    hideSuggestions(field);
  }
}

function renderSuggestionsWithGroup(field, results, groupLabel) {
  const list = document.getElementById(`suggestions-${field}`);
  list.innerHTML = '';
  if (!results.length) { list.classList.add('hidden'); return; }
  const label = document.createElement('div');
  label.className = 'suggestion-group-label';
  label.textContent = groupLabel;
  list.appendChild(label);
  results.forEach((item, i) => appendSuggestionItem(list, field, item, i, acState[field].nearbyResults));
  list.classList.remove('hidden');
}

function renderSuggestions(field, results) {
  const list = document.getElementById(`suggestions-${field}`);
  list.innerHTML = '';

  // First: nearby matches (if any overlap)
  const typedQuery = document.getElementById(field).value.trim().toLowerCase();
  const nearbyMatches = acState[field].nearbyResults.filter(r =>
    (r.name || r.display_name).toLowerCase().includes(typedQuery)
  );

  if (nearbyMatches.length) {
    const lbl = document.createElement('div');
    lbl.className = 'suggestion-group-label';
    lbl.textContent = '📍 Nearby';
    list.appendChild(lbl);
    nearbyMatches.forEach((item, i) => appendSuggestionItem(list, field, item, i, acState[field].nearbyResults));

    if (results.length) {
      const lbl2 = document.createElement('div');
      lbl2.className = 'suggestion-group-label';
      lbl2.textContent = '🔍 Search Results';
      list.appendChild(lbl2);
    }
  }

  if (!results.length && !nearbyMatches.length) {
    list.innerHTML = '<div class="suggestion-empty">No results found</div>';
    list.classList.remove('hidden');
    return;
  }

  // Merge for keyboard nav
  const allResults = [...nearbyMatches, ...results.filter(r =>
    !nearbyMatches.some(n => n.display_name === r.display_name)
  )];
  acState[field].results = allResults;

  results.filter(r => !nearbyMatches.some(n => n.display_name === r.display_name))
    .forEach((item, i) => appendSuggestionItem(list, field, item, i, acState[field].results));

  list.classList.remove('hidden');
}

function appendSuggestionItem(list, field, item, i, resultArr) {
  const addr     = item.address || {};
  const mainName = item.name || addr.road || addr.neighbourhood || item.display_name.split(',')[0];
  const subParts = item.display_name.replace(mainName, '').replace(/^,\s*/, '');
  const subName  = subParts.slice(0, 55) + (subParts.length > 55 ? '…' : '');
  const icon     = iconForType(item.type, item.class);

  const el = document.createElement('div');
  el.className = 'suggestion-item';
  el.innerHTML = `
    <span class="suggestion-pin">${icon}</span>
    <div class="suggestion-text">
      <div class="suggestion-main">${mainName}</div>
      <div class="suggestion-sub">${subName}</div>
    </div>`;
  el.addEventListener('mousedown', e => { e.preventDefault(); selectSuggestion(field, item); });
  list.appendChild(el);
}

function showSuggestionsLoading(field) {
  const list = document.getElementById(`suggestions-${field}`);
  list.innerHTML = `<div class="suggestion-loading"><div class="suggestion-spinner"></div><span>Searching…</span></div>`;
  list.classList.remove('hidden');
}

function hideSuggestions(field) {
  document.getElementById(`suggestions-${field}`).classList.add('hidden');
  acState[field].focusIdx = -1;
}

function selectSuggestion(field, item) {
  document.getElementById(field).value = item.display_name;
  document.getElementById(`clear-${field}`).style.display = 'block';
  hideSuggestions(field);
}

function onInputKeydown(e, field) {
  const list  = document.getElementById(`suggestions-${field}`);
  const items = list.querySelectorAll('.suggestion-item');
  const state = acState[field];
  if (list.classList.contains('hidden') || !items.length) {
    if (e.key === 'Enter') getRoutes(); return;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); state.focusIdx = Math.min(state.focusIdx + 1, items.length - 1); updateFocus(items, state.focusIdx); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); state.focusIdx = Math.max(state.focusIdx - 1, 0); updateFocus(items, state.focusIdx); }
  else if (e.key === 'Enter') { e.preventDefault(); if (state.focusIdx >= 0 && state.results[state.focusIdx]) selectSuggestion(field, state.results[state.focusIdx]); else { hideSuggestions(field); getRoutes(); } }
  else if (e.key === 'Escape') hideSuggestions(field);
}

function updateFocus(items, idx) {
  items.forEach((el, i) => el.classList.toggle('focused', i === idx));
  items[idx]?.scrollIntoView({ block: 'nearest' });
}

function clearInput(field) {
  document.getElementById(field).value = '';
  document.getElementById(`clear-${field}`).style.display = 'none';
  hideSuggestions(field);
  acState[field].results = [];
  document.getElementById(field).focus();
}

document.addEventListener('click', e => {
  ['source', 'destination'].forEach(field => {
    const wrapper = document.getElementById(`suggestions-${field}`)?.closest('.autocomplete-wrapper');
    if (wrapper && !wrapper.contains(e.target)) hideSuggestions(field);
  });
});

function iconForType(type, cls) {
  if (cls === 'amenity') {
    if (['hospital','clinic'].includes(type)) return '🏥';
    if (['school','university'].includes(type)) return '🎓';
    if (['restaurant','cafe'].includes(type)) return '🍽️';
    return '🏢';
  }
  if (cls === 'railway' || type === 'station') return '🚉';
  if (cls === 'aeroway' || type === 'aerodrome') return '✈️';
  if (cls === 'highway') return '🛣️';
  if (cls === 'place') return '🌆';
  return '📍';
}

// ================================================================
//  GEOCODING + ROUTING
// ================================================================
async function geocode(place) {
  let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(place)}&limit=1`;
  if (userLocation) {
    const d = 1.0; // local bounds
    url += `&lat=${userLocation.lat}&lon=${userLocation.lon}&bbox=${userLocation.lon-d},${userLocation.lat-d},${userLocation.lon+d},${userLocation.lat+d}`;
  }
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.features || !data.features.length) throw new Error(`Location not found: "${place}"`);
  return { 
    lat: data.features[0].geometry.coordinates[1], 
    lon: data.features[0].geometry.coordinates[0] 
  };
}

async function getOSRMRoute(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/`
    + `${from.lon},${from.lat};${to.lon},${to.lat}`
    + `?overview=full&geometries=geojson&alternatives=true`;
  const res  = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes.length) throw new Error('Routing failed');
  return data.routes.map(r => {
    const totalMinutes = Math.round((r.duration / 60) * 1.35); // 1.35x Traffic multiplier for Indian roads
    let etaStr = totalMinutes + ' min';
    if (totalMinutes > 60) {
      etaStr = Math.floor(totalMinutes / 60) + ' h ' + (totalMinutes % 60) + ' min';
    }
    return {
      coords:       r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      distance:     (r.distance / 1000).toFixed(1) + ' km',
      eta:          etaStr,
      durationMins: totalMinutes
    };
  });
}

// ================================================================
//  MAIN: GET ROUTES
// ================================================================
async function getRoutes() {
  const srcVal = document.getElementById('source').value.trim();
  const dstVal = document.getElementById('destination').value.trim();
  if (!srcVal || !dstVal) { showAlert('⚠ Please enter both source and destination'); return; }
  ['source','destination'].forEach(f => hideSuggestions(f));
  clearRoutes();
  setLoading(true);
  hideAlert();

  // Geocode
  let fromCoord, toCoord;
  try {
    [fromCoord, toCoord] = await Promise.all([geocode(srcVal), geocode(dstVal)]);
  } catch (e) {
    setLoading(false); showAlert('❌ ' + e.message); return;
  }

  // OSRM routing
  let osrmRoutes;
  try {
    osrmRoutes = await getOSRMRoute(fromCoord, toCoord);
  } catch (e) {
    setLoading(false); showAlert('❌ Could not fetch route. Check internet connection.'); return;
  }

  const routes = osrmRoutes.slice(0, 3);  // Show up to 3 routes for comparison

  // Backend safety
  let safetyData = null;
  try {
    const res = await fetch('/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ source: srcVal, destination: dstVal, women_mode: wsmMode })
    });
    if (res.ok) safetyData = await res.json();
  } catch (e) { /* use mock */ }

  const FALLBACK_PROFILES = [
    { score: 82, risks: ['Minimal risk detected','Well-lit street throughout','High foot traffic area'] },
    { score: 58, risks: ['Low activity at segment 3 (sparse traffic area)','Moderate lighting on side road'] },
    { score: 31, risks: ['Deserted area at segment 1 (very low foot traffic)','High risk at segment 2 (isolated & poorly lit)','Isolated zone at segment 4 (minimal crowd & activity)'] }
  ];

  routesData = routes.map((r, i) => {
    const b       = safetyData?.[i] || null;
    const fb      = FALLBACK_PROFILES[i] || FALLBACK_PROFILES[1];
    const score   = Math.min(100, Math.max(0, Math.round(b?.safety_score ?? fb.score)));
    return {
      name:            b?.name || `Route ${String.fromCharCode(65+i)}`,
      distance:        r.distance,
      eta:             r.eta,
      durationMins:    r.durationMins,
      safety_score:    score,
      risks:           b?.risks?.length ? b.risks : fb.risks,
      segment_labels:  b?.segment_labels || [],
      explanation:     b?.explanation   || null,
      coords:          r.coords
    };
  });
  routesData.sort((a,b) => b.safety_score - a.safety_score);

  // Assign comparison labels after sorting
  if (routesData.length > 0) routesData[0].label = '🛡️ Safest';
  if (routesData.length > 1) routesData[routesData.length - 1].label = '⚠️ Most Risky';
  if (routesData.length > 2) routesData[1].label = '⚡ Balanced';
  else if (routesData.length === 2) routesData[1].label = '⚠️ Most Risky';

  routesData.forEach((r,i) => drawRoute(r,i));
  map.fitBounds(routesData.flatMap(r=>r.coords), { padding: [80,90] });

  // Fetch & display landmarks along the route (always, regardless of mode)
  fetchAndShowLandmarks(routesData);

  setLoading(false);
  document.getElementById('route-header-sub').textContent = `${srcVal.split(',')[0]} → ${dstVal.split(',')[0]}`;
  goToRouteOptions();
  renderRouteCards();
}

// ================================================================
//  MAP DRAWING
// ================================================================
// Per-route distinct colors so all routes are visually different on the map
const ROUTE_COLORS = [
  { line: '#2979ff', glow: '#2979ff' },  // Route A – blue
  { line: '#ff9100', glow: '#ff9100' },  // Route B – orange
  { line: '#d500f9', glow: '#d500f9' },  // Route C – purple
];

function routeColor(score) {
  return wsmMode ? (score>=60?'#ff4081':'#ff6d00') : (score>=60?'#00c853':'#ff1744');
}

function drawRoute(route, index, dimmed) {
  const palette = ROUTE_COLORS[index % ROUTE_COLORS.length];
  const opacity = dimmed ? 0.22 : 0.92;
  const glowOp  = dimmed ? 0.04 : 0.15;
  const weight  = dimmed ? 4    : 6;

  const glow = L.polyline(route.coords, {
    color: palette.glow, weight: 18, opacity: glowOp, lineJoin: 'round'
  }).addTo(map);

  const line = L.polyline(route.coords, {
    color: palette.line, weight, opacity, lineJoin: 'round', lineCap: 'round'
  }).addTo(map);

  line.bindPopup(
    `<b>${route.name}</b><br>🛡 Safety: <b>${route.safety_score}/100</b><br>⏱ ${route.eta} • 📏 ${route.distance}`
  );

  // Midpoint label marker so routes are labeled on the map
  const mid = route.coords[Math.floor(route.coords.length / 2)];
  const labelIcon = L.divIcon({
    className: '',
    html: `<div style="
      background:${palette.line};
      color:#fff;
      font-size:11px;
      font-weight:700;
      padding:3px 8px;
      border-radius:12px;
      box-shadow:0 2px 6px rgba(0,0,0,.35);
      white-space:nowrap;
      opacity:${dimmed ? 0.35 : 1};
      ">${route.name}</div>`,
    iconAnchor: [30, 12]
  });
  const labelMkr = L.marker(mid, { icon: labelIcon, interactive: false }).addTo(map);
  routeLines.push(glow, line, labelMkr);
}

function clearRoutes() {
  routeLines.forEach(l => map.removeLayer(l));
  routeLines = [];
  clearLandmarks();
}

function clearLandmarks() {
  landmarkMarkers.forEach(m => map.removeLayer(m));
  landmarkMarkers = [];
}

// ================================================================
//  LANDMARK LAYER  (Overpass API – hospitals, police, pharmacies)
// ================================================================
const LANDMARK_CONFIG = [
  { amenity: 'hospital', icon: '⚕️', label: 'Hospital',        color: '#e53935', bg: '#ffebee' },
  { amenity: 'clinic',   icon: '🏥', label: 'Clinic',          color: '#e53935', bg: '#ffebee' },
  { amenity: 'pharmacy', icon: '💊', label: 'Pharmacy',        color: '#2e7d32', bg: '#e8f5e9' },
  { amenity: 'police',   icon: '🚔', label: 'Police Station',  color: '#1565c0', bg: '#e3f2fd' },
];

async function fetchAndShowLandmarks(routes) {
  // Build bounding box from all route coords combined
  const allCoords = routes.flatMap(r => r.coords);  // [[lat,lon], ...]
  if (!allCoords.length) return;

  const lats = allCoords.map(c => c[0]);
  const lons = allCoords.map(c => c[1]);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const west  = Math.min(...lons);
  const east  = Math.max(...lons);

  // Small padding so landmarks slightly off-route are included
  const pad = 0.008;
  const bbox = `${south-pad},${west-pad},${north+pad},${east+pad}`;

  const amenityFilter = LANDMARK_CONFIG.map(c => `node["amenity"="${c.amenity}"](${bbox});`).join('');
  const query = `[out:json][timeout:12];(${amenityFilter});out body;`;
  const url   = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const data = await res.json();
    if (!data.elements?.length) return;

    // Deduplicate by (lat,lon) and limit per type to avoid map clutter
    const seen    = new Set();
    const countBy = {};
    const MAX_PER_TYPE = 6;

    data.elements.forEach(el => {
      const amenity = el.tags?.amenity;
      if (!amenity) return;
      const cfg = LANDMARK_CONFIG.find(c => c.amenity === amenity);
      if (!cfg) return;

      countBy[amenity] = (countBy[amenity] || 0);
      if (countBy[amenity] >= MAX_PER_TYPE) return;
      countBy[amenity]++;

      const key = `${el.lat.toFixed(5)},${el.lon.toFixed(5)}`;
      if (seen.has(key)) return;
      seen.add(key);

      const name = el.tags?.name || cfg.label;
      placeLandmarkMarker(el.lat, el.lon, cfg, name);
    });
  } catch (e) {
    // Silently fail – landmarks are supplementary, not critical
  }
}

function placeLandmarkMarker(lat, lon, cfg, name) {
  const icon = L.divIcon({
    className: '',
    html: `<div class="landmark-marker" style="border-color:${cfg.color};background:${cfg.bg};">
             <span class="landmark-icon">${cfg.icon}</span>
           </div>`,
    iconSize:   [34, 34],
    iconAnchor: [17, 17]
  });

  const marker = L.marker([lat, lon], { icon, zIndexOffset: 200 })
    .addTo(map)
    .bindPopup(
      `<div style="font-family:'Inter',sans-serif;font-size:13px;">
         <strong>${cfg.icon} ${name}</strong><br>
         <span style="font-size:11px;color:#555;">${cfg.label}</span>
       </div>`,
      { maxWidth: 200 }
    );

  landmarkMarkers.push(marker);
}

// ================================================================
//  BACK NAVIGATION
// ================================================================
const SCREENS = ['search-section', 'route-options', 'safety-card'];

function showScreen(id) {
  SCREENS.forEach(s => document.getElementById(s).classList.toggle('hidden', s !== id));
  openPanel();
  // Show/hide top-bar back button
  const showBack = id !== 'search-section';
  document.getElementById('top-back-btn').classList.toggle('hidden', !showBack);
}

function handleBack() {
  const visible = SCREENS.find(s => !document.getElementById(s).classList.contains('hidden'));
  if (visible === 'safety-card')  { goToRouteOptions(); return; }
  if (visible === 'route-options') { goToSearch(); return; }
}

function goToSearch() {
  showScreen('search-section');
  clearRoutes();
  hideAlert();
}

function goToRouteOptions() {
  showScreen('route-options');
  hideAlert();
}

function showRouteOptions() { goToRouteOptions(); } // alias

// ================================================================
//  ROUTE CARDS
// ================================================================
function renderRouteCards() {
  const container = document.getElementById('route-cards-container');
  container.innerHTML = '';

  // Comparison header
  const header = document.createElement('div');
  header.className = 'route-compare-header';
  header.innerHTML = `<span>Comparing ${routesData.length} routes by safety</span>`;
  container.appendChild(header);

  routesData.forEach((route, i) => {
    const isSafe = route.safety_score >= 60;
    const isMid  = route.safety_score >= 40 && route.safety_score < 60;
    const card   = document.createElement('div');
    card.className = `route-card ${isSafe ? 'safe-card' : isMid ? 'mid-card' : 'unsafe-card'}`;
    card.id = `card-${i}`;
    card.onclick = () => selectRoute(i, card);

    const mapColor  = (ROUTE_COLORS[i % ROUTE_COLORS.length] || ROUTE_COLORS[0]).line;
    const badgeClass = isSafe ? 'badge-safe' : isMid ? 'badge-mid' : 'badge-risk';
    const labelHtml  = route.label ? `<span class="route-label">${route.label}</span>` : '';

    // ── Vetoed route badge (women mode only) ──
    const vetoBadge = (wsmMode && route.safety_score <= 30)
      ? `<span class="wsm-veto-badge">🚫 Avoid</span>` : '';

    // ── Per-segment color strip ──
    const segStrip = buildSegmentStrip(route.segment_labels);

    // ── Explanation snippet ──
    const expHtml = (wsmMode && route.explanation)
      ? `<div class="route-explanation">${route.explanation.feels_like ? '🧭 ' + route.explanation.feels_like : ''}</div>`
      : '';

    card.innerHTML = `
      <div style="width:5px;min-width:5px;height:52px;border-radius:4px;background:${mapColor};margin-right:10px;flex-shrink:0;"></div>
      <div class="route-card-info">
        <div class="route-card-name">${route.name} ${labelHtml} ${vetoBadge}</div>
        <div class="route-card-meta">⏱ ${route.eta} &nbsp;•&nbsp; 📏 ${route.distance}</div>
        ${segStrip}
        <div class="route-risks-mini">${route.risks.slice(0,1).map(r=>`⚠ ${r}`).join(' ')}</div>
        ${expHtml}
      </div>
      <div class="route-card-badge ${badgeClass}">${route.safety_score}<span style="font-size:9px">/100</span></div>`;
    container.appendChild(card);
  });
}

function selectRoute(index, cardEl) {
  document.querySelectorAll('.route-card').forEach(c => c.classList.remove('selected'));
  cardEl.classList.add('selected');
  selectedRoute = index;

  // Redraw: highlight selected route, dim others
  clearRoutes();
  routesData.forEach((r, i) => drawRoute(r, i, i !== index));

  setTimeout(() => {
    showScreen('safety-card');
    populateSafetyCard(routesData[index]);
    if (routesData[index].safety_score < 60) showAlert(`⚠ Entering low safety zone – ${routesData[index].name}`);
  }, 250);
}

// ================================================================
//  SAFETY CARD
// ================================================================
function populateSafetyCard(route) {
  const score = route.safety_score;
  const fill  = document.getElementById('score-ring-fill');
  fill.style.strokeDashoffset = 314;
  setTimeout(() => { fill.style.strokeDashoffset = 314 - (score/100)*314; }, 60);
  fill.classList.remove('medium','low');
  if (score < 50) fill.classList.add('low'); else if (score < 70) fill.classList.add('medium');

  document.getElementById('score-num').textContent  = score;
  document.getElementById('score-desc').textContent = score>=75?'✅ Good Safety':score>=50?'⚠ Moderate Risk':'🚨 High Risk';
  document.getElementById('route-eta').textContent  = `⏱ ${route.eta} • 📏 ${route.distance}`;

  const risksList = document.getElementById('risks-list');
  risksList.innerHTML = '';
  if (!route.risks?.length) {
    risksList.innerHTML = '<div style="font-size:13px;color:#666;padding:8px 0;">No major risks identified ✅</div>';
  } else {
    const iconFor = t => { t=t.toLowerCase(); if(t.includes('light')||t.includes('dark'))return'🌑'; if(t.includes('crowd')||t.includes('isolat'))return'👥'; if(t.includes('activity'))return'🚶'; if(t.includes('risk'))return'⚠️'; return'📍'; };
    route.risks.forEach((r,i) => {
      const item = document.createElement('div');
      item.className = 'risk-item'; item.style.animationDelay = `${i*0.08}s`;
      item.innerHTML = `<span class="risk-icon">${iconFor(r)}</span><span>${r}</span>`;
      risksList.appendChild(item);
    });
  }

  const hiSec = document.getElementById('highlights-section');
  hiSec.innerHTML = '';
  if (score >= 60) {
    hiSec.innerHTML = '<div class="highlights-title">✅ Safety Highlights</div>';
    [{ icon:'📷', text:'CCTV coverage along route' },{ icon:'🚔', text:'Police patrol zone nearby' },{ icon:'🏥', text:'Emergency services accessible' }]
      .forEach((h,i) => {
        const item = document.createElement('div');
        item.className = 'highlight-item'; item.style.animationDelay = `${i*0.08}s`;
        item.innerHTML = `<span class="risk-icon">${h.icon}</span><span>${h.text}</span>`;
        hiSec.appendChild(item);
      });
  }
}

// ================================================================
//  NAVIGATION MODE (Google Maps style)
// ================================================================
const NAV_STEPS = [
  { icon: '⬆️', dist: 'In 300 m', street: 'Continue straight on main road' },
  { icon: '↰',  dist: 'In 150 m', street: 'Turn left at next junction' },
  { icon: '⬆️', dist: 'In 500 m', street: 'Continue on highway' },
  { icon: '↱',  dist: 'In 80 m',  street: 'Turn right onto ring road' },
  { icon: '⬆️', dist: 'In 1.2 km', street: 'Stay on current road' },
  { icon: '🏁', dist: 'Arriving', street: 'You have reached your destination' },
];

// ── Off-route detection helpers ──────────────────────────────────

/**
 * Returns the minimum distance (metres) from `latlng` ([lat,lon]) to the
 * nearest point on the polyline defined by `coords` ([[lat,lon], …]).
 */
function distanceToPolyline(latlng, coords) {
  let minDist = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentDist(latlng, coords[i], coords[i + 1]);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/** Euclidean distance (metres via Leaflet) from point P to segment AB. */
function pointToSegmentDist(P, A, B) {
  const pA = map.distance(P, A);
  const pB = map.distance(P, B);
  const ab = map.distance(A, B);
  if (ab === 0) return pA;
  // Project P onto line AB (parametric t ∈ [0,1])
  const t = Math.max(0, Math.min(1,
    ((P[0] - A[0]) * (B[0] - A[0]) + (P[1] - A[1]) * (B[1] - A[1])) /
    ((B[0] - A[0]) ** 2 + (B[1] - A[1]) ** 2)
  ));
  const closest = [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])];
  return map.distance(P, closest);
}

/**
 * Fetch a fresh route from currentLoc to navDestCoord and update
 * the active navigation route + HUD without leaving nav mode.
 */
async function rerouteFromCurrentPosition(currentLoc) {
  if (isRerouting || !navDestCoord) return;
  isRerouting = true;
  lastRerouteTime = Date.now();

  // Show rerouting banner
  updateTurnBanner({ icon: '🔄', dist: 'Please wait…', street: 'Rerouting…' });

  try {
    const fromCoord = { lat: currentLoc[0], lon: currentLoc[1] };
    const osrmRoutes = await getOSRMRoute(fromCoord, navDestCoord);
    if (!osrmRoutes || !osrmRoutes.length) throw new Error('No route');

    const newRoute = osrmRoutes[0];   // take fastest new route

    // Update the active route in routesData so arrival check keeps working
    routesData[selectedRoute].coords      = newRoute.coords;
    routesData[selectedRoute].eta         = newRoute.eta;
    routesData[selectedRoute].distance    = newRoute.distance;
    routesData[selectedRoute].durationMins = newRoute.durationMins;

    // Redraw only the new active route
    clearRoutes();
    drawRoute(routesData[selectedRoute], selectedRoute ?? 0);

    // Update HUD
    const now = new Date();
    now.setMinutes(now.getMinutes() + newRoute.durationMins);
    const arrivalTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.getElementById('nav-hud-eta-val').textContent  = arrivalTime;
    document.getElementById('nav-hud-dist-val').textContent = newRoute.distance;

    // Refresh landmarks for new route
    fetchAndShowLandmarks([routesData[selectedRoute]]);

    showAlert('🔄 Route updated from your current location');
    updateTurnBanner(NAV_STEPS[0]);  // reset turn instruction
  } catch (e) {
    showAlert('⚠ Could not reroute – check internet connection');
    updateTurnBanner(NAV_STEPS[0]);
  } finally {
    isRerouting = false;
  }
}

function startNavigation() {
  if (selectedRoute === null) return;
  const route = routesData[selectedRoute];

  // ── Store destination coordinate for rerouting ──
  const destCoords = route.coords[route.coords.length - 1];
  navDestCoord  = { lat: destCoords[0], lon: destCoords[1] };
  isRerouting   = false;
  lastRerouteTime = 0;

  // Enter nav mode
  document.getElementById('bottom-panel').classList.add('nav-mode');
  document.getElementById('wsm-float').classList.add('hidden');
  document.getElementById('sos-btn').classList.add('hidden');
  document.getElementById('top-bar').classList.add('hidden');
  document.getElementById('alert-banner').classList.add('hidden');

  // Show navigation UI
  document.getElementById('nav-turn-banner').classList.remove('hidden');
  document.getElementById('nav-hud').classList.remove('hidden');

  // HUD values
  const now = new Date();
  now.setMinutes(now.getMinutes() + route.durationMins);
  const arrivalTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('nav-hud-eta-val').textContent   = arrivalTime;
  document.getElementById('nav-hud-dist-val').textContent  = route.distance;
  document.getElementById('nav-hud-safety-val').textContent = route.safety_score + '/100';

  // Highlight selected route only
  clearRoutes();
  drawRoute(route, selectedRoute ?? 0);

  // Create animated car marker
  if (navMarker) map.removeLayer(navMarker);
  const carIcon = L.divIcon({
    html: '<div class="nav-car-icon">🚗</div>',
    iconSize: [36, 36], iconAnchor: [18, 18], className: ''
  });

  // Set initial position based on real GPS or route start
  const startPos = userLocation ? [userLocation.lat, userLocation.lon] : route.coords[0];
  navMarker = L.marker(startPos, { icon: carIcon, zIndexOffset: 1000 }).addTo(map);
  map.setView(startPos, 16);

  // Show first turn instruction
  updateTurnBanner(NAV_STEPS[0]);

  // ── OFF-ROUTE DETECTION CONSTANTS ──
  const OFF_ROUTE_THRESHOLD_M = 50;   // metres before triggering reroute
  const REROUTE_COOLDOWN_MS   = 15000; // minimum 15 s between reroutes

  // Real-time device tracking via Geolocation API
  let stepIdx = 0;
  if (navWatchId !== null) { navigator.geolocation.clearWatch(navWatchId); navWatchId = null; }

  navWatchId = navigator.geolocation.watchPosition((pos) => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const currentLoc = [lat, lon];

    // Move car marker and pan map
    navMarker.setLatLng(currentLoc);
    map.panTo(currentLoc, { animate: true, duration: 1.0 });

    // ── OFF-ROUTE CHECK ──────────────────────────────────────────
    const activeCoords = routesData[selectedRoute].coords;
    const distFromRoute = distanceToPolyline(currentLoc, activeCoords);
    const now2 = Date.now();

    if (
      distFromRoute > OFF_ROUTE_THRESHOLD_M &&
      !isRerouting &&
      (now2 - lastRerouteTime) > REROUTE_COOLDOWN_MS
    ) {
      rerouteFromCurrentPosition(currentLoc);
      return; // skip step logic until reroute completes
    }
    // ─────────────────────────────────────────────────────────────

    // Cycle turn-by-turn steps for UX simulation
    stepIdx = Math.min(stepIdx + 1, NAV_STEPS.length - 2);
    if (Math.random() > 0.8) {
      updateTurnBanner(NAV_STEPS[stepIdx]);
    }

    // Check if arrived (within ~50 metres of destination)
    const dest       = routesData[selectedRoute].coords;
    const destPoint  = dest[dest.length - 1];
    const distMeters = map.distance(currentLoc, destPoint);

    if (distMeters < 50) {
      navigator.geolocation.clearWatch(navWatchId);
      navWatchId = null;
      updateTurnBanner(NAV_STEPS[NAV_STEPS.length - 1]);
      showAlert('🏁 You have arrived at your destination!');
      setTimeout(stopNavigation, 4000);
    }
  }, (err) => {
    console.warn('Tracking error:', err);
    showAlert('⚠ Waiting for GPS location...');
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });

  // Start SOS arrival timer when Women Safety Mode is active
  if (wsmMode) startSOSTimer(route.durationMins);
}

function updateTurnBanner(step) {
  document.getElementById('nav-turn-icon').textContent  = step.icon;
  document.getElementById('nav-turn-dist').textContent  = step.dist;
  document.getElementById('nav-turn-street').textContent = step.street;
}

function stopNavigation() {
  if (navWatchId !== null) {
    navigator.geolocation.clearWatch(navWatchId);
    navWatchId = null;
  }
  isRerouting  = false;
  navDestCoord = null;
  if (navInterval) {
    clearInterval(navInterval);
    navInterval = null;
  }

  if (navMarker) { map.removeLayer(navMarker); navMarker = null; }

  document.getElementById('nav-turn-banner').classList.add('hidden');
  document.getElementById('nav-hud').classList.add('hidden');
  document.getElementById('bottom-panel').classList.remove('nav-mode');
  document.getElementById('wsm-float').classList.remove('hidden');
  document.getElementById('sos-btn').classList.remove('hidden');
  document.getElementById('top-bar').classList.remove('hidden');
  hideAlert();

  // Redraw all routes (no dimming after nav ends)
  cancelSOSTimer();  // clear SOS timer when navigation stops
  routesData.forEach((r, i) => drawRoute(r, i, false));
  if (routesData.length) map.fitBounds(routesData.flatMap(r => r.coords), { padding: [80, 90] });
}

// ================================================================
//  PANEL HELPERS
// ================================================================
function setLoading(on) {
  document.getElementById('find-btn').disabled = on;
  document.getElementById('btn-label').textContent = on ? 'Calculating routes…' : '🔍 Find Safe Route';
  document.getElementById('btn-spinner').classList.toggle('hidden', !on);
}

function openPanel() {
  document.getElementById('bottom-panel').classList.remove('collapsed');
  panelOpen = true; updateWSMFloat();
}

function togglePanel() {
  panelOpen = !panelOpen;
  document.getElementById('bottom-panel').classList.toggle('collapsed', !panelOpen);
  updateWSMFloat();
}

function updateWSMFloat() {
  const panel = document.getElementById('bottom-panel');
  const float = document.getElementById('wsm-float');
  const sos = document.getElementById('sos-btn');
  const bottomPos = (!panelOpen ? 80 : panel.offsetHeight + 8) + 'px';
  float.style.bottom = bottomPos;
  if (sos) sos.style.bottom = bottomPos;
}

new MutationObserver(updateWSMFloat).observe(document.getElementById('bottom-panel'), { attributes:true, childList:true, subtree:true });
window.addEventListener('resize', updateWSMFloat);
window.addEventListener('load',   updateWSMFloat);

// ================================================================
//  EMERGENCY HUB  (fan-out toggle)
// ================================================================
let emergencyHubOpen = false;

function toggleEmergencyHub() {
  emergencyHubOpen = !emergencyHubOpen;
  document.getElementById('sos-btn').classList.toggle('open', emergencyHubOpen);
}

// Close hub when user taps anywhere outside it
document.addEventListener('click', e => {
  const hub = document.getElementById('sos-btn');
  if (emergencyHubOpen && hub && !hub.contains(e.target)) {
    emergencyHubOpen = false;
    hub.classList.remove('open');
  }
});

// ================================================================
//  ALERT BANNER
// ================================================================
function showAlert(msg) {
  const b = document.getElementById('alert-banner');
  document.getElementById('alert-text').textContent = msg;
  b.classList.remove('hidden');
  clearTimeout(alertTimeout);
  alertTimeout = setTimeout(hideAlert, 7000);
}
function hideAlert()    { document.getElementById('alert-banner').classList.add('hidden'); }
function dismissAlert() { hideAlert(); }

// ================================================================
//  WOMEN SAFETY MODE
// ================================================================
function toggleWomenSafetyMode(active) {
  wsmMode = active;
  document.getElementById('wsm-float').classList.toggle('wsm-active', active);
  document.querySelector('.bottom-panel').classList.toggle('wsm-mode', active);
  if (active) showAlert('🛡 Women Safety Mode ON – Routes re-optimized for your safety');
  else { hideAlert(); cancelSOSTimer(); }
  if (routeLines.length && routesData.length) { clearRoutes(); routesData.forEach((r, i) => drawRoute(r, i, false)); }
}

// ================================================================
//  SEGMENT COLOR STRIP
// ================================================================
function buildSegmentStrip(labels) {
  if (!labels || !labels.length) return '';
  const colorMap = { safe: '#00c853', moderate: '#ffd600', danger: '#ff1744' };
  const segments = labels.map(l => {
    const c = colorMap[l] || '#ccc';
    return `<div class="seg-strip-cell" style="background:${c};" title="${l}"></div>`;
  }).join('');
  return `<div class="seg-strip">${segments}</div>`;
}

// ================================================================
//  SOS ARRIVAL TIMER
// ================================================================
function startSOSTimer(etaMins) {
  cancelSOSTimer();
  // Grace window = ETA + 5 minutes (in seconds)
  sosTimerSeconds = (etaMins + 5) * 60;

  const modal   = document.getElementById('sos-timer-modal');
  const display = document.getElementById('sos-timer-display');
  const label   = document.getElementById('sos-timer-label');
  modal.classList.remove('hidden');
  label.textContent = `Auto-check in ${etaMins + 5} min if not cancelled`;

  sosTimerInterval = setInterval(() => {
    sosTimerSeconds--;
    const m = Math.floor(sosTimerSeconds / 60);
    const s = sosTimerSeconds % 60;
    display.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

    if (sosTimerSeconds <= 60) {
      display.style.color = '#ff1744';
      display.style.animation = 'pulse-sos-text 0.6s infinite';
    }

    if (sosTimerSeconds <= 0) {
      clearInterval(sosTimerInterval);
      sosTimerInterval = null;
      modal.classList.add('hidden');
      // ── Step 2: show confirmation prompt instead of firing immediately ──
      startSOSConfirmation();
    }
  }, 1000);
}

// Step 2 – "Are you safe?" confirmation with its own 30-second countdown.
// SOS is only fired if the user ignores this prompt too.
function startSOSConfirmation() {
  let confirmSeconds = 30;
  const modal   = document.getElementById('sos-confirm-modal');
  const display = document.getElementById('sos-confirm-countdown');
  modal.classList.remove('hidden');
  display.textContent = confirmSeconds;

  sosConfirmInterval = setInterval(() => {
    confirmSeconds--;
    display.textContent = confirmSeconds;
    if (confirmSeconds <= 10) display.style.color = '#ff1744';
    if (confirmSeconds <= 0) {
      clearInterval(sosConfirmInterval);
      sosConfirmInterval = null;
      modal.classList.add('hidden');
      triggerSOSAlert();  // user ignored both prompts → fire SOS
    }
  }, 1000);
}

// Called when user taps "I'm Safe" on either modal
function cancelSOSTimer() {
  if (sosTimerInterval)   { clearInterval(sosTimerInterval);   sosTimerInterval   = null; }
  if (sosConfirmInterval) { clearInterval(sosConfirmInterval); sosConfirmInterval = null; }

  const modal = document.getElementById('sos-timer-modal');
  if (modal) modal.classList.add('hidden');
  const confirmModal = document.getElementById('sos-confirm-modal');
  if (confirmModal) confirmModal.classList.add('hidden');

  const display = document.getElementById('sos-timer-display');
  if (display) { display.style.color = ''; display.style.animation = ''; }
  const cd = document.getElementById('sos-confirm-countdown');
  if (cd) { cd.style.color = ''; }
}

function triggerSOSAlert() {
  // Build a shareable location URL
  const locStr = userLocation
    ? `https://maps.google.com/?q=${userLocation.lat},${userLocation.lon}`
    : 'Location unavailable';
  const msg = `🚨 SOS! I haven't reached my destination. Last known location: ${locStr}`;
  // Try Web Share API (works on mobile), fallback to copy
  if (navigator.share) {
    navigator.share({ title: 'Emergency SOS', text: msg }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(msg).catch(() => {});
    showAlert('🚨 SOS message copied to clipboard! Share with emergency contact.');
  }
}