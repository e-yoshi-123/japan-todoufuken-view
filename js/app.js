'use strict';

const MUNI_ZOOM = 8;
const FADE_START = 7.5;

const COLOR_SCALES = {
  population: {
    title: '人口',
    colors: ['#fff7ec','#fee8c8','#fdd49e','#fdbb84','#fc8d59','#ef6548','#d7301f','#990000'],
    min: 500000,
    max: 14000000,
    format: v => (v >= 10000 ? `${Math.round(v/10000)}万` : `${v.toLocaleString()}`)
  },
  avg_age: {
    title: '平均年齢',
    colors: ['#ffffcc','#d9f0a3','#addd8e','#78c679','#41ab5d','#238443','#006837','#004529'],
    min: 44,
    max: 55,
    format: v => `${v.toFixed(1)}歳`
  },
  elderly_pct: {
    title: '高齢化率 (65歳以上)',
    colors: ['#f7fbff','#deebf7','#c6dbef','#9ecae1','#6baed6','#4292c6','#2171b5','#084594'],
    min: 20,
    max: 38,
    format: v => `${v.toFixed(1)}%`
  }
};

let map, prefStats = {}, muniStats = {};
let currentMode = 'population';
let loadedMuniPrefectures = new Set();
let isShowingMunicipalities = false;
const muniFeatureMap = {};
let centerPrefCode = null;
let highlightRafId = null;

async function init() {
  const statsResp = await fetch('data/prefecture_stats.json');
  const statsData = await statsResp.json();
  statsData.prefectures.forEach(p => { prefStats[p.code] = p; });

  const prefResp = await fetch('data/prefectures.geojson');
  const prefGeoJSON = await prefResp.json();
  prefGeoJSON.features.forEach(f => {
    const code = f.properties.N03_007;
    if (prefStats[code]) Object.assign(f.properties, prefStats[code]);
  });

  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [139.7, 35.69],
    zoom: 9.0,
    minZoom: 4,
    maxZoom: 14,
    // 日本の範囲外にパンできないように制限
    maxBounds: [[119, 22], [156, 47]]
  });

  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  map.on('load', () => {
    const style = map.getStyle();
    const firstSymbolId = style.layers.find(l => l.type === 'symbol')?.id;

    addWorldMask(firstSymbolId);
    setupPrefectureFill(prefGeoJSON, firstSymbolId);
    setupMunicipalityLayer(firstSymbolId);
    addPrefectureOverlay(); // municipality-border の直前に挿入
    // 都道府県境界線は市区町村fillより後に追加 → 常に最前面
    addPrefectureBorder(firstSymbolId);
    // 都道府県・市区町村のラベルは symbol層として最上位に追加
    addPrefectureLabel();
    addMunicipalityLabel();
    configureOFMLabels();
    updateLegend();
    updateColoring();
    bindZoomEvents();
    bindControls();
    bindMapEvents();
    // 初期ズームがMUNI_ZOOM以上の場合、起動時に市区町村データをロード
    if (map.getZoom() >= MUNI_ZOOM) {
      isShowingMunicipalities = true;
      loadVisibleMunicipalities();
    }
  });
}

// ---- 日本外マスク ----

function addWorldMask(beforeId) {
  // 日本のbboxを穴として持つ世界矩形ポリゴン
  map.addSource('world-mask', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[-180,-90],[180,-90],[180,90],[-180,90],[-180,-90]],
          [[119,22],[156,22],[156,47],[119,47],[119,22]]
        ]
      }
    }
  });

  map.addLayer({
    id: 'world-mask',
    type: 'fill',
    source: 'world-mask',
    paint: {
      'fill-color': '#b8d4e8',
      'fill-opacity': 1
    }
  }, beforeId);
}

// ---- 都道府県レイヤー ----

function setupPrefectureFill(geojson, beforeId) {
  map.addSource('prefectures', { type: 'geojson', data: geojson });

  // zoom 7.5〜8 の間でフェードアウト（fillのみ）
  map.addLayer({
    id: 'prefecture-fill',
    type: 'fill',
    source: 'prefectures',
    paint: {
      'fill-color': '#e8e8e8',
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], FADE_START, 0.8, MUNI_ZOOM, 0]
    }
  }, beforeId);
}

function addPrefectureBorder(beforeId) {
  // 市区町村fillより後に追加することで、市区町村ズームでも最前面に描画
  map.addLayer({
    id: 'prefecture-border',
    type: 'line',
    source: 'prefectures',
    paint: {
      'line-color': '#1e3a8a',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 8, 4.0, 12, 5.5],
      'line-opacity': 1.0
    }
  }, beforeId);
}

function addPrefectureLabel() {
  map.addLayer({
    id: 'prefecture-label',
    type: 'symbol',
    source: 'prefectures',
    minzoom: 4.5,
    maxzoom: MUNI_ZOOM,
    layout: {
      'text-field': ['get', 'N03_001'],
      'text-font': ['Noto Sans Bold', 'Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5, 9, 7, 13],
      'text-allow-overlap': false,
      'text-anchor': 'center'
    },
    paint: {
      'text-color': '#1e293b',
      'text-halo-color': 'rgba(255,255,255,0.9)',
      'text-halo-width': 2
    }
  });
}

function addMunicipalityLabel() {
  map.addLayer({
    id: 'municipality-label',
    type: 'symbol',
    source: 'municipalities',
    minzoom: MUNI_ZOOM,
    layout: {
      'text-field': ['coalesce', ['get', 'N03_004'], ['get', 'N03_003'], ''],
      'text-font': ['Noto Sans Regular', 'Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 13, 13],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'text-anchor': 'center',
      'text-max-width': 4
    },
    paint: {
      'text-color': '#1e293b',
      'text-halo-color': 'rgba(255,255,255,0.9)',
      'text-halo-width': 1.5
    }
  });
}

function configureOFMLabels() {
  const layers = map.getStyle().layers;
  const existing = new Set(layers.map(l => l.id));

  // OFMのboundary系・道路番号シールド系レイヤーを非表示
  layers
    .filter(l => l.id.includes('boundary') || l.id.includes('admin') || l.id.includes('shield') || l.id.includes('road_label') || l.id.includes('route'))
    .forEach(l => map.setLayoutProperty(l.id, 'visibility', 'none'));

  // OFMの都道府県名ラベルは非表示（自前で描画）
  if (existing.has('label_state')) {
    map.setLayoutProperty('label_state', 'visibility', 'none');
  }
  // OFMの都市・集落ラベルは zoom >= MUNI_ZOOM で非表示（自前ラベルに切り替え）
  ['label_city', 'label_city_capital', 'label_town', 'label_village', 'label_other']
    .filter(id => existing.has(id))
    .forEach(id => {
      map.setPaintProperty(id, 'text-opacity',
        ['step', ['zoom'], 1, MUNI_ZOOM, 0]);
    });
}

// ---- 市区町村レイヤー ----

function setupMunicipalityLayer(beforeId) {
  map.addSource('municipalities', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });

  // zoom 7.5〜8 の間でフェードイン
  const muniOpacity = ['interpolate', ['linear'], ['zoom'],
    FADE_START, 0,
    MUNI_ZOOM, 0.8
  ];
  const muniLineOpacity = ['interpolate', ['linear'], ['zoom'],
    FADE_START, 0,
    MUNI_ZOOM, 0.9
  ];

  map.addLayer({
    id: 'municipality-fill',
    type: 'fill',
    source: 'municipalities',
    paint: { 'fill-color': '#e8e8e8', 'fill-opacity': muniOpacity }
  }, beforeId);

  map.addLayer({
    id: 'municipality-border',
    type: 'line',
    source: 'municipalities',
    paint: {
      'line-color': '#064e3b',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 12, 3.5],
      'line-opacity': 1.0
    }
  }, beforeId);
}

// ---- ズームイベント ----

function getCenterPrefCode() {
  const point = map.project(map.getCenter());
  const features = map.queryRenderedFeatures(point, { layers: ['prefecture-fill'] });
  if (features.length > 0) {
    const code = features[0].properties.N03_007;
    return code ? code.substring(0, 2) : null;
  }
  return null;
}

function addPrefectureOverlay() {
  map.addLayer({
    id: 'prefecture-overlay',
    type: 'fill',
    source: 'prefectures',
    filter: ['==', ['get', 'N03_007'], '__none__'], // 初期は非表示
    paint: {
      'fill-color': 'white',
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], FADE_START, 0, MUNI_ZOOM, 0.82]
    }
  }, 'municipality-border');
}

function applyOverlay() {
  map.setFilter('prefecture-overlay', centerPrefCode
    ? ['!=', ['get', 'N03_007'], centerPrefCode + '000']
    : ['==', ['get', 'N03_007'], '__none__']
  );
}

function updateCenterHighlight() {
  const z = map.getZoom();
  if (z < MUNI_ZOOM) {
    if (centerPrefCode !== null) { centerPrefCode = null; applyOverlay(); }
    return;
  }
  const newCode = getCenterPrefCode();
  if (newCode === centerPrefCode) return;
  centerPrefCode = newCode;
  applyOverlay();
}

function scheduleHighlightUpdate() {
  if (highlightRafId) return;
  highlightRafId = requestAnimationFrame(() => { highlightRafId = null; updateCenterHighlight(); });
}

function bindZoomEvents() {
  map.on('zoom', () => {
    const z = map.getZoom();
    document.getElementById('zoom-level').textContent = `zoom ${z.toFixed(1)}`;
    const showingMuni = z >= MUNI_ZOOM;

    if (showingMuni && !isShowingMunicipalities) {
      isShowingMunicipalities = true;
      loadVisibleMunicipalities();
    } else if (!showingMuni) {
      isShowingMunicipalities = false;
    }
  });

  map.on('move', scheduleHighlightUpdate);

  map.on('moveend', () => {
    if (map.getZoom() >= MUNI_ZOOM) loadVisibleMunicipalities();
  });
}

function bindToggle() {
  const btn = document.getElementById('toggle-btn');
  const controls = document.getElementById('controls');

  if (window.innerWidth <= 600) {
    controls.classList.add('collapsed');
    btn.textContent = '開く ▼';
  }

  btn.addEventListener('click', () => {
    controls.classList.toggle('collapsed');
    btn.textContent = controls.classList.contains('collapsed') ? '開く ▼' : '閉じる ▲';
  });
}

function bindControls() {
  document.querySelectorAll('.btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn[data-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      updateLegend();
      updateColoring();
    });
  });
  bindToggle();
}

function bindMapEvents() {
  map.on('click', 'prefecture-fill', e => {
    if (map.getZoom() >= MUNI_ZOOM) return; // 市区町村モード時はスキップ
    const props = e.features[0].properties;
    showInfo(props.N03_001, prefStats[props.N03_007]);
  });

  map.on('click', 'municipality-fill', e => {
    const props = e.features[0].properties;
    const name = [props.N03_001, props.N03_003, props.N03_004].filter(Boolean).join(' ');
    showInfo(name, muniStats[props.N03_007]);
  });

  map.on('mouseenter', 'prefecture-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'prefecture-fill', () => { map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', 'municipality-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'municipality-fill', () => { map.getCanvas().style.cursor = ''; });
}

function showInfo(name, stats) {
  document.getElementById('info-name').textContent = name || '不明';
  if (!stats) {
    document.getElementById('info-stats').innerHTML = '<div style="color:#aaa;font-size:11px">データなし</div>';
    return;
  }
  document.getElementById('info-stats').innerHTML = `
    <div class="stat-row"><span>人口</span><span class="stat-value">${stats.population ? stats.population.toLocaleString() + ' 人' : 'N/A'}</span></div>
    <div class="stat-row"><span>平均年齢</span><span class="stat-value">${stats.avg_age != null ? stats.avg_age.toFixed(1) + ' 歳' : 'N/A'}</span></div>
    <div class="stat-row"><span>高齢化率</span><span class="stat-value">${stats.elderly_pct != null ? stats.elderly_pct.toFixed(1) + ' %' : 'N/A'}</span></div>
  `;
}

// ---- ヒートマップ ----

function buildColorExpression(mode, statsMap, codeKey) {
  const scale = COLOR_SCALES[mode];
  const expr = ['match', ['get', codeKey]];
  let hasEntries = false;

  for (const [code, stats] of Object.entries(statsMap)) {
    const val = stats[mode];
    if (val == null) continue;
    const t = Math.max(0, Math.min(1, (val - scale.min) / (scale.max - scale.min)));
    expr.push(code, interpolateColors(scale.colors, t));
    hasEntries = true;
  }

  if (!hasEntries) return '#e8e8e8';
  expr.push('#e8e8e8');
  return expr;
}

function buildMuniColorExpression(mode) {
  const scale = COLOR_SCALES[mode];
  const expr = ['match', ['get', 'N03_007']];

  // 全国の市区町村データからmin/maxを動的に計算
  const vals = Object.values(muniStats).map(s => s[mode]).filter(v => v != null);
  if (vals.length === 0) return '#e8e8e8';
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;

  let hasEntries = false;
  for (const [code, stats] of Object.entries(muniStats)) {
    const val = stats[mode];
    if (val == null) continue;
    const t = Math.max(0, Math.min(1, (val - min) / range));
    expr.push(code, interpolateColors(scale.colors, t));
    hasEntries = true;
  }

  if (!hasEntries) return '#e8e8e8';
  expr.push('#e8e8e8');
  return expr;
}

function updateColoring() {
  map.setPaintProperty('prefecture-fill', 'fill-color',
    buildColorExpression(currentMode, prefStats, 'N03_007'));

  if (Object.keys(muniStats).length > 0) {
    map.setPaintProperty('municipality-fill', 'fill-color',
      buildMuniColorExpression(currentMode));
  }
}

function interpolateColors(colors, t) {
  const n = colors.length - 1;
  const idx = Math.min(Math.floor(t * n), n - 1);
  return lerpColor(colors[idx], colors[idx + 1], t * n - idx);
}

function lerpColor(a, b, t) {
  const p = hex => [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
  const [ar,ag,ab] = p(a), [br,bg,bb] = p(b);
  return `rgb(${Math.round(ar+(br-ar)*t)},${Math.round(ag+(bg-ag)*t)},${Math.round(ab+(bb-ab)*t)})`;
}

// ---- 凡例 ----

function updateLegend() {
  const scale = COLOR_SCALES[currentMode];
  document.getElementById('legend-title').textContent = scale.title;
  document.getElementById('legend-bar').style.background =
    `linear-gradient(to right, ${scale.colors.join(',')})`;
  document.getElementById('legend-labels').innerHTML =
    `<span>${scale.format(scale.min)}</span><span>${scale.format(scale.max)}</span>`;
}

// ---- 市区町村データ遅延読み込み ----

async function loadVisibleMunicipalities() {
  const codes = getVisiblePrefectureCodes();
  const toLoad = codes.filter(c => !loadedMuniPrefectures.has(c));
  if (toLoad.length === 0) return;

  document.getElementById('loading-indicator').style.display = 'block';
  await Promise.all(toLoad.map(loadMunicipalityData));

  map.getSource('municipalities')
    .setData({ type: 'FeatureCollection', features: Object.values(muniFeatureMap) });
  updateColoring();
  updateCenterHighlight();
  document.getElementById('loading-indicator').style.display = 'none';
}

function getVisiblePrefectureCodes() {
  const codes = new Set();
  // queryRenderedFeatures: viewport内の描画済みフィーチャーを取得
  map.queryRenderedFeatures({ layers: ['prefecture-fill'] }).forEach(f => {
    const c = f.properties.N03_007?.substring(0, 2);
    if (c) codes.add(c);
  });
  // querySourceFeatures: ロード済みタイル全体から補完（viewport端の都道府県を確実に拾うため）
  map.querySourceFeatures('prefectures').forEach(f => {
    const c = f.properties.N03_007?.substring(0, 2);
    if (c) codes.add(c);
  });
  return Array.from(codes);
}

async function loadMunicipalityData(prefCode) {
  if (loadedMuniPrefectures.has(prefCode)) return;
  loadedMuniPrefectures.add(prefCode);
  try {
    const resp = await fetch(`data/municipalities/${prefCode}.json`);
    if (!resp.ok) return;
    const geojson = await resp.json();
    geojson.features.forEach(f => {
      const code = f.properties.N03_007;
      if (!code) return;
      f.properties.pref_code = code.substring(0, 2);
      muniFeatureMap[code] = f;
      if (!muniStats[code]) {
        muniStats[code] = generatePlaceholderStats(code);
        Object.assign(f.properties, muniStats[code]);
      }
    });
  } catch (e) {
    console.warn(`Failed to load municipalities/${prefCode}:`, e);
  }
}

function generatePlaceholderStats(muniCode) {
  const prefCode = muniCode.substring(0, 2) + '000';
  const pref = prefStats[prefCode] || {};
  const seed = muniCode.split('').reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 0);
  const rand = (min, max, offset = 0) => min + ((seed * 7919 + offset) % 1000) / 1000 * (max - min);
  return {
    population: Math.round((pref.population || 1000000) / 30 * (0.05 + rand(0, 2.5, 0))),
    avg_age: Math.round(((pref.avg_age || 48) + rand(-5, 5, 1)) * 10) / 10,
    elderly_pct: Math.round(((pref.elderly_pct || 28) + rand(-6, 6, 2)) * 10) / 10
  };
}

init().catch(console.error);
