ARG CUDA_VERSION=13.0.0
FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV DRJIT_LIBLLVM_PATH=/usr/lib/aarch64-linux-gnu/libLLVM-14.so

# ============================================================
# System dependencies
# ============================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    cmake ninja-build git \
    llvm-14-dev libllvm14 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# ============================================================
# Build Dr.Jit 1.2.0 from source for aarch64
#   - Fix x86-only -march=ivybridge flag in cmake-defaults
#   - Disable OptiX (not supported on GB10 sm_121)
# ============================================================
RUN git clone --recursive --branch v1.2.0 --depth 1 \
        https://github.com/mitsuba-renderer/drjit.git /build/drjit \
    && cd /build/drjit \
    && sed -i 's/-march=ivybridge/-march=native/g' \
        ext/drjit-core/ext/nanothread/ext/cmake-defaults/CMakeLists.txt \
    && CMAKE_ARGS="-DCMAKE_CUDA_ARCHITECTURES=121 -DDRJIT_ENABLE_OPTIX=OFF" \
        pip3 install --no-cache-dir . \
    && rm -rf /build/drjit

# ============================================================
# Build Mitsuba 3.7.1 from source for aarch64
#   - LLVM-only variants (no CUDA/OptiX ray tracing)
#   - llvm_ad_mono_polarized = what sionna-rt requires
# ============================================================
RUN pip3 install --no-cache-dir \
        scikit-build-core "nanobind==2.9.2" "typing_extensions>=4.12" \
        hatch-fancy-pypi-readme \
    && git clone --recursive --branch v3.7.1 --depth 1 \
        https://github.com/mitsuba-renderer/mitsuba3.git /build/mitsuba \
    && cd /build/mitsuba \
    && find . -name "CMakeLists.txt" -exec grep -l "ivybridge" {} \; \
        | xargs sed -i 's/-march=ivybridge/-march=native/g' \
    && CMAKE_ARGS="-DMI_DEFAULT_VARIANTS=scalar_rgb,llvm_ad_mono_polarized,llvm_ad_rgb" \
        pip3 install --no-cache-dir --no-build-isolation . \
    && rm -rf /build/mitsuba

# ============================================================
# Install Sionna RT 1.2.1 (version-matched to drjit/mitsuba)
# ============================================================
RUN pip3 install --no-cache-dir sionna-rt --no-deps \
    && pip3 install --no-cache-dir \
        pythreejs importlib_resources numpy scipy matplotlib pillow

# ============================================================
# FastAPI server + dependencies
# ============================================================
RUN pip3 install --no-cache-dir \
        fastapi uvicorn[standard] websockets httpx trimesh

# ============================================================
# Jupyter Lab for advanced / notebook-based research
# ============================================================
RUN pip3 install --no-cache-dir jupyterlab ipywidgets

WORKDIR /app
COPY server.py /app/
COPY static/ /app/static/
COPY notebooks/ /app/notebooks/
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8080 8888

CMD ["/app/start.sh"]
