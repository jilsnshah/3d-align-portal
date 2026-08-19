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

# Case files, the mesh cache and the database live on a mounted volume, so a
# redeploy does not take the uploads with it.
ENV FRONTEND_DIST=/srv/frontend_dist \
    STORAGE_LOCAL_ROOT=/data/storage \
    DATABASE_URL=sqlite:////data/align.db \
    ENVIRONMENT=production \
    COOKIE_SECURE=true \
    PORT=8000

VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://localhost:${PORT}/api/health || exit 1

# One worker: SQLite takes a single writer, and the travel cache is per-process.
CMD ["sh", "-c", "python migrate_dev.py && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
