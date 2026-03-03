/**
 * Storage Sources List Component
 * 
 * Displays connected storage sources with status indicators.
 * Allows reconnecting, refreshing, and removing sources.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faPlus,
  faChevronDown,
} from '@fortawesome/free-solid-svg-icons';
import {
  getSourcesArray,
  onSourceChange,
} from '../storage/index.js';
import { useStore } from '../store';
import ConnectStorageDialog from './ConnectStorageDialog';
import StorageSourceItem from './StorageSourceItem.jsx';

/**
 * Storage sources list with collapsible toggle and add button
 */
function StorageSourceList({ onAddSource, onSelectSource, onOpenCloudGpu, listOnly = false }) {
  const [sources, setSources] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [isListExpanded, setIsListExpanded] = useState(true);
  const [editSource, setEditSource] = useState(null);
  const activeSourceId = useStore((state) => state.activeSourceId);

  // Load sources on mount and subscribe to changes
  useEffect(() => {
    setSources(getSourcesArray());

    const unsubscribe = onSourceChange((event, sourceId) => {
      setSources(getSourcesArray());
    });

    return unsubscribe;
  }, []);

  const handleToggleExpand = useCallback((sourceId) => {
    setExpandedId(prev => prev === sourceId ? null : sourceId);
  }, []);

  const handleRemove = useCallback((sourceId) => {
    if (expandedId === sourceId) {
      setExpandedId(null);
    }
  }, [expandedId]);

  const handleEditSource = useCallback((source) => {
    setEditSource(source);
  }, []);

  const handleCloseEdit = useCallback(() => {
    setEditSource(null);
  }, []);

  const listContent = sources.length === 0 ? (
    <div class="sources-empty">
      <p>No storage sources connected</p>
      <button class="add-source-link" onClick={onAddSource}>
        <FontAwesomeIcon icon={faPlus} /> Connect storage
      </button>
    </div>
  ) : (
    <div class="sources-list">
      {sources.map((source) => (
        <StorageSourceItem
          key={source.id}
          source={source}
          isActive={source.id === activeSourceId}
          expanded={expandedId === source.id}
          onToggleExpand={() => handleToggleExpand(source.id)}
          onSelect={onSelectSource}
          onEditSource={handleEditSource}
          onRemove={handleRemove}
          onOpenCloudGpu={onOpenCloudGpu}
          listOnly={listOnly}
        />
      ))}
    </div>
  );

  if (listOnly) {
    return (
      <>
        {listContent}
        {editSource && (
          <ConnectStorageDialog
            isOpen={!!editSource}
            onClose={handleCloseEdit}
            onConnect={handleCloseEdit}
            editSource={editSource}
          />
        )}
      </>
    );
  }

  return (
    <div class="settings-group">
      <div 
        class="group-toggle" 
        aria-expanded={isListExpanded}
        onClick={() => setIsListExpanded(!isListExpanded)}
      >
        <span class="settings-eyebrow">Collections</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginRight: '-8px' }}>
          <button 
            class="add-source-btn" 
            onClick={(e) => { e.stopPropagation(); onAddSource(); }} 
            title="Add storage source"
            style={{ width: '28px', height: '22px', fontSize: '11px' }}
          >
            <FontAwesomeIcon icon={faPlus} />
          </button>
          <FontAwesomeIcon icon={faChevronDown} class="chevron" />
        </div>
      </div>

      <div class="group-content" style={{ display: isListExpanded ? 'flex' : 'none' }}>
        {listContent}
      </div>

      {editSource && (
        <ConnectStorageDialog
          isOpen={!!editSource}
          onClose={handleCloseEdit}
          onConnect={handleCloseEdit}
          editSource={editSource}
        />
      )}
    </div>
  );
}

export default StorageSourceList;
