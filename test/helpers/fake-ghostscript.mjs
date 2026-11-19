// Orchestration fixture only. Never used to generate corpus references.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
const [mode, pdf, png, ...args] = process.argv.slice(2);
if (args.includes('-version')) {
  console.log(mode === 'version' ? 'GPL Ghostscript 9.0' : 'GPL Ghostscript 10.07.1');
} else if (mode === 'timeout') {
  setTimeout(() => {}, 30000);
} else if (mode === 'overflow') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
} else if (mode === 'exit' || (mode === 'later' && args.some(a => a.endsWith('second.ps')))) {
  process.exit(7);
} else {
  const output = args.find(a => a.startsWith('-sOutputFile=')).slice(13);
  if (mode === 'substitution') console.log('Substituting font Helvetica for Missing');
  if(mode === 'wrongfontprefix' || mode === 'wrongfontearlier') {
    const expected=pdf.replaceAll('\\','/');
    if(mode === 'wrongfontearlier') console.log(`Loading Missing font from ${expected}... prior failed attempt.`);
    console.log(`Loading Missing font from ${expected}.different... done.\nORACLE-FONT:Missing=Missing\nORACLE-PATH:Missing=${expected}.different`);
  }
  if (output.endsWith('.pdf')) {
    const bytes=readFileSync(pdf);
    const later=args.some(a=>a.endsWith('second.ps'));
    if(later && mode === 'pdf-no-startxref') writeFileSync(output,bytes.subarray(0,bytes.lastIndexOf('startxref')));
    else if(later && mode === 'pdf-no-eof') writeFileSync(output,bytes.subarray(0,bytes.lastIndexOf('%%EOF')));
    else if(later && mode === 'pdf-recovery') writeFileSync(output,Buffer.from(bytes.toString().replace(/startxref\n\d+/, 'startxref\n1')));
    else copyFileSync(pdf, output);
  }
  else {
    const dest = output.replace('%d', '1');
    if (mode === 'missing') process.exit(0);
    if (mode === 'corrupt') writeFileSync(dest, 'not PNG');
    else if(mode === 'truncated') writeFileSync(dest,readFileSync(png).subarray(0,-4));
    else {copyFileSync(png, dest);if(mode === 'extra') copyFileSync(png,output.replace('%d','2'));}
  }
}
