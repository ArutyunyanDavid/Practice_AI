import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // The browser dev server only needs PORT. Keep backend-only secrets such as
  // OPENAI_API_KEY out of Vite's environment-loading path entirely.
  const environment = loadEnv(mode, process.cwd(), ['PORT']);
  const apiPort = environment.PORT || process.env.PORT || '8787';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': `http://localhost:${apiPort}`,
      },
    },
  };
});
