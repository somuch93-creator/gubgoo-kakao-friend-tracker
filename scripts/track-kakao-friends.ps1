<#
.SYNOPSIS
    카카오톡 채널의 친구 수를 CSV에 한 시간에 한 줄씩 기록합니다.

.DESCRIPTION
    카카오톡 채널 홈(pf.kakao.com)이 공개적으로 사용하는 프로필 API에서
    friend_count 를 읽어 CSV에 append 합니다. 로그인/토큰이 필요 없습니다.
    같은 시간대 기록이 이미 있으면 최신 값으로 덮어씁니다(중복 방지).

.EXAMPLE
    .\track-kakao-friends.ps1 -ChannelId _abcdEF
#>
[CmdletBinding()]
param(
    # 채널 URL(https://pf.kakao.com/_abcdEF)의 마지막 조각. 밑줄 포함/미포함 모두 허용.
    [string]$ChannelId = $env:KAKAO_CHANNEL_ID,

    # 기록할 CSV 경로
    [string]$CsvPath = (Join-Path $PSScriptRoot 'kakao-friends.csv')
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$LogPath = Join-Path $PSScriptRoot 'track-kakao-friends.log'
function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

try {
    if ([string]::IsNullOrWhiteSpace($ChannelId)) {
        throw '채널 ID가 없습니다. -ChannelId _abcdEF 형태로 넘기거나 KAKAO_CHANNEL_ID 환경변수를 설정하세요.'
    }
    # 전체 URL을 붙여넣어도 동작하도록 정규화
    if ($ChannelId -match 'pf\.kakao\.com/([^/?#]+)') { $ChannelId = $Matches[1] }
    if ($ChannelId -notmatch '^_') { $ChannelId = '_' + $ChannelId }

    $uri = "https://pf.kakao.com/rocket-web/web/v2/profiles/$ChannelId"
    Write-Log "조회 시작: $uri"

    $res = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 30 `
        -Headers @{ 'Accept' = 'application/json' } `
        -UserAgent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

    $card = $res.cards | Where-Object { $_.type -eq 'profile' } | Select-Object -First 1
    if (-not $card -or -not $card.profile) {
        throw "프로필 정보를 찾지 못했습니다. 채널 ID($ChannelId)가 맞는지 확인하세요."
    }

    $count = [int]$card.profile.friend_count
    $name  = [string]$card.profile.name
    $now   = Get-Date
    $today = $now.ToString('yyyy-MM-dd')

    # 기존 기록 로드
    $rows = @()
    if (Test-Path $CsvPath) { $rows = @(Import-Csv -Path $CsvPath) }

    # '날짜 + 시' 단위로 한 줄. 같은 시간대에 다시 돌리면 그 줄을 갱신한다.
    $bucket = "$today " + $now.ToString('HH')
    $keyOf = {
        param($r)
        $t = if ($r.time -and $r.time.Length -ge 2) { $r.time.Substring(0, 2) } else { '??' }
        "$($r.date) $t"
    }

    # 비교 대상은 '현재 시간대보다 앞선' 기록 중 가장 최근 것
    $earlier = @($rows | Where-Object {
        $_.channel_id -eq $ChannelId -and (& $keyOf $_) -lt $bucket
    })
    $prev = $earlier | Sort-Object { "$($_.date) $($_.time)" } | Select-Object -Last 1
    $delta = if ($prev) { $count - [int]$prev.friend_count } else { $null }

    # 같은 시간대 중복 행 제거 후 재기록
    $rows = @($rows | Where-Object {
        -not ($_.channel_id -eq $ChannelId -and (& $keyOf $_) -eq $bucket)
    })
    $rows += [pscustomobject][ordered]@{
        date         = $today
        time         = $now.ToString('HH:mm:ss')
        channel      = $name
        channel_id   = $ChannelId
        friend_count = $count
        delta        = $delta
    }

    $rows | Export-Csv -Path $CsvPath -NoTypeInformation -Encoding UTF8

    $deltaText = if ($null -eq $delta) { '(첫 기록)' } elseif ($delta -ge 0) { "+$delta" } else { "$delta" }
    Write-Log ("기록 완료: {0} / 친구 {1:N0}명 / 직전 기록 대비 {2} -> {3}" -f $name, $count, $deltaText, $CsvPath)
    exit 0
}
catch {
    Write-Log $_.Exception.Message 'ERROR'
    exit 1
}
