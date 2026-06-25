FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
  && corepack enable \
  && useradd -m -u 10001 sidecar \
  && mkdir -p /runtime /home/sidecar/.azure \
  && chown -R sidecar:sidecar /runtime /home/sidecar

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
COPY sdk/package.json ./sdk/package.json
COPY sdk/src ./sdk/src
COPY sdk/tsconfig.json ./sdk/tsconfig.json
COPY sdk/tsconfig.esm.json ./sdk/tsconfig.esm.json

RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm prune --prod

USER sidecar
ENV SIDECAR_WORK_ROOT=/runtime/sidecar
CMD ["node", "dist/sidecar/main.js"]