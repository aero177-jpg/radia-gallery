/**
 * Viewer fade helpers for fullscreen and orientation transitions.
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const fadeOutViewer = async (viewerEl, delayMs = 150) => {
  if (!viewerEl) return;
  viewerEl.classList.remove('fs-fade-in');
  viewerEl.classList.add('fs-fade-out');
  await delay(delayMs);
};

export const fadeInViewer = (
  viewerEl,
  { resize, requestRender, settleMs = 500, fadeInMs = 250 } = {}
) => {
  if (!viewerEl) return;
  setTimeout(() => {
    requestAnimationFrame(() => {
      if (resize) resize();
      if (requestRender) requestRender();
      viewerEl.classList.remove('fs-fade-out');
      viewerEl.classList.add('fs-fade-in');
      setTimeout(() => viewerEl.classList.remove('fs-fade-in'), fadeInMs);
    });
  }, settleMs);
};

export const restoreViewerVisibility = (viewerEl, fadeInMs = 250) => {
  if (!viewerEl) return;
  viewerEl.classList.remove('fs-fade-out');
  viewerEl.classList.add('fs-fade-in');
  setTimeout(() => viewerEl.classList.remove('fs-fade-in'), fadeInMs);
};
