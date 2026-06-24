export const POC_RUNTIME_HTTP_PATHS = {
  health: '/health',
  clientNegotiate: '/client/negotiate',
  sidecarNegotiate: '/sidecar/negotiate'
} as const;

export const POC_RUNTIME_HTTP_QUERY = {
  tenantId: 'tenantId'
} as const;