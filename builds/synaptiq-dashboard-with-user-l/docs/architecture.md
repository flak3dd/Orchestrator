# System Architecture Design
## Component: SynaptiQ dashboard with user list

```mermaid
graph TD
  Client[Frontend Client] -->|HTTP/WS| Server[Backend Server]
  Server -->|SQL| Database[SQLite DB]
  Server -->|Log| Logger[Structured Logger]
```