/**
 * Money Hunter — Client-Side OCR & Cleaning Engine
 * "Track the note, not the person."
 *
 * Responsibilities:
 *   1. Run Tesseract.js against a camera frame, isolate the serial number.
 *   2. Auto-correct common OCR confusions WITHIN THE NUMERIC ZONE ONLY.
 *   3. Validate the cleaned candidate against the RBI serial format.
 *   4. Score confidence and require multi-frame consensus before accepting
 *      a reading — this is the mitigation for the structural risk flagged
 *      in the PRD: a misread that still LOOKS like a valid serial (passes
 *      regex, passes character correction) but is actually the wrong note.
 *      A single sharp-but-wrong frame can do that; two independent frames
 *      agreeing on the same wrong string essentially cannot.
 *   5. Capture geolocation, encode to geohash6 IN MEMORY, and discard the
 *      raw coordinate before it ever leaves this module.
 *
 * No raw lat/long, altitude, or full-precision coordinate is ever placed
 * on an object that gets serialized into a network payload.
 */

// ============================================================================
// 1. SERIAL FORMAT & CHARACTER-CONFUSION CORRECTION
// ============================================================================

// RBI-style serial: 1 digit + 2 alphanumeric (prefix/series) + optional space
// + 6 digits (the "running number" zone).
const SERIAL_REGEX = /^[0-9][A-Z0-9]{2}\s?[0-9]{6}$/;

// Confusions to auto-correct — but ONLY inside the trailing 6-digit numeric
// zone. The prefix zone (position 0-2) legitimately contains letters, so
// applying numeric correction there would corrupt valid series codes.
const NUMERIC_ZONE_CORRECTIONS = {
  O: "0", Q: "0",
  I: "1", L: "1", // uppercase L and lowercase l both normalize to 'L' before lookup
  B: "8",
  S: "5",
  Z: "2",
  G: "6",
};

/**
 * Splits a raw OCR string into { prefixZone, numericZone } and applies
 * confusion correction only to the numeric zone. Returns null if the
 * string can't be segmented into a plausible 3 + 6 character shape.
 */
function segmentAndCorrect(rawText) {
  const cleaned = rawText.toUpperCase().replace(/[^A-Z0-9\s]/g, "").trim();
  const compact = cleaned.replace(/\s+/g, "");

  if (compact.length !== 9) return null; // 3 prefix chars + 6 numeric chars

  const prefixZone = compact.slice(0, 3);
  let numericZone = compact.slice(3, 9);

  numericZone = numericZone
    .split("")
    .map((ch) => NUMERIC_ZONE_CORRECTIONS[ch] ?? ch)
    .join("");

  // After correction, the numeric zone must be all digits — if it still
  // isn't, this candidate is unsalvageable and should be rejected rather
  // than guessed at further.
  if (!/^[0-9]{6}$/.test(numericZone)) return null;

  return { prefixZone, numericZone, formatted: `${prefixZone} ${numericZone}` };
}

/**
 * Validates a fully-assembled candidate against the strict RBI regex.
 */
function isValidSerialFormat(formatted) {
  return SERIAL_REGEX.test(formatted);
}

// ============================================================================
// 2. CONFIDENCE SCORING
// ============================================================================

/**
 * Tesseract.js returns per-symbol confidence (0-100) in result.data.symbols
 * (or .words, depending on configured detail level). We combine:
 *   - mean OCR confidence across the recognized region
 *   - a penalty for every character that required auto-correction, since
 *     each correction is the engine admitting a guess, not a certain read
 *
 * Returns a 0.000–1.000 score, stored as scans.ocr_confidence server-side.
 */
function computeConfidenceScore(tesseractResult, correctionCount) {
  const symbols = tesseractResult?.data?.symbols ?? tesseractResult?.data?.words ?? [];
  if (symbols.length === 0) return 0;

  const meanConfidence =
    symbols.reduce((sum, s) => sum + (s.confidence ?? 0), 0) / symbols.length / 100;

  const correctionPenalty = Math.min(correctionCount * 0.08, 0.4); // cap penalty at 0.4
  const score = Math.max(0, meanConfidence - correctionPenalty);

  return Math.round(score * 1000) / 1000;
}

const MIN_ACCEPT_CONFIDENCE = 0.55; // below this, we don't even attempt consensus
const MIN_CONSENSUS_FRAMES = 2;      // number of independent frames that must agree

// ============================================================================
// 3. MULTI-FRAME CONSENSUS
// ============================================================================

/**
 * Tracks OCR candidates across consecutive camera frames during a single
 * scan session. Only accepts a reading once the same formatted serial has
 * been independently produced MIN_CONSENSUS_FRAMES times. This is the
 * primary defense against a single confident-but-wrong misread silently
 * entering the trail as a phantom note or a false velocity flag.
 */
class ConsensusTracker {
  constructor() {
    this.candidates = new Map(); // formatted serial -> { count, confidences: [] }
  }

  /**
   * Feed one frame's result. Returns the accepted reading once consensus
   * is reached, or null if still collecting.
   */
  submit(formatted, confidence) {
    if (!this.candidates.has(formatted)) {
      this.candidates.set(formatted, { count: 0, confidences: [] });
    }
    const entry = this.candidates.get(formatted);
    entry.count += 1;
    entry.confidences.push(confidence);

    if (entry.count >= MIN_CONSENSUS_FRAMES) {
      return {
        serial_number: formatted,
        ocr_confidence: Math.max(...entry.confidences), // best observed, not averaged
        consensus_frames: entry.count,
      };
    }
    return null;
  }

  reset() {
    this.candidates.clear();
  }
}

// ============================================================================
// 4. TESSERACT.JS INTEGRATION
// ============================================================================

let tesseractWorker = null;

async function getWorker() {
  if (tesseractWorker) return tesseractWorker;
  // Tesseract.js loaded globally via CDN <script> tag in index.html, or
  // import Tesseract from 'tesseract.js' if bundled.
  tesseractWorker = await Tesseract.createWorker("eng", 1, {
    logger: () => {}, // wire to a UI progress indicator if desired
  });
  await tesseractWorker.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    tessedit_pageseg_mode: "7", // single text line — the serial number strip
  });
  return tesseractWorker;
}

/**
 * Runs OCR against a single cropped frame (canvas/ImageBitmap of the
 * serial-number viewfinder region) and returns a validated candidate, or
 * null if this frame didn't produce anything usable.
 */
async function processFrame(imageSource) {
  const worker = await getWorker();
  const result = await worker.recognize(imageSource);
  const rawText = result.data.text || "";

  const segmented = segmentAndCorrect(rawText);
  if (!segmented) return null;

  const correctionCount = countCorrections(rawText, segmented);
  const confidence = computeConfidenceScore(result, correctionCount);

  if (!isValidSerialFormat(segmented.formatted)) return null;
  if (confidence < MIN_ACCEPT_CONFIDENCE) return null;

  return { formatted: segmented.formatted, confidence };
}

function countCorrections(rawText, segmented) {
  const compact = rawText.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const originalNumericZone = compact.slice(3, 9);
  let corrections = 0;
  for (let i = 0; i < segmented.numericZone.length; i++) {
    if (originalNumericZone[i] !== segmented.numericZone[i]) corrections++;
  }
  return corrections;
}

// ============================================================================
// 5. GEOHASH ENCODING — raw coordinates never persist past this function
// ============================================================================

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/**
 * Standard geohash encoding, truncated to 6 characters (~1.2km x 0.6km
 * cell). This is a pure function: it takes primitives in, returns a string,
 * and holds no reference to the input after returning.
 */
function encodeGeohash6(lat, lon) {
  let latRange = [-90, 90];
  let lonRange = [-180, 180];
  let isEven = true;
  let bit = 0;
  let ch = 0;
  let geohash = "";

  while (geohash.length < 6) {
    if (isEven) {
      const mid = (lonRange[0] + lonRange[1]) / 2;
      if (lon > mid) { ch |= (1 << (4 - bit)); lonRange[0] = mid; }
      else { lonRange[1] = mid; }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (lat > mid) { ch |= (1 << (4 - bit)); latRange[0] = mid; }
      else { latRange[1] = mid; }
    }
    isEven = !isEven;
    if (bit < 4) { bit++; }
    else { geohash += GEOHASH_BASE32[ch]; bit = 0; ch = 0; }
  }
  return geohash;
}

/**
 * Captures the device's current position, encodes it to geohash6, and
 * resolves ONLY with the encoded string. The raw GeolocationPosition object
 * goes out of scope the instant this function returns — nothing holds a
 * reference to it, nothing logs it, nothing attaches it to a payload.
 */
function captureGeohash6() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation unavailable on this device"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const encoded = encodeGeohash6(position.coords.latitude, position.coords.longitude);
        // position falls out of scope here — nothing retains lat/long/altitude.
        resolve(encoded);
      },
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

// ============================================================================
// 6. IMAGE PROOF — crop, compress, and structural liveness/paper checks
// ============================================================================
//
// Everything in this section runs on-device before anything touches the
// network. Only the small compressed crop + a pass/fail liveness verdict
// leave the browser — never a full-frame image, never raw pixel buffers.

const CROP_MARGIN_PX = 2 * 96; // ~2 inches at 96dpi around the serial strip
const WEBP_TARGET_BYTES = 30 * 1024;
const WEBP_TARGET_QUALITY_START = 0.72;

/**
 * Crops a ~2-inch margin around the serial-number bounding box from the
 * source frame and encodes it as WebP, stepping quality down until the
 * result lands near WEBP_TARGET_BYTES (~30KB). Returns a Blob, or null if
 * the browser can't produce WebP (falls back gracefully — the scan can
 * still proceed without a photo proof).
 */
async function cropAndCompressToWebP(sourceCanvas, serialBoundingBox) {
  const { x, y, width, height } = serialBoundingBox;
  const cropX = Math.max(0, x - CROP_MARGIN_PX);
  const cropY = Math.max(0, y - CROP_MARGIN_PX);
  const cropW = Math.min(sourceCanvas.width - cropX, width + CROP_MARGIN_PX * 2);
  const cropH = Math.min(sourceCanvas.height - cropY, height + CROP_MARGIN_PX * 2);

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  const ctx = cropCanvas.getContext("2d");
  ctx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  let quality = WEBP_TARGET_QUALITY_START;
  let blob = await canvasToWebP(cropCanvas, quality);
  if (!blob) return null; // WebP unsupported in this browser

  // Step quality down until we're at/under the target size, or we've tried
  // enough times — never loop indefinitely on a stubborn frame.
  let attempts = 0;
  while (blob && blob.size > WEBP_TARGET_BYTES && quality > 0.25 && attempts < 6) {
    quality -= 0.1;
    blob = await canvasToWebP(cropCanvas, quality);
    attempts += 1;
  }

  return { blob, cropCanvas };
}

function canvasToWebP(canvas, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/webp", quality);
  });
}

/**
 * Background-pattern liveness check: samples pixel variance in the margin
 * surrounding the serial strip (i.e. NOT the serial digits themselves).
 * A genuine banknote has fine-grained security print texture — guilloche
 * patterns, microtext, colour-shifting ink — in that margin. A serial
 * number handwritten or printed on a blank sheet of paper instead shows a
 * near-uniform, low-variance background. This is a coarse pre-filter, not
 * a forensic verdict — it flags for review rather than hard-blocking.
 */
function checkBackgroundLiveness(cropCanvas, serialBoundingBoxRelative) {
  const ctx = cropCanvas.getContext("2d");
  const { width, height } = cropCanvas;
  const { x, y, width: sw, height: sh } = serialBoundingBoxRelative;

  const marginPixels = sampleMarginPixels(ctx, width, height, { x, y, width: sw, height: sh });
  if (marginPixels.length === 0) {
    return { pass: true, reason: "insufficient-margin-sample" }; // fail open, not closed
  }

  const variance = pixelVariance(marginPixels);
  const PLAIN_PAPER_VARIANCE_THRESHOLD = 12; // empirically low for blank/matte paper

  return {
    pass: variance >= PLAIN_PAPER_VARIANCE_THRESHOLD,
    variance,
    reason: variance < PLAIN_PAPER_VARIANCE_THRESHOLD ? "background-too-uniform" : "ok",
  };
}

function sampleMarginPixels(ctx, canvasW, canvasH, serialBox) {
  const samples = [];
  const step = 6; // sparse sampling grid keeps this cheap
  for (let py = 0; py < canvasH; py += step) {
    for (let px = 0; px < canvasW; px += step) {
      const insideSerial =
        px >= serialBox.x && px <= serialBox.x + serialBox.width &&
        py >= serialBox.y && py <= serialBox.y + serialBox.height;
      if (insideSerial) continue; // only sample the surrounding margin
      const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
      samples.push((r + g + b) / 3);
    }
  }
  return samples;
}

function pixelVariance(values) {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sq = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(sq);
}

/**
 * Lightweight Moiré-interference check: a photo-of-a-photo (rescanning a
 * phone/laptop screen showing the note) produces regular high-frequency
 * banding from the beat between the display's pixel grid and the camera
 * sensor's grid — something a genuine paper-and-ink note under normal
 * lighting doesn't produce. We approximate frequency-domain detection with
 * a cheap row/column gradient-oscillation count rather than a full FFT, to
 * keep this fast enough to run per-frame in the browser.
 */
function detectMoirePattern(cropCanvas) {
  const ctx = cropCanvas.getContext("2d");
  const { width, height } = cropCanvas;
  const gray = toGrayscaleRow(ctx, width, height, Math.floor(height / 2));

  let signFlips = 0;
  for (let i = 2; i < gray.length; i++) {
    const d1 = gray[i - 1] - gray[i - 2];
    const d2 = gray[i] - gray[i - 1];
    if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2)) signFlips++;
  }

  // Regular, high-frequency oscillation across the sampled row is the
  // Moiré signature; organic print/lighting noise flips far less often.
  const MOIRE_FLIP_RATIO_THRESHOLD = 0.35;
  const flipRatio = signFlips / gray.length;

  return {
    pass: flipRatio < MOIRE_FLIP_RATIO_THRESHOLD,
    flipRatio,
    reason: flipRatio >= MOIRE_FLIP_RATIO_THRESHOLD ? "moire-interference-detected" : "ok",
  };
}

function toGrayscaleRow(ctx, width, height, rowY) {
  const { data } = ctx.getImageData(0, rowY, width, 1);
  const row = new Array(width);
  for (let i = 0; i < width; i++) {
    const off = i * 4;
    row[i] = 0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2];
  }
  return row;
}

/**
 * Runs both structural checks and returns a single verdict. Callers should
 * treat a failing verdict as "flag for manual review", not necessarily a
 * hard reject — false positives are possible under unusual lighting.
 */
function runStructuralLivenessChecks(cropCanvas, serialBoundingBoxRelative) {
  const background = checkBackgroundLiveness(cropCanvas, serialBoundingBoxRelative);
  const moire = detectMoirePattern(cropCanvas);
  return {
    pass: background.pass && moire.pass,
    background,
    moire,
  };
}

// ============================================================================
// 7. PAYLOAD ASSEMBLY — what actually gets queued for /v1/scans
// ============================================================================

/**
 * Assembles the exact object that gets written to the IndexedDB offline
 * queue (and eventually POSTed). This is the single choke point that
 * guarantees raw location and unvalidated serials never reach the network
 * layer.
 */
async function assembleScanPayload({
  serial_number,
  ocr_confidence,
  scan_source,
  node_type,
  photoBlob = null,      // compressed WebP crop from cropAndCompressToWebP(), or null
  livenessVerdict = null, // result of runStructuralLivenessChecks(), or null
}) {
  if (!isValidSerialFormat(serial_number)) {
    throw new Error("Refusing to assemble payload: invalid serial format");
  }

  const geohash6 = await captureGeohash6();

  return {
    local_id: crypto.randomUUID(),           // idempotency key for offline sync
    serial_number,
    geohash6,                                  // raw coordinates already discarded
    captured_at: new Date().toISOString(),     // client clock; server rounds to 5-min bucket
    scan_source,                               // 'citizen' | 'institutional'
    node_type: node_type ?? null,
    ocr_confidence,
    photo: photoBlob,                          // uploaded separately as multipart; not inlined as base64
    liveness_ok: livenessVerdict ? livenessVerdict.pass : null,
    liveness_detail: livenessVerdict
      ? { background: livenessVerdict.background?.reason, moire: livenessVerdict.moire?.reason }
      : null,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  segmentAndCorrect,
  isValidSerialFormat,
  computeConfidenceScore,
  ConsensusTracker,
  processFrame,
  encodeGeohash6,
  captureGeohash6,
  assembleScanPayload,
  cropAndCompressToWebP,
  checkBackgroundLiveness,
  detectMoirePattern,
  runStructuralLivenessChecks,
  MIN_ACCEPT_CONFIDENCE,
  MIN_CONSENSUS_FRAMES,
};
