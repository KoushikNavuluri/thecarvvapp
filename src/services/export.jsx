/* ============================================================
   Real export. Renders each slide off-screen with the same Slide
   engine the viewer uses, captures PNGs, then packages by format:
     png  -> one download per slide
     pdf  -> a single paged document
     pack -> a zip: slides + caption + alt text + sources + story.json
   Progress callbacks match the old simulated job: (pct, step).
   ============================================================ */
import React from "react";
import { createRoot } from "react-dom/client";
import { toBlob } from "html-to-image";
import { jsPDF } from "jspdf";
import JSZip from "jszip";
import { Slide } from "../slides/SlideRenderer";
import { captionFor, altFor } from "../data/templates";
import { platformOf } from "../lib/tokens";

const slug = s => ((s || "carvv-story").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || "carvv-story");
const fmtBytes = n => n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB";

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("Could not read a rendered slide."));
    r.readAsDataURL(blob);
  });
}

/* Render one slide off-screen and capture it as a PNG blob. Fonts are
   already loaded by the app shell; the photography is data URIs, so no
   network is needed. If font inlining fails (offline CDN), retry with
   fonts skipped rather than dropping the export. */
async function renderPng(p, s, i, pixelRatio) {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-12000px;top:0;pointer-events:none;";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await new Promise(resolve => {
      root.render(
        <div ref={el => { if (el) resolve(el); }} style={{ width:1080 }}>
          <Slide slide={s} styleId={p.style} platformId={p.platform} w={1080} radius={0} deco={p.deco} index={i} total={p.slides.length}/>
        </div>
      );
    });
    if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* fonts optional */ } }
    const node = host.firstChild;
    let blob = null;
    try {
      blob = await toBlob(node, { pixelRatio });
    } catch {
      blob = await toBlob(node, { pixelRatio, skipFonts:true });
    }
    if (!blob) throw new Error("A slide rendered empty.");
    return blob;
  } finally {
    root.unmount();
    host.remove();
  }
}

/* The whole job. Throws with a readable message on real failure; the
   export screen's error state shows it and offers a retry. */
export async function exportProject(p, fmt, quality, onProgress) {
  if (!p || !p.slides?.length) throw new Error("This project has no slides to export.");
  const ratio = { "1x":1, "2x":2, "3x":3 }[quality] || 2;
  const total = p.slides.length + 1;
  const pngs = [];
  for (let i = 0; i < p.slides.length; i++) {
    pngs.push(await renderPng(p, p.slides[i], i, ratio));
    onProgress?.(Math.round(((i + 1) / total) * 100), i + 1);
  }
  const name = slug(p.title);
  let size = pngs.reduce((a, b) => a + b.size, 0);

  if (fmt === "pdf") {
    const pf = platformOf(p.platform);
    const w = 1080, h = Math.round(pf.h / pf.w * 1080);
    const pdf = new jsPDF({ unit:"px", format:[w, h], hotfixes:["px_scaling"] });
    for (let i = 0; i < pngs.length; i++) {
      if (i) pdf.addPage([w, h]);
      pdf.addImage(await blobToDataUrl(pngs[i]), "PNG", 0, 0, w, h);
    }
    const blob = pdf.output("blob");
    size = blob.size;
    saveBlob(blob, `${name}.pdf`);
  } else if (fmt === "pack") {
    const zip = new JSZip();
    const folder = zip.folder(name);
    pngs.forEach((b, i) => folder.file(`slide-${String(i + 1).padStart(2, "0")}.png`, b));
    const cap = captionFor(p);
    folder.file("caption.txt", `${cap.hook}\n\n${cap.body}\n\n${cap.cta}\n\n${cap.tags.join(" ")}`);
    folder.file("alt-text.txt", p.slides.map((s, i) => altFor(s, i)).join("\n\n"));
    const srcs = (p.sources || []).map(s => typeof s === "string" ? s : [s.title, s.publisher, s.url].filter(Boolean).join(" · "));
    folder.file("sources.txt", srcs.length ? srcs.join("\n") : "No external sources attached.");
    folder.file("story.json", JSON.stringify(p, null, 2));
    const blob = await zip.generateAsync({ type:"blob" });
    size = blob.size;
    saveBlob(blob, `${name}.zip`);
  } else {
    pngs.forEach((b, i) => setTimeout(() => saveBlob(b, `${name}-${String(i + 1).padStart(2, "0")}.png`), i * 350));
  }
  onProgress?.(100, p.slides.length + 1);
  return { size: fmtBytes(size) };
}
