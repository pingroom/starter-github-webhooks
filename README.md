# GitHub webhooks → PingRoom

Send a linked PingRoom notification when an issue opens or a release publishes in a repository you choose. This Node.js starter verifies GitHub signatures, filters events, and records successful deliveries across restarts for up to 24 hours.

Uses the official [`@pingroom/sdk`](https://github.com/pingroom/sdk), pinned to `0.7.0`. Requires Node.js 22 or newer.

## Try it offline

Click **Use this template**, clone your repository, then run:

```sh
npm ci
npm run demo
```

The demo sends signed requests to a temporary local HTTP server. The real SDK uses an in-memory transport: nothing contacts GitHub or PingRoom, and no credentials are read. Expect two simulated pings and one skipped duplicate.

## Connect and configure

Install or open [PingRoom](https://pingroom.io/i), sign in, and run:

```sh
npm run connect
cp .env.example .env
```

Open the printed connection link and approve the robot's room access. Use the same link while installing the app. The connection is saved in ignored `.pingroom/credentials.json`; POSIX permissions are `0600` for the file and `0700` for the directory.

Edit `.env`:

```dotenv
GITHUB_WEBHOOK_SECRET=your-random-secret-at-least-32-characters
GITHUB_REPOSITORIES=your-org/your-repo,other-org/other-repo
HOST=127.0.0.1
PORT=3000
```

Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Then run `npm start`.

Existing shell variables override `.env`. To supply an existing PingRoom connection, set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. If either is present, both must be nonblank; saved credentials are then ignored.

## Add the GitHub webhook

1. Put an HTTPS reverse proxy or tunnel in front of the local server. Forward the raw request bytes and GitHub headers unchanged to `http://127.0.0.1:3000/webhooks/github`. Deployment is up to you; this template does not deploy infrastructure.
2. In your repository's **Settings → Webhooks → Add webhook**, set the public HTTPS URL ending in `/webhooks/github`.
3. Select **application/json**, enter the same secret as `GITHUB_WEBHOOK_SECRET`, and select the **Issues** and **Releases** events. Keep SSL verification enabled.
4. Open an issue or publish a release. Check **Recent Deliveries** in GitHub and the linked ping in your room.

The allowlist is required and matches `owner/repository` names without regard to case. Only `issues.opened` and `release.published` send pings. Other actions and event types, including GitHub's setup `ping`, return `202` when they belong to an allowed repository.

`GET /health` returns `200`. The default listener is `127.0.0.1:3000`; set `HOST` if your proxy or container needs another address.

## Delivery behavior

- Signatures use HMAC-SHA256 over the raw body and `timingSafeEqual`, following [GitHub's verification guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries). The repository and event fields are checked before sending.
- Successful sends are recorded atomically in `.pingroom/deliveries.json`. Concurrent copies wait for the same send. The dedupe key is the signed body's SHA-256 hash, because GitHub's delivery ID header is unsigned. Changing that ID cannot bypass retained replay protection; different signed bodies with the same ID still process separately.
- The store retains at most 1,000 successful bodies for 24 hours. Older or evicted bodies can send again. Run one process per store directory; a lock prevents a second writer. For multiple instances or durable queues, replace `src/store.js` with shared storage and a worker.
- Failed sends return `503` and are not recorded as delivered. A timeout may still mean the remote service accepted the ping. A crash or disk failure between sending and recording can also cause a duplicate on retry; this starter does not guarantee exactly-once delivery.
- GitHub does **not** automatically redeliver failures. Use **Recent Deliveries → Redeliver**, or add your own retry worker. See [GitHub's failed-delivery guidance](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

Bodies are limited to 256 KiB with a two-second read deadline. The server accepts up to 16 active deliveries and 64 connections. SDK calls have a five-second timeout; the HTTP response deadline is eight seconds, below GitHub's ten-second limit. A response deadline does not stop a send already in progress; its result can still be recorded. Larger payloads and overloaded requests return non-2xx responses for inspection and manual redelivery.

No request payloads, signatures, tokens, or upstream error bodies are logged. HTTP errors contain a short status code such as `invalid_signature` or `delivery_failed`.

## Adapt and test

```sh
npm test
```

Tests cover signatures, allowlisting, filtering, byte/read limits, concurrent duplicates, persistence, failed-send retries, and configuration. CI runs tests and the offline demo on Node.js 22 and 24 without secrets.

Change `src/events.js` to map additional event types. Keep signature verification and the repository allowlist before your handler. Pings have a title, a body capped at 120 characters, and a button linking to the issue or release. Deterministic application code owns filtering and execution; no AI provider is required.

| Problem | Check |
| --- | --- |
| Startup fails | Required `.env` values, saved connection, port availability, and the store lock. |
| `401 invalid_signature` | Identical secrets and unchanged raw request bytes through your proxy. |
| `403 repository_not_allowed` | Exact `owner/repository` entry in `GITHUB_REPOSITORIES`. |
| `413 body_too_large` | This starter intentionally rejects payloads above 256 KiB. |
| `503 delivery_failed` | PingRoom connectivity, room grant, quotas, and writable `.pingroom/` storage; then manually redeliver. |
| Store locked after a crash | Verify the process ID in `.pingroom/deliveries.lock` is no longer running, then remove only that lock file and restart. Keep `deliveries.json`. |

To add a human decision before a workflow action, see [starter-human-review](https://github.com/pingroom/starter-human-review). For job status updates, see [starter-job-progress](https://github.com/pingroom/starter-job-progress).

MIT licensed. See [LICENSE](LICENSE).
