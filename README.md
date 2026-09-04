# 급구 카카오톡 채널 친구 수 기록

**10분마다** [급구 채널](https://pf.kakao.com/_WUtxjM)의 친구 수를 Google Sheets에 한 줄씩 기록합니다.
Google Apps Script(시트 내장)에서 돌기 때문에 PC도 GitHub도 필요 없습니다.
GitHub Actions 버전은 `apps-script/` 로 옮기면서 비활성화했습니다.

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

- `delta` — 직전 기록 대비 증감(= 대개 10분 전). 첫 기록이면 빈 값. 감소하면 음수로 찍힙니다.
- **10분마다 한 줄**이 원칙입니다. 중복 판정은 `SLOT_MINUTES`(5분) 구간 단위로 하고, 같은 구간에 이미 기록이 있으면 새 행 대신 그 줄을 갱신합니다.
- 구간을 실행 주기(10분)의 **절반**으로 잡은 이유: 같게 잡으면 트리거가 몇 초만 흔들려도 두 실행이 같은 구간에 들어가 측정값 하나가 덮여 사라집니다. 절반이면 정상 실행끼리는 절대 겹치지 않으면서, 실수로 연달아 돌린 경우는 여전히 중복이 안 쌓입니다. (10분 간격 전 구간 1,440분 전수 확인 결과 충돌 0건)
- **시각 값은 읽을 때 반드시 정규화합니다.** 시트가 `"09:31:45"` 를 시각 타입으로 저장했다가 텍스트 서식이 적용되면 표시 문자열 `"9:31:45"` 로 돌아옵니다(앞자리 0이 떨어짐). 고정 위치로 잘라 쓰면 `"9::00"` 같은 깨진 키가 나오고, 그 키가 문자 비교에서 정상 키보다 크게 정렬돼 해당 행들이 통째로 '미래'로 분류됩니다. 그러면 증감 비교 대상이 엉뚱한 행이 되어 delta 가 누적됩니다. 실제로 2026-09-03~04 의 00~09 시 기록 118행이 이 문제로 틀어져 재계산했습니다. `normTime_` / `norm_time` 이 이를 막습니다.
- 지난 구간을 수동으로 다시 돌려도, 비교 대상은 그 **앞** 구간 기록입니다(뒤쪽 행과 비교해 엉뚱한 값이 찍히지 않도록).
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
- **더 짧은 간격은 GitHub Actions로 불가능합니다.** 크론 하한이 5분입니다. 1분 단위가 필요하면 Google Apps Script나 상시 가동 서버를 쓰세요.
- **이 저장소는 공개라 Actions 사용량이 무료입니다**(GitHub 호스팅 러너 기준). 비공개로 되돌리면 무료 한도 월 2,000분을 쓰게 되는데, 매시 실행은 회당 1분 과금 × 720회 = **월 720분**이라 그래도 한도 안입니다. 실측 실행시간은 12~14초지만 GitHub은 job 단위로 분을 올려 계산합니다.
- **공개 저장소는 60일간 저장소 활동이 없으면 예약 실행이 자동으로 꺼집니다.** 예약 실행 자체는 활동으로 안 쳐줍니다. 그래서 워크플로 마지막에 keepalive 스텝을 두어, 마지막 커밋이 `KEEPALIVE_AFTER_DAYS`(기본 45일)보다 오래됐을 때만 빈 커밋을 하나 남깁니다. 평소 실행에서는 아무것도 하지 않습니다.
- 조회에 실패하면 워크플로가 **실패로 끝나므로** GitHub에서 알림 메일이 옵니다. 조용히 빈 값이 쌓이지 않습니다.

## 대안: Google Apps Script (`apps-script/Code.gs`)

GitHub Actions 예약 실행이 자주 밀리거나 건너뛰면 이쪽으로 옮길 수 있습니다.
코드가 스프레드시트 안에서 직접 돌기 때문에 **서비스 계정·JSON 키·GitHub 저장소가 전혀 필요 없습니다.**

설치는 세 단계입니다:

1. 스프레드시트 → **확장 프로그램 → Apps Script**
2. `apps-script/Code.gs` 내용을 통째로 붙여넣고 저장
3. 함수 목록에서 `setupTrigger` 선택 → 실행 (권한 승인 1회). 주기를 바꿀 때도 이 함수를 다시 실행하면 됩니다.

기록 형식과 중복 판정 규칙은 GitHub Actions 버전과 **동일합니다**. 두 구현의
`buildRow_` / `build_row` 는 같은 입력에 같은 결과를 내도록 교차 검증했습니다.

| | GitHub Actions | Apps Script |
|---|---|---|
| 최소 간격 | 5분 | 1분 |
| 밀림·누락 | 부하 시 건너뛰기도 함 | 거르지 않고 꾸준히 |
| 비용 | 공개 저장소는 무료 | 무료 (한도 초과 시 과금 아니라 중단) |
| 한도 | — | 10분 간격 = 하루 144회 ≈ 7분/일. Workspace 한도 6시간/일의 약 2% |
| 필요한 것 | 저장소 + 시크릿 + 서비스 계정 | 없음 |

**둘을 동시에 켜두지 마세요.** 같은 시간대에 둘 다 쓰면 서로 덮어쓰기만 할 뿐
데이터가 깨지지는 않지만, 실행이 두 배로 낭비됩니다. 옮길 때는 GitHub 워크플로의
`schedule` 을 지우거나 Actions 탭에서 `Disable workflow` 하세요.

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
