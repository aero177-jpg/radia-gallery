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
