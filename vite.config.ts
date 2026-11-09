import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  // noVNC uses top-level await in its browser capability probe. Electron 33
  // ships Chromium 130, so the dev optimizer must not down-level that module to
  // the default chrome87 target.
  optimizeDeps: {
    esbuildOptions: { target: "chrome128" },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome128",
  },
});
