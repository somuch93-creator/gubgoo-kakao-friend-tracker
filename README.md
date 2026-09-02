# 급구 카카오톡 채널 친구 수 기록

**매시 정각(KST)** 마다 [급구 채널](https://pf.kakao.com/_WUtxjM)의 친구 수를 Google Sheets에 한 줄씩 기록합니다.
GitHub Actions에서 돌기 때문에 PC를 켜둘 필요가 없습니다.

## 어떻게 가져오나

카카오톡 채널 홈이 내부적으로 쓰는 공개 엔드포인트를 그대로 읽습니다. **로그인·API 키·크롤링 도구가 필요 없습니다.**

```
GET https://pf.kakao.com/rocket-web/web/v2/profiles/_WUtxjM
→ cards[type=profile].profile.friend_count
```

채널 관리자센터에서 **친구 수 공개**가 꺼지면 이 값이 내려오지 않습니다. 그때는 스크립트가 에러로 종료됩니다.

## 기록 형식

| date | time | channel | channel_id | friend_count | delta |
|---|---|---|---|---|---|
| 2026-09-02 | 10:00:12 | 급구 | _WUtxjM | 699000 | |
| 2026-09-02 | 11:00:09 | 급구 | _WUtxjM | 699050 | 50 |
| 2026-09-02 | 12:00:07 | 급구 | _WUtxjM | 699041 | -9 |

- `delta` — 직전 기록 대비 증감(= 대개 한 시간 전). 첫 기록이면 빈 값. 감소하면 음수로 찍힙니다.
- 한 시간에 한 줄입니다. **같은 시간대에 두 번 실행하면 새 행이 아니라 그 줄을 갱신**합니다(수동 재실행해도 중복이 안 쌓임).
- 지난 시간대를 수동으로 다시 돌려도, 비교 대상은 그 **앞** 시간대 기록입니다(뒤쪽 행과 비교해 엉뚱한 값이 찍히지 않도록).
- `channel_id` 로 구분하므로 나중에 다른 채널을 같은 시트에 추가해도 섞이지 않습니다.
- `date` 는 일부러 **텍스트**로 저장합니다. 날짜 타입으로 넣으면 시트 로케일에 따라 표시 형식이 바뀌어서, 다음 실행 때 "같은 시간대 기록이 이미 있는지" 비교가 깨지고 중복 행이 쌓입니다. `friend_count` 와 `delta` 는 숫자로 저장되니 차트·수식에 그대로 쓸 수 있습니다.

---

## 설정 (최초 1회, 약 10분)

### 1. Google Sheets 준비

1. 새 스프레드시트를 만듭니다. 주소창의 `docs.google.com/spreadsheets/d/`**`이_부분`**`/edit` 이 **시트 ID** 입니다.
2. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만들고 **Google Sheets API**를 사용 설정합니다.
3. **사용자 인증 정보 → 서비스 계정 만들기** → 만든 계정의 **키 → 키 추가 → JSON** 으로 키 파일을 받습니다.
4. JSON 안의 `client_email`(`...@....iam.gserviceaccount.com`)을 복사해, **1번 스프레드시트의 공유 버튼 → 편집자로 추가**합니다.
   > 이 단계를 빠뜨리면 `PermissionError` 가 납니다. 가장 흔한 실수입니다.

### 2. GitHub 저장소에 올리기

```bash
git init
git add .
git commit -m "카카오 채널 친구 수 일별 기록 추가"
git branch -M main
git remote add origin https://github.com/<계정>/<저장소>.git
git push -u origin main
```

> 서비스 계정 JSON 키는 `.gitignore` 로 막아뒀습니다. **절대 커밋하지 마세요.**

### 3. Actions 시크릿·변수 등록

저장소 → **Settings → Secrets and variables → Actions**

**Secrets** 탭 (New repository secret):

| 이름 | 값 |
|---|---|
| `GOOGLE_SHEET_ID` | 1번에서 복사한 시트 ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 받은 JSON 키 **파일 내용 전체**를 그대로 붙여넣기 |

**Variables** 탭 (New repository variable):

| 이름 | 값 |
|---|---|
| `KAKAO_CHANNEL_ID` | `_WUtxjM` |
| `WORKSHEET_NAME` | `friend_count` (선택, 비우면 이 값이 기본) |

### 4. 동작 확인

저장소 → **Actions → 카카오 채널 친구 수 기록 → Run workflow** 로 수동 실행해서 시트에 한 줄 들어오는지 확인합니다.
이후로는 매시 정각에 자동으로 돕니다.

---

## 알아둘 것

- **실행 시각은 정확히 정각이 아닙니다.** GitHub Actions 크론은 전체 부하에 따라 수 분~수십 분 늦게 시작되고, 부하가 아주 높으면 **아예 건너뛰기도 합니다**(공식 문서 명시). 시간 단위 추이용으로는 문제없지만, 분 단위 정확도가 필요하면 다른 실행 환경이 필요합니다.
- **더 짧은 간격은 GitHub Actions로 불가능합니다.** 크론 하한이 5분이고, 5분 간격이면 비공개 저장소 기준 월 8,600분가량이라 무료 한도(2,000분)를 크게 넘겨 과금됩니다. 1분 단위가 필요하면 Google Apps Script나 상시 가동 서버를 쓰세요.
- **비공개 저장소는 Actions 무료 사용량(월 2,000분)을 씁니다.** 매시 실행은 회당 1분 미만 × 720회 = **월 720분** 정도로 한도 안입니다.
- 스케줄 자동 중지(60일 무활동)는 **공개 저장소에만** 적용됩니다. 이 저장소는 비공개라 해당 없습니다.
- 조회에 실패하면 워크플로가 **실패로 끝나므로** GitHub에서 알림 메일이 옵니다. 조용히 빈 값이 쌓이지 않습니다.

## 로컬에서 확인하기

지금 친구 수만 빠르게 보고 싶을 때:

```bash
curl -s "https://pf.kakao.com/rocket-web/web/v2/profiles/_WUtxjM" | grep -o '"friend_count":[0-9]*'
```

시트에 쓰지 않고 스크립트만 테스트:

```bash
pip install -r requirements.txt
KAKAO_CHANNEL_ID=_WUtxjM python scripts/track_kakao_friends.py --dry-run
```

`scripts/track-kakao-friends.ps1` 은 같은 일을 하는 PowerShell 버전입니다(시간 단위 기준도 동일). 의존성 없이 로컬 CSV에 기록하며, GitHub 없이 로컬에서 굴려야 할 때를 대비해 남겨뒀습니다.
