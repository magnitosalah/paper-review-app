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

현재 연결은 브라우저 메모리에 보관하는 짧은 수명의 access token을 사용합니다. 새 브라우저 세션이나 토큰 만료 후에는 사용자가 다시 Google 연결 버튼을 눌러야 합니다. 갱신 토큰을 로컬 저장소나 서버 파일에 보관하지 않습니다. PC와 폰 각각에서 같은 계정을 연결하고 저장 완료를 확인한 뒤 이어 읽습니다. [Google token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)

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

## GitHub → Vercel

1. 앱 코드를 GitHub 원격 저장소에 푸시합니다.
2. Vercel에서 저장소를 Import하고 **Root Directory를 `paperdesk`**로 지정합니다.
3. Framework는 Next.js, Install은 `npm ci`, Build는 `npm run build`입니다.
4. Google 공개 설정·`ALLOWED_EMAILS`·사용할 AI 비밀키를 Vercel에 등록하고 배포합니다.
5. 확정된 운영 URL을 Google OAuth origin과 API key의 허용 referrer에 등록합니다.
6. `NEXT_PUBLIC_` 값이 바뀌면 재배포합니다. PC와 폰은 같은 운영 URL을 사용합니다.

앱 재배포와 사용자 기록 저장은 별개입니다. 논문·대화는 본인 Drive에 보관하며, PDF·개인 대화·토큰·API 비밀키는 Git에 올리지 않습니다.

## 검증 범위와 운영 전 확인

로컬 테스트는 PDF 파싱·참고문헌 추출·상태 병합·요청 검증·제공자 응답 처리를 확인합니다. 코드 테스트나 브라우저 미리보기만으로 실제 Google 계정 동기화와 AI 실응답을 검증했다고 판단하지 않습니다. **Google OAuth·Drive 읽기/쓰기·두 기기 동기화·각 AI의 실제 응답은 설정 후 별도 검증해야 합니다.**

- 첫 버전은 텍스트 PDF, 파일당 최대 **50MB**입니다. 스캔 OCR은 포함하지 않습니다.
- PC에서 PDF·스크랩을 저장한 뒤 폰에서 같은 계정으로 읽고, 반대로 작성한 대화·메모도 확인합니다.
- Drive 접근 취소·토큰 만료·저장 실패 시 미전송 상태를 표시하고 기존 기기 기록을 보존하는지 확인합니다.
- 참고문헌 검색 결과를 확인한 뒤 연결합니다. 초록·원문 확보 범위와 질문에 실제 전달한 구간을 구분합니다.
- 생성 중 브라우저 연결이 끊기면 답변이 중단될 수 있습니다. 저장된 요청 상태를 확인하며, 불명확한 요청을 자동으로 다시 실행하지 않습니다.
- 오프라인의 새 AI 요청, Drive 파일 다운로드, 전문 검색 기반 다중 논문 분석은 지원하지 않습니다.

공식 연결 문서: [Google Picker](https://developers.google.com/workspace/drive/picker/guides/overview), [Drive 업로드](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [Vercel Git](https://vercel.com/docs/git), [Gemini](https://aistudio.google.com/docs/get-started), [Claude](https://platform.claude.com/docs/en/api/messages), [Codex App Server](https://learn.chatgpt.com/docs/app-server).
