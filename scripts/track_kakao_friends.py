#!/usr/bin/env python3
"""카카오톡 채널의 친구 수를 매일 Google Sheets에 한 줄씩 기록한다.

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


def build_row(rows: list[list[str]], channel_id: str, channel_name: str,
              count: int, now: datetime) -> tuple[list, int | None]:
    """기록할 행과, 오늘자 기존 행의 번호(없으면 None)를 반환한다."""
    today = now.strftime("%Y-%m-%d")

    same_channel = [r for r in rows if len(r) >= 5 and r[3] == channel_id]
    previous = next((r for r in reversed(same_channel) if r[0] != today), None)
    delta = count - int(previous[4]) if previous else ""

    existing_row_number = None
    for index, row in enumerate(rows, start=2):  # 시트 2행부터 데이터
        if len(row) >= 5 and row[3] == channel_id and row[0] == today:
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
    # 그러면 아래 build_row 의 '오늘 기록이 이미 있는가' 비교가 조용히 깨져
    # 매일 중복 행이 쌓인다. 숫자 컬럼은 RAW 에서도 숫자로 저장되므로 손해가 없다.
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
    print(f"[INFO] {action} 완료 — 전일 대비 {delta_text}")


if __name__ == "__main__":
    main()
