# Polite Router — Slack Bot

Chat interface for [polite_router.py](polite_router.py). Send a URL in Slack, get back what the site allows — feeds, sitemaps, and crawlable pages — without breaking any rules.

## Setup

### 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Pick your workspace
3. Paste the contents of `manifest.yaml`
4. Click **Create**

### 2. Get your tokens

- **Bot token:** OAuth & Permissions → Install to Workspace → copy `xoxb-…`
- **App token:** Basic Information → App-Level Tokens → **Generate Token** with `connections:write` scope → copy `xapp-…`

### 3. Run it

```bash
cp .env.example .env
# Fill in SLACK_BOT_TOKEN and SLACK_APP_TOKEN

pip install -r requirements.txt
python app.py
```

## Usage

| Method | Example |
|--------|---------|
| Slash command | `/route https://example.com` |
| Mention | `@PoliteRouter https://example.com` |
| DM | Just paste a URL |

The bot replies with a formatted card showing every page it found, which route it used (feed, sitemap, crawl), request stats, and the router log.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | — | Required. `xoxb-…` |
| `SLACK_APP_TOKEN` | — | Required. `xapp-…` |
| `PR_MAX_PAGES` | 15 | Max pages per run |
| `PR_MAX_REQUESTS` | 30 | Hard cap on network requests |
| `PR_FRESH_MINS` | 60 | Cache freshness in minutes |
| `PR_BOT_NAME` | PoliteRouter | User-Agent bot name |
| `PR_CONTACT` | — | Optional contact URL/email in User-Agent |
| `PR_CACHE_DIR` | .router_cache | Where cached pages are stored |
