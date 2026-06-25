import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface JsonResponse {
  statusCode: number;
  body: unknown;
}

export type CentralHttpRouteHandler = (request: IncomingMessage) => Promise<JsonResponse>;

interface RegisteredRoute {
  method: string;
  path: string;
  handler: CentralHttpRouteHandler;
}

export interface CentralHttpServerOptions {
  port: number;
}

export class CentralHttpServer {
  private readonly routes: RegisteredRoute[] = [];
  private readonly server: Server;

  constructor(private readonly options: CentralHttpServerOptions) {
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        this.writeJson(response, 500, { error: error instanceof Error ? error.message : 'internal server error' });
      });
    });
  }

  registerRoute(method: string, path: string, handler: CentralHttpRouteHandler): void {
    this.routes.push({ method, path, handler });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.options.port, resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('central HTTP server did not bind to a TCP port');
    }
    return address.port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, this.corsHeaders());
      response.end();
      return;
    }
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const route = this.routes.find((candidate) => candidate.method === request.method && candidate.path === path);
    if (route) {
      const result = await route.handler(request);
      this.writeJson(response, result.statusCode, result.body);
      return;
    }

    this.writeJson(response, 404, { error: 'not found' });
  }

  private writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, { 'content-type': 'application/json', ...this.corsHeaders() });
    response.end(JSON.stringify(body));
  }

  private corsHeaders(): Record<string, string> {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    };
  }
}