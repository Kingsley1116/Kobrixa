FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ pkg-config libudev-dev libusb-1.0-0-dev libnss3 libatk1.0-0 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libcups2 libgtk-3-0 libxshmfence1 xvfb xauth && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.15.0
COPY source.bundle /tmp/source.bundle
RUN git clone /tmp/source.bundle /workspace && rm /tmp/source.bundle && chown -R node:node /workspace
USER node
WORKDIR /workspace
ENV pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false CI=true
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter=!@kobrixa/desktop --filter=!@kobrixa/web build
FROM base AS product
RUN pnpm --filter @kobrixa/desktop package

USER root
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*
USER node
RUN git diff --exit-code && test -z "$(git status --porcelain)"
