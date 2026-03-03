/**
 * Demo collections flow (modal + install handlers).
 */

import { useCallback, useState } from 'preact/hooks';
import { faFolder, faLeaf, faGamepad, faTreeCity, faCat, faCube } from '@fortawesome/free-solid-svg-icons';
import { getSource } from '../storage/index.js';
import { loadFromStorageSource } from '../fileLoader';
import { importTransferBundle } from '../utils/debugTransfer.js';

const DEMO_COLLECTION_OPTIONS = [
  {
    key: 'street',
    title: 'Street & Travel',
    subtitle: 'Street photography demo collection',
    icon: faTreeCity,
    url: 'https://pub-db16fc5228e844edb71f8282c2992658.r2.dev/demo_street/radia-transfer-demo-street-20260222.zip',
  },
  {
    key: 'plants-hiking',
    title: 'Plants & Hiking',
    subtitle: 'Outdoor photography demo collection',
    icon: faLeaf,
    url: 'https://pub-db16fc5228e844edb71f8282c2992658.r2.dev/demo_nature/radia-transfer-demo-plants-hiking-20260222.zip',
  },
  {
    key: 'people-animals',
    title: 'People & Animals',
    subtitle: 'People and animals demo collection',
    icon: faCat,
    url: 'https://pub-db16fc5228e844edb71f8282c2992658.r2.dev/demo_people/radia-transfer-demo-people-animals-20260218.zip',
  },
  {
    key: 'game-captures',
    title: 'Game Captures',
    subtitle: 'Gameplay screenshot demo collection',
    icon: faGamepad,
    url: 'https://pub-db16fc5228e844edb71f8282c2992658.r2.dev/demo_misc/radia-transfer-screenshots-20260218.zip',
  },
  {
    key: 'multiview-model',
    title: 'Multiview Model',
    subtitle: 'Single model with multiple viewpoints',
    icon: faCube,
    url: 'https://pub-db16fc5228e844edb71f8282c2992658.r2.dev/demo_multiview/radia-transfer-demo-multiview-model-20260224%20(1).zip',
  }
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function useDemoCollections({
  addLog,
  setLandingVisible,
  panelTransitionMs = 350,
} = {}) {
  const [demoCollectionsModalOpen, setDemoCollectionsModalOpen] = useState(false);

  const handleLoadDemo = useCallback(() => {
    setDemoCollectionsModalOpen(true);
  }, []);

  const handleInstallDemoCollections = useCallback(async (selectedKeys = []) => {
    const selected = DEMO_COLLECTION_OPTIONS.filter((option) => selectedKeys.includes(option.key) && option.url);
    if (!selected.length) {
      throw new Error('Select at least one available demo collection.');
    }

    addLog(`[Demo] Installing ${selected.length} collection${selected.length === 1 ? '' : 's'}...`);

    const installTasks = selected.map(async (option) => {
      const response = await fetch(option.url);
      if (!response.ok) {
        throw new Error(`Download failed (${response.status})`);
      }
      const blob = await response.blob();
      const urlParts = option.url.split('/');
      const rawName = urlParts[urlParts.length - 1] || `${option.key}.zip`;
      const fileName = rawName.endsWith('.zip') ? rawName : `${rawName}.zip`;
      const file = new File([blob], fileName, { type: 'application/zip' });
      const { manifest } = await importTransferBundle(file);
      const importedSourceId = manifest?.data?.sources?.[0]?.id || null;
      return {
        key: option.key,
        title: option.title,
        sourceId: importedSourceId,
      };
    });

    const settled = await Promise.allSettled(installTasks);
    const successful = [];
    const failed = [];

    settled.forEach((result, idx) => {
      const option = selected[idx];
      if (result.status === 'fulfilled') {
        successful.push(result.value);
        addLog(`[Demo] Installed ${result.value.title}`);
      } else {
        const message = result.reason?.message || 'Unknown error';
        failed.push({ key: option.key, title: option.title, message });
        addLog(`[Demo] Failed to install ${option.title}: ${message}`);
      }
    });

    if (!successful.length) {
      throw new Error('Failed to install selected demo collections.');
    }

    setLandingVisible(false);
    await delay(panelTransitionMs);

    const openOrder = selectedKeys
      .map((key) => successful.find((item) => item.key === key))
      .filter(Boolean);

    let loadedSource = null;
    for (const item of openOrder) {
      const source = item?.sourceId ? getSource(item.sourceId) : null;
      if (!source) continue;
      try {
        await loadFromStorageSource(source);
        loadedSource = source;
        break;
      } catch (err) {
        addLog(`[Demo] Failed to open ${item.title}: ${err?.message || err}`);
      }
    }

    if (!loadedSource) {
      throw new Error('Installed demo collections, but none could be opened.');
    }

    if (failed.length) {
      addLog(`[Demo] Installed ${successful.length}/${selected.length} selected collections.`);
    }
  }, [addLog, panelTransitionMs, setLandingVisible]);

  return {
    demoCollectionsModalOpen,
    setDemoCollectionsModalOpen,
    handleLoadDemo,
    handleInstallDemoCollections,
    demoCollectionOptions: DEMO_COLLECTION_OPTIONS,
  };
}
