import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'plotly-cabal': path.resolve(__dirname, '../plotly-cabal/build/plotly.min.js'),
    },
  },
  server: {
    allowedHosts: ['nonlosable-concha-noncontemptuously.ngrok-free.dev'],
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
})
