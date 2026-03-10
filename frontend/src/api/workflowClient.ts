import { getApiBase } from './client';
import type { AssetLibraryResult, OfficialAssetQuery, StudioAsset, StudioOptions, WorkspaceDetail, WorkspaceSummary } from '../types/studio';
import type {
  WorkflowBridgeConfig,
  WorkflowGraph,
  WorkflowPromptCard,
  WorkflowRunCreateRequest,
  WorkflowRunPreviewRequest,
  WorkflowRunPreviewResponse,
  WorkflowRunSnapshot,
  WorkflowTemplate,
} from '../types/workflow';

function buildUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const base = String(getApiBase() || '').replace(/\/$/, '');
  if (!base) return path;
  if (path.startsWith('/')) return `${base}${path}`;
  return `${base}/${path}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildUrl(path), init);
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { detail: text };
  }
  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'detail' in parsed
        ? String((parsed as { detail?: unknown }).detail || `请求失败 (${response.status})`)
        : `请求失败 (${response.status})`;
    throw new Error(message);
  }
  return parsed as T;
}

export const workflowApi = {
  listRuns(): Promise<Array<{ id: string; name: string; status: string; workspace_id: string; created_at: string; updated_at: string }>> {
    return requestJson<Array<{ id: string; name: string; status: string; workspace_id: string; created_at: string; updated_at: string }>>(
      '/api/v1/workflow/runs',
    );
  },
  previewRun(payload: WorkflowRunPreviewRequest): Promise<WorkflowRunPreviewResponse> {
    return requestJson<WorkflowRunPreviewResponse>('/api/v1/workflow/runs/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  createRun(payload: WorkflowRunCreateRequest): Promise<WorkflowRunSnapshot> {
    return requestJson<WorkflowRunSnapshot>('/api/v1/workflow/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  getRun(runId: string): Promise<WorkflowRunSnapshot> {
    return requestJson<WorkflowRunSnapshot>(`/api/v1/workflow/runs/${encodeURIComponent(runId)}`);
  },
  retryRunTask(runId: string, taskId: string): Promise<WorkflowRunSnapshot> {
    return requestJson<WorkflowRunSnapshot>(`/api/v1/workflow/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: 'POST',
    });
  },
  listTemplates(): Promise<WorkflowTemplate[]> {
    return requestJson<WorkflowTemplate[]>('/api/v1/workflow/templates');
  },
  listPromptCards(): Promise<WorkflowPromptCard[]> {
    return requestJson<WorkflowPromptCard[]>('/api/v1/workflow/prompt-cards');
  },
  createPromptCard(payload: { name: string; text: string; tags?: string[] }): Promise<WorkflowPromptCard> {
    return requestJson<WorkflowPromptCard>('/api/v1/workflow/prompt-cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  updatePromptCard(
    cardId: string,
    payload: Partial<{ name: string; text: string; tags: string[] }>,
  ): Promise<WorkflowPromptCard> {
    return requestJson<WorkflowPromptCard>(`/api/v1/workflow/prompt-cards/${encodeURIComponent(cardId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  deletePromptCard(cardId: string): Promise<{ status: string }> {
    return requestJson<{ status: string }>(`/api/v1/workflow/prompt-cards/${encodeURIComponent(cardId)}`, {
      method: 'DELETE',
    });
  },
  createTemplate(payload: { name: string; description: string; graph: WorkflowGraph; tags: string[] }): Promise<WorkflowTemplate> {
    return requestJson<WorkflowTemplate>('/api/v1/workflow/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  updateTemplate(
    templateId: string,
    payload: Partial<{ name: string; description: string; graph: WorkflowGraph; tags: string[] }>,
  ): Promise<WorkflowTemplate> {
    return requestJson<WorkflowTemplate>(`/api/v1/workflow/templates/${encodeURIComponent(templateId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  deleteTemplate(templateId: string): Promise<{ status: string }> {
    return requestJson<{ status: string }>(`/api/v1/workflow/templates/${encodeURIComponent(templateId)}`, {
      method: 'DELETE',
    });
  },
  getBridgeConfig(): Promise<WorkflowBridgeConfig> {
    return requestJson<WorkflowBridgeConfig>('/api/v1/workflow/bridge/config');
  },
  updateBridgeConfig(payload: WorkflowBridgeConfig): Promise<WorkflowBridgeConfig> {
    return requestJson<WorkflowBridgeConfig>('/api/v1/workflow/bridge/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  bridgeGetOptions(): Promise<StudioOptions> {
    return requestJson<StudioOptions>('/api/v1/workflow/bridge/options');
  },
  bridgeListWorkspaces(): Promise<WorkspaceSummary[]> {
    return requestJson<WorkspaceSummary[]>('/api/v1/workflow/bridge/workspaces');
  },
  bridgeGetWorkspace(workspaceId: string): Promise<WorkspaceDetail> {
    return requestJson<WorkspaceDetail>(`/api/v1/workflow/bridge/workspaces/${encodeURIComponent(workspaceId)}`);
  },
  bridgeListAssets(query: OfficialAssetQuery & { workspace_id?: string }): Promise<AssetLibraryResult> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit ?? 80));
    if (query.cursor) params.set('cursor', String(query.cursor));
    if (query.search) params.set('search', query.search);
    if (query.workspace_id) params.set('workspace_id', query.workspace_id);
    if (query.scene) params.set('scene', query.scene);
    if (query.style) params.set('style', query.style);
    if (query.material) params.set('material', query.material);
    if (query.lighting) params.set('lighting', query.lighting);
    return requestJson<AssetLibraryResult>(`/api/v1/workflow/bridge/assets/library?${params.toString()}`);
  },
  listLocalAssets(query: { cursor?: string | null; limit?: number; kind?: string; search?: string; workspace_id?: string }): Promise<AssetLibraryResult> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit ?? 80));
    if (query.cursor) params.set('cursor', String(query.cursor));
    if (query.kind) params.set('kind', query.kind);
    if (query.search) params.set('search', query.search);
    if (query.workspace_id) params.set('workspace_id', query.workspace_id);
    return requestJson<AssetLibraryResult>(`/api/v1/assets/library?${params.toString()}`);
  },
  getAssetById(assets: StudioAsset[], id: string): StudioAsset | null {
    return assets.find((item) => item.id === id) || null;
  },
};
