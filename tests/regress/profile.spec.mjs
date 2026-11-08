import { test } from '@playwright/test';
import { DEMOS, cacheDemoAssets, jumpTo, next, openDemo, prev, readState, startRecording, stopRecording, summarizeFrames, waitForNeighbours, waitForSettled } from './helpers.mjs';

// Diagnostic only. Run with REGRESS_PROFILE=1 to attribute stalls during slide changes.
test.skip(!process.env.REGRESS_PROFILE, 'Set REGRESS_PROFILE=1 to run');

const instrument = (page) => page.evaluate(() => {
  const { v } = window.__probe;
  const gl = v.renderer.getContext();
  const totals = {};
  window.__costs = totals;
  const wrap = (obj, name, label = name) => {
    const original = obj[name];
    if (typeof original !== 'function') return;
    obj[name] = function wrapped(...args) {
      const t = performance.now();
      const result = original.apply(this, args);
      const add = () => {
        const d = performance.now() - t;
        const entry = (totals[label] ??= { calls: 0, totalMs: 0, maxMs: 0 });
        entry.calls += 1;
        entry.totalMs += d;
        entry.maxMs = Math.max(entry.maxMs, d);
      };
      if (result?.then) result.then(add, add); else add();
      return result;
    };
  };
  ['readPixels', 'texImage2D', 'texSubImage2D', 'texSubImage3D', 'texImage3D', 'compileShader', 'linkProgram', 'finish'].forEach((n) => wrap(gl, n, `gl.${n}`));
  wrap(v.composer, 'render', 'composer.render (CPU submit)');
  wrap(v.spark, 'update', 'spark.update (async wall time)');
});

const costs = (page) => page.evaluate(() => {
  const out = {};
  for (const [k, e] of Object.entries(window.__costs)) out[k] = { calls: e.calls, totalMs: Math.round(e.totalMs), maxMs: Math.round(e.maxMs) };
  for (const k of Object.keys(window.__costs)) delete window.__costs[k];
  return out;
});

const topSelfTime = (profile, limit = 18) => {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    if (['(idle)', '(root)', '(program)'].includes(f.functionName)) return;
    const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber}`;
    self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0));
  });
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, us]) => `${Math.round(us / 1000)}ms  ${k}`);
};

test('profile a preloaded and an uncached slide change', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  await instrument(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });

  const run = async (label, action) => {
    await costs(page);
    await startRecording(page);
    await cdp.send('Profiler.start');
    await action();
    await waitForSettled(page);
    await waitForNeighbours(page);
    const { profile } = await cdp.send('Profiler.stop');
    const recording = await stopRecording(page);
    const longestFrames = recording.samples.slice(1)
      .map((s, i) => ({ atMs: Math.round(s.t - recording.samples[0].t), gapMs: Math.round(s.t - recording.samples[i].t), out: s.out, in: s.in, loading: s.loading, opacity: +s.opacity.toFixed(2) }))
      .sort((a, b) => b.gapMs - a.gapMs).slice(0, 8).sort((a, b) => a.atMs - b.atMs);
    console.log(JSON.stringify({ label, frames: summarizeFrames(recording), costs: await costs(page), longestFrames, longtasks: recording.longtasks.map((t) => Math.round(t.d)) }, null, 1));
    console.log(topSelfTime(profile).join('\n'));
  };

  await run('preloaded next', () => next(page));
  const { idx, count } = await readState(page);
  await run('uncached jump', () => jumpTo(page, (idx + Math.floor(count / 2)) % count));
});

test('isolate which engine stage produces slow frames', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  const result = await page.evaluate(async () => {
    const { v } = window.__probe;
    const measure = async (ms = 4000) => {
      const gaps = [];
      const start = performance.now();
      let last = start;
      while (performance.now() - start < ms) {
        v.requestRender();
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        gaps.push(Math.round(now - last));
        last = now;
      }
      const series = gaps.slice(1, 37).join(' ');
      const sorted = gaps.slice(1).sort((a, b) => a - b);
      return { frames: sorted.length, p50: sorted[sorted.length >> 1], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1), series };
    };
    const out = {};
    out.default1 = await measure();
    const auto = v.spark.autoUpdate;
    v.spark.autoUpdate = false;
    out.sparkAutoUpdateOff = await measure();
    v.spark.autoUpdate = auto;
    const composerRender = v.composer.render;
    v.composer.render = () => v.renderer.render(v.scene, v.camera);
    out.noComposer = await measure();
    delete v.composer.render;
    if (composerRender !== v.composer.render) v.composer.render = composerRender;
    out.default2 = await measure();
    return out;
  });
  console.log(JSON.stringify(result, null, 1));
});

test('compare manual and controlled camera motion', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.fullScene);
  await page.evaluate(() => {
    const { v } = window.__probe;
    const original = v.composer.render;
    window.__renders = [];
    v.composer.render = function wrapped(...args) {
      const c = v.camera.position;
      window.__renders.push({ t: performance.now(), cam: [c.x, c.y, c.z], dist: c.distanceTo(v.controls.target) });
      return original.apply(this, args);
    };
  });

  const measure = async (label, action) => {
    await waitForSettled(page);
    await page.evaluate(() => { window.__renders.length = 0; });
    await action();
    const stats = await page.evaluate(() => {
      const all = window.__renders.slice();
      // Keep only frames where the camera actually moved, trimming ease-in and ease-out.
      const moved = all.filter((r, i) => i && Math.hypot(r.cam[0] - all[i - 1].cam[0], r.cam[1] - all[i - 1].cam[1], r.cam[2] - all[i - 1].cam[2]) > 1e-5);
      const trim = Math.floor(moved.length * 0.1);
      const core = moved.slice(trim, moved.length - trim);
      const gaps = core.slice(1).map((r, i) => r.t - core[i].t).sort((a, b) => a - b);
      const q = (p) => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] ?? 0);
      const span = core.length > 1 ? core.at(-1).t - core[0].t : 0;
      const steps = core.slice(1).map((r, i) => (Math.hypot(r.cam[0] - core[i].cam[0], r.cam[1] - core[i].cam[1], r.cam[2] - core[i].cam[2]) / Math.max(r.dist, 1e-3)) * 57.3).sort((a, b) => a - b);
      const sq = (p) => +(steps[Math.min(steps.length - 1, Math.floor(steps.length * p))] ?? 0).toFixed(2);
      return { stepDegP50: sq(0.5), stepDegP95: sq(0.95), rendersWhileMoving: core.length, fps: span ? +(((core.length - 1) / span) * 1000).toFixed(1) : 0, p50Ms: q(0.5), p95Ms: q(0.95), maxMs: Math.round(gaps.at(-1) ?? 0), over100: gaps.filter((g) => g > 100).length };
    });
    console.log(label.padEnd(34), JSON.stringify(stats));
  };

  const manual = async () => {
    await page.mouse.move(640, 400);
    await page.mouse.down();
    for (let i = 0; i < 120; i += 1) {
      await page.mouse.move(640 + i * 1.5, 400 + Math.sin(i / 15) * 15);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  };
  const scripted = () => page.evaluate(() => new Promise((resolve) => {
    const { v } = window.__probe;
    const start = performance.now();
    const offset = v.camera.position.clone().sub(v.controls.target);
    const axis = v.camera.up.clone().normalize();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / 2000);
      v.camera.position.copy(v.controls.target).add(offset.clone().applyAxisAngle(axis, k * 0.5));
      v.controls.update();
      v.requestRender();
      if (k < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  }));
  let forward = true;
  const glide = async () => {
    if (forward) await next(page); else await prev(page);
    forward = !forward;
    await waitForSettled(page);
  };
  const setBackground = (visible) => page.evaluate((on) => {
    document.getElementById('__nobg')?.remove();
    if (on) return;
    const s = document.createElement('style');
    s.id = '__nobg';
    s.textContent = '.bg-image-container{display:none!important}';
    document.head.appendChild(s);
  }, visible);

  for (let round = 1; round <= 2; round += 1) {
    await measure(`manual drag #${round}`, manual);
    await measure(`scripted orbit, no CSS #${round}`, scripted);
    await measure(`keyframe glide #${round}`, glide);
    await setBackground(false);
    await measure(`glide, background off #${round}`, glide);
    await measure(`manual, background off #${round}`, manual);
    await setBackground(true);
  }
});

test('measure resolution and splat quality during motion', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.fullScene);
  const results = await page.evaluate(async () => {
    const { v } = window.__probe;
    const original = v.composer.render;
    let renders = [];
    v.composer.render = function wrapped(...args) { renders.push(performance.now()); return original.apply(this, args); };
    const orbit = () => new Promise((resolve) => {
      const start = performance.now();
      const offset = v.camera.position.clone().sub(v.controls.target);
      const axis = v.camera.up.clone().normalize();
      const step = () => {
        const k = Math.min(1, (performance.now() - start) / 4000);
        v.camera.position.copy(v.controls.target).add(offset.clone().applyAxisAngle(axis, Math.sin(k * Math.PI * 2) * 0.2));
        v.controls.update();
        v.requestRender();
        if (k < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    const basePr = v.renderer.getPixelRatio();
    const baseStd = v.spark.maxStdDev;
    const apply = (scale, std) => {
      v.renderer.setPixelRatio(basePr * scale);
      v.composer.setPixelRatio(basePr * scale);
      v.spark.maxStdDev = std;
    };
    const run = async (label, scale, std) => {
      apply(scale, std);
      await new Promise((r) => setTimeout(r, 400));
      renders = [];
      await orbit();
      const gaps = renders.slice(1).map((t, i) => t - renders[i]).sort((a, b) => a - b);
      const q = (p) => Math.round(gaps[Math.floor(gaps.length * p)] ?? 0);
      return `${label.padEnd(34)} fps ${(gaps.length / 4).toFixed(1).padStart(5)}  p50 ${q(0.5)}ms  p95 ${q(0.95)}ms  over100 ${gaps.filter((g) => g > 100).length}`;
    };
    const lines = [];
    for (let round = 1; round <= 2; round += 1) {
      lines.push(await run(`full res, std ${baseStd.toFixed(2)}`, 1, baseStd));
      lines.push(await run('75% res', 0.75, baseStd));
      lines.push(await run('50% res', 0.5, baseStd));
      lines.push(await run('full res, std 1.5', 1, 1.5));
      lines.push(await run('full res, std 1.0', 1, 1.0));
      lines.push(await run('75% res, std 1.5', 0.75, 1.5));
    }
    apply(1, baseStd);
    return lines;
  });
  console.log(results.join('\n'));
});

test('image handoff timeline by phase', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  await page.evaluate(async () => {
    const probe = window.__probe;
    const { v, el } = probe;
    probe.ss = await import('/src/slideshowController.js');
    const original = v.composer.render;
    probe.renders = [];
    v.composer.render = function wrapped(...args) {
      if (probe.rec) probe.renders.push({ t: performance.now(), cam: v.camera.position.toArray(), dist: v.camera.position.distanceTo(v.controls.target) });
      return original.apply(this, args);
    };
    void el;
  });

  const report = (label, r) => {
    const phaseOf = (s, moving) => {
      if (s.opacity < 0.05) return '2 hidden';
      if (s.out) return '1 fade-out';
      if (s.opacity < 0.99 || s.in) return '3 fade-in';
      return moving ? '4 full, moving' : '5 full, still';
    };
    const camMoved = (a, b) => Math.hypot(a.cam[0] - b.cam[0], a.cam[1] - b.cam[1], a.cam[2] - b.cam[2]) > 1e-5;
    const phases = {};
    r.samples.forEach((s, i) => {
      if (!i) return;
      const p = phaseOf(s, camMoved(s, r.samples[i - 1]));
      (phases[p] ??= { gaps: [], steps: [], renders: 0, longMs: 0 }).gaps.push(s.t - r.samples[i - 1].t);
    });
    const sampleAt = (t) => { let lo = 0, hi = r.samples.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (r.samples[m].t < t) lo = m + 1; else hi = m; } return lo; };
    r.renders.forEach((x, i) => {
      if (!i) return;
      const at = sampleAt(x.t);
      const p = phaseOf(r.samples[at], at && camMoved(r.samples[at], r.samples[at - 1]));
      const entry = phases[p]; if (!entry) return;
      entry.renders += 1;
      const prev = r.renders[i - 1];
      entry.steps.push((Math.hypot(x.cam[0] - prev.cam[0], x.cam[1] - prev.cam[1], x.cam[2] - prev.cam[2]) / Math.max(x.dist, 1e-3)) * 57.3);
    });
    r.longtasks.forEach((t) => { const p = phaseOf(r.samples[sampleAt(t.t)], false); if (phases[p]) phases[p].longMs += t.d; });
    console.log(`\n== ${label} (${Math.round(r.samples.at(-1).t - r.samples[0].t)}ms)`);
    for (const [name, e] of Object.entries(phases).sort()) {
      const g = e.gaps.slice().sort((a, b) => a - b), st = e.steps.slice().sort((a, b) => a - b);
      const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0;
      console.log(`${name.padEnd(16)} time ${String(Math.round(g.reduce((a, b) => a + b, 0))).padStart(6)}ms  renders ${String(e.renders).padStart(4)}  gap p50 ${String(Math.round(q(g, 0.5))).padStart(3)} p95 ${String(Math.round(q(g, 0.95))).padStart(4)} max ${String(Math.round(g.at(-1) ?? 0)).padStart(4)}  >100ms ${String(g.filter((x) => x > 100).length).padStart(3)}  longTask ${String(Math.round(e.longMs)).padStart(5)}ms  step p50 ${q(st, 0.5).toFixed(2)} p95 ${q(st, 0.95).toFixed(2)}`);
    }
  };

  const capture = async (label, action) => {
    await page.evaluate(() => { window.__probe.renders = []; });
    await startRecording(page);
    await action();
    const r = await stopRecording(page);
    r.renders = await page.evaluate(() => window.__probe.renders);
    report(label, r);
  };

  const playFor = (ms, continuous) => async () => {
    await page.evaluate((c) => {
      const { useStore, ss } = window.__probe;
      useStore.getState().setSlideshowContinuousMode(c);
      ss.startSlideshow();
    }, continuous);
    await page.waitForTimeout(ms);
    await page.evaluate(() => window.__probe.ss.stopSlideshow());
  };

  await capture('manual next x3', async () => {
    for (let i = 0; i < 3; i += 1) {
      await next(page);
      await waitForSettled(page);
      await waitForNeighbours(page);
    }
  });
  await waitForSettled(page);
  await capture('slideshow, continuous (default)', playFor(24000, true));
  await waitForSettled(page);
  await waitForNeighbours(page);
  await capture('slideshow, non-continuous', playFor(24000, false));
});

test('attribute main-thread work while the image is visible', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  await page.evaluate(async () => { window.__probe.ss = await import('/src/slideshowController.js'); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });

  await startRecording(page);
  const t0 = await page.evaluate(() => performance.now());
  await cdp.send('Profiler.start');
  await page.evaluate(() => window.__probe.ss.startSlideshow());
  await page.waitForTimeout(24000);
  await page.evaluate(() => window.__probe.ss.stopSlideshow());
  const { profile } = await cdp.send('Profiler.stop');
  const { samples } = await stopRecording(page);

  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  profile.nodes.forEach((n) => (n.children || []).forEach((c) => parent.set(c, n.id)));
  const opacityAt = (t) => { let lo = 0, hi = samples.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (samples[m].t < t) lo = m + 1; else hi = m; } return samples[lo].opacity; };
  const name = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop().split('?')[0]}:${n.callFrame.lineNumber}`;

  const self = new Map();
  const appCaller = new Map();
  let t = t0;
  let visibleBusy = 0;
  profile.samples.forEach((id, i) => {
    const dMs = (profile.timeDeltas[i] || 0) / 1000;
    t += dMs;
    const n = byId.get(id);
    if (['(idle)', '(root)', '(program)'].includes(n.callFrame.functionName)) return;
    if (opacityAt(t) < 0.05) return;
    visibleBusy += dMs;
    self.set(name(n), (self.get(name(n)) || 0) + dMs);
    let cursor = n;
    let label = '(no app frame)';
    while (cursor) {
      if (/\/src\//.test(cursor.callFrame.url)) { label = name(cursor); break; }
      cursor = byId.get(parent.get(cursor.id));
    }
    appCaller.set(label, (appCaller.get(label) || 0) + dMs);
  });
  const top = (m, k = 16) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, ms]) => `${String(Math.round(ms)).padStart(6)}ms  ${key}`).join('\n');
  console.log(`VISIBLE main-thread busy: ${Math.round(visibleBusy)}ms\n--SELF\n${top(self)}\n--APP CALLER\n${top(appCaller)}`);
});

test('ab test readback and error checks during playback', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  const base = await page.evaluate(async () => {
    const probe = window.__probe;
    probe.ss = await import('/src/slideshowController.js');
    const gl = probe.v.renderer.getContext();
    probe.realGetError = gl.getError.bind(gl);
    probe.gl = gl;
    return probe.v.spark.minSortIntervalMs;
  });
  console.log(`default minSortIntervalMs: ${base}`);

  const variant = async (label, { noGetError = false, sortMs = base }) => {
    await waitForSettled(page);
    await waitForNeighbours(page);
    await page.evaluate(({ off, ms }) => {
      const { v, gl, realGetError } = window.__probe;
      gl.getError = off ? () => 0 : realGetError;
      v.spark.minSortIntervalMs = ms;
    }, { off: noGetError, ms: sortMs });
    await startRecording(page);
    await page.evaluate(() => window.__probe.ss.startSlideshow());
    await page.waitForTimeout(24000);
    await page.evaluate(() => window.__probe.ss.stopSlideshow());
    const { samples, longtasks } = await stopRecording(page);
    const visible = samples.slice(1).map((s, i) => ({ op: s.opacity, gap: s.t - samples[i].t, t: s.t })).filter((x) => x.op >= 0.05);
    const gaps = visible.map((x) => x.gap).sort((a, b) => a - b);
    const q = (p) => Math.round(gaps[Math.floor(gaps.length * p)]);
    const span = visible.reduce((a, x) => a + x.gap, 0);
    const longVisible = longtasks.filter((t) => { const s = samples.find((x) => x.t >= t.t); return s && s.opacity >= 0.05; }).reduce((a, t) => a + t.d, 0);
    console.log(`${label.padEnd(30)} p95 ${String(q(0.95)).padStart(4)}  p99 ${String(q(0.99)).padStart(4)}  max ${String(Math.round(gaps.at(-1))).padStart(4)}  >100ms/10s ${(gaps.filter((g) => g > 100).length / span * 10000).toFixed(1).padStart(5)}  >200ms ${String(gaps.filter((g) => g > 200).length).padStart(3)}  longTask visible ${String(Math.round(longVisible)).padStart(5)}ms`);
  };

  for (let round = 1; round <= 2; round += 1) {
    await variant(`#${round} default`, {});
    await variant(`#${round} no getError`, { noGetError: true });
    await variant(`#${round} sort every 250ms`, { sortMs: 250 });
    await variant(`#${round} no getError + sort 250`, { noGetError: true, sortMs: 250 });
  }
});

test('tradeoff freezes and neighbour readiness', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  await page.evaluate(async () => { window.__probe.ss = await import('/src/slideshowController.js'); });

  const run = async (label, continuous, seconds) => {
    await waitForSettled(page);
    await waitForNeighbours(page);
    await page.evaluate(({ c, d }) => {
      const { useStore, ss } = window.__probe;
      useStore.getState().setSlideshowContinuousMode(c);
      useStore.getState().setSlideshowDuration(d);
      ss.startSlideshow();
    }, { c: continuous, d: seconds });
    await startRecording(page);
    await page.waitForTimeout(24000);
    const { samples } = await stopRecording(page);
    await page.evaluate(() => window.__probe.ss.stopSlideshow());

    const swaps = [];
    let loadingSpans = 0;
    samples.forEach((s, i) => {
      if (!i) return;
      if (s.mesh !== samples[i - 1].mesh) swaps.push(s.t);
      if (s.loading && !samples[i - 1].loading) loadingSpans += 1;
    });
    const hiddenSpans = [];
    let hiddenStart = null;
    samples.forEach((s) => {
      if (s.opacity < 0.05) { hiddenStart ??= s.t; } else if (hiddenStart !== null) { hiddenSpans.push(s.t - hiddenStart); hiddenStart = null; }
    });
    const hiddenAvg = hiddenSpans.length ? Math.round(hiddenSpans.reduce((x, y) => x + y, 0) / hiddenSpans.length) : 0;
    const visible = samples.slice(1).map((s, i) => ({ s, gap: s.t - samples[i].t })).filter((x) => x.s.opacity >= 0.05);
    const gaps = visible.map((x) => x.gap).sort((a, b) => a - b);
    const freezes = visible.filter((x) => x.gap > 200).map((x) => {
      const since = swaps.filter((t) => t <= x.s.t).at(-1);
      return `${since === undefined ? '?' : Math.round(x.s.t - since)}ms/${Math.round(x.gap)}`;
    });
    console.log(`${label.padEnd(26)} hiddenAvg ${String(hiddenAvg).padStart(4)}ms  swaps ${String(swaps.length).padStart(2)}  uncachedLoads ${String(loadingSpans).padStart(2)}  p95 ${String(Math.round(gaps[Math.floor(gaps.length * 0.95)])).padStart(3)}  max ${String(Math.round(gaps.at(-1))).padStart(4)}  >200ms ${String(freezes.length).padStart(2)}  [afterSwap/gap] ${freezes.join(' ')}`);
  };

  for (let round = 1; round <= 2; round += 1) {
    await run(`#${round} continuous 3s`, true, 3);
    await run(`#${round} non-continuous 3s`, false, 3);
    await run(`#${round} continuous 1s`, true, 1);
  }
});

test('what runs inside tradeoff freezes', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  await page.evaluate(async () => {
    const probe = window.__probe;
    probe.ss = await import('/src/slideshowController.js');
    const { useStore, ss } = probe;
    useStore.getState().setSlideshowContinuousMode(true);
    useStore.getState().setSlideshowDuration(3);
    void ss;
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await startRecording(page);
  const t0 = await page.evaluate(() => performance.now());
  await cdp.send('Profiler.start');
  await page.evaluate(() => window.__probe.ss.startSlideshow());
  await page.waitForTimeout(24000);
  await page.evaluate(() => window.__probe.ss.stopSlideshow());
  const { profile } = await cdp.send('Profiler.stop');
  const { samples } = await stopRecording(page);

  const windows = [];
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].t - samples[i - 1].t > 200 && samples[i].opacity >= 0.05) windows.push([samples[i - 1].t, samples[i].t]);
  }
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  profile.nodes.forEach((n) => (n.children || []).forEach((c) => parent.set(c, n.id)));
  const label = (n) => `${n.callFrame.functionName || '(anon)'}@${n.callFrame.url.split('/').pop().split('?')[0]}:${n.callFrame.lineNumber}`;
  const stacks = new Map();
  let idle = 0; let total = 0; let t = t0;
  profile.samples.forEach((id, i) => {
    const d = (profile.timeDeltas[i] || 0) / 1000;
    t += d;
    if (!windows.some(([a, b]) => t >= a && t <= b)) return;
    total += d;
    const n = byId.get(id);
    if (['(idle)', '(program)', '(root)'].includes(n.callFrame.functionName)) { idle += d; return; }
    const chain = [];
    let cursor = n;
    while (cursor && chain.length < 7) {
      if (cursor.callFrame.functionName !== '(root)') chain.push(label(cursor));
      cursor = byId.get(parent.get(cursor.id));
    }
    const key = chain.join(' < ');
    stacks.set(key, (stacks.get(key) || 0) + d);
  });
  console.log(`FREEZE windows: ${windows.map(([a, b]) => Math.round(b - a)).join(', ')}; total ${Math.round(total)}ms, idle/program ${Math.round(idle)}ms`);
  console.log([...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, ms]) => `STACK ${Math.round(ms)}ms  ${k}`).join('\n'));
});

test('trace browser and GPU during tradeoff freezes', async ({ page, context, browser }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  await page.evaluate(async () => {
    const probe = window.__probe;
    probe.ss = await import('/src/slideshowController.js');
    probe.useStore.getState().setSlideshowContinuousMode(true);
    probe.useStore.getState().setSlideshowDuration(3);
  });

  const freezesOf = (samples) => {
    const out = [];
    for (let i = 1; i < samples.length; i += 1) {
      if (samples[i].t - samples[i - 1].t > 200 && samples[i].opacity >= 0.05) out.push([samples[i - 1].t, samples[i].t]);
    }
    return out;
  };
  const play = async (ms = 24000) => {
    await startRecording(page);
    await page.evaluate(() => window.__probe.ss.startSlideshow());
    await page.waitForTimeout(ms);
    await page.evaluate(() => window.__probe.ss.stopSlideshow());
    return (await stopRecording(page)).samples;
  };

  await browser.startTracing(page, {
    categories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'cc', 'viz', 'gpu', 'gpu.service', 'gpu.decoder', 'gpu.angle', 'disabled-by-default-gpu.service', 'disabled-by-default-gpu.decoder', '__metadata'],
  });
  const t0 = await page.evaluate(() => { performance.mark('__regressT0'); return performance.now(); });
  const samples = await play();
  const trace = JSON.parse((await browser.stopTracing()).toString('utf8'));

  const windows = freezesOf(samples);
  const events = trace.traceEvents;
  const mark = events.find((e) => e.name === '__regressT0');
  const toTraceUs = (ms) => mark.ts + (ms - t0) * 1000;
  const names = new Map();
  const procs = new Map();
  events.forEach((e) => {
    if (e.ph !== 'M') return;
    if (e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
    if (e.name === 'process_name') procs.set(e.pid, e.args.name);
  });
  const threadOf = (e) => `${procs.get(e.pid) || e.pid}/${names.get(`${e.pid}:${e.tid}`) || e.tid}`;

  console.log(`TRACE freezes ${windows.map(([a, b]) => Math.round(b - a)).join(', ')}; events ${events.length}`);
  windows.slice(0, 4).forEach(([a, b], w) => {
    const start = toTraceUs(a);
    const end = toTraceUs(b);
    const hits = events
      .filter((e) => e.ph === 'X' && e.dur && e.ts < end && e.ts + e.dur > start)
      .map((e) => ({ overlap: (Math.min(end, e.ts + e.dur) - Math.max(start, e.ts)) / 1000, name: e.name, thread: threadOf(e) }))
      .filter((h) => h.overlap >= 40)
      .sort((x, y) => y.overlap - x.overlap);
    const seen = new Set();
    const lines = [];
    for (const h of hits) {
      const key = `${h.thread}|${h.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${String(Math.round(h.overlap)).padStart(5)}ms  ${h.thread}  ${h.name}`);
      if (lines.length >= 16) break;
    }
    console.log(`TRACE window ${w} (${Math.round(b - a)}ms)\n${lines.join('\n')}`);
  });

  const summarize = (label, s) => {
    const f = freezesOf(s).map(([a, b]) => Math.round(b - a));
    console.log(`GLOW ${label.padEnd(12)} freezes ${f.length}  [${f.join(' ')}]`);
  };
  const glow = (on) => page.evaluate((v) => {
    document.getElementById('__nobg')?.remove();
    if (v) return;
    const s = document.createElement('style');
    s.id = '__nobg';
    s.textContent = '.bg-image-container{display:none!important}';
    document.head.appendChild(s);
  }, on);
  for (let round = 1; round <= 2; round += 1) {
    await waitForSettled(page);
    await waitForNeighbours(page);
    await glow(true);
    summarize(`on #${round}`, await play());
    await waitForSettled(page);
    await waitForNeighbours(page);
    await glow(false);
    summarize(`off #${round}`, await play());
  }
  await glow(true);
});

test('correlate freezes with neighbour arrival and GPU uploads', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  await page.evaluate(async () => {
    const probe = window.__probe;
    probe.ss = await import('/src/slideshowController.js');
    probe.useStore.getState().setSlideshowContinuousMode(true);
    probe.useStore.getState().setSlideshowDuration(3);
    const gl = probe.v.renderer.getContext();
    probe.uploads = [];
    for (const name of ['texImage3D', 'texSubImage3D', 'texStorage3D']) {
      const original = gl[name].bind(gl);
      gl[name] = (...args) => {
        if (probe.rec) probe.uploads.push({ t: performance.now(), name, w: args[name === 'texStorage3D' ? 2 : name === 'texImage3D' ? 3 : 5], h: args[name === 'texStorage3D' ? 3 : name === 'texImage3D' ? 4 : 6], d: args[name === 'texStorage3D' ? 4 : name === 'texImage3D' ? 5 : 7] });
        return original(...args);
      };
    }
    probe.arrivals = [];
    const known = new Set(probe.sm.getSplatCache().keys());
    const watch = () => {
      probe.sm.getSplatCache().forEach((_, key) => {
        if (!known.has(key)) { known.add(key); if (probe.rec) probe.arrivals.push(performance.now()); }
      });
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await startRecording(page);
  await page.evaluate(() => window.__probe.ss.startSlideshow());
  await page.waitForTimeout(30000);
  await page.evaluate(() => window.__probe.ss.stopSlideshow());
  const { samples } = await stopRecording(page);
  const { uploads, arrivals } = await page.evaluate(() => ({ uploads: window.__probe.uploads, arrivals: window.__probe.arrivals }));
  const last = (arr, t) => arr.filter((x) => x <= t).at(-1);
  const swaps = samples.filter((s, i) => i && s.mesh !== samples[i - 1].mesh).map((s) => s.t);
  console.log(`CORR arrivals ${arrivals.length}, swaps ${swaps.length}, uploads ${uploads.length}: ${[...new Set(uploads.map((u) => `${u.name} ${u.w}x${u.h}x${u.d}`))].slice(0, 6).join(' | ')}`);
  for (let i = 1; i < samples.length; i += 1) {
    const gap = samples[i].t - samples[i - 1].t;
    if (gap <= 200 || samples[i].opacity < 0.05) continue;
    const start = samples[i - 1].t;
    const a = last(arrivals, samples[i].t);
    const u = last(uploads.map((x) => x.t), samples[i].t);
    const s = last(swaps, start);
    console.log(`CORR freeze ${Math.round(gap)}ms: ${s === undefined ? '?' : Math.round(start - s)}ms after swap, ${a === undefined ? '?' : Math.round(start - a)}ms after neighbour arrived, ${u === undefined ? '?' : Math.round(start - u)}ms after 3D upload`);
  }
});

test('frame gate on and off during playback', async ({ page, context }) => {
  test.setTimeout(900_000);
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  await page.evaluate(async () => {
    const probe = window.__probe;
    probe.ss = await import('/src/slideshowController.js');
    const { composer, renderer, camera } = probe.v;
    const realRender = composer.render.bind(composer);
    probe.frames = [];
    probe.frameRec = false;
    composer.render = (...args) => {
      const out = realRender(...args);
      if (!probe.frameRec) return out;
      const gl = renderer.getContext();
      const frame = {
        t: performance.now(),
        pos: camera.position.toArray(),
        mesh: probe.v.currentMesh?.uuid ?? null,
        op: parseFloat(getComputedStyle(probe.el).opacity),
        gpuMs: null,
      };
      probe.frames.push(frame);
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      const poll = () => {
        if (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) { setTimeout(poll, 0); return; }
        frame.gpuMs = performance.now() - frame.t;
        gl.deleteSync(fence);
      };
      setTimeout(poll, 0);
      return out;
    };
  });

  const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const run = async (label, gate, continuous) => {
    await waitForSettled(page);
    await waitForNeighbours(page);
    await page.evaluate(({ g, c }) => {
      const probe = window.__probe;
      probe.v.setFrameGateEnabled(g);
      probe.useStore.getState().setSlideshowContinuousMode(c);
      probe.useStore.getState().setSlideshowDuration(3);
      probe.frames = [];
      probe.frameRec = true;
      probe.ss.startSlideshow();
    }, { g: gate, c: continuous });
    await page.waitForTimeout(24000);
    await page.evaluate(() => { window.__probe.frameRec = false; window.__probe.ss.stopSlideshow(); });
    await page.waitForTimeout(1500);
    const frames = await page.evaluate(() => window.__probe.frames);
    const pairs = frames.slice(1).map((f, i) => ({ f, prev: frames[i] })).filter(({ f, prev }) => f.op >= 0.5 && f.mesh === prev.mesh);
    const gaps = pairs.map(({ f, prev }) => f.t - prev.t).sort((a, b) => a - b);
    const steps = pairs.map(({ f, prev }) => Math.hypot(f.pos[0] - prev.pos[0], f.pos[1] - prev.pos[1], f.pos[2] - prev.pos[2])).filter((s) => s > 1e-6).sort((a, b) => a - b);
    const gpu = pairs.map(({ f }) => f.gpuMs).filter((v) => v !== null).sort((a, b) => a - b);
    const span = gaps.reduce((a, b) => a + b, 0);
    const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
    const stdev = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / (gaps.length || 1));
    console.log(`GATE ${label.padEnd(30)} fps ${(gaps.length / span * 1000).toFixed(1).padStart(5)}  interval p50 ${q(gaps, 0.5).toFixed(0).padStart(3)} p95 ${q(gaps, 0.95).toFixed(0).padStart(3)} p99 ${q(gaps, 0.99).toFixed(0).padStart(3)} stdev ${stdev.toFixed(1).padStart(5)}  camStep p95/p50 ${(q(steps, 0.95) / (q(steps, 0.5) || 1)).toFixed(2)}  gpuDone p50 ${q(gpu, 0.5).toFixed(0).padStart(3)} p95 ${q(gpu, 0.95).toFixed(0).padStart(3)}`);
  };

  for (let round = 1; round <= 2; round += 1) {
    await run(`#${round} continuous gate off`, false, true);
    await run(`#${round} continuous gate on`, true, true);
    await run(`#${round} non-continuous gate off`, false, false);
    await run(`#${round} non-continuous gate on`, true, false);
  }
  await page.evaluate(() => window.__probe.v.setFrameGateEnabled(false));
});

test('batched splat drawing', async ({ page, context }) => {
  test.setTimeout(900_000);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || /THREE\.WebGLProgram|Shader Error/.test(m.text())) errors.push(m.text().slice(0, 400)); });
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  await page.evaluate(async () => {
    const probe = window.__probe;
    probe.ss = await import('/src/slideshowController.js');
    probe.useStore.getState().setDebugSplatBatchingEnabled(false);
    const { spark, THREE } = probe.v;
    const originalGeometry = spark.geometry;
    const originalShader = spark.material.vertexShader;
    const makeGeometry = (batch) => {
      const positions = new Float32Array(batch * 12);
      const indices = new Uint16Array(batch * 6);
      const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
      const quad = originalGeometry.index.array;
      for (let s = 0; s < batch; s += 1) {
        for (let v = 0; v < 4; v += 1) positions.set([corners[v * 2], corners[v * 2 + 1], s], (s * 4 + v) * 3);
        for (let i = 0; i < 6; i += 1) indices[s * 6 + i] = s * 4 + quad[i];
      }
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      let instances = 0;
      Object.defineProperty(geometry, 'instanceCount', {
        get: () => instances,
        set: (active) => { spark.material.uniforms.batchActiveSplats.value = active; instances = Math.ceil(active / batch); },
      });
      return geometry;
    };
    spark.material.uniforms.batchActiveSplats = { value: 0 };
    const patchedShader = (batch) => originalShader
      .replaceAll('gl_InstanceID', 'batchSplatId')
      .replace('void main() {', `uniform int batchActiveSplats;\nvoid main() {\n    int batchSplatId = gl_InstanceID * ${batch} + int(position.z);\n    if (batchSplatId >= batchActiveSplats) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }`);
    const geometries = new Map();
    probe.setBatch = (batch) => {
      const active = spark.geometry.instanceCount;
      const previousBatch = probe.batch || 1;
      const count = previousBatch === 1 ? active : spark.material.uniforms.batchActiveSplats.value;
      if (batch === 1) {
        spark.geometry = originalGeometry;
        spark.material.vertexShader = originalShader;
      } else {
        if (!geometries.has(batch)) geometries.set(batch, makeGeometry(batch));
        spark.geometry = geometries.get(batch);
        spark.material.vertexShader = patchedShader(batch);
      }
      spark.geometry.instanceCount = count;
      spark.material.needsUpdate = true;
      probe.batch = batch;
      probe.v.requestRender();
    };
    const gl = probe.v.renderer.getContext();
    // One draw, timed from submit to GPU completion. The camera is still, so Spark does not regenerate or sort.
    probe.drawCost = async (frames) => {
      const out = [];
      for (let i = 0; i < frames; i += 1) {
        const t = performance.now();
        probe.v.forceRenderNow();
        const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        await new Promise((resolve) => {
          const poll = () => { if (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) setTimeout(poll, 0); else resolve(); };
          setTimeout(poll, 0);
        });
        gl.deleteSync(fence);
        out.push(performance.now() - t);
      }
      return out.sort((a, b) => a - b)[Math.floor(frames / 2)];
    };
    probe.setScale = (s) => { probe.v.renderer.setPixelRatio(s); probe.v.composer.setPixelRatio(s); };
    // Hash of the rendered canvas, read in the same task as the draw.
    probe.pixels = () => {
      probe.v.forceRenderNow();
      const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
      const data = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return Array.from(data.filter((_, i) => i % 1024 === 0));
    };
    probe.frames = [];
    probe.frameRec = false;
    const { composer, camera } = probe.v;
    const realRender = composer.render.bind(composer);
    composer.render = (...args) => {
      const out = realRender(...args);
      if (probe.frameRec) probe.frames.push({ t: performance.now(), mesh: probe.v.currentMesh?.uuid ?? null, op: parseFloat(getComputedStyle(probe.el).opacity), pos: camera.position.toArray() });
      return out;
    };
  });

  await page.evaluate(() => window.__probe.drawCost(10));
  const splats = await page.evaluate(() => window.__probe.v.spark.activeSplats);
  console.log(`BATCH active splats ${splats}`);
  const drawRow = async (label, batch, scale) => {
    const ms = await page.evaluate(async ({ b, s }) => {
      const p = window.__probe;
      p.setBatch(b);
      p.setScale(s);
      await p.drawCost(8);
      return p.drawCost(40);
    }, { b: batch, s: scale });
    console.log(`BATCH draw ${label.padEnd(30)} median ${ms.toFixed(1)} ms`);
  };
  for (let round = 1; round <= 3; round += 1) {
    for (const scale of [1, 0.25]) {
      await drawRow(`#${round} one per instance @${scale}`, 1, scale);
      await drawRow(`#${round} 128 per instance @${scale}`, 128, scale);
      await drawRow(`#${round} 512 per instance @${scale}`, 512, scale);
    }
  }
  await page.evaluate(() => window.__probe.setScale(1));

  const compare = await page.evaluate(async () => {
    const p = window.__probe;
    p.setBatch(1);
    await p.drawCost(5);
    const a = p.pixels();
    p.setBatch(128);
    await p.drawCost(5);
    const b = p.pixels();
    let sum = 0; let max = 0;
    a.forEach((v, i) => { const d = Math.abs(v - b[i]); sum += d; max = Math.max(max, d); });
    return { samples: a.length, meanDiff: sum / a.length, maxDiff: max, nonBlank: a.filter((v) => v > 0).length };
  });
  console.log(`BATCH image diff ${JSON.stringify(compare)}`);

  const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const play = async (label, batch) => {
    await page.evaluate((b) => window.__probe.setBatch(b), batch);
    await waitForSettled(page);
    await waitForNeighbours(page);
    await page.evaluate(() => {
      const p = window.__probe;
      p.useStore.getState().setSlideshowContinuousMode(true);
      p.useStore.getState().setSlideshowDuration(3);
      p.frames = [];
      p.frameRec = true;
      p.ss.startSlideshow();
    });
    await page.waitForTimeout(20000);
    await page.evaluate(() => { window.__probe.frameRec = false; window.__probe.ss.stopSlideshow(); });
    const frames = await page.evaluate(() => window.__probe.frames);
    const gaps = frames.slice(1).map((f, i) => ({ f, prev: frames[i] })).filter(({ f, prev }) => f.op >= 0.5 && f.mesh === prev.mesh).map(({ f, prev }) => f.t - prev.t).sort((a, b) => a - b);
    const span = gaps.reduce((a, b) => a + b, 0);
    console.log(`BATCH play ${label.padEnd(30)} fps ${(gaps.length / span * 1000).toFixed(1).padStart(5)}  interval p50 ${q(gaps, 0.5).toFixed(0).padStart(3)} p95 ${q(gaps, 0.95).toFixed(0).padStart(3)} p99 ${q(gaps, 0.99).toFixed(0).padStart(3)}`);
  };
  for (let round = 1; round <= 2; round += 1) {
    await play(`#${round} one per instance`, 1);
    await play(`#${round} 128 per instance`, 128);
  }
  await page.evaluate(() => window.__probe.setBatch(1));
  console.log(`BATCH console errors ${errors.length}: ${errors.slice(0, 3).join(' | ')}`);
});

test('cpu depth sort against gpu readback', async ({ page, context }) => {
  test.setTimeout(900_000);
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  const check = () => page.evaluate(async () => {
    const probe = window.__probe;
    probe.cs ??= await import('/src/splatCpuSort.js');
    const { spark, renderer } = probe.v;
    const proto = Object.getPrototypeOf(spark).readbackDepth;
    const current = spark.current;
    const numSplats = current.numSplats;
    const size = Math.ceil(numSplats / 2048) * 2048;
    const gpu = new Uint32Array(size);
    await proto.call(spark, { current, renderer, numSplats, readback: gpu });
    const cpu = new Float32Array(size);
    const usable = await probe.cs.fillCpuDistancesForTest(spark, current, numSplats, cpu);
    if (!usable) return { usable, mapping: current.mapping?.length, hasPacked: !!current.mapping?.[0]?.node?.packedSplats, ext: !!current.mapping?.[0]?.node?.extSplats };
    const g = new Float32Array(gpu.buffer);
    let infMismatch = 0; let compared = 0; let maxAbs = 0; let maxRel = 0; let inactive = 0; let inverted = 0;
    const stride = Math.max(1, Math.floor(numSplats / 200000));
    let prev = null;
    for (let i = 0; i < numSplats; i += 1) {
      const a = g[i]; const b = cpu[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) { if (a !== b) infMismatch += 1; else inactive += 1; continue; }
      compared += 1;
      const d = Math.abs(a - b);
      if (d > maxAbs) maxAbs = d;
      if (d / Math.max(a, 1e-6) > maxRel) maxRel = d / Math.max(a, 1e-6);
      if (i % stride === 0) { if (prev && (prev[0] - a) * (prev[1] - b) < 0 && Math.abs(prev[0] - a) > 1e-3) inverted += 1; prev = [a, b]; }
    }
    const times = [];
    for (let i = 0; i < 25; i += 1) { const t = performance.now(); await probe.cs.fillCpuDistancesForTest(spark, current, numSplats, cpu); times.push(performance.now() - t); }
    times.sort((a, b) => a - b);
    return { usable, numSplats, compared, inactive, infMismatch, maxAbs, maxRel, inverted, fillMedianMs: +times[12].toFixed(2), fillMaxMs: +times[24].toFixed(2) };
  });
  console.log(`CPUSORT compare ${JSON.stringify(await check())}`);
  await next(page); await waitForSettled(page); await waitForNeighbours(page);
  console.log(`CPUSORT compare next image ${JSON.stringify(await check())}`);

  await page.evaluate(async () => {
    const probe = window.__probe;
    probe.ss = await import('/src/slideshowController.js');
    const { composer, renderer, spark } = probe.v;
    const gl = renderer.getContext();
    const realSub = gl.getBufferSubData.bind(gl);
    probe.subMs = 0;
    gl.getBufferSubData = (...args) => { const t = performance.now(); const out = realSub(...args); probe.subMs += performance.now() - t; return out; };
    probe.sorts = 0;
    probe.readMs = 0;
    const realSet = Float32Array.prototype.set;
    Float32Array.prototype.set = function timedSet(...args) {
      if (args[0]?.length < 100000) return realSet.apply(this, args);
      const t = performance.now();
      const out = realSet.apply(this, args);
      probe.readMs += performance.now() - t;
      return out;
    };
    const worker = spark.sortWorker;
    const realCall = worker.call.bind(worker);
    worker.call = (name, ...args) => { if (name === 'sortSplats32') probe.sorts += 1; return realCall(name, ...args); };
    probe.frames = [];
    probe.frameRec = false;
    const realRender = composer.render.bind(composer);
    composer.render = (...args) => {
      const out = realRender(...args);
      if (probe.frameRec) probe.frames.push({ t: performance.now(), mesh: probe.v.currentMesh?.uuid ?? null, op: parseFloat(getComputedStyle(probe.el).opacity) });
      return out;
    };
  });
  const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const play = async (label, cpu, continuous) => {
    await page.evaluate((c) => {
      const p = window.__probe;
      const { spark } = p.v;
      p.cs.setCpuDepthSort(spark, c);
      const inner = spark.readbackDepth;
      spark.readbackDepth = function timedReadback(args) {
        const t = performance.now();
        const out = inner.call(this, args);
        p.readMs += performance.now() - t;
        return out;
      };
    }, cpu);
    await waitForSettled(page);
    await waitForNeighbours(page);
    await page.evaluate((c) => {
      const p = window.__probe;
      p.useStore.getState().setSlideshowContinuousMode(c);
      p.useStore.getState().setSlideshowDuration(3);
      p.frames = []; p.subMs = 0; p.sorts = 0; p.readMs = 0;
      p.frameRec = true;
      p.ss.startSlideshow();
    }, continuous);
    await page.waitForTimeout(22000);
    const { frames, subMs, sorts, readMs } = await page.evaluate(() => { const p = window.__probe; p.frameRec = false; p.ss.stopSlideshow(); return { frames: p.frames, subMs: p.subMs, sorts: p.sorts, readMs: p.readMs }; });
    const all = frames.slice(1).map((f, i) => ({ f, prev: frames[i] }));
    const visible = all.filter(({ f, prev }) => f.op >= 0.5 && f.mesh === prev.mesh).map(({ f, prev }) => f.t - prev.t).sort((a, b) => a - b);
    const span = visible.reduce((a, b) => a + b, 0);
    console.log(`CPUSORT play ${label.padEnd(34)} fps ${(visible.length / span * 1000).toFixed(1).padStart(5)}  interval p50 ${q(visible, 0.5).toFixed(0).padStart(3)} p95 ${q(visible, 0.95).toFixed(0).padStart(3)} p99 ${q(visible, 0.99).toFixed(0).padStart(3)} max ${q(visible, 1).toFixed(0).padStart(4)}  getBufferSubData ${subMs.toFixed(0).padStart(5)}ms  readback call ${readMs.toFixed(0).padStart(5)}ms  sorts ${String(sorts).padStart(4)}`);
  };
  for (let round = 1; round <= 2; round += 1) {
    await play(`#${round} continuous gpu readback`, false, true);
    await play(`#${round} continuous cpu depth`, true, true);
    await play(`#${round} non-continuous gpu readback`, false, false);
    await play(`#${round} non-continuous cpu depth`, true, false);
  }
  await page.evaluate(() => window.__probe.cs.setCpuDepthSort(window.__probe.v.spark, false));
});

test('fade layer variants', async ({ page, context }) => {
  await cacheDemoAssets(context);
  await openDemo(page, DEMOS.image);
  await page.evaluate(async () => {
    const probe = window.__probe;
    probe.ss = await import('/src/slideshowController.js');
    probe.useStore.getState().setSlideshowContinuousMode(true);
    probe.useStore.getState().setSlideshowDuration(3);
  });
  const css = (text) => page.evaluate((t) => {
    document.getElementById('__variant')?.remove();
    if (!t) return;
    const s = document.createElement('style');
    s.id = '__variant';
    s.textContent = t;
    document.head.appendChild(s);
  }, text);
  const run = async (label, text) => {
    await waitForSettled(page);
    await waitForNeighbours(page);
    await css(text);
    await startRecording(page);
    await page.evaluate(() => window.__probe.ss.startSlideshow());
    await page.waitForTimeout(24000);
    await page.evaluate(() => window.__probe.ss.stopSlideshow());
    const { samples } = await stopRecording(page);
    const out = [];
    let lastReveal = null;
    for (let i = 1; i < samples.length; i += 1) {
      const gap = samples[i].t - samples[i - 1].t;
      if (samples[i - 1].opacity < 0.05 && samples[i].opacity >= 0.05) lastReveal = samples[i].t;
      if (gap > 200 && samples[i].opacity >= 0.05) out.push(`${Math.round(gap)}@${lastReveal ? Math.round(samples[i - 1].t - lastReveal) : '?'}/op${samples[i].opacity.toFixed(2)}`);
    }
    console.log(`VARIANT ${label.padEnd(22)} ${String(out.length).padStart(2)} freezes  [gap@afterReveal/opacity] ${out.join(' ')}`);
  };
  const variants = [
    ['default', ''],
    ['never fully zero', '.viewer.slide-out{opacity:.02!important}'],
    ['will-change', '#viewer,#viewer canvas{will-change:opacity}'],
  ];
  for (let round = 1; round <= 2; round += 1) {
    for (const [label, text] of variants) await run(`#${round} ${label}`, text);
  }
  await css('');
});
