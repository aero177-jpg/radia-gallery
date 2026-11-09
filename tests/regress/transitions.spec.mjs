import { expect, test } from '@playwright/test';
import {
  DEMOS,
  cacheDemoAssets,
  compareWithBaseline,
  distance,
  getGpu,
  jumpTo,
  measureForcedRender,
  next,
  openDemo,
  prev,
  readState,
  recordMetric,
  startRecording,
  stopRecording,
  summarizeFrames,
  waitForNeighbours,
  waitForSettled,
} from './helpers.mjs';

// Fully faded is the point of the swap, but CSS fades run independently of JS on a loaded GPU.
const MAX_OPACITY_AT_SWAP = 0.15;
const POSE_EPSILON = 0.01;
const MAX_SINGLE_FRAME_STEP_RATIO = 0.4;

let gpu = 'unknown';

test.beforeEach(async ({ context }) => {
  await cacheDemoAssets(context);
});

const expectHealthyEndState = (state) => {
  expect(state.isLoading, 'still loading').toBe(false);
  expect(state.locked, 'navigation lock leaked').toBe(false);
  expect(state.controlsEnabled, 'controls left disabled').toBe(true);
  expect(state.opacity, 'viewer left faded').toBe(1);
  expect(state.visible, 'exactly one visible mesh').toBe(1);
  expect(state.meshAssetId, 'displayed mesh does not match current asset').toBe(state.expectedAssetId);
  expect(state.cacheSize, 'more splats retained than current + neighbours').toBeLessThanOrEqual(3);
};

test.describe('image (SHARP) mode', () => {
  test('slide advance hides the swap and ends consistent', async ({ page }) => {
    await openDemo(page, DEMOS.image);
    gpu = await getGpu(page);

    const before = await readState(page);
    expect(before.isCustomModel).toBe(false);
    recordMetric('imageForcedRender', await measureForcedRender(page));

    await startRecording(page);
    await next(page);
    await waitForSettled(page);
    await waitForNeighbours(page);
    const recording = await stopRecording(page);
    recordMetric('imageSlideChange', summarizeFrames(recording));
    const { samples } = recording;

    const swapIndex = samples.findIndex((s) => s.mesh !== before.mesh);
    expect(swapIndex, 'mesh never swapped').toBeGreaterThan(0);
    const firstOut = samples.findIndex((s) => s.out);
    const firstIn = samples.findIndex((s, i) => i >= swapIndex && s.in);

    expect(firstOut, 'no slide-out class').toBeGreaterThanOrEqual(0);
    expect(firstOut, 'slide-out must start before the swap').toBeLessThanOrEqual(swapIndex);
    expect(firstIn, 'slide-in must follow the swap').toBeGreaterThanOrEqual(swapIndex);

    // The core of the illusion: nothing on screen when the splat changes.
    expect(samples[swapIndex].opacity, 'mesh swapped while visible').toBeLessThanOrEqual(MAX_OPACITY_AT_SWAP);

    const exposedWithoutMesh = samples.filter((s) => s.opacity > 0.5 && s.visible === 0);
    expect(exposedWithoutMesh.length, 'frames showing an empty viewer').toBe(0);

    const after = await readState(page);
    expect(after.idx).toBe((before.idx + 1) % before.count);
    expectHealthyEndState(after);

    // Nothing near the target is preloaded here, so this is the worst-case stall.
    const target = (after.idx + Math.floor(after.count / 2)) % after.count;
    await startRecording(page);
    await jumpTo(page, target);
    await waitForSettled(page);
    await waitForNeighbours(page);
    recordMetric('imageUncachedJump', summarizeFrames(await stopRecording(page)));
    const jumped = await readState(page);
    expect(jumped.idx).toBe(target);
    expectHealthyEndState(jumped);
  });

  test('rapid next leaves one consistent state', async ({ page }) => {
    await openDemo(page, DEMOS.image);
    for (let i = 0; i < 6; i += 1) {
      await next(page);
      await page.waitForTimeout(120);
    }
    await waitForSettled(page);
    expectHealthyEndState(await readState(page));
  });
});

test.describe('full scene mode (keyframes)', () => {
  test('keyframe glide keeps the mesh and returns to the saved pose', async ({ page }) => {
    await openDemo(page, DEMOS.fullScene);

    const start = await readState(page);
    expect(start.isCustomModel).toBe(true);
    expect(start.count).toBeGreaterThan(1);
    recordMetric('sceneForcedRender', await measureForcedRender(page));

    await startRecording(page);
    await next(page);
    await waitForSettled(page);
    const recording = await stopRecording(page);
    recordMetric('sceneKeyframeGlide', summarizeFrames(recording));
    const { samples } = recording;

    const middle = await readState(page);
    expect(middle.idx).toBe(start.idx + 1);
    expect(middle.mesh, 'keyframe navigation reloaded the splat').toBe(start.mesh);
    expect(samples.some((s) => s.loading), 'keyframe navigation showed loading').toBe(false);

    const travel = distance(start.cam, middle.cam);
    expect(travel, 'camera did not move to the next keyframe').toBeGreaterThan(POSE_EPSILON);
    let largestStep = 0;
    for (let i = 1; i < samples.length; i += 1) {
      largestStep = Math.max(largestStep, distance(samples[i - 1].cam, samples[i].cam));
    }
    expect(largestStep / travel, 'camera jumped during the glide').toBeLessThan(MAX_SINGLE_FRAME_STEP_RATIO);
    expectHealthyEndState(middle);

    await prev(page);
    await waitForSettled(page);
    const back = await readState(page);
    expect(back.idx).toBe(start.idx);
    expect(distance(back.cam, start.cam), 'did not return to saved pose').toBeLessThan(POSE_EPSILON);
  });

  test('rapid next does not lock the camera', async ({ page }) => {
    await openDemo(page, DEMOS.fullScene);
    const { mesh } = await readState(page);
    for (let i = 0; i < 6; i += 1) {
      await next(page);
      await page.waitForTimeout(120);
    }
    await waitForSettled(page);
    const state = await readState(page);
    expect(state.mesh).toBe(mesh);
    expectHealthyEndState(state);
  });
});

test.describe('phone-sized viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  // Checks layout and mobile code paths only. It says nothing about real phone GPU performance.
  test('mobile state applies and a slide advance works', async ({ page }) => {
    await openDemo(page, DEMOS.image);
    const before = await readState(page);
    expect(before.isMobile).toBe(true);
    await next(page);
    await waitForSettled(page);
    const after = await readState(page);
    expect(after.idx).toBe((before.idx + 1) % before.count);
    expectHealthyEndState(after);
  });
});

test.afterAll(() => {
  const failures = compareWithBaseline(gpu);
  expect(failures, 'large performance regressions against baseline').toEqual([]);
});
