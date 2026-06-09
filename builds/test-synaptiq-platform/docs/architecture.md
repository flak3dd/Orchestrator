# System Architecture Design
## Component: Test SynaptiQ platform

```mermaid
graph TD
  Client[Frontend Client] -->|HTTP/WS| Server[Backend Server]
  Server -->|SQL| Database[SQLite DB]
  Server -->|Log| Logger[Structured Logger]
```