/** An original, locally generated reading guide. No third-party PDF is bundled. */
export function samplePdf(): Blob {
  const pages = [
    ["PAPERDESK  /  READING NOTES", "A little space for big ideas", "A hands-on guide to reading with AI", "", "01   Start with a question", "", "Good reading is an active conversation with a text. When a sentence", "feels unfamiliar, pause and turn that uncertainty into a question.", "You do not need to understand every detail on the first pass.", "", "Select this paragraph and ask your reading assistant to explain it:", "", "A useful explanation connects a new idea to something you already", "understand. It makes assumptions visible, separates evidence from", "interpretation, and gives you a concrete example to think with.", "", "02   Keep the evidence close", "", "Save the sentence together with its page and your own note. An", "answer is easier to revisit when its original context is one click away.", "The quote stays attached even when you turn to another page.", "", "An AI explanation can help you reason about a claim, but a model", "should not imply it has read material that was never provided.", "Check whether an answer uses a quotation, an abstract, or a full text.", "", "03   Follow a reference", "", "References connect ideas across papers. For example, the work by", "Vaswani and colleagues [1] is a useful starting point for learning", "about Transformer architectures. Open the References tab to explore.", "", "This is an original Paperdesk tutorial, not a research publication."],
    ["PAPERDESK  /  READING NOTES", "Make the conversation yours", "Continue on your own terms", "", "04   Choose your assistant", "", "Choose a connected provider and model before sending a question.", "When switching providers, choose whether to carry the conversation", "forward or start a fresh discussion with only the attached material.", "Your previous answers keep their original provider labels.", "", "05   Read anywhere", "", "Local reading works in this browser. Sign in to a configured cloud", "workspace to keep your papers, highlights, and conversations together", "across your computer and phone. Wait for the saved status before", "switching devices. A local file needs to finish uploading first.", "", "Try it", "", "- Highlight a passage on page one.", "- Save a note in your own words.", "- Attach the passage to a question.", "- Open the reference as a separate conversation.", "", "This guide is sample content. No AI response has been simulated.", "", "References", "", "[1] Vaswani, A., et al. (2017). Attention Is All You Need.", "Advances in Neural Information Processing Systems.", "https://doi.org/10.48550/arXiv.1706.03762"]
  ];
  const objects: string[] = [];
  const add = (s:string) => { objects.push(s); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((lines,i) => {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`);
    const commands = lines.map((line,j) => {const size=j===1?25:j===0?10:11; const y=738-j*19; return `BT /F1 ${size} Tf ${j===0?'0.12 0.4 0.32':'0.12 0.16 0.2'} rg 52 ${y} Td (${line.replace(/[\\()]/g,'\\$&')}) Tj ET`;}).join('\n');
    add(`<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`);
  });
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const xref=pdf.length;
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf],{type:'application/pdf'});
}
