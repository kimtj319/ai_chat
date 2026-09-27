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
    // 빌드 결과가 자기 자산을 "./assets/…" 로 부르게 한다. "/assets/…" 이면 앱이 다른
    // 도메인의 하위 경로로 연결됐을 때 그 도메인의 루트에서 찾다가 빈 화면이 된다.
    // 라우팅은 해시(#admin 등)라 페이지는 늘 앱 루트에서 열리므로 상대 경로가 맞다.
    base: "./",
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
  };
});
