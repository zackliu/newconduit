# Foundry hosted-agent flavor of the sidecar image.
#
# Extends containers/sidecar/Dockerfile with the Foundry host adapter, its writable-user requirement, and the
# deployment-stable non-secret Copilot provider configuration. Session commands still flow over Web PubSub.
#
# BASE_IMAGE lets the base be pulled from a registry (for ACR/remote builds) while defaulting to the local tag
# produced by `pnpm build:sidecar-image`. Build order (see foundry/README.md):
#   local:  pnpm build:sidecar-image; docker build -f containers/sidecar-foundry/Dockerfile -t <img> .
#   remote: az acr build -r <acr> -t agent-runtime-sidecar-poc:<tag> -f containers/sidecar/Dockerfile .
#           az acr build -r <acr> -t agent-runtime-sidecar-foundry:<tag> \
#             --build-arg BASE_IMAGE=<acr>.azurecr.io/agent-runtime-sidecar-poc:<tag> \
#             --build-arg COPILOT_MODEL=<model> --build-arg COPILOT_PROVIDER_TYPE=<type> \
#             --build-arg COPILOT_PROVIDER_BASE_URL=<url> \
#             -f containers/sidecar-foundry/Dockerfile .
ARG BASE_IMAGE=agent-runtime-sidecar-poc:latest
FROM ${BASE_IMAGE}
ARG COPILOT_MODEL
ARG COPILOT_PROVIDER_TYPE
ARG COPILOT_PROVIDER_BASE_URL
RUN test -n "$COPILOT_MODEL" \
	&& test -n "$COPILOT_PROVIDER_TYPE" \
	&& test -n "$COPILOT_PROVIDER_BASE_URL"
ENV SIDECAR_HOST_CLASS=foundry \
	COPILOT_MODEL=${COPILOT_MODEL} \
	COPILOT_PROVIDER_TYPE=${COPILOT_PROVIDER_TYPE} \
	COPILOT_PROVIDER_BASE_URL=${COPILOT_PROVIDER_BASE_URL}
# Foundry injects the session's persistent storage as the container's $HOME (observed: /home/session) and runs
# the image as its declared USER. The base image drops to USER sidecar (uid 10001) for the Docker path, but
# Foundry's persistent $HOME is not owned by that user, so host-managed storage (rooted under $HOME so it
# survives idle scale-to-zero / recycle) hits EACCES on mkdir. Run the Foundry variant as root so it can write
# Foundry's persistent $HOME; the Docker base image keeps USER sidecar.
USER root
