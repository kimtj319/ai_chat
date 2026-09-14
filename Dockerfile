# Ubuntu-based runtime image for qwen-web.
#
# The app and its dependencies are baked in, so the container needs no network
# access at run time — only the vLLM endpoints it talks to. Conversation data
# and logs live on mounted volumes so they survive a container replacement.
#
#   docker build --platform linux/amd64 -t qwen-web:1.0 .
#   docker save qwen-web:1.0 | gzip > qwen-web-image.tar.gz
#
# Platform pinned in FROM so the image is linux/amd64 regardless of the
# machine doing the build (this Mac is arm64; the target server is x86_64).
FROM --platform=linux/amd64 ubuntu:24.04

# start_web.sh requires: bash (base image), node, npm, curl.
# Ubuntu 24.04's apt ships Node 18; this app is verified on 22, so pull 22
# from NodeSource rather than using the distro package.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        tzdata && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Seoul
WORKDIR /app

# Dependencies first: this layer is rebuilt only when the lockfile changes,
# so ordinary source edits do not trigger a full reinstall.
COPY package.json package-lock.json ./
RUN npm ci

# Application: prebuilt output plus the sources, so start_web.sh can rebuild
# in place if anything is ever edited inside the container.
COPY dist ./dist
COPY dist-server ./dist-server
COPY server ./server
COPY src ./src
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY start_web.sh README.md .env.example ./
RUN chmod +x start_web.sh && mkdir -p data log run

# Defaults; override any of these with `docker run -e`. The Tavily key is
# deliberately absent — pass it at run time so it never lands in the image.
ENV PORT=9000 \
    DATA_DIR=/app/data \
    VLLM_ENDPOINTS="local|http://localhost:8000/v1"

EXPOSE 9000

# Interactive shell, per the deployment convention: run with `-dit` so bash
# holds the container open and the app is started with ./start_web.sh.
CMD ["/bin/bash"]
