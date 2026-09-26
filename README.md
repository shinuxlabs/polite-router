# Polite Router

Cloud Slack bot. It runs only on Vercel at `https://polite-router.vercel.app/api/slack`. There is no local server.

A URL is routed politely (robots.txt, feeds, sitemaps, a short crawl). Anything else is a chat with Grok (`grok-4.5`).

## Commands

In the **Messages** tab, or in a DM with **@PoliteRouter**:

```
https://example.com
https://example.com max:10
What can you do?
```

In any channel where the bot is invited:

```
/route https://example.com
/route https://example.com max:10
@PoliteRouter https://example.com
@PoliteRouter what can you do?
```

`max:` is optional. It caps the page list from 1 to 30. The default is 15.

## Check that it is up

```
curl https://polite-router.vercel.app/api/slack
```

`slack` and `grok` must both be `true`.

## Slack app

If you recreate the app, use **From a manifest** and paste `manifest.yaml`, then install it to the workspace. The request URL is already `https://polite-router.vercel.app/api/slack`.

## Environment

Set on Vercel for Production, Preview, and Development. Nothing is read from a local `.env` in production.

| Variable | Default | Required |
|----------|---------|----------|
| `SLACK_BOT_TOKEN` | — | yes |
| `SLACK_SIGNING_SECRET` | — | yes |
| `XAI_API_KEY` | — | yes |
| `XAI_MODEL` | grok-4.5 | no |
| `PR_MAX_PAGES` | 15 | no |
| `PR_MAX_REQUESTS` | 30 | no |
| `PR_BOT_NAME` | PoliteRouter | no |
| `PR_CONTACT` | — | no |
