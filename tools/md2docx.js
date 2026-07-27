// Markdown -> professional QuickServe .docx
//
// Turns the drafted document markdown into Word files with a real letterhead,
// consistent typography, proper tables, and a page-numbered footer. Fill-in
// blanks written as [LIKE THIS] are shaded so nothing unfilled slips past on a
// printed page.
//
//   node md2docx.js <pack.json> <outDir>
//
// pack.json: { documents: [ { slug, title, purpose, markdown } ] }

const fs = require("fs");
const path = require("path");
const D = require("docx");
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType, HeadingLevel,
  Footer, Header, PageNumber, TabStopType, TabStopPosition, LevelFormat, convertInchesToTwip
} = D;

// Greyscale only. The single spot of colour in the whole document is the logo
// image in the letterhead; everything else is black, grey, or white.
const INK = "1A1A1A";      // near-black, headings
const GREEN = "8C8C8C";    // (kept name) now a neutral grey rule
const GREY = "666666";     // muted body / footer
const RULE = "C8C8C8";     // table + hairline rules
const SHADE = "F2F2F2";    // table header fill
const FILL = "ECECEC";     // [PLACEHOLDER] fill — grey, not colour
const SERIF = "Georgia";   // professional serif for a formal document

const PAGE_W = 11906;      // A4 width in DXA (210mm) — Namibia uses A4
const MARGIN = convertInchesToTwip(0.85);
const CONTENT_W = PAGE_W - MARGIN * 2;

const LOGO = fs.readFileSync(path.join(__dirname, "logo.png"));

// Signing assets, shared with the PDF generator and the app. The stamp always
// exists; the signature appears once assets/signature.png is supplied.
const ASSETS = path.join(__dirname, "..", "assets");
const readAsset = (file) => { try { return fs.readFileSync(path.join(ASSETS, file)); } catch { return null; } };
const STAMP = readAsset("stamp.png");
const SIGNATURE = readAsset("signature.png");

// ---------- inline formatting ----------
// Splits on **bold**, *italic*, and [PLACEHOLDER] so each becomes its own run.
function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[A-Z0-9 ./&'’,()%+-]{2,}\])/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(new TextRun({ text: tok.slice(2, -2), bold: true, ...base }));
    } else if (tok.startsWith("[")) {
      out.push(new TextRun({ text: tok, bold: true, color: INK, shading: { type: ShadingType.CLEAR, fill: FILL }, ...base }));
    } else {
      out.push(new TextRun({ text: tok.slice(1, -1), italics: true, ...base }));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out.length ? out : [new TextRun({ text, ...base })];
}

const P = (text, opts = {}) => {
  const { size = 21, color = "222222", bold, spacing, align, indent, base = {} } = opts;
  return new Paragraph({
    children: runs(text, { size, color, bold, font: SERIF, ...base }),
    spacing: spacing || { after: 120, line: 276 },
    alignment: align,
    indent
  });
};

// ---------- tables ----------
function buildTable(rows) {
  // A table can have an empty header (| | |) used purely for layout, or empty
  // body cells (a stamp box). Clamp columns so a malformed row can never crash
  // the run, and only treat row 0 as a header when it actually has text.
  const cols = Math.min(20, Math.max(1, ...rows.map((r) => r.length)));
  const norm = rows.map((r) => [...r.slice(0, cols), ...Array(Math.max(0, cols - r.length)).fill("")]);
  const hasHeader = norm.length > 1 && norm[0].some((c) => c.trim() !== "");
  // Right-align a column only when every value in it is a number, so a column
  // that mixes money with dates or text stays left-aligned and even.
  const isNum = (c) => /^[N$\s\d.,()%-]+$/.test(c) && c.trim();
  const bodyStart = hasHeader ? 1 : 0;
  const numericCol = [];
  for (let ci = 0; ci < cols; ci++) {
    const vals = norm.slice(bodyStart).map((r) => (r[ci] || "").trim()).filter((v) => v !== "");
    numericCol[ci] = vals.length > 0 && vals.every(isNum);
  }
  // First column carries the label and gets more room; rest split evenly.
  const first = Math.round(CONTENT_W * (cols === 2 ? 0.46 : 0.34));
  const rest = Math.floor((CONTENT_W - first) / (cols - 1 || 1));
  const widths = cols === 1 ? [CONTENT_W] : [first, ...Array(cols - 1).fill(rest)];
  widths[widths.length - 1] += CONTENT_W - widths.reduce((a, b) => a + b, 0);

  return new Table({
    columnWidths: widths,
    width: { size: CONTENT_W, type: WidthType.DXA },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 2, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      left:   { style: BorderStyle.SINGLE, size: 2, color: RULE },
      right:  { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideVertical:   { style: BorderStyle.SINGLE, size: 2, color: RULE }
    },
    rows: norm.map((cells, ri) => {
      const isHead = hasHeader && ri === 0;
      return new TableRow({
        tableHeader: isHead,
        children: cells.map((cell, ci) =>
          new TableCell({
            width: { size: widths[ci], type: WidthType.DXA },
            shading: isHead ? { type: ShadingType.CLEAR, fill: SHADE } : undefined,
            margins: { top: 90, bottom: 90, left: 130, right: 130 },
            children: [
              new Paragraph({
                children: runs(cell || " ", {
                  size: 20,
                  bold: isHead || undefined,
                  color: isHead ? INK : "222222",
                  font: SERIF
                }),
                spacing: { after: 0, line: 250 },
                alignment: ci > 0 && numericCol[ci] ? AlignmentType.RIGHT : undefined
              })
            ]
          })
        )
      });
    })
  });
}

// ---------- markdown -> docx children ----------
function convert(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  const kids = [];
  let i = 0;

  const hr = () => new Paragraph({
    text: "",
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE } },
    spacing: { before: 200, after: 200 }
  });

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { i++; continue; }

    // table
    if (t.startsWith("|") && lines[i + 1] && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const rawRows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rawRows.push(lines[i].trim());
        i++;
      }
      // The second line is the header/body separator (---). Drop only that one;
      // every other row is real, including rows with deliberately empty cells.
      if (rawRows.length > 1 && /^\|[\s:|-]+\|$/.test(rawRows[1])) rawRows.splice(1, 1);
      const rows = rawRows.map((r) => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
      kids.push(buildTable(rows));
      kids.push(new Paragraph({ text: "", spacing: { after: 140 } }));
      continue;
    }

    if (/^---+$/.test(t)) { kids.push(hr()); i++; continue; }

    // Signing assets on their own line.
    if (t === "{{STAMP}}") {
      if (STAMP) {
        kids.push(new Paragraph({
          children: [new ImageRun({ data: STAMP, type: "png", transformation: { width: 128, height: 128 } })],
          spacing: { before: 160, after: 60 }
        }));
      }
      i++; continue;
    }
    if (t === "{{SIGNATURE}}") {
      if (SIGNATURE) {
        kids.push(new Paragraph({
          children: [new ImageRun({ data: SIGNATURE, type: "png", transformation: { width: 180, height: 60 } })],
          spacing: { before: 200, after: 0 }
        }));
      } else {
        kids.push(new Paragraph({ text: "", spacing: { before: 240, after: 0 } }));
      }
      // A ruled line under the signature, either way.
      kids.push(new Paragraph({
        text: "",
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "555555" } },
        spacing: { after: 40 },
        indent: { left: 0 }
      }));
      i++; continue;
    }

    // headings
    if (t.startsWith("#### ")) {
      kids.push(new Paragraph({
        children: runs(t.slice(5), { size: 21, bold: true, color: INK, font: SERIF }),
        spacing: { before: 200, after: 90 }
      }));
      i++; continue;
    }
    if (t.startsWith("### ")) {
      kids.push(new Paragraph({
        children: runs(t.slice(4), { size: 22, bold: true, color: INK, font: SERIF }),
        spacing: { before: 240, after: 100 }
      }));
      i++; continue;
    }
    if (t.startsWith("## ")) {
      kids.push(new Paragraph({
        children: runs(t.slice(3).toUpperCase(), { size: 23, bold: true, color: INK, font: SERIF }),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 320, after: 130 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GREEN } }
      }));
      i++; continue;
    }
    if (t.startsWith("# ")) {
      kids.push(new Paragraph({
        children: runs(t.slice(2).toUpperCase(), { size: 30, bold: true, color: INK, font: SERIF }),
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { before: 60, after: 220 }
      }));
      i++; continue;
    }

    // bullets
    if (/^[-*]\s+/.test(t)) {
      kids.push(new Paragraph({
        children: runs(t.replace(/^[-*]\s+/, ""), { size: 21, color: "222222", font: SERIF }),
        bullet: { level: (line.match(/^\s*/)[0].length >= 2) ? 1 : 0 },
        spacing: { after: 90, line: 270 }
      }));
      i++; continue;
    }

    // numbered clause like "1.2 Something" — keep the number as literal text so
    // clause numbering never renumbers itself when the owner edits the file.
    const clause = t.match(/^(\d+(?:\.\d+)*\.?)\s+(.*)$/);
    if (clause) {
      kids.push(new Paragraph({
        children: [
          new TextRun({ text: clause[1].padEnd(Math.max(clause[1].length + 1, 5)), bold: true, size: 21, color: INK, font: SERIF }),
          ...runs(clause[2], { size: 21, color: "222222", font: SERIF })
        ],
        spacing: { after: 110, line: 276 },
        indent: { left: 420, hanging: 420 }
      }));
      i++; continue;
    }

    kids.push(P(t));
    i++;
  }
  return kids;
}

// ---------- letterhead / footer ----------
function header() {
  return new Header({
    children: [
      new Paragraph({
        children: [new ImageRun({ data: LOGO, type: "png", transformation: { width: 208, height: 52 } })],
        spacing: { after: 40 }
      }),
      new Paragraph({
        children: [
          new TextRun({ text: "Quickserve Financial Services CC", bold: true, size: 16, color: INK, font: SERIF }),
          new TextRun({ text: "   ·   Reg. No. CC/2026/01904", size: 16, color: GREY, font: SERIF })
        ],
        spacing: { after: 14 }
      }),
      new Paragraph({
        children: [
          new TextRun({ text: "Cell +264 81 281 9840   ·   WhatsApp +264 81 264 6222", size: 15, color: GREY, font: SERIF })
        ],
        spacing: { after: 14 }
      }),
      new Paragraph({
        children: [
          new TextRun({ text: "3403 Danger Ashipala Street, Swakopmund, Namibia   ·   P.O. Box 197, Swakopmund   ·   erastusmatheus3@gmail.com", size: 15, color: GREY, font: SERIF })
        ],
        spacing: { after: 90 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: GREEN } }
      })
    ]
  });
}

function footer(title) {
  return new Footer({
    children: [
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: RULE } },
        spacing: { before: 60 },
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          new TextRun({ text: `QuickServe Cashloan · ${title}`, size: 15, color: GREY, font: SERIF }),
          new TextRun({ text: "\t", size: 15 }),
          new TextRun({ text: "Page ", size: 15, color: GREY, font: SERIF }),
          new TextRun({ children: [PageNumber.CURRENT], size: 15, color: GREY, font: SERIF }),
          new TextRun({ text: " of ", size: 15, color: GREY, font: SERIF }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 15, color: GREY, font: SERIF })
        ]
      })
    ]
  });
}

function buildDoc(doc) {
  return new Document({
    creator: "QuickServe Cashloan",
    title: doc.title,
    description: doc.purpose || "",
    numbering: {
      config: [{
        reference: "bullets",
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT },
          { level: 1, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT }
        ]
      }]
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_W, height: 16838 },
          margin: { top: convertInchesToTwip(1.55), bottom: convertInchesToTwip(0.9), left: MARGIN, right: MARGIN }
        }
      },
      headers: { default: header() },
      footers: { default: footer(doc.title) },
      children: convert(doc.markdown)
    }]
  });
}

// ---------- main ----------
(async () => {
  const [, , packPath, outDir] = process.argv;
  const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
  fs.mkdirSync(outDir, { recursive: true });

  let n = 0;
  for (const doc of pack.documents) {
    const buf = await Packer.toBuffer(buildDoc(doc));
    const file = path.join(outDir, `${doc.slug}.docx`);
    fs.writeFileSync(file, buf);
    console.log(`  ${(doc.slug + ".docx").padEnd(46)} ${String(Math.round(buf.length / 1024)).padStart(4)} KB   ${doc.title}`);
    n++;
  }
  console.log(`\n${n} documents written to ${outDir}`);
})();
