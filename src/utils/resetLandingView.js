import { useStore } from '../store.js';
import { resetSplatManager } from '../splatManager.js';
import { clearBackground } from '../backgroundManager.js';
import { requestRender, setCurrentMesh, setOriginalImageAspect } from '../viewer.js';
import { resize } from '../fileLoader.js';

export const resetLandingView = ({ setHasDefaultSource, setLandingVisible, statusMessage } = {}) => {
  const state = useStore.getState();

  state.clearActiveSource();
  state.setAssets([]);
  state.setCurrentAssetIndex(-1);
  state.setFillMode(false);

  resetSplatManager();
  setCurrentMesh(null);
  setOriginalImageAspect(null);
  clearBackground();

  const pageEl = document.querySelector('.page');
  if (pageEl) {
    pageEl.classList.remove('has-glow');
  }

  setHasDefaultSource?.(false);
  setLandingVisible?.(true);

  if (statusMessage) {
    state.setStatus(statusMessage);
  }

  resize();
  requestRender();
};
