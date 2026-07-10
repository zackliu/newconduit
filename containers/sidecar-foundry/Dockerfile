# Foundry hosted-agent flavor of the sidecar image.
#
# Identical build to containers/sidecar/Dockerfile; the only difference is that this image selects the
# `foundry` sidecar host adapter, which serves the Foundry hosted-agent HTTP contract (GET /readiness +
# POST /invocations liveness) instead of the env-driven local/Docker host. Session commands still flow over
# Web PubSub inside the started daemon - this only changes the outer host wrapper and the lifecycle owner.
#
# BASE_IMAGE lets the base be pulled from a registry (for ACR/remote builds) while defaulting to the local tag
# produced by `pnpm build:sidecar-image`. Build order (see foundry/README.md):
#   local:  pnpm build:sidecar-image; docker build -f containers/sidecar-foundry/Dockerfile -t <img> .
#   remote: az acr build -r <acr> -t agent-runtime-sidecar-poc:<tag> -f containers/sidecar/Dockerfile .
#           az acr build -r <acr> -t agent-runtime-sidecar-foundry:<tag> \
#             --build-arg BASE_IMAGE=<acr>.azurecr.io/agent-runtime-sidecar-poc:<tag> \
#             -f containers/sidecar-foundry/Dockerfile .
ARG BASE_IMAGE=agent-runtime-sidecar-poc:latest
FROM ${BASE_IMAGE}
ENV SIDECAR_HOST_CLASS=foundry
# Foundry injects the session's persistent storage as the container's $HOME (observed: /home/session) and runs
# the image as its declared USER. The base image drops to USER sidecar (uid 10001) for the Docker path, but
# Foundry's persistent $HOME is not owned by that user, so host-managed storage (rooted under $HOME so it
# survives idle scale-to-zero / recycle) hits EACCES on mkdir. Run the Foundry variant as root so it can write
# Foundry's persistent $HOME; the Docker base image keeps USER sidecar.
USER root
