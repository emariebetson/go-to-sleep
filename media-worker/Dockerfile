FROM python:3.13.7-slim@sha256:3d1b9d735e23f45f166f508d1a4ca91d33e7f29d92cc4f6ccb2c5a9a3076ac05
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg=7:5.1.8-0+deb12u1 && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 worker && mkdir -p /work/input /work/output && chown -R worker:worker /work
WORKDIR /app
COPY --chown=worker:worker worker.py /app/worker.py
USER 10001
ENTRYPOINT ["python", "/app/worker.py"]
