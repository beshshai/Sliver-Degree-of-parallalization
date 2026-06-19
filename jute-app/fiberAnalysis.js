/**
 * Fiber Parallelization Analysis Engine
 * -------------------------------------
 * Algorithmic (non-AI) analysis of fiber/sliver alignment from an image,
 * using Sobel gradient edge detection + circular statistics on the
 * resulting orientation distribution.
 *
 * Works in both browser (with Canvas ImageData) and Node.js (with any
 * library that produces an {data, width, height} RGBA buffer, e.g. sharp
 * or jimp -- see NODE_USAGE_NOTES at the bottom of this file).
 *
 * No external dependencies. Pure JS, ES2020+.
 */

/**
 * Convert RGBA image data to a grayscale Float32Array.
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} imageData
 * @returns {Float32Array}
 */
function toGray(imageData) {
  const { data, width, height } = imageData;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return gray;
}

/**
 * Run Sobel gradient filters and extract per-pixel fiber orientation angles
 * (weighted by gradient magnitude). Angles are in degrees, range [0, 180),
 * already rotated 90 degrees from the raw gradient direction so that the
 * angle represents the direction of the FIBER (edge), not the gradient
 * normal.
 *
 * @param {Float32Array} gray
 * @param {number} w
 * @param {number} h
 * @param {number} magThreshold - minimum gradient magnitude to count a pixel (default 12)
 * @returns {{angles: number[], mags: number[], gx: Float32Array, gy: Float32Array}}
 */
function sobelOrientations(gray, w, h, magThreshold = 12) {
  const angles = [];
  const mags = [];
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = gray[i - w - 1], tc = gray[i - w], tr = gray[i - w + 1];
      const ml = gray[i - 1], mr = gray[i + 1];
      const bl = gray[i + w - 1], bc = gray[i + w], br = gray[i + w + 1];

      const sx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const sy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      gx[i] = sx;
      gy[i] = sy;

      const mag = Math.sqrt(sx * sx + sy * sy);
      if (mag > magThreshold) {
        let ang = Math.atan2(sy, sx) * 180 / Math.PI;
        ang = (ang + 180) % 180;
        const fiberAng = (ang + 90) % 180;
        angles.push(fiberAng);
        mags.push(mag);
      }
    }
  }

  return { angles, mags, gx, gy };
}

/**
 * Compute weighted circular statistics on a set of angles in [0, 180).
 * Angles are doubled internally to correctly handle the 180-degree
 * periodicity of line orientations (0 deg and 180 deg are the same direction).
 *
 * @param {number[]} angles - degrees, [0, 180)
 * @param {number[]} mags - weights (e.g. gradient magnitude) per angle
 * @returns {{meanAngle: number, R: number, circVar: number, circStdDeg: number}}
 */
function weightedCircularStats(angles, mags) {
  let sumW = 0, sumSin = 0, sumCos = 0;
  for (let i = 0; i < angles.length; i++) {
    const rad = (angles[i] * 2 * Math.PI) / 180;
    const w = mags[i];
    sumSin += w * Math.sin(rad);
    sumCos += w * Math.cos(rad);
    sumW += w;
  }

  const R = Math.sqrt(sumSin * sumSin + sumCos * sumCos) / (sumW || 1);
  let meanAngle = (Math.atan2(sumSin, sumCos) * 180) / Math.PI / 2;
  meanAngle = ((meanAngle % 180) + 180) % 180;

  const circVar = 1 - R;
  const circStdDeg = Math.min(
    Math.sqrt(-2 * Math.log(R + 1e-9)) * 180 / Math.PI,
    90
  );

  return { meanAngle, R, circVar, circStdDeg };
}

/**
 * Bucket angles into a histogram (for visualization), weighted by magnitude.
 * Returns values normalized to [0, 1].
 *
 * @param {number[]} angles
 * @param {number[]} mags
 * @param {number} bins - default 36 (5-degree bins)
 * @returns {number[]}
 */
function buildHistogram(angles, mags, bins = 36) {
  const hist = new Array(bins).fill(0);
  for (let i = 0; i < angles.length; i++) {
    let b = Math.floor(angles[i] / (180 / bins));
    if (b >= bins) b = bins - 1;
    hist[b] += mags[i];
  }
  const max = Math.max(...hist, 1);
  return hist.map((v) => v / max);
}

/**
 * Convert circular variance into a 0-100 "parallelization score".
 * 100 = perfectly aligned fibers, 0 = fully random orientation.
 *
 * @param {number} circVar
 * @returns {number}
 */
function computeScore(circVar) {
  return Math.max(0, Math.min(100, Math.round((1 - circVar) * 100)));
}

/**
 * Full pipeline: takes raw RGBA image data, returns the complete analysis.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} imageData
 * @param {object} [options]
 * @param {number} [options.magThreshold=12]
 * @param {number} [options.histBins=36]
 * @returns {object} analysis result, or {error: string} if insufficient texture
 */
function analyzeFiberParallelization(imageData, options = {}) {
  const { magThreshold = 12, histBins = 36 } = options;
  const { width: w, height: h } = imageData;

  const gray = toGray(imageData);
  const { angles, mags, gx, gy } = sobelOrientations(gray, w, h, magThreshold);

  if (angles.length < 20) {
    return {
      error:
        'Not enough texture detected. Try a higher-contrast or higher-resolution image.',
    };
  }

  const stats = weightedCircularStats(angles, mags);
  const hist = buildHistogram(angles, mags, histBins);
  const score = computeScore(stats.circVar);

  return {
    width: w,
    height: h,
    score,
    meanAngleDeg: round1(stats.meanAngle),
    resultantLengthR: round3(stats.R),
    circularVariance: round3(stats.circVar),
    angularStdDevDeg: round1(stats.circStdDeg),
    edgePixelCount: angles.length,
    histogram: hist,
    // gx/gy are returned only if the caller wants to render a gradient
    // magnitude map; omit from API responses if payload size matters.
    _gx: gx,
    _gy: gy,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Helper: build a grayscale gradient-magnitude preview as a flat RGBA
 * buffer (e.g. to re-encode as PNG for the gradient map visualization).
 *
 * @param {Float32Array} gx
 * @param {Float32Array} gy
 * @param {number} w
 * @param {number} h
 * @returns {Uint8ClampedArray} RGBA buffer, length w*h*4
 */
function gradientMagnitudeBuffer(gx, gy, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const mag = Math.min(255, Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]));
    out[i * 4] = mag;
    out[i * 4 + 1] = mag;
    out[i * 4 + 2] = mag;
    out[i * 4 + 3] = 255;
  }
  return out;
}

module.exports = {
  toGray,
  sobelOrientations,
  weightedCircularStats,
  buildHistogram,
  computeScore,
  analyzeFiberParallelization,
  gradientMagnitudeBuffer,
};

/**
 * NODE_USAGE_NOTES
 * -----------------
 * In a Node backend you won't have `Canvas`/`ImageData` natively. Use the
 * `sharp` library to decode an uploaded image into a raw RGBA buffer that
 * matches the {data, width, height} shape this module expects:
 *
 *   const sharp = require('sharp');
 *   const { analyzeFiberParallelization } = require('./fiberAnalysis');
 *
 *   async function analyzeUpload(fileBuffer) {
 *     const MAX_DIM = 480; // matches the downscale used in the prototype
 *     const image = sharp(fileBuffer).rotate(); // auto-orient
 *     const metadata = await image.metadata();
 *     const scale = Math.min(1, MAX_DIM / Math.max(metadata.width, metadata.height));
 *     const targetW = Math.round(metadata.width * scale);
 *     const targetH = Math.round(metadata.height * scale);
 *
 *     const { data, info } = await image
 *       .resize(targetW, targetH)
 *       .ensureAlpha()
 *       .raw()
 *       .toBuffer({ resolveWithObject: true });
 *
 *     const imageData = { data, width: info.width, height: info.height };
 *     return analyzeFiberParallelization(imageData);
 *   }
 *
 * To render the gradient map as a downloadable/storable PNG:
 *
 *   const buf = gradientMagnitudeBuffer(result._gx, result._gy, result.width, result.height);
 *   await sharp(buf, { raw: { width: result.width, height: result.height, channels: 4 } })
 *     .png()
 *     .toFile('gradient-map.png');
 *
 * Strip `_gx`/`_gy` from the result object before sending it as JSON in an
 * API response -- they're large typed arrays meant only for local
 * visualization rendering, not for the wire.
 */
