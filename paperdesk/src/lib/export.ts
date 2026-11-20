import { WorkspaceState,Paper } from './types';
export function exportMarkdown(state:WorkspaceState,paper:Paper):string {
  const out=[`# ${paper.title}`,`내보낸 날짜: ${new Date().toLocaleString('ko-KR')}`,`원본: ${paper.filename}`,'## 스크랩'];
  for(const s of state.scraps.filter(s=>s.paperId===paper.id)) out.push(`### PDF ${s.page}페이지`,s.text.split('\n').map(l=>`> ${l}`).join('\n'),s.note||'');
  for(const chat of state.chats.filter(c=>c.paperId===paper.id)) {
    out.push(`## ${chat.title}`);
    const ref=state.references.find(r=>r.id===chat.referenceId);if(ref)out.push(`참고문헌: ${ref.citation}`,`자료 범위: ${ref.evidence}`,ref.url||'');
    for(const m of state.messages.filter(m=>m.chatId===chat.id)) {
      out.push(`### ${m.role==='user'?'질문':'답변'} · ${m.provider} / ${m.model}`,m.createdAt);
      if(m.quote)out.push(`PDF ${m.quote.page}페이지`,m.quote.text.split('\n').map(l=>`> ${l}`).join('\n'));
      out.push(m.content);if(m.status!=='complete')out.push(`상태: ${m.status}`);
    }
  }
  return out.join('\n\n');
}
export function downloadText(text:string,name:string) {const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
