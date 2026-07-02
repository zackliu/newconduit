FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
ENV DOTNET_ROOT=/usr/share/dotnet
ENV PATH=$PATH:/usr/share/dotnet
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release git \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
  && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
  && bash /tmp/dotnet-install.sh --channel 9.0 --install-dir /usr/share/dotnet \
  && bash /tmp/dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet \
  && rm /tmp/dotnet-install.sh \
  && corepack enable \
  && useradd -m -u 10001 sidecar \
  && mkdir -p /runtime /home/sidecar/.azure /home/sidecar/.nuget \
  && chown -R sidecar:sidecar /runtime /home/sidecar \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
COPY config ./config
COPY sdk/client/package.json ./sdk/client/package.json
COPY samples/webclient/package.json ./samples/webclient/package.json
COPY samples/issue-fixer/package.json ./samples/issue-fixer/package.json

RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm prune --prod

USER sidecar
ENV SIDECAR_WORK_ROOT=/runtime/sidecar
CMD ["node", "dist/sidecar/main.js"]
