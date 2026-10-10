# Panel Reader, reading-only: build the web app, then run the API (which serves it) without the panel
# model (MAGI=off) and without model keys. New comics are added from a machine with Magi installed.

FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /bin/uv
WORKDIR /app/api
COPY api/pyproject.toml api/uv.lock ./
RUN uv sync --frozen --no-dev --no-group magi --no-install-project
COPY api/ ./
RUN uv sync --frozen --no-dev --no-group magi
COPY --from=web /web/dist /app/web/dist
ENV MAGI=off PYTHONUNBUFFERED=1
CMD ["sh", "-c", "exec .venv/bin/uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
