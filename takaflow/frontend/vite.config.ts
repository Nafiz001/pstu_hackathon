import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dev server proxies the API rather than calling it cross-origin.
 *
 * Same-origin in development means the browser behaves exactly as it will in production behind
 * the load balancer — no CORS preflights that only exist locally, and no environment-specific
 * base URL for the client to get wrong.
 *
 * 127.0.0.1, never `localhost`: on Windows `localhost` resolves to ::1 first, and connections to
 * the Docker-published port over IPv6 stall. Same reason the backend's DATABASE_URL is an IP.
 */
// Defaults to the load balancer in front of the API replicas, which is how the app is demoed.
// Point it at a bare `npm run dev` backend with API_TARGET=http://127.0.0.1:3000.
const target = process.env.API_TARGET ?? 'http://127.0.0.1:18090';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind IPv4 explicitly. Vite's default host is `localhost`, which on Windows resolves to ::1
    // first — the same IPv6-loopback trap that made the API and the load balancer unreachable.
    host: '127.0.0.1',
    proxy: {
      '/api': { target, changeOrigin: true },
      '/healthz': { target, changeOrigin: true },
      '/metrics': { target, changeOrigin: true },
    },
  },
});
