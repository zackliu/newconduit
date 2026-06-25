export const POC_RUNTIME_HTTP_PATHS = {
  health: '/health',
  runtimeStatus: '/runtime/status',
  clientNegotiate: '/client/negotiate',
  sidecarNegotiate: '/sidecar/negotiate'
} as const;

export const POC_RUNTIME_HTTP_QUERY = {
  tenantId: 'tenantId',
  clientConnectionId: 'clientConnectionId'
} as const;