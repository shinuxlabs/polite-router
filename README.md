# Polite Router

Slack bot that reads a site's rules and finds the lowest-impact way in. It runs on Vercel. A URL gets a polite route (robots.txt, feeds, sitemaps, a short crawl). Anything else is a chat with Grok.

## Cloud

The live Slack endpoint is `https://<your-project>.vercel.app/api/slack`.

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) → **From a manifest** and paste `manifest.yaml` (its request URLs must match the Vercel domain).
2. Install it to the workspace. Copy the bot token (`xoxb-…`) and the signing secret.
3. On Vercel, set `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `XAI_API_KEY`.
4. Reinstall the app if Slack asks you to after changing the manifest. Invite `@PoliteRouter` to a channel.

## Usage

| Method | Example |
|--------|---------|
| Slash command | `/route https://example.com` |
| Mention | `@PoliteRouter https://example.com` |
| DM a URL | Routes the site, then Grok summarizes |
| DM anything else | Chat with Grok |

`max:10` caps how many pages are listed.

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
