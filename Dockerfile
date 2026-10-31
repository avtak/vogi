# Vogi on a Hugging Face Space (Docker SDK). Secrets: MODEL_API_KEY, VOGI_ACCESS_CODE.
FROM python:3.13-slim
RUN pip install --no-cache-dir uv
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY vogi ./vogi
COPY eval ./eval
RUN uv sync --frozen --no-dev
ENV VOGI_HOST=0.0.0.0 VOGI_PORT=7860 VOGI_ENV_FILE=/dev/null
EXPOSE 7860
CMD ["/app/.venv/bin/vogi"]
