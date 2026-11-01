(() => {
  "use strict";

  const button = document.getElementById("download-pdf-btn");
  const status = document.getElementById("pdf-status");
  const filename = "Nguyen-Le-Vinh-CV.pdf";

  function withTimeout(promise, milliseconds, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      })
    ]).finally(() => clearTimeout(timer));
  }

  async function waitForImages(root) {
    await Promise.all([...root.querySelectorAll("img")].map(image => {
      if (image.complete) {
        return image.naturalWidth ? Promise.resolve() : Promise.reject(new Error("A CV image failed to load."));
      }
      return new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", () => reject(new Error("A CV image failed to load.")), { once: true });
      });
    }));
  }

  async function iconFontCSS() {
    // Icons use ::before, so the renderer cannot discover their font itself.
    const response = await fetch("./lib/bootstrap-icon/font/fonts/bootstrap-icons.woff2");
    if (!response.ok) throw new Error("The icon font could not be loaded.");
    const blob = await response.blob();
    const dataURL = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return `@font-face { font-family: "bootstrap-icons"; src: url("${dataURL}") format("woff2"); }`;
  }

  function contentRanges(root) {
    const top = root.getBoundingClientRect().top;
    const lines = [];
    const blocks = [];
    const add = (list, rect) => {
      if (rect.height > 0 && rect.width > 0) {
        list.push({ start: rect.top - top - 1, end: rect.bottom - top + 1 });
      }
    };

    // Text ranges are measured by the browser, including justified and wrapped
    // lines in both columns. Never split an image, icon, or line of text.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) add(lines, rect);
    }
    root.querySelectorAll("img, i").forEach(element => add(lines, element.getBoundingClientRect()));

    // Prefer to keep individual bullets and headings together without
    // sacrificing most of a page.
    root.querySelectorAll(".skill-part, .skill-icon-item, .info-part, .exp-part-detail > span, .prj-part-detail > span, .edu-part-detail > span, .prj-meta")
      .forEach(element => add(blocks, element.getBoundingClientRect()));
    root.querySelectorAll(".right-part-title, .left-part-title, .prj-detail-title, .exp-tech-stack")
      .forEach(element => {
        const rect = element.getBoundingClientRect();
        const next = element.nextElementSibling;
        if (next) blocks.push({ start: rect.top - top - 1, end: next.getBoundingClientRect().top - top + 20 });
      });
    root.querySelectorAll(".exp-part, .prj-part, .edu-part").forEach(card => {
      const detail = card.querySelector(".exp-part-detail, .prj-part-detail, .edu-part-detail");
      blocks.push({ start: card.getBoundingClientRect().top - top, end: detail.getBoundingClientRect().top - top + 20 });
    });
    return { lines, blocks };
  }

  function safeBreak(limit, start, intervals) {
    let cut = limit;
    // Moving upward can encounter a different line in the other column.
    while (cut > start) {
      const crossing = intervals.filter(interval => interval.start < cut && interval.end > cut);
      if (!crossing.length) return cut;
      cut = Math.min(...crossing.map(interval => interval.start));
    }
    return start;
  }

  function pageSlices(root, canvas, pageHeight) {
    const height = root.getBoundingClientRect().height;
    const scale = canvas.height / height;
    const { lines, blocks } = contentRanges(root);
    const slices = [];
    let start = 0;
    while (start < canvas.height) {
      const limit = Math.min(canvas.height, start + Math.floor(pageHeight * scale));
      let end = limit;
      if (limit < canvas.height) {
        const preferred = safeBreak(limit / scale, start / scale, [...lines, ...blocks]);
        const cut = preferred > start / scale + pageHeight * 0.8
          ? preferred
          : safeBreak(limit / scale, start / scale, lines);
        end = Math.floor(cut * scale);
        if (end <= start) throw new Error("No safe page break could be found.");
      }
      slices.push({ start, end });
      start = end;
    }
    return slices;
  }

  async function downloadPDF() {
    if (button.disabled) return;
    const label = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Preparing PDF…";
    status.textContent = "Preparing images and fonts…";
    delete status.dataset.error;

    try {
      if (!window.htmlToImage?.toCanvas || !window.jspdf?.jsPDF) {
        throw new Error("PDF libraries are unavailable. Reload the page and try again.");
      }
      const source = document.querySelector(".my-resume");
      const [fontEmbedCSS] = await withTimeout(Promise.all([iconFontCSS(), document.fonts.ready, waitForImages(source)]), 15000, "Images or fonts took too long to load.");
      status.textContent = "Rendering PDF…";
      const canvas = await withTimeout(window.htmlToImage.toCanvas(source, {
        pixelRatio: 3,
        backgroundColor: "#ffffff",
        fontEmbedCSS,
        // Avoid capturing the outer page shadow; all card shadows are retained.
        style: { boxShadow: "none", margin: "0" }
      }), 60000, "PDF rendering timed out. Please try again.");

      const pdf = new window.jspdf.jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
      pdf.setProperties({ title: "Nguyen Le Vinh - Fullstack .NET Developer", author: "Nguyen Le Vinh", subject: "Curriculum Vitae" });
      const margin = 6;
      const width = pdf.internal.pageSize.getWidth() - margin * 2;
      const height = pdf.internal.pageSize.getHeight() - margin * 2;
      const sourceWidth = source.getBoundingClientRect().width;
      const slices = pageSlices(source, canvas, height * sourceWidth / width);

      slices.forEach(({ start, end }, index) => {
        if (index) pdf.addPage();
        const page = document.createElement("canvas");
        page.width = canvas.width;
        page.height = end - start;
        const context = page.getContext("2d");
        if (!context) throw new Error("Canvas is unavailable in this browser.");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, page.width, page.height);
        context.drawImage(canvas, 0, start, canvas.width, page.height, 0, 0, page.width, page.height);
        // PNG keeps small text and the gradient palette free of JPEG artifacts.
        pdf.addImage(page.toDataURL("image/png"), "PNG", margin, margin, width, page.height * width / page.width, undefined, "FAST");
        page.width = page.height = 0;
      });
      canvas.width = canvas.height = 0;
      await pdf.save(filename, { returnPromise: true });
      status.textContent = "PDF ready. Check your browser downloads.";
    } catch (error) {
      console.error("PDF export failed:", error);
      status.dataset.error = "true";
      status.textContent = "Could not create the PDF. Please reload the page and try again.";
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.innerHTML = label;
    }
  }

  button.addEventListener("click", downloadPDF);
})();
