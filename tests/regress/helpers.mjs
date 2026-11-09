import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(here, '../../.cache/regress');
const ASSET_DIR = resolve(CACHE_DIR, 'assets');

export const DEMOS = {
  image: { title: 'Street & Travel', path: '/demo-street-travel' },
  fullScene: { title: 'Multiview Model', path: '/demo-multiview-model' },
};

/** Serve demo downloads from disk after the first run, so tests do not depend on R2. */
export const cacheDemoAssets = async (context) => {
  mkdirSync(ASSET_DIR, { recursive: true });
  await context.route(/\.r2\.dev\//, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || request.headers().range) return route.continue();

    const file = resolve(ASSET_DIR, createHash('sha1').update(request.url()).digest('hex'));
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' };
    if (existsSync(file)) return route.fulfill({ status: 200, headers, body: readFileSync(file) });

    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const body = await response.body();
    writeFileSync(file, body);
    return route.fulfill({ status: 200, headers, body });
  });
};

/** Runs in the page. Records one sample per animation frame while `rec` is true. */
const installProbeInPage = async () => {
  if (window.__probe) return;
  const [v, { useStore }, fl, sm] = await Promise.all([
    import('/src/viewer.js'),
    import('/src/store.js'),
    import('/src/fileLoader.js'),
    import('/src/splatManager.js'),
  ]);
  const el = document.querySelector('#viewer');
  const probe = { v, useStore, fl, sm, el, rec: false, samples: [], longtasks: [] };
  window.__probe = probe;

  new PerformanceObserver((list) => {
    if (!probe.rec) return;
    for (const e of list.getEntries()) probe.longtasks.push({ t: e.startTime, d: e.duration });
  }).observe({ entryTypes: ['longtask'] });

  const sample = () => {
    if (probe.rec) {
      const c = v.camera.position;
      let visible = 0;
      sm.getSplatCache().forEach((entry) => { if (entry.mesh.visible) visible += 1; });
      probe.samples.push({
        t: performance.now(),
        out: el.classList.contains('slide-out'),
        in: el.classList.contains('slide-in'),
        loading: el.classList.contains('loading'),
        opacity: parseFloat(getComputedStyle(el).opacity),
        idx: useStore.getState().currentAssetIndex,
        mesh: v.currentMesh?.uuid ?? null,
        cam: [c.x, c.y, c.z],
        visible,
      });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

export const openDemo = async (page, demo) => {
  await page.goto(process.env.REGRESS_FRAME_GATE ? '/?frameGate' : '/');
  await page.getByRole('button', { name: /^D\s*e\s*m\s*o$/ }).click();
  await page.getByText(demo.title, { exact: true }).click();
  await page.getByRole('button', { name: 'Open selected' }).click();
  await page.waitForURL(`**${demo.path}`, { timeout: 180_000 });
  await page.waitForSelector('#viewer.has-mesh', { state: 'attached', timeout: 180_000 });
  await page.evaluate(installProbeInPage);
  await waitForSettled(page);
  await waitForNeighbours(page);
};

/** Neighbour preloads are unawaited and are the main post-transition stall, so wait for them explicitly. */
export const waitForNeighbours = (page, timeout = 120_000) => page.evaluate(async (limit) => {
  const { useStore, sm } = window.__probe;
  const deadline = performance.now() + limit;
  while (performance.now() < deadline) {
    const { assets } = useStore.getState();
    const unique = new Set(assets.map((a) => a.cacheKey || a.baseAssetId || a.id)).size;
    if (sm.getSplatCache().size >= Math.min(3, unique)) {
      await new Promise((r) => setTimeout(r, 500));
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Neighbours did not finish preloading in time');
}, timeout);

/** Resolves when no transition, load, or camera motion has been active for 750 ms. */
export const waitForSettled = (page, timeout = 120_000) => page.evaluate(async (limit) => {
  const { v, useStore, fl, el } = window.__probe;
  const deadline = performance.now() + limit;
  let stableSince = null;
  let last = null;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const pos = v.camera.position;
    const moved = !last || pos.distanceTo(last) > 1e-5;
    last = pos.clone();
    const busy = moved
      || fl.isNavigationLockedRef()
      || useStore.getState().isLoading
      || ['slide-out', 'slide-in', 'loading'].some((c) => el.classList.contains(c));
    if (busy) { stableSince = null; continue; }
    stableSince ??= performance.now();
    if (performance.now() - stableSince >= 750) return;
  }
  throw new Error('Viewer did not settle in time');
}, timeout);

export const startRecording = (page) => page.evaluate(() => {
  const probe = window.__probe;
  probe.samples = [];
  probe.longtasks = [];
  probe.rec = true;
});

export const stopRecording = (page) => page.evaluate(() => {
  const probe = window.__probe;
  probe.rec = false;
  return { samples: probe.samples, longtasks: probe.longtasks };
});

export const readState = (page) => page.evaluate(() => {
  const { v, useStore, sm, fl, el } = window.__probe;
  const s = useStore.getState();
  const c = v.camera.position;
  const cache = sm.getSplatCache();
  let visible = 0;
  cache.forEach((entry) => { if (entry.mesh.visible) visible += 1; });
  const asset = s.assets[s.currentAssetIndex];
  return {
    idx: s.currentAssetIndex,
    count: s.assets.length,
    isLoading: s.isLoading,
    isCustomModel: s.isCustomModel,
    isMobile: s.isMobile,
    locked: fl.isNavigationLockedRef(),
    controlsEnabled: v.controls.enabled,
    opacity: parseFloat(getComputedStyle(el).opacity),
    mesh: v.currentMesh?.uuid ?? null,
    meshAssetId: v.currentMesh?.userData?.assetId ?? null,
    expectedAssetId: asset?.cacheKey || asset?.baseAssetId || asset?.id,
    cacheSize: cache.size,
    visible,
    cam: [c.x, c.y, c.z],
  };
});

export const jumpTo = (page, index) => page.evaluate((i) => { void window.__probe.fl.loadAssetByIndex(i); }, index);
export const next = (page) => page.evaluate(() => { void window.__probe.fl.loadNextAsset(); });
export const prev = (page) => page.evaluate(() => { void window.__probe.fl.loadPrevAsset(); });

export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

/** Frame pacing summary. Steadiness is the goal, so tails matter more than the mean. */
export const summarizeFrames = ({ samples, longtasks }) => {
  const gaps = samples.slice(1).map((s, i) => s.t - samples[i].t).sort((a, b) => a - b);
  const span = samples.length > 1 ? samples.at(-1).t - samples[0].t : 0;
  return {
    durationMs: Math.round(span),
    frames: samples.length,
    fps: span ? +(((samples.length - 1) / span) * 1000).toFixed(1) : 0,
    p50Ms: Math.round(percentile(gaps, 0.5)),
    p95Ms: Math.round(percentile(gaps, 0.95)),
    maxMs: Math.round(gaps.at(-1) ?? 0),
    over100Ms: gaps.filter((g) => g > 100).length,
    over250Ms: gaps.filter((g) => g > 250).length,
    longTaskTotalMs: Math.round(longtasks.reduce((sum, e) => sum + e.d, 0)),
  };
};

/** Measures render cost: rendering is on demand, so idle frame rate says nothing. */
export const measureForcedRender = (page, ms = 4000) => page.evaluate(async (duration) => {
  const { v, useStore } = window.__probe;
  // The frame gate skips draws, so with it on these rAF gaps would not measure render cost.
  v.setFrameGateEnabled(false);
  const gaps = [];
  const start = performance.now();
  let last = start;
  while (performance.now() - start < duration) {
    v.requestRender();
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }
  v.setFrameGateEnabled(useStore.getState().debugFrameGateEnabled);
  gaps.shift();
  gaps.sort((a, b) => a - b);
  return {
    fps: +((gaps.length / duration) * 1000).toFixed(1),
    p50Ms: Math.round(gaps[gaps.length >> 1]),
    p95Ms: Math.round(gaps[Math.floor(gaps.length * 0.95)]),
    maxMs: Math.round(gaps.at(-1)),
  };
}, ms);

export const getGpu = (page) => page.evaluate(() => {
  const gl = window.__probe.v.renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});

const METRICS = [];
export const recordMetric = (name, value) => METRICS.push([name, value]);

/**
 * Compare with this GPU's stored baseline. Writes one if none exists, or when
 * REGRESS_UPDATE_BASELINE=1. Returns descriptions of large regressions only.
 */
export const compareWithBaseline = (gpu) => {
  const current = Object.fromEntries(METRICS);
  const key = createHash('sha1').update(gpu).digest('hex').slice(0, 10);
  const file = resolve(CACHE_DIR, `baseline-${key}.json`);
  writeFileSync(resolve(CACHE_DIR, 'latest.json'), JSON.stringify({ gpu, ...current }, null, 2));
  console.log(`\nGPU: ${gpu}\n${JSON.stringify(current, null, 2)}`);

  if (process.env.REGRESS_UPDATE_BASELINE === '1' || !existsSync(file)) {
    writeFileSync(file, JSON.stringify({ gpu, ...current }, null, 2));
    console.log(`Baseline written: ${file}`);
    return [];
  }

  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  const failures = [];
  for (const [name, metrics] of Object.entries(current)) {
    const before = baseline[name];
    if (!before) continue;
    for (const field of ['p95Ms', 'maxMs']) {
      // Integrated-GPU timing is noisy, so only a large, absolute slowdown fails.
      if (metrics[field] > before[field] * 1.75 && metrics[field] - before[field] > 100) {
        failures.push(`${name}.${field}: ${before[field]} -> ${metrics[field]}`);
      }
    }
  }
  return failures;
};
