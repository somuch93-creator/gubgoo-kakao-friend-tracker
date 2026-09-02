#!/usr/bin/env python3
"""카카오톡 채널의 친구 수를 일정 주기마다 한 줄씩 Google Sheets에 기록한다.

카카오톡 채널 홈(pf.kakao.com)이 공개적으로 사용하는 프로필 API를 그대로 읽는다.
로그인이나 API 키가 필요 없고, 채널 설정에서 '친구 수 공개'만 켜져 있으면 된다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

KST = ZoneInfo("Asia/Seoul")
PROFILE_API = "https://pf.kakao.com/rocket-web/web/v2/profiles/{channel_id}"
HEADER = ["date", "time", "channel", "channel_id", "friend_count", "delta"]

# 실행 주기(분)와 중복 판정 구간(분). Apps Script 버전(apps-script/Code.gs)과 값을 맞춰 둔다.
# 구간을 주기의 절반으로 잡는 이유: 같으면 실행이 몇 초만 흔들려도 두 실행이 같은
# 구간에 들어가 측정값 하나가 덮여 사라진다. 절반이면 정상 실행끼리는 겹치지 않는다.
TRIGGER_MINUTES = 10
SLOT_MINUTES = TRIGGER_MINUTES // 2
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"[ERROR] 환경변수 {name} 가 비어 있습니다.")
    return value


def normalize_channel_id(raw: str) -> str:
    """'_abcdEF', 'abcdEF', 'https://pf.kakao.com/_abcdEF/chat' 을 모두 '_abcdEF' 로."""
    channel_id = raw.strip().rstrip("/").split("?")[0]
    if "pf.kakao.com/" in channel_id:
        channel_id = channel_id.split("pf.kakao.com/")[1].split("/")[0]
    if not channel_id.startswith("_"):
        channel_id = "_" + channel_id
    return channel_id


def fetch_profile(channel_id: str, attempts: int = 3) -> tuple[str, int]:
    """(채널명, 친구 수) 반환. 일시적 네트워크 오류만 재시도한다."""
    url = PROFILE_API.format(channel_id=channel_id)
    headers = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    }

    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(url, headers=headers, timeout=20)
            response.raise_for_status()
            payload = response.json()
            break
        except requests.RequestException as error:
            last_error = error
            if attempt < attempts:
                time.sleep(2 * attempt)
    else:
        sys.exit(f"[ERROR] 프로필 조회 실패: {last_error}")

    for card in payload.get("cards", []):
        profile = card.get("profile")
        if card.get("type") == "profile" and profile:
            return str(profile.get("name", "")), int(profile["friend_count"])

    sys.exit(
        f"[ERROR] 프로필 카드를 찾지 못했습니다. 채널 ID({channel_id})가 맞는지, "
        "채널 관리자센터에서 '친구 수 공개'가 켜져 있는지 확인하세요."
    )


def open_worksheet(sheet_id: str, worksheet_name: str):
    import gspread
    from google.oauth2.service_account import Credentials

    info = json.loads(require_env("GOOGLE_SERVICE_ACCOUNT_JSON"))
    client = gspread.authorize(Credentials.from_service_account_info(info, scopes=SCOPES))
    spreadsheet = client.open_by_key(sheet_id)

    try:
        worksheet = spreadsheet.worksheet(worksheet_name)
    except gspread.WorksheetNotFound:
        worksheet = spreadsheet.add_worksheet(title=worksheet_name, rows=1000, cols=len(HEADER))

    if not worksheet.row_values(1):
        worksheet.update(range_name="A1:F1", values=[HEADER], raw=True)

    return worksheet


def slot_key(date_str: str, time_str: str) -> str:
    """'YYYY-MM-DD' + 'HH:MM:SS' 를 SLOT_MINUTES 단위 구간 키로. 예) 5분 단위면 14:23 -> '... 14:20'"""
    if not time_str or len(time_str) < 5:
        return f"{date_str} ??"
    try:
        minute = int(time_str[3:5])
    except ValueError:
        return f"{date_str} ??"
    slot = minute // SLOT_MINUTES * SLOT_MINUTES
    return f"{date_str} {time_str[:2]}:{slot:02d}"


def row_key(row: list[str]) -> str:
    return slot_key(row[0], row[1])


def build_row(rows: list[list[str]], channel_id: str, channel_name: str,
              count: int, now: datetime) -> tuple[list, int | None]:
    """기록할 행과, 같은 구간 기존 행의 번호(없으면 None)를 반환한다."""
    today = now.strftime("%Y-%m-%d")
    current = slot_key(today, now.strftime("%H:%M:%S"))

    # 비교 대상은 '현재 구간보다 앞선' 기록 중 가장 최근 것.
    # 단순히 '마지막 행'을 쓰면, 지난 구간을 수동 재실행할 때
    # 뒤쪽(더 나중) 행과 비교해 엉뚱한 증감이 찍힌다.
    same_channel = [r for r in rows if len(r) >= 5 and r[3] == channel_id]
    earlier = [r for r in same_channel if row_key(r) < current]
    previous = max(earlier, key=lambda r: (r[0], r[1]), default=None)
    delta = count - int(previous[4]) if previous else ""

    existing_row_number = None
    for index, row in enumerate(rows, start=2):  # 시트 2행부터 데이터
        if len(row) >= 5 and row[3] == channel_id and row_key(row) == current:
            existing_row_number = index
            break

    row = [today, now.strftime("%H:%M:%S"), channel_name, channel_id, count, delta]
    return row, existing_row_number


def main() -> None:
    parser = argparse.ArgumentParser(description="카카오톡 채널 친구 수 기록")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Google Sheets에 쓰지 않고 조회 결과만 출력",
    )
    args = parser.parse_args()

    channel_id = normalize_channel_id(require_env("KAKAO_CHANNEL_ID"))
    now = datetime.now(KST)

    channel_name, count = fetch_profile(channel_id)
    print(f"[INFO] {channel_name} ({channel_id}) 친구 {count:,}명 @ {now:%Y-%m-%d %H:%M:%S} KST")

    if args.dry_run:
        print("[INFO] --dry-run 이므로 시트에 쓰지 않습니다.")
        return

    worksheet = open_worksheet(
        require_env("GOOGLE_SHEET_ID"),
        os.environ.get("WORKSHEET_NAME", "friend_count").strip() or "friend_count",
    )
    rows = worksheet.get_all_values()[1:]  # 헤더 제외

    row, existing_row_number = build_row(rows, channel_id, channel_name, count, now)

    # RAW 로 쓰는 이유: USER_ENTERED 는 "2026-09-02" 를 날짜로 파싱해 저장하고,
    # 다시 읽을 때 시트 로케일의 표시 형식("2026. 9. 2." 등)으로 돌려준다.
    # 그러면 build_row 의 '같은 구간 기록이 이미 있는가' 비교가 조용히 깨져
    # 실행할 때마다 중복 행이 쌓인다. 숫자 컬럼은 RAW 에서도 숫자로 저장되므로 손해가 없다.
    if existing_row_number:
        worksheet.update(
            range_name=f"A{existing_row_number}:F{existing_row_number}",
            values=[row],
            raw=True,
        )
        action = f"{existing_row_number}행 갱신"
    else:
        worksheet.append_row(row, value_input_option="RAW")
        action = "새 행 추가"

    delta_text = "(첫 기록)" if row[5] == "" else f"{row[5]:+,}"
    print(f"[INFO] {action} 완료 — 직전 기록 대비 {delta_text}")


if __name__ == "__main__":
    main()
