export class AuthorizationController {
  decide(_input: { principal: string; action: string; resourceId: string }): 'allow' {
    return 'allow';
  }
}