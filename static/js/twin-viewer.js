/**
 * Panel 1: 3D Digital Twin Viewer (Three.js)
 *
 * Features:
 * - Real triangle mesh from Sionna RT scene (GLB)
 * - Click to place TX (left-click) or RX (shift-click) towers
 * - Ray paths colored by interaction type
 * - Coverage heatmap overlay on ground plane
 * - Auto-computes coverage + paths after tower placement
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let twinScene, twinCamera, twinRenderer, twinControls;
let rayPathGroup, deviceGroup, buildingGroup, coverageGroup;
let sceneBBox = null;       // bounding box of loaded mesh
let placementMode = null;   // null | 'tx' | 'rx'
let previewMarker = null;   // ghost marker following cursor
let previewMast = null;     // line from surface to device preview
let previewHeightLabel = null; // sprite showing height in meters
let placementSurfaceY = 0;    // Y of hit surface (rooftop or ground)
let placementHeight = 3;      // meters above surface (adjustable)
let placementLockPos = null;   // XZ position locked during shift
let shiftHeld = false;
let lastMouseY = 0;
let selectedDevice = null;     // { name, type, position }
let selectionRing = null;      // ring mesh around selected device
let moveMode = false;          // device drag-to-move mode
let movingDeviceName = null;   // name of device being moved
let mouseDownPos = null;       // for click vs drag detection
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// Realistic building material colors — keyed by suffix from mesh name
// Server names meshes like 'element_0__mat_concrete', 'element_1__mat_glass', etc.
const BUILDING_MATERIALS = {
    concrete: { color: 0xb0ada8, specular: 0x222222, shininess: 8 },
    brick:    { color: 0xc4907a, specular: 0x221111, shininess: 5 },
    marble:   { color: 0xd5d0cb, specular: 0x444444, shininess: 30 },
    metal:    { color: 0xb8bcc4, specular: 0x666666, shininess: 50 },
    wood:     { color: 0xbfa87a, specular: 0x111100, shininess: 10 },
    glass:    { color: 0xc8dde8, specular: 0x555555, shininess: 60, opacity: 0.7, transparent: true },
    default:  { color: 0xa5a5a0, specular: 0x222222, shininess: 10 },
};

// ── Coordinate transform: Sionna (X,Y,Z-up) → Three.js (X,Y-up,Z) ──
function sionnaToThree(x, y, z) {
    return new THREE.Vector3(x, z, -y);
}

function threeToSionna(v) {
    return [v.x, -v.z, v.y];
}

// ── Init ──────────────────────────────────────────────────────────────

function initTwinViewer() {
    const container = document.getElementById('three-container');
    const w = container.clientWidth;
    const h = container.clientHeight;

    twinScene = new THREE.Scene();
    twinScene.background = new THREE.Color(0x101018);

    twinCamera = new THREE.PerspectiveCamera(50, w / h, 0.5, 3000);
    twinCamera.position.set(200, 180, 200);

    twinRenderer = new THREE.WebGLRenderer({ antialias: true });
    twinRenderer.setSize(w, h);
    twinRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    twinRenderer.toneMapping = THREE.NoToneMapping;
    container.appendChild(twinRenderer.domElement);

    // Controls
    twinControls = new OrbitControls(twinCamera, twinRenderer.domElement);
    twinControls.enableDamping = true;
    twinControls.dampingFactor = 0.08;
    twinControls.maxPolarAngle = Math.PI * 0.48;
    twinControls.minDistance = 20;
    twinControls.maxDistance = 1200;
    twinControls.target.set(50, 0, -100);

    // ── Lighting — bright enough to see building detail on dark bg ──
    twinScene.add(new THREE.AmbientLight(0xffffff, 2.0));
    twinScene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 1.5));

    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(150, 300, 100);
    twinScene.add(sun);

    const fill = new THREE.DirectionalLight(0x8899cc, 1.0);
    fill.position.set(-80, 120, -60);
    twinScene.add(fill);

    const back = new THREE.DirectionalLight(0x667788, 0.8);
    back.position.set(-100, 80, 100);
    twinScene.add(back);

    // Ground grid
    const gridHelper = new THREE.GridHelper(800, 80, 0x76b900, 0x181828);
    gridHelper.material.opacity = 0.1;
    gridHelper.material.transparent = true;
    twinScene.add(gridHelper);

    // Layer groups
    coverageGroup = new THREE.Group();
    twinScene.add(coverageGroup);
    buildingGroup = new THREE.Group();
    twinScene.add(buildingGroup);
    rayPathGroup = new THREE.Group();
    twinScene.add(rayPathGroup);
    deviceGroup = new THREE.Group();
    twinScene.add(deviceGroup);

    // ── Click handling for tower placement + selection ──
    container.addEventListener('click', onSceneClick, false);
    container.addEventListener('mousemove', onSceneMouseMove, false);
    container.addEventListener('mousedown', (e) => { mouseDownPos = { x: e.clientX, y: e.clientY }; });

    // Keyboard handlers
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Shift' && (placementMode || moveMode) && !shiftHeld) {
            shiftHeld = true;
            if (previewMarker?.visible) {
                placementLockPos = previewMarker.position.clone();
                lastMouseY = 0;
            }
            const c = document.getElementById('three-container');
            if (c) c.style.cursor = 'ns-resize';
        }
        if (e.key === 'Escape') {
            if (moveMode) exitMoveMode();
            else if (placementMode) setPlacementMode(null);
            else deselectDevice();
        }
        if (e.key === 'Delete' && selectedDevice && !moveMode && !placementMode) {
            deleteSelectedDevice();
        }
        if (e.key === 'm' && selectedDevice && !moveMode && !placementMode) {
            enterMoveMode();
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Shift') {
            shiftHeld = false;
            placementLockPos = null;
            const c = document.getElementById('three-container');
            if (c && (placementMode || moveMode)) c.style.cursor = 'crosshair';
        }
    });

    // Resize
    const ro = new ResizeObserver(() => {
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        twinCamera.aspect = cw / ch;
        twinCamera.updateProjectionMatrix();
        twinRenderer.setSize(cw, ch);
    });
    ro.observe(container);

    // Animate
    (function animate() {
        requestAnimationFrame(animate);
        twinControls.update();
        // Pulse glow on devices
        const t = performance.now() * 0.001;
        deviceGroup.children.forEach(c => {
            if (c.userData.isGlow) {
                c.material.opacity = 0.08 + 0.06 * Math.sin(t * 2 + c.userData.phase);
            }
        });
        // Pulse + rotate selection ring
        if (selectionRing) {
            selectionRing.material.opacity = 0.5 + 0.4 * Math.sin(t * 3);
            selectionRing.rotation.z += 0.005;
        }
        twinRenderer.render(twinScene, twinCamera);
    })();
}

// ── Tower Placement ───────────────────────────────────────────────────

function setPlacementMode(mode) {
    placementMode = mode;
    placementHeight = mode === 'tx' ? 3 : 1.5; // default heights
    shiftHeld = false;
    placementLockPos = null;
    const container = document.getElementById('three-container');

    if (mode) {
        container.style.cursor = 'crosshair';
        const color = mode === 'tx' ? 0xff3333 : 0x00e5ff;

        // Antenna housing preview
        if (!previewMarker) {
            const geo = new THREE.CylinderGeometry(0.8, 1.2, 3, 8);
            const mat = new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.5,
            });
            previewMarker = new THREE.Mesh(geo, mat);
            previewMarker.visible = false;
            twinScene.add(previewMarker);
        } else {
            previewMarker.material.color.set(color);
        }

        // Mast preview (line from surface to device)
        if (!previewMast) {
            const mastGeo = new THREE.BufferGeometry();
            mastGeo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,1,0], 3));
            previewMast = new THREE.Line(mastGeo, new THREE.LineBasicMaterial({
                color, transparent: true, opacity: 0.6,
            }));
            previewMast.visible = false;
            twinScene.add(previewMast);
        } else {
            previewMast.material.color.set(color);
        }

        // Height label preview
        if (!previewHeightLabel) {
            previewHeightLabel = makeTextSprite('0m', color);
            previewHeightLabel.visible = false;
            twinScene.add(previewHeightLabel);
        }
    } else {
        container.style.cursor = '';
        if (previewMarker) previewMarker.visible = false;
        if (previewMast) previewMast.visible = false;
        if (previewHeightLabel) previewHeightLabel.visible = false;
    }
}

function getSceneIntersection(event) {
    const container = document.getElementById('three-container');
    const rect = container.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, twinCamera);

    // Intersect buildings and ground
    const targets = [];
    buildingGroup.traverse(c => { if (c.isMesh) targets.push(c); });

    // Invisible ground plane for picking
    const groundPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(2000, 2000),
        new THREE.MeshBasicMaterial({ visible: false })
    );
    groundPlane.rotation.x = -Math.PI / 2;
    groundPlane.position.y = 0;
    groundPlane.userData.isGround = true;
    groundPlane.updateMatrixWorld(true);
    targets.push(groundPlane);

    const hits = raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return null;

    const hit = hits[0];
    // Walk up to check if we hit the tagged ground plane
    let obj = hit.object;
    const isBuilding = !obj.userData.isGround;
    const surfaceY = isBuilding ? hit.point.y : 0;

    return { point: hit.point, surfaceY, isBuilding };
}

// Find the surface Y below a given position (for mast rendering)
function getSurfaceBelow(pos) {
    const downRay = new THREE.Raycaster(
        new THREE.Vector3(pos.x, pos.y + 0.5, pos.z),
        new THREE.Vector3(0, -1, 0)
    );
    const targets = [];
    buildingGroup.traverse(c => { if (c.isMesh) targets.push(c); });
    const hits = downRay.intersectObjects(targets, true);
    return (hits.length > 0 && hits[0].point.y > 0.1) ? hits[0].point.y : 0;
}

function updatePreviewVisuals(x, z, surfaceY, heightAboveSurface) {
    const deviceY = surfaceY + heightAboveSurface;

    // Antenna marker
    previewMarker.position.set(x, deviceY, z);
    previewMarker.visible = true;

    // Mast line from surface to device
    if (previewMast) {
        const positions = previewMast.geometry.attributes.position;
        positions.array[0] = x; positions.array[1] = surfaceY; positions.array[2] = z;
        positions.array[3] = x; positions.array[4] = deviceY;  positions.array[5] = z;
        positions.needsUpdate = true;
        previewMast.visible = heightAboveSurface > 0.5;
    }

    // Height label
    if (previewHeightLabel) {
        // Dispose old texture and create new one
        if (previewHeightLabel.material.map) previewHeightLabel.material.map.dispose();
        previewHeightLabel.material.dispose();
        const color = placementMode === 'tx' ? 0xff3333 : 0x00e5ff;
        const label = `${heightAboveSurface.toFixed(1)}m`;
        const canvas = document.createElement('canvas');
        canvas.width = 128; canvas.height = 48;
        const ctx = canvas.getContext('2d');
        ctx.font = 'bold 24px monospace';
        ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
        ctx.textAlign = 'center';
        ctx.fillText(label, 64, 32);
        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        previewHeightLabel.material = new THREE.SpriteMaterial({
            map: texture, transparent: true, opacity: 0.9,
        });
        previewHeightLabel.position.set(x + 5, deviceY, z);
        previewHeightLabel.scale.set(12, 4, 1);
        previewHeightLabel.visible = true;
    }
}

function onSceneMouseMove(event) {
    if ((!placementMode && !moveMode) || !previewMarker) return;

    if (shiftHeld) {
        // Height adjustment mode — lock XZ, adjust height with mouse Y
        if (!placementLockPos) {
            placementLockPos = previewMarker.position.clone();
            lastMouseY = event.clientY;
            return;
        }
        if (lastMouseY === 0) {
            lastMouseY = event.clientY;
            return;
        }
        const deltaY = lastMouseY - event.clientY; // up = positive
        lastMouseY = event.clientY;
        placementHeight = Math.max(0.5, Math.min(100, placementHeight + deltaY * 0.3));
        updatePreviewVisuals(
            placementLockPos.x, placementLockPos.z,
            placementSurfaceY, placementHeight
        );
        return;
    }

    // Normal mode — track mouse position on scene surfaces
    const hit = getSceneIntersection(event);
    if (!hit) return;

    placementSurfaceY = hit.surfaceY;
    updatePreviewVisuals(hit.point.x, hit.point.z, hit.surfaceY, placementHeight);
}

async function onSceneClick(event) {
    // Ignore drag (orbit) gestures — only handle real clicks
    if (mouseDownPos) {
        const dx = event.clientX - mouseDownPos.x;
        const dy = event.clientY - mouseDownPos.y;
        if (dx * dx + dy * dy > 25) return;
    }

    // Move mode — confirm device reposition
    if (moveMode) {
        if (!previewMarker?.visible) return;
        const pos = previewMarker.position.clone();
        const [sx, sy, sz] = threeToSionna(pos);
        try {
            const res = await fetch(`api/devices/${movingDeviceName}/position`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x: sx, y: sy, z: sz }),
            });
            const data = await res.json();
            if (data.status === 'ok') {
                exitMoveMode();
                await refreshDevices();
                computeAll();
            }
        } catch (e) {
            console.error('Move failed:', e);
        }
        return;
    }

    // Placement mode — add new device
    if (placementMode) {
        if (!previewMarker?.visible) return;
        const placePoint = previewMarker.position.clone();
        const [sx, sy, sz] = threeToSionna(placePoint);
        try {
            const res = await fetch('api/devices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: placementMode, x: sx, y: sy, z: sz }),
            });
            const data = await res.json();
            if (data.status === 'ok') {
                setPlacementMode(null);
                await refreshDevices();
                computeAll();
            }
        } catch (e) {
            console.error('Failed to place device:', e);
        }
        return;
    }

    // Selection mode — click on device to select
    handleDeviceClick(event);
}

// ── Scene Loading ─────────────────────────────────────────────────────

async function loadSceneGeometry() {
    try {
        const [meshRes, geoRes] = await Promise.all([
            fetch('api/scene/mesh'),
            fetch('api/scene/geometry'),
        ]);

        if (meshRes.ok) {
            const blob = await meshRes.blob();
            const url = URL.createObjectURL(blob);
            const loader = new GLTFLoader();

            loader.load(url, (gltf) => {
                buildingGroup.clear();
                coverageGroup.clear();
                rayPathGroup.clear();

                const model = gltf.scene;
                model.rotation.x = -Math.PI / 2;

                model.traverse((child) => {
                    if (child.isMesh) {
                        // Dark translucent buildings — coverage glow visible at ground level
                        child.material = new THREE.MeshBasicMaterial({
                            color: 0x1a1a2e,
                            transparent: true,
                            opacity: 0.85,
                            depthWrite: true,
                        });

                        // Neon edge wireframe — cyberpunk building outlines
                        const edges = new THREE.EdgesGeometry(child.geometry, 20);
                        const edgeLine = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
                            color: 0x76b900, transparent: true, opacity: 0.25,
                        }));
                        child.add(edgeLine);
                    }
                });

                buildingGroup.add(model);
                URL.revokeObjectURL(url);

                // Store bounding box and center camera
                sceneBBox = new THREE.Box3().setFromObject(model);
                const center = sceneBBox.getCenter(new THREE.Vector3());
                const size = sceneBBox.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);

                twinControls.target.copy(center);
                twinCamera.position.set(
                    center.x + maxDim * 0.45,
                    maxDim * 0.4,
                    center.z + maxDim * 0.45
                );

                let faceCount = 0;
                model.traverse((c) => {
                    if (c.isMesh) faceCount += c.geometry.index ? c.geometry.index.count / 3 : 0;
                });
                document.getElementById('obj-count').textContent =
                    `${(faceCount / 1000).toFixed(0)}K TRIS`;
            });
        }

        if (geoRes.ok) {
            const data = await geoRes.json();
            renderDevices(data.devices);
        }
    } catch (e) {
        console.error('Failed to load scene geometry:', e);
    }
}

async function refreshDevices() {
    try {
        const res = await fetch('api/devices');
        const data = await res.json();
        renderDevices(data.devices);
    } catch (e) {
        console.error('Failed to refresh devices:', e);
    }
}

function renderDevices(devices) {
    deviceGroup.clear();

    devices.forEach((dev, idx) => {
        const isTx = dev.type === 'tx';
        const color = isTx ? 0xff3333 : 0x00e5ff;
        const pos = sionnaToThree(dev.position[0], dev.position[1], dev.position[2]);

        // Find surface below device for mast
        const surfaceY = getSurfaceBelow(pos);
        const mastHeight = pos.y - surfaceY;

        // Mast / tower pole (thin cylinder from surface to device)
        if (mastHeight > 0.5) {
            const mastGeo = new THREE.CylinderGeometry(0.15, 0.15, mastHeight, 6);
            const mastMat = new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.5,
            });
            const mast = new THREE.Mesh(mastGeo, mastMat);
            mast.position.set(pos.x, surfaceY + mastHeight / 2, pos.z);
            deviceGroup.add(mast);

            // Mast base plate
            const baseGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.3, 8);
            const baseMat = new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.3,
            });
            const base = new THREE.Mesh(baseGeo, baseMat);
            base.position.set(pos.x, surfaceY + 0.15, pos.z);
            deviceGroup.add(base);
        }

        // Antenna housing at device position
        const antHeight = isTx ? 3 : 1.5;
        const geo = new THREE.CylinderGeometry(0.5, 0.8, antHeight, 8);
        const mat = new THREE.MeshStandardMaterial({
            color, emissive: color, emissiveIntensity: 0.8,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(pos);
        mesh.userData.deviceName = dev.name;
        deviceGroup.add(mesh);

        // Pulsing glow
        const glowGeo = new THREE.SphereGeometry(2.5, 16, 16);
        const glowMat = new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.1,
        });
        const glow = new THREE.Mesh(glowGeo, glowMat);
        glow.position.copy(pos);
        glow.position.y += antHeight / 2;
        glow.userData.isGlow = true;
        glow.userData.phase = idx * 1.3;
        deviceGroup.add(glow);

        // Beam cone for TX
        if (isTx) {
            const coneGeo = new THREE.ConeGeometry(15, 30, 32, 1, true);
            const coneMat = new THREE.MeshBasicMaterial({
                color: 0x76b900, transparent: true, opacity: 0.035,
                side: THREE.DoubleSide,
            });
            const cone = new THREE.Mesh(coneGeo, coneMat);
            cone.position.copy(pos);
            cone.position.y += antHeight;
            cone.rotation.x = Math.PI;
            deviceGroup.add(cone);
        }

        // Label with height info
        const heightLabel = mastHeight > 0.5 ? ` (${mastHeight.toFixed(1)}m)` : '';
        const label = `${dev.type.toUpperCase()}: ${dev.name}${heightLabel}`;
        const sprite = makeTextSprite(label, color);
        sprite.position.copy(pos);
        sprite.position.y += antHeight + 4;
        deviceGroup.add(sprite);
    });
}

function makeTextSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 22px monospace';
    ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
    ctx.textAlign = 'center';
    ctx.fillText(text, 128, 38);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.9 });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(18, 4.5, 1);
    return sprite;
}

// ── Ray Paths ─────────────────────────────────────────────────────────

function renderRayPaths(pathData) {
    rayPathGroup.clear();

    const typeColors = {
        'LoS':        0x76b900,   // NVIDIA green — direct path
        'reflected':  0x00e5ff,   // cyan — specular reflection
        'diffracted': 0xff00aa,   // magenta — edge diffraction
        'scattered':  0xffa500,   // orange — diffuse scattering
        'refracted':  0xffff00,   // yellow — refraction through material
    };

    pathData.forEach((path) => {
        const points = path.vertices.map(v => sionnaToThree(v[0], v[1], v[2]));
        if (points.length < 2) return;

        const color = typeColors[path.type] || 0xaaaaaa;

        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
            color, transparent: true, opacity: 0.9, linewidth: 2,
        });
        rayPathGroup.add(new THREE.Line(geo, mat));

        // Bounce markers
        points.slice(1, -1).forEach(p => {
            const dotGeo = new THREE.SphereGeometry(0.5, 8, 8);
            const dotMat = new THREE.MeshBasicMaterial({ color });
            const dot = new THREE.Mesh(dotGeo, dotMat);
            dot.position.copy(p);
            rayPathGroup.add(dot);
        });
    });
}

// ── Coverage Heatmap Overlay ──────────────────────────────────────────

function renderCoverageOverlay(imageB64) {
    coverageGroup.clear();
    if (!sceneBBox || !imageB64) return;

    const size = sceneBBox.getSize(new THREE.Vector3());
    const center = sceneBBox.getCenter(new THREE.Vector3());

    const img = new Image();
    img.onload = () => {
        const texture = new THREE.Texture(img);
        texture.needsUpdate = true;
        texture.minFilter = THREE.LinearFilter;

        const planeGeo = new THREE.PlaneGeometry(size.x * 1.15, size.z * 1.15);
        const planeMat = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            opacity: 0.65,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
        });
        const plane = new THREE.Mesh(planeGeo, planeMat);
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(center.x, 0.3, center.z);
        coverageGroup.add(plane);
    };
    img.src = 'data:image/png;base64,' + imageB64;
}

// ── Progress Bar ─────────────────────────────────────────────────────

function showProgress(label, pct) {
    const bar = document.getElementById('compute-progress');
    const fillEl = document.getElementById('progress-fill');
    const labelEl = document.getElementById('progress-label');
    const timeEl = document.getElementById('progress-time');

    bar.classList.add('active');
    labelEl.textContent = label;

    if (pct < 0) {
        // Indeterminate
        fillEl.classList.add('indeterminate');
        fillEl.style.width = '30%';
    } else {
        fillEl.classList.remove('indeterminate');
        fillEl.style.width = `${pct}%`;
    }
    timeEl.textContent = '';
}

function updateProgressTime(text) {
    const timeEl = document.getElementById('progress-time');
    if (timeEl) timeEl.textContent = text;
}

function hideProgress() {
    const bar = document.getElementById('compute-progress');
    const fillEl = document.getElementById('progress-fill');
    bar.classList.remove('active');
    fillEl.classList.remove('indeterminate');
    fillEl.style.width = '0%';
}

// ── Unified Compute (sequential phases with progress) ────────────────

let computing = false;

async function computeAll() {
    if (computing) return;
    computing = true;
    const maxDepth = document.getElementById('max-depth')?.value || 3;
    const statusText = document.querySelector('.status-text');

    try {
        // ── Phase 1: Coverage Map (ray-traced through building geometry) ──
        showProgress('RAY-TRACING COVERAGE MAP THROUGH BUILDINGS...', -1);
        if (statusText) statusText.textContent = 'COMPUTING COVERAGE...';

        const covRes = await fetch(`api/coverage?max_depth=${maxDepth}`, { method: 'POST' });

        if (covRes.ok) {
            const covTime = covRes.headers.get('X-Compute-Time') || '';
            const blob = await covRes.blob();
            const blobUrl = URL.createObjectURL(blob);

            // Update coverage panel (Panel 2)
            const img = document.getElementById('coverage-img');
            const placeholder = document.getElementById('coverage-placeholder');
            img.onload = () => {
                if (placeholder) placeholder.style.display = 'none';
                img.style.display = 'block';
            };
            img.src = blobUrl;
            document.getElementById('coverage-time').textContent = covTime;

            // Coverage overlay on 3D scene
            renderCoverageOverlayFromBlob(blobUrl);

            showProgress(`COVERAGE DONE (${covTime}) — RAY-TRACING PATHS...`, 40);
            updateProgressTime(covTime);
        }

        // ── Phase 2: Ray Path Computation (through building geometry) ──
        showProgress('RAY-TRACING PROPAGATION PATHS...', -1);
        if (statusText) statusText.textContent = 'COMPUTING PATHS...';

        const pathRes = await fetch(`api/paths?max_depth=${maxDepth}`, { method: 'POST' });
        const pathData = await pathRes.json();

        showProgress('ANALYZING CHANNEL DATA...', 75);

        // Update 3D ray paths
        renderRayPaths(pathData.paths || []);

        // Update path analysis (Panel 3)
        if (typeof updatePathAnalysis === 'function') {
            updatePathAnalysis(pathData);
        }

        showProgress('COMPUTING LINK BUDGET...', 90);

        // Update link budget (Panel 4)
        if (typeof updateLinkBudget === 'function') {
            updateLinkBudget(pathData);
        }

        // Update badges
        const pathBadge = document.getElementById('path-count');
        if (pathBadge) pathBadge.textContent = `${pathData.num_paths} PATHS`;
        const linkBadge = document.getElementById('link-badge');
        if (linkBadge) linkBadge.textContent = pathData.compute_time;

        // ── Done ──
        showProgress('COMPLETE', 100);
        updateProgressTime(`Coverage + ${pathData.num_paths} paths in ${pathData.compute_time}`);
        if (statusText) {
            const sceneName = pathData?.scene || '';
            statusText.textContent = `SCENE: ${sceneName.toUpperCase()}`;
        }

        setTimeout(hideProgress, 2500);

    } catch (e) {
        console.error('Compute failed:', e);
        showProgress('ERROR: ' + e.message, 0);
        if (statusText) statusText.textContent = 'COMPUTE ERROR';
        setTimeout(hideProgress, 4000);
    } finally {
        computing = false;
    }
}

// Render coverage overlay from blob URL (avoids re-encoding to base64)
function renderCoverageOverlayFromBlob(blobUrl) {
    coverageGroup.clear();
    if (!sceneBBox) return;

    const size = sceneBBox.getSize(new THREE.Vector3());
    const center = sceneBBox.getCenter(new THREE.Vector3());

    const img = new Image();
    img.onload = () => {
        const texture = new THREE.Texture(img);
        texture.needsUpdate = true;
        texture.minFilter = THREE.LinearFilter;

        const planeGeo = new THREE.PlaneGeometry(size.x * 1.15, size.z * 1.15);
        const planeMat = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            opacity: 0.65,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
        });
        const plane = new THREE.Mesh(planeGeo, planeMat);
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(center.x, 0.3, center.z);
        coverageGroup.add(plane);
    };
    img.src = blobUrl;
}

// ── Device Selection ─────────────────────────────────────────────────

function handleDeviceClick(event) {
    const container = document.getElementById('three-container');
    const rect = container.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, twinCamera);

    const deviceMeshes = [];
    deviceGroup.children.forEach(c => {
        if (c.isMesh && c.userData.deviceName) deviceMeshes.push(c);
    });

    const hits = raycaster.intersectObjects(deviceMeshes);
    if (hits.length > 0) {
        selectDeviceByName(hits[0].object.userData.deviceName);
    } else {
        deselectDevice();
    }
}

async function selectDeviceByName(name) {
    try {
        const res = await fetch('api/devices');
        const data = await res.json();
        const dev = data.devices.find(d => d.name === name);
        if (!dev) return;
        selectedDevice = dev;
        highlightDevice(name);
        showSidebar(dev);
    } catch (e) {
        console.error('Failed to select device:', e);
    }
}

function deselectDevice() {
    if (moveMode) exitMoveMode();
    selectedDevice = null;
    clearHighlight();
    hideSidebar();
}

function highlightDevice(name) {
    clearHighlight();
    deviceGroup.children.forEach(c => {
        if (c.isMesh && c.userData.deviceName === name) {
            const ringGeo = new THREE.TorusGeometry(4, 0.3, 8, 32);
            const ringMat = new THREE.MeshBasicMaterial({
                color: 0x76b900, transparent: true, opacity: 0.9,
            });
            selectionRing = new THREE.Mesh(ringGeo, ringMat);
            selectionRing.rotation.x = -Math.PI / 2;
            selectionRing.position.copy(c.position);
            selectionRing.position.y -= 1.5;
            selectionRing.userData.isSelectionRing = true;
            twinScene.add(selectionRing);

            if (c.material.emissiveIntensity !== undefined) {
                c.userData.origEmissive = c.material.emissiveIntensity;
                c.material.emissiveIntensity = 2.5;
            }
        }
    });
}

function clearHighlight() {
    if (selectionRing) {
        twinScene.remove(selectionRing);
        selectionRing.geometry.dispose();
        selectionRing.material.dispose();
        selectionRing = null;
    }
    deviceGroup.children.forEach(c => {
        if (c.isMesh && c.userData.origEmissive !== undefined) {
            c.material.emissiveIntensity = c.userData.origEmissive;
            delete c.userData.origEmissive;
        }
    });
}

// ── Sidebar ──────────────────────────────────────────────────────────

function showSidebar(dev) {
    const sidebar = document.getElementById('tower-sidebar');
    if (!sidebar) return;
    document.getElementById('sidebar-title').textContent = dev.name.toUpperCase();
    const badge = document.getElementById('sidebar-type');
    badge.textContent = dev.type.toUpperCase();
    badge.className = 'sidebar-badge ' + (dev.type === 'tx' ? 'badge-tx' : 'badge-rx');
    document.getElementById('sidebar-name').textContent = dev.name;

    // Sionna coordinates
    document.getElementById('sidebar-x').value = dev.position[0].toFixed(1);
    document.getElementById('sidebar-y').value = dev.position[1].toFixed(1);
    document.getElementById('sidebar-z').value = dev.position[2].toFixed(1);

    // Height above surface
    const pos3 = sionnaToThree(dev.position[0], dev.position[1], dev.position[2]);
    const surfY = getSurfaceBelow(pos3);
    const h = pos3.y - surfY;
    document.getElementById('sidebar-height').textContent =
        h > 0.5 ? `${h.toFixed(1)} m above surface` : 'Ground level';

    sidebar.classList.add('open');
}

function hideSidebar() {
    const sidebar = document.getElementById('tower-sidebar');
    if (sidebar) sidebar.classList.remove('open');
}

async function onSidebarPositionChange() {
    if (!selectedDevice) return;
    const x = parseFloat(document.getElementById('sidebar-x').value);
    const y = parseFloat(document.getElementById('sidebar-y').value);
    const z = parseFloat(document.getElementById('sidebar-z').value);
    if (isNaN(x) || isNaN(y) || isNaN(z)) return;

    try {
        const res = await fetch(`api/devices/${selectedDevice.name}/position`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x, y, z }),
        });
        const data = await res.json();
        if (data.status === 'ok') {
            selectedDevice.position = [x, y, z];
            await refreshDevices();
            highlightDevice(selectedDevice.name);
            // Update height display
            const pos3 = sionnaToThree(x, y, z);
            const surfY = getSurfaceBelow(pos3);
            const h = pos3.y - surfY;
            document.getElementById('sidebar-height').textContent =
                h > 0.5 ? `${h.toFixed(1)} m above surface` : 'Ground level';
        }
    } catch (e) {
        console.error('Position update failed:', e);
    }
}

async function deleteSelectedDevice() {
    if (!selectedDevice) return;
    try {
        const res = await fetch(`api/devices/${selectedDevice.name}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.status === 'ok') {
            deselectDevice();
            await refreshDevices();
            computeAll();
        }
    } catch (e) {
        console.error('Delete failed:', e);
    }
}

// ── Move Mode ────────────────────────────────────────────────────────

function enterMoveMode() {
    if (!selectedDevice) return;
    moveMode = true;
    movingDeviceName = selectedDevice.name;
    const isTx = selectedDevice.type === 'tx';
    const color = isTx ? 0xff3333 : 0x00e5ff;

    // Initial position from selected device
    const pos = sionnaToThree(
        selectedDevice.position[0], selectedDevice.position[1], selectedDevice.position[2]
    );
    const surfY = getSurfaceBelow(pos);
    placementHeight = Math.max(0.5, pos.y - surfY);
    placementSurfaceY = surfY;

    // Preview marker
    if (!previewMarker) {
        const geo = new THREE.CylinderGeometry(0.8, 1.2, 3, 8);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 });
        previewMarker = new THREE.Mesh(geo, mat);
        twinScene.add(previewMarker);
    } else {
        previewMarker.material.color.set(color);
    }
    previewMarker.position.copy(pos);
    previewMarker.visible = true;

    // Mast preview
    if (!previewMast) {
        const mastGeo = new THREE.BufferGeometry();
        mastGeo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,1,0], 3));
        previewMast = new THREE.Line(mastGeo, new THREE.LineBasicMaterial({
            color, transparent: true, opacity: 0.6,
        }));
        twinScene.add(previewMast);
    } else {
        previewMast.material.color.set(color);
    }

    // Height label
    if (!previewHeightLabel) {
        previewHeightLabel = makeTextSprite('0m', color);
        twinScene.add(previewHeightLabel);
    }

    updatePreviewVisuals(pos.x, pos.z, surfY, placementHeight);

    const container = document.getElementById('three-container');
    container.style.cursor = 'crosshair';

    // Update sidebar to show move state
    const title = document.getElementById('sidebar-title');
    if (title) title.textContent = 'MOVING \u2014 CLICK TO PLACE';
}

function exitMoveMode() {
    moveMode = false;
    movingDeviceName = null;
    shiftHeld = false;
    placementLockPos = null;
    if (previewMarker) previewMarker.visible = false;
    if (previewMast) previewMast.visible = false;
    if (previewHeightLabel) previewHeightLabel.visible = false;
    const container = document.getElementById('three-container');
    container.style.cursor = '';
    hideSidebar();
    selectedDevice = null;
    clearHighlight();
}

// ── Panel Collapse + Resize ─────────────────────────────────────────

function togglePanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.classList.toggle('collapsed');
    updateGridLayout();
}

function updateGridLayout() {
    const grid = document.querySelector('.panel-grid');
    if (!grid) return;
    const p3 = document.getElementById('panel-paths');
    const p4 = document.getElementById('panel-link');
    const bothCollapsed = p3?.classList.contains('collapsed') && p4?.classList.contains('collapsed');
    grid.style.gridTemplateRows = bothCollapsed ? '1fr 32px' : '';
}

function initResizeHandles() {
    const grid = document.querySelector('.panel-grid');
    if (!grid) return;

    // ── Column resize handle ──
    const colHandle = document.getElementById('col-resize-handle');
    if (colHandle) {
        let startX, startFrac;
        colHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startFrac = parseFloat(grid.style.getPropertyValue('--col-split') || '50');
            const onMove = (ev) => {
                const dx = ev.clientX - startX;
                const pct = startFrac + (dx / grid.clientWidth) * 100;
                const clamped = Math.max(25, Math.min(75, pct));
                grid.style.setProperty('--col-split', clamped);
                grid.style.gridTemplateColumns = `${clamped}fr ${100 - clamped}fr`;
                // Move handle position
                colHandle.style.left = `calc(${clamped}% - 3px)`;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                colHandle.classList.remove('active');
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            colHandle.classList.add('active');
        });
        colHandle.addEventListener('dblclick', () => {
            grid.style.gridTemplateColumns = '1fr 1fr';
            grid.style.setProperty('--col-split', 50);
            colHandle.style.left = 'calc(50% - 3px)';
        });
    }

    // ── Row resize handle ──
    const rowHandle = document.getElementById('row-resize-handle');
    if (rowHandle) {
        let startY, startFrac;
        rowHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startY = e.clientY;
            startFrac = parseFloat(grid.style.getPropertyValue('--row-split') || '50');
            const onMove = (ev) => {
                const dy = ev.clientY - startY;
                const pct = startFrac + (dy / grid.clientHeight) * 100;
                const clamped = Math.max(20, Math.min(80, pct));
                grid.style.setProperty('--row-split', clamped);
                grid.style.gridTemplateRows = `${clamped}fr ${100 - clamped}fr`;
                rowHandle.style.top = `calc(${clamped}% - 3px)`;
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                rowHandle.classList.remove('active');
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            rowHandle.classList.add('active');
        });
        rowHandle.addEventListener('dblclick', () => {
            grid.style.gridTemplateRows = '1fr 1fr';
            grid.style.setProperty('--row-split', 50);
            rowHandle.style.top = 'calc(50% - 3px)';
        });
    }
}

// ── Export ─────────────────────────────────────────────────────────────

window.initTwinViewer = initTwinViewer;
window.loadSceneGeometry = loadSceneGeometry;
window.renderRayPaths = renderRayPaths;
window.renderCoverageOverlay = renderCoverageOverlay;
window.setPlacementMode = setPlacementMode;
window.computeAll = computeAll;
window.refreshDevices = refreshDevices;
window.deselectDevice = deselectDevice;
window.deleteSelectedDevice = deleteSelectedDevice;
window.enterMoveMode = enterMoveMode;
window.onSidebarPositionChange = onSidebarPositionChange;
window.togglePanel = togglePanel;
window.initResizeHandles = initResizeHandles;
