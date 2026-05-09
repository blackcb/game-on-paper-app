# Stage 1: build dependencies into an isolated venv.
# `python:3.14-slim` (~120 MB) is a Debian-slim base with the
# Python runtime but no compiler toolchain or dev headers.
FROM python:3.14-slim AS pybuilder

# Compiler toolchain only needed at build time. Some wheels (lxml,
# pydantic-core fallbacks, etc.) may compile from source on amd64.
# Stripped from the runtime image via the multi-stage copy below.
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY requirements.txt .

# Isolated venv keeps the runtime image free of /usr/local/lib
# Python clutter from the build base.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# `xgboost-cpu` and `xgboost` share the `xgboost/` Python module
# directory but install as separate packages on PyPI. sportsdataverse
# pins `xgboost`, which forces pip to install the GPU-capable build
# (~330 MB) and pulls `nvidia-nccl-cu12` (~300 MB) as a runtime dep.
# Both are dead weight on a CPU-only Cloudflare Container.
#
# Uninstall the GPU build + the orphaned NCCL package, then force-
# reinstall xgboost-cpu to repopulate the xgboost/ module files.
# Snapshot tests in python/tests/test_process_snapshot.py verify that
# CPU-only predictions match the GPU build's output.
RUN pip uninstall -y xgboost nvidia-nccl-cu12 && \
    pip install --no-cache-dir --force-reinstall --no-deps xgboost-cpu==2.1.4

# Strip ahead-of-time bytecode caches and bundled tests from the
# installed packages. pandas/scipy/numpy ship test suites that we
# never run in production but that pad the image by tens of MB.
RUN find /opt/venv -depth -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/venv -depth -name tests -type d -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/venv -depth -name "*.pyc" -delete && \
    find /opt/venv -depth -name "*.pyo" -delete

# Stage 2: runtime image. Just the slim base + the prepared venv +
# our source. No compiler toolchain, no pip cache, no source tree.
FROM python:3.14-slim
WORKDIR /code

# `python:3.14-slim` (bookworm-slim) doesn't ship `curl`, but the
# droplet's docker-compose healthcheck (docker-compose.fork.yml)
# is `curl --fail http://python:7000/healthcheck` executed inside
# this container. Without curl the healthcheck fails as
# command-not-found, the container never reports healthy, and
# `node`'s `service_healthy: python` dependency aborts the deploy.
# Pre-slim Dockerfile used `python:3.14` (full), which had curl
# baked in; this restores that contract at ~3 MB cost. Goes away
# in Phase 3E once fork-deploy.yml is archived.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Copy the venv directly. PATH points at it so `gunicorn` resolves.
COPY --from=pybuilder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Whitelisted source copy — `.dockerignore` excludes tests/, .venv,
# scripts/, __pycache__, etc., but listing files explicitly keeps
# the runtime image deterministic regardless of directory state.
COPY app.py schemas.py flask_logs.py ./

# Production WSGI server. Two gthread workers, 8 threads each.
# - Worker count: the python container has a 4 GB memory cap; pandas
#   pipelines on a single big game can spike to 1+ GB transient
#   memory, so 2 workers keeps headroom for one outlier without OOM.
# - gthread + 8 threads per worker: Flask handlers spend most of their
#   wall time waiting on ESPN's CDN and the XGBoost predict calls
#   (which release the GIL); thread-per-request handles concurrency
#   well without paying for additional fork copies of the loaded
#   models.
# - 120s timeout: cold game-page processing can run 5-6s on the
#   slowest games; 120s is well above the long tail without masking
#   genuine hangs.
# - --preload: load app:app in the gunicorn master before fork()ing
#   workers. Combined with _warmup_models() at app-import in app.py,
#   this moves sportsdataverse + xgboost + booster loads from
#   per-worker first-request cost (the bulk of the 14-19s cold-start
#   tail measured in 3A.7) into one-shot startup cost. Workers
#   inherit the loaded models via copy-on-write, so the first user
#   request after a Cloudflare-Container resume hits an
#   already-warm interpreter. Cloudflare doesn't route requests
#   until ports are listening, so the user-visible cold-start
#   collapses to roughly the gunicorn boot time.
CMD ["gunicorn", "-w", "2", "-k", "gthread", "--threads", "8", "--timeout", "120", "--preload", "-b", "0.0.0.0:7000", "app:app"]
