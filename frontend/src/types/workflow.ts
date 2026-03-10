import type { StudioAsset, StudioComposerMode } from './studio';

export type WorkflowNodeKind = 'start' | 'input' | 'batch' | 'review' | 'display' | 'transform' | 'merge' | 'save' | 'end';

export interface WorkflowPosition {
  x: number;
  y: number;
}

export interface WorkflowReferenceAsset {
  id: string;
  source: 'local' | 'bridge';
  title?: string;
}

export interface WorkflowInputNodeData {
  label: string;
  prompt: string;
  mode: StudioComposerMode;
  model: string;
  aspect_ratio: string;
  quality: string;
  count: number;
  references: WorkflowReferenceAsset[];
}

export interface WorkflowStartNodeData {
  label: string;
}

export interface WorkflowReviewNodeData {
  label: string;
  instruction: string;
}

export interface WorkflowBatchNodeData {
  label: string;
}

export interface WorkflowDisplayNodeData {
  label: string;
  showRawJson: boolean;
}

export interface WorkflowTransformNodeData {
  label: string;
  prompt_template: string;
  mode: StudioComposerMode;
  model: string;
}

export interface WorkflowMergeNodeData {
  label: string;
  strategy: 'text_concat' | 'asset_collect';
}

export interface WorkflowSaveNodeData {
  label: string;
  category: 'image' | 'text' | 'mixed';
}

export interface WorkflowEndNodeData {
  label: string;
}

export type WorkflowNodeData =
  | WorkflowStartNodeData
  | WorkflowInputNodeData
  | WorkflowBatchNodeData
  | WorkflowReviewNodeData
  | WorkflowDisplayNodeData
  | WorkflowTransformNodeData
  | WorkflowMergeNodeData
  | WorkflowSaveNodeData
  | WorkflowEndNodeData;

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeKind;
  position: WorkflowPosition;
  data: WorkflowNodeData;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  graph: WorkflowGraph;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowPromptCard {
  id: string;
  name: string;
  text: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export type WorkflowStepStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'skipped';

export interface WorkflowNodeOutput {
  kind: 'none' | 'text' | 'image' | 'mixed';
  text?: string;
  assets?: StudioAsset[];
  value?: unknown;
}

export interface WorkflowRunStep {
  node_id: string;
  node_label: string;
  node_type: WorkflowNodeKind;
  status: WorkflowStepStatus;
  started_at?: string;
  finished_at?: string;
  elapsed_seconds: number;
  output?: WorkflowNodeOutput;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
  steps: WorkflowRunStep[];
  outputs: Array<{
    id: string;
    run_id: string;
    node_id: string;
    category: 'image' | 'text' | 'mixed';
    title: string;
    content: WorkflowNodeOutput;
    created_at: string;
  }>;
  waiting_review_node_id?: string;
}

export interface WorkflowBridgeConfig {
  base_url: string;
  enabled: boolean;
}

export interface WorkflowStorageView {
  templates: WorkflowTemplate[];
  outputs: WorkflowRun['outputs'];
  assets: StudioAsset[];
}

export type WorkflowCombinationMode = 'broadcast' | 'pairwise' | 'cartesian';

export interface WorkflowRunAssetInput {
  id: string;
  title?: string;
}

export interface WorkflowRunPromptInput {
  id?: string;
  title?: string;
  text: string;
}

export interface WorkflowRunRecipeInput {
  id?: string;
  name?: string;
  prompt_template?: string;
  model?: string;
  aspect_ratio?: string;
  quality?: string;
  reference_asset_ids?: string[];
  enabled?: boolean;
}

export interface WorkflowRunSlotBindingInput {
  slot_name: string;
  slot_type?: 'dynamic' | 'fixed';
  required?: boolean;
  asset_id?: string;
}

export interface WorkflowRunPreviewRequest {
  assets: WorkflowRunAssetInput[];
  prompts: WorkflowRunPromptInput[];
  recipes?: WorkflowRunRecipeInput[];
  combination_mode: WorkflowCombinationMode;
  variants_per_item: number;
  concurrency: number;
  slot_bindings?: WorkflowRunSlotBindingInput[];
}

export interface WorkflowRunCreateRequest extends WorkflowRunPreviewRequest {
  workspace_id?: string;
  name?: string;
}

export interface WorkflowRunTaskSnapshot {
  id: string;
  source_asset_id: string;
  source_asset_title: string;
  prompt_id: string;
  prompt_title: string;
  prompt_text: string;
  recipe_id: string;
  recipe_name: string;
  variant_index: number;
  effective_prompt: string;
  params: Record<string, unknown>;
  attachment_asset_ids: string[];
  slot_assets?: Array<{
    slot_name: string;
    asset_id: string;
    asset_title?: string;
  }>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error: string;
  elapsed_seconds: number;
  started_at: string;
  finished_at: string;
  result: Record<string, unknown>;
}

export interface WorkflowRunSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface WorkflowRunSnapshot {
  id: string;
  name: string;
  workspace_id: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  combination_mode: WorkflowCombinationMode;
  variants_per_item: number;
  concurrency: number;
  limit: number;
  assets: WorkflowRunAssetInput[];
  prompts: WorkflowRunPromptInput[];
  recipes: WorkflowRunRecipeInput[];
  slot_bindings: WorkflowRunSlotBindingInput[];
  tasks: WorkflowRunTaskSnapshot[];
  summary: WorkflowRunSummary;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunPreviewResponse {
  combination_mode: WorkflowCombinationMode;
  variants_per_item: number;
  concurrency: number;
  total_tasks: number;
  limit: number;
  assets_count: number;
  prompts_count: number;
  recipes_count: number;
  sample_tasks: Array<{
    task_id: string;
    source_asset_id: string;
    source_asset_title?: string;
    prompt_id: string;
    recipe_id: string;
    variant_index: number;
    prompt_preview: string;
    slot_assets?: Array<{
      slot_name: string;
      asset_id: string;
      asset_title?: string;
    }>;
    attachment_asset_ids?: string[];
  }>;
  expanded_tasks?: Array<{
    task_id: string;
    source_asset_id: string;
    source_asset_title?: string;
    prompt_id: string;
    prompt_title?: string;
    prompt_text?: string;
    recipe_id: string;
    recipe_name?: string;
    variant_index: number;
    effective_prompt: string;
    slot_assets?: Array<{
      slot_name: string;
      asset_id: string;
      asset_title?: string;
    }>;
    attachment_asset_ids?: string[];
  }>;
  slot_bindings: WorkflowRunSlotBindingInput[];
}
