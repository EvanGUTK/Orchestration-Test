import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const HOST = process.env["HOST"] ?? "127.0.0.1";
const WEB_PORT = Number(process.env["WEB_PORT"] ?? 5173);
const API_PORT = Number(process.env["API_PORT"] ?? 3000);
const apiOrigin = `http://${HOST}:${API_PORT}`;
const wsOrigin = `ws://${HOST}:${API_PORT}`;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2023",
  },
  server: {
    host: HOST,
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      "/api/v1/events": { target: wsOrigin, ws: true, changeOrigin: false },
      "/api": { target: apiOrigin, changeOrigin: false },
    },
  },
  preview: { host: HOST, port: WEB_PORT, strictPort: true },
});
