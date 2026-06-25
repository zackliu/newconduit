/**
 * Marks the policy decision point for routing and resource access, even while the POC keeps the authorization model intentionally thin.
 */
export class AuthorizationController {
  decide(_input: { principal: string; action: string; resourceId: string }): 'allow' {
    return 'allow';
  }
}