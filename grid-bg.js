// ============================================================
// Vista PDF — Interactive Grid Background
//
// Topology: an infinite torus of cells. Each cell drifts at 63°.
// When a cell's origin crosses the right (or bottom) wrap edge, the
// cell teleports back to the left (or top) margin — the grid is
// finite but renders as if endless because every column/row is
// rendered in *spatial* order (not array order), via per-row
// startCol[] and per-column startRow[] offsets that advance each
// time a cell wraps.
//
// This eliminates two prior bugs:
//   1) "Jolt every ~5s" — old code wrapped a single global driftX
//      from SPACING→0, snapping every point's target left by one cell.
//   2) "Empty L on the top-left" — old code shifted every origin
//      +SPACING per wrap, so the leftmost cells gradually crept off the
//      left edge of the viewport leaving a missing strip.
// ============================================================

(() => {
  const canvas = document.getElementById('bgGrid');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });

  // ----- Look -----
  const LINE_COLOR = 'rgba(140, 146, 154, 0.55)';
  const LINE_WIDTH = 1.0;

  // ----- Grid -----
  const SPACING = 42;
  const MARGIN_CELLS = 6; // big off-screen buffer so edge clicks never expose voids

  // ----- Drift (63°, down-right) -----
  const DRIFT_ANGLE_DEG = 63;
  const DRIFT_SPEED = 0.18;
  const DRIFT_VX = Math.cos(DRIFT_ANGLE_DEG * Math.PI / 180) * DRIFT_SPEED;
  const DRIFT_VY = Math.sin(DRIFT_ANGLE_DEG * Math.PI / 180) * DRIFT_SPEED;

  // ----- Interaction -----
  const HOVER_RADIUS = 240;
  const HOVER_PULL   = 0.35;
  const BH_RADIUS    = 420;       // smaller bowl — less of the page warps
  const BH_PULL_MAX  = 0.55;      // half-strength — lensy, not crushing
  // Hold-to-pull: strength lerps toward 1 while held, toward 0 when released.
  const BH_RAMP_RATE = 0.18;      // ease-in rate while holding
  const BH_FADE_RATE = 0.07;      // slower ease-out after release
  const EASE = 0.30;

  // ----- State -----
  let dpr = 1, W = 0, H = 0;
  let cols = 0, rows = 0;
  let points = [];
  let startCol, startRow;       // Int32Arrays — rotation offsets per row / per column
  let xRange = 0, yRange = 0;
  let leftEdge = 0, topEdge = 0;
  let wrapRightAt = 0, wrapBottomAt = 0;

  const mouse = { x: -9999, y: -9999, inside: false };

  // Hold-to-pull state: bhStrength eases toward 1 while pointerDown, toward 0 otherwise.
  let pointerDown = false;
  let bhX = 0, bhY = 0;
  let bhStrength = 0;

  // ----- Setup -----
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cols = Math.ceil(W / SPACING) + 2 * MARGIN_CELLS;
    rows = Math.ceil(H / SPACING) + 2 * MARGIN_CELLS;
    xRange = cols * SPACING;
    yRange = rows * SPACING;
    leftEdge = -MARGIN_CELLS * SPACING;
    topEdge  = -MARGIN_CELLS * SPACING;
    // Wrap each cell when its origin has drifted one full SPACING past
    // the rightmost (or bottommost) initial position.
    wrapRightAt  = leftEdge + xRange;  // = (cols - MARGIN_CELLS) * SPACING
    wrapBottomAt = topEdge  + yRange;

    points = new Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ox = leftEdge + c * SPACING;
        const oy = topEdge  + r * SPACING;
        points[r * cols + c] = { ox, oy, x: ox, y: oy };
      }
    }
    startCol = new Int32Array(rows);  // all zeros — default left-to-right order
    startRow = new Int32Array(cols);  // all zeros — default top-to-bottom order
  }

  // ----- Input -----
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.inside = true;
    // While held, the singularity follows the cursor
    if (pointerDown) { bhX = e.clientX; bhY = e.clientY; }
  }, { passive: true });

  document.addEventListener('mouseleave', () => { mouse.inside = false; });

  window.addEventListener('pointerdown', (e) => {
    bhX = e.clientX; bhY = e.clientY;
    pointerDown = true;
  }, { passive: true });

  // Release from anywhere ends the hold — even if pointer moved off the window.
  window.addEventListener('pointerup',     () => { pointerDown = false; }, { passive: true });
  window.addEventListener('pointercancel', () => { pointerDown = false; }, { passive: true });
  window.addEventListener('blur',          () => { pointerDown = false; });

  window.addEventListener('resize', resize);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ----- Main loop -----
  function tick(now) {
    // 1) Drift every cell's origin. Wrap individually + update rotation indices.
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const p = points[base + c];
        p.ox += DRIFT_VX;
        p.oy += DRIFT_VY;
        if (p.ox > wrapRightAt) {
          p.ox -= xRange;
          p.x  -= xRange;
          // This cell is now spatially leftmost in row r
          startCol[r] = c;
        }
        if (p.oy > wrapBottomAt) {
          p.oy -= yRange;
          p.y  -= yRange;
          // This cell is now spatially topmost in column c
          startRow[c] = r;
        }
      }
    }

    // While released and still fading, the singularity drifts with the grid.
    // While held, the cursor anchors it (mousemove keeps overwriting bhX/bhY).
    if (!pointerDown && bhStrength > 0.001) {
      bhX += DRIFT_VX;
      bhY += DRIFT_VY;
    }

    // Hold-to-pull strength: ease toward 1 while held, toward 0 when released.
    const targetStrength = pointerDown ? 1 : 0;
    const rate = pointerDown ? BH_RAMP_RATE : BH_FADE_RATE;
    bhStrength += (targetStrength - bhStrength) * rate;
    if (!pointerDown && bhStrength < 0.003) bhStrength = 0;

    // 2) Physics — hover + black hole pull, ease toward target
    const hoverActive = mouse.inside;
    const mx = mouse.x, my = mouse.y;
    const hoverR2 = HOVER_RADIUS * HOVER_RADIUS;
    const bhR2    = BH_RADIUS * BH_RADIUS;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let tx = p.ox, ty = p.oy;

      if (!reduced && hoverActive) {
        const dx = mx - p.ox, dy = my - p.oy;
        const d2 = dx * dx + dy * dy;
        if (d2 < hoverR2) {
          const d = Math.sqrt(d2);
          const fall = 1 - d / HOVER_RADIUS;
          const t = fall * fall * HOVER_PULL;
          tx = p.ox + dx * t;
          ty = p.oy + dy * t;
        }
      }

      if (!reduced && bhStrength > 0.001) {
        const dx = bhX - p.ox, dy = bhY - p.oy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bhR2) {
          const d = Math.sqrt(d2);
          const fall = 1 - d / BH_RADIUS;
          const t = Math.sqrt(fall) * bhStrength * BH_PULL_MAX;
          tx = tx + (bhX - tx) * t;
          ty = ty + (bhY - ty) * t;
        }
      }

      p.x += (tx - p.x) * EASE;
      p.y += (ty - p.y) * EASE;
    }

    // 3) Render in *spatial* order using rotation indices
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.strokeStyle = LINE_COLOR;

    const path = new Path2D();

    // Horizontal lines — for each row, walk columns in spatial order
    for (let r = 0; r < rows; r++) {
      const sc = startCol[r];
      const base = r * cols;
      const first = points[base + sc];
      path.moveTo(first.x, first.y);
      for (let i = 1; i < cols; i++) {
        const c = (sc + i) % cols;
        const p = points[base + c];
        path.lineTo(p.x, p.y);
      }
    }

    // Vertical lines — for each column, walk rows in spatial order
    for (let c = 0; c < cols; c++) {
      const sr = startRow[c];
      const first = points[sr * cols + c];
      path.moveTo(first.x, first.y);
      for (let i = 1; i < rows; i++) {
        const r = (sr + i) % rows;
        const p = points[r * cols + c];
        path.lineTo(p.x, p.y);
      }
    }

    ctx.stroke(path);

    requestAnimationFrame(tick);
  }

  resize();
  requestAnimationFrame(tick);
})();
