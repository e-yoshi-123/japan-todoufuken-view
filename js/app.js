'use strict';

// ズームしきい値: これ以上で市区町村表示
const MUNI_ZOOM = 8;

// カラースケール設定
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

async function init() {
  // 都道府県統計データ読み込み
  const statsResp = await fetch('data/prefecture_stats.json');
  const statsData = await statsResp.json();
  statsData.prefectures.forEach(p => { prefStats[p.code] = p; });

  // 都道府県GeoJSON読み込み
  const prefResp = await fetch('data/prefectures.geojson');
  const prefGeoJSON = await prefResp.json();

  // 統計データをGeoJSONフィーチャーにマージ
  prefGeoJSON.features.forEach(f => {
    const code = f.properties.N03_007;
    if (prefStats[code]) {
      Object.assign(f.properties, prefStats[code]);
    }
  });

  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [136.5, 36.0],
    zoom: 5,
    minZoom: 3,
    maxZoom: 14
  });

  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  map.on('load', () => {
    // ラベルより下に挿入するためのアンカーレイヤーを探す
    const style = map.getStyle();
    const firstSymbolId = style.layers.find(l => l.type === 'symbol')?.id;

    setupPrefectureLayer(prefGeoJSON, firstSymbolId);
    setupMunicipalityLayer(firstSymbolId);
    updateLegend();
    updateColoring();
    bindZoomEvents();
    bindControls();
    bindMapEvents();
  });
}

function setupPrefectureLayer(geojson, beforeId) {
  map.addSource('prefectures', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'prefecture-fill',
    type: 'fill',
    source: 'prefectures',
    paint: {
      'fill-color': '#e8e8e8',
      'fill-opacity': 0.75
    }
  }, beforeId);

  map.addLayer({
    id: 'prefecture-border',
    type: 'line',
    source: 'prefectures',
    paint: {
      'line-color': '#1d4ed8',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.2, 8, 2.5, 10, 1.5],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 1.0, 9, 0.4]
    }
  }, beforeId);
}

function setupMunicipalityLayer(beforeId) {
  map.addSource('municipalities', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });

  map.addLayer({
    id: 'municipality-fill',
    type: 'fill',
    source: 'municipalities',
    paint: {
      'fill-color': '#e8e8e8',
      'fill-opacity': 0.75
    }
  }, beforeId);

  map.addLayer({
    id: 'municipality-border',
    type: 'line',
    source: 'municipalities',
    paint: {
      'line-color': '#047857',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 12, 1.8],
      'line-opacity': 0.8
    }
  }, beforeId);
}

function bindZoomEvents() {
  map.on('zoom', () => {
    const z = map.getZoom();
    document.getElementById('zoom-level').textContent = `zoom ${z.toFixed(1)}`;
    const showing = z >= MUNI_ZOOM;

    document.getElementById('level-badge').textContent =
      showing ? '市区町村表示' : '都道府県表示';
    document.getElementById('level-badge').className =
      showing ? 'municipality' : '';

    if (showing && !isShowingMunicipalities) {
      isShowingMunicipalities = true;
      loadVisibleMunicipalities();
    } else if (!showing) {
      isShowingMunicipalities = false;
    }
  });

  map.on('moveend', () => {
    if (map.getZoom() >= MUNI_ZOOM) loadVisibleMunicipalities();
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
}

function bindMapEvents() {
  // 都道府県クリック
  map.on('click', 'prefecture-fill', e => {
    const props = e.features[0].properties;
    const code = props.N03_007;
    const stats = prefStats[code];
    showInfo(props.N03_001 || props.name, stats);
  });

  // 市区町村クリック
  map.on('click', 'municipality-fill', e => {
    const props = e.features[0].properties;
    const name = [props.N03_001, props.N03_003, props.N03_004].filter(Boolean).join(' ');
    const code = props.N03_007;
    const stats = muniStats[code];
    showInfo(name, stats);
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
    <div class="stat-row"><span>平均年齢</span><span class="stat-value">${stats.avg_age ? stats.avg_age.toFixed(1) + ' 歳' : 'N/A'}</span></div>
    <div class="stat-row"><span>高齢化率</span><span class="stat-value">${stats.elderly_pct ? stats.elderly_pct.toFixed(1) + ' %' : 'N/A'}</span></div>
  `;
}

// ---- ヒートマップ更新 ----

function buildColorExpression(mode, statsMap, codeKey) {
  const scale = COLOR_SCALES[mode];
  const stops = [];

  for (const [code, stats] of Object.entries(statsMap)) {
    const val = stats[mode];
    if (val == null) continue;
    const t = Math.max(0, Math.min(1, (val - scale.min) / (scale.max - scale.min)));
    const color = interpolateColors(scale.colors, t);
    stops.push([code, color]);
  }

  if (stops.length === 0) return '#e8e8e8';

  const expr = ['match', ['get', codeKey]];
  stops.forEach(([code, color]) => { expr.push(code, color); });
  expr.push('#e8e8e8');
  return expr;
}

function updateColoring() {
  const prefExpr = buildColorExpression(currentMode, prefStats, 'N03_007');
  map.setPaintProperty('prefecture-fill', 'fill-color', prefExpr);

  if (Object.keys(muniStats).length > 0) {
    const muniExpr = buildColorExpression(currentMode, muniStats, 'N03_007');
    map.setPaintProperty('municipality-fill', 'fill-color', muniExpr);
  }
}

function interpolateColors(colors, t) {
  const n = colors.length - 1;
  const idx = Math.min(Math.floor(t * n), n - 1);
  const frac = t * n - idx;
  return lerpColor(colors[idx], colors[idx + 1], frac);
}

function lerpColor(a, b, t) {
  const parse = hex => [
    parseInt(hex.slice(1,3),16),
    parseInt(hex.slice(3,5),16),
    parseInt(hex.slice(5,7),16)
  ];
  const [ar,ag,ab] = parse(a);
  const [br,bg,bb] = parse(b);
  const r = Math.round(ar + (br-ar)*t);
  const g = Math.round(ag + (bg-ag)*t);
  const bl = Math.round(ab + (bb-ab)*t);
  return `rgb(${r},${g},${bl})`;
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
  const bounds = map.getBounds();
  const prefecturesToLoad = getVisiblePrefectureCodes(bounds);

  const toLoad = prefecturesToLoad.filter(code => !loadedMuniPrefectures.has(code));
  if (toLoad.length === 0) return;

  const indicator = document.getElementById('loading-indicator');
  indicator.style.display = 'block';

  const promises = toLoad.map(code => loadMunicipalityData(code));
  await Promise.all(promises);

  const src = map.getSource('municipalities');
  src.setData({ type: 'FeatureCollection', features: Object.values(muniFeatureMap) });

  updateColoring();
  indicator.style.display = 'none';
}

function getVisiblePrefectureCodes(bounds) {
  const features = map.queryRenderedFeatures({ layers: ['prefecture-fill'] });
  const codes = new Set();
  features.forEach(f => {
    const code = f.properties.N03_007;
    if (code) codes.add(code.substring(0, 2));
  });
  return Array.from(codes);
}

const muniFeatureMap = {};

async function loadMunicipalityData(prefCode) {
  if (loadedMuniPrefectures.has(prefCode)) return;
  loadedMuniPrefectures.add(prefCode);

  try {
    const resp = await fetch(`data/municipalities/${prefCode}.json`);
    if (!resp.ok) return;
    const geojson = await resp.json();

    geojson.features.forEach(f => {
      const code = f.properties.N03_007;
      if (code) {
        muniFeatureMap[code] = f;
        // プレースホルダー統計（実データがあれば上書き）
        if (!muniStats[code]) {
          muniStats[code] = generatePlaceholderStats(code);
          Object.assign(f.properties, muniStats[code]);
        }
      }
    });
  } catch (e) {
    console.warn(`Failed to load municipalities for ${prefCode}:`, e);
  }
}


function generatePlaceholderStats(muniCode) {
  // 都道府県コードから親の統計を参照してランダムに分散させる
  const prefCode = muniCode.substring(0, 2) + '000';
  const prefStat = prefStats[prefCode] || {};
  const baseAge = prefStat.avg_age || 48;
  const basePop = (prefStat.population || 1000000) / 30;

  const seed = muniCode.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng = (min, max) => min + ((seed * 1234567 % 1000) / 1000) * (max - min);

  return {
    population: Math.round(basePop * (0.1 + rng(0, 2))),
    avg_age: Math.round((baseAge + rng(-4, 4)) * 10) / 10,
    elderly_pct: Math.round((prefStat.elderly_pct || 28) + rng(-5, 5)) * 10 / 10
  };
}

init().catch(console.error);
