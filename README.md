# Paperdesk

[앱 열기](https://paper-review-app-nine.vercel.app) · [GitHub 검증](https://github.com/magnitosalah/paper-review-app/actions)

논문을 읽고 문장을 보관하며 Codex·Gemini·Claude에 질문하는 반응형 웹앱입니다. 로컬 PDF, Google Drive 파일 선택, 참고문헌 검색과 별도 대화, 개인 서재 동기화를 위한 코드를 포함합니다.

애플리케이션은 [`paperdesk/`](paperdesk/)에 있습니다. Vercel에서 Git 저장소를 연결할 때 **Root Directory를 `paperdesk`**로 지정합니다.

- [실행·배포·외부 서비스 설정](paperdesk/README.md)
- [기획서](논문_리딩_앱_기획서.md)
- [Codex 서버 실행 안내](paperdesk/codex-runner/README.md)

외부 서비스의 계정과 인증 정보는 저장소에 포함하지 않습니다. 연결이 없는 상태에서도 브라우저 로컬 PDF 열기·스크랩·메모·Markdown 내보내기는 사용할 수 있습니다. 실제 AI 응답과 기기 간 동기화는 아래 설정 후 검증해야 합니다.
