import { lazy, type ComponentType } from "react";
import { LoadFailed } from "./components/ListSkeleton";

/**
 * 대화 화면이 아닌 페이지들. 첫 화면 묶음에서 빼서 따로 받는다(App.tsx 가 이 이름으로 쓴다).
 *
 * React.lazy 만으로는 처음 열 때마다 Suspense 가 대체 화면을 띄우고, React 는 그 뒤의
 * 내용을 300ms 단위로만 드러내므로(깜빡임을 막는 장치) 같은 망에서도 페이지가 0.3초 늦게
 * 뜬다 — 예전에는 바로 떴다. 그래서 첫 화면이 뜨고 조금 뒤 모두 받아 두고, 받아 둔
 * 페이지는 기다리지 않고 바로 그린다. 받기 전에 누르면 그때만 대체 화면을 거친다.
 *
 * 미리 받는 데에는 하나가 더 있다: 배포하면 예전 묶음 파일은 사라진다. 오래 열어 둔 탭이
 * 그 뒤에 처음 페이지를 열면 받을 파일이 없다. 그래도 받지 못하면 빈 화면 대신
 * 새로고침을 권한다.
 */
function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  const preload = () => {
    loading ??= load().then(
      (component) => (loaded = component),
      (error: unknown) => {
        loading = null;
        throw error;
      },
    );
    return loading;
  };
  const Lazy = lazy(() =>
    preload().then(
      (component) => ({ default: component }),
      () => ({ default: PageLoadFailed as ComponentType<P> }),
    ),
  );
  function Page(props: P) {
    const Loaded = loaded;
    return Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
  }
  return { Page, preload };
}

function PageLoadFailed() {
  return (
    <LoadFailed
      message="페이지를 불러오지 못했습니다."
      detail="앱이 새로 배포되었거나 연결이 끊겼을 수 있습니다. 새로고침하면 다시 받습니다."
      onRetry={() => window.location.reload()}
    />
  );
}

const admin = lazyPage(() => import("./components/AdminPage").then((m) => m.AdminPage));
const board = lazyPage(() => import("./components/BoardPage").then((m) => m.BoardPage));
const documents = lazyPage(() => import("./components/DocumentsPage").then((m) => m.DocumentsPage));
const library = lazyPage(() => import("./components/LibraryPage").then((m) => m.LibraryPage));
const settings = lazyPage(() => import("./components/ConversationSettingsPage").then((m) => m.ConversationSettingsPage));
const tools = lazyPage(() => import("./components/ToolsPage").then((m) => m.ToolsPage));

export const AdminPage = admin.Page;
export const BoardPage = board.Page;
export const DocumentsPage = documents.Page;
export const LibraryPage = library.Page;
export const ConversationSettingsPage = settings.Page;
export const ToolsPage = tools.Page;

// 첫 화면의 요청(로그인 확인·대화 목록)과 다투지 않게 조금 뒤에. 실패하면 처음 열 때 다시 해 본다.
const PRELOAD_DELAY_MS = 3000;
window.addEventListener(
  "load",
  () => {
    window.setTimeout(() => {
      for (const page of [admin, board, documents, library, settings, tools]) page.preload().catch(() => {});
    }, PRELOAD_DELAY_MS);
  },
  { once: true },
);
