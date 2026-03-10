import base64
import concurrent.futures
import io
import json
import os
import random
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlencode, urlparse

from fastapi import HTTPException
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
from pydantic import BaseModel, Field


class CreateSessionRequest(BaseModel):
    name: str = Field(default="室内设计会话")


class CreateTurnRequest(BaseModel):
    text: str = Field(default="")
    params: Dict[str, Any] = Field(default_factory=dict)
    attachment_asset_ids: List[str] = Field(default_factory=list)
    references: List[Dict[str, Any]] = Field(default_factory=list)
    annotation_context: Dict[str, Any] = Field(default_factory=dict)
    annotation_contexts: List[Dict[str, Any]] = Field(default_factory=list)


class SaveAnnotationRequest(BaseModel):
    snapshot: Dict[str, Any] = Field(default_factory=dict)


class ImportSessionRequest(BaseModel):
    name: Optional[str] = None
    messages: List[Dict[str, Any]] = Field(default_factory=list)


class RuntimeHttpConfigRequest(BaseModel):
    endpoint: str = Field(default="")
    api_key: str = Field(default="")
    text_api_key: str = Field(default="")
    text_model: str = Field(default="gpt-4.1-mini")
    response_format: str = Field(default="url")
    timeout_seconds: int = Field(default=120)
    download_dir: str = Field(default="")


class RuntimeSteppedPromptConfigRequest(BaseModel):
    phase1_template: str = Field(default="")
    phase2_template: str = Field(default="")


class RuntimeConfigRequest(BaseModel):
    http: RuntimeHttpConfigRequest = Field(default_factory=RuntimeHttpConfigRequest)
    stepped_prompt: RuntimeSteppedPromptConfigRequest = Field(default_factory=RuntimeSteppedPromptConfigRequest)


class UpdateWorkspaceModeRequest(BaseModel):
    mode: str = Field(default="image")


class UpdateAssetRequest(BaseModel):
    title: Optional[str] = None
    tags: Optional[List[str]] = None


class MentionStaticUploadResult(BaseModel):
    id: str
    title: str
    order: int
    tags: List[str] = Field(default_factory=list)
    storage_key: str
    file_url: str
    thumbnail_url: str


class WorkflowTemplateCreateRequest(BaseModel):
    name: str = Field(default="未命名模板")
    description: str = Field(default="")
    graph: Dict[str, Any] = Field(default_factory=dict)
    tags: List[str] = Field(default_factory=list)


class WorkflowTemplateUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    graph: Optional[Dict[str, Any]] = None
    tags: Optional[List[str]] = None


class WorkflowPromptCardCreateRequest(BaseModel):
    name: str = Field(default="未命名指令卡片")
    text: str = Field(default="")
    tags: List[str] = Field(default_factory=list)


class WorkflowPromptCardUpdateRequest(BaseModel):
    name: Optional[str] = None
    text: Optional[str] = None
    tags: Optional[List[str]] = None


class WorkflowBridgeConfigRequest(BaseModel):
    base_url: str = Field(default="http://127.0.0.1:9000/api/studio")
    enabled: bool = Field(default=False)


class WorkflowRunPreviewRequest(BaseModel):
    assets: List[Any] = Field(default_factory=list)
    prompts: List[Any] = Field(default_factory=list)
    recipes: List[Dict[str, Any]] = Field(default_factory=list)
    combination_mode: str = Field(default="broadcast")
    variants_per_item: int = Field(default=1)
    concurrency: int = Field(default=2)
    slot_bindings: List[Dict[str, Any]] = Field(default_factory=list)


class WorkflowRunCreateRequest(WorkflowRunPreviewRequest):
    workspace_id: str = Field(default="")
    name: str = Field(default="工作流批运行")


PROJECT_ROOT = Path(__file__).resolve().parent
DATA_ROOT = PROJECT_ROOT / "data"
SESSIONS_DIR = DATA_ROOT / "sessions"
ASSETS_DIR = DATA_ROOT / "assets"
GENERATED_DIR = DATA_ROOT / "generated"
MENTION_SOURCE_DIR = DATA_ROOT / "mention_sources"
SESSIONS_INDEX_FILE = DATA_ROOT / "sessions_index.json"
ASSET_INDEX_FILE = DATA_ROOT / "asset_index.json"
OFFICIAL_ASSETS_FILE = DATA_ROOT / "official_assets.json"
OFFICIAL_PROMPTS_FILE = DATA_ROOT / "official_prompts.json"
RUNTIME_CONFIG_FILE = DATA_ROOT / "runtime_config.json"
MENTION_SETTINGS_FILE = DATA_ROOT / "mention_settings.json"
WORKFLOW_TEMPLATES_FILE = DATA_ROOT / "workflow_templates.json"
WORKFLOW_PROMPT_CARDS_FILE = DATA_ROOT / "workflow_prompt_cards.json"
WORKFLOW_BRIDGE_CONFIG_FILE = DATA_ROOT / "workflow_bridge_config.json"
WORKFLOW_RUNS_DIR = DATA_ROOT / "workflow_runs"
WORKFLOW_RUNS_INDEX_FILE = DATA_ROOT / "workflow_runs_index.json"

IMAGE_EXT_ALLOWLIST = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}

MODEL_OPTIONS = [
    {"id": "xiaodoubao-nano-banana", "name": "xiaodoubao"},
]
ASPECT_RATIO_OPTIONS = ["4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "1:1", "4:5", "5:4", "21:9"]
QUALITY_OPTIONS = ["1K", "2K", "4K"]
COUNT_OPTIONS = [1, 2, 3, 4]
PROTECTED_MENTION_SOURCE_IDS = {"upload", "generated", "saved"}
# 为降低并发下的瞬时网络失败，允许有限次重试；仅瞬时网络错误会进入重试分支。
HTTP_GENERATE_MAX_ATTEMPTS = 3
TEXT_STREAM_TRANSIENT_MAX_RETRIES = 2
TEXT_PROMPT_PACK_TIMEOUT_SECONDS = 90
TEXT_PROMPT_PACK_MODE = "stepped_image_prompts"
TEXT_PROMPT_PACK_MODE_LEGACY = "five_image_prompts"
TEXT_PROMPT_PACK_STAGE_PHASE1 = "phase1_options"
TEXT_PROMPT_PACK_STAGE_PHASE2 = "phase2_prompts"
WORKFLOW_RUN_MAX_TASKS = 50
WORKFLOW_PRIMARY_ASSET_MENTIONS = {"input_asset", "主素材"}
WORKFLOW_MENTION_PATTERN = re.compile(r"(?<![A-Za-z0-9_])@([A-Za-z0-9_\u4e00-\u9fff]+)")

DEFAULT_STEPPED_PROMPT_PHASE1_TEMPLATE = """
你是“全案室内设计大师（20年高品质私宅落地经验）”。
请先做结构锚定分析，再做美学诊断，然后给出改造选项。
严格保留原始硬装结构，不得拆改门窗、吊顶、管线、地面铺贴与动线。
拒绝网红化和不宜居风格，只推荐主流高级、可落地的居住风格。
你必须且只能返回 JSON，不要 Markdown，不要解释，不要前后缀。
固定 JSON 结构：
{"type":"interior_two_stage_v1","phase":"phase1_options","anchors":["..."],"diagnosis":{"pros":["..."],"cons":["..."]},"options":[{"id":"opt1","title":"风格名","summary":"方案摘要"}],"follow_up":"请从3个方案中选择一个，我将生成3条可直接生图提示词。"}。
其中 options 必须严格为 3 项；每项都要明显不同，禁止同义改写。
""".strip()

DEFAULT_STEPPED_PROMPT_PHASE2_TEMPLATE = """
你是“全案室内设计大师（20年高品质私宅落地经验）”。
用户已选择方案：{{selected_option_title}}（{{selected_option_id}}）。
方案摘要：{{selected_option_summary}}。
请基于该方案生成 3 条可直接用于生图模型的中文长提示词。
每条提示词都必须包含：
1) 正向描述（风格、材质、光影、家具形态、镜头视角、画质关键词）；
2) 核心约束（保持原有房间结构不变，保持门窗位置不变，保持吊顶造型不变，保持透视关系）；
3) 负向描述（不要改变户型，不要拆墙，避免样板间式冰冷感，避免过度概念化）。
必须包含关键词：温馨舒适、高档居住氛围、生活气息、AD家居杂志摄影、真实质感、光影层次、色温3000K-4000K（暖白光）、8k超高清真实摄影。
材质必须具体，如全粒面皮革、哑光胡桃木、棉麻窗帘。
三条提示词必须显著不同，禁止同义改写。
你必须且只能返回 JSON，不要 Markdown，不要解释，不要前后缀。
固定 JSON 结构：
{"type":"interior_two_stage_v1","phase":"phase2_prompts","selected_option":{"id":"optX","title":"风格名"},"prompts":[{"id":"p1","title":"提示词1","prompt":"完整中文长提示词"}],"follow_up":"可直接点击任意“生图”生成。"}。
其中 prompts 必须严格为 3 项；每条都必须是可直接生图的完整中文长句。
""".strip()

DEFAULT_RUNTIME_CONFIG: Dict[str, Any] = {
    "http": {
        "endpoint": "",
        "api_key": "",
        "text_api_key": "",
        "text_model": "gpt-4.1-mini",
        "response_format": "url",
        "timeout_seconds": 120,
        "download_dir": "",
    },
    "stepped_prompt": {
        "phase1_template": DEFAULT_STEPPED_PROMPT_PHASE1_TEMPLATE,
        "phase2_template": DEFAULT_STEPPED_PROMPT_PHASE2_TEMPLATE,
    },
}

DEFAULT_WORKFLOW_BRIDGE_CONFIG: Dict[str, Any] = {
    "base_url": "http://127.0.0.1:9000/api/studio",
    "enabled": False,
}


def _runtime_http_api_key_from_env() -> str:
    for name in ("STUDIO_HTTP_API_KEY", "XIAODOUBAO_API_KEY", "HTTP_API_KEY"):
        value = str(os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def _runtime_text_api_key_from_env() -> str:
    for name in ("STUDIO_TEXT_API_KEY", "OPENAI_API_KEY"):
        value = str(os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _parse_iso_datetime(value: Any) -> Optional[datetime]:
    raw = str(value or "").strip()
    if not raw:
        return None
    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        return datetime.fromisoformat(normalized)
    except Exception:
        return None


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Use per-write unique temp files to avoid collisions under concurrent writes.
    fd, tmp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        tmp_path.replace(path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:
                pass


def _ratio_to_size(ratio: str) -> Tuple[int, int]:
    mapping = {
        "1:1": (1024, 1024),
        "4:3": (1280, 960),
        "3:4": (960, 1280),
        "16:9": (1344, 768),
        "9:16": (768, 1344),
        "2:3": (896, 1344),
        "3:2": (1344, 896),
        "4:5": (960, 1200),
        "5:4": (1200, 960),
        "21:9": (1536, 658),
    }
    return mapping.get(ratio, (960, 1280))


def _normalize_quality(quality: str) -> str:
    raw = str(quality or "").strip().upper()
    aliases = {
        "STANDARD": "1K",
        "HD": "2K",
        "ULTRA": "4K",
        "1K": "1K",
        "2K": "2K",
        "4K": "4K",
    }
    return aliases.get(raw, "2K")


def _normalize_aspect_ratio(ratio: str) -> str:
    val = (ratio or "3:4").strip()
    if val not in set(ASPECT_RATIO_OPTIONS):
        return "3:4"
    return val


def _normalize_count(count: int) -> int:
    try:
        val = int(count)
    except Exception:
        val = 1
    if val not in set(COUNT_OPTIONS):
        return 1
    return val


def _normalize_composer_mode(mode: Any) -> str:
    value = str(mode or "").strip().lower()
    if value == "text":
        return "text"
    return "image"


def _normalize_stepped_prompt_config(payload: Any) -> Dict[str, str]:
    default_payload = {
        "phase1_template": DEFAULT_STEPPED_PROMPT_PHASE1_TEMPLATE,
        "phase2_template": DEFAULT_STEPPED_PROMPT_PHASE2_TEMPLATE,
    }
    if not isinstance(payload, dict):
        return dict(default_payload)
    phase1 = str(payload.get("phase1_template") or "").strip()
    phase2 = str(payload.get("phase2_template") or "").strip()
    return {
        "phase1_template": phase1 or default_payload["phase1_template"],
        "phase2_template": phase2 or default_payload["phase2_template"],
    }


def _normalize_runtime_config(payload: Any) -> Dict[str, Any]:
    cfg = {
        "http": {
            "endpoint": "",
            "api_key": "",
            "text_api_key": "",
            "text_model": "gpt-4.1-mini",
            "response_format": "url",
            "timeout_seconds": 120,
            "download_dir": "",
        },
        "stepped_prompt": _normalize_stepped_prompt_config(None),
    }
    if not isinstance(payload, dict):
        return cfg

    http_payload = payload.get("http")
    if isinstance(http_payload, dict):
        cfg["http"]["endpoint"] = str(http_payload.get("endpoint") or "").strip()
        cfg["http"]["api_key"] = str(http_payload.get("api_key") or "")
        cfg["http"]["text_api_key"] = str(http_payload.get("text_api_key") or "")
        cfg["http"]["text_model"] = str(http_payload.get("text_model") or "gpt-4.1-mini").strip() or "gpt-4.1-mini"
        response_format = str(http_payload.get("response_format") or "url").strip().lower()
        cfg["http"]["response_format"] = "b64_json" if response_format == "b64_json" else "url"

        try:
            timeout = int(http_payload.get("timeout_seconds") or 120)
        except Exception:
            timeout = 120
        cfg["http"]["timeout_seconds"] = max(5, min(timeout, 600))
        cfg["http"]["download_dir"] = str(http_payload.get("download_dir") or "").strip()

    cfg["stepped_prompt"] = _normalize_stepped_prompt_config(payload.get("stepped_prompt"))

    return cfg


def _default_mention_settings(prompts: List[Dict[str, Any]], taxonomies: Dict[str, List[str]]) -> Dict[str, Any]:
    return {
        "composer_placeholder": "描述你的想法，输入@触发选择素材，单条消息最多9张素材",
        "search_placeholder": "搜索素材标题...",
        "upload_button_text": "点击 / 拖拽 / 粘贴 上传",
        "sources": [
            {"id": "upload", "name": "上传", "enabled": True, "order": 1, "kind": "dynamic", "content_type": "image", "items": []},
            {"id": "generated", "name": "生成", "enabled": True, "order": 2, "kind": "dynamic", "content_type": "image", "items": []},
            {"id": "saved", "name": "素材库", "enabled": True, "order": 3, "kind": "dynamic", "content_type": "image", "items": []},
            {"id": "official", "name": "官方", "enabled": True, "order": 4, "kind": "dynamic", "content_type": "image", "items": []},
        ],
        "official_prompts": prompts,
        "official_taxonomies": taxonomies,
    }


def _normalize_source_content_type(value: Any) -> str:
    return "text" if str(value or "").strip().lower() == "text" else "image"


def _normalize_prompt_pack_mode(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {TEXT_PROMPT_PACK_MODE, TEXT_PROMPT_PACK_MODE_LEGACY}:
        return TEXT_PROMPT_PACK_MODE
    return ""


def _normalize_prompt_pack_stage(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized == TEXT_PROMPT_PACK_STAGE_PHASE2:
        return TEXT_PROMPT_PACK_STAGE_PHASE2
    return TEXT_PROMPT_PACK_STAGE_PHASE1


def _normalize_prompt_pack_selected_option(params: Any) -> Dict[str, str]:
    if not isinstance(params, dict):
        return {}
    nested = params.get("selected_option")
    option_id = str(params.get("selected_option_id") or "").strip()
    option_title = str(params.get("selected_option_title") or "").strip()
    option_summary = str(params.get("selected_option_summary") or "").strip()
    if isinstance(nested, dict):
        option_id = str(nested.get("id") or option_id).strip()
        option_title = str(nested.get("title") or option_title).strip()
        option_summary = str(nested.get("summary") or option_summary).strip()
    payload: Dict[str, str] = {}
    if option_id:
        payload["id"] = option_id
    if option_title:
        payload["title"] = option_title
    if option_summary:
        payload["summary"] = option_summary
    return payload


def _render_prompt_template(template: str, variables: Dict[str, str]) -> str:
    result = str(template or "")
    for key, value in variables.items():
        token = f"{{{{{key}}}}}"
        result = result.replace(token, str(value or ""))
    return result.strip()


def _stepped_prompt_json_instruction(stage: str, selected_option: Dict[str, str], prompt_config: Dict[str, Any]) -> str:
    normalized_prompt_config = _normalize_stepped_prompt_config(prompt_config)
    option_id = str(selected_option.get("id") or "").strip() or "optX"
    option_title = str(selected_option.get("title") or "").strip() or "已选方案"
    option_summary = str(selected_option.get("summary") or "").strip() or "（未提供摘要）"
    option_context = f"{option_title}（{option_id}）"
    if option_summary:
        option_context = f"{option_context}；摘要：{option_summary}"
    variables = {
        "selected_option_id": option_id,
        "selected_option_title": option_title,
        "selected_option_summary": option_summary,
        "selected_option_context": option_context,
    }
    if stage == TEXT_PROMPT_PACK_STAGE_PHASE2:
        template = normalized_prompt_config["phase2_template"]
        return _render_prompt_template(template, variables)
    template = normalized_prompt_config["phase1_template"]
    return _render_prompt_template(template, variables)


def _normalize_source_item(item: Any, index: int, source_content_type: str = "image") -> Dict[str, Any]:
    if not isinstance(item, dict):
        item = {}
    sid = str(item.get("id") or f"static-{uuid.uuid4().hex[:10]}")
    item_type = _normalize_source_content_type(item.get("item_type") or source_content_type)
    title_default = "未命名文本" if item_type == "text" else "未命名素材"
    title = str(item.get("title") or title_default).strip() or title_default
    tags_raw = item.get("tags")
    tags: List[str] = []
    if isinstance(tags_raw, list):
        for v in tags_raw:
            text = str(v or "").strip()
            if text:
                tags.append(text)
    try:
        order = int(item.get("order") or (index + 1))
    except Exception:
        order = index + 1
    content = str(item.get("content") or "").strip() if item_type == "text" else ""
    storage_key = str(item.get("storage_key") or "").strip() if item_type == "image" else ""
    return {
        "id": sid,
        "title": title,
        "order": max(1, order),
        "tags": tags,
        "item_type": item_type,
        "content": content,
        "storage_key": storage_key,
    }


def _normalize_mention_settings(payload: Any, default_payload: Dict[str, Any]) -> Dict[str, Any]:
    base = dict(default_payload)
    if not isinstance(payload, dict):
        payload = {}

    composer_placeholder = str(payload.get("composer_placeholder") or base.get("composer_placeholder") or "").strip()
    search_placeholder = str(payload.get("search_placeholder") or base.get("search_placeholder") or "").strip()
    upload_button_text = str(payload.get("upload_button_text") or base.get("upload_button_text") or "").strip()

    sources_raw = payload.get("sources")
    if not isinstance(sources_raw, list):
        sources_raw = base.get("sources", [])
    sources: List[Dict[str, Any]] = []
    for idx, source in enumerate(sources_raw):
        if not isinstance(source, dict):
            continue
        source_id = str(source.get("id") or f"source-{uuid.uuid4().hex[:8]}").strip() or f"source-{uuid.uuid4().hex[:8]}"
        source_name = str(source.get("name") or source_id).strip() or source_id
        source_kind = str(source.get("kind") or "dynamic").strip().lower()
        if source_kind not in {"dynamic", "static"}:
            source_kind = "dynamic"
        try:
            order = int(source.get("order") or (idx + 1))
        except Exception:
            order = idx + 1
        enabled = bool(source.get("enabled", True))
        source_content_type = "image"
        if source_kind == "static":
            source_content_type = _normalize_source_content_type(source.get("content_type") or "image")
        items_raw = source.get("items")
        items: List[Dict[str, Any]] = []
        if source_kind == "static" and isinstance(items_raw, list):
            items = [_normalize_source_item(item, i, source_content_type) for i, item in enumerate(items_raw)]
            items.sort(key=lambda x: int(x.get("order") or 0))
        sources.append(
            {
                "id": source_id,
                "name": source_name,
                "enabled": enabled,
                "order": max(1, order),
                "kind": source_kind,
                "content_type": source_content_type,
                "items": items,
            }
        )
    sources.sort(key=lambda x: int(x.get("order") or 0))

    prompts_raw = payload.get("official_prompts")
    if not isinstance(prompts_raw, list):
        prompts_raw = base.get("official_prompts", [])
    prompts: List[Dict[str, Any]] = []
    for idx, item in enumerate(prompts_raw):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        content = str(item.get("content") or "").strip()
        if not title and not content:
            continue
        prompts.append(
            {
                "id": str(item.get("id") or f"prompt-{idx + 1:03d}").strip() or f"prompt-{idx + 1:03d}",
                "title": title or f"提示词{idx + 1}",
                "content": content,
            }
        )

    tax_raw = payload.get("official_taxonomies")
    if not isinstance(tax_raw, dict):
        tax_raw = base.get("official_taxonomies", {})
    taxonomies: Dict[str, List[str]] = {}
    for key in ("scene", "style", "material", "lighting"):
        values = tax_raw.get(key)
        out: List[str] = []
        if isinstance(values, list):
            for value in values:
                text = str(value or "").strip()
                if text and text not in out:
                    out.append(text)
        taxonomies[key] = out

    return {
        "composer_placeholder": composer_placeholder or base.get("composer_placeholder") or "",
        "search_placeholder": search_placeholder or base.get("search_placeholder") or "",
        "upload_button_text": upload_button_text or base.get("upload_button_text") or "",
        "sources": sources,
        "official_prompts": prompts,
        "official_taxonomies": taxonomies,
    }


def _public_asset_from_record(asset: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(asset)
    kind = out.get("kind")
    aid = out.get("id")
    if not aid:
        return out
    if kind == "official":
        out["file_url"] = f"/api/v1/official-assets/{aid}/preview"
        out["thumbnail_url"] = f"/api/v1/official-assets/{aid}/preview?thumb=1"
    else:
        out["file_url"] = f"/api/v1/assets/{aid}/file"
        out["thumbnail_url"] = f"/api/v1/assets/{aid}/file?thumb=1"
    return out


def _public_deleted_asset_stub(ref: Dict[str, Any]) -> Dict[str, Any]:
    rid = str(ref.get("id") or f"deleted-{uuid.uuid4().hex[:8]}")
    title = str(ref.get("title") or "已删除图片")
    return {
        "id": rid,
        "kind": "deleted",
        "title": title,
        "file_url": "",
        "thumbnail_url": "",
        "deleted": True,
    }


def _merge_session_messages(existing_messages: Any, incoming_messages: Any) -> List[Dict[str, Any]]:
    existing = existing_messages if isinstance(existing_messages, list) else []
    incoming = incoming_messages if isinstance(incoming_messages, list) else []
    merged: List[Dict[str, Any]] = []
    pos_by_id: Dict[str, int] = {}

    def _append_or_replace(item: Any) -> None:
        if not isinstance(item, dict):
            return
        mid = str(item.get("id") or "").strip()
        if not mid:
            merged.append(item)
            return
        prev_index = pos_by_id.get(mid)
        if prev_index is None:
            pos_by_id[mid] = len(merged)
            merged.append(item)
            return
        merged[prev_index] = item

    for msg in existing:
        _append_or_replace(msg)
    for msg in incoming:
        _append_or_replace(msg)

    return merged


class StudioService:
    def __init__(self):
        self._session_locks_guard = threading.Lock()
        self._session_locks: Dict[str, threading.Lock] = {}
        self._workflow_run_locks_guard = threading.Lock()
        self._workflow_run_locks: Dict[str, threading.Lock] = {}
        self._workflow_runner_guard = threading.Lock()
        self._workflow_runner_threads: Dict[str, threading.Thread] = {}
        self.ensure_runtime()

    def _get_session_lock(self, sid: str) -> threading.Lock:
        key = str(sid or "").strip()
        with self._session_locks_guard:
            lock = self._session_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._session_locks[key] = lock
            return lock

    def _get_workflow_run_lock(self, run_id: str) -> threading.Lock:
        key = str(run_id or "").strip()
        with self._workflow_run_locks_guard:
            lock = self._workflow_run_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._workflow_run_locks[key] = lock
            return lock

    def ensure_runtime(self) -> None:
        DATA_ROOT.mkdir(parents=True, exist_ok=True)
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        ASSETS_DIR.mkdir(parents=True, exist_ok=True)
        GENERATED_DIR.mkdir(parents=True, exist_ok=True)
        MENTION_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
        WORKFLOW_RUNS_DIR.mkdir(parents=True, exist_ok=True)
        if not SESSIONS_INDEX_FILE.exists():
            _write_json(SESSIONS_INDEX_FILE, [])
        if not ASSET_INDEX_FILE.exists():
            _write_json(ASSET_INDEX_FILE, {})
        if not OFFICIAL_ASSETS_FILE.exists():
            self._seed_official_assets()
        if not OFFICIAL_PROMPTS_FILE.exists():
            self._seed_official_prompts()
        if not RUNTIME_CONFIG_FILE.exists():
            _write_json(RUNTIME_CONFIG_FILE, DEFAULT_RUNTIME_CONFIG)
        if not MENTION_SETTINGS_FILE.exists():
            _write_json(
                MENTION_SETTINGS_FILE,
                _default_mention_settings(
                    self.get_official_prompts(),
                    self.list_official_taxonomies(),
                ),
            )
        if not WORKFLOW_TEMPLATES_FILE.exists():
            _write_json(WORKFLOW_TEMPLATES_FILE, [])
        if not WORKFLOW_PROMPT_CARDS_FILE.exists():
            _write_json(WORKFLOW_PROMPT_CARDS_FILE, [])
        if not WORKFLOW_BRIDGE_CONFIG_FILE.exists():
            _write_json(WORKFLOW_BRIDGE_CONFIG_FILE, DEFAULT_WORKFLOW_BRIDGE_CONFIG)
        if not WORKFLOW_RUNS_INDEX_FILE.exists():
            _write_json(WORKFLOW_RUNS_INDEX_FILE, [])

    def _seed_official_assets(self) -> None:
        scenes = ["客厅", "卧室", "餐厅", "厨房", "书房", "卫生间", "玄关", "阳台"]
        styles = ["现代极简", "侘寂", "奶油风", "中古", "法式", "北欧", "新中式", "工业"]
        materials = ["木饰面", "大理石", "微水泥", "玻璃", "金属", "布艺", "皮革", "藤编"]
        lights = ["自然采光", "暖光氛围", "冷调灯光", "夜景照明"]
        colors = ["#E8D7C6", "#D7C6B3", "#CBB59C", "#E9DCC8", "#D8BFA7", "#B8A38D", "#BFAE9B", "#9F8B76"]

        items: List[Dict[str, Any]] = []
        idx = 0
        for scene in scenes:
            for style in styles:
                for material in materials:
                    lighting = lights[(idx + len(style)) % len(lights)]
                    color = colors[idx % len(colors)]
                    item = {
                        "id": f"official-{idx + 1:03d}",
                        "kind": "official",
                        "title": f"{style}{scene} - {material}",
                        "scene": scene,
                        "style": style,
                        "material": material,
                        "lighting": lighting,
                        "tags": [scene, style, material, lighting],
                        "color": color,
                        "created_at": _now_iso(),
                        "annotation_snapshot": {},
                    }
                    items.append(item)
                    idx += 1
                    if idx >= 80:
                        _write_json(OFFICIAL_ASSETS_FILE, items)
                        return
        _write_json(OFFICIAL_ASSETS_FILE, items)

    def _seed_official_prompts(self) -> None:
        prompts = [
            {"id": "prompt-001", "title": "客厅氛围优化", "content": "保留结构，强化空间层次、材质细节和暖光氛围。"},
            {"id": "prompt-002", "title": "卧室收纳升级", "content": "在不改动硬装前提下提升收纳效率和整洁感。"},
            {"id": "prompt-003", "title": "餐厨一体优化", "content": "提升通透感和动线，增加合理照明层次。"},
            {"id": "prompt-004", "title": "法式线条演绎", "content": "加入法式线条、石膏线和柔和材质过渡，保持自然比例。"},
            {"id": "prompt-005", "title": "中古风材质替换", "content": "将主材替换为中古木质与复古金属，保留功能性。"},
        ]
        _write_json(OFFICIAL_PROMPTS_FILE, prompts)

    def _load_sessions_index(self) -> List[Dict[str, Any]]:
        index = _read_json(SESSIONS_INDEX_FILE, [])
        return index if isinstance(index, list) else []

    def _save_sessions_index(self, index: List[Dict[str, Any]]) -> None:
        _write_json(SESSIONS_INDEX_FILE, index)

    def _load_asset_index(self) -> Dict[str, Dict[str, Any]]:
        index = _read_json(ASSET_INDEX_FILE, {})
        return index if isinstance(index, dict) else {}

    def _save_asset_index(self, index: Dict[str, Dict[str, Any]]) -> None:
        _write_json(ASSET_INDEX_FILE, index)

    def _session_file(self, sid: str) -> Path:
        return SESSIONS_DIR / f"{sid}.json"

    def _load_session_raw(self, sid: str) -> Optional[Dict[str, Any]]:
        path = self._session_file(sid)
        if not path.exists():
            return None
        data = _read_json(path, None)
        return data if isinstance(data, dict) else None

    def _save_session_raw(self, session: Dict[str, Any]) -> None:
        sid = session["id"]
        lock = self._get_session_lock(sid)
        with lock:
            current = self._load_session_raw(sid) or {}
            merged_session = dict(current)
            merged_session.update(session)
            merged_session["composer_mode"] = _normalize_composer_mode(merged_session.get("composer_mode"))
            merged_session["messages"] = _merge_session_messages(current.get("messages"), session.get("messages"))

            _write_json(self._session_file(sid), merged_session)

            index = self._load_sessions_index()
            found = False
            for item in index:
                if item.get("id") == sid:
                    item["name"] = merged_session.get("name", "")
                    item["updated_at"] = merged_session.get("updated_at", _now_iso())
                    item["created_at"] = merged_session.get("created_at", item.get("created_at", _now_iso()))
                    item["composer_mode"] = merged_session.get("composer_mode", "image")
                    found = True
                    break
            if not found:
                index.append(
                    {
                        "id": sid,
                        "name": merged_session.get("name", "未命名会话"),
                        "created_at": merged_session.get("created_at", _now_iso()),
                        "updated_at": merged_session.get("updated_at", _now_iso()),
                        "composer_mode": merged_session.get("composer_mode", "image"),
                    }
                )
            index.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
            self._save_sessions_index(index)

    def _running_message_stale_seconds(self) -> int:
        config = self.get_runtime_config()
        http_cfg = config.get("http") if isinstance(config.get("http"), dict) else {}
        try:
            timeout_seconds = int(http_cfg.get("timeout_seconds") or 120)
        except Exception:
            timeout_seconds = 120
        timeout_seconds = max(5, min(timeout_seconds, 600))
        return max(180, min(timeout_seconds * 2, 1800))

    def _repair_stale_running_messages(self, session: Dict[str, Any]) -> bool:
        messages = session.get("messages")
        if not isinstance(messages, list) or not messages:
            return False
        now = datetime.now()
        stale_after = self._running_message_stale_seconds()
        changed = False
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            if str(msg.get("role") or "").strip() != "assistant":
                continue
            if str(msg.get("status") or "").strip() != "running":
                continue
            created_at = _parse_iso_datetime(msg.get("created_at"))
            if not created_at:
                continue
            if (now - created_at).total_seconds() < stale_after:
                continue
            mode = _normalize_composer_mode(msg.get("mode"))
            msg["status"] = "failed"
            msg["text"] = "文本任务已超时或中断，请重试。" if mode == "text" else "生成任务已超时或中断，请重试。"
            changed = True
        if changed:
            session["updated_at"] = _now_iso()
        return changed

    def _resolve_asset(self, asset_id: str) -> Optional[Dict[str, Any]]:
        if not asset_id:
            return None
        asset = self._load_asset_index().get(asset_id)
        if asset:
            return asset
        official = self.get_official_asset(asset_id)
        if official:
            return official
        return self._resolve_static_source_asset(asset_id)

    def _resolve_static_source_asset(self, item_id: str) -> Optional[Dict[str, Any]]:
        settings = _read_json(MENTION_SETTINGS_FILE, {})
        if not isinstance(settings, dict):
            return None
        for source in settings.get("sources") or []:
            if not isinstance(source, dict):
                continue
            if str(source.get("kind") or "") != "static":
                continue
            for item in source.get("items") or []:
                if not isinstance(item, dict):
                    continue
                if str(item.get("id") or "") != item_id:
                    continue
                item_type = _normalize_source_content_type(item.get("item_type") or source.get("content_type") or "image")
                if item_type != "image":
                    return None
                storage_key = str(item.get("storage_key") or "").strip()
                if not storage_key:
                    return None
                path = (MENTION_SOURCE_DIR / storage_key).resolve()
                base = MENTION_SOURCE_DIR.resolve()
                if not str(path).startswith(str(base)):
                    return None
                return {
                    "id": item_id,
                    "kind": "mention_static",
                    "title": str(item.get("title") or "静态素材"),
                    "file_path": str(path),
                    "tags": item.get("tags") if isinstance(item.get("tags"), list) else [],
                    "created_at": _now_iso(),
                }
        return None

    def _hydrate_message_assets(self, msg: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(msg)
        out["mode"] = _normalize_composer_mode(out.get("mode"))
        attachment_ids = out.get("attachment_asset_ids") or []
        image_ids = out.get("image_asset_ids") or []
        attachment_list: List[Dict[str, Any]] = []
        for aid in attachment_ids:
            asset = self._resolve_asset(str(aid))
            if asset:
                attachment_list.append(_public_asset_from_record(asset))
            else:
                attachment_list.append(_public_deleted_asset_stub({"id": str(aid), "title": "已删除素材"}))
        for ref in out.get("deleted_attachment_refs") or []:
            if not isinstance(ref, dict):
                continue
            rid = str(ref.get("id") or "").strip()
            if rid and any(str(item.get("id") or "") == rid for item in attachment_list):
                continue
            attachment_list.append(_public_deleted_asset_stub(ref))
        out["attachments"] = attachment_list

        image_list: List[Dict[str, Any]] = []
        for aid in image_ids:
            asset = self._resolve_asset(str(aid))
            if asset:
                image_list.append(_public_asset_from_record(asset))
            else:
                image_list.append(_public_deleted_asset_stub({"id": str(aid), "title": "已删除图片"}))
        for ref in out.get("deleted_image_refs") or []:
            if not isinstance(ref, dict):
                continue
            rid = str(ref.get("id") or "").strip()
            if rid and any(str(item.get("id") or "") == rid for item in image_list):
                continue
            image_list.append(_public_deleted_asset_stub(ref))
        out["images"] = image_list
        references = out.get("references") or []
        normalized_refs: List[Dict[str, Any]] = []
        for ref in references:
            if not isinstance(ref, dict):
                continue
            item = dict(ref)
            aid = str(item.get("asset_id") or "").strip()
            if aid:
                asset = self._resolve_asset(aid)
                if asset:
                    item["asset"] = _public_asset_from_record(asset)
            normalized_refs.append(item)
        out["references"] = normalized_refs
        return out

    def get_options(self) -> Dict[str, Any]:
        return {
            "models": MODEL_OPTIONS,
            "aspect_ratios": ASPECT_RATIO_OPTIONS,
            "qualities": QUALITY_OPTIONS,
            "counts": COUNT_OPTIONS,
        }

    def get_runtime_config(self) -> Dict[str, Any]:
        loaded = _read_json(RUNTIME_CONFIG_FILE, DEFAULT_RUNTIME_CONFIG)
        normalized = _normalize_runtime_config(loaded)
        if loaded != normalized:
            _write_json(RUNTIME_CONFIG_FILE, normalized)
        image_env_managed = bool(_runtime_http_api_key_from_env())
        text_env_managed = bool(_runtime_text_api_key_from_env())
        if image_env_managed:
            normalized["http"]["api_key"] = ""
        if text_env_managed:
            normalized["http"]["text_api_key"] = ""
        normalized["http"]["api_key_managed_by_env"] = image_env_managed
        normalized["http"]["text_api_key_managed_by_env"] = text_env_managed
        return normalized

    def update_runtime_config(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        normalized = _normalize_runtime_config(payload)
        if _runtime_http_api_key_from_env():
            normalized["http"]["api_key"] = ""
        if _runtime_text_api_key_from_env():
            normalized["http"]["text_api_key"] = ""
        _write_json(RUNTIME_CONFIG_FILE, normalized)
        return normalized

    def select_download_directory(self) -> Dict[str, Any]:
        try:
            result = subprocess.run(
                ["osascript", "-e", 'POSIX path of (choose folder with prompt "选择图片下载目录")'],
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"打开目录选择器失败: {exc}") from exc

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            if "User canceled" in err:
                raise HTTPException(status_code=400, detail="未选择目录")
            raise HTTPException(status_code=500, detail=f"打开目录选择器失败: {err or '未知错误'}")

        path = str(result.stdout or "").strip()
        if not path:
            raise HTTPException(status_code=400, detail="未选择目录")
        return {"path": str(Path(path).expanduser().resolve())}

    def _mention_settings_with_urls(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(settings)
        sources: List[Dict[str, Any]] = []
        for source in settings.get("sources") or []:
            if not isinstance(source, dict):
                continue
            source_kind = str(source.get("kind") or "dynamic").strip().lower()
            source_content_type = _normalize_source_content_type(source.get("content_type") or "image")
            item_list: List[Dict[str, Any]] = []
            for item in source.get("items") or []:
                if not isinstance(item, dict):
                    continue
                item_out = dict(item)
                item_id = str(item.get("id") or "").strip()
                item_type = _normalize_source_content_type(item.get("item_type") or source_content_type)
                item_out["item_type"] = item_type
                if item_type == "text":
                    item_out["storage_key"] = ""
                if item_id and item_type == "image":
                    item_out["file_url"] = f"/api/v1/mention-settings/items/{item_id}/file"
                    item_out["thumbnail_url"] = f"/api/v1/mention-settings/items/{item_id}/file?thumb=1"
                item_list.append(item_out)
            source_out = dict(source)
            source_out["kind"] = "static" if source_kind == "static" else "dynamic"
            source_out["content_type"] = source_content_type
            source_out["items"] = item_list
            sources.append(source_out)
        out["sources"] = sources
        return out

    def get_mention_settings(self) -> Dict[str, Any]:
        default_payload = _default_mention_settings(
            self.get_official_prompts(),
            self.list_official_taxonomies(),
        )
        loaded = _read_json(MENTION_SETTINGS_FILE, default_payload)
        normalized = _normalize_mention_settings(loaded, default_payload)
        if loaded != normalized:
            _write_json(MENTION_SETTINGS_FILE, normalized)
        return self._mention_settings_with_urls(normalized)

    def update_mention_settings(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        default_payload = _default_mention_settings(
            self.get_official_prompts(),
            self.list_official_taxonomies(),
        )
        current = _normalize_mention_settings(_read_json(MENTION_SETTINGS_FILE, default_payload), default_payload)
        updated = _normalize_mention_settings(payload, default_payload)
        updated_sources = updated.get("sources") if isinstance(updated, dict) else []
        source_by_id: Dict[str, Dict[str, Any]] = {}
        if isinstance(updated_sources, list):
            for source in updated_sources:
                if not isinstance(source, dict):
                    continue
                source_id = str(source.get("id") or "").strip()
                if source_id:
                    source_by_id[source_id] = source

        missing_source_ids = sorted([sid for sid in PROTECTED_MENTION_SOURCE_IDS if sid not in source_by_id])
        if missing_source_ids:
            raise HTTPException(
                status_code=400,
                detail=f"默认来源不可删除: {', '.join(missing_source_ids)}",
            )
        invalid_kind_ids = sorted(
            [
                sid
                for sid in PROTECTED_MENTION_SOURCE_IDS
                if str((source_by_id.get(sid) or {}).get("kind") or "").strip().lower() != "dynamic"
            ]
        )
        if invalid_kind_ids:
            raise HTTPException(
                status_code=400,
                detail=f"默认来源类型不可修改: {', '.join(invalid_kind_ids)}",
            )

        current_storage: Dict[str, str] = {}
        for source in current.get("sources") or []:
            for item in source.get("items") or []:
                item_id = str(item.get("id") or "").strip()
                storage_key = str(item.get("storage_key") or "").strip()
                if item_id and storage_key:
                    current_storage[item_id] = storage_key

        updated_item_ids: set = set()
        for source in updated.get("sources") or []:
            for item in source.get("items") or []:
                item_id = str(item.get("id") or "").strip()
                if item_id:
                    updated_item_ids.add(item_id)

        to_delete_ids = [item_id for item_id in current_storage if item_id not in updated_item_ids]
        for item_id in to_delete_ids:
            storage_key = current_storage.get(item_id) or ""
            if not storage_key:
                continue
            path = (MENTION_SOURCE_DIR / storage_key).resolve()
            base = MENTION_SOURCE_DIR.resolve()
            if str(path).startswith(str(base)) and path.exists():
                try:
                    path.unlink()
                except Exception:
                    pass

        _write_json(MENTION_SETTINGS_FILE, updated)
        return self._mention_settings_with_urls(updated)

    def upload_mention_static_item(self, source_id: str, filename: str, content: bytes) -> Dict[str, Any]:
        if not content:
            raise HTTPException(status_code=400, detail="上传内容为空")
        sid = str(source_id or "custom").strip() or "custom"
        settings = self.get_mention_settings()
        source = None
        for item in settings.get("sources") or []:
            if not isinstance(item, dict):
                continue
            if str(item.get("id") or "").strip() != sid:
                continue
            source = item
            break
        if not source:
            raise HTTPException(status_code=404, detail="来源不存在")
        if str(source.get("kind") or "").strip().lower() != "static":
            raise HTTPException(status_code=400, detail="仅静态来源支持上传素材")
        if _normalize_source_content_type(source.get("content_type") or "image") != "image":
            raise HTTPException(status_code=400, detail="文字类型来源不支持上传图片素材")

        safe_sid = "".join(ch for ch in sid if ch.isalnum() or ch in {"-", "_"}).strip() or "custom"
        source_dir = MENTION_SOURCE_DIR / safe_sid
        source_dir.mkdir(parents=True, exist_ok=True)
        suffix = (Path(filename or "").suffix or ".png").lower()
        if suffix not in IMAGE_EXT_ALLOWLIST:
            suffix = ".png"
        item_id = f"static-{uuid.uuid4().hex[:10]}"
        file_name = f"{item_id}{suffix}"
        save_path = source_dir / file_name
        with save_path.open("wb") as f:
            f.write(content)
        storage_key = f"{safe_sid}/{file_name}"
        return MentionStaticUploadResult(
            id=item_id,
            title=(Path(filename or file_name).stem or item_id),
            order=1,
            tags=[],
            storage_key=storage_key,
            file_url=f"/api/v1/mention-settings/items/{item_id}/file",
            thumbnail_url=f"/api/v1/mention-settings/items/{item_id}/file?thumb=1",
        ).model_dump()

    def _find_static_item_storage_key(self, item_id: str) -> Optional[str]:
        settings = _read_json(MENTION_SETTINGS_FILE, {})
        if not isinstance(settings, dict):
            return None
        for source in settings.get("sources") or []:
            if not isinstance(source, dict):
                continue
            for item in source.get("items") or []:
                if not isinstance(item, dict):
                    continue
                if str(item.get("id") or "") == item_id:
                    item_type = _normalize_source_content_type(item.get("item_type") or source.get("content_type") or "image")
                    if item_type != "image":
                        return None
                    storage_key = str(item.get("storage_key") or "").strip()
                    return storage_key or None
        return None

    def get_mention_static_item_file_response(self, item_id: str, thumb: bool = False):
        storage_key = self._find_static_item_storage_key(item_id)
        if not storage_key:
            raise HTTPException(status_code=404, detail="素材不存在")
        file_path = (MENTION_SOURCE_DIR / storage_key).resolve()
        base = MENTION_SOURCE_DIR.resolve()
        if not str(file_path).startswith(str(base)) or not file_path.exists():
            raise HTTPException(status_code=404, detail="素材文件不存在")
        if not thumb:
            return FileResponse(str(file_path))
        with Image.open(file_path).convert("RGB") as img:
            img.thumbnail((360, 240))
            out = io.BytesIO()
            img.save(out, format="PNG")
        return Response(content=out.getvalue(), media_type="image/png")

    def list_sessions(self) -> List[Dict[str, Any]]:
        items = self._load_sessions_index()
        items.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
        return items

    def create_session(self, name: Optional[str] = None) -> Dict[str, Any]:
        now = _now_iso()
        sid = f"workspace-{uuid.uuid4().hex[:10]}"
        session = {
            "id": sid,
            "name": (name or "室内设计会话").strip() or "室内设计会话",
            "composer_mode": "image",
            "created_at": now,
            "updated_at": now,
            "messages": [],
        }
        self._save_session_raw(session)
        return session

    def import_session(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        created = self.create_session(name=payload.get("name"))
        raw = self._load_session_raw(created["id"]) or created
        raw["composer_mode"] = _normalize_composer_mode(payload.get("composer_mode"))
        messages = payload.get("messages") or []
        normalized: List[Dict[str, Any]] = []
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            role = msg.get("role")
            if role not in {"user", "assistant"}:
                continue
            normalized.append(
                {
                    "id": f"msg-{uuid.uuid4().hex[:10]}",
                    "role": role,
                    "text": str(msg.get("text") or "").strip(),
                    "params": msg.get("params") if isinstance(msg.get("params"), dict) else {},
                    "attachment_asset_ids": [],
                    "image_asset_ids": [],
                    "mode": _normalize_composer_mode(msg.get("mode")),
                    "status": "completed",
                    "created_at": _now_iso(),
                }
            )
        raw["messages"] = normalized
        raw["updated_at"] = _now_iso()
        self._save_session_raw(raw)
        return self.get_session_or_404(raw["id"])

    def get_session(self, sid: str) -> Optional[Dict[str, Any]]:
        raw = self._load_session_raw(sid)
        if not raw:
            return None
        changed = False
        normalized_mode = _normalize_composer_mode(raw.get("composer_mode"))
        if raw.get("composer_mode") != normalized_mode:
            raw["composer_mode"] = normalized_mode
            changed = True
        if self._repair_stale_running_messages(raw):
            changed = True
        if changed:
            self._save_session_raw(raw)
        hydrated = dict(raw)
        hydrated["composer_mode"] = normalized_mode
        hydrated["messages"] = [self._hydrate_message_assets(m) for m in (raw.get("messages") or [])]
        return hydrated

    def get_session_or_404(self, sid: str) -> Dict[str, Any]:
        session = self.get_session(sid)
        if not session:
            raise HTTPException(status_code=404, detail="Workspace not found")
        return session

    def delete_session(self, sid: str) -> None:
        path = self._session_file(sid)
        if path.exists():
            path.unlink()
        gen_dir = GENERATED_DIR / sid
        if gen_dir.exists():
            shutil.rmtree(gen_dir, ignore_errors=True)
        index = [x for x in self._load_sessions_index() if x.get("id") != sid]
        self._save_sessions_index(index)

    def update_session_mode(self, sid: str, mode: str) -> Dict[str, Any]:
        raw = self._load_session_raw(sid)
        if not raw:
            raise HTTPException(status_code=404, detail="Workspace not found")
        raw["composer_mode"] = _normalize_composer_mode(mode)
        raw["updated_at"] = _now_iso()
        self._save_session_raw(raw)
        return self.get_session_or_404(sid)

    def _create_asset_record(
        self,
        *,
        kind: str,
        title: str,
        file_path: Optional[str] = None,
        tags: Optional[List[str]] = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        aid = f"asset-{uuid.uuid4().hex[:12]}"
        payload: Dict[str, Any] = {
            "id": aid,
            "kind": kind,
            "title": title,
            "file_path": file_path or "",
            "tags": tags or [],
            "created_at": _now_iso(),
            "annotation_snapshot": {},
        }
        if extra:
            payload.update(extra)
        index = self._load_asset_index()
        index[aid] = payload
        self._save_asset_index(index)
        return payload

    def upload_assets(self, files: List[Tuple[str, bytes]], *, workspace_id: Optional[str] = None) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        normalized_workspace_id = str(workspace_id or "").strip()
        for name, content in files:
            if not content:
                continue
            suffix = (Path(name).suffix or ".png").lower()
            if suffix not in IMAGE_EXT_ALLOWLIST:
                suffix = ".png"
            temp_name = f"upload-{uuid.uuid4().hex[:12]}{suffix}"
            save_path = ASSETS_DIR / temp_name
            with save_path.open("wb") as f:
                f.write(content)
            extra: Dict[str, Any] = {}
            if normalized_workspace_id:
                extra["workspace_id"] = normalized_workspace_id
            asset = self._create_asset_record(
                kind="upload",
                title=Path(name).name,
                file_path=str(save_path),
                tags=["上传素材"],
                extra=extra or None,
            )
            results.append(_public_asset_from_record(asset))
        return results

    def list_assets(
        self,
        *,
        cursor: Optional[str] = None,
        limit: int = 80,
        kind: Optional[str] = None,
        search: Optional[str] = None,
        workspace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        items = list(self._load_asset_index().values())

        def match(asset: Dict[str, Any]) -> bool:
            if kind and str(asset.get("kind") or "") != kind:
                return False
            if workspace_id and str(asset.get("workspace_id") or "") != workspace_id:
                return False
            if search:
                joined = " ".join(
                    [str(asset.get("title") or ""), " ".join(str(x) for x in (asset.get("tags") or []))]
                ).lower()
                if search.lower() not in joined:
                    return False
            return True

        filtered = [x for x in items if match(x)]
        filtered.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
        try:
            offset = int(cursor or 0)
        except Exception:
            offset = 0
        offset = max(offset, 0)
        limit = max(1, min(int(limit or 80), 200))
        chunk = filtered[offset : offset + limit]
        next_cursor = str(offset + limit) if offset + limit < len(filtered) else None
        return {
            "items": [_public_asset_from_record(x) for x in chunk],
            "has_more": next_cursor is not None,
            "next_cursor": next_cursor,
            "total": len(filtered),
        }

    def get_official_assets(self) -> List[Dict[str, Any]]:
        items = _read_json(OFFICIAL_ASSETS_FILE, [])
        return items if isinstance(items, list) else []

    def get_official_asset(self, aid: str) -> Optional[Dict[str, Any]]:
        for item in self.get_official_assets():
            if item.get("id") == aid:
                return item
        return None

    def get_official_prompts(self) -> List[Dict[str, Any]]:
        data = _read_json(OFFICIAL_PROMPTS_FILE, [])
        return data if isinstance(data, list) else []

    def list_official_taxonomies(self, dimension: Optional[str] = None) -> Any:
        items = self.get_official_assets()
        tax = {
            "scene": sorted({x.get("scene", "") for x in items if x.get("scene")}),
            "style": sorted({x.get("style", "") for x in items if x.get("style")}),
            "material": sorted({x.get("material", "") for x in items if x.get("material")}),
            "lighting": sorted({x.get("lighting", "") for x in items if x.get("lighting")}),
        }
        if dimension:
            return tax.get(dimension, [])
        return tax

    def page_official_assets(
        self,
        *,
        cursor: Optional[str] = None,
        limit: int = 24,
        scene: Optional[str] = None,
        style: Optional[str] = None,
        material: Optional[str] = None,
        lighting: Optional[str] = None,
        search: Optional[str] = None,
    ) -> Dict[str, Any]:
        def match(item: Dict[str, Any]) -> bool:
            if scene and item.get("scene") != scene:
                return False
            if style and item.get("style") != style:
                return False
            if material and item.get("material") != material:
                return False
            if lighting and item.get("lighting") != lighting:
                return False
            if search:
                text = " ".join(
                    [
                        item.get("title", ""),
                        item.get("scene", ""),
                        item.get("style", ""),
                        item.get("material", ""),
                        item.get("lighting", ""),
                    ]
                ).lower()
                if search.lower() not in text:
                    return False
            return True

        items = [x for x in self.get_official_assets() if match(x)]
        try:
            offset = int(cursor or 0)
        except Exception:
            offset = 0
        offset = max(offset, 0)
        limit = max(1, min(int(limit or 24), 60))
        chunk = items[offset : offset + limit]
        next_cursor = str(offset + limit) if offset + limit < len(items) else None
        return {
            "items": [_public_asset_from_record(x) for x in chunk],
            "has_more": next_cursor is not None,
            "next_cursor": next_cursor,
            "total": len(items),
        }

    def update_asset_meta_or_404(
        self,
        asset_id: str,
        *,
        title: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        index = self._load_asset_index()
        asset = index.get(asset_id)
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")

        changed = False
        if title is not None:
            normalized_title = str(title).strip()
            if not normalized_title:
                raise HTTPException(status_code=400, detail="标题不能为空")
            if normalized_title != str(asset.get("title") or ""):
                asset["title"] = normalized_title
                changed = True

        if tags is not None:
            normalized_tags: List[str] = []
            for tag in tags or []:
                text = str(tag or "").strip()
                if text:
                    normalized_tags.append(text)
            if normalized_tags != list(asset.get("tags") or []):
                asset["tags"] = normalized_tags
                changed = True

        if changed:
            asset["updated_at"] = _now_iso()
            index[asset_id] = asset
            self._save_asset_index(index)
        return _public_asset_from_record(asset)

    def render_official_preview(self, asset_id: str, thumb: bool = False) -> Optional[bytes]:
        asset = self.get_official_asset(asset_id)
        if not asset:
            return None
        size = (360, 240) if thumb else (1280, 848)
        color = asset.get("color") or "#d5c3ae"
        image = Image.new("RGB", size, color=color)
        draw = ImageDraw.Draw(image)
        w, h = size
        for i in range(0, w, max(24, w // 20)):
            draw.rectangle((i, 0, min(i + 10, w), h), fill=(255, 255, 255, 32))
        draw.rectangle((30, h - 170, w - 30, h - 30), outline=(255, 255, 255), width=3)
        draw.text((52, h - 150), asset.get("title", "官方素材"), fill=(255, 255, 255))
        draw.text((52, h - 120), f"{asset.get('style', '')} · {asset.get('scene', '')}", fill=(250, 246, 240))
        draw.text((52, h - 90), f"{asset.get('material', '')} · {asset.get('lighting', '')}", fill=(250, 246, 240))
        out = io.BytesIO()
        image.save(out, format="PNG")
        return out.getvalue()

    def _load_reference_image(self, attachment_ids: List[str], size: Tuple[int, int]) -> Image.Image:
        for aid in attachment_ids:
            asset = self._resolve_asset(aid)
            if not asset:
                continue
            if asset.get("kind") == "official":
                data = self.render_official_preview(aid, thumb=False)
                if data:
                    try:
                        return Image.open(io.BytesIO(data)).convert("RGB").resize(size, Image.Resampling.LANCZOS)
                    except Exception:
                        continue
            fp = asset.get("file_path") or ""
            p = Path(fp)
            if p.exists():
                try:
                    return Image.open(p).convert("RGB").resize(size, Image.Resampling.LANCZOS)
                except Exception:
                    continue
        fallback = Image.new("RGB", size, color="#d8c6b4")
        d = ImageDraw.Draw(fallback)
        d.rectangle((40, 40, size[0] - 40, size[1] - 40), outline="#f7efe6", width=3)
        d.text((56, 56), "INTERIOR DESIGN DRAFT", fill="#f7efe6")
        return fallback

    def _decorate_generated_image(self, image: Image.Image, prompt: str, model: str, quality: str, idx: int) -> Image.Image:
        out = image.copy()
        draw = ImageDraw.Draw(out)
        w, h = out.size
        overlay = random.choice(["#8B5E3C", "#7A6A5B", "#A38A73", "#6B4B32"])
        draw.rectangle((0, h - 180, w, h), fill=(20, 18, 16, 140))
        draw.text((28, h - 156), f"模型: {model}  质量: {quality}", fill="#efe3d6")
        draw.text((28, h - 126), f"候选图 #{idx + 1}", fill="#efe3d6")
        short = (prompt or "").strip().replace("\n", " ")
        short = short[:70] + ("..." if len(short) > 70 else "")
        draw.text((28, h - 96), short or "无提示词", fill="#f8f2ea")
        draw.rectangle((22, h - 164, 24, h - 26), fill=overlay)
        if quality == "standard":
            out = out.filter(ImageFilter.SMOOTH)
        elif quality == "ultra":
            out = ImageEnhance.Sharpness(out).enhance(1.5)
            out = ImageEnhance.Contrast(out).enhance(1.08)
        return out

    def _mime_to_suffix(self, mime_type: str, fallback: str = ".png") -> str:
        val = (mime_type or "").split(";")[0].strip().lower()
        mapping = {
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/webp": ".webp",
            "image/bmp": ".bmp",
            "image/gif": ".gif",
        }
        if val in mapping:
            return mapping[val]
        fb = (fallback or ".png").lower()
        if not fb.startswith("."):
            fb = f".{fb}"
        if fb in IMAGE_EXT_ALLOWLIST:
            return fb
        return ".png"

    def _save_generated_binary(
        self,
        *,
        session_id: str,
        image_bytes: bytes,
        suffix: str,
        title: str,
        tags: List[str],
    ) -> Dict[str, Any]:
        target_dir = GENERATED_DIR / session_id
        target_dir.mkdir(parents=True, exist_ok=True)
        normalized_suffix = self._mime_to_suffix("", suffix)
        file_name = f"gen-{uuid.uuid4().hex[:10]}{normalized_suffix}"
        file_path = target_dir / file_name
        with file_path.open("wb") as f:
            f.write(image_bytes)
        return self._create_asset_record(
            kind="generated",
            title=title,
            file_path=str(file_path),
            tags=tags,
            extra={"workspace_id": session_id},
        )

    def _extract_generated_candidates(self, payload: Any) -> List[Dict[str, str]]:
        candidates: List[Dict[str, str]] = []

        def add_url(url: str, title: str = "") -> None:
            value = str(url or "").strip()
            if value.startswith("http://") or value.startswith("https://"):
                candidates.append({"kind": "url", "value": value, "title": title})

        def add_base64(raw: str, mime_type: str = "", title: str = "") -> None:
            value = str(raw or "").strip()
            if value:
                candidates.append({"kind": "base64", "value": value, "mime_type": mime_type, "title": title})

        nodes: List[Any] = []
        if isinstance(payload, list):
            nodes = payload
        elif isinstance(payload, dict):
            for key in ("images", "data", "outputs", "results"):
                value = payload.get(key)
                if isinstance(value, list):
                    nodes = value
                    break
            if not nodes and isinstance(payload.get("output"), dict):
                output = payload.get("output") or {}
                if isinstance(output.get("images"), list):
                    nodes = output.get("images") or []
            if not nodes:
                for key in ("image", "output_image", "result"):
                    if key in payload:
                        nodes = [payload.get(key)]
                        break

        for node in nodes:
            if isinstance(node, str):
                text = node.strip()
                if text.startswith("data:image/"):
                    parts = text.split(",", 1)
                    if len(parts) == 2:
                        mime = parts[0].split(";")[0].replace("data:", "")
                        add_base64(parts[1], mime)
                    continue
                add_url(text)
                continue

            if not isinstance(node, dict):
                continue

            title = str(node.get("title") or node.get("name") or "").strip()
            url = node.get("url") or node.get("image_url") or node.get("src")
            if isinstance(url, str):
                add_url(url, title)

            data_url = node.get("data_url") or node.get("image_data_url")
            if isinstance(data_url, str) and data_url.startswith("data:image/"):
                parts = data_url.split(",", 1)
                if len(parts) == 2:
                    mime = parts[0].split(";")[0].replace("data:", "")
                    add_base64(parts[1], mime, title)

            raw_base64 = node.get("base64") or node.get("b64_json") or node.get("b64") or node.get("image_base64")
            if isinstance(raw_base64, str):
                if raw_base64.startswith("data:image/"):
                    parts = raw_base64.split(",", 1)
                    if len(parts) == 2:
                        mime = parts[0].split(";")[0].replace("data:", "")
                        add_base64(parts[1], mime, title)
                else:
                    mime_type = str(node.get("mime_type") or node.get("content_type") or "")
                    add_base64(raw_base64, mime_type, title)

            nested = node.get("image")
            if isinstance(nested, str):
                if nested.startswith("data:image/"):
                    parts = nested.split(",", 1)
                    if len(parts) == 2:
                        mime = parts[0].split(";")[0].replace("data:", "")
                        add_base64(parts[1], mime, title)
                else:
                    add_url(nested, title)

        return candidates

    def _fetch_remote_image_bytes(self, url: str, timeout_seconds: int) -> Tuple[bytes, str]:
        req = urllib_request.Request(
            str(url).strip(),
            headers={"User-Agent": "InteriorPromptStudio/0.1"},
            method="GET",
        )
        with urllib_request.urlopen(req, timeout=timeout_seconds) as resp:
            content = resp.read()
            content_type = str(resp.headers.get("Content-Type") or "")
        return content, content_type

    def _normalize_generation_endpoint(self, endpoint: str) -> str:
        value = str(endpoint or "").strip()
        if not value:
            return ""
        value = value.rstrip("/")
        parsed = urlparse(value)
        if not parsed.scheme or not parsed.netloc:
            return value
        path = parsed.path or ""
        if path in {"", "/"}:
            return f"{value}/v1/images/generations"
        if path == "/v1":
            return f"{value}/images/generations"
        return value

    def _normalize_chat_endpoint(self, endpoint: str) -> str:
        value = str(endpoint or "").strip()
        if not value:
            return ""
        value = value.rstrip("/")
        parsed = urlparse(value)
        if not parsed.scheme or not parsed.netloc:
            if value.endswith("/images/generations"):
                return f"{value[: -len('/images/generations')]}/chat/completions"
            if value.endswith("/v1"):
                return f"{value}/chat/completions"
            return value
        path = parsed.path or ""
        if path in {"", "/"}:
            return f"{value}/v1/chat/completions"
        if path == "/v1":
            return f"{value}/chat/completions"
        if path.endswith("/images/generations"):
            return f"{value[: -len('/images/generations')]}/chat/completions"
        return value

    def _resolve_xiaodoubao_model(self, image_size: str, selected_model: str) -> str:
        model = str(selected_model or "").strip().lower()
        if model in {
            "nano-banana",
            "nano-banana-hd",
            "nano-banana-2",
            "nano-banana-2-2k",
            "nano-banana-2-4k",
        }:
            return model
        mapping = {
            "1K": "nano-banana-2",
            "2K": "nano-banana-2-2k",
            "4K": "nano-banana-2-4k",
        }
        return mapping.get(image_size, "nano-banana-2-2k")

    def _asset_to_binary(self, asset_id: str) -> Optional[Tuple[bytes, str]]:
        asset = self._resolve_asset(asset_id)
        if not asset:
            return None
        content: Optional[bytes] = None
        mime_type = "image/png"
        if asset.get("kind") == "official":
            content = self.render_official_preview(asset_id, thumb=False)
        else:
            fp = str(asset.get("file_path") or "")
            if fp:
                path = Path(fp)
                if path.exists():
                    try:
                        content = path.read_bytes()
                        ext = path.suffix.lower()
                        mime_mapping = {
                            ".png": "image/png",
                            ".jpg": "image/jpeg",
                            ".jpeg": "image/jpeg",
                            ".webp": "image/webp",
                            ".bmp": "image/bmp",
                            ".gif": "image/gif",
                        }
                        mime_type = mime_mapping.get(ext, "image/png")
                    except Exception:
                        content = None
        if not content:
            return None
        return content, mime_type

    def _asset_to_b64(self, asset_id: str) -> Optional[str]:
        binary = self._asset_to_binary(asset_id)
        if not binary:
            return None
        content, _mime_type = binary
        return base64.b64encode(content).decode("utf-8")

    def _optimize_multimodal_image(self, content: bytes) -> Tuple[bytes, str]:
        # 避免把超大原图直接塞进 data URL，导致网关超时/断连
        max_edge = 1600
        target_bytes = 2_000_000
        min_edge = 640
        try:
            with Image.open(io.BytesIO(content)) as img:
                frame = img.copy()
        except Exception:
            return content, "image/png"

        if max(frame.size or (0, 0)) <= 0:
            return content, "image/png"

        # 先按最大边缩放到视觉模型常见输入尺寸
        width, height = frame.size
        largest_edge = max(width, height)
        if largest_edge > max_edge:
            ratio = max_edge / float(largest_edge)
            frame = frame.resize((max(1, int(width * ratio)), max(1, int(height * ratio))), Image.LANCZOS)

        if frame.mode not in ("RGB", "L"):
            frame = frame.convert("RGB")
        elif frame.mode == "L":
            frame = frame.convert("RGB")

        quality_levels = [85, 78, 72, 66, 60]
        best_payload: Optional[bytes] = None
        best_size = 1 << 62

        working = frame
        for _round in range(5):
            for quality in quality_levels:
                buf = io.BytesIO()
                try:
                    working.save(buf, format="JPEG", quality=quality, optimize=True)
                except Exception:
                    continue
                payload = buf.getvalue()
                size = len(payload)
                if size < best_size:
                    best_payload = payload
                    best_size = size
                if size <= target_bytes:
                    return payload, "image/jpeg"

            w, h = working.size
            if min(w, h) <= min_edge:
                break
            shrink = 0.85
            working = working.resize((max(min_edge, int(w * shrink)), max(min_edge, int(h * shrink))), Image.LANCZOS)

        if best_payload:
            return best_payload, "image/jpeg"
        return content, "image/png"

    def _asset_to_data_url(self, asset_id: str) -> Optional[str]:
        binary = self._asset_to_binary(asset_id)
        if not binary:
            return None
        content, mime_type = binary
        if len(content) > 1_500_000:
            content, mime_type = self._optimize_multimodal_image(content)
        b64 = base64.b64encode(content).decode("utf-8")
        return f"data:{mime_type};base64,{b64}"

    def _build_reference_images(self, attachment_ids: List[str]) -> List[str]:
        images: List[str] = []
        for aid in attachment_ids:
            b64 = self._asset_to_b64(aid)
            if not b64:
                continue
            images.append(b64)
            if len(images) >= 9:
                break
        return images

    def _decode_candidate_to_binary(self, item: Dict[str, str], timeout_seconds: int) -> Tuple[bytes, str, str]:
        kind = str(item.get("kind") or "")
        title = str(item.get("title") or "").strip()

        if kind == "url":
            url = str(item.get("value") or "").strip()
            if not url:
                raise ValueError("返回图片 URL 为空")
            image_bytes, mime_type = self._fetch_remote_image_bytes(url, timeout_seconds)
            guessed = Path(urlparse(url).path).suffix
            return image_bytes, self._mime_to_suffix(mime_type, guessed), title

        if kind == "base64":
            raw_base64 = str(item.get("value") or "").strip()
            if not raw_base64:
                raise ValueError("返回 base64 为空")
            image_bytes = base64.b64decode(raw_base64, validate=False)
            mime_type = str(item.get("mime_type") or "")
            return image_bytes, self._mime_to_suffix(mime_type, ".png"), title

        raise ValueError("返回图片类型不支持")

    def _request_generation_once(
        self,
        *,
        endpoint: str,
        headers: Dict[str, str],
        payload: Dict[str, Any],
        timeout_seconds: int,
    ) -> Tuple[bytes, str, str]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib_request.Request(endpoint, data=body, headers=headers, method="POST")
        try:
            with urllib_request.urlopen(req, timeout=timeout_seconds) as resp:
                raw_text = resp.read().decode("utf-8")
        except urllib_error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8")
            except Exception:
                detail = str(exc.reason or "")
            detail = detail.strip()[:220]
            raise ValueError(f"HTTP {exc.code} {detail}".strip()) from exc
        except urllib_error.URLError as exc:
            raise ValueError(f"网络错误: {exc.reason}") from exc
        except Exception as exc:
            raise ValueError(f"请求异常: {exc}") from exc

        try:
            parsed = json.loads(raw_text or "{}")
        except Exception as exc:
            raise ValueError("接口返回不是 JSON") from exc

        candidates = self._extract_generated_candidates(parsed)
        if not candidates:
            raise ValueError("接口返回里没有可识别图片（data/images）")

        return self._decode_candidate_to_binary(candidates[0], timeout_seconds)

    def _resolve_text_runtime(self) -> Dict[str, Any]:
        config = self.get_runtime_config()
        http_cfg = config.get("http") if isinstance(config.get("http"), dict) else {}
        stepped_prompt_cfg = config.get("stepped_prompt") if isinstance(config.get("stepped_prompt"), dict) else {}
        chat_endpoint = self._normalize_chat_endpoint(str(http_cfg.get("endpoint") or ""))
        if not chat_endpoint:
            raise HTTPException(status_code=400, detail="请先在设置中填写 API 地址。")
        timeout_seconds = max(5, min(int(http_cfg.get("timeout_seconds") or 120), 600))
        text_model = str(http_cfg.get("text_model") or "").strip() or "gpt-4.1-mini"
        api_key = (
            _runtime_text_api_key_from_env()
            or str(http_cfg.get("text_api_key") or "").strip()
            or _runtime_http_api_key_from_env()
            or str(http_cfg.get("api_key") or "").strip()
        )
        return {
            "endpoint": chat_endpoint,
            "timeout_seconds": timeout_seconds,
            "api_key": api_key,
            "model": text_model,
            "stepped_prompt": _normalize_stepped_prompt_config(stepped_prompt_cfg),
        }

    def _content_node_to_text(self, content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: List[str] = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                    continue
                if not isinstance(item, dict):
                    continue
                text = ""
                if "text" in item:
                    text = str(item.get("text") or "")
                elif "output_text" in item:
                    text = str(item.get("output_text") or "")
                elif item.get("type") in {"text", "output_text"}:
                    text = str(item.get("content") or "")
                if text:
                    parts.append(text)
            return "".join(parts)
        return ""

    def _extract_chat_delta_text(self, payload: Any) -> str:
        if not isinstance(payload, dict):
            return ""
        choices = payload.get("choices")
        if not isinstance(choices, list) or len(choices) == 0:
            return ""
        first = choices[0] if isinstance(choices[0], dict) else {}
        delta = first.get("delta")
        if not isinstance(delta, dict):
            return ""
        return self._content_node_to_text(delta.get("content"))

    def _extract_chat_message_text(self, payload: Any) -> str:
        if not isinstance(payload, dict):
            return ""
        choices = payload.get("choices")
        if not isinstance(choices, list) or len(choices) == 0:
            return ""
        first = choices[0] if isinstance(choices[0], dict) else {}
        message = first.get("message")
        if isinstance(message, dict):
            text = self._content_node_to_text(message.get("content"))
            if text:
                return text
        return self._extract_chat_delta_text(payload)

    def _stream_openai_chat(self, *, endpoint: str, headers: Dict[str, str], payload: Dict[str, Any], timeout_seconds: int) -> Iterator[str]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib_request.Request(endpoint, data=body, headers=headers, method="POST")
        try:
            with urllib_request.urlopen(req, timeout=timeout_seconds) as resp:
                started_at = time.monotonic()
                content_type = str(resp.headers.get("Content-Type") or "").lower()
                if "text/event-stream" in content_type:
                    for raw_line in resp:
                        if (time.monotonic() - started_at) > timeout_seconds:
                            raise HTTPException(status_code=502, detail=f"文本模型请求超时（>{timeout_seconds}s）")
                        line = raw_line.decode("utf-8", errors="ignore").strip()
                        if not line or not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if not data:
                            continue
                        if data == "[DONE]":
                            break
                        try:
                            event = json.loads(data)
                        except Exception:
                            continue
                        if isinstance(event, dict) and event.get("error") is not None:
                            error_payload = event.get("error")
                            if isinstance(error_payload, dict):
                                message = str(error_payload.get("message") or "").strip() or json.dumps(error_payload, ensure_ascii=False)
                            else:
                                message = str(error_payload).strip()
                            raise HTTPException(status_code=502, detail=f"文本模型请求失败：{message or '上游返回错误'}")
                        delta = self._extract_chat_delta_text(event)
                        if delta:
                            yield delta
                    return

                raw_text = resp.read().decode("utf-8")
                parsed = json.loads(raw_text or "{}")
                full_text = self._extract_chat_message_text(parsed)
                if full_text:
                    yield full_text
        except urllib_error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8")
            except Exception:
                detail = str(exc.reason or "")
            detail = detail.strip()[:220]
            raise HTTPException(status_code=502, detail=f"文本模型请求失败：HTTP {exc.code} {detail}".strip()) from exc
        except urllib_error.URLError as exc:
            raise HTTPException(status_code=502, detail=f"文本模型网络错误：{exc.reason}") from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"文本模型请求异常：{exc}") from exc

    def _is_transient_upstream_error(self, detail: str) -> bool:
        raw = str(detail or "").strip().lower()
        if not raw:
            return False
        markers = [
            "eof occurred in violation of protocol",
            "unexpected eof while reading",
            "remote end closed connection without response",
            "connection reset",
            "connection reset by peer",
            "broken pipe",
            "remote end closed connection",
            "temporarily unavailable",
            "timed out",
            "timeout",
            "connection aborted",
            "connection closed",
            "connection refused",
            "_ssl.c:",
            "ssl: unexpected eof",
            "tlsv1 alert internal error",
            "failed to fetch",
        ]
        if any(token in raw for token in markers):
            return True
        # 上游 5xx 视作可重试的瞬时故障；4xx 属于业务/参数错误，不重试。
        if "http 5" in raw:
            return True
        return False

    def _is_transient_text_upstream_error(self, detail: str) -> bool:
        return self._is_transient_upstream_error(detail)

    def _normalize_annotation_context(self, payload: Any) -> Dict[str, Any]:
        if not isinstance(payload, dict):
            return {}
        asset_id = str(payload.get("asset_id") or "").strip()
        objects_raw = payload.get("objects")
        objects: List[Dict[str, Any]] = []
        if isinstance(objects_raw, list):
            for item in objects_raw:
                if not isinstance(item, dict):
                    continue
                object_id = str(item.get("id") or "").strip()
                shape_id = str(item.get("shape_id") or "").strip()
                text = str(item.get("text") or "").strip()
                bbox_raw = item.get("bbox")
                bbox: Dict[str, float] = {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}
                if isinstance(bbox_raw, dict):
                    for key in ("x", "y", "w", "h"):
                        try:
                            bbox[key] = float(bbox_raw.get(key) or 0.0)
                        except Exception:
                            bbox[key] = 0.0
                if not object_id:
                    continue
                objects.append(
                    {
                        "id": object_id,
                        "shape_id": shape_id,
                        "bbox": bbox,
                        "text": text,
                    }
                )
                if len(objects) >= 3:
                    break

        move_relation_raw = payload.get("move_relation")
        move_relation: Optional[Dict[str, str]] = None
        if isinstance(move_relation_raw, dict):
            source_id = str(move_relation_raw.get("source_id") or "").strip()
            target_id = str(move_relation_raw.get("target_id") or "").strip()
            valid_ids = {str(item.get("id") or "") for item in objects}
            if source_id and target_id and source_id != target_id and source_id in valid_ids and target_id in valid_ids:
                move_relation = {
                    "source_id": source_id,
                    "target_id": target_id,
                }

        return {
            "asset_id": asset_id,
            "objects": objects,
            "move_relation": move_relation,
        }

    def _normalize_annotation_contexts(self, payload: Any) -> List[Dict[str, Any]]:
        contexts_raw: List[Any]
        if isinstance(payload, list):
            contexts_raw = payload
        elif isinstance(payload, dict):
            contexts_raw = [payload]
        else:
            contexts_raw = []

        normalized: List[Dict[str, Any]] = []
        for item in contexts_raw:
            context = self._normalize_annotation_context(item)
            if not isinstance(context, dict):
                continue
            objects = context.get("objects")
            if not isinstance(objects, list) or len(objects) == 0:
                continue
            normalized.append(context)
        return normalized

    def _annotation_contexts_to_prompt(self, contexts: List[Dict[str, Any]]) -> str:
        if not isinstance(contexts, list) or len(contexts) == 0:
            return ""
        lines = ["[标注上下文]"]
        for ctx_index, context in enumerate(contexts, start=1):
            if not isinstance(context, dict):
                continue
            objects = context.get("objects")
            if not isinstance(objects, list) or len(objects) == 0:
                continue
            asset_id = str(context.get("asset_id") or "").strip()
            if asset_id:
                lines.append(f"- 图片{ctx_index} (asset_id={asset_id})")
            else:
                lines.append(f"- 图片{ctx_index}")
            for item in objects:
                if not isinstance(item, dict):
                    continue
                object_id = str(item.get("id") or "").strip()
                text = str(item.get("text") or "").strip()
                bbox = item.get("bbox")
                if not object_id:
                    continue
                bbox_desc = ""
                if isinstance(bbox, dict):
                    try:
                        bbox_desc = " (x={:.1f}, y={:.1f}, w={:.1f}, h={:.1f})".format(
                            float(bbox.get("x") or 0.0),
                            float(bbox.get("y") or 0.0),
                            float(bbox.get("w") or 0.0),
                            float(bbox.get("h") or 0.0),
                        )
                    except Exception:
                        bbox_desc = ""
                lines.append(f"  - {object_id}{bbox_desc}: {text or '未填写'}")
            move_relation = context.get("move_relation")
            if isinstance(move_relation, dict):
                source_id = str(move_relation.get("source_id") or "").strip()
                target_id = str(move_relation.get("target_id") or "").strip()
                if source_id and target_id:
                    lines.append(f"  - 移动关系: {source_id} -> {target_id}")
        if len(lines) <= 1:
            return ""
        return "\n".join(lines)

    def _create_generated_assets_mock(
        self, session_id: str, prompt: str, params: Dict[str, Any], attachment_ids: List[str]
    ) -> List[Dict[str, Any]]:
        ratio = _normalize_aspect_ratio(params.get("aspect_ratio", "3:4"))
        quality = _normalize_quality(params.get("quality", "2K"))
        model = str(params.get("model", MODEL_OPTIONS[0]["id"]))
        count = _normalize_count(params.get("count", 1))
        size = _ratio_to_size(ratio)

        base = self._load_reference_image(attachment_ids, size)
        target_dir = GENERATED_DIR / session_id
        target_dir.mkdir(parents=True, exist_ok=True)

        result: List[Dict[str, Any]] = []
        for i in range(count):
            rendered = self._decorate_generated_image(base, prompt=prompt, model=model, quality=quality, idx=i)
            name = f"gen-{uuid.uuid4().hex[:10]}.png"
            fp = target_dir / name
            rendered.save(fp, format="PNG")
            asset = self._create_asset_record(
                kind="generated",
                title=f"生成图 {i + 1}",
                file_path=str(fp),
                tags=["生成图", model, ratio, quality],
                extra={"workspace_id": session_id},
            )
            result.append(asset)
        return result

    def _create_generated_assets_http(
        self,
        session_id: str,
        prompt: str,
        params: Dict[str, Any],
        attachment_ids: List[str],
        references: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        config = self.get_runtime_config()
        http_cfg = config.get("http") if isinstance(config.get("http"), dict) else {}
        endpoint = self._normalize_generation_endpoint(str(http_cfg.get("endpoint") or ""))
        if not endpoint:
            raise HTTPException(status_code=400, detail="请先在设置中填写小豆包 API 地址。")

        timeout_seconds = max(5, min(int(http_cfg.get("timeout_seconds") or 120), 600))
        api_key = _runtime_http_api_key_from_env() or str(http_cfg.get("api_key") or "")
        ratio = _normalize_aspect_ratio(params.get("aspect_ratio", "3:4"))
        image_size = _normalize_quality(params.get("quality", "2K"))
        model = self._resolve_xiaodoubao_model(image_size, str(params.get("model", "")))
        count = _normalize_count(params.get("count", 1))
        response_format = str(http_cfg.get("response_format") or "url").strip().lower()
        if response_format not in {"url", "b64_json"}:
            response_format = "url"

        request_payload: Dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "response_format": response_format,
            "aspect_ratio": ratio,
            "image_size": image_size,
        }
        reference_images = self._build_reference_images(attachment_ids)
        if reference_images:
            request_payload["image"] = reference_images

        headers = {"Content-Type": "application/json"}
        token = api_key.strip()
        if token:
            if token.lower().startswith("bearer "):
                headers["Authorization"] = token
            else:
                headers["Authorization"] = f"Bearer {token}"

        output: List[Optional[Dict[str, Any]]] = [None] * count
        errors: List[str] = []

        def worker(index: int) -> Tuple[int, bytes, str, str]:
            last_error = "未知错误"
            max_attempts = max(1, HTTP_GENERATE_MAX_ATTEMPTS)
            for attempt_index in range(max_attempts):
                try:
                    image_bytes, suffix, title = self._request_generation_once(
                        endpoint=endpoint,
                        headers=headers,
                        payload=request_payload,
                        timeout_seconds=timeout_seconds,
                    )
                    return index, image_bytes, suffix, title
                except Exception as exc:
                    last_error = str(exc)
                    is_last = attempt_index >= (max_attempts - 1)
                    if is_last:
                        break
                    if not self._is_transient_upstream_error(last_error):
                        break
                    backoff = min(1.2, 0.25 * (2 ** attempt_index)) + random.uniform(0.0, 0.08)
                    time.sleep(backoff)
            raise ValueError(last_error)

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(max(count, 1), 4)) as executor:
            future_map = {executor.submit(worker, i): i for i in range(count)}
            for future in concurrent.futures.as_completed(future_map):
                target_index = future_map[future]
                try:
                    idx, image_bytes, suffix, title = future.result()
                    output[idx] = {
                        "image_bytes": image_bytes,
                        "suffix": suffix,
                        "title": title or f"生成图 {idx + 1}",
                    }
                except Exception as exc:
                    errors.append(f"第{target_index + 1}张失败: {exc}")

        missing_indexes = [idx for idx, item in enumerate(output) if item is None]
        if missing_indexes:
            detail = errors[0] if errors else "未知错误"
            success_count = count - len(missing_indexes)
            raise HTTPException(
                status_code=502,
                detail=f"小豆包生成失败：目标 {count} 张，仅成功 {success_count} 张。{detail}",
            )

        generated: List[Dict[str, Any]] = []
        for item in output:
            if not item:
                continue
            saved = self._save_generated_binary(
                session_id=session_id,
                image_bytes=item["image_bytes"],
                suffix=item["suffix"],
                title=item["title"],
                tags=["生成图", "xiaodoubao", model, ratio, image_size],
            )
            generated.append(saved)
        return generated

    def _create_generated_assets(
        self,
        session_id: str,
        prompt: str,
        params: Dict[str, Any],
        attachment_ids: List[str],
        references: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        return self._create_generated_assets_http(
            session_id=session_id,
            prompt=prompt,
            params=params,
            attachment_ids=attachment_ids,
            references=references,
        )

    def create_turn(
        self,
        session_id: str,
        text: str,
        params: Dict[str, Any],
        attachment_asset_ids: List[str],
        references: Optional[List[Dict[str, Any]]] = None,
        annotation_context: Optional[Dict[str, Any]] = None,
        annotation_contexts: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        session = self._load_session_raw(session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Workspace not found")

        normalized_params = {
            "model": params.get("model", MODEL_OPTIONS[0]["id"]),
            "aspect_ratio": _normalize_aspect_ratio(params.get("aspect_ratio", "3:4")),
            "quality": _normalize_quality(params.get("quality", "2K")),
            "count": _normalize_count(params.get("count", 1)),
        }
        valid_references: List[Dict[str, Any]] = []
        seen_slots: set = set()
        for idx, ref in enumerate(references or []):
            if not isinstance(ref, dict):
                continue
            slot = str(ref.get("slot") or "").strip()
            aid = str(ref.get("asset_id") or "").strip()
            if not slot or not aid or slot in seen_slots:
                continue
            if self._resolve_asset(aid) is None:
                continue
            try:
                order = int(ref.get("order") or (idx + 1))
            except Exception:
                order = idx + 1
            seen_slots.add(slot)
            valid_references.append(
                {
                    "mention_id": str(ref.get("mention_id") or f"mention-{uuid.uuid4().hex[:8]}"),
                    "slot": slot,
                    "asset_id": aid,
                    "source": str(ref.get("source") or ""),
                    "order": order,
                    "asset_title": str(ref.get("asset_title") or ""),
                }
            )
        valid_references.sort(key=lambda x: int(x.get("order") or 0))
        valid_attachment_ids: List[str] = []
        for aid in [x["asset_id"] for x in valid_references] + list(attachment_asset_ids or []):
            if aid in valid_attachment_ids:
                continue
            if self._resolve_asset(aid) is None:
                continue
            valid_attachment_ids.append(aid)
        raw_annotation_contexts: List[Dict[str, Any]] = []
        if isinstance(annotation_contexts, list):
            raw_annotation_contexts.extend([item for item in annotation_contexts if isinstance(item, dict)])
        if isinstance(annotation_context, dict) and annotation_context:
            raw_annotation_contexts.append(annotation_context)
        normalized_annotation_contexts = self._normalize_annotation_contexts(raw_annotation_contexts)
        for context in normalized_annotation_contexts:
            annotation_asset_id = str(context.get("asset_id") or "").strip()
            if annotation_asset_id and annotation_asset_id not in valid_attachment_ids and self._resolve_asset(annotation_asset_id):
                valid_attachment_ids.append(annotation_asset_id)
        composed_text = (text or "").strip()
        annotation_prompt = self._annotation_contexts_to_prompt(normalized_annotation_contexts)
        if annotation_prompt:
            if composed_text:
                composed_text = f"{annotation_prompt}\n\n原始需求:\n{composed_text}"
            else:
                composed_text = annotation_prompt
        user_msg = {
            "id": f"msg-{uuid.uuid4().hex[:10]}",
            "role": "user",
            "mode": "image",
            "text": (text or "").strip(),
            "params": normalized_params,
            "attachment_asset_ids": valid_attachment_ids,
            "image_asset_ids": [],
            "references": valid_references,
            "annotation_context": normalized_annotation_contexts[0] if normalized_annotation_contexts else {},
            "annotation_contexts": normalized_annotation_contexts,
            "status": "completed",
            "created_at": _now_iso(),
        }
        assistant_msg = {
            "id": f"msg-{uuid.uuid4().hex[:10]}",
            "role": "assistant",
            "mode": "image",
            "text": "正在生成中...",
            "params": normalized_params,
            "attachment_asset_ids": [],
            "image_asset_ids": [],
            "status": "running",
            "created_at": _now_iso(),
        }

        messages = session.get("messages") or []
        messages.extend([user_msg, assistant_msg])
        session["messages"] = messages
        session["updated_at"] = _now_iso()
        self._save_session_raw(session)

        try:
            generated = self._create_generated_assets(
                session_id=session_id,
                prompt=composed_text,
                params=normalized_params,
                attachment_ids=valid_attachment_ids,
                references=valid_references,
            )
            assistant_msg["text"] = "已完成生成。你可以继续追问、复制下载，或进入标注模式。"
            assistant_msg["image_asset_ids"] = [a["id"] for a in generated]
            assistant_msg["status"] = "completed"
        except HTTPException as exc:
            detail = str(exc.detail or "生成失败")
            assistant_msg["text"] = f"生成失败：{detail}"
            assistant_msg["status"] = "failed"
            session["updated_at"] = _now_iso()
            self._save_session_raw(session)
            raise
        except Exception as exc:
            assistant_msg["text"] = f"生成失败：{exc}"
            assistant_msg["status"] = "failed"
            session["updated_at"] = _now_iso()
            self._save_session_raw(session)
            raise HTTPException(status_code=500, detail=f"生成失败：{exc}") from exc

        session["updated_at"] = _now_iso()
        self._save_session_raw(session)

        return {
            "user_message": self._hydrate_message_assets(user_msg),
            "assistant_message": self._hydrate_message_assets(assistant_msg),
        }

    def stream_text_turn(
        self,
        session_id: str,
        text: str,
        params: Dict[str, Any],
        attachment_asset_ids: List[str],
        references: Optional[List[Dict[str, Any]]] = None,
        annotation_context: Optional[Dict[str, Any]] = None,
        annotation_contexts: Optional[List[Dict[str, Any]]] = None,
    ) -> Iterator[str]:
        session = self._load_session_raw(session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Workspace not found")

        runtime = self._resolve_text_runtime()
        raw_params = params or {}
        prompt_pack_mode = _normalize_prompt_pack_mode(raw_params.get("prompt_pack_mode"))
        prompt_pack_stage = _normalize_prompt_pack_stage(raw_params.get("prompt_pack_stage"))
        selected_option = _normalize_prompt_pack_selected_option(raw_params)
        valid_references: List[Dict[str, Any]] = []
        seen_slots: set = set()
        for idx, ref in enumerate(references or []):
            if not isinstance(ref, dict):
                continue
            slot = str(ref.get("slot") or "").strip()
            aid = str(ref.get("asset_id") or "").strip()
            if not slot or not aid or slot in seen_slots:
                continue
            if self._resolve_asset(aid) is None:
                continue
            try:
                order = int(ref.get("order") or (idx + 1))
            except Exception:
                order = idx + 1
            seen_slots.add(slot)
            valid_references.append(
                {
                    "mention_id": str(ref.get("mention_id") or f"mention-{uuid.uuid4().hex[:8]}"),
                    "slot": slot,
                    "asset_id": aid,
                    "source": str(ref.get("source") or ""),
                    "order": order,
                    "asset_title": str(ref.get("asset_title") or ""),
                }
            )
        valid_references.sort(key=lambda x: int(x.get("order") or 0))
        valid_attachment_ids: List[str] = []
        for aid in [x["asset_id"] for x in valid_references] + list(attachment_asset_ids or []):
            if aid in valid_attachment_ids:
                continue
            if self._resolve_asset(aid) is None:
                continue
            valid_attachment_ids.append(aid)

        raw_annotation_contexts: List[Dict[str, Any]] = []
        if isinstance(annotation_contexts, list):
            raw_annotation_contexts.extend([item for item in annotation_contexts if isinstance(item, dict)])
        if isinstance(annotation_context, dict) and annotation_context:
            raw_annotation_contexts.append(annotation_context)
        normalized_annotation_contexts = self._normalize_annotation_contexts(raw_annotation_contexts)
        for context in normalized_annotation_contexts:
            annotation_asset_id = str(context.get("asset_id") or "").strip()
            if annotation_asset_id and annotation_asset_id not in valid_attachment_ids and self._resolve_asset(annotation_asset_id):
                valid_attachment_ids.append(annotation_asset_id)

        raw_text = (text or "").strip()
        composed_text = raw_text
        annotation_prompt = self._annotation_contexts_to_prompt(normalized_annotation_contexts)
        if annotation_prompt:
            if composed_text:
                composed_text = f"{annotation_prompt}\n\n原始需求:\n{composed_text}"
            else:
                composed_text = annotation_prompt
        if prompt_pack_mode == TEXT_PROMPT_PACK_MODE:
            structure_instruction = _stepped_prompt_json_instruction(
                prompt_pack_stage,
                selected_option,
                runtime.get("stepped_prompt"),
            )
            if composed_text:
                composed_text = f"{composed_text}\n\n[输出格式要求]\n{structure_instruction}"
            else:
                composed_text = structure_instruction

        if not composed_text and len(valid_attachment_ids) == 0:
            raise HTTPException(status_code=400, detail="请输入内容或添加素材")

        normalized_params = {
            "model": runtime["model"],
        }
        if prompt_pack_mode:
            normalized_params["prompt_pack_mode"] = prompt_pack_mode
            normalized_params["prompt_pack_stage"] = prompt_pack_stage
            if selected_option.get("id"):
                normalized_params["selected_option_id"] = selected_option["id"]
            if selected_option.get("title"):
                normalized_params["selected_option_title"] = selected_option["title"]
            if selected_option.get("summary"):
                normalized_params["selected_option_summary"] = selected_option["summary"]
        user_msg = {
            "id": f"msg-{uuid.uuid4().hex[:10]}",
            "role": "user",
            "mode": "text",
            "text": raw_text,
            "params": normalized_params,
            "attachment_asset_ids": valid_attachment_ids,
            "image_asset_ids": [],
            "references": valid_references,
            "annotation_context": normalized_annotation_contexts[0] if normalized_annotation_contexts else {},
            "annotation_contexts": normalized_annotation_contexts,
            "status": "completed",
            "created_at": _now_iso(),
        }
        assistant_msg = {
            "id": f"msg-{uuid.uuid4().hex[:10]}",
            "role": "assistant",
            "mode": "text",
            "text": "正在思考中...",
            "params": normalized_params,
            "attachment_asset_ids": [],
            "image_asset_ids": [],
            "status": "running",
            "created_at": _now_iso(),
        }

        messages = session.get("messages") or []
        messages.extend([user_msg, assistant_msg])
        session["messages"] = messages
        session["updated_at"] = _now_iso()
        self._save_session_raw(session)

        def _event_line(payload: Dict[str, Any]) -> str:
            return f"{json.dumps(payload, ensure_ascii=False)}\n"

        def _generator() -> Iterator[str]:
            accumulated = ""
            try:
                yield _event_line(
                    {
                        "type": "start",
                        "user_message": self._hydrate_message_assets(user_msg),
                        "assistant_message": self._hydrate_message_assets(assistant_msg),
                    }
                )
                multimodal_data_urls: List[str] = []
                for aid in valid_attachment_ids:
                    data_url = self._asset_to_data_url(aid)
                    if not data_url:
                        continue
                    multimodal_data_urls.append(data_url)
                    if len(multimodal_data_urls) >= 9:
                        break

                headers = {"Content-Type": "application/json"}
                token = str(runtime.get("api_key") or "").strip()
                if token:
                    if token.lower().startswith("bearer "):
                        headers["Authorization"] = token
                    else:
                        headers["Authorization"] = f"Bearer {token}"

                def _build_message_content(image_url_style: str) -> Any:
                    if not multimodal_data_urls:
                        return composed_text or "请根据输入内容进行回复。"
                    content_items: List[Dict[str, Any]] = [{"type": "text", "text": composed_text or "请结合图片进行分析。"}]
                    for url in multimodal_data_urls:
                        if image_url_style == "string":
                            content_items.append({"type": "image_url", "image_url": url})
                        else:
                            content_items.append({"type": "image_url", "image_url": {"url": url}})
                    return content_items

                style_attempts = ["object", "string"] if multimodal_data_urls else ["object"]
                endpoint = str(runtime.get("endpoint") or "")
                if multimodal_data_urls and "linkapi.org" in endpoint:
                    style_attempts = ["string", "object"]

                try:
                    timeout_seconds = int(runtime.get("timeout_seconds") or 120)
                except Exception:
                    timeout_seconds = 120
                timeout_seconds = max(5, min(timeout_seconds, 600))
                transient_max_retries = TEXT_STREAM_TRANSIENT_MAX_RETRIES
                # 分步生图词强调交互速度，限制超时并关闭自动重试，避免一次任务长时间挂起。
                if prompt_pack_mode == TEXT_PROMPT_PACK_MODE:
                    timeout_seconds = min(timeout_seconds, TEXT_PROMPT_PACK_TIMEOUT_SECONDS)
                    transient_max_retries = 0
                style_succeeded = False
                for attempt_index, style in enumerate(style_attempts):
                    transient_retry_count = 0
                    while True:
                        attempt_has_delta = False
                        request_payload: Dict[str, Any] = {
                            "model": runtime["model"],
                            "messages": [{"role": "user", "content": _build_message_content(style)}],
                            "stream": True,
                        }
                        try:
                            for delta in self._stream_openai_chat(
                                endpoint=endpoint,
                                headers=headers,
                                payload=request_payload,
                                timeout_seconds=timeout_seconds,
                            ):
                                if not delta:
                                    continue
                                attempt_has_delta = True
                                accumulated += delta
                                assistant_msg["text"] = accumulated
                                yield _event_line({"type": "delta", "delta": delta, "assistant_text": accumulated})
                            style_succeeded = True
                            break
                        except HTTPException as exc:
                            detail = str(exc.detail or "")
                            is_last = attempt_index >= (len(style_attempts) - 1)
                            # 仅在多模态、且尚未返回任何 token 时，尝试 image_url 兼容格式切换
                            if multimodal_data_urls and not attempt_has_delta and not accumulated and not is_last:
                                if "EOF occurred in violation of protocol" in detail or "image_url" in detail.lower() or "invalid" in detail.lower():
                                    break
                            # 文本上游偶发网络抖动（SSL EOF/连接重置）时，且尚未产出 token，则自动重试一次
                            if (
                                not attempt_has_delta
                                and not accumulated
                                and transient_retry_count < transient_max_retries
                                and self._is_transient_text_upstream_error(detail)
                            ):
                                transient_retry_count += 1
                                backoff = min(1.2, 0.2 * (2 ** (transient_retry_count - 1))) + random.uniform(0.0, 0.08)
                                time.sleep(backoff)
                                continue
                            raise
                    if style_succeeded:
                        break

                assistant_msg["text"] = accumulated.strip() or "已完成。"
                assistant_msg["status"] = "completed"
                session["updated_at"] = _now_iso()
                self._save_session_raw(session)
                yield _event_line(
                    {
                        "type": "done",
                        "user_message": self._hydrate_message_assets(user_msg),
                        "assistant_message": self._hydrate_message_assets(assistant_msg),
                    }
                )
            except GeneratorExit:
                if assistant_msg.get("status") == "running":
                    assistant_msg["text"] = "文本任务已中断（连接关闭），请重试。"
                    assistant_msg["status"] = "failed"
                    session["updated_at"] = _now_iso()
                    self._save_session_raw(session)
                raise
            except HTTPException as exc:
                detail = str(exc.detail or "文本生成失败")
                assistant_msg["text"] = f"文本生成失败：{detail}"
                assistant_msg["status"] = "failed"
                session["updated_at"] = _now_iso()
                self._save_session_raw(session)
                yield _event_line(
                    {
                        "type": "error",
                        "message": detail,
                        "assistant_message": self._hydrate_message_assets(assistant_msg),
                    }
                )
            except Exception as exc:
                detail = str(exc)
                assistant_msg["text"] = f"文本生成失败：{detail}"
                assistant_msg["status"] = "failed"
                session["updated_at"] = _now_iso()
                self._save_session_raw(session)
                yield _event_line(
                    {
                        "type": "error",
                        "message": detail,
                        "assistant_message": self._hydrate_message_assets(assistant_msg),
                    }
                )

        return _generator()

    def delete_image_or_404(self, image_id: str) -> None:
        index = self._load_asset_index()
        asset = index.get(image_id)
        if not asset:
            raise HTTPException(status_code=404, detail="Image not found")
        asset_title = str(asset.get("title") or "已删除图片")
        fp = asset.get("file_path") or ""
        if fp:
            p = Path(fp)
            if p.exists():
                try:
                    p.unlink()
                except Exception:
                    pass
        del index[image_id]
        self._save_asset_index(index)

        for session_meta in self._load_sessions_index():
            sid = session_meta.get("id")
            if not sid:
                continue
            raw = self._load_session_raw(sid)
            if not raw:
                continue
            changed = False
            for msg in raw.get("messages") or []:
                image_ids = msg.get("image_asset_ids") or []
                if image_id in image_ids:
                    msg["image_asset_ids"] = [x for x in image_ids if x != image_id]
                    deleted_refs = msg.get("deleted_image_refs")
                    if not isinstance(deleted_refs, list):
                        deleted_refs = []
                    if all(str(item.get("id") or "") != image_id for item in deleted_refs if isinstance(item, dict)):
                        deleted_refs.append({"id": image_id, "title": asset_title, "deleted_at": _now_iso()})
                    msg["deleted_image_refs"] = deleted_refs
                    changed = True
                attachment_ids = msg.get("attachment_asset_ids") or []
                if image_id in attachment_ids:
                    msg["attachment_asset_ids"] = [x for x in attachment_ids if x != image_id]
                    deleted_attachments = msg.get("deleted_attachment_refs")
                    if not isinstance(deleted_attachments, list):
                        deleted_attachments = []
                    if all(str(item.get("id") or "") != image_id for item in deleted_attachments if isinstance(item, dict)):
                        deleted_attachments.append({"id": image_id, "title": asset_title, "deleted_at": _now_iso()})
                    msg["deleted_attachment_refs"] = deleted_attachments
                    changed = True
            if changed:
                raw["updated_at"] = _now_iso()
                self._save_session_raw(raw)

    def save_annotations_or_404(self, image_id: str, snapshot: Dict[str, Any]) -> Dict[str, Any]:
        index = self._load_asset_index()
        asset = index.get(image_id)
        if not asset:
            raise HTTPException(status_code=404, detail="Image not found")
        asset["annotation_snapshot"] = snapshot or {}
        asset["updated_at"] = _now_iso()
        index[image_id] = asset
        self._save_asset_index(index)
        return _public_asset_from_record(asset)

    def _asset_file_path(self, aid: str) -> Optional[Path]:
        asset = self._resolve_asset(aid)
        if not asset:
            return None
        if asset.get("kind") == "official":
            return None
        fp = asset.get("file_path") or ""
        if not fp:
            return None
        p = Path(fp)
        if not p.exists():
            return None
        return p

    def get_asset_file_response(self, aid: str, thumb: bool = False):
        path = self._asset_file_path(aid)
        if not path:
            raise HTTPException(status_code=404, detail="Asset file not found")
        if not thumb:
            return FileResponse(str(path))
        with Image.open(path).convert("RGB") as img:
            img.thumbnail((360, 240))
            out = io.BytesIO()
            img.save(out, format="PNG")
        return Response(content=out.getvalue(), media_type="image/png")

    def save_asset_to_download_dir(self, aid: str) -> Dict[str, Any]:
        config = self.get_runtime_config()
        http_cfg = config.get("http") if isinstance(config.get("http"), dict) else {}
        download_dir = str(http_cfg.get("download_dir") or "").strip()
        if not download_dir:
            raise HTTPException(status_code=400, detail="请先在设置中配置下载目录")

        target_dir = Path(download_dir).expanduser()
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"下载目录不可用: {exc}") from exc
        if not target_dir.is_dir():
            raise HTTPException(status_code=400, detail="下载路径不是文件夹")

        asset = self._resolve_asset(aid)
        if not asset:
            raise HTTPException(status_code=404, detail="素材不存在")

        raw_stem = str(asset.get("title") or aid).strip() or aid
        stem = re.sub(r"[\\\\/:*?\"<>|]+", "_", raw_stem).strip(" .") or "image"

        source_path = self._asset_file_path(aid)
        binary_data: Optional[bytes] = None
        suffix = ".png"
        if source_path and source_path.exists():
            suffix = source_path.suffix.lower() or ".png"
        elif str(asset.get("kind") or "") == "official":
            preview = self.render_official_preview(aid, thumb=False)
            if not preview:
                raise HTTPException(status_code=404, detail="官方素材不存在")
            binary_data = preview
            suffix = ".png"
        else:
            raise HTTPException(status_code=404, detail="素材文件不存在")

        if suffix not in IMAGE_EXT_ALLOWLIST:
            suffix = ".png"

        target_path = target_dir / f"{stem}{suffix}"
        seq = 2
        while target_path.exists():
            target_path = target_dir / f"{stem}-{seq}{suffix}"
            seq += 1

        try:
            if binary_data is not None:
                with target_path.open("wb") as f:
                    f.write(binary_data)
            elif source_path is not None:
                shutil.copy2(source_path, target_path)
            else:
                raise HTTPException(status_code=500, detail="下载失败")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"写入下载目录失败: {exc}") from exc

        return {"saved_path": str(target_path.resolve()), "file_name": target_path.name}

    def get_official_preview(self, asset_id: str, thumb: bool = False):
        data = self.render_official_preview(asset_id, thumb=thumb)
        if not data:
            raise HTTPException(status_code=404, detail="Official asset not found")
        return Response(content=data, media_type="image/png")

    def _workflow_run_file(self, run_id: str) -> Path:
        return WORKFLOW_RUNS_DIR / f"{run_id}.json"

    def _load_workflow_runs_index(self) -> List[Dict[str, Any]]:
        payload = _read_json(WORKFLOW_RUNS_INDEX_FILE, [])
        return payload if isinstance(payload, list) else []

    def _save_workflow_runs_index(self, index: List[Dict[str, Any]]) -> None:
        _write_json(WORKFLOW_RUNS_INDEX_FILE, index)

    def _load_workflow_run_raw(self, run_id: str) -> Optional[Dict[str, Any]]:
        rid = str(run_id or "").strip()
        if not rid:
            return None
        payload = _read_json(self._workflow_run_file(rid), None)
        return payload if isinstance(payload, dict) else None

    def _save_workflow_run_raw(self, run_payload: Dict[str, Any]) -> None:
        rid = str(run_payload.get("id") or "").strip()
        if not rid:
            raise HTTPException(status_code=400, detail="run_id 不能为空")
        lock = self._get_workflow_run_lock(rid)
        with lock:
            payload = dict(run_payload)
            payload["updated_at"] = _now_iso()
            _write_json(self._workflow_run_file(rid), payload)

            index = self._load_workflow_runs_index()
            found = False
            for item in index:
                if str(item.get("id") or "").strip() != rid:
                    continue
                item.update(
                    {
                        "id": rid,
                        "name": str(payload.get("name") or ""),
                        "status": str(payload.get("status") or "idle"),
                        "workspace_id": str(payload.get("workspace_id") or ""),
                        "created_at": str(payload.get("created_at") or item.get("created_at") or _now_iso()),
                        "updated_at": str(payload.get("updated_at") or _now_iso()),
                    }
                )
                found = True
                break
            if not found:
                index.append(
                    {
                        "id": rid,
                        "name": str(payload.get("name") or ""),
                        "status": str(payload.get("status") or "idle"),
                        "workspace_id": str(payload.get("workspace_id") or ""),
                        "created_at": str(payload.get("created_at") or _now_iso()),
                        "updated_at": str(payload.get("updated_at") or _now_iso()),
                    }
                )
            index.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
            self._save_workflow_runs_index(index)

    def list_workflow_runs(self) -> List[Dict[str, Any]]:
        return self._load_workflow_runs_index()

    def get_workflow_run_or_404(self, run_id: str) -> Dict[str, Any]:
        payload = self._load_workflow_run_raw(run_id)
        if not payload:
            raise HTTPException(status_code=404, detail="运行记录不存在")
        return payload

    def _normalize_workflow_combination_mode(self, mode: Any) -> str:
        value = str(mode or "").strip().lower()
        if value in {"broadcast", "pairwise", "cartesian"}:
            return value
        return "broadcast"

    def _normalize_workflow_assets(self, raw_assets: Any) -> List[Dict[str, Any]]:
        if not isinstance(raw_assets, list):
            raw_assets = []
        result: List[Dict[str, Any]] = []
        seen: set = set()
        for index, item in enumerate(raw_assets, start=1):
            aid = ""
            title = ""
            if isinstance(item, str):
                aid = item.strip()
            elif isinstance(item, dict):
                aid = str(item.get("id") or item.get("asset_id") or "").strip()
                title = str(item.get("title") or "").strip()
            if not aid or aid in seen:
                continue
            asset = self._resolve_asset(aid)
            if not asset:
                raise HTTPException(status_code=400, detail=f"素材不存在：{aid}")
            seen.add(aid)
            result.append(
                {
                    "id": aid,
                    "title": title or str(asset.get("title") or f"素材{index}"),
                }
            )
        if not result:
            raise HTTPException(status_code=400, detail="请至少提供 1 个有效素材")
        return result

    def _normalize_workflow_prompts(self, raw_prompts: Any) -> List[Dict[str, Any]]:
        if not isinstance(raw_prompts, list):
            raw_prompts = []
        result: List[Dict[str, Any]] = []
        for index, item in enumerate(raw_prompts, start=1):
            pid = ""
            text = ""
            title = ""
            if isinstance(item, str):
                text = item.strip()
            elif isinstance(item, dict):
                pid = str(item.get("id") or "").strip()
                title = str(item.get("title") or "").strip()
                text = str(item.get("text") or item.get("prompt") or item.get("content") or "").strip()
            if not text:
                continue
            result.append(
                {
                    "id": pid or f"prompt-{index}",
                    "title": title or f"提示词{index}",
                    "text": text,
                }
            )
        if not result:
            raise HTTPException(status_code=400, detail="请至少提供 1 条有效提示词")
        return result

    def _normalize_workflow_recipes(self, raw_recipes: Any) -> List[Dict[str, Any]]:
        if not isinstance(raw_recipes, list):
            raw_recipes = []
        result: List[Dict[str, Any]] = []
        for index, item in enumerate(raw_recipes, start=1):
            recipe = item if isinstance(item, dict) else {}
            if recipe and not bool(recipe.get("enabled", True)):
                continue
            rid = str(recipe.get("id") or f"recipe-{index}").strip() or f"recipe-{index}"
            name = str(recipe.get("name") or f"配方{index}").strip() or f"配方{index}"
            prompt_template = str(recipe.get("prompt_template") or recipe.get("template") or "").strip()
            model = str(recipe.get("model") or MODEL_OPTIONS[0]["id"]).strip() or MODEL_OPTIONS[0]["id"]
            aspect_ratio = _normalize_aspect_ratio(str(recipe.get("aspect_ratio") or "3:4"))
            quality = _normalize_quality(str(recipe.get("quality") or "2K"))

            refs_raw = recipe.get("reference_asset_ids")
            refs: List[str] = []
            if isinstance(refs_raw, list):
                for aid in refs_raw:
                    text = str(aid or "").strip()
                    if not text or text in refs:
                        continue
                    if self._resolve_asset(text) is None:
                        raise HTTPException(status_code=400, detail=f"配方引用素材不存在：{text}")
                    refs.append(text)

            result.append(
                {
                    "id": rid,
                    "name": name,
                    "prompt_template": prompt_template,
                    "model": model,
                    "aspect_ratio": aspect_ratio,
                    "quality": quality,
                    "reference_asset_ids": refs,
                }
            )
        if not result:
            result.append(
                {
                    "id": "recipe-1",
                    "name": "默认配方",
                    "prompt_template": "",
                    "model": MODEL_OPTIONS[0]["id"],
                    "aspect_ratio": "3:4",
                    "quality": "2K",
                    "reference_asset_ids": [],
                }
            )
        return result

    def _normalize_workflow_slot_bindings(self, raw_bindings: Any) -> List[Dict[str, Any]]:
        if not isinstance(raw_bindings, list):
            raw_bindings = []
        bindings: List[Dict[str, Any]] = []
        seen: set = set()
        for item in raw_bindings:
            if not isinstance(item, dict):
                continue
            slot_name = str(item.get("slot_name") or item.get("name") or "").strip()
            if not slot_name or slot_name in seen:
                continue
            slot_type = str(item.get("slot_type") or item.get("type") or "dynamic").strip().lower()
            if slot_type not in {"dynamic", "fixed"}:
                slot_type = "dynamic"
            required = bool(item.get("required", True))
            asset_id = str(item.get("asset_id") or "").strip()
            if required and not asset_id:
                raise HTTPException(status_code=400, detail=f"槽位缺少素材绑定：{slot_name}")
            if asset_id and self._resolve_asset(asset_id) is None:
                raise HTTPException(status_code=400, detail=f"槽位素材不存在：{asset_id}")
            bindings.append(
                {
                    "slot_name": slot_name,
                    "slot_type": slot_type,
                    "required": required,
                    "asset_id": asset_id,
                }
            )
            seen.add(slot_name)
        return bindings

    def _extract_workflow_mentions(self, text: str) -> List[str]:
        mentions: List[str] = []
        source = str(text or "")
        for match in WORKFLOW_MENTION_PATTERN.finditer(source):
            token = str(match.group(1) or "").strip()
            if not token or token in mentions:
                continue
            mentions.append(token)
        return mentions

    def _validate_workflow_mentions(
        self,
        *,
        prompts: List[Dict[str, Any]],
        recipes: List[Dict[str, Any]],
        slot_bindings: List[Dict[str, Any]],
    ) -> None:
        slot_map: Dict[str, Dict[str, Any]] = {
            str(item.get("slot_name") or "").strip(): item for item in slot_bindings if isinstance(item, dict)
        }
        allowed_mentions = set(slot_map.keys()) | set(WORKFLOW_PRIMARY_ASSET_MENTIONS)

        mentions_in_prompts: List[str] = []
        for prompt in prompts:
            mentions_in_prompts.extend(self._extract_workflow_mentions(str(prompt.get("text") or "")))
        mentions_in_templates: List[str] = []
        for recipe in recipes:
            mentions_in_templates.extend(self._extract_workflow_mentions(str(recipe.get("prompt_template") or "")))

        seen_mentions: List[str] = []
        for token in mentions_in_prompts + mentions_in_templates:
            if token not in seen_mentions:
                seen_mentions.append(token)

        invalid = [token for token in seen_mentions if token not in allowed_mentions]
        if invalid:
            invalid_text = "、".join([f"@{token}" for token in invalid])
            raise HTTPException(status_code=400, detail=f"检测到未定义引用：{invalid_text}")

        missing_bound_slots = []
        for token in seen_mentions:
            slot = slot_map.get(token)
            if slot and not str(slot.get("asset_id") or "").strip():
                missing_bound_slots.append(token)
        if missing_bound_slots:
            missing_text = "、".join([f"@{token}" for token in missing_bound_slots])
            raise HTTPException(status_code=400, detail=f"引用槽位未绑定素材：{missing_text}")

    def _build_workflow_pairs(
        self,
        *,
        assets: List[Dict[str, Any]],
        prompts: List[Dict[str, Any]],
        combination_mode: str,
    ) -> List[Tuple[Dict[str, Any], Dict[str, Any]]]:
        mode = self._normalize_workflow_combination_mode(combination_mode)
        pairs: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        if mode == "broadcast":
            if len(assets) == 1:
                pairs = [(assets[0], prompt) for prompt in prompts]
            elif len(prompts) == 1:
                pairs = [(asset, prompts[0]) for asset in assets]
            else:
                raise HTTPException(
                    status_code=400,
                    detail="广播模式要求素材或提示词其中一侧数量为 1",
                )
        elif mode == "pairwise":
            if len(assets) != len(prompts):
                raise HTTPException(status_code=400, detail="一一对应模式要求素材数量与提示词数量一致")
            pairs = list(zip(assets, prompts))
        else:
            for asset in assets:
                for prompt in prompts:
                    pairs.append((asset, prompt))
        if len(pairs) == 0:
            raise HTTPException(status_code=400, detail="未生成有效任务对，请检查输入")
        return pairs

    def _resolve_workflow_slot_assets(self, slot_bindings: List[Dict[str, Any]]) -> List[Dict[str, str]]:
        slot_assets: List[Dict[str, str]] = []
        for item in slot_bindings:
            if not isinstance(item, dict):
                continue
            slot_name = str(item.get("slot_name") or "").strip()
            asset_id = str(item.get("asset_id") or "").strip()
            if not slot_name or not asset_id:
                continue
            asset = self._resolve_asset(asset_id)
            if not asset:
                continue
            slot_assets.append(
                {
                    "slot_name": slot_name,
                    "asset_id": asset_id,
                    "asset_title": str(asset.get("title") or asset_id),
                }
            )
        return slot_assets

    def _compose_slot_binding_hint(self, slot_assets: List[Dict[str, str]]) -> str:
        if not slot_assets:
            return ""
        lines = ["[参考槽位绑定]"]
        for item in slot_assets:
            lines.append(
                f"- {item.get('slot_name')}: {item.get('asset_title') or item.get('asset_id')} (asset_id={item.get('asset_id')})"
            )
        return "\n".join(lines)

    def _compose_recipe_prompt(
        self,
        *,
        base_prompt: str,
        recipe: Dict[str, Any],
        asset: Dict[str, Any],
        slot_assets: List[Dict[str, str]],
    ) -> str:
        prompt_text = str(base_prompt or "").strip()
        template = str(recipe.get("prompt_template") or "").strip()
        if template:
            if "{{prompt}}" in template:
                prompt_text = template.replace("{{prompt}}", prompt_text)
            else:
                prompt_text = f"{template}\n\n{prompt_text}".strip()
        prompt_text = prompt_text.replace("{{asset_title}}", str(asset.get("title") or ""))
        prompt_text = prompt_text.replace("{{asset_id}}", str(asset.get("id") or ""))
        primary_asset_text = str(asset.get("title") or asset.get("id") or "")
        for token in ("@input_asset", "@主素材"):
            if token in prompt_text:
                prompt_text = prompt_text.replace(token, f"[主素材:{primary_asset_text}]")
        for slot in slot_assets:
            slot_name = str(slot.get("slot_name") or "").strip()
            if not slot_name:
                continue
            token = f"@{slot_name}"
            if token in prompt_text:
                replacement = f"[{slot_name}:{slot.get('asset_title') or slot.get('asset_id')}]"
                prompt_text = prompt_text.replace(token, replacement)
        slot_hint = self._compose_slot_binding_hint(slot_assets)
        if slot_hint:
            prompt_text = f"{prompt_text}\n\n{slot_hint}".strip()
        return prompt_text.strip()

    def _expand_workflow_tasks(
        self,
        *,
        assets: List[Dict[str, Any]],
        prompts: List[Dict[str, Any]],
        recipes: List[Dict[str, Any]],
        slot_bindings: List[Dict[str, Any]],
        combination_mode: str,
        variants_per_item: int,
    ) -> List[Dict[str, Any]]:
        pairs = self._build_workflow_pairs(assets=assets, prompts=prompts, combination_mode=combination_mode)
        variants = max(1, min(int(variants_per_item or 1), 8))
        slot_assets = self._resolve_workflow_slot_assets(slot_bindings)
        tasks: List[Dict[str, Any]] = []
        for asset, prompt in pairs:
            for recipe in recipes:
                for variant_index in range(1, variants + 1):
                    composed_prompt = self._compose_recipe_prompt(
                        base_prompt=str(prompt.get("text") or ""),
                        recipe=recipe,
                        asset=asset,
                        slot_assets=slot_assets,
                    )
                    attachment_ids: List[str] = []
                    source_aid = str(asset.get("id") or "").strip()
                    if source_aid:
                        attachment_ids.append(source_aid)
                    for slot_item in slot_assets:
                        aid = str(slot_item.get("asset_id") or "").strip()
                        if aid and aid not in attachment_ids:
                            attachment_ids.append(aid)
                    for ref in recipe.get("reference_asset_ids") or []:
                        aid = str(ref or "").strip()
                        if aid and aid not in attachment_ids:
                            attachment_ids.append(aid)
                    tasks.append(
                        {
                            "id": f"wf-task-{uuid.uuid4().hex[:10]}",
                            "source_asset_id": source_aid,
                            "source_asset_title": str(asset.get("title") or source_aid),
                            "prompt_id": str(prompt.get("id") or ""),
                            "prompt_title": str(prompt.get("title") or ""),
                            "prompt_text": str(prompt.get("text") or ""),
                            "recipe_id": str(recipe.get("id") or ""),
                            "recipe_name": str(recipe.get("name") or ""),
                            "variant_index": variant_index,
                            "effective_prompt": composed_prompt,
                            "params": {
                                "model": str(recipe.get("model") or MODEL_OPTIONS[0]["id"]),
                                "aspect_ratio": _normalize_aspect_ratio(str(recipe.get("aspect_ratio") or "3:4")),
                                "quality": _normalize_quality(str(recipe.get("quality") or "2K")),
                                "count": 1,
                            },
                            "attachment_asset_ids": attachment_ids,
                            "slot_assets": [dict(item) for item in slot_assets],
                            "status": "pending",
                            "error": "",
                            "elapsed_seconds": 0,
                            "started_at": "",
                            "finished_at": "",
                            "result": {},
                        }
                    )
        if len(tasks) > WORKFLOW_RUN_MAX_TASKS:
            raise HTTPException(
                status_code=400,
                detail=f"任务总数 {len(tasks)} 超出上限 {WORKFLOW_RUN_MAX_TASKS}，请减少输入规模",
            )
        return tasks

    def _build_workflow_preview_payload(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        assets = self._normalize_workflow_assets(payload.get("assets"))
        prompts = self._normalize_workflow_prompts(payload.get("prompts"))
        recipes = self._normalize_workflow_recipes(payload.get("recipes"))
        slot_bindings = self._normalize_workflow_slot_bindings(payload.get("slot_bindings"))
        self._validate_workflow_mentions(prompts=prompts, recipes=recipes, slot_bindings=slot_bindings)
        combination_mode = self._normalize_workflow_combination_mode(payload.get("combination_mode"))
        variants_per_item = max(1, min(int(payload.get("variants_per_item") or 1), 8))
        concurrency = max(1, min(int(payload.get("concurrency") or 2), 8))
        tasks = self._expand_workflow_tasks(
            assets=assets,
            prompts=prompts,
            recipes=recipes,
            slot_bindings=slot_bindings,
            combination_mode=combination_mode,
            variants_per_item=variants_per_item,
        )
        sample = [
            {
                "task_id": item.get("id"),
                "source_asset_id": item.get("source_asset_id"),
                "source_asset_title": item.get("source_asset_title"),
                "prompt_id": item.get("prompt_id"),
                "recipe_id": item.get("recipe_id"),
                "variant_index": item.get("variant_index"),
                "prompt_preview": str(item.get("effective_prompt") or "")[:120],
                "slot_assets": item.get("slot_assets") if isinstance(item.get("slot_assets"), list) else [],
                "attachment_asset_ids": item.get("attachment_asset_ids") if isinstance(item.get("attachment_asset_ids"), list) else [],
            }
            for item in tasks[: min(5, len(tasks))]
        ]
        expanded_tasks = [
            {
                "task_id": item.get("id"),
                "source_asset_id": item.get("source_asset_id"),
                "source_asset_title": item.get("source_asset_title"),
                "prompt_id": item.get("prompt_id"),
                "prompt_title": item.get("prompt_title"),
                "prompt_text": item.get("prompt_text"),
                "recipe_id": item.get("recipe_id"),
                "recipe_name": item.get("recipe_name"),
                "variant_index": item.get("variant_index"),
                "effective_prompt": item.get("effective_prompt"),
                "slot_assets": item.get("slot_assets") if isinstance(item.get("slot_assets"), list) else [],
                "attachment_asset_ids": item.get("attachment_asset_ids") if isinstance(item.get("attachment_asset_ids"), list) else [],
            }
            for item in tasks
        ]
        return {
            "assets": assets,
            "prompts": prompts,
            "recipes": recipes,
            "slot_bindings": slot_bindings,
            "combination_mode": combination_mode,
            "variants_per_item": variants_per_item,
            "concurrency": concurrency,
            "tasks": tasks,
            "total_tasks": len(tasks),
            "limit": WORKFLOW_RUN_MAX_TASKS,
            "sample_tasks": sample,
            "expanded_tasks": expanded_tasks,
        }

    def preview_workflow_run(self, payload: WorkflowRunPreviewRequest) -> Dict[str, Any]:
        built = self._build_workflow_preview_payload(payload.model_dump())
        return {
            "combination_mode": built["combination_mode"],
            "variants_per_item": built["variants_per_item"],
            "concurrency": built["concurrency"],
            "total_tasks": built["total_tasks"],
            "limit": built["limit"],
            "assets_count": len(built["assets"]),
            "prompts_count": len(built["prompts"]),
            "recipes_count": len(built["recipes"]),
            "sample_tasks": built["sample_tasks"],
            "expanded_tasks": built["expanded_tasks"],
            "slot_bindings": built["slot_bindings"],
        }

    def _calc_workflow_run_summary(self, tasks: List[Dict[str, Any]]) -> Dict[str, int]:
        summary = {"total": len(tasks), "pending": 0, "running": 0, "completed": 0, "failed": 0}
        for item in tasks:
            status = str(item.get("status") or "pending").strip().lower()
            if status in summary:
                summary[status] += 1
            elif status == "paused":
                summary["pending"] += 1
            else:
                summary["pending"] += 1
        return summary

    def _execute_workflow_task(self, workspace_id: str, task: Dict[str, Any]) -> Dict[str, Any]:
        started = time.monotonic()
        try:
            turn = self.create_turn(
                session_id=workspace_id,
                text=str(task.get("effective_prompt") or ""),
                params=task.get("params") if isinstance(task.get("params"), dict) else {},
                attachment_asset_ids=list(task.get("attachment_asset_ids") or []),
                references=[],
                annotation_context={},
                annotation_contexts=[],
            )
            assistant = turn.get("assistant_message") if isinstance(turn, dict) else {}
            images = assistant.get("images") if isinstance(assistant, dict) else []
            image_asset_ids: List[str] = []
            if isinstance(images, list):
                for item in images:
                    if not isinstance(item, dict):
                        continue
                    aid = str(item.get("id") or "").strip()
                    if aid:
                        image_asset_ids.append(aid)
            elapsed_seconds = max(1, int(time.monotonic() - started))
            return {
                "ok": True,
                "elapsed_seconds": elapsed_seconds,
                "output": {
                    "assistant_text": str((assistant or {}).get("text") or ""),
                    "image_asset_ids": image_asset_ids,
                },
            }
        except Exception as exc:
            elapsed_seconds = max(1, int(time.monotonic() - started))
            detail = str(exc)
            if isinstance(exc, HTTPException):
                detail = str(exc.detail or detail)
            return {
                "ok": False,
                "elapsed_seconds": elapsed_seconds,
                "error": detail or "任务执行失败",
                "output": {},
            }

    def _get_run_task_by_id(self, run_payload: Dict[str, Any], task_id: str) -> Optional[Dict[str, Any]]:
        tasks = run_payload.get("tasks")
        if not isinstance(tasks, list):
            return None
        for item in tasks:
            if not isinstance(item, dict):
                continue
            if str(item.get("id") or "").strip() == task_id:
                return item
        return None

    def _execute_workflow_run_background(self, run_id: str) -> None:
        try:
            run_payload = self.get_workflow_run_or_404(run_id)
            if str(run_payload.get("status") or "") != "running":
                return
            workspace_id = str(run_payload.get("workspace_id") or "").strip()
            tasks = run_payload.get("tasks")
            if not workspace_id or not isinstance(tasks, list):
                run_payload["status"] = "failed"
                run_payload["error"] = "运行记录缺少 workspace 或任务列表"
                run_payload["summary"] = self._calc_workflow_run_summary(tasks if isinstance(tasks, list) else [])
                self._save_workflow_run_raw(run_payload)
                return

            concurrency = max(1, min(int(run_payload.get("concurrency") or 2), 8))
            stop_dispatch = False
            pending_ids = [
                str(item.get("id") or "")
                for item in tasks
                if isinstance(item, dict) and str(item.get("status") or "pending") == "pending"
            ]
            future_map: Dict[concurrent.futures.Future, str] = {}
            with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
                while pending_ids and not stop_dispatch and len(future_map) < concurrency:
                    task_id = pending_ids.pop(0)
                    task = self._get_run_task_by_id(run_payload, task_id)
                    if not task:
                        continue
                    task["status"] = "running"
                    task["started_at"] = _now_iso()
                    task["error"] = ""
                    run_payload["summary"] = self._calc_workflow_run_summary(tasks)
                    self._save_workflow_run_raw(run_payload)
                    future = executor.submit(self._execute_workflow_task, workspace_id, dict(task))
                    future_map[future] = task_id

                while future_map:
                    done, _ = concurrent.futures.wait(
                        list(future_map.keys()),
                        return_when=concurrent.futures.FIRST_COMPLETED,
                    )
                    for future in done:
                        task_id = future_map.pop(future)
                        task = self._get_run_task_by_id(run_payload, task_id)
                        if not task:
                            continue
                        result = future.result()
                        task["elapsed_seconds"] = int(result.get("elapsed_seconds") or 0)
                        task["finished_at"] = _now_iso()
                        task["result"] = result.get("output") if isinstance(result.get("output"), dict) else {}
                        if bool(result.get("ok")):
                            task["status"] = "completed"
                            task["error"] = ""
                        else:
                            task["status"] = "failed"
                            task["error"] = str(result.get("error") or "任务执行失败")
                            stop_dispatch = True
                        run_payload["summary"] = self._calc_workflow_run_summary(tasks)
                        self._save_workflow_run_raw(run_payload)

                    while pending_ids and not stop_dispatch and len(future_map) < concurrency:
                        task_id = pending_ids.pop(0)
                        task = self._get_run_task_by_id(run_payload, task_id)
                        if not task:
                            continue
                        task["status"] = "running"
                        task["started_at"] = _now_iso()
                        task["error"] = ""
                        run_payload["summary"] = self._calc_workflow_run_summary(tasks)
                        self._save_workflow_run_raw(run_payload)
                        future = executor.submit(self._execute_workflow_task, workspace_id, dict(task))
                        future_map[future] = task_id

            summary = self._calc_workflow_run_summary(tasks)
            run_payload["summary"] = summary
            run_payload["status"] = "paused" if summary.get("failed", 0) > 0 else "completed"
            self._save_workflow_run_raw(run_payload)
        finally:
            with self._workflow_runner_guard:
                self._workflow_runner_threads.pop(str(run_id or "").strip(), None)

    def _start_workflow_run_background(self, run_id: str) -> None:
        rid = str(run_id or "").strip()
        if not rid:
            return
        with self._workflow_runner_guard:
            existing = self._workflow_runner_threads.get(rid)
            if existing and existing.is_alive():
                return
            thread = threading.Thread(target=self._execute_workflow_run_background, args=(rid,), daemon=True)
            self._workflow_runner_threads[rid] = thread
            thread.start()

    def create_workflow_run(self, payload: WorkflowRunCreateRequest) -> Dict[str, Any]:
        built = self._build_workflow_preview_payload(payload.model_dump())
        requested_workspace_id = str(payload.workspace_id or "").strip()
        workspace_id = requested_workspace_id
        if requested_workspace_id:
            if not self._load_session_raw(requested_workspace_id):
                raise HTTPException(status_code=404, detail="workspace_id 不存在")
        else:
            created = self.create_session(str(payload.name or "工作流批运行").strip() or "工作流批运行")
            workspace_id = str(created.get("id") or "").strip()

        now = _now_iso()
        run_payload = {
            "id": f"wf-run-{uuid.uuid4().hex[:10]}",
            "name": str(payload.name or "工作流批运行").strip() or "工作流批运行",
            "workspace_id": workspace_id,
            "status": "running",
            "combination_mode": built["combination_mode"],
            "variants_per_item": built["variants_per_item"],
            "concurrency": built["concurrency"],
            "limit": built["limit"],
            "assets": built["assets"],
            "prompts": built["prompts"],
            "recipes": built["recipes"],
            "slot_bindings": built["slot_bindings"],
            "tasks": built["tasks"],
            "summary": self._calc_workflow_run_summary(built["tasks"]),
            "created_at": now,
            "updated_at": now,
        }
        self._save_workflow_run_raw(run_payload)
        self._start_workflow_run_background(run_payload["id"])
        return run_payload

    def retry_workflow_run_task(self, run_id: str, task_id: str) -> Dict[str, Any]:
        rid = str(run_id or "").strip()
        tid = str(task_id or "").strip()
        if not rid or not tid:
            raise HTTPException(status_code=400, detail="run_id/task_id 不能为空")
        run_payload = self.get_workflow_run_or_404(rid)
        if str(run_payload.get("status") or "").strip() == "running":
            raise HTTPException(status_code=409, detail="运行中不可重试，请稍后再试")
        task = self._get_run_task_by_id(run_payload, tid)
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")
        if str(task.get("status") or "").strip() != "failed":
            raise HTTPException(status_code=400, detail="仅失败任务可重试")

        workspace_id = str(run_payload.get("workspace_id") or "").strip()
        if not workspace_id or self._load_session_raw(workspace_id) is None:
            raise HTTPException(status_code=404, detail="运行关联 workspace 不存在")

        task["status"] = "running"
        task["started_at"] = _now_iso()
        task["finished_at"] = ""
        task["elapsed_seconds"] = 0
        task["error"] = ""
        task["result"] = {}
        run_payload["status"] = "running"
        run_payload["summary"] = self._calc_workflow_run_summary(run_payload.get("tasks") if isinstance(run_payload.get("tasks"), list) else [])
        self._save_workflow_run_raw(run_payload)

        result = self._execute_workflow_task(workspace_id, dict(task))
        task["elapsed_seconds"] = int(result.get("elapsed_seconds") or 0)
        task["finished_at"] = _now_iso()
        task["result"] = result.get("output") if isinstance(result.get("output"), dict) else {}
        if bool(result.get("ok")):
            task["status"] = "completed"
            task["error"] = ""
        else:
            task["status"] = "failed"
            task["error"] = str(result.get("error") or "任务执行失败")

        run_payload["summary"] = self._calc_workflow_run_summary(run_payload.get("tasks") if isinstance(run_payload.get("tasks"), list) else [])
        if int(run_payload["summary"].get("failed", 0)) > 0:
            run_payload["status"] = "paused"
        elif int(run_payload["summary"].get("pending", 0)) > 0:
            run_payload["status"] = "running"
        else:
            run_payload["status"] = "completed"
        self._save_workflow_run_raw(run_payload)

        if str(run_payload.get("status") or "") == "running":
            self._start_workflow_run_background(rid)
        return run_payload

    def _load_workflow_templates(self) -> List[Dict[str, Any]]:
        payload = _read_json(WORKFLOW_TEMPLATES_FILE, [])
        return payload if isinstance(payload, list) else []

    def _save_workflow_templates(self, templates: List[Dict[str, Any]]) -> None:
        _write_json(WORKFLOW_TEMPLATES_FILE, templates)

    def list_workflow_templates(self) -> List[Dict[str, Any]]:
        templates = self._load_workflow_templates()
        templates.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        return templates

    def create_workflow_template(self, payload: WorkflowTemplateCreateRequest) -> Dict[str, Any]:
        name = str(payload.name or "").strip() or "未命名模板"
        description = str(payload.description or "").strip()
        graph = payload.graph if isinstance(payload.graph, dict) else {}
        tags = [str(item or "").strip() for item in (payload.tags or [])]
        normalized_tags = [tag for tag in tags if tag]

        now = _now_iso()
        template = {
            "id": f"wf-template-{uuid.uuid4().hex[:10]}",
            "name": name,
            "description": description,
            "graph": graph,
            "tags": normalized_tags,
            "created_at": now,
            "updated_at": now,
        }

        templates = self._load_workflow_templates()
        templates.append(template)
        self._save_workflow_templates(templates)
        return template

    def update_workflow_template(self, template_id: str, payload: WorkflowTemplateUpdateRequest) -> Dict[str, Any]:
        target_id = str(template_id or "").strip()
        if not target_id:
            raise HTTPException(status_code=400, detail="模板 ID 不能为空")

        templates = self._load_workflow_templates()
        for idx, item in enumerate(templates):
            if str(item.get("id") or "").strip() != target_id:
                continue
            next_item = dict(item)
            if payload.name is not None:
                name = str(payload.name or "").strip()
                if name:
                    next_item["name"] = name
            if payload.description is not None:
                next_item["description"] = str(payload.description or "").strip()
            if payload.graph is not None:
                next_item["graph"] = payload.graph if isinstance(payload.graph, dict) else {}
            if payload.tags is not None:
                tags = [str(tag or "").strip() for tag in payload.tags]
                next_item["tags"] = [tag for tag in tags if tag]
            next_item["updated_at"] = _now_iso()
            templates[idx] = next_item
            self._save_workflow_templates(templates)
            return next_item
        raise HTTPException(status_code=404, detail="模板不存在")

    def delete_workflow_template(self, template_id: str) -> None:
        target_id = str(template_id or "").strip()
        templates = self._load_workflow_templates()
        next_templates = [item for item in templates if str(item.get("id") or "").strip() != target_id]
        if len(next_templates) == len(templates):
            raise HTTPException(status_code=404, detail="模板不存在")
        self._save_workflow_templates(next_templates)

    def _load_workflow_prompt_cards(self) -> List[Dict[str, Any]]:
        payload = _read_json(WORKFLOW_PROMPT_CARDS_FILE, [])
        return payload if isinstance(payload, list) else []

    def _save_workflow_prompt_cards(self, cards: List[Dict[str, Any]]) -> None:
        _write_json(WORKFLOW_PROMPT_CARDS_FILE, cards)

    def list_workflow_prompt_cards(self) -> List[Dict[str, Any]]:
        cards = self._load_workflow_prompt_cards()
        cards.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        return cards

    def create_workflow_prompt_card(self, payload: WorkflowPromptCardCreateRequest) -> Dict[str, Any]:
        name = str(payload.name or "").strip() or "未命名指令卡片"
        text = str(payload.text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="指令内容不能为空")
        tags = [str(item or "").strip() for item in (payload.tags or [])]
        normalized_tags = [tag for tag in tags if tag]

        now = _now_iso()
        card = {
            "id": f"wf-prompt-card-{uuid.uuid4().hex[:10]}",
            "name": name,
            "text": text,
            "tags": normalized_tags,
            "created_at": now,
            "updated_at": now,
        }
        cards = self._load_workflow_prompt_cards()
        cards.append(card)
        self._save_workflow_prompt_cards(cards)
        return card

    def update_workflow_prompt_card(self, card_id: str, payload: WorkflowPromptCardUpdateRequest) -> Dict[str, Any]:
        target_id = str(card_id or "").strip()
        if not target_id:
            raise HTTPException(status_code=400, detail="卡片 ID 不能为空")

        cards = self._load_workflow_prompt_cards()
        for idx, item in enumerate(cards):
            if str(item.get("id") or "").strip() != target_id:
                continue
            next_item = dict(item)
            if payload.name is not None:
                next_item["name"] = str(payload.name or "").strip() or "未命名指令卡片"
            if payload.text is not None:
                text = str(payload.text or "").strip()
                if not text:
                    raise HTTPException(status_code=400, detail="指令内容不能为空")
                next_item["text"] = text
            if payload.tags is not None:
                tags = [str(tag or "").strip() for tag in payload.tags]
                next_item["tags"] = [tag for tag in tags if tag]
            next_item["updated_at"] = _now_iso()
            cards[idx] = next_item
            self._save_workflow_prompt_cards(cards)
            return next_item
        raise HTTPException(status_code=404, detail="指令卡片不存在")

    def delete_workflow_prompt_card(self, card_id: str) -> None:
        target_id = str(card_id or "").strip()
        cards = self._load_workflow_prompt_cards()
        next_cards = [item for item in cards if str(item.get("id") or "").strip() != target_id]
        if len(next_cards) == len(cards):
            raise HTTPException(status_code=404, detail="指令卡片不存在")
        self._save_workflow_prompt_cards(next_cards)

    def _normalize_workflow_bridge_config(self, payload: Any) -> Dict[str, Any]:
        if not isinstance(payload, dict):
            payload = {}
        base_url = str(payload.get("base_url") or DEFAULT_WORKFLOW_BRIDGE_CONFIG["base_url"]).strip()
        if not base_url:
            base_url = DEFAULT_WORKFLOW_BRIDGE_CONFIG["base_url"]
        base_url = base_url.rstrip("/")
        enabled = bool(payload.get("enabled", DEFAULT_WORKFLOW_BRIDGE_CONFIG["enabled"]))
        return {"base_url": base_url, "enabled": enabled}

    def get_workflow_bridge_config(self) -> Dict[str, Any]:
        payload = _read_json(WORKFLOW_BRIDGE_CONFIG_FILE, DEFAULT_WORKFLOW_BRIDGE_CONFIG)
        normalized = self._normalize_workflow_bridge_config(payload)
        return normalized

    def update_workflow_bridge_config(self, payload: WorkflowBridgeConfigRequest) -> Dict[str, Any]:
        next_config = self._normalize_workflow_bridge_config(payload.model_dump())
        _write_json(WORKFLOW_BRIDGE_CONFIG_FILE, next_config)
        return next_config

    def _request_workflow_bridge_json(
        self,
        path: str,
        query: Optional[Dict[str, Any]] = None,
    ) -> Any:
        bridge_cfg = self.get_workflow_bridge_config()
        base_url = str(bridge_cfg.get("base_url") or "").strip().rstrip("/")
        if not base_url:
            raise HTTPException(status_code=400, detail="Bridge base_url 未配置")
        normalized_path = path if path.startswith("/") else f"/{path}"
        url = f"{base_url}{normalized_path}"
        if query:
            encoded = urlencode(
                {k: v for k, v in query.items() if v is not None and str(v) != ""},
                doseq=True,
            )
            if encoded:
                url = f"{url}?{encoded}"

        req = urllib_request.Request(
            url,
            headers={"Accept": "application/json"},
            method="GET",
        )
        try:
            with urllib_request.urlopen(req, timeout=25) as resp:
                raw = resp.read().decode("utf-8")
        except urllib_error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8")
            except Exception:
                detail = str(exc.reason or "")
            detail = detail.strip()[:260]
            raise HTTPException(status_code=502, detail=f"Bridge 请求失败：HTTP {exc.code} {detail}".strip()) from exc
        except urllib_error.URLError as exc:
            raise HTTPException(status_code=502, detail=f"Bridge 网络错误：{exc.reason}") from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Bridge 请求异常：{exc}") from exc

        try:
            return json.loads(raw or "{}")
        except Exception as exc:
            raise HTTPException(status_code=502, detail="Bridge 返回非 JSON") from exc

    def bridge_get_options(self) -> Dict[str, Any]:
        payload = self._request_workflow_bridge_json("/api/v1/options")
        return payload if isinstance(payload, dict) else {}

    def bridge_list_workspaces(self) -> List[Dict[str, Any]]:
        payload = self._request_workflow_bridge_json("/api/v1/workspaces")
        if not isinstance(payload, list):
            return []
        return [item for item in payload if isinstance(item, dict)]

    def bridge_get_workspace(self, workspace_id: str) -> Dict[str, Any]:
        sid = str(workspace_id or "").strip()
        if not sid:
            raise HTTPException(status_code=400, detail="workspace_id 不能为空")
        payload = self._request_workflow_bridge_json(f"/api/v1/workspaces/{sid}")
        return payload if isinstance(payload, dict) else {}

    def bridge_list_assets(
        self,
        cursor: Optional[str] = None,
        limit: int = 80,
        kind: Optional[str] = None,
        search: Optional[str] = None,
        workspace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload = self._request_workflow_bridge_json(
            "/api/v1/assets/library",
            query={
                "cursor": cursor,
                "limit": max(1, min(int(limit or 80), 200)),
                "kind": kind,
                "search": search,
                "workspace_id": workspace_id,
            },
        )
        return payload if isinstance(payload, dict) else {"items": [], "has_more": False, "next_cursor": None, "total": 0}


app_service = StudioService()
