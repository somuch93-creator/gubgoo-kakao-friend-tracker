/**
 * 급구 카카오톡 채널 친구 수 기록 — Google Apps Script 버전
 *
 * GitHub Actions 버전과 동일한 일을 한다. 다만 코드가 스프레드시트 안에서
 * 직접 돌기 때문에 서비스 계정·JSON 키·GitHub 저장소가 전혀 필요 없다.
 *
 * 설치:
 *   1) 스프레드시트 → 확장 프로그램 → Apps Script
 *   2) 이 파일 내용을 통째로 붙여넣고 저장
 *   3) 함수 목록에서 setupTrigger 선택 후 실행 (권한 승인 1회)
 *
 * 무료. 10분 간격이면 하루 144회 x 수 초 = 약 7분/일 로,
 * 트리거 한도(개인 90분/일, Workspace 6시간/일)에 한참 못 미친다.
 */

const CHANNEL_ID = '_WUtxjM';           // 채널 URL(pf.kakao.com/_WUtxjM)의 마지막 조각
const SHEET_NAME = 'friend_count';

// 실행 주기(분). Apps Script 트리거는 1·5·10·15·30 만 허용한다.
const TRIGGER_MINUTES = 10;
// 중복 판정 구간(분). 이 구간 안에 이미 기록이 있으면 새 행 대신 그 행을 갱신한다.
// 일부러 실행 주기의 절반으로 잡았다. 같으면 트리거가 몇 초만 흔들려도 두 실행이
// 같은 구간에 들어가 측정값 하나가 덮여 사라진다. 절반이면 정상 실행끼리는
// 절대 겹치지 않으면서, 실수로 연달아 돌린 경우는 여전히 중복이 안 쌓인다.
const SLOT_MINUTES = TRIGGER_MINUTES / 2;
const TZ = 'Asia/Seoul';
const HEADER = ['date', 'time', 'channel', 'channel_id', 'friend_count', 'delta'];


/** 트리거가 호출하는 진입점. */
function recordFriendCount() {
  const profile = fetchProfile_(CHANNEL_ID);
  const sheet = getSheet_();

  const now = new Date();
  const today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  const time = Utilities.formatDate(now, TZ, 'HH:mm:ss');

  // 헤더를 뺀 데이터 행만.
  // date/time 은 시트가 날짜·시각 타입으로 돌려줄 수 있어 String() 으로 뭉개기 전에
  // 정규화한다. 그냥 String(Date) 하면 "Thu Sep 04 2026 ..." 이 되어 비교가 깨진다.
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1).map(function (r) {
    return [normDate_(r[0]), normTime_(r[1]),
            String(r[2] == null ? '' : r[2]), String(r[3] == null ? '' : r[3]),
            String(r[4] == null ? '' : r[4]), String(r[5] == null ? '' : r[5])];
  });

  const result = buildRow_(rows, CHANNEL_ID, profile.name, profile.count, today, time);

  // appendRow 대신 setValues 를 쓴다. appendRow 는 값을 파싱해 "09:31:45" 를
  // 시각 타입으로 바꿔 버리는데, 텍스트 서식이 걸린 범위에 setValues 하면
  // 문자열이 그대로 남는다.
  const targetRow = result.existingRowNumber || (sheet.getLastRow() + 1);
  sheet.getRange(targetRow, 1, 1, HEADER.length).setValues([result.row]);

  if (result.existingRowNumber) {
    Logger.log('%s행 갱신 — %s 친구 %s명', String(targetRow), profile.name, String(profile.count));
  } else {
    Logger.log('%s행 추가 — %s 친구 %s명 (직전 대비 %s)', String(targetRow), profile.name, String(profile.count), String(result.row[5]));
  }
}


function pad2_(v) {
  return ('0' + String(v).replace(/[^0-9]/g, '')).slice(-2);
}


/** 시트에서 읽은 날짜 값을 'YYYY-MM-DD' 로 정규화한다. 시각 타입으로 저장돼 있으면 Date 로 돌아온다. */
function normDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v == null ? '' : v).trim();
}


/**
 * 시트에서 읽은 시각 값을 'HH:mm:ss' 로 정규화한다.
 *
 * 왜 필요한가: 시트가 "09:31:45" 를 시각 타입으로 저장했다가 텍스트 서식이
 * 적용되면서 표시 문자열 "9:31:45" 로 되돌아오는 일이 있다. 앞자리 0이 떨어진다.
 * 예전처럼 고정 위치로 잘라 쓰면 "9:31:45" 에서 시=" 9:" 분="1:" 처럼 깨진 키가
 * 나오고, 그 키가 문자 비교에서 정상 키보다 크게 정렬돼 해당 행들이 통째로
 * '미래'로 분류된다. 그러면 증감 비교 대상이 엉뚱한 행이 되어 delta 가 누적된다.
 * (2026-09-03 ~ 09-04 의 00~09 시 기록이 실제로 이 문제로 틀어졌다.)
 */
function normTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm:ss');
  const parts = String(v == null ? '' : v).trim().split(':');
  if (parts.length < 2) return '';
  return pad2_(parts[0]) + ':' + pad2_(parts[1]) + ':' + (parts.length > 2 ? pad2_(parts[2]) : '00');
}


/** 'YYYY-MM-DD' + 'HH:MM:SS' 를 SLOT_MINUTES 단위 구간 키로. 예) 5분 단위면 14:23 -> "... 14:20" */
function slotKey_(dateStr, timeStr) {
  const t = normTime_(timeStr);
  const d = normDate_(dateStr);
  if (!t) return d + ' ??';
  const slot = Math.floor(parseInt(t.substring(3, 5), 10) / SLOT_MINUTES) * SLOT_MINUTES;
  return d + ' ' + t.substring(0, 2) + ':' + pad2_(slot);
}


/**
 * 기록할 행과, 같은 구간 기존 행의 번호를 계산한다.
 *
 * 순수 함수라 Apps Script 밖에서도 그대로 테스트할 수 있게 분리해 뒀다.
 * 규칙은 SLOT_MINUTES 단위 구간마다 한 줄:
 *   - 새로운 구간  -> 새 행 추가
 *   - 같은 구간    -> 그 행을 갱신 (중복 방지)
 * 증감 비교 대상은 '현재 구간보다 앞선 기록 중 가장 최근 것'이다.
 * 단순히 마지막 행과 비교하면, 지난 구간을 다시 돌렸을 때
 * 뒤쪽(더 나중) 행과 비교해 엉뚱한 값이 찍힌다.
 */
function buildRow_(rows, channelId, channelName, count, today, time) {
  const currentKey = slotKey_(today, time);

  function keyOf(r) { return slotKey_(r[0], r[1]); }

  const mine = rows.filter(function (r) { return r.length >= 5 && r[3] === channelId; });

  // 정렬 비교도 정규화한 값으로 해야 한다. 원본 문자열끼리 비교하면
  // "9:51:46" > "10:01:46" (문자 비교)이 되어 더 오래된 행이 '가장 최근'으로 뽑힌다.
  function sortKey(r) { return normDate_(r[0]) + ' ' + normTime_(r[1]); }

  let previous = null;
  mine.forEach(function (r) {
    if (keyOf(r) >= currentKey) return;
    if (!previous || sortKey(r) > sortKey(previous)) previous = r;
  });
  const delta = previous ? count - Number(previous[4]) : '';

  let existingRowNumber = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.length >= 5 && r[3] === channelId && keyOf(r) === currentKey) {
      existingRowNumber = i + 2;          // 시트는 1-based, 1행은 헤더
      break;
    }
  }

  return {
    row: [today, time, channelName, channelId, count, delta],
    existingRowNumber: existingRowNumber
  };
}


/** 카카오 공개 프로필 API에서 (채널명, 친구 수)를 읽는다. */
function fetchProfile_(channelId) {
  const url = 'https://pf.kakao.com/rocket-web/web/v2/profiles/' + channelId;
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('프로필 조회 실패 (HTTP ' + res.getResponseCode() + '). 채널 ID(' + channelId + ')를 확인하세요.');
  }

  const cards = JSON.parse(res.getContentText()).cards || [];
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].type === 'profile' && cards[i].profile) {
      return { name: String(cards[i].profile.name), count: Number(cards[i].profile.friend_count) };
    }
  }
  throw new Error("프로필 카드를 찾지 못했습니다. 채널 관리자센터에서 '친구 수 공개'가 켜져 있는지 확인하세요.");
}


/** 시트를 확보하고 헤더와 서식을 보장한다. */
function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  if (!sheet.getRange(1, 1).getValue()) {
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  }

  // date/time 열을 '일반'으로 두면 "2026-09-02"가 날짜 타입으로 변환되고,
  // 다시 읽을 때 시트 로케일의 표시 형식으로 돌아온다. 그러면 위 buildRow_ 의
  // '같은 시간대인가' 비교가 조용히 깨져 실행할 때마다 중복 행이 쌓인다.
  // 텍스트(@) 서식으로 고정해 문자열이 그대로 왕복하게 한다.
  sheet.getRange('A:B').setNumberFormat('@');

  return sheet;
}


/** 최초 1회만 실행(주기를 바꿀 때도 다시 실행). 트리거를 건다. */
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'recordFriendCount'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });   // 중복 등록 방지

  ScriptApp.newTrigger('recordFriendCount')
    .timeBased()
    .everyMinutes(TRIGGER_MINUTES)
    .create();

  Logger.log('%s분 간격 트리거 등록 완료', TRIGGER_MINUTES);
  recordFriendCount();          // 바로 한 번 실행해 동작 확인
}


/** 트리거를 모두 제거하고 싶을 때. */
function removeTriggers() {
  const all = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'recordFriendCount'; });
  all.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('트리거 %s개 제거', all.length);
}
