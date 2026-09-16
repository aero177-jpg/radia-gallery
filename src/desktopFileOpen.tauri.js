import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

const DESKTOP_FILE_OPEN_EVENT = 'radia://open-files';

export const hasPendingDesktopFileOpen = () => false;

export const subscribeDesktopFileOpenPending = (listener) => {
  listener(false);
  return () => {};
};

const toFile = async (path) => {
  const normalizedPath = String(path || '');
  if (!normalizedPath) return null;

  const info = await invoke('get_splat_file_info', { path: normalizedPath });
  return {
    name: info.name,
    size: info.size,
    lastModified: info.lastModified,
    async openStream() {
      const response = await fetch(convertFileSrc(normalizedPath));
      if (!response.ok || !response.body) {
        throw new Error(`Could not stream ${info.name}`);
      }
      return response.body;
    },
    async arrayBuffer() {
      const response = await fetch(convertFileSrc(normalizedPath));
      if (!response.ok) {
        throw new Error(`Could not open ${info.name}`);
      }
      return response.arrayBuffer();
    },
  };
};

const openPaths = async (paths, onFiles, onOpening) => {
  const files = (await Promise.all((paths || []).map(toFile))).filter(Boolean);
  if (files.length > 0) {
    onOpening();
    await onFiles(files);
  }
};

export const initializeDesktopFileOpen = async (
  onFiles,
  onOpening = () => {},
  onDraggingChange = () => {},
) => {
  const unlisten = await listen(DESKTOP_FILE_OPEN_EVENT, ({ payload }) => {
    void openPaths(payload?.paths, onFiles, onOpening).catch((error) => {
      console.error('[Desktop] Failed to open native file:', error);
    });
  });
  const unlistenDrop = await getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === 'drop') {
      onDraggingChange(false);
      void openPaths(payload.paths, onFiles, onOpening).catch((error) => {
        console.error('[Desktop] Failed to open dropped file:', error);
      });
      return;
    }

    onDraggingChange(payload.type !== 'leave');
  });

  try {
    const paths = await invoke('take_startup_file_paths');
    await openPaths(paths, onFiles, onOpening);
  } catch (error) {
    unlisten();
    unlistenDrop();
    throw error;
  }

  return () => {
    unlisten();
    unlistenDrop();
  };
};