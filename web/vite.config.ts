import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// `npm run dev:phone` serves over HTTPS on the LAN: phones only allow live camera on HTTPS.
const phone = process.env.PHONE === '1'

export default defineConfig({
  plugins: [react(), ...(phone ? [basicSsl()] : [])],
  server: {
    host: phone ? true : undefined,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
