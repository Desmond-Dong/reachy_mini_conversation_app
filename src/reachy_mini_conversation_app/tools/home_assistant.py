"""Home Assistant MCP bridge tool."""

from __future__ import annotations
import os
from typing import Any, Dict
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from reachy_mini_conversation_app.tools.core_tools import Tool, ToolDependencies


CONTROL_FIELDS = {"action", "tool_name", "prompt_name", "arguments", "input_schema"}
TARGET_MATCH_TOOLS = {"HassTurnOn", "HassTurnOff", "HassToggle"}


def _to_jsonable(value: Any) -> Any:
    """Convert SDK objects to plain JSON-like data."""
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {key: _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(item) for item in value]
    return value


def _extract_arguments(kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """Accept a few argument aliases emitted by the model and UI."""
    for key in ("arguments", "input_schema"):
        candidate = kwargs.get(key)
        if isinstance(candidate, dict):
            return candidate

    passthrough = {key: value for key, value in kwargs.items() if key not in CONTROL_FIELDS}
    return passthrough if passthrough else {}


def _build_retry_arguments(tool_name: str, arguments: Dict[str, Any]) -> list[Dict[str, Any]]:
    """Build language-agnostic fallback argument sets for HA target matching."""
    if tool_name not in TARGET_MATCH_TOOLS:
        return []

    retries: list[Dict[str, Any]] = []
    if isinstance(arguments.get("name"), str):
        for redundant_field in ("area_name", "floor_name"):
            if redundant_field in arguments:
                updated = dict(arguments)
                updated.pop(redundant_field, None)
                if updated != arguments and updated not in retries:
                    retries.append(updated)

    return retries


def _should_retry_match_failure(result: Any) -> bool:
    """Return whether a tool result looks like a recoverable HA target-match failure."""
    dumped = _to_jsonable(result)
    if not isinstance(dumped, dict) or not dumped.get("isError"):
        return False

    content = dumped.get("content")
    if not isinstance(content, list):
        return False

    for item in content:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if not isinstance(text, str):
            continue
        if "MatchFailedError" in text or "cannot target all devices" in text:
            return True
    return False


def _extract_result_texts(result: Any) -> list[str]:
    """Extract text payloads from an MCP tool result."""
    dumped = _to_jsonable(result)
    if not isinstance(dumped, dict):
        return []
    content = dumped.get("content")
    if not isinstance(content, list):
        return []

    texts: list[str] = []
    for item in content:
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            texts.append(item["text"])
    return texts


def _build_diagnostic(tool_name: str, arguments: Dict[str, Any], result: Any) -> Dict[str, Any] | None:
    """Translate common HA match failures into actionable diagnostics."""
    texts = _extract_result_texts(result)
    if not texts:
        return None

    combined = "\n".join(texts)
    if "MatchFailedReason.ASSISTANT" in combined:
        return {
            "type": "assistant_exposure",
            "tool_name": tool_name,
            "arguments": arguments,
            "message": "Home Assistant refused the target because it is not exposed to the Assist/MCP assistant.",
            "hint": "Expose the target entity to your Home Assistant voice assistant / MCP integration, then try again.",
        }

    if "cannot target all devices" in combined:
        return {
            "type": "missing_target",
            "tool_name": tool_name,
            "arguments": arguments,
            "message": "Home Assistant rejected the call because it could not resolve a specific target device or entity.",
            "hint": "Use a more specific device name or expose the entity so Home Assistant can match it.",
        }

    return None


def _conversation_api_url(mcp_url: str) -> str:
    """Derive the Home Assistant conversation API URL from the MCP endpoint URL."""
    parts = urlsplit(mcp_url)
    path = parts.path
    if path.endswith("/api/mcp"):
        path = path[: -len("/api/mcp")] + "/api/conversation/process"
    else:
        path = "/api/conversation/process"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


async def _call_assist_command(url: str, token: str, command: str, language: str | None) -> Dict[str, Any]:
    """Send a natural-language command to Home Assistant's conversation API."""
    payload: Dict[str, Any] = {"text": command}
    if language:
        payload["language"] = language

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(_conversation_api_url(url), headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()

    plain = data if isinstance(data, dict) else {"raw": data}
    response_text = None
    try:
        speech = plain.get("response", {}).get("speech", {})
        plain_speech = speech.get("plain", {})
        response_text = plain_speech.get("speech")
    except Exception:
        response_text = None

    return {
        "action": "assist_command",
        "command": command,
        "language": language,
        "response_text": response_text,
        "result": plain,
    }


class HomeAssistant(Tool):
    """Bridge Home Assistant's MCP server through a single tool."""

    name = "home_assistant"
    description = (
        "Bridge to Home Assistant. Prefer assist_command for natural-language home control requests so Home Assistant "
        "can use its own conversation matching. Use discover_tools to inspect available MCP capabilities, call_tool "
        "for exact MCP tool invocations, and get_prompt to fetch Home Assistant prompt guidance."
    )
    parameters_schema = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["assist_command", "discover_tools", "get_prompt", "call_tool"],
                "description": "Which Home Assistant MCP action to perform.",
            },
            "command": {
                "type": "string",
                "description": "Required for assist_command. The user's natural-language Home Assistant request.",
            },
            "language": {
                "type": "string",
                "description": "Optional BCP-47 language code for assist_command, for example zh-CN or en-US.",
            },
            "tool_name": {
                "type": "string",
                "description": "Required for call_tool. Exact MCP tool name returned by discover_tools.",
            },
            "arguments": {
                "type": "object",
                "description": "Arguments for call_tool or get_prompt.",
                "additionalProperties": True,
            },
            "prompt_name": {
                "type": "string",
                "description": "Required for get_prompt. Exact MCP prompt name.",
            },
        },
        "required": ["action"],
        "additionalProperties": False,
    }

    async def __call__(self, deps: ToolDependencies, **kwargs: Any) -> Dict[str, Any]:
        """Dispatch to the configured Home Assistant MCP server."""
        del deps

        enabled = os.getenv("HOME_ASSISTANT_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
        url = os.getenv("HOME_ASSISTANT_MCP_URL", "").strip()
        token = os.getenv("HOME_ASSISTANT_TOKEN", "").strip()
        if not enabled:
            return {
                "error": "Home Assistant is disabled. Enable it from the Credentials page first.",
            }
        if not url:
            return {"error": "HOME_ASSISTANT_MCP_URL is not configured."}
        if not token:
            return {"error": "HOME_ASSISTANT_TOKEN is not configured."}

        action = str(kwargs.get("action") or "").strip()
        command = str(kwargs.get("command") or "").strip()
        language = str(kwargs.get("language") or "").strip() or None
        tool_name = str(kwargs.get("tool_name") or "").strip()
        prompt_name = str(kwargs.get("prompt_name") or "").strip()
        arguments = _extract_arguments(kwargs)
        headers = {"Authorization": f"Bearer {token}"}

        if action == "assist_command":
            if not command:
                return {"error": "command is required for assist_command."}
            try:
                return await _call_assist_command(url, token, command, language)
            except Exception as exc:
                return {"error": f"Home Assistant assist command failed: {type(exc).__name__}: {exc}"}

        try:
            async with streamablehttp_client(
                url,
                headers=headers,
                timeout=timedelta(seconds=30),
                sse_read_timeout=timedelta(seconds=300),
            ) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()

                    if action == "discover_tools":
                        tools_result = await session.list_tools()
                        tools = []
                        for tool in getattr(tools_result, "tools", []):
                            tools.append(
                                {
                                    "name": getattr(tool, "name", ""),
                                    "description": getattr(tool, "description", ""),
                                    "input_schema": _to_jsonable(getattr(tool, "inputSchema", {})),
                                }
                            )
                        return {
                            "action": action,
                            "available_tools": tools,
                        }

                    if action == "get_prompt":
                        if not prompt_name:
                            return {"error": "prompt_name is required for get_prompt."}
                        prompt_result = await session.get_prompt(prompt_name, arguments=arguments or None)
                        return {
                            "action": action,
                            "prompt": _to_jsonable(prompt_result),
                        }

                    if action == "call_tool":
                        if not tool_name:
                            return {"error": "tool_name is required for call_tool."}
                        tool_result = await session.call_tool(tool_name, arguments=arguments or None)
                        if _should_retry_match_failure(tool_result):
                            for candidate_arguments in _build_retry_arguments(tool_name, arguments):
                                tool_result = await session.call_tool(tool_name, arguments=candidate_arguments or None)
                                arguments = candidate_arguments
                                if not _should_retry_match_failure(tool_result):
                                    break
                        return {
                            "action": action,
                            "tool_name": tool_name,
                            "arguments": arguments,
                            "result": _to_jsonable(tool_result),
                            "diagnostic": _build_diagnostic(tool_name, arguments, tool_result),
                        }

                    return {"error": f"Unsupported action: {action}"}
        except Exception as exc:
            return {"error": f"Home Assistant MCP request failed: {type(exc).__name__}: {exc}"}
