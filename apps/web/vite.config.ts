import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.API_PORT ?? "5512";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["source"] },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? "5412"),
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, ws: true, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: true, assetsInlineLimit: 0 },
});
