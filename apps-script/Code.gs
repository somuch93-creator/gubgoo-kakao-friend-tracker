/**
 * 급구 카카오톡 채널 친구 수 기록 — Google Apps Script 버전
 *
 * GitHub Actions 버전과 동일한 일을 한다. 다만 코드가 스프레드시트 안에서
 * 직접 돌기 때문에 서비스 계정·JSON 키·GitHub 저장소가 전혀 필요 없다.
 *
 * 설치:
 *   1) 스프레드시트 → 확장 프로그램 → Apps Script
 *   2) 이 파일 내용을 통째로 붙여넣고 저장
 *   3) 함수 목록에서 setupHourlyTrigger 선택 후 실행 (권한 승인 1회)
 *
 * 무료. 시간당 실행 기준 트리거 한도(90분/일)의 약 1%만 쓴다.
 */

const CHANNEL_ID = '_WUtxjM';           // 채널 URL(pf.kakao.com/_WUtxjM)의 마지막 조각
const SHEET_NAME = 'friend_count';
const TZ = 'Asia/Seoul';
const HEADER = ['date', 'time', 'channel', 'channel_id', 'friend_count', 'delta'];


/** 트리거가 호출하는 진입점. */
function recordFriendCount() {
  const profile = fetchProfile_(CHANNEL_ID);
  const sheet = getSheet_();

  const now = new Date();
  const today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  const time = Utilities.formatDate(now, TZ, 'HH:mm:ss');

  // 헤더를 뺀 데이터 행만
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1).map(function (r) { return r.map(String); });

  const result = buildRow_(rows, CHANNEL_ID, profile.name, profile.count, today, time);

  if (result.existingRowNumber) {
    sheet.getRange(result.existingRowNumber, 1, 1, HEADER.length).setValues([result.row]);
    Logger.log('%s행 갱신 — %s 친구 %s명', result.existingRowNumber, profile.name, profile.count);
  } else {
    sheet.appendRow(result.row);
    Logger.log('새 행 추가 — %s 친구 %s명 (직전 대비 %s)', profile.name, profile.count, result.row[5]);
  }
}


/**
 * 기록할 행과, 같은 시간대 기존 행의 번호를 계산한다.
 *
 * 순수 함수라 Apps Script 밖에서도 그대로 테스트할 수 있게 분리해 뒀다.
 * 규칙은 '날짜 + 시' 단위로 한 줄:
 *   - 새로운 시간대  -> 새 행 추가
 *   - 같은 시간대    -> 그 행을 갱신 (중복 방지)
 * 증감 비교 대상은 '현재 시간대보다 앞선 기록 중 가장 최근 것'이다.
 * 단순히 마지막 행과 비교하면, 지난 시간대를 다시 돌렸을 때
 * 뒤쪽(더 나중) 행과 비교해 엉뚱한 값이 찍힌다.
 */
function buildRow_(rows, channelId, channelName, count, today, time) {
  const currentKey = today + ' ' + time.substring(0, 2);

  function keyOf(r) {
    const t = (r[1] && r[1].length >= 2) ? r[1].substring(0, 2) : '??';
    return r[0] + ' ' + t;
  }

  const mine = rows.filter(function (r) { return r.length >= 5 && r[3] === channelId; });

  let previous = null;
  mine.forEach(function (r) {
    if (keyOf(r) >= currentKey) return;
    if (!previous || (r[0] + ' ' + r[1]) > (previous[0] + ' ' + previous[1])) previous = r;
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


/** 최초 1회만 실행. 매시간 트리거를 건다. */
function setupHourlyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'recordFriendCount'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });   // 중복 등록 방지

  // nearMinute(30) 은 매시 30분 ±15분(즉 15~45분) 사이에 실행한다는 뜻.
  // 30분을 고른 이유: 어떻게 흔들려도 같은 시간대 안에 머물러서,
  // 한 시간대에 정확히 한 번만 기록된다. (7분으로 잡으면 -15분이 되어
  // 이전 시간대로 넘어갈 수 있다.)
  ScriptApp.newTrigger('recordFriendCount')
    .timeBased()
    .everyHours(1)
    .nearMinute(30)
    .create();

  Logger.log('매시간 트리거 등록 완료');
  recordFriendCount();          // 바로 한 번 실행해 동작 확인
}


/** 트리거를 모두 제거하고 싶을 때. */
function removeTriggers() {
  const all = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'recordFriendCount'; });
  all.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('트리거 %s개 제거', all.length);
}
