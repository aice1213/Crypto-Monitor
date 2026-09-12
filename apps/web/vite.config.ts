import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // 开发时将 /api 代理到 Worker（默认本地 wrangler dev，可通过 VITE_WORKER_URL 覆盖）
  const workerTarget = env.VITE_WORKER_URL || 'http://localhost:8787';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: workerTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom', 'zustand'],
            charts: ['lightweight-charts'],
          },
        },
      },
    },
  };
});
