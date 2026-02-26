import type {
  AssetLibraryQuery,
  AssetLibraryResult,
  CreateTurnPayload,
  MentionSettings,
  MentionSourceItem,
  OfficialAssetPageResult,
  OfficialAssetQuery,
  OfficialPrompt,
  OfficialTaxonomies,
  RuntimeConfig,
  StudioAsset,
  StudioOptions,
  TurnResult,
  WorkspaceDetail,
  WorkspaceSummary,
} from '../types/studio';

const API_BASE = String(import.meta.env.VITE_API_BASE_URL || '')
  .trim()
  .replace(/\/$/, '');
const BROWSER_ORIGIN = typeof window !== 'undefined' ? window.location.origin.replace(/\/$/, '') : '';

function buildUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  if (path.startsWith('/')) {
    return API_BASE ? `${API_BASE}${path}` : path;
  }
  if (API_BASE) {
    return `${API_BASE}/${path}`;
  }
  return `/${path.replace(/^\/+/, '')}`;
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

export function resolveAssetUrl(raw?: string): string {
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('/')) {
    if (API_BASE) return `${API_BASE}${raw}`;
    return BROWSER_ORIGIN ? `${BROWSER_ORIGIN}${raw}` : raw;
  }
  if (API_BASE) return `${API_BASE}/${raw}`;
  return BROWSER_ORIGIN ? `${BROWSER_ORIGIN}/${raw.replace(/^\/+/, '')}` : raw;
}

export function getApiBase(): string {
  return API_BASE || BROWSER_ORIGIN || '';
}

export const studioApi = {
  getOptions(): Promise<StudioOptions> {
    return requestJson<StudioOptions>('/api/v1/options');
  },
  getRuntimeConfig(): Promise<RuntimeConfig> {
    return requestJson<RuntimeConfig>('/api/v1/runtime-config');
  },
  updateRuntimeConfig(payload: RuntimeConfig): Promise<RuntimeConfig> {
    return requestJson<RuntimeConfig>('/api/v1/runtime-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  getMentionSettings(): Promise<MentionSettings> {
    return requestJson<MentionSettings>('/api/v1/mention-settings');
  },
  updateMentionSettings(payload: MentionSettings): Promise<MentionSettings> {
    return requestJson<MentionSettings>('/api/v1/mention-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  uploadMentionStaticItem(sourceId: string, file: File): Promise<MentionSourceItem> {
    const formData = new FormData();
    formData.append('source_id', sourceId);
    formData.append('file', file, file.name);
    return requestJson<MentionSourceItem>('/api/v1/mention-settings/items/upload', {
      method: 'POST',
      body: formData,
    });
  },
  listWorkspaces(): Promise<WorkspaceSummary[]> {
    return requestJson<WorkspaceSummary[]>('/api/v1/workspaces');
  },
  createWorkspace(name: string): Promise<WorkspaceDetail> {
    return requestJson<WorkspaceDetail>('/api/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  },
  getWorkspace(workspaceId: string): Promise<WorkspaceDetail> {
    return requestJson<WorkspaceDetail>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`);
  },
  deleteWorkspace(workspaceId: string): Promise<{ status: string }> {
    return requestJson<{ status: string }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    });
  },
  uploadAssets(files: File[], workspaceId?: string): Promise<{ items: StudioAsset[] }> {
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file, file.name));
    if (workspaceId) {
      formData.append('workspace_id', workspaceId);
    }
    return requestJson<{ items: StudioAsset[] }>('/api/v1/assets/upload', {
      method: 'POST',
      body: formData,
    });
  },
  updateAssetMeta(assetId: string, payload: { title?: string; tags?: string[] }): Promise<StudioAsset> {
    return requestJson<StudioAsset>(`/api/v1/assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  downloadAssetToLocal(assetId: string): Promise<{ saved_path: string; file_name: string }> {
    return requestJson<{ saved_path: string; file_name: string }>(
      `/api/v1/assets/${encodeURIComponent(assetId)}/download-local`,
      {
        method: 'POST',
      },
    );
  },
  selectDirectory(): Promise<{ path: string }> {
    return requestJson<{ path: string }>('/api/v1/system/select-directory', {
      method: 'POST',
    });
  },
  createTurn(workspaceId: string, payload: CreateTurnPayload): Promise<TurnResult> {
    return requestJson<TurnResult>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  deleteImage(imageId: string): Promise<{ status: string }> {
    return requestJson<{ status: string }>(`/api/v1/images/${encodeURIComponent(imageId)}`, {
      method: 'DELETE',
    });
  },
  saveAnnotation(imageId: string, snapshot: Record<string, unknown>): Promise<StudioAsset> {
    return requestJson<StudioAsset>(`/api/v1/images/${encodeURIComponent(imageId)}/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot }),
    });
  },
  getOfficialTaxonomies(): Promise<OfficialTaxonomies> {
    return requestJson<OfficialTaxonomies>('/api/v1/official-taxonomies');
  },
  pageOfficialAssets(query: OfficialAssetQuery): Promise<OfficialAssetPageResult> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit ?? 24));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.scene) params.set('scene', query.scene);
    if (query.style) params.set('style', query.style);
    if (query.material) params.set('material', query.material);
    if (query.lighting) params.set('lighting', query.lighting);
    if (query.search) params.set('search', query.search);
    return requestJson<OfficialAssetPageResult>(`/api/v1/official-assets/page?${params.toString()}`);
  },
  getOfficialPrompts(): Promise<OfficialPrompt[]> {
    return requestJson<OfficialPrompt[]>('/api/v1/official-prompts');
  },
  listAssetLibrary(query: AssetLibraryQuery = {}): Promise<AssetLibraryResult> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit ?? 80));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.kind) params.set('kind', query.kind);
    if (query.search) params.set('search', query.search);
    if (query.workspace_id) params.set('workspace_id', query.workspace_id);
    return requestJson<AssetLibraryResult>(`/api/v1/assets/library?${params.toString()}`);
  },
};
