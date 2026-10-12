import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Inventario de computadoras',
        short_name: 'Inventario',
        description: 'Inventario compartido de computadoras con cámara, ubicación y respaldo.',
        theme_color: '#0c2e2a',
        background_color: '#f4f7f5',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: './',
        scope: './',
        lang: 'es-MX',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
        // Firebase Auth must reach Vercel's proxy; never answer OAuth routes
        // from the SPA cache, including in an installed iOS PWA.
        navigateFallbackDenylist: [/^\/__\/auth\//, /^\/__\/firebase\//]
      },
      devOptions: { enabled: true }
    })
  ],
  server: { port: 5173 },
  preview: { port: 4173, allowedHosts: ['.trycloudflare.com'] }
})
