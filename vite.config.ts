/// <reference types="vitest" />
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue() // Плагин legacy полностью удален
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Явно указываем современный таргет для поддержки BigInt (нужно для MapLibre)
    target: 'es2022',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('maplibre-gl')) return 'maplibre'
            if (id.includes('socket.io-client')) return 'socketio'
            if (id.includes('@ionic') || id.includes('vue') || id.includes('vue-router')) return 'vendor'
            return 'vendor'
          }
        }
      }
    }
  },
  // Указываем таргет и для esbuild
  esbuild: {
    target: 'es2022'
  },
  test: {
    globals: true,
    environment: 'jsdom'
  }
})
