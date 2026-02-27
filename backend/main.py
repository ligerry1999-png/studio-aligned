from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from service import (
    CreateSessionRequest,
    CreateTurnRequest,
    ImportSessionRequest,
    RuntimeConfigRequest,
    SaveAnnotationRequest,
    UpdateAssetRequest,
    app_service,
)


def create_app() -> FastAPI:
    app = FastAPI(title="Interior Prompt Studio API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:5174",
            "http://localhost:5174",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=True,
    )

    @app.get("/api/v1/options")
    def get_options():
        return app_service.get_options()

    @app.get("/api/v1/runtime-config")
    def get_runtime_config():
        return app_service.get_runtime_config()

    @app.put("/api/v1/runtime-config")
    def update_runtime_config(payload: RuntimeConfigRequest):
        return app_service.update_runtime_config(payload.model_dump())

    @app.get("/api/v1/mention-settings")
    def get_mention_settings():
        return app_service.get_mention_settings()

    @app.put("/api/v1/mention-settings")
    def update_mention_settings(payload: Dict[str, Any]):
        return app_service.update_mention_settings(payload)

    @app.post("/api/v1/mention-settings/items/upload")
    async def upload_mention_static_item(source_id: str, file: UploadFile = File(...)):
        content = await file.read()
        return app_service.upload_mention_static_item(source_id=source_id, filename=file.filename or "upload.png", content=content)

    @app.get("/api/v1/mention-settings/items/{item_id}/file")
    def get_mention_static_item_file(item_id: str, thumb: int = 0):
        return app_service.get_mention_static_item_file_response(item_id=item_id, thumb=bool(thumb))

    @app.get("/api/v1/workspaces")
    def list_workspaces():
        return app_service.list_sessions()

    @app.post("/api/v1/workspaces")
    def create_workspace(payload: CreateSessionRequest):
        return app_service.create_session(payload.name)

    @app.post("/api/v1/workspaces/import")
    def import_workspace(payload: ImportSessionRequest):
        return app_service.import_session(payload.model_dump())

    @app.get("/api/v1/workspaces/{workspace_id}")
    def get_workspace(workspace_id: str):
        return app_service.get_session_or_404(workspace_id)

    @app.delete("/api/v1/workspaces/{workspace_id}")
    def delete_workspace(workspace_id: str):
        app_service.delete_session(workspace_id)
        return {"status": "success"}

    @app.post("/api/v1/assets/upload")
    async def upload_assets(files: List[UploadFile] = File(...), workspace_id: Optional[str] = Form(None)):
        payload = []
        for f in files:
            content = await f.read()
            payload.append((f.filename or "upload.png", content))
        return {"items": app_service.upload_assets(payload, workspace_id=workspace_id)}

    @app.post("/api/v1/assets")
    async def upload_assets_compat(files: List[UploadFile] = File(...), workspace_id: Optional[str] = Form(None)):
        payload = []
        for f in files:
            content = await f.read()
            payload.append((f.filename or "upload.png", content))
        return {"items": app_service.upload_assets(payload, workspace_id=workspace_id)}

    @app.patch("/api/v1/assets/{asset_id}")
    def update_asset(asset_id: str, payload: UpdateAssetRequest):
        return app_service.update_asset_meta_or_404(
            asset_id=asset_id,
            title=payload.title,
            tags=payload.tags,
        )

    @app.post("/api/v1/assets/{asset_id}/download-local")
    def download_asset_to_local(asset_id: str):
        return app_service.save_asset_to_download_dir(asset_id)

    @app.post("/api/v1/workspaces/{workspace_id}/turns")
    def create_turn(workspace_id: str, payload: CreateTurnRequest):
        return app_service.create_turn(
            session_id=workspace_id,
            text=payload.text,
            params=payload.params,
            attachment_asset_ids=payload.attachment_asset_ids,
            references=payload.references,
            annotation_context=payload.annotation_context,
            annotation_contexts=payload.annotation_contexts,
        )

    @app.delete("/api/v1/images/{image_id}")
    def delete_image(image_id: str):
        app_service.delete_image_or_404(image_id)
        return {"status": "success"}

    @app.post("/api/v1/images/{image_id}/annotations")
    def save_annotations(image_id: str, payload: SaveAnnotationRequest):
        return app_service.save_annotations_or_404(image_id, payload.snapshot)

    @app.get("/api/v1/assets/{asset_id}/file")
    def get_asset_file(asset_id: str, thumb: int = 0):
        return app_service.get_asset_file_response(asset_id, thumb=bool(thumb))

    @app.get("/api/v1/assets/library")
    def get_assets_library(
        cursor: Optional[str] = None,
        limit: int = 80,
        kind: Optional[str] = None,
        search: Optional[str] = None,
        workspace_id: Optional[str] = None,
    ):
        return app_service.list_assets(
            cursor=cursor,
            limit=limit,
            kind=kind,
            search=search,
            workspace_id=workspace_id,
        )

    @app.get("/api/v1/official-taxonomies")
    def get_taxonomies(dimension: Optional[str] = None):
        return app_service.list_official_taxonomies(dimension)

    @app.get("/api/v1/official-assets/page")
    def get_official_assets_page(
        cursor: Optional[str] = None,
        limit: int = 24,
        scene: Optional[str] = None,
        style: Optional[str] = None,
        material: Optional[str] = None,
        lighting: Optional[str] = None,
        search: Optional[str] = None,
    ):
        return app_service.page_official_assets(
            cursor=cursor,
            limit=limit,
            scene=scene,
            style=style,
            material=material,
            lighting=lighting,
            search=search,
        )

    @app.get("/api/v1/official-assets/{asset_id}/preview")
    def official_preview(asset_id: str, thumb: int = 0):
        return app_service.get_official_preview(asset_id=asset_id, thumb=bool(thumb))

    @app.get("/api/v1/official-prompts")
    def get_official_prompts():
        return app_service.get_official_prompts()

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.post("/api/v1/system/select-directory")
    def select_directory():
        return app_service.select_download_directory()

    return app


app = create_app()
