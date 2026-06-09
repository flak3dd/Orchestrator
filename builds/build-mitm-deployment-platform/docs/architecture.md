# System Architecture Design
## Component: build mitm deployment platform to reverse proxy all traffic from target site

```mermaid
graph TD
  Client[Frontend Client] -->|HTTP/WS| Server[Backend Server]
  Server -->|SQL| Database[SQLite DB]
  Server -->|Log| Logger[Structured Logger]
```