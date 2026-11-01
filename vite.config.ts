import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 4183,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4182", ws: true } },
  },
});
