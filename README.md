# Vista Compressor

A browser-based PDF tool for the Vista Site Selection team.
**Merge · rearrange · edit · compress · ship.** All processing happens
locally in your browser — files never get uploaded anywhere.

🔗 **Live tool:** https://mrwhfloydiv.github.io/VISTA_COMPRESSOR/

## What it does

- **Merge** any number of PDFs (and JPG/PNG images) into one document
- **Rearrange** files in the order you want them combined
- **Edit pages** — drag to reorder across documents, delete pages, right-click to insert,
  zoom-preview before deleting, undo with Ctrl+Z
- **Compress** with three quality levels using Ghostscript-WASM
  - **Light Squeeze** — 300 DPI, archive quality (~60% smaller)
  - **Email Ready** — 110 DPI, sharp text (~80% smaller)
  - **Max Crunch** — 95 DPI, screen-ready (~87% smaller)
- **Optionally make scanned PDFs searchable** with Tesseract.js OCR — adds
  invisible text layer so Ctrl+F and copy-paste work on scans
- **Sankey visualization** of the input → merged → compressed flow

## Real-world numbers

Tested on a 127 MB bundle of 7 scanned legal documents (130 pages):

| Preset | Output | Reduction |
|---|---|---|
| Low | 52.79 MB | -58.6% |
| Recommended | 23.43 MB | -81.6% |
| Extreme | 16.30 MB | -87.2% |
| Extreme + searchable | 18.56 MB | -85.4% (now Ctrl+F works) |

For reference, iLovePDF produced 21.1 MB on the same bundle without OCR.

## Tech

- 100% client-side — no server, no upload, no third-party processing
- **Ghostscript** compiled to WASM via [@jspawn/ghostscript-wasm](https://github.com/jsscheller/ghostscript-wasm) for compression
- **Tesseract.js** for OCR
- **pdf-lib** for merging and text-layer baking
- **PDF.js** for in-browser page rendering
- **fontkit** for embedding subsetted Noto Sans when OCR encounters unicode

## License

The compression engine inherits Ghostscript's AGPL-3.0 license. The rest of the
code is internal to Vista Site Selection — please don't redistribute outside the
team without checking first.
