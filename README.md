# Paperdesk

[앱 열기](https://paper-review-app-nine.vercel.app) · [GitHub 검증](https://github.com/magnitosalah/paper-review-app/actions)

논문을 읽고 문장을 보관하며 Codex·Gemini·Claude에 질문하는 반응형 웹앱입니다. 로컬 PDF, Google Drive 파일 선택, 참고문헌 검색과 별도 대화, 개인 서재 동기화를 위한 코드를 포함합니다.

애플리케이션은 [`paperdesk/`](paperdesk/)에 있습니다. Vercel에서 Git 저장소를 연결할 때 **Root Directory를 `paperdesk`**로 지정합니다.

- [실행·배포·외부 서비스 설정](paperdesk/README.md)
- [기획서](논문_리딩_앱_기획서.md)
- [Codex 서버 실행 안내](paperdesk/codex-runner/README.md)

외부 서비스의 계정과 인증 정보는 저장소에 포함하지 않습니다. 연결이 없는 상태에서도 브라우저 로컬 PDF 열기·스크랩·메모·Markdown 내보내기는 사용할 수 있습니다.

실제 Google 계정으로 운영 앱에서 PDF·스크랩을 저장한 뒤, 독립된 localhost 브라우저 저장소에서 PDF 본문·스크랩·메모·읽기 위치와 실패한 질문·첨부 인용문·오류 상태가 복원되는 것을 확인했습니다. Google Picker의 PDF 선택·중복 감지, DOI 참고문헌 검색과 문헌별 대화 연결 동기화도 확인했습니다. 실제 폰에서의 사용은 추가 검증이 필요합니다.

설정한 Gemini 세 모델은 현재 프로젝트의 **월 지출 한도**로 HTTP 429가 발생해 실제 답변 생성에 성공하지 못했습니다. AI Studio 화면에서도 `₩0 / ₩0`·`한도 도달`을 확인했습니다. 프로젝트 소유자가 [AI Studio Spend](https://ai.studio/spend)에서 재개 방법을 결정해야 합니다. 결제·한도 설정은 변경하지 않았으며, [검증 현황과 재개 안내](paperdesk/README.md#현재-gemini-사용을-막는-조건)에 상세 내용을 정리했습니다.

현재는 **새로고침 후에도 `연결 설정 → Google Drive로 연결`에서 같은 계정으로 다시 연결**해야 계정 서재가 나타납니다. 연결 전의 로컬 서재와 Google 계정 서재는 따로 보관됩니다. 자세한 순서는 [이어 읽기 안내](paperdesk/README.md#새로고침하거나-다른-기기에서-이어-읽기)를 참고하세요.
