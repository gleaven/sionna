/**
 * Panel 4: Link Budget Calculator
 * Computes real link budget from Sionna RT propagation data + user parameters.
 * No fake data — all values derived from actual ray tracing results.
 */

const PRESETS = {
    '3.5':  { label: 'FR1 (3.5 GHz)',    bw_mhz: 100,  nf_db: 5 },
    '28':   { label: 'FR2 (28 GHz)',      bw_mhz: 400,  nf_db: 7 },
    '60':   { label: 'V-Band (60 GHz)',   bw_mhz: 2160, nf_db: 8 },
    '140':  { label: 'Sub-THz (140 GHz)', bw_mhz: 10000, nf_db: 10 },
    '300':  { label: 'THz (300 GHz)',     bw_mhz: 20000, nf_db: 12 },
};

let linkParams = {
    fc_ghz: 3.5,
    tx_power_dbm: 23,
    tx_gain_dbi: 0,
    rx_gain_dbi: 0,
    bw_mhz: 100,
    nf_db: 5,
};

function initLinkBudget() {
    const container = document.getElementById('link-container');
    renderLinkBudget(container, null);
}

function renderLinkBudget(container, pathData) {
    let html = '';

    // Parameter controls
    html += '<div class="lb-params">';
    html += '<div class="lb-param">';
    html += '<label>FREQUENCY</label>';
    html += '<select id="lb-freq" onchange="onFreqChange(this.value)">';
    for (const [ghz, p] of Object.entries(PRESETS)) {
        const sel = parseFloat(ghz) === linkParams.fc_ghz ? ' selected' : '';
        html += `<option value="${ghz}"${sel}>${p.label}</option>`;
    }
    html += '</select></div>';

    html += `<div class="lb-param"><label>TX POWER</label><div class="lb-input-row"><input type="number" id="lb-txpow" value="${linkParams.tx_power_dbm}" step="1" onchange="onLinkParamChange()"><span class="lb-unit">dBm</span></div></div>`;
    html += `<div class="lb-param"><label>TX GAIN</label><div class="lb-input-row"><input type="number" id="lb-txgain" value="${linkParams.tx_gain_dbi}" step="1" onchange="onLinkParamChange()"><span class="lb-unit">dBi</span></div></div>`;
    html += `<div class="lb-param"><label>RX GAIN</label><div class="lb-input-row"><input type="number" id="lb-rxgain" value="${linkParams.rx_gain_dbi}" step="1" onchange="onLinkParamChange()"><span class="lb-unit">dBi</span></div></div>`;
    html += `<div class="lb-param"><label>BANDWIDTH</label><div class="lb-input-row"><input type="number" id="lb-bw" value="${linkParams.bw_mhz}" step="10" onchange="onLinkParamChange()"><span class="lb-unit">MHz</span></div></div>`;
    html += `<div class="lb-param"><label>NOISE FIG.</label><div class="lb-input-row"><input type="number" id="lb-nf" value="${linkParams.nf_db}" step="0.5" onchange="onLinkParamChange()"><span class="lb-unit">dB</span></div></div>`;
    html += '</div>';

    // Results section
    if (!pathData || !pathData.analysis) {
        html += '<div class="lb-placeholder">Run <strong>RAY TRACE</strong> to compute link budget from real propagation data.</div>';
    } else {
        html += buildLinkResults(pathData);
    }

    container.innerHTML = html;
}

function buildLinkResults(data) {
    const a = data.analysis;
    const d = data.distance_m;
    const fc = linkParams.fc_ghz * 1e9;
    const bw = linkParams.bw_mhz * 1e6;

    // FSPL at configured frequency
    const fspl_db = 20 * Math.log10(d) + 20 * Math.log10(fc) + 20 * Math.log10(4 * Math.PI / 3e8);

    // Thermal noise floor: kTB
    const k_boltzmann = 1.380649e-23;
    const T = 290; // Kelvin
    const noise_floor_dbm = 10 * Math.log10(k_boltzmann * T * bw * 1000);
    const noise_plus_nf = noise_floor_dbm + linkParams.nf_db;

    // Total path loss from Sionna (if available) or FSPL as fallback
    const sionna_path_gain = a.total_path_gain_db;
    const path_loss_db = sionna_path_gain !== undefined ? -sionna_path_gain : fspl_db;

    // EIRP
    const eirp_dbm = linkParams.tx_power_dbm + linkParams.tx_gain_dbi;

    // Received power
    const rx_power_dbm = eirp_dbm - path_loss_db + linkParams.rx_gain_dbi;

    // SNR
    const snr_db = rx_power_dbm - noise_plus_nf;

    // Shannon capacity: C = BW * log2(1 + SNR)
    const snr_linear = Math.pow(10, snr_db / 10);
    const capacity_bps = bw * Math.log2(1 + Math.max(0, snr_linear));
    const capacity_str = capacity_bps > 1e9 ? `${(capacity_bps / 1e9).toFixed(2)} Gbps`
        : capacity_bps > 1e6 ? `${(capacity_bps / 1e6).toFixed(1)} Mbps`
        : `${(capacity_bps / 1e3).toFixed(0)} kbps`;

    // Spectral efficiency
    const se = capacity_bps / bw;

    // Build results table
    let html = '<div class="lb-results">';
    html += '<div class="lb-section-title">LINK BUDGET</div>';
    html += '<table class="lb-table">';
    html += _row('EIRP', `${eirp_dbm.toFixed(1)} dBm`, `TX ${linkParams.tx_power_dbm} + Ant ${linkParams.tx_gain_dbi}`);
    html += _row('FSPL', `${fspl_db.toFixed(1)} dB`, `${linkParams.fc_ghz} GHz, ${d.toFixed(1)} m`);
    if (sionna_path_gain !== undefined) {
        html += _row('SIONNA PATH LOSS', `${path_loss_db.toFixed(1)} dB`, 'From ray tracing', 'highlight');
        const excess = path_loss_db - fspl_db;
        html += _row('EXCESS LOSS', `${excess.toFixed(1)} dB`, excess > 0 ? 'Multipath/obstruction' : 'Constructive multipath');
    }
    html += _row('RX GAIN', `${linkParams.rx_gain_dbi.toFixed(1)} dBi`, '');
    html += _row('RX POWER', `${rx_power_dbm.toFixed(1)} dBm`, '', rx_power_dbm > -100 ? 'good' : rx_power_dbm > -120 ? 'warn' : 'bad');
    html += _row('NOISE FLOOR', `${noise_plus_nf.toFixed(1)} dBm`, `BW=${linkParams.bw_mhz} MHz, NF=${linkParams.nf_db} dB`);
    html += _row('SNR', `${snr_db.toFixed(1)} dB`, '', snr_db > 10 ? 'good' : snr_db > 0 ? 'warn' : 'bad');
    html += '</table>';

    html += '<div class="lb-section-title">CAPACITY</div>';
    html += '<table class="lb-table">';
    html += _row('SHANNON CAPACITY', capacity_str, '', 'highlight');
    html += _row('SPECTRAL EFF.', `${se.toFixed(2)} bps/Hz`, '');
    if (a.rms_delay_spread_ns !== undefined)
        html += _row('RMS DELAY SPREAD', `${a.rms_delay_spread_ns} ns`, '');
    if (a.coherence_bandwidth_mhz !== undefined)
        html += _row('COHERENCE BW', `${a.coherence_bandwidth_mhz} MHz`,
            a.coherence_bandwidth_mhz < linkParams.bw_mhz ? 'Frequency-selective' : 'Flat fading');
    html += '</table>';

    // ISI warning
    if (a.coherence_bandwidth_mhz !== undefined && a.coherence_bandwidth_mhz < linkParams.bw_mhz) {
        html += '<div class="lb-warning">Coherence BW &lt; signal BW — frequency-selective fading. OFDM recommended.</div>';
    }

    html += '</div>';
    return html;
}

function _row(label, value, note, cls) {
    const c = cls ? ` class="${cls}"` : '';
    return `<tr><td class="lb-label">${label}</td><td${c}>${value}</td><td class="lb-note">${note}</td></tr>`;
}

function onFreqChange(ghz) {
    linkParams.fc_ghz = parseFloat(ghz);
    const preset = PRESETS[ghz];
    if (preset) {
        linkParams.bw_mhz = preset.bw_mhz;
        linkParams.nf_db = preset.nf_db;
    }
    updateLinkFromLastData();
}

function onLinkParamChange() {
    linkParams.tx_power_dbm = parseFloat(document.getElementById('lb-txpow').value) || 23;
    linkParams.tx_gain_dbi = parseFloat(document.getElementById('lb-txgain').value) || 0;
    linkParams.rx_gain_dbi = parseFloat(document.getElementById('lb-rxgain').value) || 0;
    linkParams.bw_mhz = parseFloat(document.getElementById('lb-bw').value) || 100;
    linkParams.nf_db = parseFloat(document.getElementById('lb-nf').value) || 5;
    updateLinkFromLastData();
}

function updateLinkFromLastData() {
    const container = document.getElementById('link-container');
    renderLinkBudget(container, lastPathData);
}

function updateLinkBudget(pathData) {
    const container = document.getElementById('link-container');
    renderLinkBudget(container, pathData);
}
