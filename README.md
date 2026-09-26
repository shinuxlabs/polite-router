# Polite Router

Slack bot that reads a site's rules and finds the lowest-impact way in. It runs on Vercel. A URL gets a polite route (robots.txt, feeds, sitemaps, a short crawl). Anything else is a chat with Grok.

## Cloud

The live Slack endpoint is `https://polite-router.vercel.app/api/slack`.

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) → **From a manifest** and paste `manifest.yaml`.
2. Install it to the workspace. Copy the bot token (`xoxb-…`) and the signing secret.
3. On Vercel, set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. `XAI_API_KEY` is already set.
4. If the app already existed, paste the manifest again and reinstall so Slack grants `assistant:write`.
5. In Slack, open **Polite Router** → **Messages**. That tab is the chat box.

## Usage

| Method | Example |
|--------|---------|
| Messages tab | Open the app and type |
| Slash command | `/route https://example.com` |
| Mention | `@PoliteRouter https://example.com` |
| DM a URL | Routes the site, then Grok summarizes |
| DM anything else | Chat with Grok |

`max:10` caps how many pages are listed.

## How the LLM is linked

Slack never sees the key. The Messages tab, DMs, mentions, and `/route` all end in `askGrok()` in `lib/grok.js`:

```
POST https://api.x.ai/v1/chat/completions
Authorization: Bearer $XAI_API_KEY
model: $XAI_MODEL   (default grok-4.5)
```

`GET /api/slack` reports whether that key is present. It does not reveal the key.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | — | Required. `xoxb-…` |
| `SLACK_SIGNING_SECRET` | — | Required for the Vercel endpoint |
| `XAI_API_KEY` | — | Required for Grok chat and summaries |
| `XAI_MODEL` | grok-4.5 | xAI model |
| `PR_MAX_PAGES` | 15 | Max pages per run |
| `PR_MAX_REQUESTS` | 30 | Hard cap on network requests |
| `PR_BOT_NAME` | PoliteRouter | User-Agent bot name |
| `PR_CONTACT` | — | Optional contact URL or email in the User-Agent |

## Local Socket Mode

`app.py` still runs the original Bolt Socket Mode wrapper. It needs `polite_router.py` on the path, `SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN`.

```bash
pip install -r requirements.txt
python app.py
```
