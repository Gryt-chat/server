<div align="center">
  <img src="https://raw.githubusercontent.com/Gryt-chat/client/main/public/logo.svg" width="80" alt="Gryt logo" />
  <h1>Gryt Signaling Server</h1>
  <p>Node.js signaling server for the <a href="https://github.com/Gryt-chat/gryt">Gryt</a> voice chat platform.<br />Manages WebRTC signaling, rooms, text chat, and file uploads.</p>
</div>

<br />

## Docker

```bash
docker pull ghcr.io/gryt-chat/server:latest
docker run -p 5000:5000 --env-file .env ghcr.io/gryt-chat/server:latest
```

Browse tags at [ghcr.io/gryt-chat/server](https://github.com/Gryt-chat/server/pkgs/container/server).

## Quick Start (development)

```bash
bun install
cp example.env .env
bun dev
```

Starts on **http://localhost:5000**.

## Documentation

Full docs at **[docs.gryt.chat/docs/server](https://docs.gryt.chat/docs/server)**:

- [API Reference](https://docs.gryt.chat/docs/server/api-reference) — WebSocket events, REST endpoints, data structures
- [Rate Limiting](https://docs.gryt.chat/docs/server/rate-limiting) — score-based system, configuration
- [Multi-Server](https://docs.gryt.chat/docs/server/multi-server) — server isolation, room IDs
- [Deployment](https://docs.gryt.chat/docs/deployment) — Docker Compose, Kubernetes

## Issues

Please report bugs and request features in the [main Gryt repository](https://github.com/Gryt-chat/gryt/issues).

## License

[AGPL-3.0](https://github.com/Gryt-chat/gryt/blob/main/LICENSE) — Part of [Gryt](https://github.com/Gryt-chat/gryt)
