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
        type: 'module'
      },
      includeAssets: ['peerlink-logo.png', 'favicon.ico'],
      manifest: {
        name: 'PeerLink',
        short_name: 'PeerLink',
        description: 'Fast peer-to-peer file transfer',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'peerlink-logo.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'peerlink-logo.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      injectManifest: {
        injectionPoint: 'self.__WB_MANIFEST',
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024
      }
    })
  ],
})
