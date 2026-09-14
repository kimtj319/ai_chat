import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev-server proxy: the browser talks to this Express backend (server/), never
// to vLLM directly. All "/api/*" requests are forwarded as-is (no path
// rewrite — the backend itself expects the "/api" prefix) to BACKEND_URL,
// which defaults to http://localhost:8080 (see server/config.ts's PORT).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.BACKEND_URL || "http://localhost:8080";

  // Shared by `vite dev` and `vite preview` — without the preview entry the
  // built app served by `npm run preview` would 404 on every /api call.
  const proxy = {
    "/api": {
      target,
      changeOrigin: true,
    },
  };

  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
  };
});
