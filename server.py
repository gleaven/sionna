"""
6G R&D — FastAPI server for Sionna RT radio propagation research.

Real computation backend:
- Scene geometry export for Three.js 3D visualization
- Live radio coverage maps via Sionna RT PlanarRadioMap
- Ray path computation with full channel analysis (delay spread, path loss, AoD/AoA)
- Link budget calculation from actual propagation data
"""

import io
import json
import math
import os
import time
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import asyncio
import websockets

import numpy as np
import httpx
from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sionna")

# ── Sionna RT initialization (heavy, do once) ────────────────────────

SIONNA_READY = threading.Event()
SCENE = None
SCENE_LOCK = threading.Lock()
SCENE_NAME = "munich"

# Available scenes bundled with sionna-rt
BUILT_IN_SCENES = {
    "munich": "sionna.rt.scene.munich",
    "etoile": "sionna.rt.scene.etoile",
    "simple_street_canyon": "sionna.rt.scene.simple_street_canyon",
    "simple_wedge": "sionna.rt.scene.simple_wedge",
    "box": "sionna.rt.scene.box",
    "floor_wall": "sionna.rt.scene.floor_wall",
}

DEFAULT_TX_POS = [8.5, 21.0, 27.0]
DEFAULT_RX_POS = [45.0, 90.0, 1.5]


def _init_sionna():
    """Initialize Sionna RT in a background thread."""
    global SCENE
    try:
        logger.info("Initializing Sionna RT...")
        os.environ.setdefault(
            "DRJIT_LIBLLVM_PATH",
            "/usr/lib/aarch64-linux-gnu/libLLVM-14.so",
        )
        import sionna.rt as rt
        import mitsuba as mi

        logger.info(f"Mitsuba variant: {mi.variant()}")
        logger.info(f"Sionna RT loaded, variants: {mi.variants()}")

        # Load default scene
        scene = rt.load_scene(rt.scene.munich)
        logger.info(f"Munich scene loaded: {len(scene.objects)} objects")

        # Set up default antenna arrays
        from sionna.rt import PlanarArray, Transmitter, Receiver

        ant = PlanarArray(
            num_rows=1, num_cols=1,
            vertical_spacing=0.5, horizontal_spacing=0.5,
            pattern="iso", polarization="V",
        )
        scene.tx_array = ant
        scene.rx_array = ant

        # Add default TX/RX
        tx = Transmitter(name="tx0", position=DEFAULT_TX_POS)
        rx = Receiver(name="rx0", position=DEFAULT_RX_POS)
        scene.add(tx)
        scene.add(rx)

        SCENE = scene
        SIONNA_READY.set()
        logger.info("Sionna RT ready.")

        # Pre-cache the mesh GLB so first page load is instant
        try:
            _build_mesh_cache(SCENE_NAME)
        except Exception:
            logger.warning("Mesh pre-cache failed (will retry on first request)")

        # Warm up LLVM JIT — first RT call compiles kernels (~30-60s),
        # subsequent calls use cached compiled code (~0.2s).
        try:
            logger.info("Warming up LLVM JIT (first-run kernel compilation)...")
            t0 = time.time()
            rms = rt.RadioMapSolver()
            rms(scene, cell_size=[10, 10], max_depth=1)
            logger.info(f"Coverage JIT warm-up: {time.time()-t0:.1f}s")
            t0 = time.time()
            solver = rt.PathSolver()
            solver(scene, max_depth=1)
            logger.info(f"Paths JIT warm-up: {time.time()-t0:.1f}s")
            logger.info("JIT warm-up complete — subsequent calls will be fast.")
        except Exception:
            logger.warning("JIT warm-up failed (first compute will be slower)")
    except Exception:
        logger.exception("Failed to initialize Sionna RT")
        SIONNA_READY.set()  # Unblock health checks even on failure


@asynccontextmanager
async def lifespan(app: FastAPI):
    thread = threading.Thread(target=_init_sionna, daemon=True)
    thread.start()
    yield


app = FastAPI(title="6G R&D — Sionna RT Research Platform", lifespan=lifespan)

# ── Static files ─────────────────────────────────────────────────────

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ── Health & root ────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "sionna_ready": SIONNA_READY.is_set(),
        "scene_loaded": SCENE is not None,
        "scene_name": SCENE_NAME if SCENE else None,
    }


@app.get("/")
def root():
    return FileResponse(str(STATIC_DIR / "index.html"))


# ── Scene APIs ───────────────────────────────────────────────────────

@app.get("/api/scenes")
def list_scenes():
    """List available built-in scenes."""
    return {"scenes": list(BUILT_IN_SCENES.keys()), "active": SCENE_NAME}


def _do_load_scene(name):
    """Blocking scene load — runs in thread executor."""
    global SCENE, SCENE_NAME
    import sionna.rt as rt
    from sionna.rt import PlanarArray, Transmitter, Receiver

    scene_path = getattr(rt.scene, name)
    with SCENE_LOCK:
        scene = rt.load_scene(scene_path)
        ant = PlanarArray(
            num_rows=1, num_cols=1,
            vertical_spacing=0.5, horizontal_spacing=0.5,
            pattern="iso", polarization="V",
        )
        scene.tx_array = ant
        scene.rx_array = ant
        tx = Transmitter(name="tx0", position=DEFAULT_TX_POS)
        rx = Receiver(name="rx0", position=DEFAULT_RX_POS)
        scene.add(tx)
        scene.add(rx)
        SCENE = scene
        SCENE_NAME = name
        _mesh_cache.pop(name, None)

    # Pre-cache mesh for new scene
    try:
        _build_mesh_cache(name)
    except Exception:
        logger.warning(f"Mesh pre-cache failed for {name}")

    return {"status": "ok", "scene": name, "objects": len(scene.objects)}


@app.post("/api/scene/{name}")
async def load_scene(name: str):
    """Switch to a different scene."""
    if name not in BUILT_IN_SCENES:
        return JSONResponse({"error": f"Unknown scene: {name}"}, status_code=404)
    if not SIONNA_READY.is_set():
        return JSONResponse({"error": "Sionna not ready"}, status_code=503)

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _do_load_scene, name)


@app.get("/api/scene/geometry")
async def get_scene_geometry():
    """Export TX/RX positions and scene metadata for Three.js overlays."""
    if SCENE is None:
        return JSONResponse({"error": "Scene not loaded"}, status_code=503)

    devices = []
    for name, tx in SCENE.transmitters.items():
        pos = [float(x) for x in tx.position.numpy().flatten()]
        devices.append({"name": name, "position": pos, "type": "tx"})
    for name, rx in SCENE.receivers.items():
        pos = [float(x) for x in rx.position.numpy().flatten()]
        devices.append({"name": name, "position": pos, "type": "rx"})

    return {"devices": devices, "scene": SCENE_NAME}


# ── Scene Mesh Export (GLB) ──────────────────────────────────────────

MATERIAL_COLORS = {
    "marble":   [220, 215, 210, 255],
    "metal":    [180, 190, 200, 255],
    "concrete": [170, 170, 165, 255],
    "brick":    [195, 140, 110, 255],
    "wood":     [190, 165, 120, 255],
    "glass":    [200, 230, 245, 200],
}
_mesh_cache: dict[str, bytes] = {}


def _build_mesh_cache(scene_name):
    """Build GLB mesh from current SCENE. Call from background thread."""
    import trimesh

    meshes = []
    with SCENE_LOCK:
        for name, obj in SCENE.objects.items():
            try:
                mi_mesh = obj.mi_mesh
                verts = np.array(mi_mesh.vertex_positions_buffer()).reshape(-1, 3)
                faces = np.array(mi_mesh.faces_buffer()).reshape(-1, 3)

                mat_str = str(obj.radio_material).lower() if obj.radio_material else ""
                color = [160, 160, 160, 255]
                for key, col in MATERIAL_COLORS.items():
                    if key in mat_str:
                        color = col
                        break

                tri = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
                tri.visual.vertex_colors = np.tile(color, (len(verts), 1)).astype(np.uint8)
                meshes.append(tri)
            except Exception:
                continue

    combined = trimesh.util.concatenate(meshes)
    glb_data = combined.export(file_type="glb")
    _mesh_cache[scene_name] = glb_data
    logger.info(f"Cached {scene_name} mesh: {len(combined.vertices)} verts, "
                f"{len(combined.faces)} faces, {len(glb_data)//1024} KB")


@app.get("/api/scene/mesh")
async def get_scene_mesh():
    """Export scene triangle mesh as GLB (fast concatenated mesh)."""
    if SCENE is None:
        return JSONResponse({"error": "Scene not loaded"}, status_code=503)

    if SCENE_NAME not in _mesh_cache:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _build_mesh_cache, SCENE_NAME)

    return Response(content=_mesh_cache[SCENE_NAME], media_type="model/gltf-binary")


# ── Coverage Map API ─────────────────────────────────────────────────

def _jet_colormap(val):
    """Fast jet colormap: val in [0,1] → (r,g,b) in [0,255]."""
    # Approximation of matplotlib's jet colormap
    r = int(np.clip(1.5 - abs(4.0 * val - 3.0), 0, 1) * 255)
    g = int(np.clip(1.5 - abs(4.0 * val - 2.0), 0, 1) * 255)
    b = int(np.clip(1.5 - abs(4.0 * val - 1.0), 0, 1) * 255)
    return r, g, b


def _do_coverage(cell_size, max_depth):
    """Blocking coverage computation — runs in thread executor."""
    import sionna.rt as rt
    from PIL import Image

    logger.info(f"Coverage: starting (cell={cell_size}m, depth={max_depth})")
    t0 = time.time()
    with SCENE_LOCK:
        if not SCENE.transmitters:
            from PIL import Image
            buf = io.BytesIO()
            Image.new("RGB", (100, 100), (10, 10, 15)).save(buf, format="PNG")
            buf.seek(0)
            return buf.read(), 0.0
        rms = rt.RadioMapSolver()
        rm = rms(SCENE, cell_size=[cell_size, cell_size], max_depth=max_depth)
        logger.info(f"Coverage: solver returned in {time.time()-t0:.2f}s, materializing...")
        # DrJit is lazy — np.array() triggers actual LLVM JIT execution
        try:
            data = np.array(rm.path_gain) if hasattr(rm, "path_gain") else np.zeros((10, 10))
        except Exception:
            data = np.zeros((10, 10))
    compute_time = time.time() - t0
    logger.info(f"Coverage: fully materialized in {compute_time:.2f}s, shape={data.shape}")

    # Reduce to 2D: for multi-TX, sum power across transmitters for combined coverage
    while data.ndim > 2:
        if data.shape[0] == 1:
            data = data[0]
        else:
            # Sum power contributions from all TXes (linear domain, pre-dB)
            data = data.sum(axis=0)
    if data.ndim == 1:
        side = int(math.sqrt(len(data)))
        data = data[:side * side].reshape(side, side)

    data_db = np.where(data > 0, 10 * np.log10(data + 1e-30), -200)
    data_db = np.clip(data_db, -160, 0)

    # Fast heatmap via PIL (no matplotlib overhead)
    t1 = time.time()
    vmin, vmax = -160.0, 0.0
    normalized = (data_db - vmin) / (vmax - vmin)
    normalized = np.clip(normalized, 0, 1)

    # Vectorized jet colormap
    v = normalized
    r = np.clip(1.5 - np.abs(4.0 * v - 3.0), 0, 1)
    g = np.clip(1.5 - np.abs(4.0 * v - 2.0), 0, 1)
    b = np.clip(1.5 - np.abs(4.0 * v - 1.0), 0, 1)

    # Flip vertically (origin="lower" equivalent)
    rgb = np.stack([r, g, b], axis=-1)[::-1]
    img_array = (rgb * 255).astype(np.uint8)

    # Scale up for visibility (min 400px on each side)
    h, w = img_array.shape[:2]
    scale = max(1, 400 // min(h, w))
    img = Image.fromarray(img_array, "RGB")
    if scale > 1:
        img = img.resize((w * scale, h * scale), Image.NEAREST)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    logger.info(f"Coverage: PNG rendered in {time.time()-t1:.2f}s (total {compute_time + time.time()-t1:.2f}s)")
    return buf.read(), compute_time


@app.post("/api/coverage")
async def compute_coverage(
    cell_size: float = Query(5.0, description="Cell size in meters"),
    max_depth: int = Query(3, description="Max ray bounce depth"),
):
    """Compute radio coverage map via Sionna RT and return as PNG."""
    if SCENE is None:
        return JSONResponse({"error": "Scene not loaded"}, status_code=503)

    loop = asyncio.get_event_loop()
    png_data, compute_time = await loop.run_in_executor(
        None, _do_coverage, cell_size, max_depth
    )

    return Response(
        content=png_data,
        media_type="image/png",
        headers={"X-Compute-Time": f"{compute_time:.3f}s"},
    )


# ── Ray Path API with full channel analysis ──────────────────────────

# Sionna InteractionType enum values → human-readable labels
INTERACTION_TYPES = {0: "NONE", 1: "SPECULAR", 2: "DIFFUSE", 4: "REFRACTION", 8: "DIFFRACTION"}


def _classify_path(interaction_ids):
    """Classify a path by its dominant interaction type.

    interaction_ids: array of per-segment Sionna InteractionType values
    Returns (label, type_id) where label is used by the frontend color map.
    """
    active = set(int(x) for x in interaction_ids if x != 0)
    if not active:
        return "LoS", 0
    if 8 in active:
        return "diffracted", 8
    if 2 in active:
        return "scattered", 2
    if 4 in active:
        return "refracted", 4
    if 1 in active:
        return "reflected", 1
    return f"type-{max(active)}", max(active)


def _extract_paths(paths, tx_positions, rx_positions):
    """Extract path list from a Sionna Paths object for ALL TX/RX pairs.

    With 1x1 PlanarArray per device, each device maps to one antenna index.
    The PathSolver computes all TX→RX pairs simultaneously.

    tx_positions: list of [x,y,z] for each TX device (ordered by scene iteration)
    rx_positions: list of [x,y,z] for each RX device (ordered by scene iteration)

    vertices shape:     (max_depth, num_tx_devices, num_rx_devices, num_paths, 3)
    interactions shape:  (max_depth, num_tx_devices, num_rx_devices, num_paths)
    tau shape:           (num_tx_devices, num_rx_devices, num_paths)
    a shape:             (num_tx_devices, num_rx_devices, ..., num_paths)
    """
    vertices = np.array(paths.vertices)
    inter_arr = np.array(paths.interactions) if hasattr(paths, "interactions") else None
    tau_arr = np.array(paths.tau) if hasattr(paths, "tau") else None
    valid_arr = np.array(paths.valid) if hasattr(paths, "valid") else None
    a_arr = None
    if hasattr(paths, "a"):
        try:
            a_arr = np.array(paths.a)
        except Exception:
            pass

    logger.info(
        f"Paths extract: vertices={vertices.shape}, "
        f"interactions={'None' if inter_arr is None else inter_arr.shape}, "
        f"tau={'None' if tau_arr is None else tau_arr.shape}, "
        f"a={'None' if a_arr is None else a_arr.shape}, "
        f"tx_count={len(tx_positions)}, rx_count={len(rx_positions)}"
    )

    path_list = []
    delays_s = []
    path_gains_linear = []

    if vertices.ndim != 5:
        logger.warning(f"Unexpected vertices ndim={vertices.ndim}, shape={vertices.shape}")
        return path_list, delays_s, path_gains_linear

    # Sionna tensor convention: (max_depth, num_rx, num_tx, num_paths, 3)
    # Note: RX is axis 1, TX is axis 2 (verified empirically)
    max_depth_dim, num_rx_dim, num_tx_dim, num_paths, _ = vertices.shape

    logger.info(
        f"Paths iterating: {num_tx_dim} TX x {num_rx_dim} RX x {num_paths} paths/pair"
    )

    # Iterate over all TX→RX pairs
    for ti in range(min(num_tx_dim, len(tx_positions))):
        tx_pos = tx_positions[ti]
        for ri in range(min(num_rx_dim, len(rx_positions))):
            rx_pos = rx_positions[ri]

            for p in range(num_paths):
                # Skip invalid paths — valid shape: (num_rx, num_tx, num_paths)
                if valid_arr is not None:
                    try:
                        if not valid_arr[ri, ti, p]:
                            continue
                    except IndexError:
                        continue

                # Per-segment interactions — shape: (max_depth, num_rx, num_tx, num_paths)
                if inter_arr is not None:
                    seg_types = inter_arr[:, ri, ti, p]
                else:
                    seg_types = np.zeros(max_depth_dim, dtype=int)

                # Build full path: TX → interaction vertices → RX
                coords = [tx_pos]
                for d in range(max_depth_dim):
                    if inter_arr is not None and int(seg_types[d]) != 0:
                        v = vertices[d, ri, ti, p, :]
                        coords.append([float(v[0]), float(v[1]), float(v[2])])
                coords.append(rx_pos)

                if len(coords) < 2:
                    continue

                # Classify by dominant interaction
                label, type_id = _classify_path(seg_types)
                num_interactions = len(coords) - 2

                # Delay — tau shape: (num_rx, num_tx, num_paths)
                delay_s = None
                if tau_arr is not None:
                    try:
                        delay_s = float(tau_arr[ri, ti, p])
                    except IndexError:
                        pass

                # Path gain — a shape: (num_rx, num_tx, ..., num_paths)
                gain_db = None
                if a_arr is not None:
                    try:
                        a_val = a_arr[ri, ti, ..., p]
                        gain_linear = float(np.sum(np.abs(a_val) ** 2))
                        if gain_linear > 0:
                            gain_db = float(10 * np.log10(gain_linear))
                            path_gains_linear.append(gain_linear)
                    except (IndexError, ValueError):
                        pass

                if delay_s is not None:
                    delays_s.append(delay_s)

                entry = {
                    "vertices": coords,
                    "type": label,
                    "type_id": type_id,
                    "num_interactions": num_interactions,
                    "tx_idx": ti,
                    "rx_idx": ri,
                }
                if delay_s is not None:
                    entry["delay_ns"] = round(delay_s * 1e9, 2)
                if gain_db is not None:
                    entry["path_gain_db"] = round(gain_db, 1)
                path_list.append(entry)

    return path_list, delays_s, path_gains_linear


def _do_paths(max_depth, tx_position=None, rx_position=None):
    """Blocking path computation — runs in thread executor."""
    import sionna.rt as rt

    logger.info(f"Paths: starting (depth={max_depth})")
    t0 = time.time()
    with SCENE_LOCK:
        if not SCENE.transmitters or not SCENE.receivers:
            return {
                "paths": [], "num_paths": 0, "compute_time": "0s",
                "tx_position": [0,0,0], "rx_position": [0,0,0],
                "distance_m": 0, "max_depth": max_depth,
                "scene": SCENE_NAME, "analysis": {},
            }

        first_tx_name = next(iter(SCENE.transmitters))
        first_rx_name = next(iter(SCENE.receivers))

        if tx_position:
            coords = [float(x) for x in tx_position.split(",")]
            SCENE.transmitters[first_tx_name].position = coords
        if rx_position:
            coords = [float(x) for x in rx_position.split(",")]
            SCENE.receivers[first_rx_name].position = coords

        solver = rt.PathSolver()
        paths = solver(SCENE, max_depth=max_depth)
        logger.info(f"Paths: solver returned in {time.time()-t0:.2f}s, extracting...")

        # Collect all TX/RX positions in scene iteration order
        tx_positions = [[float(x) for x in t.position.numpy().flatten()]
                        for t in SCENE.transmitters.values()]
        rx_positions = [[float(x) for x in r.position.numpy().flatten()]
                        for r in SCENE.receivers.values()]

        path_list, delays_s, path_gains_linear = _extract_paths(paths, tx_positions, rx_positions)

    compute_time = time.time() - t0
    logger.info(f"Paths: extracted {len(path_list)} paths in {compute_time:.2f}s")

    first_tx = tx_positions[0] if tx_positions else [0, 0, 0]
    first_rx = rx_positions[0] if rx_positions else [0, 0, 0]
    distance = float(np.linalg.norm(np.array(first_tx) - np.array(first_rx)))
    analysis = _compute_channel_analysis(delays_s, path_gains_linear, path_list, distance)

    return {
        "paths": path_list,
        "num_paths": len(path_list),
        "compute_time": f"{compute_time:.3f}s",
        "tx_position": first_tx,
        "rx_position": first_rx,
        "distance_m": round(distance, 2),
        "max_depth": max_depth,
        "scene": SCENE_NAME,
        "analysis": analysis,
    }


@app.post("/api/paths")
async def compute_paths(
    max_depth: int = Query(3, description="Max ray bounce depth"),
    tx_position: str = Query(None, description="TX position as 'x,y,z'"),
    rx_position: str = Query(None, description="RX position as 'x,y,z'"),
):
    """Compute ray paths and return full channel analysis."""
    if SCENE is None:
        return JSONResponse({"error": "Scene not loaded"}, status_code=503)

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None, _do_paths, max_depth, tx_position, rx_position
    )


def _compute_channel_analysis(delays_s, path_gains_linear, path_list, distance):
    """Derive real channel metrics from computed path data."""
    analysis = {
        "los_exists": any(p["type"] == "LoS" for p in path_list),
        "path_type_counts": {},
    }

    # Count interaction types
    for p in path_list:
        t = p["type"]
        analysis["path_type_counts"][t] = analysis["path_type_counts"].get(t, 0) + 1

    # Delay spread analysis (real physics)
    if len(delays_s) >= 2:
        delays = np.array(delays_s)
        min_delay = float(np.min(delays))
        max_delay = float(np.max(delays))
        mean_delay = float(np.mean(delays))

        # RMS delay spread (σ_τ)
        if len(path_gains_linear) == len(delays_s) and sum(path_gains_linear) > 0:
            # Power-weighted delay spread
            powers = np.array(path_gains_linear)
            total_power = np.sum(powers)
            mean_excess_delay = float(np.sum(powers * delays) / total_power)
            rms_delay_spread = float(np.sqrt(
                np.sum(powers * (delays - mean_excess_delay) ** 2) / total_power
            ))
            analysis["total_path_gain_db"] = round(10 * np.log10(total_power + 1e-30), 1)
        else:
            mean_excess_delay = mean_delay
            rms_delay_spread = float(np.std(delays))

        analysis["min_delay_ns"] = round(min_delay * 1e9, 2)
        analysis["max_delay_ns"] = round(max_delay * 1e9, 2)
        analysis["mean_excess_delay_ns"] = round(mean_excess_delay * 1e9, 2)
        analysis["rms_delay_spread_ns"] = round(rms_delay_spread * 1e9, 2)
        analysis["delay_spread_us"] = round(rms_delay_spread * 1e6, 4)

        # Coherence bandwidth (Bc ≈ 1 / (5 * σ_τ)) for 0.5 correlation
        if rms_delay_spread > 0:
            bc_hz = 1.0 / (5.0 * rms_delay_spread)
            analysis["coherence_bandwidth_mhz"] = round(bc_hz / 1e6, 2)
    elif len(delays_s) == 1:
        analysis["min_delay_ns"] = round(delays_s[0] * 1e9, 2)
        analysis["max_delay_ns"] = round(delays_s[0] * 1e9, 2)
        analysis["rms_delay_spread_ns"] = 0.0

    # Path gain statistics
    if path_gains_linear:
        total = sum(path_gains_linear)
        analysis["total_path_gain_db"] = round(10 * np.log10(total + 1e-30), 1)
        analysis["strongest_path_gain_db"] = round(10 * np.log10(max(path_gains_linear) + 1e-30), 1)

    # Free-space reference for comparison
    if distance > 0:
        # FSPL at 3.5 GHz (typical FR1 6G candidate)
        fspl_db = 20 * np.log10(distance) + 20 * np.log10(3.5e9) + 20 * np.log10(4 * np.pi / 3e8)
        analysis["fspl_3_5ghz_db"] = round(fspl_db, 1)

    analysis["tx_rx_distance_m"] = round(distance, 2)

    return analysis


# ── Device management ────────────────────────────────────────────────

_device_counter = {"tx": 0, "rx": 0}


@app.get("/api/devices")
async def list_devices():
    """List all TX/RX devices in the current scene."""
    if SCENE is None:
        return JSONResponse({"error": "Scene not loaded"}, status_code=503)
    devices = []
    for name, tx in SCENE.transmitters.items():
        pos = [float(x) for x in tx.position.numpy().flatten()]
        devices.append({"name": name, "position": pos, "type": "tx"})
    for name, rx in SCENE.receivers.items():
        pos = [float(x) for x in rx.position.numpy().flatten()]
        devices.append({"name": name, "position": pos, "type": "rx"})
    return {"devices": devices}


@app.post("/api/devices")
async def add_device(request: Request):
    """Add a new TX or RX device at given position. Body: {type, x, y, z}."""
    if SCENE is None:
        return JSONResponse({"error": "Scene not loaded"}, status_code=503)

    body = await request.json()
    dtype = body.get("type", "tx")
    x, y, z = float(body.get("x", 0)), float(body.get("y", 0)), float(body.get("z", 0))

    from sionna.rt import Transmitter, Receiver

    with SCENE_LOCK:
        if dtype == "tx":
            _device_counter["tx"] += 1
            name = f"tx{_device_counter['tx']}"
            dev = Transmitter(name=name, position=[x, y, z])
        else:
            _device_counter["rx"] += 1
            name = f"rx{_device_counter['rx']}"
            dev = Receiver(name=name, position=[x, y, z])
        SCENE.add(dev)

    return {"status": "ok", "name": name, "type": dtype, "position": [x, y, z]}


@app.delete("/api/devices/{device_name}")
async def remove_device(device_name: str):
    """Remove a TX or RX device from the scene."""
    if SCENE is None:
        return JSONResponse({"error": "Scene not loaded"}, status_code=503)

    with SCENE_LOCK:
        if device_name in SCENE.transmitters:
            SCENE.remove(device_name)
        elif device_name in SCENE.receivers:
            SCENE.remove(device_name)
        else:
            return JSONResponse({"error": f"Unknown device: {device_name}"}, status_code=404)

    return {"status": "ok", "removed": device_name}


@app.post("/api/devices/{device_name}/position")
async def update_device_position(device_name: str, request: Request):
    """Move a TX or RX device to a new position."""
    if SCENE is None:
        return JSONResponse({"error": "Scene not loaded"}, status_code=503)

    body = await request.json()
    x, y, z = float(body.get("x", 0)), float(body.get("y", 0)), float(body.get("z", 0))

    with SCENE_LOCK:
        if device_name in SCENE.transmitters:
            SCENE.transmitters[device_name].position = [x, y, z]
        elif device_name in SCENE.receivers:
            SCENE.receivers[device_name].position = [x, y, z]
        else:
            return JSONResponse({"error": f"Unknown device: {device_name}"}, status_code=404)

    return {"status": "ok", "device": device_name, "position": [x, y, z]}


# ── Configuration save/load ───────────────────────────────────────────

CONFIGS_DIR = Path("/app/data/configs")


@app.get("/api/configs")
async def list_configs():
    """List all saved tower configurations."""
    CONFIGS_DIR.mkdir(parents=True, exist_ok=True)
    configs = []
    for f in sorted(CONFIGS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(f.read_text())
            configs.append({
                "name": f.stem,
                "scene": data.get("scene"),
                "device_count": len(data.get("devices", [])),
                "saved_at": data.get("saved_at"),
                "description": data.get("description", ""),
            })
        except Exception:
            pass
    return {"configs": configs}


@app.post("/api/configs/{name}")
async def save_config(name: str, request: Request):
    """Save current tower configuration under a name."""
    if SCENE is None:
        return JSONResponse({"error": "Scene not loaded"}, status_code=503)

    try:
        body = await request.json()
    except Exception:
        body = {}

    devices = []
    for n, tx in SCENE.transmitters.items():
        pos = [float(x) for x in tx.position.numpy().flatten()]
        devices.append({"name": n, "type": "tx", "position": pos})
    for n, rx in SCENE.receivers.items():
        pos = [float(x) for x in rx.position.numpy().flatten()]
        devices.append({"name": n, "type": "rx", "position": pos})

    config = {
        "scene": SCENE_NAME,
        "devices": devices,
        "link_params": body.get("link_params", {}),
        "description": body.get("description", ""),
        "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    CONFIGS_DIR.mkdir(parents=True, exist_ok=True)
    (CONFIGS_DIR / f"{name}.json").write_text(json.dumps(config, indent=2))
    logger.info(f"Config saved: {name} ({len(devices)} devices, scene={SCENE_NAME})")

    return {"status": "ok", "name": name, "device_count": len(devices)}


@app.post("/api/configs/{name}/load")
async def load_config(name: str):
    """Load a saved configuration — restores scene and devices."""
    config_file = CONFIGS_DIR / f"{name}.json"
    if not config_file.exists():
        return JSONResponse({"error": f"Config not found: {name}"}, status_code=404)

    config = json.loads(config_file.read_text())

    # Switch scene if different
    if config["scene"] != SCENE_NAME and config["scene"] in BUILT_IN_SCENES:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_load_scene, config["scene"])

    # Restore devices
    from sionna.rt import Transmitter, Receiver

    with SCENE_LOCK:
        # Clear existing devices
        for n in list(SCENE.transmitters.keys()):
            SCENE.remove(n)
        for n in list(SCENE.receivers.keys()):
            SCENE.remove(n)

        # Add saved devices
        for dev in config.get("devices", []):
            if dev["type"] == "tx":
                SCENE.add(Transmitter(name=dev["name"], position=dev["position"]))
            else:
                SCENE.add(Receiver(name=dev["name"], position=dev["position"]))

        # Update device counter to avoid name collisions
        max_tx = max((int(d["name"].replace("tx", "")) for d in config.get("devices", [])
                       if d["type"] == "tx" and d["name"].startswith("tx")), default=0)
        max_rx = max((int(d["name"].replace("rx", "")) for d in config.get("devices", [])
                       if d["type"] == "rx" and d["name"].startswith("rx")), default=0)
        _device_counter["tx"] = max(max_tx, _device_counter["tx"])
        _device_counter["rx"] = max(max_rx, _device_counter["rx"])

    logger.info(f"Config loaded: {name} ({len(config.get('devices', []))} devices)")

    return {
        "status": "ok",
        "scene": config["scene"],
        "devices": config.get("devices", []),
        "link_params": config.get("link_params", {}),
    }


@app.delete("/api/configs/{name}")
async def delete_config(name: str):
    """Delete a saved configuration."""
    config_file = CONFIGS_DIR / f"{name}.json"
    if config_file.exists():
        config_file.unlink()
        return {"status": "ok", "deleted": name}
    return JSONResponse({"error": f"Config not found: {name}"}, status_code=404)


def _do_compute_all(cell_size, max_depth):
    """Blocking combined coverage + paths computation — runs in thread executor."""
    import sionna.rt as rt
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import base64

    # ── Coverage map ──
    with SCENE_LOCK:
        rms = rt.RadioMapSolver()
        t0 = time.time()
        rm = rms(SCENE, cell_size=[cell_size, cell_size], max_depth=max_depth)
        coverage_time = time.time() - t0

    try:
        data = np.array(rm.path_gain) if hasattr(rm, "path_gain") else np.zeros((10, 10))
    except Exception:
        data = np.zeros((10, 10))
    while data.ndim > 2:
        if data.shape[0] == 1:
            data = data[0]
        else:
            data = data.sum(axis=0)
    if data.ndim == 1:
        side = int(math.sqrt(len(data)))
        data = data[:side * side].reshape(side, side)

    data_db = np.where(data > 0, 10 * np.log10(data + 1e-30), -200)
    data_db = np.clip(data_db, -160, 0)

    fig, ax = plt.subplots(1, 1, figsize=(8, 6))
    im = ax.imshow(data_db, cmap="jet", interpolation="bilinear", origin="lower")
    ax.set_title(f"Path Gain — {SCENE_NAME.upper()} (depth={max_depth})",
                 color="#e0e0e0", fontsize=11)
    cbar = plt.colorbar(im, ax=ax, label="Path Gain (dB)")
    cbar.ax.yaxis.label.set_color("#e0e0e0")
    cbar.ax.tick_params(colors="#aaa")
    ax.set_xlabel(f"X ({cell_size}m cells)", color="#aaa")
    ax.set_ylabel(f"Y ({cell_size}m cells)", color="#aaa")
    ax.tick_params(colors="#aaa")
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100, bbox_inches="tight",
                facecolor="#0a0a0f", edgecolor="none")
    plt.close(fig)
    buf.seek(0)
    coverage_b64 = base64.b64encode(buf.read()).decode()

    h, w = data_db.shape
    coverage_raw = {
        "width": w, "height": h,
        "cell_size": cell_size,
        "min_db": float(data_db[data_db > -200].min()) if np.any(data_db > -200) else -160,
        "max_db": float(data_db.max()),
    }

    # ── Ray paths ──
    with SCENE_LOCK:
        solver = rt.PathSolver()
        t1 = time.time()
        paths = solver(SCENE, max_depth=max_depth)
        paths_time = time.time() - t1

        tx_positions = [[float(x) for x in t.position.numpy().flatten()]
                        for t in SCENE.transmitters.values()]
        rx_positions = [[float(x) for x in r.position.numpy().flatten()]
                        for r in SCENE.receivers.values()]

    path_list, delays_s, path_gains_linear = _extract_paths(paths, tx_positions, rx_positions)
    first_tx = tx_positions[0] if tx_positions else [0, 0, 0]
    first_rx = rx_positions[0] if rx_positions else [0, 0, 0]
    distance = float(np.linalg.norm(np.array(first_tx) - np.array(first_rx)))
    analysis = _compute_channel_analysis(delays_s, path_gains_linear, path_list, distance)

    return {
        "coverage": {
            "image_b64": coverage_b64,
            "compute_time": f"{coverage_time:.3f}s",
            "raw": coverage_raw,
        },
        "paths": {
            "paths": path_list,
            "num_paths": len(path_list),
            "compute_time": f"{paths_time:.3f}s",
            "tx_position": first_tx,
            "rx_position": first_rx,
            "distance_m": round(distance, 2),
            "max_depth": max_depth,
            "scene": SCENE_NAME,
            "analysis": analysis,
        },
    }


@app.post("/api/compute")
async def compute_all(
    cell_size: float = Query(5.0),
    max_depth: int = Query(3),
):
    """Compute both coverage map and ray paths in one call."""
    if SCENE is None:
        return JSONResponse({"error": "Scene not loaded"}, status_code=503)

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None, _do_compute_all, cell_size, max_depth
    )


# ── Jupyter Notebook Proxy ────────────────────────────────────────────
# Proxies /notebooks/* to Jupyter Lab running on localhost:8888.
# Jupyter is configured with --ServerApp.base_url=/notebooks so its
# internal URLs match the external path under standalone serving. If
# you put this behind a prefix-rewriting reverse proxy (e.g. /sionna/),
# make sure the proxy strips the prefix before forwarding.

JUPYTER_BASE = "http://127.0.0.1:8888"


@app.get("/notebooks")
@app.get("/notebooks/")
async def jupyter_root():
    """Redirect bare /notebooks/ to Jupyter Lab UI."""
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/notebooks/lab")


@app.api_route("/notebooks/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def jupyter_proxy(request: Request, path: str):
    """Reverse proxy HTTP requests to Jupyter Lab."""
    target_url = f"{JUPYTER_BASE}/notebooks/{path}"
    if request.url.query:
        target_url += f"?{request.url.query}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        body = await request.body()
        headers = dict(request.headers)
        # Remove hop-by-hop headers and origin (Jupyter's check_origin()
        # rejects the external origin, causing 404 on PUT/POST)
        for h in ("host", "connection", "transfer-encoding", "origin"):
            headers.pop(h, None)

        resp = await client.request(
            method=request.method,
            url=target_url,
            headers=headers,
            content=body,
        )

    # Pass through response, excluding hop-by-hop headers
    excluded = {"transfer-encoding", "connection", "content-encoding", "content-length"}
    resp_headers = {k: v for k, v in resp.headers.items() if k.lower() not in excluded}

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=resp_headers,
        media_type=resp.headers.get("content-type"),
    )


@app.websocket("/notebooks/{path:path}")
async def jupyter_ws_proxy(ws: WebSocket, path: str):
    """Reverse proxy WebSocket connections to Jupyter (kernel communication)."""
    await ws.accept()

    target_url = f"ws://127.0.0.1:8888/notebooks/{path}"
    if ws.scope.get("query_string"):
        target_url += f"?{ws.scope['query_string'].decode()}"

    try:
        async with websockets.connect(target_url) as jupyter_ws:
            async def client_to_jupyter():
                try:
                    while True:
                        data = await ws.receive()
                        if "text" in data:
                            await jupyter_ws.send(data["text"])
                        elif "bytes" in data:
                            await jupyter_ws.send(data["bytes"])
                except (WebSocketDisconnect, Exception):
                    pass

            async def jupyter_to_client():
                try:
                    async for msg in jupyter_ws:
                        if isinstance(msg, str):
                            await ws.send_text(msg)
                        else:
                            await ws.send_bytes(msg)
                except (WebSocketDisconnect, Exception):
                    pass

            await asyncio.gather(client_to_jupyter(), jupyter_to_client())
    except Exception as e:
        logger.warning(f"Jupyter WS proxy error: {e}")
    finally:
        try:
            await ws.close()
        except Exception:
            pass


# ── Run ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")
