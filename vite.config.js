import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

const normalizeBasePath = (value) => {
  const text = String(value || '/').trim();
  const withLeadingSlash = text.startsWith('/') ? text : `/${text}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

const base = normalizeBasePath(process.env.BASE_PATH || '/');

export default defineConfig({
  plugins: [
    preact(),
    basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      manifest: {
        id: './',
        name: 'Radia',
        short_name: 'Radia',
        start_url: './',
        scope: './',
        display: 'standalone',
        display_override: ['fullscreen', 'standalone'],
        background_color: '#0c0d10',
        theme_color: '#0c0d10',
        icons: [
          {
            src: `${base}radiaIcon_192.png`,
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: `${base}radiaIcon_512.png`,
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        navigateFallback: `${base}index.html`,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,jpg,jpeg,webp,woff2}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024
      }
    })
  ],
  // Use BASE_PATH environment variable, defaulting to '/'
  base,
  server: {
    https: false,
    host: true
  }
})
