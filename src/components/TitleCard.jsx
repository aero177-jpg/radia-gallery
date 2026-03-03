/**
 * Landing title card overlay for loading assets.
 * Sits above the app layout and handles file/storage/demo actions.
 */
import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import { useStore } from '../store';
import FrostedTitle from './FrostedTitle';
import { testSharpCloud } from '../testSharpCloud';
import { FolderIcon, ServerIcon, RocketIcon, CollectionIcon, FolderOpenIcon } from '../icons/customIcons';
import { getSourcesArray, onSourceChange } from '../storage/index.js';
import StorageSourceList from './StorageSourceList';
import Modal from './Modal';
import { DemoCollectionsPage } from './AddDemoCollectionsModal';

function TitleCard({
  show,
  forceFrostedTitleOnly = false,
  onPickFile,
  onOpenStorage,
  onLoadDemo,
  onSelectSource,
  onOpenCloudGpu,
  onInstallDemoCollections,
  demoCollectionOptions = [],
}) {
  const isVisible = show || forceFrostedTitleOnly;

  // Keep the overlay mounted through fade-out; unmount after transition ends
  const [mounted, setMounted] = useState(isVisible);

  // Responsive mask height (tight mask on narrow screens)
  const [maskHeight, setMaskHeight] = useState(() => {
    if (typeof window === 'undefined') return 150;
    return window.innerWidth <= 500 ? 80 : 150;
  });

  // Button entrance visibility
  const [buttonsVisible, setButtonsVisible] = useState(false);

  // Sources state for collections button
  const [sources, setSources] = useState(() => getSourcesArray());
  const [showCollectionsModal, setShowCollectionsModal] = useState(false);
  const [collectionsView, setCollectionsView] = useState('sources');
  const [fastExit, setFastExit] = useState(false);
  const closeCollectionsTimerRef = useRef(null);
  const openControlsModalWithSections = useStore((state) => state.openControlsModalWithSections);


  // Subscribe to source changes
  useEffect(() => {
    setSources(getSourcesArray());
    const unsubscribe = onSourceChange(() => {
      setSources(getSourcesArray());
    });
    return unsubscribe;
  }, []);

  const handleOpenCollections = useCallback(() => {
    setCollectionsView('sources');
    setShowCollectionsModal(true);
  }, []);

  const handleCloseCollections = useCallback(() => {
    if (closeCollectionsTimerRef.current) {
      clearTimeout(closeCollectionsTimerRef.current);
      closeCollectionsTimerRef.current = null;
    }
    setCollectionsView('sources');
    setShowCollectionsModal(false);
  }, []);

  const handleSelectSource = useCallback((sourceId) => {
    setFastExit(true);
    if (closeCollectionsTimerRef.current) {
      clearTimeout(closeCollectionsTimerRef.current);
      closeCollectionsTimerRef.current = null;
    }
    closeCollectionsTimerRef.current = setTimeout(() => {
      setShowCollectionsModal(false);
      closeCollectionsTimerRef.current = null;
    }, 90);
    onSelectSource?.(sourceId);
  }, [onSelectSource]);

  useEffect(() => {
    if (isVisible) {
      setFastExit(false);
    }
  }, [isVisible]);

  useEffect(() => {
    return () => {
      if (closeCollectionsTimerRef.current) {
        clearTimeout(closeCollectionsTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let unmountTimer;
    if (isVisible) {
      setMounted(true);
    } else {
      unmountTimer = setTimeout(() => setMounted(false), 450);
    }
    return () => {
      if (unmountTimer) clearTimeout(unmountTimer);
    };
  }, [isVisible]);

  useEffect(() => {
    if (!show || forceFrostedTitleOnly) {
      setButtonsVisible(false);
      return undefined;
    }
    const resizeHandler = () => {
      setMaskHeight(window.innerWidth <= 500 ? 80 : 180);
    };
    resizeHandler();
    window.addEventListener('resize', resizeHandler);

    const timer = setTimeout(() => setButtonsVisible(true), 1000);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', resizeHandler);
    };
  }, [show, forceFrostedTitleOnly]);

  const actionButtonsClass = `action-buttons ${buttonsVisible ? 'is-visible' : ''}`;
  const helpButtonClass = `title-card-help ${buttonsVisible ? 'is-visible' : ''}`;

  const showCollectionsButton = sources.length > 0;

  // Render always and let parent control visibility via CSS class to allow fade transitions
  const overlayClass = `title-card-overlay ${isVisible ? 'is-visible' : 'is-hidden'} ${fastExit ? 'is-fast-exit' : ''}`;

  if (!mounted) return null;

  return (
    <div class={overlayClass} inert={!isVisible ? '' : undefined}>
      <div class="title-card">
        <FrostedTitle
          backgroundImage="/neonstaticblur.jpg"
          title="Radia"
          height={520}
          maskHeight={maskHeight}
          animation="rotate"
          showStroke
        />
        {!forceFrostedTitleOnly && (
          <div class="title-card__content">
            <div class={actionButtonsClass}>
              <button class="action-btn " onClick={onPickFile}>
                <FolderIcon size={16} />
                <span>B r o w s e </span>
              </button>
              <button class="action-btn " onClick={onOpenStorage}>
                <ServerIcon size={16} />
                <span>C o n n e c t</span>
              </button>
              {showCollectionsButton ? (
                <button class="action-btn " onClick={handleOpenCollections}>
                  <FolderOpenIcon size={16} />
                  <span>C o l l e c t i o n s</span>
                </button>
              ) : (
                <button class="action-btn " onClick={onLoadDemo}>
                  <RocketIcon size={16} />
                  <span>D e m o</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {!forceFrostedTitleOnly && (
        <div class={helpButtonClass}>
          <button
            class="action-btn help-btn"
            onClick={() => openControlsModalWithSections(['getting-started.viewer-overview'])}
            aria-label="Open controls"
            title="Controls"
          >
            ?
          </button>
        </div>
      )}

      {!forceFrostedTitleOnly && (
        <Modal
          isOpen={showCollectionsModal}
          onClose={handleCloseCollections}
          maxWidth={collectionsView === 'demos' ? 520 : 480}
        >
          {collectionsView === 'sources' ? (
            <>
              <h2>Collections</h2>
              <p class="dialog-subtitle">Select a collection to load.</p>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px', marginBottom: '8px' }}>
                <button
                  class="back-button"
                  onClick={() => setCollectionsView('demos')}
                  style={{ marginBottom: 0 }}
                >
                  add demo collections
                </button>
              </div>

              <StorageSourceList
                onAddSource={onOpenStorage}
                onSelectSource={handleSelectSource}
                onOpenCloudGpu={onOpenCloudGpu}
                listOnly
              />

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '24px' }}>
                <button
                  class="secondary-button"
                  onClick={handleCloseCollections}
                  style={{ height: '36px', padding: '0 16px', minWidth: '80px', marginTop: '0' }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <DemoCollectionsPage
              isActive={collectionsView === 'demos' && showCollectionsModal}
              onBack={() => setCollectionsView('sources')}
              onClose={handleCloseCollections}
              onInstall={onInstallDemoCollections}
              options={demoCollectionOptions}
            />
          )}
        </Modal>
      )}
    </div>
  );
}

export default TitleCard;
