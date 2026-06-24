# Server Role Decision

Use this file when the main question is how the app server participates in the system, not which browser SDK to import.

## Ask these questions first

- Is plain group fan-out enough, or must one server-side handling path process each client event?
- Can the server expose a reachable HTTP endpoint and configure upstream settings on the hub?
- Does any server process need realtime data but cannot or should not expose an inbound endpoint?
- Will the server send or manage connections through REST or `WebPubSubServiceClient`?

## Common server shapes

- Negotiate / publish / manage only
  - Typical server choice: `@azure/web-pubsub` with `WebPubSubServiceClient`
  - Use this when the server issues client access URLs, sends to groups/users/connections, or manages membership and permissions.
  - Do not add upstream just because the server also publishes.

- Node app hosting upstream
  - Typical server choice: `@azure/web-pubsub` with `WebPubSubServiceClient`, plus `@azure/web-pubsub-express` with `WebPubSubEventHandler`
  - Use this when an Express or similar server must receive connect, connected, disconnected, or user events from the service.

- Azure Functions hosting upstream
  - Typical server choice: Azure Web PubSub Functions bindings and triggers first
  - Use this when Functions is the natural host for the event path.
  - Do not force the Node Express middleware pattern into a Functions app.

- Server process as a client connection
  - Typical server choice: `@azure/web-pubsub-client`
  - Use this when the server process should actively connect outward to the service and participate like another client connection.
  - This can coexist with server-side publish or upstream handling.

## Shape 1: client-connection / group pubsub

- The realtime participants hold client connections to the service and exchange data through groups or server messages.
- A server process can use this shape too if it actively connects outward to the service like any other client.
- This shape avoids inbound callback requirements for the realtime path.
- Use it when fan-out is enough and any required business acknowledgement can be modeled explicitly at the application layer.

## Shape 2: upstream event handling

- The service forwards connect, connected, disconnected, or user events to a configured upstream endpoint as CloudEvents over HTTP.
- This gives one server-side handling path per event request, with normal HTTP success or failure semantics.
- Use it when server-side validation, dispatch, or event acknowledgement is part of the feature itself.
- This shape requires a reachable endpoint and hub event-handler configuration. During local development, that often means the tunnel flow unless the server is already reachable.
- Azure Functions and a custom app server are hosting choices for this same upstream shape, not separate architecture categories.

## Server send/manage role

- `WebPubSubServiceClient` and the REST API let the server send to groups, users, or connections and manage membership or permissions.
- In JavaScript or TypeScript server apps, that usually means `@azure/web-pubsub` with `WebPubSubServiceClient`.
- This role can be combined with either shape above.
- Do not confuse "the server publishes with REST" with "the server must use upstream." Those are different decisions.

## Best-practice posture

- Start from the server role, not from the package name.
- Mention the usual package or binding choice only to point the implementation in the right direction.
- Do not turn this file into a step-by-step SDK guide. The goal is to choose the right shape, not to teach every API call.
- If one server process both publishes and handles upstream, say that clearly instead of pretending it is one role.

## Decision rule

- If the feature is primarily "connected participants fan out through groups," stay with client-connection / group pubsub.
- If the feature is primarily "each event must be handled by server logic," choose upstream first and then choose whether Functions or an app server hosts it.
