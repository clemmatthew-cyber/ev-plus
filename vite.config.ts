import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: "hidden",  // F-23: no public source maps in production
  },
  server: {
    proxy: {
      "/api": "http://localhost:5000",
    },
  },
});
