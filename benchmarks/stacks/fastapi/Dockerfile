# syntax=docker/dockerfile:1
# FastAPI benchmark service. Build context: this folder.
#   docker build -t qsbench-fastapi benchmarks/stacks/fastapi

# 1. Install the pinned dependencies (all have prebuilt wheels) into a virtual environment and precompile bytecode.
FROM python:3.13.15-slim-trixie AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
COPY requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install --no-deps --only-binary=:all: -r /tmp/requirements.txt \
 && /opt/venv/bin/pip uninstall -q -y pip
COPY app /srv/app
RUN /opt/venv/bin/python -m compileall -q /opt/venv/lib /srv/app

# 2. Runtime: the same slim base with the virtual environment and the application only.
FROM python:3.13.15-slim-trixie
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    UPLOAD_DIR=/data/uploads \
    WEB_CONCURRENCY=2
COPY --from=build /opt/venv /opt/venv
COPY --from=build /srv/app /srv/app
RUN useradd --system --uid 10001 app && mkdir -p /data/uploads && chown -R app:app /data
USER app
WORKDIR /srv
EXPOSE 8080
# Two uvicorn worker processes (one per CPU), uvloop and httptools. DB_POOL_SIZE is split between the workers.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"${PORT}\" --workers \"${WEB_CONCURRENCY}\" --loop uvloop --http httptools --timeout-graceful-shutdown 5"]
