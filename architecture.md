# Architecture Review & Analysis

## Executive Summary

The codebase follows a modular monorepo structure using PNPM workspaces. It implements a layered architecture separating the core framework, protocol definitions, transport layer, and client libraries. While the overall separation of concerns is logical, there are significant architectural issues regarding coupling and circular dependencies that threaten the stability and maintainability of the system.

## Module Analysis

### 1. Core (`@nmtjs/core`)
*   **Role**: The kernel of the framework. Handles Dependency Injection (DI), Plugins, Hooks, and Logging.
*   **Cohesion**: High. It focuses on the runtime lifecycle and composition of the application.
*   **Coupling**: Low (mostly). However, it contains utility functions (`match`, `Pattern`) that are used by lower-level packages like `protocol`, creating an inverted dependency.

### 2. Protocol (`@nmtjs/protocol`)
*   **Role**: Defines the wire format, message types, and stream handling for both client and server.
*   **Cohesion**: Mixed. It mixes pure type definitions with runtime logic (stream implementations) and re-exports from other packages.
*   **Coupling**: **Inverted Dependency**.
    *   `protocol` depends on `core` for utility functions (`match`, `Pattern`).
    *   **Nuance**: The dependency on `core` is only used in `protocol/server`. `protocol/client` is free of `core` imports. While tree-shaking prevents `core` code from ending up in client bundles, the package dependency remains in `package.json`, causing unnecessary installation overhead for client-only consumers.

### 3. Gateway (`@nmtjs/gateway`)
*   **Role**: Manages connections, transports, and integrates them with the Core DI container.
*   **Cohesion**: High. It acts as a clear translation layer between raw transports and the application logic.
*   **Coupling**: Expected. Depends on `core` and `protocol`.

### 4. Client (`@nmtjs/client`)
*   **Role**: Provides the client-side SDK.
*   **Cohesion**: High.
*   **Coupling**: High (due to the circular dependency with `protocol`).

### 5. Common (`@nmtjs/common`)
*   **Role**: Shared utilities and types.
*   **Cohesion**: Low (Utility bucket). This is typical for a `common` package.
*   **Coupling**: Low. Used by everyone.

## Critical Issues

### 1. Protocol Coupled to Core
The `protocol` package depends on `@nmtjs/core` specifically for the `match` function and `Pattern` type used in content negotiation.
*   **Impact**: The `protocol` package, which should be lightweight and portable (potentially usable in other environments), drags in the entire `core` framework dependency.
*   **Violation**: This violates the **Stable Dependencies Principle**. `protocol` is more stable/abstract than `core`, yet it depends on it.
*   **Mitigation**: The separate entry points (`/client` and `/server`) ensure that client bundles do not include `core` code. However, the installation dependency remains.

## Recommendations

### 1. Decouple Protocol from Core
*   **Action**: Move `match` and `Pattern` from `@nmtjs/core` to `@nmtjs/common` (or a new `@nmtjs/utils` package).
*   **Rationale**: These are generic utility functions. Moving them to `common` allows `protocol` to use them without depending on the heavy `core` framework. This solves the inverted dependency and cleans up the dependency tree.

### 2. Standardize Stream Interfaces
*   **Action**: As noted in the Streams Review, adopt standard Web Streams API interfaces strictly.
*   **Rationale**: This reduces the need for custom stream implementations and wrappers, simplifying the `protocol` and `client` packages.

### 4. Clarify Package Boundaries
*   **Action**: Enforce strict boundaries. `protocol` should not import from `client` or `server` implementation packages. It should only depend on `common`.

## Conclusion

The system has a solid foundation but is currently compromised by a few critical dependency violations. Addressing the circular dependency and decoupling the protocol from the core framework are immediate priorities to ensure a robust architecture.
