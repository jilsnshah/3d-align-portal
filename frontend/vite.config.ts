import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind every interface so the app is reachable on both localhost and
    // 127.0.0.1. Cookies are host-scoped, so those two hostnames get separate
    // sessions — handy for having a doctor and staff signed in side by side.
    host: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
