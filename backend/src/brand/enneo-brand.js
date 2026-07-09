import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ============================================================ enneo Brand-Templates
// Quelle: "Enneo Design System" (Style Guide v2026-01.3). Regeln:
// - Dokumente (Produkt-Nähe): Inter, Papier-Weiß, Purple #7B5AE2 als Akzent, Navy #292C3F als Ink.
// - Präsentationen (Brand-Fläche): Geist Display + Geist Mono Body, Navy #181825,
//   grainy Lavender-über-Navy-Gradients die über den Rand bluten — der Grain ist Pflicht.
// - Deutsch, Sie-Form, kein Hype, keine Emojis, keine Illustrationen.

const here = dirname(fileURLToPath(import.meta.url))
const LOGO_DARK = readFileSync(join(here, 'logo-dark.svg'), 'utf8') // für dunkle Flächen
const LOGO_LIGHT = readFileSync(join(here, 'logo-light.svg'), 'utf8') // für helle Flächen

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@300;400;500&display=swap" rel="stylesheet">'

// Signature-Grain als Inline-SVG-Turbulence (data-URI), über die Gradients gelegt
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")"

const TOKENS = `
  --purple:#7B5AE2;--purple-dark:#613CDD;--purple-300:#957BE8;--purple-200:#B09CEE;--purple-100:#CABDF3;--purple-50:#E5DEF9;
  --navy:#292C3F;--navy-700:#545666;--navy-500:#7F808C;--navy-300:#A6ABB2;--navy-200:#D4D5D9;--ink:#181825;
  --paper:#FFFFFF;--bg-alt:#F8F7F9;--bg-soft:#EDEBEF;--line:#D4CFD8;
  --green:#38A870;--red:#DB5151;--yellow:#F6B100;
  --font-ui:'Inter',system-ui,sans-serif;--font-brand:'Geist','Inter',system-ui,sans-serif;--font-mono:'Geist Mono',ui-monospace,monospace;`

export function wrapDocument({ title, body }) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
${FONTS}
<style>
:root{${TOKENS}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg-soft);font:400 16px/1.55 var(--font-ui);color:var(--navy);-webkit-font-smoothing:antialiased}
.page{max-width:820px;margin:0 auto;background:var(--paper);min-height:100vh;padding:64px 72px 80px}
.doc-head{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:48px;padding-bottom:20px;border-bottom:1px solid var(--line)}
.doc-head .logo{width:118px;flex:none}
.doc-head .meta{font:400 12px/1.5 var(--font-mono);color:var(--navy-500);text-align:right}
h1{font:700 34px/1.2 var(--font-ui);letter-spacing:-.02em;margin:0 0 8px}
h2{font:700 24px/1.25 var(--font-ui);letter-spacing:-.02em;margin:44px 0 12px}
h3{font:600 18px/1.3 var(--font-ui);letter-spacing:-.01em;margin:32px 0 8px}
p{margin:0 0 14px}
.lead{font-size:18px;color:var(--navy-700);margin-bottom:28px}
ul,ol{margin:0 0 16px;padding-left:22px}
li{margin-bottom:6px}
table{border-collapse:collapse;width:100%;margin:16px 0 24px;font-size:14.5px}
th{text-align:left;font-weight:600;border-bottom:2px solid var(--navy);padding:9px 12px 9px 0}
td{border-bottom:1px solid var(--line);padding:9px 12px 9px 0;vertical-align:top}
code,pre{font-family:var(--font-mono);font-size:13.5px}
pre{background:var(--bg-alt);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto}
blockquote{margin:20px 0;padding:14px 20px;border-left:3px solid var(--purple);background:var(--purple-50);border-radius:0 8px 8px 0}
strong{font-weight:600}
a{color:var(--purple);text-decoration:none}
.accent{color:var(--purple)}
.kpi-row{display:flex;gap:16px;margin:20px 0 28px;flex-wrap:wrap}
.kpi{flex:1;min-width:150px;border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.kpi .v{font:700 28px/1.1 var(--font-ui);letter-spacing:-.02em;color:var(--purple)}
.kpi .l{font:400 12.5px/1.4 var(--font-ui);color:var(--navy-500);margin-top:4px}
.doc-foot{margin-top:64px;padding-top:16px;border-top:1px solid var(--line);font:400 11.5px/1.5 var(--font-mono);color:var(--navy-500);display:flex;justify-content:space-between}
@media print{body{background:var(--paper)}.page{max-width:none;padding:24px 8px}}
@page{margin:18mm 16mm}
</style>
</head>
<body>
<div class="page">
  <div class="doc-head"><span class="logo">${LOGO_LIGHT}</span><div class="meta">enneo GmbH · ${dateDE()}</div></div>
  ${body}
  <div class="doc-foot"><span>enneo — AI-Kundenservice für regulierte Branchen</span><span>Vertraulich</span></div>
</div>
</body>
</html>`
}

export function wrapPresentation({ title, slides }) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
${FONTS}
<style>
:root{${TOKENS}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--ink)}
body{font:300 17px/1.55 var(--font-mono);color:#EDEBEF;-webkit-font-smoothing:antialiased}
.deck{height:100%;overflow-y:auto;scroll-snap-type:y mandatory}
.slide{position:relative;height:100vh;scroll-snap-align:start;padding:7vh 8vw;display:flex;flex-direction:column;justify-content:center;overflow:hidden;background:var(--ink)}
.slide::before{content:'';position:absolute;inset:0;background:${GRAIN};opacity:.16;pointer-events:none;mix-blend-mode:overlay}
.slide.title{background:radial-gradient(120% 90% at 82% -10%,rgba(176,156,238,.5) 0%,rgba(123,90,226,.28) 34%,rgba(24,24,37,0) 68%),radial-gradient(90% 70% at -10% 110%,rgba(123,90,226,.32) 0%,rgba(24,24,37,0) 60%),var(--ink)}
.slide.accent{background:radial-gradient(110% 80% at 110% 100%,rgba(123,90,226,.38) 0%,rgba(24,24,37,0) 62%),var(--ink)}
.slide .logo{position:absolute;top:5vh;left:8vw;width:104px}
.slide .num{position:absolute;bottom:4.5vh;right:8vw;font:300 12px/1 var(--font-mono);color:var(--navy-500)}
h1{font:500 clamp(40px,5.6vw,74px)/1.06 var(--font-brand);letter-spacing:-.02em;color:#fff;margin:0 0 26px;max-width:20ch}
h2{font:500 clamp(28px,3.4vw,46px)/1.12 var(--font-brand);letter-spacing:-.015em;color:#fff;margin:0 0 22px;max-width:26ch}
h3{font:500 clamp(19px,1.8vw,25px)/1.25 var(--font-brand);color:var(--purple-200);margin:0 0 10px}
p{margin:0 0 14px;max-width:62ch;color:#D4D5D9}
.kicker{font:400 13px/1 var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--purple-300);margin-bottom:22px}
ul,ol{margin:0 0 16px;padding-left:20px;color:#D4D5D9}
li{margin-bottom:10px;max-width:58ch}
strong{color:#fff;font-weight:500}
.accent{color:var(--purple-200)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:28px;margin-top:12px}
.card{border:1px solid rgba(212,213,217,.18);border-radius:14px;padding:22px 24px;background:rgba(41,44,63,.35)}
.big{font:500 clamp(40px,4.6vw,64px)/1 var(--font-brand);color:var(--purple-200);letter-spacing:-.02em}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:15px}
th{text-align:left;font-weight:500;color:#fff;border-bottom:1px solid rgba(212,213,217,.4);padding:8px 14px 8px 0;font-family:var(--font-mono)}
td{border-bottom:1px solid rgba(212,213,217,.15);padding:8px 14px 8px 0;color:#D4D5D9}
@media print{.deck{overflow:visible}.slide{page-break-after:always;height:100vh}}
@page{size:landscape;margin:0}
</style>
</head>
<body>
<div class="deck">
${slides}
</div>
<script>
// Folien-Navigation: Pfeiltasten / Leertaste / PageUp-Down
const deck=document.querySelector('.deck'),slides=[...document.querySelectorAll('.slide')]
slides.forEach((s,i)=>{if(!s.querySelector('.logo'))s.insertAdjacentHTML('afterbegin','<span class="logo">${LOGO_DARK.replace(/'/g, "\\'").replace(/\n/g, '')}</span>');s.insertAdjacentHTML('beforeend','<span class="num">'+(i+1)+' / '+slides.length+'</span>')})
let cur=0
const go=(i)=>{cur=Math.max(0,Math.min(slides.length-1,i));slides[cur].scrollIntoView({behavior:'smooth'})}
document.addEventListener('keydown',(e)=>{
  if(['ArrowDown','ArrowRight','PageDown',' '].includes(e.key)){e.preventDefault();go(cur+1)}
  if(['ArrowUp','ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();go(cur-1)}
})
deck.addEventListener('scroll',()=>{cur=Math.round(deck.scrollTop/window.innerHeight)})
</script>
</body>
</html>`
}

function dateDE() {
  return new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
