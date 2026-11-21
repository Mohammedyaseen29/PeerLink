import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: null,
      registerType: 'prompt',
      devOptions: {
        enabled: true,
        type: 'module',
        navigateFallback: 'index.html'
      },
      includeAssets: ['peerlink-mark.svg', 'peerlink-icon.svg', 'peerlink-icon-32.png', 'peerlink-icon-180.png'],
      manifest: {
        name: 'PeerLink',
        short_name: 'PeerLink',
        description: 'Fast peer-to-peer file transfer',
        theme_color: '#121612',
        background_color: '#121612',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'peerlink-icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'peerlink-icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      injectManifest: {
        injectionPoint: 'self.__WB_MANIFEST',
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        globIgnores: ['webrtc-loopback-test.html', 'vite.svg', 'peerlink-logo.png'],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024
      }
    })
  ],
})
