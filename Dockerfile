# One image, one origin: the API also serves the built frontend, so there is no
# CORS to configure and the session cookie behaves the way it does locally.

FROM node:20-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


FROM python:3.11-slim
WORKDIR /srv

# Build deps for numpy/scipy wheels are not needed on slim + manylinux, but
# curl is useful for the container health check.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt "gunicorn==23.0.0"

COPY backend/ ./
COPY --from=web /web/dist ./frontend_dist

# Nothing durable is kept on this filesystem, because the host throws it away on
# every deploy. Case files go to object storage (STORAGE_BACKEND=s3) and the
# database is a managed Postgres, both supplied by the environment.
#
# STORAGE_LOCAL_ROOT still has a job under S3: it is where the converted A3DM
# meshes and the articulation results are cached. Those are derived from the
# stored STLs, so losing them costs one slow first view, not data.
ENV FRONTEND_DIST=/srv/frontend_dist \
    STORAGE_LOCAL_ROOT=/tmp/align-cache \
    ENVIRONMENT=production \
    COOKIE_SECURE=true \
    PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://localhost:${PORT}/api/health || exit 1

# One worker: 512 MB of RAM does not hold two copies of numpy, scipy and a mesh
# being converted, and the travel cache is per-process anyway. migrate_dev only
# patches an existing SQLite dev database; on Postgres it exits straight away.
CMD ["sh", "-c", "python migrate_dev.py && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
