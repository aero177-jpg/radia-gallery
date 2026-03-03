/**
 * Frosted glass title hero.
 * Renders an animated background with a blurred layer masked to text shape.
 * Uses CSS mask-image with an external SVG file for clipping.
 */
import './frostedTitle.css';
import { useEffect, useState } from 'preact/hooks';

function FrostedTitle({
  backgroundImage = '/_DSF1672.jpg',
  maskSvg = '/Radiatitle.svg',
  height = 300,
  maskHeight = 130, // Logical height for layout (SVG mask height)
  showStroke = false,
  className = '',
  animation = 'pan', // 'pan' | 'rotate' | 'random' | 'off'
}) {
  // Use the external SVG file as the mask
  const maskUrl = `url("${maskSvg}")`;
  const strokeMaskUrl = maskUrl;

  // Normalize animation value - fallback to 'pan'
  const anim = ['pan', 'rotate', 'random', 'off'].includes(animation) ? animation : 'pan';

  // Control mount visibility to trigger the transition-based focus-in
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // small delay keeps the blur for a moment before transitioning
    const id = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(id);
  }, []);

  const heroClass = [
    'frosted-hero',
    className,
    `frosted-hero--anim-${anim}`,
    visible ? 'is-visible' : ''
  ].filter(Boolean).join(' ');

  return (
    <div
      class={heroClass}
      style={{ '--hero-height': `${height}px`, '--mask-height': `${maskHeight}px` }}
    >
      {/* Layers wrapper - overflows without affecting layout */}
      <div class="frosted-hero__layers">
        {/* Sharp background layer (kept hidden) */}
        <div
          class="frosted-hero__background"
          style={{ backgroundImage: `url("${backgroundImage}")` }}
          aria-hidden="true"
        />

        {/* Blurred layer clipped to text fill shape */}
        <div
          class="frosted-hero__blur-layer frosted-hero__blur-layer--fill"
          style={{
            '--bg': `url("${backgroundImage}")`,
            WebkitMaskImage: maskUrl,
            maskImage: maskUrl,
          }}
          aria-hidden="true"
        />

        {/* Stroke layer - same animated bg but brighter, masked to stroke */}
        {showStroke && (
          <div
            class="frosted-hero__blur-layer--stroke"
            style={{
              '--bg': `url("${backgroundImage}")`,
              WebkitMaskImage: strokeMaskUrl,
              maskImage: strokeMaskUrl,
            }}
            aria-hidden="true"
          />
        )}

        {/* Glass tint overlay (also masked to text) */}
        <div
          class="frosted-hero__glass-tint"
          style={{
            WebkitMaskImage: maskUrl,
            maskImage: maskUrl,
          }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

export default FrostedTitle;
