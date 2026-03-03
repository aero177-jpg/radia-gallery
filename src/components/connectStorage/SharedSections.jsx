import { useState } from 'preact/hooks';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronRight,
  faChevronDown,
  faQuestion,
  faFolderOpen,
} from '@fortawesome/free-solid-svg-icons';

export function FaqItem({ question, children }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class="faq-item">
      <button
        class="faq-question"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <FontAwesomeIcon icon={faQuestion} className="faq-icon" />
        <span>{question}</span>
        <FontAwesomeIcon icon={expanded ? faChevronDown : faChevronRight} className="faq-chevron" />
      </button>
      {expanded && (
        <div class="faq-answer">
          {children}
        </div>
      )}
    </div>
  );
}

export function ExistingCollectionItem({ collection, onSelect, isLoading, selected }) {
  return (
    <button
      class={`existing-collection-item ${selected ? 'selected' : ''}`}
      onClick={() => onSelect(collection)}
      disabled={isLoading}
    >
      <div class="collection-info">
        <FontAwesomeIcon icon={faFolderOpen} className="collection-icon" />
        <div class="collection-details">
          <span class="collection-name">{collection.name}</span>
          <span class="collection-meta">
            <span
              style={{ display: 'inline-flex', gap: '4px', marginTop: '2px' }}
            >
              <div style={collection.assetCount > 0 ? { color: '#5cb178' } : undefined}>
                {collection.assetCount}
              </div>
              {' '}item{collection.assetCount !== 1 ? 's' : ''}
            </span>
          </span>
        </div>
      </div>
      <FontAwesomeIcon icon={faChevronRight} className="collection-arrow" />
    </button>
  );
}
