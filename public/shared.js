async function initTopbar(activePage) {
  const res = await fetch('/api/session');
  if (!res.ok) {
    window.location.href = '/';
    return null;
  }
  const data = await res.json();
  const user = data.user;

  const topbar = document.getElementById('topbar');
  topbar.innerHTML = `
    <div class="brand">Jute sliver analyzer</div>
    <nav>
      <a href="/dashboard" class="${activePage === 'dashboard' ? 'active' : ''}">Dashboard</a>
      <a href="/batches" class="${activePage === 'batches' ? 'active' : ''}">Batches</a>
      <a href="/trends" class="${activePage === 'trends' ? 'active' : ''}">Trends</a>
    </nav>
    <div class="user-info">
      <span>${escapeHtml(user.name)}</span>
      <button class="secondary" id="logoutBtn" style="padding:4px 10px; font-size:12px;">Sign out</button>
    </div>
  `;

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/';
  });

  return user;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function scoreBadgeClass(score) {
  if (score >= 75) return { cls: 'badge-good', label: 'Good' };
  if (score >= 50) return { cls: 'badge-moderate', label: 'Moderate' };
  return { cls: 'badge-poor', label: 'Poor' };
}

function scoreColor(score) {
  if (score >= 75) return '#1D9E75';
  if (score >= 50) return '#BA7517';
  return '#E24B4A';
}

function timeAgo(isoString) {
  const date = new Date(isoString.replace(' ', 'T') + 'Z');
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.round(hrs / 24);
  if (days < 30) return days + 'd ago';
  return date.toLocaleDateString();
}

function drawHistogramCanvas(canvas, hist, meanAngle) {
  const w = 280, h = 140;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);
  const barW = w / hist.length;
  ctx.fillStyle = '#5DCAA5';
  hist.forEach((v, i) => {
    const barH = v * (h - 16);
    ctx.fillRect(i * barW, h - barH - 8, barW - 1, barH);
  });
  const meanX = (meanAngle / 180) * w;
  ctx.strokeStyle = '#D85A30';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(meanX, 0);
  ctx.lineTo(meanX, h);
  ctx.stroke();
}

// Draws a simple 3-bar score-distribution chart (Good/Moderate/Poor counts).
function drawScoreDistributionCanvas(canvas, distribution) {
  const w = 280, h = 140;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#faf9f6';
  ctx.fillRect(0, 0, w, h);

  const bars = [
    { label: 'Poor', value: distribution.poor, color: '#E24B4A' },
    { label: 'Moderate', value: distribution.moderate, color: '#BA7517' },
    { label: 'Good', value: distribution.good, color: '#1D9E75' },
  ];
  const max = Math.max(distribution.poor, distribution.moderate, distribution.good, 1);
  const padBottom = 22, padTop = 10;
  const usableH = h - padBottom - padTop;
  const barW = w / bars.length;

  ctx.font = '11px -apple-system, sans-serif';
  bars.forEach((b, i) => {
    const barH = (b.value / max) * usableH;
    const x = i * barW + barW * 0.2;
    const bw = barW * 0.6;
    ctx.fillStyle = b.color;
    ctx.fillRect(x, h - padBottom - barH, bw, barH);
    ctx.fillStyle = '#1d1d1b';
    ctx.textAlign = 'center';
    ctx.fillText(String(b.value), i * barW + barW / 2, h - padBottom - barH - 4);
    ctx.fillStyle = '#6b6a64';
    ctx.fillText(b.label, i * barW + barW / 2, h - 6);
  });
}
