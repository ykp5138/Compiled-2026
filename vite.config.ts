import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend never sees credentials: all Luminal calls go through the Node server.
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [".."] },
    proxy: { "/api": "http://localhost:8787" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
