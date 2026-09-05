import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/doomify/',
  // Spotify の Redirect URI は完全一致が必須で、localhost は拒否されるため 127.0.0.1:5173 に固定する
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  plugins: [
    react(),
    VitePWA({
      // autoUpdate は再生中に勝手にリロードして音を止めるので、更新は曲の切れ目に手動適用する
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'doomify — Spotifyをスワイプで聴き流す',
        short_name: 'doomify',
        description: 'Spotifyの曲を縦スワイプで次々に聴き流すアプリ',
        lang: 'ja',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0b0b12',
        background_color: '#0b0b12',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // カバーアートは短期だけキャッシュ(ポリシー上、長期保存はしない)。crossorigin 付き img なので opaque にならない
            urlPattern: /^https:\/\/i\.scdn\.co\/image\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cover-art',
              expiration: { maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },
          // API 応答・認可・SDK スクリプトはキャッシュしない
          { urlPattern: /^https:\/\/(api|accounts)\.spotify\.com\//, handler: 'NetworkOnly' },
          { urlPattern: /^https:\/\/sdk\.scdn\.co\//, handler: 'NetworkOnly' },
        ],
      },
    }),
  ],
})
