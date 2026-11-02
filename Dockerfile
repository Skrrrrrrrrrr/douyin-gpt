# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS frontend
WORKDIR /build/web/cult
COPY web/cult/package.json web/cult/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/cult/ ./
COPY web/connection.js web/connection.d.ts ../
RUN npm run build

FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.166.0
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    DISPLAY=:99 \
    HOME=/home/node \
    DOUYIN_GPT_HOME=/data \
    CODEX_HOME=/data/codex \
    DOUYIN_BROWSER=/app/docker/chromium.sh \
    IMAGEIO_FFMPEG_EXE=/usr/bin/ffmpeg \
    PATH=/opt/venv/bin:$PATH
# The slim base has no OS CA bundle yet. Bootstrap HTTPS with Node's bundled
# trusted roots; apt then installs and maintains Debian's ca-certificates package.
RUN node -e 'const fs=require("node:fs");fs.mkdirSync("/etc/ssl/certs",{recursive:true});fs.writeFileSync("/etc/ssl/certs/ca-certificates.crt",require("node:tls").rootCertificates.join("\n"));'
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    ca-certificates chromium ffmpeg fonts-noto-cjk gosu novnc openbox procps \
    python3 python3-venv tini websockify x11-utils x11vnc xvfb \
    && mkdir -p /System/Library/Fonts /data /home/node \
    && ln -s /usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc '/System/Library/Fonts/STHeiti Medium.ttc' \
    && ln -s /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc '/System/Library/Fonts/STHeiti Light.ttc' \
    && chown node:node /data /home/node
WORKDIR /app
COPY package.json package-lock.json requirements-video.txt ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm install --global --no-audit --no-fund @openai/codex@${CODEX_VERSION} \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements-video.txt
COPY *.md config.example.json official.example.json ./
COPY assets/ ./assets/
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY vendor/ ./vendor/
COPY web/ ./web/
COPY docker/ ./docker/
COPY --from=frontend /build/web/cult/dist/index.html ./web/index.html
RUN chmod 755 docker/*.sh && node --check docker/runner.mjs && node --check docker/import.mjs
EXPOSE 3147 6080
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node docker/healthcheck.mjs
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "docker/runner.mjs"]
