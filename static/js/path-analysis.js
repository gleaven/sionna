/**
 * Panel 3: Path Analysis
 * Shows real ray tracing results from Sionna RT PathSolver.
 * Populated after user clicks RAY TRACE — no fake data.
 */

let lastPathData = null;

function updatePathAnalysis(data) {
    lastPathData = data;
    const container = document.getElementById('path-container');
    const badge = document.getElementById('path-count');

    if (!data || !data.paths || data.paths.length === 0) {
        container.innerHTML = '<div class="panel-placeholder">No paths computed yet. Click <strong>RAY TRACE</strong> to analyze propagation.</div>';
        badge.textContent = '—';
        return;
    }

    badge.textContent = `${data.num_paths} PATHS`;
    const a = data.analysis || {};

    // Build summary stats
    let html = '<div class="path-summary">';

    html += _stat('DISTANCE', `${data.distance_m} m`);
    html += _stat('COMPUTE', data.compute_time);
    html += _stat('LoS', a.los_exists ? 'YES' : 'NO', a.los_exists ? 'good' : 'dim');

    if (a.rms_delay_spread_ns !== undefined)
        html += _stat('RMS DELAY', `${a.rms_delay_spread_ns} ns`);
    if (a.coherence_bandwidth_mhz !== undefined)
        html += _stat('COH. BW', `${a.coherence_bandwidth_mhz} MHz`);
    if (a.total_path_gain_db !== undefined)
        html += _stat('TOTAL GAIN', `${a.total_path_gain_db} dB`);
    if (a.fspl_3_5ghz_db !== undefined)
        html += _stat('FSPL 3.5G', `${-a.fspl_3_5ghz_db} dB`);

    html += '</div>';

    // Interaction type breakdown
    if (a.path_type_counts) {
        html += '<div class="path-type-bar">';
        const total = Object.values(a.path_type_counts).reduce((s, v) => s + v, 0);
        const colors = { LoS: '#76b900', reflected: '#00e5ff', diffracted: '#ff00aa', scattered: '#ffa500', refracted: '#ffff00' };
        for (const [type, count] of Object.entries(a.path_type_counts)) {
            const pct = (count / total * 100).toFixed(0);
            const color = colors[type] || '#888';
            html += `<div class="type-segment" style="width:${pct}%;background:${color}" title="${type}: ${count}"></div>`;
        }
        html += '</div>';
        html += '<div class="path-type-legend">';
        for (const [type, count] of Object.entries(a.path_type_counts)) {
            const color = colors[type] || '#888';
            html += `<span class="type-label"><span class="type-dot" style="background:${color}"></span>${type} (${count})</span>`;
        }
        html += '</div>';
    }

    // Power delay profile chart
    html += '<div class="pdp-section">';
    html += '<div class="pdp-title">POWER DELAY PROFILE</div>';
    html += '<canvas id="pdp-canvas" class="pdp-canvas"></canvas>';
    html += '</div>';

    // Path table
    html += '<div class="path-table-wrap">';
    html += '<table class="path-table"><thead><tr>';
    html += '<th>#</th><th>TYPE</th><th>INTERACTIONS</th><th>DELAY (ns)</th><th>GAIN (dB)</th>';
    html += '</tr></thead><tbody>';

    data.paths.forEach((p, i) => {
        const typeClass = p.type === 'LoS' ? 'los' : p.type;
        html += `<tr class="path-row ${typeClass}">`;
        html += `<td>${i + 1}</td>`;
        html += `<td>${p.type}</td>`;
        html += `<td>${p.num_interactions}</td>`;
        html += `<td>${p.delay_ns !== undefined ? p.delay_ns : '—'}</td>`;
        html += `<td>${p.path_gain_db !== undefined ? p.path_gain_db : '—'}</td>`;
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    container.innerHTML = html;

    // Draw PDP after DOM update
    requestAnimationFrame(() => drawPDP(data.paths));
}

function drawPDP(paths) {
    const canvas = document.getElementById('pdp-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.clientWidth * 2;
    const h = canvas.height = canvas.clientHeight * 2;
    ctx.clearRect(0, 0, w, h);

    // Filter paths that have both delay and gain
    const valid = paths.filter(p => p.delay_ns !== undefined && p.path_gain_db !== undefined);
    if (valid.length === 0) {
        ctx.fillStyle = '#555';
        ctx.font = '20px Share Tech Mono';
        ctx.textAlign = 'center';
        ctx.fillText('No delay/gain data available', w / 2, h / 2);
        return;
    }

    const delays = valid.map(p => p.delay_ns);
    const gains = valid.map(p => p.path_gain_db);
    const minDelay = Math.min(...delays);
    const maxDelay = Math.max(...delays);
    const minGain = Math.min(...gains);
    const maxGain = Math.max(...gains);
    const delayRange = maxDelay - minDelay || 1;
    const gainRange = maxGain - minGain || 1;

    const pad = { left: 80, right: 20, top: 20, bottom: 40 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Axes
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, h - pad.bottom);
    ctx.lineTo(w - pad.right, h - pad.bottom);
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#888';
    ctx.font = '18px Share Tech Mono';
    ctx.textAlign = 'center';
    ctx.fillText('Delay (ns)', w / 2, h - 4);
    ctx.save();
    ctx.translate(16, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Gain (dB)', 0, 0);
    ctx.restore();

    // Tick marks
    ctx.font = '14px Share Tech Mono';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
        const val = minGain + (gainRange * i / 4);
        const y = h - pad.bottom - (i / 4) * plotH;
        ctx.fillText(val.toFixed(0), pad.left - 6, y + 4);
        ctx.strokeStyle = '#1a1a2e';
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(w - pad.right, y);
        ctx.stroke();
    }
    ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
        const val = minDelay + (delayRange * i / 4);
        const x = pad.left + (i / 4) * plotW;
        ctx.fillText(val.toFixed(1), x, h - pad.bottom + 18);
    }

    // Draw impulses (stems)
    const colors = { LoS: '#76b900', reflected: '#00e5ff', diffracted: '#ff00aa', scattered: '#ffa500', refracted: '#ffff00' };
    const barW = Math.max(4, Math.min(16, plotW / valid.length / 2));

    valid.forEach((p, i) => {
        const x = pad.left + ((p.delay_ns - minDelay) / delayRange) * plotW;
        const y = pad.top + (1 - (p.path_gain_db - minGain) / gainRange) * plotH;
        const baseY = h - pad.bottom;

        const color = colors[p.type] || '#888';
        ctx.strokeStyle = color;
        ctx.lineWidth = barW;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.moveTo(x, baseY);
        ctx.lineTo(x, y);
        ctx.stroke();

        // Dot at top
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, barW / 2 + 2, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.globalAlpha = 1;
}

function _stat(label, value, cls) {
    const c = cls ? ` ${cls}` : '';
    return `<div class="path-stat"><span class="path-stat-label">${label}</span><span class="path-stat-value${c}">${value}</span></div>`;
}
