import { useState } from "react";
import { setBrowserControl, useBrowserControl } from "../browser/browserControl";
import { useBrowserExtension } from "../browser/extension";
import { appPath } from "../api/base";
import { copyText } from "../state/clipboard";
import { Modal } from "./Modal";
import { ToggleSwitch } from "./ToggleSwitch";
import { showToast } from "./Toast";
import "./BrowserControlToggle.css";

function CursorIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 8h18" />
      <path d="m12 11 1.6 7 1.4-2.6 2.6 2.6 1.2-1.2-2.6-2.6 2.6-1.4z" />
    </svg>
  );
}

/**
 * 입력창의 "크롬" 단추. 켜면 이번부터 보내는 질문에 크롬 도구가 실려, 모델이 사용자의
 * 크롬을 읽고 조작할 수 있다. 확장 프로그램이 없으면 설치 안내를 연다.
 * 폰에서는 그리지 않는다(Composer) — 모바일 크롬에는 확장 프로그램이 없다.
 */
/** 크롬 제어가 지금 실제로 켜져 있는가(확장 연결 + 사용자 켬). */
export function useBrowserControlActive(): boolean {
  const ext = useBrowserExtension();
  const on = useBrowserControl();
  return on && ext.available && ext.enabled;
}

/**
 * variant="row" 는 입력창 "+" 메뉴 안의 한 줄(이름·한 줄 설명·스위치)이다. 기본(icon)은
 * 입력창의 아이콘 단추로, 켜져 있는 동안에만 입력창에 남아 상태를 보이고 바로 끄게 한다.
 */
export function BrowserControlToggle({ variant = "icon" }: { variant?: "icon" | "row" }) {
  const ext = useBrowserExtension();
  const on = useBrowserControl();
  const [guideOpen, setGuideOpen] = useState(false);
  const active = on && ext.available && ext.enabled;

  function handleClick() {
    if (!ext.available) {
      setGuideOpen(true);
      return;
    }
    if (!ext.enabled) {
      showToast("확장 프로그램 창에서 '크롬 연결 켜기' 를 먼저 켜 주세요.");
      return;
    }
    setBrowserControl(!on);
    showToast(on ? "크롬 제어를 껐습니다." : "크롬 제어를 켰습니다. 처음 가는 사이트와 되돌리기 어려운 동작은 매번 묻습니다.");
  }

  const label = !ext.available ? "크롬 제어 연결하기" : active ? "크롬 제어 끄기" : "크롬 제어 켜기";
  if (variant === "row") {
    return (
      <>
        <div className="mcp-picker-action">
          <CursorIcon />
          <span className="mcp-picker-action-text">
            <span className="mcp-picker-action-name">크롬 제어</span>
            <span className="mcp-picker-action-hint">
              {ext.available ? "모델이 이 컴퓨터의 크롬을 읽고 조작합니다" : "확장 프로그램을 연결하면 쓸 수 있습니다"}
            </span>
          </span>
          {ext.available ? (
            <ToggleSwitch on={active} label={label} onToggle={handleClick} />
          ) : (
            <button type="button" className="mcp-picker-clear" onClick={handleClick}>
              연결하기
            </button>
          )}
        </div>
        {guideOpen && <BrowserControlGuide onClose={() => setGuideOpen(false)} />}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`btn-icon composer-browser${active ? " active" : ""}`}
        aria-pressed={active}
        aria-label={label}
        data-tooltip={label}
        onClick={handleClick}
      >
        <CursorIcon />
      </button>
      {guideOpen && <BrowserControlGuide onClose={() => setGuideOpen(false)} />}
    </>
  );
}

function BrowserControlGuide({ onClose }: { onClose: () => void }) {
  const origin = window.location.origin;
  return (
    <Modal title="크롬 제어 연결하기" onClose={onClose} width={480}>
      <div className="browser-guide">
        <p>
          모델이 이 컴퓨터의 크롬에서 페이지를 열고, 읽고, 누르고, 입력하게 합니다. 처음 가는 사이트와 제출·전송·구매·삭제처럼
          보이는 동작은 매번 이 화면에서 묻습니다. 비밀번호는 입력하지 않습니다.
        </p>
        <ol>
          <li>
            <a href={appPath("ai-console-chrome.zip")} download>
              확장 프로그램 내려받기
            </a>{" "}
            — 받은 zip 파일의 압축을 풉니다.
          </li>
          <li>
            크롬 주소창에 <code>chrome://extensions</code> 를 열고, 오른쪽 위 <b>개발자 모드</b>를 켠 뒤{" "}
            <b>압축해제된 확장 프로그램을 로드합니다</b>를 눌러 푼 폴더를 고릅니다.
          </li>
          <li>
            툴바의 퍼즐 아이콘에서 <b>AI Console 크롬 연결</b>을 열고, 주소 칸에 아래 주소를 넣고 저장합니다.
            <span className="browser-guide-origin">
              <code>{origin}</code>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void copyText(origin).then((ok) => showToast(ok ? "주소를 복사했습니다." : "복사하지 못했습니다."))}
              >
                복사
              </button>
            </span>
          </li>
          <li>연결되면 입력창의 크롬 단추로 켜고 끕니다. 새로고침하면 꺼진 상태로 돌아갑니다.</li>
        </ol>
      </div>
    </Modal>
  );
}
