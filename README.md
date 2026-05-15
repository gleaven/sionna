# SIONNA — 6G R&D: Live Ray-Traced Radio Propagation + Notebook Lab

> NVIDIA Sionna RT running on your local GPU — load real urban scenes,
> drop transmitters and receivers, watch the GPU compute coverage maps
> and individual ray paths in real time, then drop into a JupyterLab
> with the full Sionna stack for neural-receiver and link-level work.

---

## What this demo is

This demo packages **NVIDIA's open-source Sionna RT 1.2.1**
(<https://nvlabs.github.io/sionna/>) — the link-level / ray-tracing
half of the Sionna suite — behind a small FastAPI server, a Three.js
3D viewer, and a JupyterLab instance, all in one container.

It does two things side by side:

1. **Interactive 6G digital twin (the UI).** Pick a scene, click on
   the 3D model to place transmitters and receivers, and the server
   ray-traces the radio environment on the GPU: a coverage map (path
   gain across the scene), the actual ray paths from each TX to each
   RX (LoS, reflected, diffracted, scattered, refracted), the channel
   impulse response derived from those paths, and a full link budget
   computed from real propagation data — not formulas — for FR1, FR2,
   V-band, sub-THz and THz carriers.
2. **JupyterLab notebook environment.** The full upstream Sionna RT,
   PHY, and SYS notebook collection ships in the image (~40 notebooks)
   so a researcher can pivot from the UI into custom workflows: neural
   receivers, LDPC vs. polar coding, MIMO/OFDM detection, link-level
   simulations driven by RT channels, end-to-end PHY abstraction,
   scheduling and power control.

Everything runs **locally on the GPU**. There are no physical radios,
no cloud calls, and no API keys — the ray tracing, the LDPC decoder,
and the neural-receiver training are all pulled through the same CUDA
device.

### The 3D digital twin (the UI)

The browser UI is a four-panel grid:

| Panel | What it shows |
|---|---|
| **01 — 3D Digital Twin** | Three.js render of the loaded Mitsuba scene, materially coloured (marble, metal, concrete, brick, wood, glass), with TX/RX gizmos you can click, drag, move, or delete. |
| **02 — Radio Coverage** | PNG path-gain heatmap (jet colormap, dB), produced by `RadioMapSolver` at the cell size and ray-bounce depth you choose. |
| **03 — Path Analysis** | Per-path table from `PathSolver`: classification (LoS / reflected / diffracted / scattered / refracted), number of interactions, propagation delay (ns), and per-path gain (dB). |
| **04 — Link Budget** | Real link budget derived from Sionna's path-gain output: configurable carrier (3.5/28/60/140/300 GHz), TX power, antenna gains, bandwidth, noise figure → EIRP, RX power, SNR, kTB noise floor, Shannon capacity. |

You can save and reload named "tower configurations" (scene + device
positions + link parameters) — the JSON files live in a Docker volume
under `/app/data/configs`.

### The notebook side

JupyterLab is mounted on the same container at
`/sionna/notebooks/lab` (proxied through the FastAPI server) and
`/notebooks/01_getting_started.ipynb` is a guided tour of the same
APIs the UI calls. Beyond that, three full notebook collections from
upstream Sionna are bundled:

- **`notebooks/rt/`** — Sionna RT tutorials: scene editing,
  diffraction, scattering, mobility, radio maps.
- **`notebooks/phy/`** — Sionna PHY: 5G NR PUSCH, polar vs. LDPC,
  OFDM/MIMO detection, neural receiver training, autoencoders, the
  full Sionna tutorial parts 1–4, link-level simulation with RT
  channels.
- **`notebooks/sys/`** — Sionna SYS: hexagonal grids, link adaptation,
  scheduling, power control, PHY abstraction, "SYS meets RT".

---

## Capabilities (at a glance)

- 6G network digital twin — Mitsuba 3 scene + Sionna RT ray tracer.
- Six bundled scenes: `munich`, `etoile`, `simple_street_canyon`,
  `simple_wedge`, `box`, `floor_wall`.
- Live GPU ray-traced coverage maps (`RadioMapSolver`) and per-path
  ray traces (`PathSolver`) computed on demand from the browser.
- Full channel analysis from real ray data: power-weighted RMS delay
  spread, mean excess delay, coherence bandwidth, total path gain,
  strongest path, FSPL reference at 3.5 GHz.
- Link budget calculator for FR1 / FR2 / V-band / sub-THz / THz.
- Click-to-place / move / delete TX and RX devices in the 3D viewer.
- Save / load / delete named tower configurations (persisted to a
  Docker volume).
- JupyterLab with the full Sionna stack and ~40 bundled tutorial
  notebooks (RT, PHY, SYS).
- LLVM-JIT pre-warmed at startup so the first user click isn't a
  60-second wait.
- Optional Caddy reverse proxy with HTTPS.

---

## Reference build platform

This demo was built and tested on a **Dell Pro Max GB10** (NVIDIA
Grace Blackwell, **ARM / aarch64** architecture, compute capability
`sm_121`). A few aarch64-specific decisions are baked into the build:

- **Dr.Jit and Mitsuba 3 are compiled from source** — there are no
  prebuilt aarch64 wheels for the version pair (`drjit==1.2.0`,
  `mitsuba==3.7.1`) that Sionna RT 1.2.1 needs. The first build
  takes 30–60 minutes.
- **OptiX is disabled** (`-DDRJIT_ENABLE_OPTIX=OFF`). OptiX doesn't
  support `sm_121` yet, so Sionna RT runs through the LLVM JIT
  variants (`scalar_rgb`, `llvm_ad_mono_polarized`, `llvm_ad_rgb`).
  This is also why `DRJIT_LIBLLVM_PATH` is pinned to the aarch64
  LLVM-14 shared library.
- The Dr.Jit and Mitsuba `CMakeLists.txt` files have a hard-coded
  `-march=ivybridge` flag that the Dockerfile patches to
  `-march=native` so the build doesn't fail on aarch64.

It will run on x86_64 NVIDIA Linux hosts too, but you'll need to
override `CMAKE_CUDA_ARCHITECTURES` and `DRJIT_LIBLLVM_PATH` for your
hardware (see Configuration).

---

## Requirements

| Requirement | Minimum | Notes |
|---|---|---|
| OS | Linux | macOS / Windows lack pass-through GPU support — won't work. |
| Docker | 24.x or newer | With Compose **v2** (`docker compose`, not `docker-compose`). |
| GPU | NVIDIA, ≥ 8 GB VRAM | Sionna RT is JIT-compiled; coverage maps on big scenes are memory-hungry. |
| GPU driver | Recent enough for your CUDA version | `nvidia-smi` must work on the host. |
| NVIDIA Container Toolkit | Installed and configured for Docker | Required to expose the GPU to the container. |
| Disk | ~10 GB | Image is large — CUDA devel base + compiled Dr.Jit/Mitsuba/Sionna + JupyterLab + bundled notebooks. |
| RAM | 16 GB recommended | Compose limits the container to 8 GB by default; raise it for larger scenes. |
| Build time | 30–60 min first build | Dr.Jit + Mitsuba 3 compile from source on aarch64. |
| API key | None | Everything runs locally. |

---

## Installation (step-by-step)

These instructions assume a fresh Linux box. If you already have
Docker + the NVIDIA Container Toolkit working, skip to step 4.

### 1. Verify your GPU is visible to the host

```bash
nvidia-smi
```

You should see a table with your GPU model, driver version, and CUDA
version. If this command fails, **fix your NVIDIA driver before going
further** — the rest will not work.

### 2. Install Docker Engine + Compose v2

Ubuntu / Debian:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # let your user run docker without sudo
newgrp docker                      # apply the new group in this shell
docker compose version             # should print "Docker Compose version v2.x.x"
```

If `docker compose version` reports "command not found", install the
plugin:

```bash
sudo apt install docker-compose-plugin
```

### 3. Install the NVIDIA Container Toolkit

Ubuntu / Debian:

```bash
distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verify it works inside Docker:

```bash
docker run --rm --gpus all nvidia/cuda:13.0.0-base-ubuntu22.04 nvidia-smi
```

You should see the same `nvidia-smi` table you saw on the host. If
this fails, fix it before continuing.

### 4. Clone the repo

```bash
git clone https://github.com/gleaven/sionna.git
cd sionna
```

### 5. Create the environment file

```bash
cp .env.example .env
```

The defaults are sensible. You only need to edit `.env` to change
ports or to point Caddy at a real hostname.

### 6. Build and start

```bash
docker compose up -d --build
```

The first build downloads the CUDA 13.0 devel base image (~3 GB) and
then **compiles Dr.Jit and Mitsuba 3 from source** — budget
**30–60 minutes** the first time. To watch progress, use:

```bash
docker buildx build --progress=plain .
```

Subsequent starts of an already-built image take ~10 seconds plus the
Sionna warm-up.

### 7. Verify it's healthy

```bash
docker compose ps
# demo-sionna should show "healthy" within ~2 min (startup grace = 120s)

curl -s http://localhost:8080/health | python3 -m json.tool
```

Expected output once Sionna has finished initialising:

```json
{
  "status": "ok",
  "sionna_ready": true,
  "scene_loaded": true,
  "scene_name": "munich"
}
```

The startup sequence in the logs should look like:

```
Initializing Sionna RT...
Mitsuba variant: llvm_ad_mono_polarized
Munich scene loaded: <N> objects
Sionna RT ready.
Cached munich mesh: <verts>, <faces>, <KB>
Warming up LLVM JIT (first-run kernel compilation)...
Coverage JIT warm-up: <s>s
Paths JIT warm-up: <s>s
JIT warm-up complete — subsequent calls will be fast.
```

The JIT warm-up at startup is intentional: the first call to
`RadioMapSolver` and `PathSolver` compiles LLVM kernels (~30–60 s) and
caches them, so the first user click in the browser feels instant.

### 8. Open the UIs

- **6G Digital Twin (3D + coverage + link budget):**
  <http://localhost:8080/>
- **JupyterLab notebooks:** <http://localhost:8080/notebooks/> (proxied
  through the FastAPI server) **or** <http://localhost:8888/sionna/notebooks/lab>
  (direct).

### 9. (Optional) Tail the logs

```bash
docker compose logs -f sionna
```

You'll see one line per coverage / path computation with timing
breakdowns (solver, materialise, render).

---

## Configuration

All variables can be set in `.env` or exported in your shell.

| Variable | Default | What it controls |
|---|---|---|
| `APP_PORT` | `8080` | Browser-facing port for the FastAPI UI, REST, WebSocket, and the `/notebooks/` proxy. |
| `JUPYTER_PORT` | `8888` | Direct host port for JupyterLab (also reachable through the proxy on `APP_PORT`). |
| `DEMO_HOSTNAME` | `localhost` | Hostname Caddy serves under (proxy profile only). |
| `HTTP_PORT` | `8081` | Caddy HTTP port. |
| `HTTPS_PORT` | `8443` | Caddy HTTPS port. |

### Container-level settings (in `docker-compose.yml`)

| Setting | Default | Notes |
|---|---|---|
| `mem_limit` | `8G` | Hard memory ceiling. Bump for large scenes / fine cell sizes. |
| `DRJIT_LIBLLVM_PATH` | `/usr/lib/aarch64-linux-gnu/libLLVM-14.so` | LLVM shared library Dr.Jit dlopens. Override for x86_64 (`/usr/lib/x86_64-linux-gnu/libLLVM-14.so`). |
| `DRJIT_NTHREADS` | `1` | Single-thread JIT — keeps Sionna deterministic and avoids thread contention with the GPU. Raise if you have CPU cores to spare and a CPU-bound workload. |
| `NVIDIA_VISIBLE_DEVICES` | `all` | Standard NVIDIA Container Toolkit GPU passthrough. |

### Build-time arguments

| Argument | Default | Notes |
|---|---|---|
| `CUDA_VERSION` | `13.0.0` | Base image tag. |
| `CMAKE_CUDA_ARCHITECTURES` | `121` (in the `pip3 install` step) | Compute capability for Dr.Jit's CUDA backend. Edit the `Dockerfile` for non-GB10 GPUs (e.g. `86` for RTX 30xx, `89` for RTX 40xx, `90` for H100). |

The default scene is `munich` with TX at `[8.5, 21.0, 27.0]` and RX at
`[45.0, 90.0, 1.5]`. Switch scenes from the UI dropdown or with
`POST /api/scene/{name}`.

---

## Live controls (in the browser)

Header bar:

- **Scene selector** — `MUNICH`, `ETOILE`, `STREET CANYON` (the
  remaining bundled scenes — `simple_wedge`, `box`, `floor_wall` —
  are reachable via the API but not exposed in the dropdown by
  default).
- **Depth** — `max_depth` for both ray solvers (1, 2, 3, 5, 8). Higher
  depth = more reflections / diffractions = slower compute.
- **+ TX / + RX** — enter placement mode, then click on the 3D mesh
  to drop a device.
- **COMPUTE** — runs `RadioMapSolver` and `PathSolver` together and
  fills panels 02–04.
- **SAVE / CONFIGS** — name the current scene + device layout + link
  parameters; reload it later. Stored as JSON in `sionna-data` volume.
- **NOTEBOOKS** — opens JupyterLab in a new tab.

Sidebar (when a device is selected):

- Edit X / Y / Z directly, or click **MOVE** to drag interactively.
- **DELETE** — remove the device.
- **RECOMPUTE** — re-run the full compute pipeline.

Link Budget panel (panel 04):

- Frequency presets: FR1 (3.5 GHz / 100 MHz), FR2 (28 GHz / 400 MHz),
  V-Band (60 GHz / 2.16 GHz), Sub-THz (140 GHz / 10 GHz), THz
  (300 GHz / 20 GHz). Each preset preloads bandwidth and noise
  figure; all values stay editable.
- Editable: TX power (dBm), TX/RX antenna gain (dBi), bandwidth (MHz),
  receiver noise figure (dB).
- All derived numbers (EIRP, RX power, SNR, noise floor, Shannon
  capacity) recompute live from the **last `PathSolver` output** — no
  formulas substituted for missing data.

All of these controls are also REST endpoints — see "Architecture" for
the file map. Open DevTools → Network to watch them fire.

---

## Bundled notebooks

`/app/notebooks/` mounts into JupyterLab. The top-level
`01_getting_started.ipynb` is a hand-written guided tour of the same
APIs the UI uses (load scene → place TX/RX → `PathSolver` →
`RadioMapSolver` → derive RMS delay spread + coherence bandwidth).
Beyond that, three full upstream-Sionna collections are included:

| Path | Topic | A few highlights |
|---|---|---|
| `notebooks/rt/` | Sionna RT — ray tracing | `Introduction`, `Diffraction`, `Scattering`, `Mobility`, `Radio-Maps`, `Scene-Edit`. |
| `notebooks/phy/` | Sionna PHY — physical layer | `5G_NR_PUSCH`, `5G_Channel_Coding_Polar_vs_LDPC_Codes`, `Neural_Receiver`, `MIMO_OFDM_Transmissions_over_CDL`, `OFDM_MIMO_Detection`, `Realistic_Multiuser_MIMO_Simulations`, `Autoencoder`, `Bit_Interleaved_Coded_Modulation`, `CIR_Dataset`, `DeepMIMO`, `Evolution_of_FEC`, `Link_Level_Simulations_with_RT`, `Sionna_tutorial_part1`–`part4`. |
| `notebooks/sys/` | Sionna SYS — system-level | `HexagonalGrid`, `LinkAdaptation`, `PHY_Abstraction`, `Power_Control`, `Scheduling`, `End-to-End_Example`, `SYS_Meets_RT`. |

These are vendored from the upstream Sionna distribution and run
unchanged inside the container.

---

## External services (BYO)

This demo has no external dependencies — there is nothing to BYO. The
override file exists only for consistency with the rest of the
`demo_center` repo:

```bash
docker compose -f docker-compose.yml -f docker-compose.byo.yml up -d
```

`docker-compose.byo.yml` is intentionally empty (`services: {}`).

---

## Optional HTTPS reverse proxy

A Caddy sidecar is bundled as an opt-in profile. It auto-provisions
Let's Encrypt certs when `DEMO_HOSTNAME` is a real DNS name pointing
at this host:

```bash
DEMO_HOSTNAME=sionna.example.com docker compose --profile proxy up -d
```

For local testing keep `DEMO_HOSTNAME=localhost` and Caddy will issue
a self-signed cert.

The bundled `Caddyfile` only proxies the FastAPI app on port 8080.
The FastAPI server already proxies `/notebooks/*` (HTTP and
WebSocket) through to JupyterLab on 8888, so JupyterLab is reachable
behind Caddy without any extra config — JupyterLab's
`base_url=/sionna/notebooks` is wired to match.

---

## Authentication

Both the FastAPI server **and the bundled JupyterLab instance run
with no authentication** by default. JupyterLab is launched with
`--ServerApp.token=''` and `--ServerApp.password=''` in `start.sh`
(it's intended to live behind an upstream auth layer like Authentik
in the original deployment).

**Do not expose these ports to the public internet without an auth
layer** — JupyterLab is effectively remote code execution for anyone
who can reach it. Recommended:

- **Caddy basic auth** — add a `basic_auth` block to `Caddyfile`.
- **oauth2-proxy in front of Caddy** — for SSO across multiple users.
- **Bind host ports to `127.0.0.1`** — easiest single-user lockdown:
  edit `docker-compose.yml` and change `"${APP_PORT:-8080}:8080"` to
  `"127.0.0.1:${APP_PORT:-8080}:8080"` (and the same for
  `JUPYTER_PORT`).
- **Cloudflare Tunnel + Access policies** — easiest if you're already
  on Cloudflare.

---

## Architecture (file map)

| File | Purpose |
|---|---|
| `server.py` | FastAPI app: scene management, `RadioMapSolver` / `PathSolver` wrappers, GLB mesh export, channel analysis, device CRUD, configs CRUD, JupyterLab HTTP+WebSocket reverse proxy. |
| `start.sh` | Launches JupyterLab in the background (no token, base URL `/sionna/notebooks`), then `exec`s the FastAPI server in the foreground. |
| `static/index.html` | 4-panel UI shell (3D twin / coverage / paths / link budget). |
| `static/js/twin-viewer.js` | Three.js scene + GLB loader + click-to-place/move device handling. |
| `static/js/coverage.js` | Coverage map rendering. |
| `static/js/path-analysis.js` | Per-path table, classification, channel-analysis summary. |
| `static/js/link-budget.js` | Frequency presets, link-budget math driven by Sionna's `total_path_gain_db`. |
| `static/css/sionna.css` | Cyber-grid styling for the 4-panel UI. |
| `notebooks/01_getting_started.ipynb` | Hand-written tour of `load_scene` → `PathSolver` → `RadioMapSolver` → channel analysis. |
| `notebooks/{rt,phy,sys}/` | Vendored upstream Sionna tutorial notebooks. |
| `Dockerfile` | CUDA 13.0 devel base, compiles Dr.Jit 1.2.0 + Mitsuba 3.7.1 from source for aarch64, installs Sionna RT 1.2.1, FastAPI, JupyterLab. |
| `docker-compose.yml` | Single `sionna` service + optional `caddy` proxy profile + `sionna-data` volume for saved configs. |
| `docker-compose.byo.yml` | Empty (no shared services to swap out). |
| `Caddyfile` | Tiny reverse-proxy config for the optional HTTPS profile. |

### Key REST endpoints

| Method + path | Purpose |
|---|---|
| `GET /health` | Liveness + Sionna ready / scene loaded. |
| `GET /api/scenes` | List built-in scenes + active. |
| `POST /api/scene/{name}` | Switch scene (recompiles JIT, rebuilds mesh cache). |
| `GET /api/scene/geometry` | TX/RX positions for the 3D viewer. |
| `GET /api/scene/mesh` | Cached GLB of the current scene. |
| `GET / POST / DELETE /api/devices[/{name}[/position]]` | List / add / move / remove TX or RX. |
| `POST /api/coverage` | `RadioMapSolver` → PNG path-gain heatmap. |
| `POST /api/paths` | `PathSolver` → JSON path list + channel analysis. |
| `POST /api/compute` | Both of the above in one call (matplotlib-rendered coverage). |
| `GET / POST / DELETE /api/configs[/{name}[/load]]` | Saved tower configurations. |
| `* /notebooks/*` | HTTP + WebSocket reverse proxy to JupyterLab. |

---

## Troubleshooting

- **First build very slow** — Mitsuba 3 + Dr.Jit are compiled from
  source for aarch64. **30–60 minutes is normal.** Use
  `docker buildx build --progress=plain .` to see which step is
  running.
- **`drjit` errors about LLVM at startup** — the build pins
  `DRJIT_LIBLLVM_PATH=/usr/lib/aarch64-linux-gnu/libLLVM-14.so`. On
  x86_64, override with
  `-e DRJIT_LIBLLVM_PATH=/usr/lib/x86_64-linux-gnu/libLLVM-14.so` (and
  install `libllvm14` in the Dockerfile if it isn't already present).
- **Sionna init hangs at startup** — `_init_sionna()` runs in a
  background thread and the first scene load + JIT warm-up takes
  ~30–60 s on a cold container. The healthcheck has a 120 s
  `start_period` for exactly this reason. If it stays "starting" past
  ~3 min, check `docker compose logs sionna` for stack traces.
- **First click in the UI is slow but later clicks are fast** —
  expected: LLVM kernels are JIT-compiled per `(scene, max_depth)`
  combo. The startup warm-up handles the default (`munich`, depth 1);
  switching scenes or jumping to depth 8 triggers a fresh compile.
- **Coverage map slow / OOM on big scenes** — the compose limit is
  8 GB. Lower `cell_size` (the UI sends 5 m by default) or raise
  `mem_limit` in `docker-compose.yml`.
- **`OptiX not available` in logs** — intentional: OptiX doesn't
  support `sm_121` (GB10 Blackwell) yet, so the build disables it.
  Sionna RT runs on the LLVM-only Mitsuba variants. No action needed.
- **`unsupported gpu architecture` during the Dr.Jit pip install** —
  your GPU's compute capability isn't `121`. Edit the
  `CMAKE_CUDA_ARCHITECTURES=121` value in the Dockerfile to match
  your hardware (e.g. `86` for RTX 30xx, `89` for RTX 40xx, `90` for
  H100) and rebuild.
- **Healthcheck failing immediately after `docker compose up`** —
  give it longer; the check tolerates a 120 s start period. The
  health endpoint comes up before Sionna does, so a 200 OK with
  `sionna_ready: false` is normal during the warm-up window.
- **Browser tab is laggy** — the Three.js viewer is GPU-bound on the
  *client* side; close other heavy tabs.
- **Saved configs disappear after `docker compose down -v`** — `-v`
  removes the `sionna-data` named volume. Drop the `-v` to keep them.
- **`/notebooks/` returns 404 from behind Caddy** — the FastAPI proxy
  strips the `Origin` header before forwarding to JupyterLab so
  `check_origin()` doesn't reject external requests; if you've put
  another proxy in front of Caddy that re-injects an external Origin,
  you may need to configure Jupyter's `allow_origin` differently.

---

## FAQ

**Q: Can I use a CPU?** No. Dr.Jit and Mitsuba can technically run on
CPU, but coverage / path solves on real urban scenes are too slow to
be interactive without GPU acceleration.

**Q: Why no token on Jupyter?** This image was originally built to
sit behind Authentik. For any other deployment, put auth in front
(see the Authentication section).

**Q: Are the bundled notebooks modified?** The `rt/`, `phy/`, and
`sys/` subtrees are vendored upstream Sionna tutorials and run
unchanged. Only `01_getting_started.ipynb` is hand-written for this
demo.

**Q: Can I add my own Mitsuba scene?** Yes — load it directly in a
notebook with `rt.load_scene("/path/to/scene.xml")`. The UI dropdown
is hard-wired to the built-in scenes, so adding one to the dropdown
also requires editing `BUILT_IN_SCENES` in `server.py` and the
`<select>` in `static/index.html`.

**Q: Does the LDPC decoder really run on the GPU?** Yes — Sionna PHY's
GPU LDPC implementation is what the polar-vs-LDPC notebook
benchmarks. The advertised ~6× speedup is upstream Sionna's, not
something this demo measures.

---

## Credits

Built by Andrew Meinecke. Wraps NVIDIA's open-source Sionna and Sionna
RT (<https://nvlabs.github.io/sionna/>) — the upstream project does
all of the actual ray tracing, link-level, and system-level
simulation; this demo just packages it for one-command local use with
a 3D UI.
