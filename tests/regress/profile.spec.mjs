import { test } from '@playwright/test';
import { DEMOS, cacheDemoAssets, jumpTo, next, openDemo, readState, startRecording, stopRecording, summarizeFrames, waitForNeighbours, waitForSettled } from './helpers.mjs';

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
