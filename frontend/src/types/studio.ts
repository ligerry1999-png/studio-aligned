export interface StudioModelOption {
  id: string;
  name: string;
}

export interface StudioOptions {
  models: StudioModelOption[];
  aspect_ratios: string[];
  qualities: string[];
  counts: number[];
}

export interface RuntimeHttpConfig {
  endpoint: string;
  api_key: string;
  response_format: 'url' | 'b64_json';
  timeout_seconds: number;
  download_dir: string;
}

export interface RuntimeConfig {
  http: RuntimeHttpConfig;
}

export interface MentionSourceItem {
  id: string;
  title: string;
  order: number;
  tags: string[];
  storage_key: string;
  file_url?: string;
  thumbnail_url?: string;
}

export interface MentionSourceConfig {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  kind: 'dynamic' | 'static';
  items: MentionSourceItem[];
}

export interface MentionSettings {
  composer_placeholder: string;
  search_placeholder: string;
  upload_button_text: string;
  sources: MentionSourceConfig[];
  official_prompts: OfficialPrompt[];
  official_taxonomies: OfficialTaxonomies;
}

export interface GenerationParams {
  model: string;
  aspect_ratio: string;
  quality: string;
  count: number;
}

export interface ComposerReference {
  mention_id: string;
  slot: string;
  asset_id: string;
  source?: string;
  order?: number;
  asset_title?: string;
}

export interface AnnotationObjectPayload {
  id: string;
  shape_id: string;
  bbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  text: string;
}

export interface AnnotationMoveRelationPayload {
  source_id: string;
  target_id: string;
}

export interface AnnotationContextPayload {
  asset_id: string;
  objects: AnnotationObjectPayload[];
  move_relation?: AnnotationMoveRelationPayload | null;
}

export interface StudioAsset {
  id: string;
  kind: string;
  title: string;
  file_url?: string;
  thumbnail_url?: string;
  tags?: string[];
  annotation_snapshot?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StudioMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  created_at?: string;
  status?: string;
  params?: Partial<GenerationParams>;
  attachments?: StudioAsset[];
  images?: StudioAsset[];
  references?: Array<ComposerReference & { asset?: StudioAsset }>;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceDetail {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  messages: StudioMessage[];
}

export interface CreateTurnPayload {
  text: string;
  params: GenerationParams;
  attachment_asset_ids: string[];
  references?: ComposerReference[];
  annotation_context?: AnnotationContextPayload;
}

export interface TurnResult {
  user_message: StudioMessage;
  assistant_message: StudioMessage;
}

export interface OfficialTaxonomies {
  scene: string[];
  style: string[];
  material: string[];
  lighting: string[];
}

export interface OfficialPrompt {
  id: string;
  title: string;
  content: string;
}

export interface OfficialAssetPageResult {
  items: StudioAsset[];
  has_more: boolean;
  next_cursor: string | null;
  total: number;
}

export interface OfficialAssetQuery {
  cursor?: string | null;
  limit?: number;
  scene?: string;
  style?: string;
  material?: string;
  lighting?: string;
  search?: string;
}

export interface AssetLibraryQuery {
  cursor?: string | null;
  limit?: number;
  kind?: string;
  search?: string;
  workspace_id?: string;
}

export interface AssetLibraryResult {
  items: StudioAsset[];
  has_more: boolean;
  next_cursor: string | null;
  total: number;
}
