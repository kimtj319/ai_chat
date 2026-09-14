#!/bin/bash
set -e

# ===================================================
# Qwen3 Web Chat — 백엔드(Express) + 프론트엔드(dist/) 구동 스크립트
# qwen-serving.sh 와 동일한 하우스 스타일
# ===================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

APP_NAME="qwen3-web-chat"
PID_DIR="./run"
LOG_DIR="./log"
PID_FILE="${PID_DIR}/web.pid"
ENV_FILE="./.env"

mkdir -p "${PID_DIR}" "${LOG_DIR}"

# 0. 호스트 환경 필수 명령어 존재 검증 (모든 서브커맨드 공통)
check_dependencies() {
    for cmd in node npm curl; do
        if ! command -v "${cmd}" &> /dev/null; then
            echo "[!] 오류: ${cmd} 명령어를 찾을 수 없습니다."
            exit 1
        fi
    done
}
check_dependencies

# .env 파일이 있으면 값을 불러온다. 이미 셸 환경변수로 지정된 값(예: PORT=9999
# ./start_web.sh start)이 있으면 .env 값보다 우선한다.
if [ -f "${ENV_FILE}" ]; then
    while IFS='=' read -r key value; do
        case "${key}" in
            ''|'#'*) continue ;;
        esac
        key="$(echo "${key}" | xargs)"
        value="$(echo "${value}" | xargs)"
        value="${value%\"}"; value="${value#\"}"
        value="${value%\'}"; value="${value#\'}"
        if [ -n "${key}" ] && [ -z "${!key+x}" ]; then
            export "${key}=${value}"
        fi
    done < "${ENV_FILE}"
fi

PORT="${PORT:-8080}"
VLLM_BASE_URL="${VLLM_BASE_URL:-http://localhost:8000/v1}"

is_running() {
    if [ -f "${PID_FILE}" ]; then
        local pid
        pid="$(cat "${PID_FILE}")"
        if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

needs_build_frontend() {
    if [ ! -f "./dist/index.html" ]; then
        return 0
    fi
    if [ -n "$(find ./src ./index.html ./package.json -newer ./dist/index.html 2>/dev/null)" ]; then
        return 0
    fi
    return 1
}

needs_build_backend() {
    if [ ! -f "./dist-server/index.js" ]; then
        return 0
    fi
    if [ -n "$(find ./server -name '*.ts' -newer ./dist-server/index.js 2>/dev/null)" ]; then
        return 0
    fi
    return 1
}

do_start() {
    if is_running; then
        echo "[!] 오류: ${APP_NAME}이(가) 이미 실행 중입니다 (PID: $(cat "${PID_FILE}"))."
        exit 1
    fi

    if needs_build_frontend; then
        echo "[*] 프론트엔드 빌드 중 (dist/ 없음 또는 소스 변경 감지)..."
        npm run build
    fi
    if needs_build_backend; then
        echo "[*] 백엔드 빌드 중 (dist-server/ 없음 또는 소스 변경 감지)..."
        npm run build:server
    fi

    local today log_file
    today="$(date +%Y%m%d)"
    log_file="${LOG_DIR}/${today}.log"

    echo "==================================================="
    echo " ${APP_NAME} 기동"
    echo " - 포트: ${PORT}"
    echo " - vLLM: ${VLLM_BASE_URL}"
    echo " - 로그 저장 위치: ${log_file}"
    echo "==================================================="

    nohup env PORT="${PORT}" VLLM_BASE_URL="${VLLM_BASE_URL}" npm run start >> "${log_file}" 2>&1 &
    local pid=$!
    echo "${pid}" > "${PID_FILE}"

    echo "[*] 서버 기동 및 헬스체크 대기 중..."
    local max_retry=30
    local count=0
    local success=0

    while [ "${count}" -lt "${max_retry}" ]; do
        # 비정상 종료(Crashed) 여부 즉시 감지
        if ! kill -0 "${pid}" 2>/dev/null; then
            echo ""
            echo "[!] 오류: 서버가 기동 중 비정상 종료되었습니다!"
            echo "---------------------------------------------------"
            tail -n 20 "${log_file}" 2>/dev/null || true
            echo "---------------------------------------------------"
            rm -f "${PID_FILE}"
            exit 1
        fi

        if curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/api/health" 2>/dev/null | grep -q '^200$'; then
            success=1
            break
        fi

        sleep 1
        count=$((count + 1))
        echo -n "."
    done
    echo ""

    if [ "${success}" -eq 1 ]; then
        echo "[+] ${APP_NAME}이(가) 준비되었습니다: http://localhost:${PORT}"
    else
        echo "[!] 경고: 헬스체크 대기 시간(${max_retry}초)이 초과되었습니다. 로그를 확인하세요: ${log_file}"
    fi
}

do_stop() {
    if ! is_running; then
        echo "[-] 중지할 ${APP_NAME}이(가) 실행되고 있지 않습니다."
        rm -f "${PID_FILE}"
        return
    fi

    local pid
    pid="$(cat "${PID_FILE}")"
    echo "[*] ${APP_NAME} (PID: ${pid}) 종료 중..."
    kill -TERM "${pid}" 2>/dev/null || true

    local count=0
    while kill -0 "${pid}" 2>/dev/null && [ "${count}" -lt 10 ]; do
        sleep 1
        count=$((count + 1))
    done

    if kill -0 "${pid}" 2>/dev/null; then
        echo "[!] 정상 종료(TERM)에 실패하여 강제 종료(KILL)합니다."
        kill -KILL "${pid}" 2>/dev/null || true
    fi

    rm -f "${PID_FILE}"
    echo "[+] ${APP_NAME}이(가) 종료되었습니다."
}

do_status() {
    echo "==================================================="
    echo " [${APP_NAME} 상태 정보]"
    echo "==================================================="
    if is_running; then
        local pid
        pid="$(cat "${PID_FILE}")"
        echo "상태: 실행 중"
        echo "PID: ${pid}"
        if ps -o etime= -p "${pid}" &>/dev/null; then
            echo "가동 시간: $(ps -o etime= -p "${pid}" | tr -d ' ')"
        fi
        echo "포트: ${PORT}"
        echo "---------------------------------------------------"
        echo -n "헬스체크 (/api/health): "
        curl -s "http://localhost:${PORT}/api/health" || echo "(응답 없음)"
        echo ""
        echo -n "vLLM 서버 (${VLLM_BASE_URL}/models): "
        if curl -s -o /dev/null -w '%{http_code}' "${VLLM_BASE_URL}/models" 2>/dev/null | grep -q '^200$'; then
            echo "도달 가능"
        else
            echo "도달 불가"
        fi
        echo "---------------------------------------------------"
        local today log_file
        today="$(date +%Y%m%d)"
        log_file="${LOG_DIR}/${today}.log"
        if [ -f "${log_file}" ]; then
            echo "최근 로그 (마지막 5줄, ${log_file}):"
            tail -n 5 "${log_file}"
        else
            echo "오늘자 로그 파일이 아직 없습니다: ${log_file}"
        fi
    else
        echo "상태: 중지됨"
    fi
    echo "==================================================="
}

do_logs() {
    local today log_file
    today="$(date +%Y%m%d)"
    log_file="${LOG_DIR}/${today}.log"
    if [ ! -f "${log_file}" ]; then
        echo "[-] 오늘자 로그 파일이 없습니다: ${log_file}"
        exit 1
    fi
    tail -f "${log_file}"
}

case "$1" in
    start)
        do_start
        ;;
    stop)
        do_stop
        ;;
    restart)
        do_stop
        do_start
        ;;
    status)
        do_status
        ;;
    logs)
        do_logs
        ;;
    *)
        echo "사용법: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
