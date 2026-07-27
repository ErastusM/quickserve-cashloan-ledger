// Markdown -> print-ready A4 PDF, same letterhead as the .docx set.
//
//   node md2pdf.js <pack.json> <outDir>
//
// Chromium renders these, so the PDFs are what the client actually receives;
// the .docx set is what the owner edits.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const HERE = __dirname;
const LOGO_B64 = fs.readFileSync(path.join(HERE, "logo.png")).toString("base64");

const FONT_CSS = fs
  .readdirSync(path.join(HERE, "fonts", "out"))
  .filter((f) => f.startsWith("Inter") && f.endsWith(".woff2"))
  .map((file) => {
    const weight = file.split("-")[1].replace(".woff2", "");
    const b64 = fs.readFileSync(path.join(HERE, "fonts", "out", file)).toString("base64");
    return `@font-face{font-family:'Inter';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  })
  .join("\n");

// ---------- minimal, predictable markdown renderer ----------
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([A-Z0-9 ./&'’,()%+-]{2,})\]/g, '<span class="ph">[$1]</span>');
}

function render(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  let list = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    if (!t) { closeList(); i++; continue; }

    if (t.startsWith("|") && lines[i + 1] && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const r = lines[i].trim();
        if (!/^\|[\s:|-]+\|$/.test(r)) {
          rows.push(r.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
        }
        i++;
      }
      const num = (c) => /^[N$\s\d.,()%-]+$/.test(c) && c.trim();
      out.push("<table>");
      rows.forEach((cells, ri) => {
        out.push("<tr>");
        cells.forEach((c, ci) => {
          const tag = ri === 0 ? "th" : "td";
          const cls = ri > 0 && ci > 0 && num(c) ? ' class="n"' : "";
          out.push(`<${tag}${cls}>${inline(c)}</${tag}>`);
        });
        out.push("</tr>");
      });
      out.push("</table>");
      continue;
    }

    if (/^---+$/.test(t)) { closeList(); out.push("<hr/>"); i++; continue; }

    let m;
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      const lvl = m[1].length;
      const txt = lvl <= 2 ? m[2].toUpperCase() : m[2];
      out.push(`<h${lvl}>${inline(txt)}</h${lvl}>`);
      i++; continue;
    }

    if (/^[-*]\s+/.test(t)) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(t.replace(/^[-*]\s+/, ""))}</li>`);
      i++; continue;
    }

    const clause = t.match(/^(\d+(?:\.\d+)*\.?)\s+(.*)$/);
    if (clause) {
      closeList();
      out.push(`<p class="cl"><span class="no">${esc(clause[1])}</span><span class="tx">${inline(clause[2])}</span></p>`);
      i++; continue;
    }

    closeList();
    out.push(`<p>${inline(t)}</p>`);
    i++;
  }
  closeList();
  return out.join("\n");
}

const page = (doc) => `<!doctype html><html><head><meta charset="utf-8"><style>
${FONT_CSS}
@page { size: A4; margin: 22mm 18mm 20mm 18mm; }
* { box-sizing: border-box; }
body { font-family: Inter, sans-serif; font-size: 10.2pt; line-height: 1.52; color: #1e2e2c; margin: 0; }
h1 { font-size: 16pt; font-weight: 800; color: #06302e; text-align: center; letter-spacing: -0.3px; margin: 0 0 14pt; }
h2 { font-size: 11.4pt; font-weight: 700; color: #06302e; letter-spacing: .2px; margin: 17pt 0 7pt;
     border-bottom: 1.6pt solid #12b84f; padding-bottom: 3pt; break-after: avoid; }
h3 { font-size: 10.8pt; font-weight: 700; color: #06302e; margin: 12pt 0 5pt; break-after: avoid; }
h4 { font-size: 10.2pt; font-weight: 700; color: #06302e; margin: 10pt 0 4pt; break-after: avoid; }
p  { margin: 0 0 6pt; }
p.cl { display: flex; gap: 7pt; align-items: baseline; }
p.cl .no { flex: 0 0 auto; min-width: 27pt; font-weight: 700; color: #06302e; }
p.cl .tx { flex: 1 1 auto; }
ul { margin: 0 0 7pt; padding-left: 17pt; }
li { margin-bottom: 3.5pt; }
hr { border: 0; border-top: 1pt solid #c9d6d3; margin: 13pt 0; }
table { width: 100%; border-collapse: collapse; margin: 8pt 0 11pt; font-size: 9.6pt; break-inside: avoid; }
th, td { border: 0.9pt solid #c9d6d3; padding: 5pt 7pt; text-align: left; vertical-align: top; }
th { background: #eef4f2; color: #06302e; font-weight: 700; }
td.n { text-align: right; white-space: nowrap; }
.ph { background: #fff4d6; color: #7a5b00; font-weight: 600; padding: 0 2pt; border-radius: 2pt; }
</style></head><body>${render(doc.markdown)}</body></html>`;

const headerTpl = () => `
<div style="width:100%; font-family:Inter,sans-serif; font-size:6.6pt; color:#5a6b69;
            padding:0 18mm; margin-top:8mm; -webkit-print-color-adjust:exact;">
  <div style="display:flex; align-items:flex-end; justify-content:space-between;
              border-bottom:1.4pt solid #12b84f; padding-bottom:3pt;">
    <img src="data:image/png;base64,${LOGO_B64}" style="height:8.5mm"/>
    <div style="text-align:right; line-height:1.45;">
      <div><strong style="color:#06302e;">[REGISTERED BUSINESS NAME]</strong> &nbsp;·&nbsp; Reg. No. [COMPANY REGISTRATION NUMBER]</div>
      <div>NAMFISA Reg. No. [NAMFISA REGISTRATION NUMBER] &nbsp;·&nbsp; [PHYSICAL ADDRESS]</div>
      <div>Tel / WhatsApp +264 81 264 6222 &nbsp;·&nbsp; [EMAIL ADDRESS]</div>
    </div>
  </div>
</div>`;

const footerTpl = (title) => `
<div style="width:100%; font-family:Inter,sans-serif; font-size:6.6pt; color:#5a6b69;
            padding:0 18mm; margin-bottom:6mm; -webkit-print-color-adjust:exact;">
  <div style="display:flex; justify-content:space-between; border-top:0.8pt solid #c9d6d3; padding-top:3pt;">
    <span>QuickServe Cashloan &nbsp;·&nbsp; ${title.replace(/</g, "")}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>
</div>`;

(async () => {
  const [, , packPath, outDir] = process.argv;
  const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
  });
  const p = await browser.newPage();

  for (const doc of pack.documents) {
    await p.setContent(page(doc), { waitUntil: "load" });
    await p.evaluate(() => document.fonts.ready);
    const file = path.join(outDir, `${doc.slug}.pdf`);
    await p.pdf({
      path: file,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerTpl(),
      footerTemplate: footerTpl(doc.title),
      margin: { top: "26mm", bottom: "18mm", left: "18mm", right: "18mm" }
    });
    console.log(`  ${(doc.slug + ".pdf").padEnd(46)} ${String(Math.round(fs.statSync(file).size / 1024)).padStart(4)} KB   ${doc.title}`);
  }
  await browser.close();
  console.log(`\n${pack.documents.length} PDFs written to ${outDir}`);
})();
