import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck } from '@fortawesome/free-solid-svg-icons';

function SelectableOptionItem({
  title,
  subtitle,
  icon,
  selected,
  onToggle,
  disabled,
  indicatorIcon = faCheck,
  selectedIndicatorBackground = 'rgba(91, 178, 213, 0.87)',
  selectedIndicatorColor = '#000',
}) {
  const disabledStyle = disabled
    ? {
        opacity: 0.55,
        cursor: 'not-allowed',
      }
    : {};

  const checkmarkStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    borderRadius: '50%',
    background: selected ? selectedIndicatorBackground : 'rgba(255, 255, 255, 0.1)',
    border: selected ? 'none' : '1px solid rgba(255, 255, 255, 0.2)',
    color: selected ? selectedIndicatorColor : 'transparent',
    fontSize: '12px',
    flexShrink: 0,
    transition: 'all 0.15s ease',
  };

  const iconStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: selected ? 1 : 0.5,
    transition: 'opacity 0.15s ease',
  };

  const titleStyle = {
    marginBottom: '4px',
    opacity: selected ? 1 : 0.6,
    transition: 'opacity 0.15s ease',
  };

  return (
    <button
      class={`storage-tier-card ${selected ? 'selected' : ''}`}
      onClick={disabled ? undefined : onToggle}
      type="button"
      style={disabledStyle}
      disabled={disabled}
    >
      <div class="collection-info">
        <div class="collection-icon" style={iconStyle}>
          <FontAwesomeIcon icon={icon} style={{ fontSize: '18px' }} />
        </div>
        <div class="collection-details">
          <span class="collection-name" style={titleStyle}>
            {title}
          </span>
          {subtitle && <span class="collection-meta">{subtitle}</span>}
        </div>
      </div>
      <div style={checkmarkStyle}>
        <FontAwesomeIcon icon={indicatorIcon} />
      </div>
    </button>
  );
}

export default SelectableOptionItem;
