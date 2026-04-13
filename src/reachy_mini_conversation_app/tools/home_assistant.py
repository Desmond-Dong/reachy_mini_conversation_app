"""Home Assistant MCP bridge tool."""

from __future__ import annotations
import os
from typing import Any, Dict
from datetime import timedelta

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from reachy_mini_conversation_app.tools.core_tools import Tool, ToolDependencies


def _to_jsonable(value: Any) -> Any:
    """Convert SDK objects to plain JSON-like data."""
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {key: _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(item) for item in value]
    return value


class HomeAssistant(Tool):
    """Bridge Home Assistant's MCP server through a single tool."""

    name = "home_assistant"
    description = (
        "Bridge to a Home Assistant MCP server. Use discover_tools first to inspect available Home Assistant "
        "capabilities, then call_tool with the exact MCP tool name and arguments. Use get_prompt to fetch any "
        "Home Assistant prompt guidance exposed by the MCP server."
    )
    parameters_schema = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["discover_tools", "get_prompt", "call_tool"],
                "description": "Which Home Assistant MCP action to perform.",
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
        tool_name = str(kwargs.get("tool_name") or "").strip()
        prompt_name = str(kwargs.get("prompt_name") or "").strip()
        raw_arguments = kwargs.get("arguments") or {}
        arguments = raw_arguments if isinstance(raw_arguments, dict) else {}
        headers = {"Authorization": f"Bearer {token}"}

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
                        result = await session.list_tools()
                        tools = []
                        for tool in getattr(result, "tools", []):
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
                        result = await session.get_prompt(prompt_name, arguments=arguments or None)
                        return {
                            "action": action,
                            "prompt": _to_jsonable(result),
                        }

                    if action == "call_tool":
                        if not tool_name:
                            return {"error": "tool_name is required for call_tool."}
                        result = await session.call_tool(tool_name, arguments=arguments or None)
                        return {
                            "action": action,
                            "tool_name": tool_name,
                            "result": _to_jsonable(result),
                        }

                    return {"error": f"Unsupported action: {action}"}
        except Exception as exc:
            return {"error": f"Home Assistant MCP request failed: {type(exc).__name__}: {exc}"}
