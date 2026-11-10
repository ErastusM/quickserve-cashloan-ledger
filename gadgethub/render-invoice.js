// Render a GadgetHub invoice to PDF from a JSON data file.
//   node gadgethub/render-invoice.js gadgethub/invoices/GH-2026-1110.json
// Writes <same name>.pdf next to the JSON. Client fields left as null are
// printed as a highlighted "[to be confirmed]" placeholder so a draft can't
// be mistaken for a finished invoice.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const dataPath = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(dataPath)) {
  console.error("Usage: node gadgethub/render-invoice.js <invoice.json>");
  process.exit(1);
}
const d = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const tpl = fs.readFileSync(path.join(__dirname, "invoice-template.html"), "utf8");

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const tbc = (label) => `<span style="color:#b45309;background:#fef3c7;padding:0 1mm">[${label} — to be confirmed]</span>`;
const val = (v, label) => (v == null || v === "" ? tbc(label) : esc(v));
const nad = (n) => "N$ " + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function words(n) {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const under1000 = (x) => {
    const h = Math.floor(x / 100), r = x % 100, out = [];
    if (h) out.push(ones[h] + " Hundred");
    if (r) out.push(r < 20 ? ones[r] : tens[Math.floor(r / 10)] + (r % 10 ? "-" + ones[r % 10] : ""));
    return out.join(" and ");
  };
  const whole = Math.floor(n), cents = Math.round((n - whole) * 100);
  const parts = [];
  if (Math.floor(whole / 1e6)) parts.push(under1000(Math.floor(whole / 1e6)) + " Million");
  if (Math.floor(whole / 1000) % 1000) parts.push(under1000(Math.floor(whole / 1000) % 1000) + " Thousand");
  if (whole % 1000) parts.push(under1000(whole % 1000));
  let s = (parts.join(" ") || "Zero") + " Namibian Dollars";
  if (cents) s += " and " + under1000(cents) + " Cents";
  return s + ".";
}

const c = d.client || {};
const clientBlock = [
  `<div class="name">${val(c.name, "Client name")}</div>` +
  [c.town ? esc(c.town) : null,
  c.phone ? esc(c.phone) : null,
  val(c.email, "Email address")].filter(Boolean).join("<br>"),
].join("");

let subtotal = 0;
const itemRows = d.items.map((it) => {
  const qty = it.qty || 1, amount = qty * it.unitPrice;
  subtotal += amount;
  const sub = [
    it.serial ? "Serial No: " + esc(it.serial) : null,
    "Condition: " + val(it.condition, "Condition"),
  ].filter(Boolean).join("<br>");
  return `<tr><td>${esc(it.description)}<div class="sub">${sub}</div></td><td class="qty">${qty}</td><td class="num unit">${nad(it.unitPrice)}</td><td class="num amt">${nad(amount)}</td></tr>`;
}).join("");

const html = tpl
  .replace(/{{number}}/g, esc(d.number))
  .replace(/{{issueDate}}/g, esc(d.issueDate))
  .replace(/{{dueDate}}/g, esc(d.dueDate || d.issueDate))
  .replace(/{{clientBlock}}/g, clientBlock)
  .replace(/{{itemRows}}/g, itemRows)
  .replace(/{{subtotal}}/g, nad(subtotal))
  .replace(/{{total}}/g, nad(subtotal))
  .replace(/{{amountWords}}/g, words(subtotal));

const outPdf = dataPath.replace(/\.json$/, ".pdf");
(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: outPdf, format: "A4", printBackground: true, preferCSSPageSize: true });
  if (process.env.PNG) {
    await page.setViewportSize({ width: 794, height: 1123 });
    await page.screenshot({ path: process.env.PNG, fullPage: true });
  }
  await browser.close();
  console.log("Wrote " + outPdf);
})();
