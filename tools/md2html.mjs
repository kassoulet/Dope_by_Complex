/*
 * Turn a docs/*.md file into a page of the site (web/style.css, same nav).
 * Only what the docs use: headings, paragraphs, lists, tables, fenced code,
 * inline code, bold, italic, links.
 *   node tools/md2html.mjs docs/PORT4.md web/port4.html "Part 4"
 */
import { readFileSync, writeFileSync } from 'node:fs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
  .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, t, u) => `<img class="${/models/.test(u) ? 'sheet' : 'shot'}" src="${u.replace(/^(\.\.\/)?web\//, '')}" alt="${t}" title="${t}">`)
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => `<a href="${u.replace(/\.md$/, '.html').replace(/^docs\//, '')}">${t}</a>`);

export function convert(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    } else if (/^#{1,3} /.test(l)) {
      const n = l.match(/^#+/)[0].length;
      const text = l.replace(/^#+ /, '');
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${n} id="${id}">${inline(text)}</h${n}>`);
      i++;
    } else if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      out.push('<table><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>' +
        rows.slice(2).map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</table>');
    } else if (/^(\*|-|\d+\.) /.test(l)) {
      const ordered = /^\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^(\*|-|\d+\.) /.test(lines[i])) {
        let t = lines[i++].replace(/^(\*|-|\d+\.) /, '');
        while (i < lines.length && /^ {2,}\S/.test(lines[i])) t += ' ' + lines[i++].trim();
        items.push(`<li>${inline(t)}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (l.trim() === '') {
      i++;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^(```|#{1,3} |\||(\*|-|\d+\.) )/.test(lines[i])) para.push(lines[i++]);
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('md2html.mjs')) {
  const [src, dst, title] = process.argv.slice(2);
  const body = convert(readFileSync(src, 'utf8'));
  const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DOPE ${title}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<nav><a href="index.html"><b>DOPE, reversed</b></a><a href="index.html#process">the process</a><a href="porting.html">porting method</a><a href="engine.html">the engine</a><a href="effects.html">the effects</a><a href="writeup.html">asm write-up</a></nav>
<main>
${body}
<p><a href="index.html">&larr; back to the player</a></p>
</main>
</body>
</html>
`;
  writeFileSync(dst, page);
  console.log('wrote ' + dst);
}
