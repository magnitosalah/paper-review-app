# Paperdesk 실행과 배포

논문 PDF를 읽고 문장을 스크랩해 Gemini·Claude·Codex에 질문하는 웹앱입니다. **기본 저장소는 사용자의 Google Drive**입니다. Supabase 프로젝트나 별도 데이터베이스를 만들 필요가 없습니다.

## 로컬 실행

검증 환경은 Node.js 24입니다. 저장소 루트에서 다음 명령을 실행합니다.

```powershell
cd paperdesk
npm ci
Copy-Item .env.example .env.local
npm run dev
```

[로컬 앱](http://127.0.0.1:3000)을 엽니다. 설정값이 없어도 이 브라우저의 로컬 서재와 직접 작성한 샘플 PDF를 사용할 수 있습니다. 이 상태에서는 기기 동기화·실제 AI 연결을 완료했다고 표시하지 않습니다.

```powershell
npm run typecheck
npm test
npm run build
node --test codex-runner/runner.test.mjs
```

PDF.js worker·문자맵·폰트·WASM은 `postinstall`에서 설치된 패키지 버전에 맞춰 복사합니다. 생성 파일은 Git에 올리지 않습니다.

## 저장 위치

| 자료 | 저장 위치 |
| --- | --- |
| 내 기기에서 가져온 PDF | Google 연결 후 Drive의 `Paperdesk` 폴더에 업로드 |
| 원래 Drive에 있던 PDF | 선택한 원본 파일을 그대로 연결 |
| 스크랩·대화·출처·읽기 위치 | Drive의 앱 전용 `appDataFolder` 안 JSON 기록 |
| 미전송 변경·기기 캐시 | 계정별 IndexedDB |

앱 기록은 변경 작업을 새 JSON으로 추가하고 읽어 병합하는 방식입니다. 두 기기가 하나의 JSON 전체를 덮어쓰는 방식으로 사용하지 않습니다. Drive API의 저장 성공이 확인된 뒤에만 동기화 완료를 표시합니다. 로컬에서 아직 전송하지 못한 자료는 해당 기기에 남습니다.

연결 전의 로컬 서재와 Google 계정 서재는 구분합니다. 연결 전에 가져온 자료를 계정에 자동 합치지 않으므로, 기기 간에 사용할 PDF는 Google 연결 후 가져옵니다. 연결한 계정에서 발생한 미전송 변경은 재연결 후 저장을 이어갑니다.

### 새로고침하거나 다른 기기에서 이어 읽기

현재 버전은 **페이지 새로고침(F5)이나 탭을 닫았다 다시 열 때에도 Google 연결을 다시 해야 합니다.** 처음에는 이 브라우저의 로컬 서재가 표시됩니다. 계정 서재가 바로 보이지 않아도 Drive에 저장한 논문·기록이 삭제된 것은 아닙니다.

1. `연결 설정`에서 `Google Drive로 연결`을 누릅니다.
2. 자료를 저장했던 **같은 Google 계정**을 선택합니다.
3. `Google Drive 동기화 완료`를 확인한 뒤 계정 서재에서 논문을 엽니다.

이미 연결한 화면에서 토큰이 만료되면 `연결 설정 → Google 다시 연결`을 누릅니다. PC에서 폰으로 옮기기 전에는 PC의 동기화 완료를 확인하고, 폰에서도 같은 운영 URL과 Google 계정을 사용합니다. 동기화 전의 변경은 작성한 브라우저에만 남아 있으므로 해당 브라우저에서 다시 연결해야 합니다.

`appDataFolder`는 일반 Drive 폴더 목록에 표시되지 않는 앱 전용 공간입니다. 파일 공유용 폴더가 아니며, **일반 `Paperdesk` PDF 폴더와는 다른 저장 위치**입니다. [Google 앱 데이터 문서](https://developers.google.com/workspace/drive/api/guides/appdata)

앱은 공개 공유 링크를 만들 필요가 없습니다. 다른 기기에서 본인의 같은 Google 계정으로 연결하면 됩니다. PDF 폴더를 다른 사람에게 공유하면 그 폴더의 자료에도 공유 권한이 적용될 수 있으므로 개인 서재 폴더의 공유 설정은 그대로 비공개로 유지합니다.

## Google Cloud 최초 설정

**Drive 폴더 공유 링크만으로는 로그인·파일 읽기·기록 쓰기를 연결할 수 없습니다.** 앱이 사용할 Google Cloud 프로젝트의 OAuth client와 Picker API key를 한 번 설정해야 합니다. Google Drive에 가입한 계정 외에 별도 저장소 서비스 가입은 필요하지 않습니다.

1. Google Cloud 프로젝트에서 **Google Drive API**와 **Google Picker API**를 활성화합니다.
2. Google Auth Platform에서 동의 화면을 설정하고, 개인 테스트 단계에서는 사용할 Google 계정을 테스트 사용자로 추가합니다.
3. OAuth client 유형을 **Web application**으로 만들고, 사용할 운영 URL과 `http://127.0.0.1:3000`을 Authorized JavaScript origins에 등록합니다. URL의 경로 없이 origin만 등록합니다.
4. 같은 프로젝트에서 Picker용 API key를 만들고 HTTP referrer/API 제한을 설정합니다. 앱의 로컬·운영 origin과 Picker가 사용하는 `https://docs.google.com/*`을 허용하고, Drive API·Google Picker API로 사용 범위를 제한합니다.
5. 프로젝트 **번호(project number)**를 App ID로 사용합니다. 문자로 된 project ID와 다릅니다.
6. `.env.local`과 Vercel 환경변수에 아래 값을 설정합니다.

| 환경변수 | 값과 사용 위치 |
| --- | --- |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Web OAuth client ID, 브라우저 공개 설정 |
| `NEXT_PUBLIC_GOOGLE_API_KEY` | 제한된 Picker API key, 브라우저 공개 설정 |
| `NEXT_PUBLIC_GOOGLE_APP_ID` | 같은 Google Cloud 프로젝트의 숫자 번호 |
| `ALLOWED_EMAILS` | 사용할 본인 Google 이메일, 쉼표로 구분하는 서버 허용 목록 |

OAuth 요청 범위는 `openid`, `email`, `profile`, `https://www.googleapis.com/auth/drive.file`, `https://www.googleapis.com/auth/drive.appdata`입니다. 선택·생성한 PDF 접근과 앱 기록 저장에 사용합니다. `drive.file`은 읽기 전용 범위가 아니며 앱이 만든 `Paperdesk` 폴더에 PDF를 저장하는 데도 사용됩니다.

현재 연결은 브라우저 메모리에 보관하는 짧은 수명의 access token을 사용합니다. 페이지 새로고침·새 탭 세션·토큰 만료 후에는 사용자가 다시 Google 연결 버튼을 눌러야 합니다. 갱신 토큰을 로컬 저장소나 서버 파일에 보관하지 않습니다. PC와 폰 각각에서 같은 계정을 연결하고 저장 완료를 확인한 뒤 이어 읽습니다. [Google token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)

`NEXT_PUBLIC_` 값은 화면 코드에 포함되는 공개 설정입니다. AI 비밀키나 OAuth 토큰을 이 이름으로 만들거나 Git에 기록하지 마세요. OAuth client secret은 현재 브라우저 token flow 설정에 필요하지 않습니다.

## AI 서비스

사용할 서비스만 서버 환경변수에 설정합니다. 모델 ID는 계정에서 실제 사용할 수 있는 ID를 쉼표로 나열합니다. 모델 허용 목록이 비어 있으면 연결되지 않은 상태로 표시합니다.

```text
GEMINI_API_KEY / GEMINI_MODELS
ANTHROPIC_API_KEY / CLAUDE_MODELS
CODEX_RUNNER_URL / CODEX_RUNNER_SECRET / CODEX_MODELS
```

서버는 Google 인증과 `ALLOWED_EMAILS`를 확인한 뒤 AI 요청을 처리합니다. 허용 목록을 비워 둔 공개 배포에서 임의 방문자가 서버 AI 키를 사용하도록 허용하지 않습니다. localhost 개발 검증에만 `ALLOW_LOCAL_DEV=true`를 사용할 수 있으며 Vercel 운영 배포에서는 사용하지 않습니다.

Codex는 일반 OpenAI 모델 API 호출과 구분된 실제 실행 계층입니다. [runner README](codex-runner/README.md)의 별도 실행 서버와 인증 설정이 필요합니다. Vercel 함수 안에 상시 Codex 프로세스를 띄우지 않습니다. 키가 없을 때 모의 AI 답변으로 대체하지 않습니다.

### 현재 Gemini 사용을 막는 조건

2026-11-20 운영 화면의 `gemini-2.5-flash`·`gemini-3.8-flash` 요청과 직접 API의 `gemini-3.1-flash-lite` 요청이 모두 HTTP 429로 실패했습니다. 마지막 응답은 `Your project has exceeded its monthly spending cap.`입니다. 현재 설정한 세 모델은 같은 프로젝트의 월 지출 한도에 막혀 있으며, **실제 답변 생성에 성공한 모델은 아직 없습니다.**

AI Studio Spend의 실제 화면에서도 사용 중인 프로젝트에 **`₩0 / ₩0`과 `한도 도달`**이 표시되는 것을 확인했습니다. 프로젝트 소유자가 [AI Studio Spend](https://ai.studio/spend)에서 **Monthly spend cap**을 검토하고 재개 방법을 결정해야 합니다. 한도 설정 경로는 [Google 공식 프로젝트 지출 한도 안내](https://aistudio.google.com/docs/billing#project-spend-caps)를 참고하세요. 이 작업에서는 결제나 지출 한도 설정을 변경하지 않았습니다.

## GitHub → Vercel

1. 앱 코드를 GitHub 원격 저장소에 푸시합니다.
2. Vercel에서 저장소를 Import하고 **Root Directory를 `paperdesk`**로 지정합니다.
3. Framework는 Next.js, Install은 `npm ci`, Build는 `npm run build`입니다.
4. Google 공개 설정·`ALLOWED_EMAILS`·사용할 AI 비밀키를 Vercel에 등록하고 배포합니다.
5. 확정된 운영 URL을 Google OAuth origin과 API key의 허용 referrer에 등록합니다.
6. `NEXT_PUBLIC_` 값이 바뀌면 재배포합니다. PC와 폰은 같은 운영 URL을 사용합니다.

앱 재배포와 사용자 기록 저장은 별개입니다. 논문·대화는 본인 Drive에 보관하며, PDF·개인 대화·토큰·API 비밀키는 Git에 올리지 않습니다.

## 검증 범위와 운영 전 확인

로컬 테스트는 PDF 파싱·참고문헌 추출·상태 병합·요청 검증·제공자 응답 처리를 확인합니다. 실제 계정 연결 검증은 아래와 같이 구분합니다. 코드 테스트나 서버 환경변수 등록만으로 실제 서비스 응답을 검증했다고 판단하지 않습니다.

2026-11-20 확인 현황:

| 항목 | 확인한 범위 |
| --- | --- |
| Google OAuth·Drive 기록 저장 | 운영 앱에서 본인 Google 계정으로 연결하고 원본 PDF를 업로드 |
| 독립 브라우저 저장소에서 복원 | 운영 앱과 IndexedDB를 공유하지 않는 localhost origin에서 같은 계정으로 연결해 PDF 본문과 스크랩 1개 복원 |
| 메모 변경 동기화 | 운영 앱에서 바꾼 스크랩 메모가 별도 localhost origin에 반영됨 |
| 읽기 위치 동기화 | 운영 앱에서 2페이지로 이동한 뒤 localhost에서도 2페이지 복원 확인 |
| Google Picker | 실제 파일 선택창에서 업로드한 테스트 PDF를 선택하고 기존 문서 중복 감지 확인 |
| 참고문헌 DOI 검색 | 전체 참고문헌 문자열에 포함된 DOI 추출을 수정하고, 실제 DataCite 검색에서 일치하는 문헌 확인 |
| 참고문헌 기록 동기화 | 확인한 문헌의 제목·초록과 문헌별 대화 연결이 운영 앱에 동기화됨 |
| 실제 PC·폰 사이의 사용 | 실제 Android·iPhone에서의 파일 선택·터치·인증·연속 사용은 별도 확인 필요 |
| Gemini | 운영 서버 설정·공식 모델 목록 조회 성공. 설정한 세 모델의 요청은 프로젝트 월 지출 한도로 HTTP 429, 정상 답변 수신은 미확인 |
| 실패한 대화 기록 복원 | 운영 앱의 Gemini 2.5·3.8 실패 요청 2건에서 질문·첨부 인용문·오류 상태가 localhost 화면에 복원됨. 정상 AI 답변을 받은 것은 아님 |
| Claude·Codex | 실제 서비스 연결·답변 검증 필요 |

서로 다른 origin에서의 복원 확인은 **실제 PC·폰 사이의 사용 검증이나 모든 오류 상황 검증을 대신하지 않습니다.**

- 첫 버전은 텍스트 PDF, 파일당 최대 **50MB**입니다. 스캔 OCR은 포함하지 않습니다.
- PC에서 PDF·스크랩을 저장한 뒤 폰에서 같은 계정으로 읽고, 반대로 작성한 대화·메모도 확인합니다.
- Drive 접근 취소·토큰 만료·저장 실패 시 미전송 상태를 표시하고 기존 기기 기록을 보존하는지 확인합니다.
- 참고문헌 검색 결과를 확인한 뒤 연결합니다. 초록·원문 확보 범위와 질문에 실제 전달한 구간을 구분합니다.
- 생성 중 브라우저 연결이 끊기면 답변이 중단될 수 있습니다. 저장된 요청 상태를 확인하며, 불명확한 요청을 자동으로 다시 실행하지 않습니다.
- 오프라인의 새 AI 요청, Drive 파일 다운로드, 전문 검색 기반 다중 논문 분석은 지원하지 않습니다.

공식 연결 문서: [Google Picker](https://developers.google.com/workspace/drive/picker/guides/overview), [Drive 업로드](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [Vercel Git](https://vercel.com/docs/git), [Gemini](https://aistudio.google.com/docs/get-started), [Claude](https://platform.claude.com/docs/en/api/messages), [Codex App Server](https://learn.chatgpt.com/docs/app-server).
