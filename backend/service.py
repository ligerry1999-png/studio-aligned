import base64
import concurrent.futures
import io
import json
import os
import random
import re
import shutil
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlparse

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


class SaveAnnotationRequest(BaseModel):
    snapshot: Dict[str, Any] = Field(default_factory=dict)


class ImportSessionRequest(BaseModel):
    name: Optional[str] = None
    messages: List[Dict[str, Any]] = Field(default_factory=list)


class RuntimeHttpConfigRequest(BaseModel):
    endpoint: str = Field(default="")
    api_key: str = Field(default="")
    response_format: str = Field(default="url")
    timeout_seconds: int = Field(default=120)
    download_dir: str = Field(default="")


class RuntimeConfigRequest(BaseModel):
    http: RuntimeHttpConfigRequest = Field(default_factory=RuntimeHttpConfigRequest)


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

IMAGE_EXT_ALLOWLIST = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}

MODEL_OPTIONS = [
    {"id": "xiaodoubao-nano-banana", "name": "xiaodoubao"},
]
ASPECT_RATIO_OPTIONS = ["4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "1:1", "4:5", "5:4", "21:9"]
QUALITY_OPTIONS = ["1K", "2K", "4K"]
COUNT_OPTIONS = [1, 2, 3, 4]
PROTECTED_MENTION_SOURCE_IDS = {"upload", "generated", "saved"}
# 每张图仅请求一次，避免“选择1张却触发多次计费请求”
HTTP_GENERATE_MAX_ATTEMPTS = 1

DEFAULT_RUNTIME_CONFIG: Dict[str, Any] = {
    "http": {
        "endpoint": "",
        "api_key": "",
        "response_format": "url",
        "timeout_seconds": 120,
        "download_dir": "",
    },
}


def _runtime_http_api_key_from_env() -> str:
    for name in ("STUDIO_HTTP_API_KEY", "XIAODOUBAO_API_KEY", "HTTP_API_KEY"):
        value = str(os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


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
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    tmp_path.replace(path)


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


def _normalize_runtime_config(payload: Any) -> Dict[str, Any]:
    cfg = {
        "http": {
            "endpoint": "",
            "api_key": "",
            "response_format": "url",
            "timeout_seconds": 120,
            "download_dir": "",
        },
    }
    if not isinstance(payload, dict):
        return cfg

    http_payload = payload.get("http")
    if isinstance(http_payload, dict):
        cfg["http"]["endpoint"] = str(http_payload.get("endpoint") or "").strip()
        cfg["http"]["api_key"] = str(http_payload.get("api_key") or "")
        response_format = str(http_payload.get("response_format") or "url").strip().lower()
        cfg["http"]["response_format"] = "b64_json" if response_format == "b64_json" else "url"

        try:
            timeout = int(http_payload.get("timeout_seconds") or 120)
        except Exception:
            timeout = 120
        cfg["http"]["timeout_seconds"] = max(5, min(timeout, 600))
        cfg["http"]["download_dir"] = str(http_payload.get("download_dir") or "").strip()

    return cfg


def _default_mention_settings(prompts: List[Dict[str, Any]], taxonomies: Dict[str, List[str]]) -> Dict[str, Any]:
    return {
        "composer_placeholder": "描述你的想法，输入@触发选择素材，单条消息最多9张素材",
        "search_placeholder": "搜索素材标题...",
        "upload_button_text": "点击 / 拖拽 / 粘贴 上传",
        "sources": [
            {"id": "upload", "name": "上传", "enabled": True, "order": 1, "kind": "dynamic", "items": []},
            {"id": "generated", "name": "生成", "enabled": True, "order": 2, "kind": "dynamic", "items": []},
            {"id": "saved", "name": "素材库", "enabled": True, "order": 3, "kind": "dynamic", "items": []},
            {"id": "official", "name": "官方", "enabled": True, "order": 4, "kind": "dynamic", "items": []},
        ],
        "official_prompts": prompts,
        "official_taxonomies": taxonomies,
    }


def _normalize_source_item(item: Any, index: int) -> Dict[str, Any]:
    if not isinstance(item, dict):
        item = {}
    sid = str(item.get("id") or f"static-{uuid.uuid4().hex[:10]}")
    title = str(item.get("title") or "未命名素材").strip() or "未命名素材"
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
    storage_key = str(item.get("storage_key") or "").strip()
    return {
        "id": sid,
        "title": title,
        "order": max(1, order),
        "tags": tags,
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
        items_raw = source.get("items")
        items: List[Dict[str, Any]] = []
        if source_kind == "static" and isinstance(items_raw, list):
            items = [_normalize_source_item(item, i) for i, item in enumerate(items_raw)]
            items.sort(key=lambda x: int(x.get("order") or 0))
        sources.append(
            {
                "id": source_id,
                "name": source_name,
                "enabled": enabled,
                "order": max(1, order),
                "kind": source_kind,
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


class StudioService:
    def __init__(self):
        self.ensure_runtime()

    def ensure_runtime(self) -> None:
        DATA_ROOT.mkdir(parents=True, exist_ok=True)
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        ASSETS_DIR.mkdir(parents=True, exist_ok=True)
        GENERATED_DIR.mkdir(parents=True, exist_ok=True)
        MENTION_SOURCE_DIR.mkdir(parents=True, exist_ok=True)
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
        _write_json(self._session_file(sid), session)
        index = self._load_sessions_index()
        found = False
        for item in index:
            if item.get("id") == sid:
                item["name"] = session.get("name", "")
                item["updated_at"] = session.get("updated_at", _now_iso())
                item["created_at"] = session.get("created_at", item.get("created_at", _now_iso()))
                found = True
                break
        if not found:
            index.append(
                {
                    "id": sid,
                    "name": session.get("name", "未命名会话"),
                    "created_at": session.get("created_at", _now_iso()),
                    "updated_at": session.get("updated_at", _now_iso()),
                }
            )
        index.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
        self._save_sessions_index(index)

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
        env_managed = bool(_runtime_http_api_key_from_env())
        if env_managed:
            normalized["http"]["api_key"] = ""
        normalized["http"]["api_key_managed_by_env"] = env_managed
        return normalized

    def update_runtime_config(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        normalized = _normalize_runtime_config(payload)
        if _runtime_http_api_key_from_env():
            normalized["http"]["api_key"] = ""
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
            item_list: List[Dict[str, Any]] = []
            for item in source.get("items") or []:
                if not isinstance(item, dict):
                    continue
                item_out = dict(item)
                item_id = str(item.get("id") or "").strip()
                if item_id:
                    item_out["file_url"] = f"/api/v1/mention-settings/items/{item_id}/file"
                    item_out["thumbnail_url"] = f"/api/v1/mention-settings/items/{item_id}/file?thumb=1"
                item_list.append(item_out)
            source_out = dict(source)
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
            "created_at": now,
            "updated_at": now,
            "messages": [],
        }
        self._save_session_raw(session)
        return session

    def import_session(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        created = self.create_session(name=payload.get("name"))
        raw = self._load_session_raw(created["id"]) or created
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
        hydrated = dict(raw)
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

    def _asset_to_b64(self, asset_id: str) -> Optional[str]:
        asset = self._resolve_asset(asset_id)
        if not asset:
            return None
        content: Optional[bytes] = None
        if asset.get("kind") == "official":
            content = self.render_official_preview(asset_id, thumb=False)
        else:
            fp = str(asset.get("file_path") or "")
            if fp:
                path = Path(fp)
                if path.exists():
                    try:
                        content = path.read_bytes()
                    except Exception:
                        content = None
        if not content:
            return None
        return base64.b64encode(content).decode("utf-8")

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

    def _annotation_context_to_prompt(self, context: Dict[str, Any]) -> str:
        if not isinstance(context, dict):
            return ""
        objects = context.get("objects")
        if not isinstance(objects, list) or len(objects) == 0:
            return ""
        lines = ["[标注上下文]"]
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
            lines.append(f"- {object_id}{bbox_desc}: {text or '未填写'}")
        move_relation = context.get("move_relation")
        if isinstance(move_relation, dict):
            source_id = str(move_relation.get("source_id") or "").strip()
            target_id = str(move_relation.get("target_id") or "").strip()
            if source_id and target_id:
                lines.append(f"- 移动关系: {source_id} -> {target_id}")
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
            for _attempt in range(max(1, HTTP_GENERATE_MAX_ATTEMPTS)):
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
        normalized_annotation_context = self._normalize_annotation_context(annotation_context)
        annotation_asset_id = str(normalized_annotation_context.get("asset_id") or "").strip()
        if annotation_asset_id and annotation_asset_id not in valid_attachment_ids and self._resolve_asset(annotation_asset_id):
            valid_attachment_ids.insert(0, annotation_asset_id)
        composed_text = (text or "").strip()
        annotation_prompt = self._annotation_context_to_prompt(normalized_annotation_context)
        if annotation_prompt:
            if composed_text:
                composed_text = f"{annotation_prompt}\n\n原始需求:\n{composed_text}"
            else:
                composed_text = annotation_prompt
        user_msg = {
            "id": f"msg-{uuid.uuid4().hex[:10]}",
            "role": "user",
            "text": (text or "").strip(),
            "params": normalized_params,
            "attachment_asset_ids": valid_attachment_ids,
            "image_asset_ids": [],
            "references": valid_references,
            "annotation_context": normalized_annotation_context,
            "status": "completed",
            "created_at": _now_iso(),
        }
        assistant_msg = {
            "id": f"msg-{uuid.uuid4().hex[:10]}",
            "role": "assistant",
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


app_service = StudioService()
