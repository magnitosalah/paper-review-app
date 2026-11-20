# Paperdesk Codex runner

Paperdesk 웹앱의 `Codex` 선택지를 처리하는 별도 Node 서버다. OpenAI 모델 직접 호출을 Codex로 표시하는 대신, 실제 `codex app-server`를 실행해 JSON-RPC로 질문과 응답을 주고받는다. 사용자의 PC를 켜 둘 필요가 없도록 클라우드 컨테이너/VM에서 운영한다.

## 현재 검증 범위

- 로컬에 설치된 `codex-cli 0.146.0`에서 생성한 `thread/start`, `turn/start` 스키마를 확인했다. Docker도 같은 버전을 고정한다.
- 단위 테스트는 입력 검증, 인증, 요청 중복 방지, RPC 승인 거부, HTTP 스트리밍 계약을 확인한다.
- **실제 OpenAI API 키가 제공되지 않아 모델 응답, 해당 계정의 모델 접근 권한, 원격 호스팅 환경의 sandbox 동작은 아직 검증하지 않았다.** `/health`의 ready는 설정 존재만 뜻하며 실제 모델 연결 성공을 보장하지 않는다.
- Codex가 실패하면 오류를 반환한다. 개발용 가짜 AI 답변이나 다른 모델로의 자동 대체는 없다.

## 배포 구성

1. 이 폴더를 Docker 빌드 컨텍스트로 사용해 Node 서버를 배포한다. Vercel 웹 프로젝트와 별도 서비스다.
2. TLS를 제공하는 프록시/호스팅을 사용해 HTTPS 주소를 만든다. 브라우저는 이 서버에 직접 연결하지 않고 Paperdesk `/api/chat`을 경유한다.
3. 런타임 비밀 저장소에서 아래 환경변수를 설정한다.
4. `/data`에 영구 볼륨을 연결한다. API 호출 전에 영구적인 요청 수신 기록을 작성해 재시작 후 중복 실행을 막는다.
5. Vercel에 `CODEX_RUNNER_URL`(예: `https://runner.example.com`, `/v1/chat` 제외), 같은 `CODEX_RUNNER_SECRET`, 동일한 `CODEX_MODELS`를 설정한다.

| 환경변수 | 의미 |
| --- | --- |
| `OPENAI_API_KEY` | Codex 실행용 OpenAI Platform API 키 |
| `CODEX_RUNNER_SECRET` | 웹 서버와 runner가 공유하는 32자 이상의 무작위 비밀값 |
| `CODEX_MODELS` | 이 계정에서 실제 사용을 확인한 모델 ID 목록, 쉼표 구분 |
| `CODEX_RUNNER_DATA_DIR` | 요청 상태·완료 답변을 보관할 영구 디렉터리, 컨테이너 기본 `/data` |
| `CODEX_MAX_CONCURRENT` | 동시 실행 제한, 기본 2, 최대 4 |
| `CODEX_BINARY` | 필요할 때만 Codex 실행 파일의 절대 경로 |
| `PORT` | 내부 HTTP 포트, 기본 8080 |

API 키는 Docker 이미지, Git, 프론트엔드 번들에 넣지 않는다. API 사용 비용은 연결한 OpenAI Platform 계정에 적용된다. 개인 Codex/ChatGPT 로그인 캐시를 복사하지 않는다. 코드에서는 표준 OpenAI API 키를 사용하는 명시적인 Responses 모델 제공자 설정으로 App Server를 실행한다. ChatGPT 구독 기반 로그인은 구현하지 않았다. 공개 서비스로 운영하기 전에는 사용하려는 인증·호스팅 형태의 최신 허용 조건을 확인해야 한다. [공식 인증 문서](https://learn.chatgpt.com/docs/auth), [App Server 인증 안내](https://learn.chatgpt.com/docs/app-server#auth-endpoints)

## 실행과 제한

```sh
node server.mjs
node --test runner.test.mjs
```

각 요청은 새로운 격리된 임시 작업 폴더와 `CODEX_HOME`에서 시작한다. 앱이 보관한 대화 텍스트를 전달하므로 서버 재시작 후에도 기존 대화 문맥을 앱에서 다시 제공할 수 있다. 기존 Codex 데스크톱 채팅과 자동 동기화하지 않는다.

셸·브라우저·앱·플러그인·하위 에이전트 관련 기능을 비활성화하고 읽기 전용 sandbox, 도구 네트워크 금지, 승인 불가 정책을 지정한다. 추가 도구 실행 이벤트 또는 승인 요청이 오면 응답을 중단한다. 호스팅에서도 비관리자 계정과 격리된 컨테이너를 유지한다. sandbox 초기화가 실패할 경우 우회하거나 권한을 완화하지 않는다. [공식 App Server 프로토콜](https://learn.chatgpt.com/docs/app-server)

요청은 최대 100초 실행된다. 연결 중단은 해당 실행을 중단하고 부분 답변 상태를 보관한다. 완료 신호를 받기 전 연결이 끊겼다면 웹앱의 `GET /api/chat?requestId=...`로 확인한다. 완료 여부가 불명확한 요청은 자동 재실행하지 않는다. 사용자가 명시적으로 다시 시도할 때 새 요청 ID를 사용한다.

영구 볼륨에는 요청 ID·본문 해시·상태·완료 또는 부분 답변이 남는다. 서비스 관리자만 접근하게 하고, 운영 시 보관 기간과 삭제 작업을 정한다. 볼륨을 지우면 runner 수준의 이전 요청 중복 방지 기록도 사라진다. 웹앱은 Google Drive의 `appDataFolder`에 요청 기록을 별도로 유지한다.

## 내부 HTTP 계약

- `GET /health`: 설정 존재 여부. 키·모델 목록·본문은 노출하지 않는다.
- `POST /v1/chat`: `Authorization: Bearer <CODEX_RUNNER_SECRET>` 필수.
- 본문: `{requestId, model, system, messages: [{role: "user" | "assistant", content}]}`.
- 응답: `application/x-ndjson`; `{type:"delta",text}`, `{type:"done"}`, `{type:"error",message}`.
- 같은 ID와 같은 본문의 완료 요청은 저장된 답변을 반환한다. 처리 중·실패·중단된 ID 또는 다른 본문으로 재사용한 ID는 `409`를 반환한다.
- Paperdesk API는 인증된 사용자 ID와 브라우저 요청 ID를 함께 해시해 runner ID를 생성한다. 서로 다른 사용자의 요청을 공유하지 않는다.

## 관련 제공자 API

웹앱의 Gemini와 Claude는 runner를 거치지 않고 서버 측 공식 API를 사용한다. Gemini는 `streamGenerateContent` SSE, Claude는 Messages API SSE를 읽는다. 모든 허용 모델은 환경변수로 설정한다. [Gemini API](https://ai.google.dev/api/generate-content), [Claude 스트리밍 API](https://platform.claude.com/docs/en/build-with-claude/streaming)
