#!/bin/bash
# Start Jupyter Lab and FastAPI server side by side.
# Jupyter runs on :8888, FastAPI on :8080 (proxies /notebooks/* to Jupyter).

# Launch Jupyter in the background — no token/password (behind Authentik auth)
jupyter lab \
    --ip=0.0.0.0 \
    --port=8888 \
    --no-browser \
    --allow-root \
    --ServerApp.token='' \
    --ServerApp.password='' \
    --ServerApp.base_url='/notebooks' \
    --ServerApp.disable_check_xsrf=True \
    --ServerApp.allow_origin='*' \
    --notebook-dir=/app/notebooks \
    &

# Start FastAPI server (foreground — container lifecycle tied to this)
exec python3 /app/server.py
