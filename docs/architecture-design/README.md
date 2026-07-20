# Architecture & Design

## Architecture overview

```mermaid
flowchart LR
    subgraph A["User's Agentic Application"]
        direction TB
        SDK["SDK"]
    end

    subgraph C["Central Session Service"]
        direction TB
        O["Tenant interface"]
        T["Session Management<br/>Worker Management<br/>WorkerPool Controller<br/>Auth<br/>Audit"]
        O --> T
    end

    subgraph D["Durable State"]
        direction TB
        E["Session Catalog · Event Log<br/>Interaction State · Audit Records"]
        X["Workspace Snapshots · Artifacts<br/>Agent State · Restore Inputs"]
    end

    subgraph W["Replaceable Execution · Homogeneous Worker Pool"]
        direction TB
        S["Deamon<br/>Agent supervision<br/>Protocol and event adaptation"]
        G["Agent Process<br/>CLI · SDK · Local IPC"]
        S <--> G
    end

    SDK <-->|"Session lifetime and commands<br/>live + history event stream"| O
    T <-->|"Lease-fenced assignment<br/>Runtime events"| S

    T <--> E
    S -->|"Checkpoint / snapshot"| X
    X -->|"Restore to a compatible Worker<br/>Same Session, new lease"| S

    T -.->|"Durable demand drives<br/>Worker Pool scaling"| S

    classDef client fill:#FFFFFF,stroke:#64748B,color:#0F172A,stroke-width:1.5px;
    classDef control fill:#DDE6F4,stroke:#4A6FA5,color:#1E3A5F,stroke-width:1.5px;
    classDef state fill:#DCEBE1,stroke:#4E8163,color:#234A34,stroke-width:1.5px;
    classDef compute fill:#F0E7D4,stroke:#9C844F,color:#4D3D20,stroke-width:1.5px;

    class SDK client;
    class O,T control;
    class E,X state;
    class S,G compute;

    style A fill:#F1F3F5,stroke:#B8C2CE,color:#334155,stroke-width:1.5px
    style C fill:#F1F3F5,stroke:#B8C2CE,color:#334155,stroke-width:1.5px
    style D fill:#F1F3F5,stroke:#B8C2CE,color:#334155,stroke-width:1.5px
    style W fill:#F1F3F5,stroke:#B8C2CE,color:#334155,stroke-width:1.5px

    linkStyle default stroke:#94A3B8,color:#334155
```

Agent Runtime Sidecar turns existing agents into durable online services. Applications interact with stable Session identities through the Central Session Service, while replaceable Workers execute sessions through a nearby Sidecar. Tenant Runtime owns routing, lifecycle, authorization, audit, and lease fencing. Durable event history and workspace snapshots allow the same Session to reconnect, pause, resume, or recover on a compatible Worker.

## Key architectural decisions

- **Session is a first-class durable object.** It preserves identity, state, workspace, and recovery while interchangeable Workers provide compute.
- **Central separates durable work from elastic compute.** It manages Session lifecycles, Worker scheduling and capacity, and lease fencing so compute can be released independently.
- **Agent-to-Worker compatibility is declarative.** AgentSpec and WorkerPool define requirements and capabilities; labels and selectors define their scheduling relationship.
- **Agent-to-Agent communication is Spec-defined and location-independent.** Delegate and AgentSpec references let Central route work through durable Child Sessions regardless of where Agents run.
- **The framework is extensible by design.** Custom Agent and host-pool adapters connect different runtimes and hosting backends without changing core contracts.

## Known limitations / future work

Session recovery currently depends on graceful, runtime-controlled lifecycle transitions that persist recovery state before compute is released. Recovery from non-graceful failures, such as Agent process or Worker crashes, is not yet supported and remains future work.