# Install dependencies in a separate stage so build-only files stay out of the runtime image.
FROM python:3.11-slim-bookworm AS builder
WORKDIR /build
COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Start a clean runtime stage and install only the packages from the builder.
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

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]