FROM python:3.11-slim-bookworm AS builder
WORKDIR /build
COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.11-slim-bookworm

WORKDIR /app
COPY --from=builder /install /usr/local

# Create a non-root app user and give it permission to write the SQLite volume.
RUN groupadd --gid 65532 app \
	&& useradd --uid 65532 --gid app --no-create-home --shell /usr/sbin/nologin app \
	&& mkdir -p /data \
	&& chown app:app /data

COPY --chown=app:app app ./app
USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
	CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/ready')"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]