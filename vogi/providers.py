"""Where Vogi sends requests. Every provider speaks the OpenAI Chat Completions protocol.

Model ids and base URLs come from dev.meta.ai/docs (read 31.10.2026) and the
hackathon participant guide (Baseten id). Keys come only from the environment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from openai import OpenAI


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    base_url: str
    key_env: str
    model: str
    open_weight: bool
    # Muse Spark on the Model API enforces a JSON schema. For partner hosts we try it,
    # and fall back to a schema in the prompt if the host refuses.
    native_schema: bool = True


PROVIDERS: dict[str, Provider] = {
    "meta": Provider(
        "meta", "Muse Spark 1.3 (Meta Model API)",
        "https://api.meta.ai/v1", "MODEL_API_KEY", "muse-spark-1.3", open_weight=False,
    ),
    "baseten": Provider(
        "baseten", "Muse Spark Open (Baseten)",
        "https://inference.baseten.co/v1", "BASETEN_API_KEY",
        "meta-models/muse-spark-open-1026", open_weight=True,
        # Baseten docs: "All except Muse Spark Open support structured outputs and JSON mode."
        native_schema=False,
    ),
    "fireworks": Provider(
        "fireworks", "Muse Spark Open (Fireworks)",
        "https://api.fireworks.ai/inference/v1", "FIREWORKS_API_KEY",
        "accounts/fireworks/models/muse-spark-open", open_weight=True,
    ),
    "together": Provider(
        "together", "Muse Spark Open (Together AI)",
        "https://api.together.xyz/v1", "TOGETHER_API_KEY",
        "meta-models/muse-spark-open", open_weight=True,
    ),
}


def _custom() -> Provider | None:
    """Any other OpenAI-compatible host (for example a Modal endpoint or a local vLLM)."""
    base = os.environ.get("VOGI_CUSTOM_BASE_URL")
    model = os.environ.get("VOGI_CUSTOM_MODEL")
    if not (base and model):
        return None
    return Provider(
        "custom", os.environ.get("VOGI_CUSTOM_LABEL", f"{model} (custom host)"),
        base, "VOGI_CUSTOM_API_KEY", model,
        open_weight=os.environ.get("VOGI_CUSTOM_OPEN_WEIGHT", "1") == "1",
    )


def load_env_file() -> None:
    """Read KEY=VALUE lines from ~/.config/vogi/env. The file lives outside the repo."""
    path = Path(os.environ.get("VOGI_ENV_FILE", Path.home() / ".config" / "vogi" / "env"))
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def available() -> list[Provider]:
    found = [p for p in PROVIDERS.values() if os.environ.get(p.key_env)]
    custom = _custom()
    if custom:
        found.append(custom)
    return found


def get(provider_id: str | None) -> Provider:
    ready = available()
    if not ready:
        raise RuntimeError(
            "No provider key found. Put MODEL_API_KEY=... in ~/.config/vogi/env (see .env.example)."
        )
    if provider_id is None:
        return ready[0]
    for p in ready:
        if p.id == provider_id:
            return p
    raise KeyError(f"Provider '{provider_id}' has no key configured.")


_clients: dict[str, OpenAI] = {}


def client(p: Provider) -> OpenAI:
    if p.id not in _clients:
        _clients[p.id] = OpenAI(
            base_url=p.base_url, api_key=os.environ.get(p.key_env, "none"), timeout=120,
        )
    return _clients[p.id]
