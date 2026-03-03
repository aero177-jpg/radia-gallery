/**
 * Shared modal wrapper with fullscreen-safe portal target.
 */

import { createPortal } from 'preact/compat';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTimes } from '@fortawesome/free-solid-svg-icons';
import usePortalTarget from '../utils/usePortalTarget';
import { useStore } from '../store';

function Modal({
  isOpen,
  onClose,
  children,
  maxWidth = 420,
  className = 'storage-dialog',
  showClose = true,
}) {
  const portalTarget = usePortalTarget();
  const disableTransparentUi = useStore((state) => state.disableTransparentUi);

  if (!isOpen || !portalTarget) return null;

  return createPortal(
    <div class="modal-overlay" onClick={() => onClose?.()}>
      <div
        class={`modal-content ${className}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth,
          ...(disableTransparentUi ? { background: '#191b22d9' } : {}),
        }}
      >
        {showClose && onClose && (
          <button class="modal-close" onClick={onClose} type="button" aria-label="Close">
            <FontAwesomeIcon icon={faTimes} />
          </button>
        )}
        {children}
      </div>
    </div>,
    portalTarget
  );
}

export default Modal;
