import "./ToggleSwitch.css";

/**
 * 켜고 끄는 스위치(도구 설정·라이브러리 공용). <button role="switch"> 라서
 * Enter·Space 는 네이티브 클릭으로 이미 동작하고, 켜짐/꺼짐은 손잡이 위치로도
 * 구별되어 색에만 기대지 않는다.
 */
export function ToggleSwitch({
  on,
  disabled,
  label,
  onToggle,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className="toggle-switch"
      data-on={on}
      onClick={() => onToggle(!on)}
    >
      <span className="toggle-switch-track" aria-hidden="true">
        <span className="toggle-switch-thumb" />
      </span>
    </button>
  );
}
