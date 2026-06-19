const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const { analyzeFiberParallelization } = require('./fiberAnalysis');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_DIM = 480;

// --- AI image validation -----------------------------------------------

async function validateJuteImage(imageBuffer, mimeType) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — skipping image validation');
    return { valid: true };
  }

  const base64Image = imageBuffer.toString('base64');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: `You are a quality-control gate for a jute fiber analysis app.
Examine this image and decide if it shows jute sliver, jute fiber, raw jute, or similar fibrous textile material suitable for parallelization analysis.

Reply with ONLY a JSON object, no other text:
{"valid": true, "reason": "brief reason"}
or
{"valid": false, "reason": "brief reason explaining what the image actually shows"}

Be strict: textbooks, people, food, landscapes, documents, random objects, or anything not clearly showing fibrous/textile material should be rejected.` }
        ],
      }],
    }),
  });

  if (!response.ok) {
    console.error('Anthropic validation error:', await response.text());
    return { valid: true };
  }

  const data = await response.json();
  const text = data.content.map(b => b.text || '').join('').trim();
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    return { valid: true };
  }
}

// -----------------------------------------------------------------------

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// --- session helpers ---------------------------------------------------

function getSessionUser(req) {
  const userId = req.cookies.user_id;
  if (!userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
}

function requireUser(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

// --- session routes ----------------------------------------------------

app.post('/api/session', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > 50) return res.status(400).json({ error: 'Name too long' });

  let user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!user) {
    const info = db.prepare('INSERT INTO users (name) VALUES (?)').run(name);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  res.cookie('user_id', user.id, { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 365, sameSite: 'lax' });
  res.json({ user });
});

app.get('/api/session', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('user_id');
  res.json({ ok: true });
});

// --- batch routes ------------------------------------------------------

// Create a new batch
app.post('/api/batches', requireUser, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Batch name is required' });
  if (name.length > 100) return res.status(400).json({ error: 'Name too long' });

  const id = uuidv4();
  const notes = (req.body.notes || '').trim() || null;

  db.prepare(`INSERT INTO batches (id, user_id, name, notes) VALUES (?, ?, ?, ?)`)
    .run(id, req.user.id, name, notes);

  // Create folder on disk right away
  const batchDir = path.join(uploadsDir, id);
  if (!fs.existsSync(batchDir)) fs.mkdirSync(batchDir, { recursive: true });

  const batch = db.prepare(`
    SELECT batches.*, users.name AS user_name,
      (SELECT COUNT(*) FROM samples WHERE batch_id = batches.id) AS sample_count
    FROM batches JOIN users ON users.id = batches.user_id
    WHERE batches.id = ?
  `).get(id);

  res.json({ batch });
});

// List batches (open ones first, then closed; filter by user if wanted)
app.get('/api/batches', (req, res) => {
  const { user_id, closed } = req.query;
  let query = `
    SELECT batches.*, users.name AS user_name,
      (SELECT COUNT(*) FROM samples WHERE batch_id = batches.id) AS sample_count,
      (SELECT ROUND(AVG(score),1) FROM samples WHERE batch_id = batches.id) AS avg_score
    FROM batches JOIN users ON users.id = batches.user_id
    WHERE 1=1
  `;
  const params = [];

  if (user_id) { query += ' AND batches.user_id = ?'; params.push(user_id); }
  if (closed !== undefined) { query += ' AND batches.closed = ?'; params.push(Number(closed)); }

  query += ' ORDER BY batches.closed ASC, batches.created_at DESC';
  res.json({ batches: db.prepare(query).all(...params) });
});

// Close a batch (marks it done — images can still be added if needed)
app.patch('/api/batches/:id/close', requireUser, (req, res) => {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.user_id !== req.user.id) return res.status(403).json({ error: 'Not your batch' });

  db.prepare(`UPDATE batches SET closed = 1, closed_at = datetime('now') WHERE id = ?`).run(batch.id);
  res.json({ ok: true });
});

// Re-open a closed batch
app.patch('/api/batches/:id/reopen', requireUser, (req, res) => {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });
  if (batch.user_id !== req.user.id) return res.status(403).json({ error: 'Not your batch' });

  db.prepare(`UPDATE batches SET closed = 0, closed_at = NULL WHERE id = ?`).run(batch.id);
  res.json({ ok: true });
});

// Get one batch with its samples
app.get('/api/batches/:id', (req, res) => {
  const batch = db.prepare(`
    SELECT batches.*, users.name AS user_name,
      (SELECT COUNT(*) FROM samples WHERE batch_id = batches.id) AS sample_count,
      (SELECT ROUND(AVG(score),1) FROM samples WHERE batch_id = batches.id) AS avg_score
    FROM batches JOIN users ON users.id = batches.user_id
    WHERE batches.id = ?
  `).get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Not found' });

  const samples = db.prepare(`
    SELECT samples.*, users.name AS user_name
    FROM samples JOIN users ON users.id = samples.user_id
    WHERE samples.batch_id = ?
    ORDER BY samples.created_at ASC
  `).all(req.params.id);

  res.json({ batch, samples });
});

// --- samples routes ----------------------------------------------------

app.post('/api/samples', requireUser, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    // AI validation
    const mimeType = req.file.mimetype || 'image/jpeg';
    const validation = await validateJuteImage(req.file.buffer, mimeType);
    if (!validation.valid) {
      return res.status(422).json({
        error: 'This image does not appear to show jute fiber or sliver. ' + (validation.reason || 'Please upload a photo of jute sliver.')
      });
    }

    // Resolve batch — if batch_id given, verify it exists and belongs to this user
    let batchId = (req.body.batch_id || '').trim() || null;
    if (batchId) {
      const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
      if (!batch) return res.status(404).json({ error: 'Batch not found' });
      // allow adding to any open batch regardless of owner (team tool)
    }

    const image = sharp(req.file.buffer).rotate();
    const metadata = await image.metadata();
    const scale = Math.min(1, MAX_DIM / Math.max(metadata.width, metadata.height));
    const targetW = Math.max(1, Math.round(metadata.width * scale));
    const targetH = Math.max(1, Math.round(metadata.height * scale));

    const { data, info } = await image
      .resize(targetW, targetH).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const result = analyzeFiberParallelization({ data, width: info.width, height: info.height });
    if (result.error) return res.status(422).json({ error: result.error });

    // Save to batch subfolder if batch given, else root uploads
    const folder = batchId ? path.join(uploadsDir, batchId) : uploadsDir;
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

    const filename = `${uuidv4()}.jpg`;
    await sharp(req.file.buffer).rotate().resize(targetW, targetH).jpeg({ quality: 82 }).toFile(path.join(folder, filename));

    const imagePath = batchId ? `/uploads/${batchId}/${filename}` : `/uploads/${filename}`;

    const info2 = db.prepare(`
      INSERT INTO samples (
        user_id, batch_id, original_filename, image_path, width, height, score,
        mean_angle_deg, resultant_length_r, circular_variance,
        angular_stddev_deg, edge_pixel_count, histogram_json, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id, batchId,
      req.file.originalname || null, imagePath,
      result.width, result.height, result.score,
      result.meanAngleDeg, result.resultantLengthR, result.circularVariance,
      result.angularStdDevDeg, result.edgePixelCount,
      JSON.stringify(result.histogram),
      (req.body.notes || '').trim() || null
    );

    const row = db.prepare(`
      SELECT samples.*, users.name AS user_name
      FROM samples JOIN users ON users.id = samples.user_id
      WHERE samples.id = ?
    `).get(info2.lastInsertRowid);

    res.json({ sample: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Analysis failed: ' + err.message });
  }
});

app.get('/api/samples', (req, res) => {
  const { user_id, batch_id, from, to, limit = 50, offset = 0 } = req.query;
  let query = `
    SELECT samples.*, users.name AS user_name
    FROM samples JOIN users ON users.id = samples.user_id
    WHERE 1=1
  `;
  const params = [];

  if (user_id) { query += ' AND samples.user_id = ?'; params.push(user_id); }
  if (batch_id) { query += ' AND samples.batch_id = ?'; params.push(batch_id); }
  if (from) { query += ' AND samples.created_at >= ?'; params.push(from); }
  if (to) { query += ' AND samples.created_at <= ?'; params.push(to + ' 23:59:59'); }

  query += ' ORDER BY samples.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  res.json({ samples: db.prepare(query).all(...params) });
});

app.get('/api/samples/:id', (req, res) => {
  const row = db.prepare(`
    SELECT samples.*, users.name AS user_name
    FROM samples JOIN users ON users.id = samples.user_id
    WHERE samples.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ sample: row });
});

app.delete('/api/samples/:id', requireUser, (req, res) => {
  const row = db.prepare('SELECT * FROM samples WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own samples' });
  db.prepare('DELETE FROM samples WHERE id = ?').run(req.params.id);
  fs.unlink(path.join(__dirname, row.image_path), () => {});
  res.json({ ok: true });
});

app.get('/api/users', (req, res) => {
  res.json({ users: db.prepare('SELECT id, name FROM users ORDER BY name').all() });
});

// SQLite strftime formats for each supported bucket size.
// 'log' is handled separately below (no bucketing at all).
const GROUP_BY_FORMATS = {
  hour: '%Y-%m-%d %H:00',
  day: '%Y-%m-%d',
  month: '%Y-%m',
  year: '%Y',
};

app.get('/api/stats/summary', (req, res) => {
  const perUser = db.prepare(`
    SELECT users.id AS user_id, users.name AS user_name, COUNT(*) AS sample_count, ROUND(AVG(samples.score), 1) AS avg_score
    FROM samples JOIN users ON users.id = samples.user_id
    GROUP BY users.id ORDER BY avg_score DESC
  `).all();

  const groupBy = (req.query.group_by || 'day').toLowerCase();

  let overTime;
  if (groupBy === 'log') {
    // No time bucketing — one point per individual sample, in upload order.
    overTime = db.prepare(`
      SELECT id, created_at AS day, score AS avg_score, 1 AS sample_count
      FROM samples ORDER BY created_at ASC
    `).all();
  } else if (groupBy === 'batch') {
    // One point per batch — avg score across all samples in that batch.
    // Batches with zero samples are excluded (nothing to average).
    overTime = db.prepare(`
      SELECT batches.id AS batch_id, batches.name AS day,
        ROUND(AVG(samples.score), 1) AS avg_score, COUNT(samples.id) AS sample_count
      FROM batches JOIN samples ON samples.batch_id = batches.id
      GROUP BY batches.id
      HAVING COUNT(samples.id) > 0
      ORDER BY batches.created_at ASC
    `).all();
  } else if (groupBy === 'batch_log') {
    // Sample-by-sample trend within a single selected batch.
    const batchId = (req.query.batch_id || '').trim();
    if (!batchId) {
      return res.status(400).json({ error: 'batch_id is required for batch_log grouping' });
    }
    overTime = db.prepare(`
      SELECT id, created_at AS day, score AS avg_score, 1 AS sample_count
      FROM samples WHERE batch_id = ? ORDER BY created_at ASC
    `).all(batchId);
  } else {
    const format = GROUP_BY_FORMATS[groupBy] || GROUP_BY_FORMATS.day;
    overTime = db.prepare(`
      SELECT strftime(?, created_at) AS day, ROUND(AVG(score), 1) AS avg_score, COUNT(*) AS sample_count
      FROM samples GROUP BY day ORDER BY day ASC
    `).all(format);
  }

  const knownGroups = ['hour', 'day', 'month', 'year', 'log', 'batch', 'batch_log'];
  res.json({ perUser, overTime, groupBy: knownGroups.includes(groupBy) ? groupBy : 'day' });
});

// --- report routes -----------------------------------------------------

const HIST_BINS = 36; // matches fiberAnalysis.js default

// Combine per-sample histograms (each already normalized 0-1 against its
// own max bin) into one aggregate histogram, weighted by edge pixel count
// so denser/more-textured samples contribute proportionally more, then
// re-normalize the result to 0-1 for display.
function combineHistograms(samples) {
  const combined = new Array(HIST_BINS).fill(0);
  for (const s of samples) {
    if (!s.histogram_json) continue;
    let hist;
    try { hist = JSON.parse(s.histogram_json); } catch (e) { continue; }
    const weight = s.edge_pixel_count || 1;
    for (let i = 0; i < HIST_BINS && i < hist.length; i++) {
      combined[i] += hist[i] * weight;
    }
  }
  const max = Math.max(...combined, 1);
  return combined.map(v => v / max);
}

function buildReportStats(samples) {
  const n = samples.length;
  if (!n) {
    return {
      sampleCount: 0, avgScore: null, minScore: null, maxScore: null,
      avgMeanAngle: null, avgCircularVariance: null, avgAngularStdDev: null,
      scoreDistribution: { good: 0, moderate: 0, poor: 0 },
      histogram: new Array(HIST_BINS).fill(0),
    };
  }

  const sum = (key) => samples.reduce((acc, s) => acc + (s[key] || 0), 0);
  const scores = samples.map(s => s.score);

  const scoreDistribution = { good: 0, moderate: 0, poor: 0 };
  for (const s of scores) {
    if (s >= 75) scoreDistribution.good++;
    else if (s >= 50) scoreDistribution.moderate++;
    else scoreDistribution.poor++;
  }

  return {
    sampleCount: n,
    avgScore: round1(sum('score') / n),
    minScore: Math.min(...scores),
    maxScore: Math.max(...scores),
    avgMeanAngle: round1(sum('mean_angle_deg') / n),
    avgCircularVariance: round3(sum('circular_variance') / n),
    avgAngularStdDev: round1(sum('angular_stddev_deg') / n),
    scoreDistribution,
    histogram: combineHistograms(samples),
  };
}

function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }

// User report: aggregate stats + histogram across all of one user's samples.
app.get('/api/reports/user/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const samples = db.prepare(`
    SELECT samples.*, users.name AS user_name
    FROM samples JOIN users ON users.id = samples.user_id
    WHERE samples.user_id = ?
    ORDER BY samples.created_at DESC
  `).all(req.params.id);

  res.json({
    subject: { type: 'user', id: user.id, name: user.name },
    stats: buildReportStats(samples),
    samples,
  });
});

// Batch report: aggregate stats + histogram across all samples in one batch.
app.get('/api/reports/batch/:id', (req, res) => {
  const batch = db.prepare(`
    SELECT batches.*, users.name AS user_name
    FROM batches JOIN users ON users.id = batches.user_id
    WHERE batches.id = ?
  `).get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  const samples = db.prepare(`
    SELECT samples.*, users.name AS user_name
    FROM samples JOIN users ON users.id = samples.user_id
    WHERE samples.batch_id = ?
    ORDER BY samples.created_at DESC
  `).all(req.params.id);

  res.json({
    subject: { type: 'batch', id: batch.id, name: batch.name, notes: batch.notes, ownerName: batch.user_name },
    stats: buildReportStats(samples),
    samples,
  });
});

// --- page routes -------------------------------------------------------

app.get('/', (req, res) => {
  const user = getSessionUser(req);
  if (user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/batches', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'batches.html'));
});

app.get('/trends', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'trends.html'));
});

app.get('/report', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

app.listen(PORT, () => {
  console.log(`Jute sliver analyzer running at http://localhost:${PORT}`);
});
