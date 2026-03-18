import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    modulePreload: {
      // Disable the inline polyfill script so the CSP script-src 'self'
      // directive is not violated. All target browsers support modulepreload
      // natively (Chrome 66+, Firefox 115+, Safari 17+).
      polyfill: false,
    },
  },
})
