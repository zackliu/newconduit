---
name: webpubsub-solution-selector
description: Choose the correct Azure Web PubSub runtime and server role without mixing client protocol, upstream handling, and server hosting. Use when the task involves Azure Web PubSub client SDK, negotiate endpoints, groups, rooms, upstream handlers, REST or `@azure/web-pubsub` service SDK sends, Azure Functions, service-to-server callbacks, Web PubSub for Socket.IO, replacing polling/SSE/WebSocket behavior, or adding Web PubSub to an existing application.
---

# WebPubSub Solution Selector

Use this skill before generating code for Azure Web PubSub work.

The main failure mode is not syntax. It is mixing up three different decisions:

- which client runtime to use
- whether the app server is in the realtime event path
- whether that server is hosted as Functions or as a regular app

## Core workflow

1. Decide whether the task is:
- Existing-app integration
- Greenfield sample or starter

2. If the task is an existing-app integration, inspect the host app before proposing structure:
- auth/session boundary
- current write path
- current live-update path such as polling/SSE/WebSocket
- domain partitions such as boards, rooms, tenants, channels, documents, or dashboards
- existing frontend build/runtime and server entrypoints

3. Choose the client runtime:
- PubSub client SDK
- Web PubSub for Socket.IO

4. Choose the server role for application logic:
- Client-connection / group pubsub
- Upstream event handling plus REST or `@azure/web-pubsub`

5. If upstream is chosen, choose the hosting shape:
- Azure Functions
- Existing or custom server

6. Ask or state answers before major edits:
- Is group fan-out enough, or must one server-side handling path process each event?
- Can the server expose a reachable HTTP endpoint and configure upstream settings?
- Are writes server-owned, or can authorized clients publish directly?
- Does any server process need its own client connection to the service instead of inbound callbacks?

7. State the chosen shape and domain mapping in one sentence before major edits.
Example: `PubSub client SDK plus server-owned REST publish; browsers connect as client connections in one hub, document ids map to groups, and writes stay on the existing API.`

8. Load the matching reference files:
- PubSub client SDK: `references/pubsub-client-sdk.md`
- Server role / upstream decision: `references/server-role-decision.md`
- Web PubSub for Socket.IO: `references/webpubsub-for-socketio.md`

9. Also load `references/existing-app-integration.md` whenever the task adds Web PubSub to an existing app, replaces polling/SSE/WebSocket behavior, or must preserve existing auth/API/build boundaries.

10. Also load `references/negotiate-checklist.md` whenever the work includes authentication, `/negotiate`, user identity, permissions, reconnect behavior, or browser connection setup.

11. Load `references/common-pitfalls.md` when:
- the task is browser PubSub client SDK
- the task replaces polling/SSE/WebSocket in an existing app
- reconnect, packaging, authority boundaries, or group semantics look easy to get subtly wrong

12. Generate the least invasive correct solution for the current task.
- For samples or starters, prefer the smallest solution that is correct for the chosen runtime and server role.
- For existing-app integration, prefer the smallest change that preserves the host app's authority model and architecture.
- Do not turn a server-role decision into a rewrite unless the user explicitly asks for it.

## Hard rules

### Runtime

- For browser PubSub clients, prefer `@azure/web-pubsub-client` by default.
- If the user wants Socket.IO semantics, do not generate a native `WebPubSubClient` solution. Use the Web PubSub for Socket.IO path.
- Do not classify Azure Functions as a peer architecture to upstream. Functions are one hosting option for upstream handlers.

### Server role

- A Web PubSub client connection can be a browser, mobile app, desktop app, worker, or an app server process that actively connects to the service.
- If the app only needs realtime fan-out among connected participants, prefer client-connection / group pubsub first.
- If the app needs connect/connected/disconnected hooks, custom user events handled on the server, or one server-side handling path per event, prefer upstream.
- Upstream requires a reachable HTTP endpoint and service-side event-handler configuration. Local development usually needs the tunnel flow unless the handler is already reachable.
- Sending messages with `WebPubSubServiceClient` or the REST API is a server role, even if that same process also holds a client connection.
- Do not assume `sendToGroup()` means another application server consumed the message. It tells you the service accepted the publish request. If application-level acknowledgement matters, model that explicitly.

### Integration

- If the app already has auth/session, API routes, server entrypoints, or a frontend build pipeline, reuse them instead of creating parallel demo structure.
- Do not add a sidecar auth scheme, duplicate login flow, or alternate business write path unless the user explicitly asks for that architecture.
- Make the mapping between app concepts and Web PubSub concepts explicit.
- If more than one mapping is plausible and the choice affects authorization, tenancy, reconnect, or operational shape, state the ambiguity before major edits and either ask the user or document the assumption clearly.
- When replacing polling/SSE/WebSocket in an existing app, first preserve behavior and authority. Do not widen product scope during the transport swap.

### Negotiate and permissions

- Do not present `?userId=...` from the browser as a production auth pattern.
- Treat `/negotiate` as a server-owned auth boundary.
- Prefer `POST /negotiate` when the endpoint issues tokens, mutates session state, or sets cookies.
- Derive identity from server-side auth state when possible. If a demo uses query-based identity for simplicity, label it clearly as demo-only.
- Distinguish initial JWT roles, initial JWT groups, client-side `joinGroup()`, and server-managed membership. They are not interchangeable.
- Do not grant broader roles than the task requires.

### Validation

- When building a sample, include a brief run path and note any production caveats.
- When explaining the final shape, state the chosen runtime, the chosen server role, whether upstream is required, and what app concept maps to hub/group.
- If the design needs application-level acknowledgement or single-handler processing, say whether that comes from upstream handling or from application logic built on top of group pubsub.

## Output guidance

- Prefer short decision-oriented explanations over long SDK summaries.
- Emit code only after the runtime and server role are selected.
- If the user asks for "a sample", default to the smallest viable scaffold for the chosen shape, not the most feature-rich architecture.
- If the user names an output directory, write directly into that directory unless they explicitly ask for an additional nested project folder.
