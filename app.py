#!/usr/bin/env python3
"""
Slack bot wrapper for polite_router.py
Users send a URL in the chat box → bot runs polite_router → posts results back.

Commands:
  /route <url>              — run the router on a site
  @bot <url>                — same, via mention
  Just paste a URL in a DM  — same, via direct message
"""

import io
import json
import os
import re
import sys
import threading
from contextlib import redirect_stdout, redirect_stderr

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

# ── Import polite_router from the same repo ──────────────────────────────
sys.path.insert(0, os.path.dirname(__file__))
from polite_router import Router

# ── Slack app ─────────────────────────────────────────────────────────────
app = App(token=os.environ["SLACK_BOT_TOKEN"])

URL_RE = re.compile(r"https?://[^\s>]+")

DEFAULT_MAX_PAGES = int(os.environ.get("PR_MAX_PAGES", 15))
DEFAULT_MAX_REQUESTS = int(os.environ.get("PR_MAX_REQUESTS", 30))
DEFAULT_FRESH_MINS = float(os.environ.get("PR_FRESH_MINS", 60))
BOT_NAME = os.environ.get("PR_BOT_NAME", "PoliteRouter")
CONTACT = os.environ.get("PR_CONTACT", None)
CACHE_DIR = os.environ.get("PR_CACHE_DIR", ".router_cache")


def run_router(url: str) -> dict:
    """Run polite_router on a URL and return structured results."""
    ua = f"{BOT_NAME}/1.0" + (f" (+{CONTACT})" if CONTACT else "")
    router = Router(
        url, ua, BOT_NAME,
        max_pages=DEFAULT_MAX_PAGES,
        fresh_secs=DEFAULT_FRESH_MINS * 60,
        max_requests=DEFAULT_MAX_REQUESTS,
        cache_dir=CACHE_DIR,
    )
    results = router.run()
    stats = router.fetcher.stats
    return {
        "url": url,
        "pages": results,
        "log": router.log,
        "stats": {
            "pages_found": len(results),
            "requests_sent": stats["network"],
            "not_modified": stats["not_modified"],
            "cache_hits": stats["cache_hits"],
        },
    }


def format_results(data: dict) -> list[dict]:
    """Format router results as Slack Block Kit blocks."""
    stats = data["stats"]
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": f"Route results for {data['url']}", "emoji": True},
        },
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*Pages found:* {stats['pages_found']}"},
                {"type": "mrkdwn", "text": f"*Requests sent:* {stats['requests_sent']}"},
                {"type": "mrkdwn", "text": f"*Cached:* {stats['cache_hits']}"},
                {"type": "mrkdwn", "text": f"*Unchanged (304):* {stats['not_modified']}"},
            ],
        },
        {"type": "divider"},
    ]

    # Show up to 15 pages in the chat
    for page in data["pages"][:15]:
        title = page.get("title", "") or page["url"]
        route_badge = f"`{page['route']}`"
        size = f"{page['bytes']:,} bytes" if page.get("bytes") else ""
        blocks.append({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"{route_badge}  <{page['url']}|{title}>\n{size}",
            },
        })

    if len(data["pages"]) > 15:
        blocks.append({
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"_…and {len(data['pages']) - 15} more pages_"}],
        })

    # Log summary
    log_text = "\n".join(data["log"])
    if log_text:
        blocks.append({"type": "divider"})
        blocks.append({
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"```{log_text}```"}],
        })

    return blocks


def format_error(url: str, error: str) -> list[dict]:
    return [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"Failed to route `{url}`:\n```{error}```"},
        }
    ]


def handle_route(url: str, say, thread_ts=None):
    """Run the router in a thread and post results."""
    say_kwargs = {}
    if thread_ts:
        say_kwargs["thread_ts"] = thread_ts

    say(text=f"Routing `{url}` — this may take a moment…", **say_kwargs)

    def _run():
        try:
            data = run_router(url)
            say(blocks=format_results(data), text=f"Found {data['stats']['pages_found']} pages on {url}", **say_kwargs)
        except Exception as e:
            say(blocks=format_error(url, str(e)), text=f"Error routing {url}", **say_kwargs)

    threading.Thread(target=_run, daemon=True).start()


# ── Slash command: /route <url> ───────────────────────────────────────────
@app.command("/route")
def command_route(ack, say, command):
    url = command["text"].strip()
    if not URL_RE.match(url):
        ack(text="Send a full URL, like `/route https://example.com`")
        return
    ack(text=f"On it — routing `{url}`…")
    handle_route(url, say)


# ── App mention: @PoliteRouter https://example.com ────────────────────────
@app.event("app_mention")
def handle_mention(event, say):
    text = event.get("text", "")
    urls = URL_RE.findall(text)
    if not urls:
        say(
            text="Send me a URL and I'll find the polite way in.\nExample: `@PoliteRouter https://example.com`",
            thread_ts=event.get("ts"),
        )
        return
    for url in urls[:3]:  # cap at 3 URLs per message
        handle_route(url, say, thread_ts=event.get("ts"))


# ── DM: just paste a URL ─────────────────────────────────────────────────
@app.event("message")
def handle_dm(event, say):
    # Only respond to DMs (im), not channel messages
    if event.get("channel_type") != "im":
        return
    # Ignore bot's own messages and edits
    if event.get("bot_id") or event.get("subtype"):
        return

    text = event.get("text", "")
    urls = URL_RE.findall(text)

    if not urls:
        say(
            text=(
                "Hey! Send me a URL and I'll route it.\n"
                "Example: `https://example.com`\n\n"
                "*Options you can add:*\n"
                "• `max:10` — limit to 10 pages\n"
                "• `fresh:30` — treat cache as fresh for 30 min\n"
            ),
        )
        return

    for url in urls[:3]:
        handle_route(url, say)


# ── Home tab ───────────────────────────────────────────────────────────────────
@app.event("app_home_opened")
def update_home_tab(client, event):
    client.views_publish(
        user_id=event["user"],
        view={
            "type": "home",
            "blocks": [
                {
                    "type": "header",
                    "text": {"type": "plain_text", "text": "Polite Router"},
                },
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": (
                            "I read a site's rules, then find the lowest-impact way in.\n\n"
                            "*How to use me:*\n"
                            "• `/route https://example.com` in any channel\n"
                            "• Mention me with a URL: `@PoliteRouter https://example.com`\n"
                            "• DM me a URL directly\n\n"
                            "*What I do:*\n"
                            "1. Read `robots.txt` and respect every rule\n"
                            "2. Check RSS feeds first (lowest impact)\n"
                            "3. Fall back to sitemaps, then careful link crawling\n"
                            "4. Cache everything so repeat runs send zero requests\n"
                            "5. Stop immediately on 401/403/429/451\n"
                        ),
                    },
                },
            ],
        },
    )


# ── Start ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    handler = SocketModeHandler(app, os.environ["SLACK_APP_TOKEN"])
    print("⚡ Polite Router bot is running")
    handler.start()
