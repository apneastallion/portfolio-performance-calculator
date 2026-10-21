import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the SPA runs on 5173 and the Pages worker on 8788 (`npm run preview`).
// Proxying /api keeps the browser talking to one origin in both modes.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
