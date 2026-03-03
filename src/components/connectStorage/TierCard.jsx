import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faFolder,
  faCloud,
  faUpload,
  faExclamationTriangle,
  faChevronRight,
  faLink,
  faDatabase,
} from '@fortawesome/free-solid-svg-icons';
import { SupabaseIcon, CloudFlareIcon, CloudGpuIcon } from '../../icons/customIcons';
import { SOURCE_TIERS } from '../../storage/index.js';

const ICONS = {
  folder: faFolder,
  cloud: faCloud,
  upload: faUpload,
  link: faLink,
  database: faDatabase,
  supabase: SupabaseIcon,
  cloudflare: CloudFlareIcon,
  'cloud-gpu': CloudGpuIcon,
};

function TierCard({ type, selected, onSelect, disabled }) {
  const info = SOURCE_TIERS[type];
  if (!info) return null;

  return (
    <button
      class={`storage-tier-card ${selected ? 'selected' : ''}`}
      onClick={() => !disabled && onSelect(type)}
      disabled={disabled}
    >
      <div class="tier-icon">
        {info.icon === 'supabase' ? (
          <SupabaseIcon size={20} className="tier-custom-icon" />
        ) : info.icon === 'cloudflare' ? (
          <CloudFlareIcon size={24} className="tier-custom-icon" />
        ) : info.icon === 'cloud-gpu' ? (
          <CloudGpuIcon size={24} className="tier-custom-icon" />
        ) : (
          <FontAwesomeIcon icon={ICONS[info.icon] || faFolder} />
        )}
      </div>
      <div class="tier-content">
        <div class="tier-header">
          <h4>{info.label}</h4>
        </div>
        <p class="tier-description">{info.description}</p>
        {disabled && (
          <p class="tier-disabled-reason">
            <FontAwesomeIcon icon={faExclamationTriangle} />
            {' '}Not supported in this browser
          </p>
        )}
      </div>
      <FontAwesomeIcon icon={faChevronRight} class="tier-arrow" />
    </button>
  );
}

export default TierCard;
