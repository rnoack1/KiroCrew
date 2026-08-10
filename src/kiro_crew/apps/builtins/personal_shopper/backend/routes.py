"""Personal Shopper — backend API routes.

Registered at gateway startup by ``apps/routes.py:register_app_routes``
(loaded via the app's ``backend.routes`` manifest field).

Routes (browser-facing, same-origin authed):

  GET  /api/apps/personal-shopper/preferences        -> list all preferences
  POST /api/apps/personal-shopper/preferences        -> add a preference
  PUT  /api/apps/personal-shopper/preferences/{id}   -> update a preference
  DELETE /api/apps/personal-shopper/preferences/{id} -> delete a preference
  POST /api/apps/personal-shopper/preferences/search -> RAG search

  GET  /api/apps/personal-shopper/groups             -> list groups
  POST /api/apps/personal-shopper/groups             -> add a group
  DELETE /api/apps/personal-shopper/groups/{id}      -> delete a group

  GET  /api/apps/personal-shopper/history            -> list history
  POST /api/apps/personal-shopper/history            -> add history entry
  PUT  /api/apps/personal-shopper/history/{id}/feedback -> update feedback

  GET  /api/apps/personal-shopper/sites              -> get sites config
  PUT  /api/apps/personal-shopper/sites              -> update sites config
"""

from __future__ import annotations

import asyncio
import json
import logging
from functools import wraps
from pathlib import Path

from aiohttp import web

from kiro_crew.apps.manager import is_app_enabled

logger = logging.getLogger(__name__)

APP_NAME = "personal-shopper"
_PREFIX = f"/api/apps/{APP_NAME}"

# Lazy-loaded store singleton (avoid import-time DB creation)
_store = None


def _get_store():
    """Get or create the PreferenceStore singleton."""
    global _store
    if _store is None:
        from kiro_crew.apps.builtins.personal_shopper.backend.store import PreferenceStore

        _store = PreferenceStore()
    return _store


def _require_enabled(handler):
    """Deny requests when Personal Shopper is disabled."""

    @wraps(handler)
    async def _wrapped(request: web.Request) -> web.Response:
        if not await asyncio.to_thread(is_app_enabled, APP_NAME):
            return web.json_response(
                {"error": "personal-shopper is disabled", "code": "app_disabled"},
                status=403,
            )
        return await handler(request)

    return _wrapped


# ── Preferences ──


async def _handle_list_preferences(request: web.Request) -> web.Response:
    store = _get_store()
    prefs = await asyncio.to_thread(store.list_all)
    return web.json_response({"preferences": prefs})


async def _handle_add_preference(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response(
            {"error": "invalid JSON", "code": "invalid_json"}, status=400
        )

    text = body.get("text", "").strip()
    if not text:
        return web.json_response({"error": "text is required", "code": "missing_required_field"}, status=400)

    tags = body.get("tags", [])
    if not isinstance(tags, list):
        return web.json_response({"error": "tags must be an array", "code": "invalid_field_type"}, status=400)

    store = _get_store()
    entry_id = await asyncio.to_thread(store.add, text, tags=tags)
    return web.json_response({"id": entry_id}, status=201)


async def _handle_update_preference(request: web.Request) -> web.Response:
    entry_id = request.match_info["id"]
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response(
            {"error": "invalid JSON", "code": "invalid_json"}, status=400
        )

    text = body.get("text")
    tags = body.get("tags")

    store = _get_store()
    await asyncio.to_thread(store.update, entry_id, text=text, tags=tags)
    return web.json_response({"id": entry_id, "updated": True})


async def _handle_delete_preference(request: web.Request) -> web.Response:
    entry_id = request.match_info["id"]
    store = _get_store()
    await asyncio.to_thread(store.delete, entry_id)
    return web.json_response({"id": entry_id, "deleted": True})


async def _handle_search_preferences(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response(
            {"error": "invalid JSON", "code": "invalid_json"}, status=400
        )

    query = body.get("query", "").strip()
    if not query:
        return web.json_response({"error": "query is required", "code": "missing_required_field"}, status=400)

    top_k = body.get("top_k", 5)
    tag_filter = body.get("tag_filter")

    store = _get_store()
    results = await asyncio.to_thread(
        store.search, query, top_k=top_k, tag_filter=tag_filter
    )
    return web.json_response(
        {
            # `semantic` tells the caller whether `score` is a cosine similarity
            # or a keyword-rank ordering, so a client never thresholds a keyword
            # score as though it measured meaning.
            "semantic": bool(results and results[0].semantic),
            "results": [
                {
                    "id": r.id,
                    "text": r.text,
                    "tags": r.tags,
                    "score": r.score,
                    "semantic": r.semantic,
                }
                for r in results
            ],
        }
    )


# ── Groups ──


async def _handle_list_groups(request: web.Request) -> web.Response:
    store = _get_store()
    groups = await asyncio.to_thread(store.list_groups)
    return web.json_response({"groups": groups})


async def _handle_add_group(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response(
            {"error": "invalid JSON", "code": "invalid_json"}, status=400
        )

    name = body.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name is required", "code": "missing_required_field"}, status=400)

    icon = body.get("icon", "")

    store = _get_store()
    group_id = await asyncio.to_thread(store.add_group, name, icon=icon)
    return web.json_response({"id": group_id}, status=201)


async def _handle_delete_group(request: web.Request) -> web.Response:
    group_id = request.match_info["id"]
    store = _get_store()
    await asyncio.to_thread(store.delete_group, group_id)
    return web.json_response({"id": group_id, "deleted": True})


# ── History ──


async def _handle_list_history(request: web.Request) -> web.Response:
    limit = int(request.query.get("limit", "20"))
    store = _get_store()
    history = await asyncio.to_thread(store.list_history, limit=limit)
    return web.json_response({"sessions": history})


async def _handle_add_history(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response(
            {"error": "invalid JSON", "code": "invalid_json"}, status=400
        )

    problem = body.get("problem", "").strip()
    if not problem:
        return web.json_response({"error": "problem is required", "code": "missing_required_field"}, status=400)

    advice = body.get("advice", "")
    products = body.get("products", [])

    store = _get_store()
    entry_id = await asyncio.to_thread(
        store.add_history, problem, advice=advice, products=products
    )
    return web.json_response({"id": entry_id}, status=201)


async def _handle_update_feedback(request: web.Request) -> web.Response:
    history_id = request.match_info["id"]
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response(
            {"error": "invalid JSON", "code": "invalid_json"}, status=400
        )

    product_name = body.get("product", "").strip()
    feedback = body.get("feedback", "").strip()
    if not product_name or not feedback:
        return web.json_response(
            {"error": "product and feedback are required",
             "code": "missing_required_field"}, status=400
        )

    store = _get_store()
    await asyncio.to_thread(store.update_feedback, history_id, product_name, feedback)
    return web.json_response({"id": history_id, "updated": True})


# ── Sites ──


def _sites_path() -> Path:
    """Resolve the sites file under the ACTIVE data home.

    Deferred to call time so ``KIROCREW_HOME`` is honoured: a module-level
    constant binds whichever home was set at import, which sends a pod's or a
    test's writes into the real user's data.
    """
    from kiro_crew.apps.manager import app_data_dir

    return app_data_dir(APP_NAME) / "sites.json"


async def _handle_get_sites(request: web.Request) -> web.Response:
    def _read():
        path = _sites_path()
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        return {"sites": []}

    data = await asyncio.to_thread(_read)
    return web.json_response(data)


async def _handle_put_sites(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response(
            {"error": "invalid JSON", "code": "invalid_json"}, status=400
        )

    def _write():
        path = _sites_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(body, indent=2, ensure_ascii=False), encoding="utf-8")

    await asyncio.to_thread(_write)
    return web.json_response({"updated": True})


# ── Registration ──


def register_routes(app: web.Application) -> None:
    """Register Personal Shopper routes on the gateway's aiohttp Application."""
    # Preferences
    app.router.add_get(
        f"{_PREFIX}/preferences", _require_enabled(_handle_list_preferences)
    )
    app.router.add_post(
        f"{_PREFIX}/preferences", _require_enabled(_handle_add_preference)
    )
    app.router.add_put(
        f"{_PREFIX}/preferences/{{id}}", _require_enabled(_handle_update_preference)
    )
    app.router.add_delete(
        f"{_PREFIX}/preferences/{{id}}", _require_enabled(_handle_delete_preference)
    )
    app.router.add_post(
        f"{_PREFIX}/preferences/search", _require_enabled(_handle_search_preferences)
    )
    # Groups
    app.router.add_get(f"{_PREFIX}/groups", _require_enabled(_handle_list_groups))
    app.router.add_post(f"{_PREFIX}/groups", _require_enabled(_handle_add_group))
    app.router.add_delete(
        f"{_PREFIX}/groups/{{id}}", _require_enabled(_handle_delete_group)
    )
    # History
    app.router.add_get(f"{_PREFIX}/history", _require_enabled(_handle_list_history))
    app.router.add_post(f"{_PREFIX}/history", _require_enabled(_handle_add_history))
    app.router.add_put(
        f"{_PREFIX}/history/{{id}}/feedback",
        _require_enabled(_handle_update_feedback),
    )
    # Sites
    app.router.add_get(f"{_PREFIX}/sites", _require_enabled(_handle_get_sites))
    app.router.add_put(f"{_PREFIX}/sites", _require_enabled(_handle_put_sites))
