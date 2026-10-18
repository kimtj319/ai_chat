import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 코드 색칠 문법을 37개(lowlight 의 common)에서 src/components/highlightLanguages.ts 의
 * 목록으로 줄인다. rehype-highlight 가 common 을 직접 불러 두어 옵션으로는 빠지지 않으므로,
 * lowlight 가 그 파일을 부르는 자리에서 갈아 끼운다. 개발 서버가 의존성을 미리 묶을 때는
 * 이 훅이 걸리지 않으므로, 거기서는 37개가 그대로일 수 있다.
 */
function trimHighlightLanguages(): Plugin {
  const replacement = fileURLToPath(new URL("./src/components/highlightLanguages.ts", import.meta.url));
  return {
    name: "trim-highlight-languages",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./lib/common.js" && importer && /[\\/]lowlight[\\/]index\.js$/.test(importer)) return replacement;
      return null;
    },
  };
}

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
    plugins: [react(), trimHighlightLanguages()],
    build: {
      rolldownOptions: {
        output: {
          // 첫 화면에 필요한 모듈은 모두 한 묶음에. 이것이 없으면 rolldown 은 나중에 받는
          // 페이지(App.tsx 의 lazy)와 함께 쓰는 모듈(Toast·ConfirmDialog·React …)을 작은
          // 묶음 여럿으로 떼어 내, 첫 로드의 요청이 늘고 그 CSS 가 index.css 앞으로 옮겨
          // 가 규칙의 순서가 바뀐다.
          codeSplitting: { groups: [{ name: "app", tags: ["$initial"] }] },
        },
      },
    },
    server: { proxy },
    preview: { proxy },
  };
});
