/**
 * Coverage Map + Ray Trace actions
 * Drives Sionna RT computation and feeds results to analysis panels.
 */

let coverageLoading = false;

function getMaxDepth() {
    const el = document.getElementById('max-depth');
    return el ? parseInt(el.value, 10) : 3;
}

async function computeCoverage() {
    if (coverageLoading) return;
    coverageLoading = true;

    const placeholder = document.getElementById('coverage-placeholder');
    const img = document.getElementById('coverage-img');
    const badge = document.getElementById('coverage-time');

    if (placeholder) placeholder.textContent = 'Computing radio map...';
    badge.textContent = 'COMPUTING';

    try {
        const depth = getMaxDepth();
        const res = await fetch(`api/coverage?max_depth=${depth}`, { method: 'POST' });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Coverage computation failed');
        }

        const computeTime = res.headers.get('X-Compute-Time') || '?';
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        img.onload = () => {
            if (placeholder) placeholder.style.display = 'none';
            img.style.display = 'block';
            badge.textContent = computeTime;
        };
        img.src = url;
    } catch (e) {
        console.error('Coverage error:', e);
        if (placeholder) placeholder.textContent = `Error: ${e.message}`;
        badge.textContent = 'ERROR';
    } finally {
        coverageLoading = false;
    }
}

async function computePaths() {
    const badge = document.getElementById('obj-count');
    const linkBadge = document.getElementById('link-badge');

    try {
        badge.textContent = 'TRACING...';
        if (linkBadge) linkBadge.textContent = 'COMPUTING';

        const depth = getMaxDepth();
        const res = await fetch(`api/paths?max_depth=${depth}`, { method: 'POST' });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Path computation failed');
        }

        const data = await res.json();
        badge.textContent = `${data.num_paths} PATHS`;
        if (linkBadge) linkBadge.textContent = data.compute_time;

        // Render paths in 3D view
        if (typeof renderRayPaths === 'function') {
            renderRayPaths(data.paths);
        }

        // Feed real data to analysis panels
        if (typeof updatePathAnalysis === 'function') {
            updatePathAnalysis(data);
        }
        if (typeof updateLinkBudget === 'function') {
            updateLinkBudget(data);
        }
    } catch (e) {
        console.error('Path error:', e);
        badge.textContent = 'ERROR';
        if (linkBadge) linkBadge.textContent = 'ERROR';
    }
}
