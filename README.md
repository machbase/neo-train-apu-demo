# Machbase Neo · MetroPT-3 철도 압축 공기 처리 장치 상태 진단 데모

MetroPT-3 전체 데이터셋으로 철도 차량의 압축 공기 처리 장치(Air Production Unit, APU)를 탐색하는 Machbase Neo 데모입니다. 영문·한글 화면과 90초 가이드 투어를 제공하며, 공식 공기 누출 발생 구간 전후의 센서 변화와 설명 가능한 건전성 지수를 함께 보여줍니다.

건전성 지수와 파생 경고는 이 프로젝트에서 정의한 설명 가능한 규칙 기반 지표입니다. 머신러닝 정확도나 투자 수익을 주장하지 않으며, 원본 데이터셋이 제공하는 공식 고장 구간과 프로젝트에서 산출한 이벤트를 화면에서 명확히 구분합니다.

## MetroPT-3를 선택한 이유

- 2020년 2월부터 8월까지 수집된 철도 차량 APU 텔레메트리 시점 1,516,948개
- 압력, 온도, 전류, 밸브, 스위치, 임펄스 등 원본 센서 15종과 약 2,275만 개의 센서 값
- 데이터셋 저자가 공개한 공기 누출 고장 구간 4개
- 압축기, 삼상 모터, 사이클론 분리 필터, 드라이어 타워, 저장 탱크, 밸브, 공압 패널과 공기 흐름을 직관적으로 표현할 수 있는 장비 구성
- 재사용이 가능한 [CC BY 4.0 라이선스](https://creativecommons.org/licenses/by/4.0/)

데이터 출처: [UCI Machine Learning Repository의 MetroPT-3](https://archive.ics.uci.edu/dataset/791/metropt%2B3%2Bdataset)

공개된 자료에는 장비가 철도 차량 압축기 APU라는 사실만 명시되어 있습니다. 제조사, 정확한 압축기 모델, 차량 번호와 자산 식별자는 공개되지 않았으므로 이 데모에서도 임의로 설정하지 않습니다.

> CSV에서 실제로 관찰되는 데이터 간격은 약 9~10초(약 0.1Hz)입니다. 데이터셋 설명에 포함된 1Hz 표기와 차이가 있으므로 이 프로젝트는 임의의 샘플링 주파수를 사용하지 않고 실제 시점 1,516,948개를 기준으로 표시합니다. 원본 시간대도 공개되지 않았으므로 원본 시각을 그대로 보존하고 화면에 "데이터셋 현지 시각 · 시간대 미지정"으로 안내합니다.

## 사전 준비

- JSH, 데이터베이스와 서비스 포트를 사용할 수 있는 Machbase Neo 8.5.x
- 최초 데이터 다운로드에 필요한 `git`, `curl`, `sha256sum`, `unzip`
- WebGL을 지원하는 최신 브라우저

아래 절차는 `machbase-neo` 실행 파일이 있는 디렉터리에서 저장소를 복제하여 다음과 같은 구조로 설치하는 것을 기준으로 합니다.

```text
<MACHBASE_NEO_INSTALL_DIR>/
├── machbase-neo
└── neo-train-apu-demo/
```

따라서 프로젝트 디렉터리에서는 Machbase Neo 실행 파일을 `../machbase-neo`로 호출합니다.

## 1. Machbase Neo 설치 디렉터리에서 소스 받기

Machbase Neo가 설치되어 있고 `machbase-neo` 실행 파일이 있는 디렉터리로 이동한 다음 저장소를 복제합니다.

```sh
cd <MACHBASE_NEO_INSTALL_DIR>
git clone https://github.com/machbase/neo-train-apu-demo.git
cd neo-train-apu-demo
```

이후의 모든 명령은 방금 이동한 `neo-train-apu-demo` 프로젝트 디렉터리에서 실행합니다.

## 2. 원본 데이터 다운로드 및 검증

먼저 JSH 다운로드 안내 스크립트를 실행합니다.

```sh
../machbase-neo jsh scripts/download-data.js
```

JSH 메모리에 약 218MB의 파일을 한 번에 올리지 않도록 이 스크립트는 다운로드 명령을 출력만 합니다. 출력된 다음 명령을 현재 셸에서 실행합니다.

```sh
curl -L --fail --output 'data/raw/metropt-3/metropt-3-dataset.zip' \
  'https://archive.ics.uci.edu/static/public/791/metropt%2B3%2Bdataset.zip'

printf '%s  %s\n' \
  'aab991a970e58210de853bb8078ce0e63abb4d9412fdc5c79792dae3d8e1721a' \
  'data/raw/metropt-3/metropt-3-dataset.zip' | sha256sum --check

unzip -j -o 'data/raw/metropt-3/metropt-3-dataset.zip' \
  'MetroPT3(AirCompressor).csv' -d 'data/raw/metropt-3'
```

다운로드와 압축 해제가 끝나면 다음 파일이 생성됩니다.

```text
data/raw/metropt-3/MetroPT3(AirCompressor).csv
```

원본 ZIP과 CSV는 Git에 포함되지 않으며, 스키마를 초기화해도 삭제하지 않습니다.

## 3. MetroPT-3 데이터를 Machbase Neo에 적재

다음 명령은 프로젝트 스키마를 생성하고 전체 CSV를 메모리에 한 번에 올리지 않고 스트리밍 방식으로 적재합니다.

```sh
../machbase-neo jsh scripts/ingest.js
```

기본 데이터베이스 접속 정보는 호스트 `127.0.0.1`, 포트 `5656`, 사용자 `sys`, 암호 `manager`입니다. 다음 환경 변수나 동일한 이름의 명령행 옵션으로 변경할 수 있습니다.

- `IIOT_METRO_DB_HOST` 또는 `--db-host`
- `IIOT_METRO_DB_PORT` 또는 `--db-port`
- `IIOT_METRO_DB_USER` 또는 `--db-user`
- `IIOT_METRO_DB_PASSWORD` 또는 `--db-password`

기존 텔레메트리가 있으면 importer가 덮어쓰기를 거부합니다. 이 프로젝트의 테이블, 롤업과 인덱스만 명시적으로 초기화하고 다시 적재하려면 다음과 같이 실행합니다.

```sh
../machbase-neo jsh scripts/ingest.js --reset
```

최초 적재가 중단된 경우에도 `--reset`을 지정하여 다시 시작합니다. 원본 데이터 파일은 삭제되지 않습니다.

## 4. 데모 서버 실행

### 외부 Bash에서 실행

`neo-train-apu-demo` 프로젝트 디렉터리에서 다음 명령을 실행합니다.

```sh
../machbase-neo jsh app/server.js --host 127.0.0.1 --port 56802
```

### Machbase Neo 내부 JSH 셸에서 실행

Machbase Neo 셸에서 작업 디렉터리를 `work/neo-train-apu-demo`로 이동한 다음 JSH 스크립트를 직접 실행합니다.

```text
work/neo-train-apu-demo > ./app/server.js --host 127.0.0.1 --port 56802
```

서버가 시작되면 브라우저에서 [http://127.0.0.1:56802](http://127.0.0.1:56802)를 엽니다. 루트의 `index.html`과 `main.html`도 이 주소로 자동 이동하며, 자동 이동이 차단되면 화면의 링크를 선택할 수 있습니다.

다른 수신 주소나 포트를 사용하려면 `--host` 또는 `--port` 값을 변경하고 `index.html`과 `main.html`의 접속 주소도 동일하게 맞춰야 합니다.

루트의 `index.html`, `main.html`, `side.html`과 `cgi-bin/api/*.js`는 Machbase Neo 패키지 배포 방식도 지원합니다. 데이터가 없으면 화면에 설치 안내를 표시하며, 합성 데이터나 이전에 남은 데이터를 실제 텔레메트리처럼 표시하지 않습니다.

## 건전성 지수 산식

2020년 2월 한 달을 기준 기간으로 삼아 시간 단위 특성의 p05, p50, p95 분위수를 계산합니다. 최근 1시간 이동 구간은 실제 타임스탬프 간격을 사용하며, 최소 45분의 데이터가 있어야 유효합니다. 데이터 간격이 120초를 초과하면 이동 구간을 초기화합니다.

다음 네 가지 정규화 위험도를 결합하여 건전성 지수를 산출합니다.

```text
높을수록 위험 = clamp((x - p95) / max(3 × (p95 - p50), ε), 0, 1)
낮을수록 위험 = clamp((p05 - x) / max(3 × (p50 - p05), ε), 0, 1)

건전성 지수 = 100 × (1
  - 0.40 × 압력 저하 위험도
  - 0.25 × 압력 회복 위험도
  - 0.20 × 시간당 기동 횟수 위험도
  - 0.15 × 압축기 부하 운전율 위험도)
```

오일 온도는 운전 상태를 설명하기 위해 화면에 표시하지만 계절 변화의 영향을 줄이기 위해 건전성 산식에서는 제외합니다. 파생 조기 경고는 건전성 지수 60 미만, 비정상 기여 요인 2개 이상인 상태가 3시간 연속 지속될 때 생성됩니다. 위험 상태는 건전성 지수 30 미만, 기여 요인 3개 이상인 상태가 1시간 지속될 때 생성되며, 건전성 지수 70 이상이 3시간 지속되면 회복으로 판단합니다.

이 기준은 검증 가능한 데모 정책이며, 학습된 고장 분류 모델이 아닙니다.

## 데이터 저장 구조와 API

`IIOT_METRO_TIMELINE`은 `value JSON SUMMARIZED WITH ROLLUP`을 사용하는 Machbase 태그 테이블입니다. 데이터셋 `metropt-3-uci-791`, 자산 `apu-01` 아래에 `telemetry`, `baseline`, `event` 형식의 JSON 행을 저장합니다.

Machbase Neo는 전체 JSON 값을 대상으로 SEC, MIN, HOUR 롤업 계층을 자동으로 관리합니다. API는 한 번의 `AVG(value)` 쿼리로 모든 숫자 필드를 집계한 뒤 사용자가 선택한 센서만 추출합니다. JSON 경로 인덱스는 행 종류, 이벤트 종류, 이벤트 출처와 건전성 등급 조회에 사용합니다.

읽기 전용 API는 다음과 같습니다.

- `GET /api/health`
- `GET /api/manifest`
- `GET /api/frame?time=...` (`seek=next|prev`로 텔레메트리 공백을 건너뛰어 다음 또는 이전 데이터를 조회)
- `GET /api/window?from=...&to=...&limit=...`
- `GET /api/signals?from=...&to=...&signals=reservoirs,health_score&limit=...`
- `GET /api/events?from=...&to=...&limit=...`

모든 데이터 응답에는 SQL, 바인딩 값, 대상 테이블, 결과 예시, 실제 쿼리 시간과 롤업 간격이 증거 정보로 포함됩니다. 센서 이름은 허용 목록으로 제한하며 API 입력값이 임의의 SQL 표현식으로 사용되지 않도록 처리합니다.

## 검증

JSH 호환 자체 검사를 실행합니다.

```sh
../machbase-neo jsh scripts/selftest.js
```

전체 적재가 끝나면 요약 결과에서 다음 내용을 확인합니다.

- 텔레메트리 행 1,516,948개
- 원본 시각 범위 `2020-02-01 00:00:00`~`2020-09-01 03:59:50`
- 2020년 2월 기준선
- 공식 공기 누출 구간 4개
- 문서에 기술한 지속 조건으로 산출된 파생 이벤트

## 프로젝트 구성

```text
app/server.js          JSH HTTP 서버, 기본 포트 56804
cgi-bin/api/           Machbase Neo 패키지 호환 API 진입점
lib/api.js             읽기 전용 데이터베이스 조회 및 증거 정보 생성
lib/metro.js           시각 처리, 이동 특성, 건전성 산식, 이벤트 지속 조건
lib/schema.js          태그 테이블, JSON 롤업과 JSON 인덱스
scripts/               다운로드 안내, 스키마, 스트리밍 적재, 자체 검사
public/                영문·한글 UI, Three.js APU 장면, 차트와 타임라인
```

Three.js와 OrbitControls는 프로젝트에 포함되어 있으므로 실행 중에는 인터넷 연결이 필요하지 않습니다. MetroPT-3 원본 데이터는 이 저장소에서 재배포하지 않으므로 데모 또는 파생 자료를 배포할 때 UCI 출처를 유지해야 합니다.
