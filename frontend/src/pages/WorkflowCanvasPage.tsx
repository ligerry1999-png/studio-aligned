import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  Menu,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { resolveAssetUrl, studioApi } from '../api/client';
import { workflowApi } from '../api/workflowClient';
import { WorkflowRichPromptEditor, type WorkflowRichMentionOption } from '../components/WorkflowRichPromptEditor';
import type { RuntimeConfig, StudioAsset, StudioComposerMode, StudioOptions } from '../types/studio';
import type {
  WorkflowBridgeConfig,
  WorkflowCombinationMode,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowInputNodeData,
  WorkflowMergeNodeData,
  WorkflowNode,
  WorkflowNodeData,
  WorkflowNodeKind,
  WorkflowNodeOutput,
  WorkflowRunCreateRequest,
  WorkflowRunPreviewResponse,
  WorkflowRunSlotBindingInput,
  WorkflowRunSnapshot,
  WorkflowBatchNodeData,
  WorkflowPromptCard,
  WorkflowReviewNodeData,
  WorkflowRun,
  WorkflowTemplate,
  WorkflowTransformNodeData,
} from '../types/workflow';

const WORKFLOW_EXECUTOR_WORKSPACE_NAME = '画布流程执行器';
const WORKFLOW_EXECUTOR_WORKSPACE_KEY = 'studio_aligned_workflow_workspace_id_v1';
const WORKFLOW_OUTPUTS_STORAGE_KEY = 'studio_aligned_workflow_outputs_v1';
const WORKFLOW_CANVAS_DRAFT_STORAGE_KEY = 'studio_aligned_workflow_canvas_draft_v1';
const MAX_STORED_OUTPUTS = 200;
const SLOT_NAME_PATTERN = /^[\u4e00-\u9fa5a-zA-Z][\u4e00-\u9fa5a-zA-Z0-9_]*$/;
const PRIMARY_ASSET_MENTION_TOKENS = ['@主素材', '@input_asset'] as const;
const DEFAULT_BATCH_SLOT_BINDINGS: WorkflowRunSlotBindingInput[] = [];

const NODE_TITLES: Record<WorkflowNodeKind, string> = {
  start: '开始节点',
  input: '输入节点',
  batch: '批量节点',
  review: '审核节点',
  display: '显示节点',
  transform: '转换节点',
  merge: '合并节点',
  save: '存储节点',
  end: '结束节点',
};

const NODE_COLORS: Record<WorkflowNodeKind, string> = {
  start: '#edf8ff',
  input: '#f4f9ff',
  batch: '#f1f8ff',
  review: '#fff8f1',
  display: '#f6f5ff',
  transform: '#f1fff7',
  merge: '#fff5fb',
  save: '#f7f7f7',
  end: '#fff2f2',
};

const MENTIONABLE_NODE_KINDS = new Set<WorkflowNodeKind>(['input', 'batch', 'transform', 'merge', 'display', 'save']);

const IMAGE_DEFAULTS = {
  aspect_ratio: '3:4',
  quality: '2K',
  count: 1,
};

type FlowNode = Node<WorkflowNodeData>;
type FlowEdge = Edge;

interface StoredOutputItem {
  id: string;
  run_id: string;
  node_id: string;
  category: 'image' | 'text' | 'mixed';
  title: string;
  content: WorkflowNodeOutput;
  created_at: string;
}

interface PendingReviewState {
  node_id: string;
  node_label: string;
  output: WorkflowNodeOutput;
  incoming_sources: Array<{ id: string; label: string }>;
}

type ReviewDecision = { action: 'approve' | 'edit'; editedText?: string };

interface BranchRetryRequest {
  reviewNodeId: string;
  sourceNodeId?: string;
}

interface BatchPromptTemplateCard {
  id: string;
  library_card_id?: string;
  name: string;
  text: string;
  enabled: boolean;
}

interface BatchTaskCard {
  id: string;
  name: string;
  asset_id: string;
  prompt_card_id: string;
  enabled: boolean;
}

interface BatchLocalPairPreview {
  asset_id: string;
  asset_title: string;
  prompt_id: string;
  prompt_title: string;
  prompt_text: string;
}

type BatchComposerSection = 'assets' | 'templates' | 'task_cards' | 'execute' | 'slots' | 'preview';
type BatchAssetPickerTab = 'upload' | 'generated' | 'library' | 'bridge';
type BatchPromptPickerTab = 'library' | 'create';
type BatchTemplateMentionTarget = { type: 'rule' | 'prompt' | 'prompt_create'; promptCardId?: string };

const BATCH_COMPOSER_SECTION_META: Array<{ id: BatchComposerSection; label: string }> = [
  { id: 'assets', label: '主图素材' },
  { id: 'templates', label: '模板池' },
  { id: 'task_cards', label: '任务卡片' },
  { id: 'execute', label: '执行参数' },
  { id: 'slots', label: '槽位映射' },
  { id: 'preview', label: '预演与运行' },
];

const BATCH_ASSET_PICKER_TAB_META: Array<{ id: BatchAssetPickerTab; label: string }> = [
  { id: 'upload', label: '上传' },
  { id: 'generated', label: '生成' },
  { id: 'library', label: '素材库' },
  { id: 'bridge', label: 'Bridge' },
];

const BATCH_PROMPT_PICKER_TAB_META: Array<{ id: BatchPromptPickerTab; label: string }> = [
  { id: 'library', label: '卡片库' },
  { id: 'create', label: '新建卡片' },
];

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}

function readStoredOutputs(): StoredOutputItem[] {
  try {
    const raw = window.localStorage.getItem(WORKFLOW_OUTPUTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as StoredOutputItem[];
  } catch {
    return [];
  }
}

function writeStoredOutputs(items: StoredOutputItem[]): void {
  try {
    window.localStorage.setItem(WORKFLOW_OUTPUTS_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore localStorage write error
  }
}

function getDefaultCanvasState(): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: [makeFlowNode('start', { x: 80, y: 120 })],
    edges: [],
  };
}

function readCanvasDraft(): { nodes: FlowNode[]; edges: FlowEdge[] } | null {
  try {
    const raw = window.localStorage.getItem(WORKFLOW_CANVAS_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkflowGraph;
    if (!parsed || !isTemplateGraphSafe(parsed)) return null;
    const restored = fromWorkflowGraph(parsed);
    if (restored.nodes.length === 0) return null;
    return restored;
  } catch {
    return null;
  }
}

function writeCanvasDraft(nodes: FlowNode[], edges: FlowEdge[]): void {
  try {
    const graph = toWorkflowGraph(nodes, edges);
    window.localStorage.setItem(WORKFLOW_CANVAS_DRAFT_STORAGE_KEY, JSON.stringify(graph));
  } catch {
    // ignore localStorage write error
  }
}

function getDefaultNodeData(type: WorkflowNodeKind): WorkflowNodeData {
  if (type === 'start') {
    return {
      label: '开始节点',
    };
  }
  if (type === 'input') {
    const data: WorkflowInputNodeData = {
      label: '输入节点',
      prompt: '',
      mode: 'image',
      model: '',
      aspect_ratio: IMAGE_DEFAULTS.aspect_ratio,
      quality: IMAGE_DEFAULTS.quality,
      count: IMAGE_DEFAULTS.count,
      references: [],
    };
    return data;
  }
  if (type === 'review') {
    const data: WorkflowReviewNodeData = {
      label: '审核节点',
      instruction: '请审核本节点输出，选择通过、重跑或编辑后继续。',
    };
    return data;
  }
  if (type === 'batch') {
    const data: WorkflowBatchNodeData = {
      label: '批量节点',
    };
    return data;
  }
  if (type === 'display') {
    return {
      label: '显示节点',
      showRawJson: false,
    };
  }
  if (type === 'transform') {
    const data: WorkflowTransformNodeData = {
      label: '转换节点',
      prompt_template: '请基于以下内容改写：\n{{input}}',
      mode: 'text',
      model: 'gpt-4.1-mini',
    };
    return data;
  }
  if (type === 'merge') {
    const data: WorkflowMergeNodeData = {
      label: '合并节点',
      strategy: 'text_concat',
    };
    return data;
  }
  if (type === 'end') {
    return {
      label: '结束节点',
    };
  }
  return {
    label: '存储节点',
    category: 'mixed',
  };
}

function makeFlowNode(type: WorkflowNodeKind, position: { x: number; y: number }): FlowNode {
  return {
    id: makeId(type),
    type,
    position,
    data: getDefaultNodeData(type),
  };
}

function toWorkflowGraph(nodes: FlowNode[], edges: FlowEdge[]): WorkflowGraph {
  const graphNodes: WorkflowNode[] = nodes.map((node) => ({
    id: node.id,
    type: (node.type as WorkflowNodeKind) || 'input',
    position: node.position,
    data: node.data,
  }));
  const graphEdges: WorkflowEdge[] = edges.map((edge) => {
    const label = typeof edge.label === 'string' ? edge.label : undefined;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label,
    };
  });
  return { nodes: graphNodes, edges: graphEdges };
}

function fromWorkflowGraph(graph: WorkflowGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = (graph.nodes || []).map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position || { x: 0, y: 0 },
    data: node.data,
  }));
  const edges: FlowEdge[] = (graph.edges || []).map((edge) => ({
    id: edge.id || makeId('edge'),
    source: edge.source,
    target: edge.target,
    label: edge.label,
    markerEnd: { type: MarkerType.ArrowClosed },
    animated: false,
  }));
  return { nodes, edges };
}

function outputToText(output: WorkflowNodeOutput | undefined): string {
  if (!output) return '';
  if (output.text && String(output.text).trim()) return String(output.text);
  if (Array.isArray(output.assets) && output.assets.length > 0) {
    return output.assets
      .map((asset) => resolveAssetUrl(asset.file_url || asset.thumbnail_url || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (output.value !== undefined && output.value !== null) {
    try {
      return JSON.stringify(output.value, null, 2);
    } catch {
      return String(output.value);
    }
  }
  return '';
}

function summarizeOutput(output: WorkflowNodeOutput | undefined): string {
  if (!output) return '无输出';
  if (output.kind === 'text') {
    const text = String(output.text || '').trim();
    return text ? text.slice(0, 80) : '文本为空';
  }
  if (output.kind === 'image') {
    return `图片 ${output.assets?.length || 0} 张`;
  }
  if (output.kind === 'mixed') {
    const textPart = output.text ? `文本 ${String(output.text).slice(0, 40)}` : '无文本';
    return `${textPart} / 图片 ${output.assets?.length || 0} 张`;
  }
  return '无输出';
}

function createBatchPromptTemplateCard(index: number): BatchPromptTemplateCard {
  return {
    id: makeId('prompt-card'),
    name: `指令模板${index}`,
    text: '',
    enabled: true,
  };
}

function createBatchTaskCard(index: number, promptCardId: string): BatchTaskCard {
  return {
    id: makeId('task-card'),
    name: `任务卡片${index}`,
    asset_id: '',
    prompt_card_id: promptCardId,
    enabled: true,
  };
}

function promptsFromTemplateCards(cards: BatchPromptTemplateCard[]): Array<{ id: string; title: string; text: string }> {
  return cards
    .filter((card) => card.enabled && String(card.text || '').trim())
    .map((card, index) => ({
      id: `prompt-${index + 1}`,
      title: String(card.name || '').trim() || `指令模板${index + 1}`,
      text: String(card.text || '').trim(),
    }));
}

function buildLocalBatchPairs(
  assets: Array<{ id: string; title: string }>,
  prompts: Array<{ id: string; title: string; text: string }>,
  mode: WorkflowCombinationMode,
): { pairs: BatchLocalPairPreview[]; error: string } {
  if (assets.length === 0) {
    return { pairs: [], error: '请先至少选择 1 张主图素材。' };
  }
  if (prompts.length === 0) {
    return { pairs: [], error: '请先至少启用并填写 1 个指令模板卡片。' };
  }

  if (mode === 'broadcast') {
    if (assets.length === 1) {
      return {
        pairs: prompts.map((prompt) => ({
          asset_id: assets[0].id,
          asset_title: assets[0].title,
          prompt_id: prompt.id,
          prompt_title: prompt.title,
          prompt_text: prompt.text,
        })),
        error: '',
      };
    }
    if (prompts.length === 1) {
      return {
        pairs: assets.map((asset) => ({
          asset_id: asset.id,
          asset_title: asset.title,
          prompt_id: prompts[0].id,
          prompt_title: prompts[0].title,
          prompt_text: prompts[0].text,
        })),
        error: '',
      };
    }
    return {
      pairs: [],
      error: '当前是“多图同规则 / 单图多规则”模式：主图和模板里，必须有一侧数量为 1。',
    };
  }

  if (mode === 'pairwise') {
    if (assets.length !== prompts.length) {
      return {
        pairs: [],
        error: `当前是“图词一一配对”模式：主图数量(${assets.length})和模板数量(${prompts.length})必须一致。`,
      };
    }
    return {
      pairs: assets.map((asset, index) => {
        const prompt = prompts[index];
        return {
          asset_id: asset.id,
          asset_title: asset.title,
          prompt_id: prompt.id,
          prompt_title: prompt.title,
          prompt_text: prompt.text,
        };
      }),
      error: '',
    };
  }

  const cartesianPairs: BatchLocalPairPreview[] = [];
  assets.forEach((asset) => {
    prompts.forEach((prompt) => {
      cartesianPairs.push({
        asset_id: asset.id,
        asset_title: asset.title,
        prompt_id: prompt.id,
        prompt_title: prompt.title,
        prompt_text: prompt.text,
      });
    });
  });
  return { pairs: cartesianPairs, error: '' };
}

function normalizeSlotName(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, '_');
}

function normalizeBatchSlotBindings(bindings: WorkflowRunSlotBindingInput[]): WorkflowRunSlotBindingInput[] {
  const out: WorkflowRunSlotBindingInput[] = [];
  const seen = new Set<string>();
  (bindings || []).forEach((item) => {
    const slotName = normalizeSlotName(item.slot_name || '');
    if (!slotName || seen.has(slotName)) return;
    seen.add(slotName);
    out.push({
      slot_name: slotName,
      slot_type: 'fixed',
      required: Boolean(item.required),
      asset_id: String(item.asset_id || '').trim(),
    });
  });
  return out;
}

function detectMentionAtCursor(value: string, caret: number): { start: number; end: number; query: string } | null {
  const safeValue = String(value || '');
  const safeCaret = Math.max(0, Math.min(caret, safeValue.length));
  const left = safeValue.slice(0, safeCaret);
  const atIndexAscii = left.lastIndexOf('@');
  const atIndexFullWidth = left.lastIndexOf('＠');
  const atIndex = Math.max(atIndexAscii, atIndexFullWidth);
  if (atIndex < 0) return null;
  const leftToken = safeValue.slice(atIndex + 1, safeCaret);
  if (/\s|@|＠/.test(leftToken)) return null;
  const rightMatch = safeValue.slice(safeCaret).match(/^[\u4e00-\u9fa5a-zA-Z0-9_]*/);
  const rightToken = rightMatch ? rightMatch[0] : '';
  return {
    start: atIndex,
    end: safeCaret + rightToken.length,
    query: `${leftToken}${rightToken}`.toLowerCase(),
  };
}

function extractMentionTokens(text: string): string[] {
  const out: string[] = [];
  const pattern = /(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_\u4e00-\u9fa5]+)/g;
  const source = String(text || '');
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match) {
    const token = String(match[2] || '').trim();
    if (token && !out.includes(token)) out.push(token);
    match = pattern.exec(source);
  }
  return out;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function resolvePromptMentions(prompt: string, context: Record<string, WorkflowNodeOutput>, allowedNodeIds?: Set<string>): string {
  if (!prompt) return '';
  return prompt.replace(/@([a-zA-Z0-9_-]+)/g, (_m, token: string) => {
    if (allowedNodeIds && !allowedNodeIds.has(token)) {
      return `@${token}`;
    }
    const resolved = outputToText(context[token]);
    return resolved || `@${token}`;
  });
}

function collectUpstreamOutputs(nodeId: string, edges: FlowEdge[], context: Record<string, WorkflowNodeOutput>): WorkflowNodeOutput[] {
  const sourceIds = edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  return sourceIds.map((sourceId) => context[sourceId]).filter(Boolean);
}

function collectAttachmentAssetIds(outputs: WorkflowNodeOutput[]): string[] {
  const set = new Set<string>();
  outputs.forEach((output) => {
    (output.assets || []).forEach((asset) => {
      const id = String(asset.id || '').trim();
      if (id) set.add(id);
    });
  });
  return Array.from(set);
}

function collectUpstreamText(outputs: WorkflowNodeOutput[]): string {
  return outputs
    .map((output) => outputToText(output))
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function stepIndexByNodeId(steps: WorkflowRun['steps'], nodeId: string): number {
  return steps.findIndex((step) => step.node_id === nodeId);
}

function normalizeNodeLabel(node: FlowNode): string {
  const rawLabel = String((node.data as { label?: unknown })?.label || '').trim();
  if (rawLabel) return rawLabel;
  return NODE_TITLES[(node.type as WorkflowNodeKind) || 'input'] || node.id;
}

function isTemplateGraphSafe(graph: WorkflowGraph): boolean {
  return Array.isArray(graph.nodes) && Array.isArray(graph.edges);
}

function sortNodesByTopo(nodes: FlowNode[], edges: FlowEdge[]): string[] {
  const nodeIds = nodes.map((node) => node.id);
  const indegree = new Map<string, number>();
  nodeIds.forEach((id) => indegree.set(id, 0));
  edges.forEach((edge) => {
    if (!indegree.has(edge.target) || !indegree.has(edge.source)) return;
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
  });

  const queue = nodeIds.filter((id) => (indegree.get(id) || 0) === 0);
  const out: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    out.push(current);
    edges.forEach((edge) => {
      if (edge.source !== current) return;
      const next = edge.target;
      const nextIndegree = (indegree.get(next) || 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) {
        queue.push(next);
      }
    });
  }

  if (out.length !== nodeIds.length) {
    throw new Error('检测到循环依赖，请检查连线。');
  }
  return out;
}

function buildIncomingIndex(edges: FlowEdge[]): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  edges.forEach((edge) => {
    if (!incoming.has(edge.target)) {
      incoming.set(edge.target, []);
    }
    incoming.get(edge.target)?.push(edge.source);
  });
  return incoming;
}

function buildOutgoingIndex(edges: FlowEdge[]): Map<string, string[]> {
  const outgoing = new Map<string, string[]>();
  edges.forEach((edge) => {
    if (!outgoing.has(edge.source)) {
      outgoing.set(edge.source, []);
    }
    outgoing.get(edge.source)?.push(edge.target);
  });
  return outgoing;
}

function collectAncestors(targetId: string, incoming: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const queue = [...(incoming.get(targetId) || [])];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    (incoming.get(current) || []).forEach((parent) => {
      if (!visited.has(parent)) queue.push(parent);
    });
  }
  return visited;
}

function collectReachable(startId: string, outgoing: Map<string, string[]>): Set<string> {
  const visited = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    (outgoing.get(current) || []).forEach((next) => {
      if (visited.has(next)) return;
      visited.add(next);
      queue.push(next);
    });
  }
  return visited;
}

function computeBranchRetryScope(
  reviewNodeId: string,
  edges: FlowEdge[],
  sourceNodeId?: string,
): Set<string> {
  const incoming = buildIncomingIndex(edges);
  const outgoing = buildOutgoingIndex(edges);

  const reviewAncestors = collectAncestors(reviewNodeId, incoming);
  reviewAncestors.add(reviewNodeId);

  if (!sourceNodeId) return reviewAncestors;

  const reachableFromSource = collectReachable(sourceNodeId, outgoing);
  const branchScope = new Set<string>();
  reviewAncestors.forEach((nodeId) => {
    if (reachableFromSource.has(nodeId)) {
      branchScope.add(nodeId);
    }
  });
  branchScope.add(reviewNodeId);
  return branchScope;
}

async function runTextModel(
  workspaceId: string,
  prompt: string,
  model: string,
  attachmentIds: string[],
): Promise<string> {
  let streamText = '';
  let streamError = '';

  await studioApi.createTextTurnStream(
    workspaceId,
    {
      text: prompt,
      params: {
        model: model || 'gpt-4.1-mini',
        aspect_ratio: IMAGE_DEFAULTS.aspect_ratio,
        quality: IMAGE_DEFAULTS.quality,
        count: 1,
      },
      attachment_asset_ids: attachmentIds,
    },
    {
      onDelta: (event) => {
        streamText += String(event.delta || '');
      },
      onDone: (event) => {
        const doneText = String(event.assistant_message?.text || '').trim();
        if (doneText) streamText = doneText;
      },
      onError: (event) => {
        streamError = String(event.message || '文本节点执行失败');
      },
    },
  );

  if (streamError) throw new Error(streamError);
  return streamText.trim();
}

async function runImageModel(
  workspaceId: string,
  prompt: string,
  model: string,
  aspectRatio: string,
  quality: string,
  count: number,
  attachmentIds: string[],
): Promise<{ text: string; assets: StudioAsset[] }> {
  const turn = await studioApi.createTurn(workspaceId, {
    text: prompt,
    params: {
      model,
      aspect_ratio: aspectRatio,
      quality,
      count,
    },
    attachment_asset_ids: attachmentIds,
  });
  return {
    text: String(turn.assistant_message?.text || '').trim(),
    assets: Array.isArray(turn.assistant_message?.images)
      ? (turn.assistant_message?.images as StudioAsset[])
      : [],
  };
}

export function WorkflowCanvasPage() {
  const initialCanvasState = useMemo(() => readCanvasDraft() || getDefaultCanvasState(), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNodeData>(initialCanvasState.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(initialCanvasState.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const [options, setOptions] = useState<StudioOptions | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);

  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [templateBusy, setTemplateBusy] = useState(false);

  const [bridgeConfig, setBridgeConfig] = useState<WorkflowBridgeConfig>({
    base_url: 'http://127.0.0.1:9000/api/studio',
    enabled: false,
  });
  const [bridgeSaving, setBridgeSaving] = useState(false);

  const [localAssets, setLocalAssets] = useState<StudioAsset[]>([]);
  const [bridgeAssets, setBridgeAssets] = useState<StudioAsset[]>([]);

  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [running, setRunning] = useState(false);
  const [pendingReview, setPendingReview] = useState<PendingReviewState | null>(null);
  const [reviewEditText, setReviewEditText] = useState('');
  const [reviewRetrySourceId, setReviewRetrySourceId] = useState('');
  const reviewDecisionsRef = useRef<Record<string, ReviewDecision>>({});

  const [storageOpen, setStorageOpen] = useState(false);
  const [storageTab, setStorageTab] = useState(0);
  const [storedOutputs, setStoredOutputs] = useState<StoredOutputItem[]>(() => readStoredOutputs());

  const [toast, setToast] = useState<{ open: boolean; severity: 'success' | 'info' | 'warning' | 'error'; message: string }>({
    open: false,
    severity: 'info',
    message: '',
  });

  const [pollStamp, setPollStamp] = useState<number>(Date.now());
  const [batchSelectedAssetIds, setBatchSelectedAssetIds] = useState<string[]>([]);
  const [batchPromptTemplates, setBatchPromptTemplates] = useState<BatchPromptTemplateCard[]>([createBatchPromptTemplateCard(1)]);
  const [batchPromptCardLibrary, setBatchPromptCardLibrary] = useState<WorkflowPromptCard[]>([]);
  const [batchPromptCardLibraryBusy, setBatchPromptCardLibraryBusy] = useState(false);
  const [batchPromptPickerOpen, setBatchPromptPickerOpen] = useState(false);
  const [batchPromptPickerTab, setBatchPromptPickerTab] = useState<BatchPromptPickerTab>('library');
  const [batchPromptPickerSearch, setBatchPromptPickerSearch] = useState('');
  const [batchPromptPickerSelectedIds, setBatchPromptPickerSelectedIds] = useState<string[]>([]);
  const [batchPromptCreateName, setBatchPromptCreateName] = useState('');
  const [batchPromptCreateText, setBatchPromptCreateText] = useState('');
  const [batchPromptCreateSaving, setBatchPromptCreateSaving] = useState(false);
  const [batchPromptDeletingId, setBatchPromptDeletingId] = useState('');
  const [batchUseTaskCards, setBatchUseTaskCards] = useState(false);
  const [batchTaskCards, setBatchTaskCards] = useState<BatchTaskCard[]>([]);
  const [batchComposerOpen, setBatchComposerOpen] = useState(false);
  const [batchComposerSection, setBatchComposerSection] = useState<BatchComposerSection>('assets');
  const [batchMode, setBatchMode] = useState<WorkflowCombinationMode>('broadcast');
  const [batchVariants, setBatchVariants] = useState<number>(1);
  const [batchConcurrency, setBatchConcurrency] = useState<number>(2);
  const [batchRecipeName, setBatchRecipeName] = useState('默认配方');
  const [batchRecipeTemplate, setBatchRecipeTemplate] = useState('');
  const [batchRecipeModel, setBatchRecipeModel] = useState('');
  const [batchRecipeAspectRatio, setBatchRecipeAspectRatio] = useState(IMAGE_DEFAULTS.aspect_ratio);
  const [batchRecipeQuality, setBatchRecipeQuality] = useState(IMAGE_DEFAULTS.quality);
  const [batchSlotBindings, setBatchSlotBindings] = useState<WorkflowRunSlotBindingInput[]>(normalizeBatchSlotBindings(DEFAULT_BATCH_SLOT_BINDINGS));
  const [batchNewSlotName, setBatchNewSlotName] = useState('');
  const [batchTemplateMentionAnchorEl, setBatchTemplateMentionAnchorEl] = useState<HTMLElement | null>(null);
  const [batchTemplateMentionOpen, setBatchTemplateMentionOpen] = useState(false);
  const [batchTemplateMentionQuery, setBatchTemplateMentionQuery] = useState('');
  const [batchTemplateMentionRange, setBatchTemplateMentionRange] = useState<{ start: number; end: number } | null>(null);
  const [batchTemplateMentionTarget, setBatchTemplateMentionTarget] = useState<BatchTemplateMentionTarget | null>(null);
  const [batchMentionPreview, setBatchMentionPreview] = useState<{ url: string; title: string } | null>(null);
  const [batchAssetPickerOpen, setBatchAssetPickerOpen] = useState(false);
  const [batchAssetPickerTab, setBatchAssetPickerTab] = useState<BatchAssetPickerTab>('upload');
  const [batchAssetPickerSearch, setBatchAssetPickerSearch] = useState('');
  const [batchAssetPickerDraftIds, setBatchAssetPickerDraftIds] = useState<string[]>([]);
  const [batchAssetUploading, setBatchAssetUploading] = useState(false);
  const [batchBridgeImportingId, setBatchBridgeImportingId] = useState('');
  const [batchPreview, setBatchPreview] = useState<WorkflowRunPreviewResponse | null>(null);
  const [batchPreviewPayloadSignature, setBatchPreviewPayloadSignature] = useState('');
  const [batchRunSnapshot, setBatchRunSnapshot] = useState<WorkflowRunSnapshot | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchPolling, setBatchPolling] = useState(false);

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) || null, [nodes, selectedNodeId]);

  const mentionableNodes = useMemo(
    () => nodes.filter((node) => MENTIONABLE_NODE_KINDS.has(((node.type as WorkflowNodeKind) || 'input') as WorkflowNodeKind)),
    [nodes],
  );
  const mentionableNodeIds = useMemo(() => new Set(mentionableNodes.map((node) => node.id)), [mentionableNodes]);
  const availableMentionTokens = useMemo(() => mentionableNodes.map((node) => `@${node.id}`), [mentionableNodes]);
  const visibleMentionTokens = useMemo(() => {
    if (!selectedNodeId) return availableMentionTokens;
    return availableMentionTokens.filter((token) => token !== `@${selectedNodeId}`);
  }, [availableMentionTokens, selectedNodeId]);

  const imageModelOptions = useMemo(() => options?.models || [], [options]);
  const textModelOptions = useMemo(() => {
    const runtimeModel = String(runtimeConfig?.http?.text_model || 'gpt-4.1-mini').trim() || 'gpt-4.1-mini';
    return [runtimeModel, 'gpt-4.1-mini', 'gpt-4.1'];
  }, [runtimeConfig]);

  const bridgeAssetMap = useMemo(() => {
    const map = new Map<string, StudioAsset>();
    bridgeAssets.forEach((asset) => map.set(asset.id, asset));
    return map;
  }, [bridgeAssets]);
  const localAssetMap = useMemo(() => {
    const map = new Map<string, StudioAsset>();
    localAssets.forEach((asset) => map.set(asset.id, asset));
    return map;
  }, [localAssets]);
  const localUploadAssets = useMemo(
    () => localAssets.filter((asset) => String(asset.kind || '').trim().toLowerCase() === 'upload'),
    [localAssets],
  );
  const localGeneratedAssets = useMemo(
    () => localAssets.filter((asset) => String(asset.kind || '').trim().toLowerCase() === 'generated'),
    [localAssets],
  );
  const localLibraryAssets = useMemo(
    () =>
      localAssets.filter((asset) => {
        const kind = String(asset.kind || '').trim().toLowerCase();
        return kind !== 'upload' && kind !== 'generated';
      }),
    [localAssets],
  );
  const batchAssetPickerTabCounts = useMemo(
    () => ({
      upload: localUploadAssets.length,
      generated: localGeneratedAssets.length,
      library: localLibraryAssets.length,
      bridge: bridgeAssets.length,
    }),
    [bridgeAssets.length, localGeneratedAssets.length, localLibraryAssets.length, localUploadAssets.length],
  );
  const batchAssetPickerSourceAssets = useMemo(() => {
    if (batchAssetPickerTab === 'bridge') return bridgeAssets;
    if (batchAssetPickerTab === 'upload') return localUploadAssets;
    if (batchAssetPickerTab === 'generated') return localGeneratedAssets;
    return localLibraryAssets;
  }, [batchAssetPickerTab, bridgeAssets, localGeneratedAssets, localLibraryAssets, localUploadAssets]);
  const batchAssetPickerVisibleAssets = useMemo(() => {
    const query = String(batchAssetPickerSearch || '').trim().toLowerCase();
    if (!query) return batchAssetPickerSourceAssets;
    return batchAssetPickerSourceAssets.filter((asset) => {
      const title = String(asset.title || '').toLowerCase();
      const id = String(asset.id || '').toLowerCase();
      const kind = String(asset.kind || '').toLowerCase();
      const tags = Array.isArray(asset.tags) ? asset.tags.map((tag) => String(tag || '').toLowerCase()).join(' ') : '';
      return `${title} ${id} ${kind} ${tags}`.includes(query);
    });
  }, [batchAssetPickerSearch, batchAssetPickerSourceAssets]);
  const batchAssetPickerDraftSet = useMemo(() => new Set(batchAssetPickerDraftIds), [batchAssetPickerDraftIds]);
  const selectedBatchAssets = useMemo(
    () => batchSelectedAssetIds.map((id) => localAssetMap.get(id)).filter(Boolean) as StudioAsset[],
    [batchSelectedAssetIds, localAssetMap],
  );
  const batchPromptCardLibraryMap = useMemo(() => {
    const map = new Map<string, WorkflowPromptCard>();
    batchPromptCardLibrary.forEach((item) => map.set(item.id, item));
    return map;
  }, [batchPromptCardLibrary]);
  const batchPromptPickerSelectedSet = useMemo(() => new Set(batchPromptPickerSelectedIds), [batchPromptPickerSelectedIds]);
  const batchPromptPickerVisibleCards = useMemo(() => {
    const query = String(batchPromptPickerSearch || '').trim().toLowerCase();
    if (!query) return batchPromptCardLibrary;
    return batchPromptCardLibrary.filter((item) => {
      const name = String(item.name || '').toLowerCase();
      const text = String(item.text || '').toLowerCase();
      const tags = Array.isArray(item.tags) ? item.tags.map((tag) => String(tag || '').toLowerCase()).join(' ') : '';
      return `${name} ${text} ${tags} ${String(item.id || '').toLowerCase()}`.includes(query);
    });
  }, [batchPromptCardLibrary, batchPromptPickerSearch]);
  const batchPromptTemplateMap = useMemo(() => {
    const map = new Map<string, BatchPromptTemplateCard>();
    batchPromptTemplates.forEach((item) => map.set(item.id, item));
    return map;
  }, [batchPromptTemplates]);
  const enabledPromptTemplateOptions = useMemo(
    () =>
      batchPromptTemplates
        .filter((item) => item.enabled && String(item.text || '').trim())
        .map((item) => ({
          id: item.id,
          label: String(item.name || '').trim() || '未命名模板',
          text: String(item.text || '').trim(),
        })),
    [batchPromptTemplates],
  );
  const enabledBatchPrompts = useMemo(() => promptsFromTemplateCards(batchPromptTemplates), [batchPromptTemplates]);
  const taskCardLocalPreview = useMemo(() => {
    if (!batchUseTaskCards) {
      return { pairs: [] as BatchLocalPairPreview[], error: '' };
    }
    const enabledCards = batchTaskCards.filter((item) => item.enabled);
    if (enabledCards.length === 0) {
      return { pairs: [] as BatchLocalPairPreview[], error: '任务卡片模式下，至少启用 1 张任务卡片。' };
    }
    const pairs: BatchLocalPairPreview[] = [];
    const seenAssetIds = new Set<string>();
    for (const card of enabledCards) {
      const asset = localAssetMap.get(String(card.asset_id || '').trim());
      if (!asset) {
        return { pairs: [] as BatchLocalPairPreview[], error: `任务卡片「${card.name || card.id}」未选择主图素材。` };
      }
      if (seenAssetIds.has(asset.id)) {
        return { pairs: [] as BatchLocalPairPreview[], error: `任务卡片模式暂不支持重复主图：${asset.id}` };
      }
      seenAssetIds.add(asset.id);
      const promptCard = batchPromptTemplateMap.get(String(card.prompt_card_id || '').trim());
      if (!promptCard || !promptCard.enabled || !String(promptCard.text || '').trim()) {
        return { pairs: [] as BatchLocalPairPreview[], error: `任务卡片「${card.name || card.id}」未绑定有效模板。` };
      }
      pairs.push({
        asset_id: asset.id,
        asset_title: String(asset.title || asset.id || ''),
        prompt_id: promptCard.id,
        prompt_title: String(promptCard.name || '').trim() || '未命名模板',
        prompt_text: String(promptCard.text || '').trim(),
      });
    }
    return { pairs, error: '' };
  }, [batchPromptTemplateMap, batchTaskCards, batchUseTaskCards, localAssetMap]);
  const localBatchPairPreview = useMemo(() => {
    if (batchUseTaskCards) {
      return taskCardLocalPreview;
    }
    const assets = selectedBatchAssets.map((asset) => ({
      id: String(asset.id || ''),
      title: String(asset.title || asset.id || ''),
    }));
    return buildLocalBatchPairs(assets, enabledBatchPrompts, batchMode);
  }, [batchMode, batchUseTaskCards, enabledBatchPrompts, selectedBatchAssets, taskCardLocalPreview]);
  const localBatchTaskEstimate = localBatchPairPreview.pairs.length * clampInt(batchVariants, 1, 8);
  const batchModeHints: Record<WorkflowCombinationMode, string> = useMemo(
    () => ({
      broadcast: '主图和模板里，必须有一侧是 1 个。常用于“多图套同一规则”或“同图多规则”。',
      pairwise: '按顺序一一配对：第 1 张图配第 1 条模板，第 2 张图配第 2 条模板。',
      cartesian: '全组合探索：每张主图会和每条模板都跑一遍。',
    }),
    [],
  );
  const slotMentionOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: WorkflowRichMentionOption[] = [];
    const primaryAsset = selectedBatchAssets[0] || null;
    const primaryAssetTitle = primaryAsset
      ? (primaryAsset.title || primaryAsset.id || '主素材')
      : '当前任务主素材';
    const primaryAssetLabel = selectedBatchAssets.length > 1
      ? `${primaryAssetTitle} +${selectedBatchAssets.length - 1}`
      : primaryAssetTitle;
    const primaryThumb = resolveAssetUrl(String(primaryAsset?.thumbnail_url || primaryAsset?.file_url || ''));
    const primaryPreview = resolveAssetUrl(String(primaryAsset?.file_url || primaryAsset?.thumbnail_url || ''));

    options.push({
      token: '@主素材',
      label: `@主素材（${primaryAssetLabel}）`,
      assetTitle: primaryAssetLabel,
      thumbnailUrl: primaryThumb || undefined,
      previewUrl: primaryPreview || undefined,
    });
    options.push({
      token: '@input_asset',
      label: `@input_asset（${primaryAssetLabel}）`,
      assetTitle: primaryAssetLabel,
      thumbnailUrl: primaryThumb || undefined,
      previewUrl: primaryPreview || undefined,
    });
    batchSlotBindings.forEach((item) => {
      const slotName = normalizeSlotName(item.slot_name || '');
      if (!slotName || seen.has(slotName)) return;
      seen.add(slotName);
      const matchedAsset = item.asset_id
        ? localAssetMap.get(item.asset_id) || bridgeAssetMap.get(item.asset_id)
        : null;
      const assetTitle = item.asset_id ? matchedAsset?.title || item.asset_id : '未绑定素材';
      const thumbnailUrl = resolveAssetUrl(String(matchedAsset?.thumbnail_url || matchedAsset?.file_url || ''));
      const previewUrl = resolveAssetUrl(String(matchedAsset?.file_url || matchedAsset?.thumbnail_url || ''));
      options.push({
        token: `@${slotName}`,
        label: `@${slotName}（${assetTitle}）`,
        assetTitle,
        thumbnailUrl: thumbnailUrl || undefined,
        previewUrl: previewUrl || undefined,
      });
    });
    return options;
  }, [batchSlotBindings, bridgeAssetMap, localAssetMap, selectedBatchAssets]);
  const mentionHelpText = useMemo(() => {
    const tokens = slotMentionOptions.map((item) => item.token).slice(0, 6);
    if (tokens.length === 0) return '输入 @ 选择可引用变量。';
    return `输入 @ 选择可引用变量（例如 ${tokens.join('、')}）。`;
  }, [slotMentionOptions]);
  const filteredSlotMentionOptions = useMemo(() => {
    const query = String(batchTemplateMentionQuery || '').trim().toLowerCase();
    if (!query) return slotMentionOptions;
    return slotMentionOptions.filter(
      (item) => item.token.toLowerCase().includes(query) || String(item.label || '').toLowerCase().includes(query),
    );
  }, [batchTemplateMentionQuery, slotMentionOptions]);

  const showToast = useCallback((severity: 'success' | 'info' | 'warning' | 'error', message: string) => {
    setToast({ open: true, severity, message });
  }, []);

  useEffect(() => {
    if (batchRecipeModel) return;
    const preferred = imageModelOptions[0]?.id || '';
    if (!preferred) return;
    setBatchRecipeModel(preferred);
  }, [batchRecipeModel, imageModelOptions]);

  useEffect(() => {
    setBatchSelectedAssetIds((prev) => prev.filter((id) => localAssetMap.has(id)));
    setBatchSlotBindings((prev) =>
      normalizeBatchSlotBindings(
        prev.map((item) => {
          const aid = String(item.asset_id || '').trim();
          if (!aid || localAssetMap.has(aid)) return item;
          return { ...item, asset_id: '' };
        }),
      ),
    );
    setBatchTaskCards((prev) =>
      prev.map((item) => {
        const assetId = String(item.asset_id || '').trim();
        if (!assetId || localAssetMap.has(assetId)) return item;
        return { ...item, asset_id: '' };
      }),
    );
  }, [localAssetMap]);

  useEffect(() => {
    setBatchPromptPickerSelectedIds((prev) => prev.filter((id) => batchPromptCardLibraryMap.has(id)));
  }, [batchPromptCardLibraryMap]);

  useEffect(() => {
    if (!batchUseTaskCards) return;
    setBatchTaskCards((prev) => {
      const enabledPromptIds = new Set(enabledPromptTemplateOptions.map((item) => item.id));
      const fallbackPromptId = enabledPromptTemplateOptions[0]?.id || '';
      if (prev.length === 0) {
        return [createBatchTaskCard(1, fallbackPromptId)];
      }
      return prev.map((item) => {
        const current = String(item.prompt_card_id || '').trim();
        if (current && enabledPromptIds.has(current)) return item;
        return { ...item, prompt_card_id: fallbackPromptId };
      });
    });
  }, [batchUseTaskCards, enabledPromptTemplateOptions]);

  useEffect(() => {
    setBatchPreviewPayloadSignature((prev) => (prev ? '' : prev));
  }, [
    batchSelectedAssetIds,
    batchUseTaskCards,
    batchTaskCards,
    batchPromptTemplates,
    batchMode,
    batchVariants,
    batchConcurrency,
    batchRecipeName,
    batchRecipeTemplate,
    batchRecipeModel,
    batchRecipeAspectRatio,
    batchRecipeQuality,
    batchSlotBindings,
  ]);

  const refreshPromptCardLibrary = useCallback(async () => {
    try {
      setBatchPromptCardLibraryBusy(true);
      const data = await workflowApi.listPromptCards();
      setBatchPromptCardLibrary(Array.isArray(data) ? data : []);
    } catch (error) {
      showToast('warning', `指令卡片库加载失败：${(error as Error).message}`);
    } finally {
      setBatchPromptCardLibraryBusy(false);
    }
  }, [showToast]);

  const refreshTemplates = useCallback(async () => {
    try {
      setTemplateBusy(true);
      const data = await workflowApi.listTemplates();
      setTemplates(Array.isArray(data) ? data : []);
    } catch (error) {
      showToast('warning', `模板加载失败：${(error as Error).message}`);
    } finally {
      setTemplateBusy(false);
    }
  }, [showToast]);

  const refreshAssets = useCallback(async () => {
    try {
      const localResp = await workflowApi.listLocalAssets({ limit: 120 });
      setLocalAssets(Array.isArray(localResp.items) ? localResp.items : []);
    } catch (error) {
      showToast('warning', `本地素材加载失败：${(error as Error).message}`);
    }

    try {
      const bridgeResp = await workflowApi.bridgeListAssets({ limit: 120 });
      setBridgeAssets(Array.isArray(bridgeResp.items) ? bridgeResp.items : []);
    } catch {
      setBridgeAssets([]);
    }
  }, [showToast]);

  const refreshBridgeConfig = useCallback(async () => {
    try {
      const cfg = await workflowApi.getBridgeConfig();
      setBridgeConfig(cfg);
    } catch {
      // ignore bridge config loading error
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [opt, runtime] = await Promise.all([studioApi.getOptions(), studioApi.getRuntimeConfig()]);
        if (!active) return;
        setOptions(opt);
        setRuntimeConfig(runtime);
      } catch (error) {
        if (!active) return;
        showToast('warning', `基础配置加载失败：${(error as Error).message}`);
      }
    })();
    void refreshTemplates();
    void refreshPromptCardLibrary();
    void refreshAssets();
    void refreshBridgeConfig();
    return () => {
      active = false;
    };
  }, [refreshAssets, refreshBridgeConfig, refreshPromptCardLibrary, refreshTemplates, showToast]);

  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => {
      setRun((prev) => {
        if (!prev) return prev;
        const now = Date.now();
        const nextSteps = prev.steps.map((step) => {
          if (step.status !== 'running' || !step.started_at) return step;
          const startedAt = new Date(step.started_at).getTime();
          const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
          return {
            ...step,
            elapsed_seconds: elapsedSeconds,
          };
        });
        return {
          ...prev,
          updated_at: nowIso(),
          steps: nextSteps,
        };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running) return undefined;
    const poller = window.setInterval(() => {
      setPollStamp(Date.now());
    }, 2000);
    return () => window.clearInterval(poller);
  }, [running]);

  useEffect(() => {
    if (!pendingReview) return;
    if (pendingReview.incoming_sources.length === 0) {
      setReviewRetrySourceId('');
      return;
    }
    const exists = pendingReview.incoming_sources.some((item) => item.id === reviewRetrySourceId);
    if (!exists) {
      setReviewRetrySourceId(pendingReview.incoming_sources[0].id);
    }
  }, [pendingReview, reviewRetrySourceId]);

  useEffect(() => {
    writeCanvasDraft(nodes, edges);
  }, [edges, nodes]);

  const executorWorkspaceIdRef = useRef<string>('');
  const batchAssetUploadInputRef = useRef<HTMLInputElement | null>(null);

  const ensureExecutorWorkspaceId = useCallback(async (): Promise<string> => {
    if (executorWorkspaceIdRef.current) return executorWorkspaceIdRef.current;

    const remembered = window.localStorage.getItem(WORKFLOW_EXECUTOR_WORKSPACE_KEY) || '';
    if (remembered) {
      try {
        await studioApi.getWorkspace(remembered);
        executorWorkspaceIdRef.current = remembered;
        return remembered;
      } catch {
        // fallthrough
      }
    }

    const workspaces = await studioApi.listWorkspaces();
    const matched = workspaces.find((item) => item.name === WORKFLOW_EXECUTOR_WORKSPACE_NAME);
    if (matched?.id) {
      executorWorkspaceIdRef.current = matched.id;
      window.localStorage.setItem(WORKFLOW_EXECUTOR_WORKSPACE_KEY, matched.id);
      return matched.id;
    }

    const created = await studioApi.createWorkspace(WORKFLOW_EXECUTOR_WORKSPACE_NAME);
    executorWorkspaceIdRef.current = created.id;
    window.localStorage.setItem(WORKFLOW_EXECUTOR_WORKSPACE_KEY, created.id);
    return created.id;
  }, []);

  const patchSelectedNodeData = useCallback(
    (patcher: (data: WorkflowNodeData) => WorkflowNodeData) => {
      if (!selectedNodeId) return;
      setNodes((prev) =>
        prev.map((node) => {
          if (node.id !== selectedNodeId) return node;
          return {
            ...node,
            data: patcher(node.data),
          };
        }),
      );
    },
    [selectedNodeId, setNodes],
  );

  const appendTokenToSelectedPrompt = useCallback(
    (token: string) => {
      if (!selectedNode) return;
      if (selectedNode.type === 'input') {
        patchSelectedNodeData((prev) => {
          const data = prev as WorkflowInputNodeData;
          const current = String(data.prompt || '').trim();
          const next = current ? `${current} ${token}` : token;
          return {
            ...data,
            prompt: next,
          };
        });
        return;
      }
      if (selectedNode.type === 'transform') {
        patchSelectedNodeData((prev) => {
          const data = prev as WorkflowTransformNodeData;
          const current = String(data.prompt_template || '').trim();
          const next = current ? `${current} ${token}` : token;
          return {
            ...data,
            prompt_template: next,
          };
        });
      }
    },
    [patchSelectedNodeData, selectedNode],
  );

  const addNode = useCallback(
    (type: WorkflowNodeKind) => {
      if (type === 'end' && nodes.some((node) => node.type === 'end')) {
        showToast('warning', '同一流程只允许一个结束节点');
        return;
      }
      const offset = nodes.length * 24;
      const node = makeFlowNode(type, { x: 80 + offset, y: 120 + offset });
      setNodes((prev) => [...prev, node]);
      setSelectedNodeId(node.id);
    },
    [nodes, setNodes, showToast],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const source = connection.source || '';
      const target = connection.target || '';
      if (!source || !target || source === target) {
        showToast('warning', '无效连线');
        return;
      }

      const duplicate = edges.some((edge) => edge.source === source && edge.target === target);
      if (duplicate) {
        showToast('warning', '同一对节点只允许一条连线');
        return;
      }

      const sourceNode = nodes.find((node) => node.id === source);
      const targetNode = nodes.find((node) => node.id === target);
      if (!sourceNode || !targetNode) {
        showToast('warning', '连线节点不存在');
        return;
      }

      if (sourceNode.type === 'end') {
        showToast('warning', '结束节点不能作为上游输出');
        return;
      }
      const sourceOutgoingCount = edges.filter((edge) => edge.source === source).length;
      if (sourceNode.type === 'start' && sourceOutgoingCount >= 1) {
        showToast('warning', '开始节点只能连接一个下游节点');
        return;
      }
      if (targetNode.type === 'start') {
        showToast('warning', '开始节点不能接收上游输入');
        return;
      }

      const incomingCount = edges.filter((edge) => edge.target === target).length;
      if (targetNode.type === 'end' && incomingCount >= 1) {
        showToast('warning', '结束节点只允许一个上游，若需汇总请先使用“合并节点”');
        return;
      }
      if (targetNode.type === 'input' && incomingCount >= 2) {
        showToast('warning', '输入节点最多允许 2 条上游连线');
        return;
      }

      const allowMultipleIncoming = targetNode.type === 'merge';
      if (!allowMultipleIncoming && targetNode.type !== 'input' && targetNode.type !== 'end' && incomingCount >= 1) {
        showToast('warning', '该节点已有上游连线，若需多输入请使用“合并节点”');
        return;
      }

      setEdges((prev) =>
        addEdge(
          {
            ...connection,
            id: makeId('edge'),
            markerEnd: { type: MarkerType.ArrowClosed },
            animated: false,
          },
          prev,
        ),
      );
    },
    [edges, nodes, setEdges, showToast],
  );

  const removeSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    setNodes((prev) => prev.filter((node) => node.id !== selectedNodeId));
    setEdges((prev) => prev.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
  }, [selectedNodeId, setEdges, setNodes]);

  const clearCanvas = useCallback(() => {
    if (!window.confirm('确认清空当前画布吗？')) return;
    setNodes(getDefaultCanvasState().nodes);
    setEdges([]);
    setSelectedNodeId(null);
    setRun(null);
    setPendingReview(null);
    reviewDecisionsRef.current = {};
  }, [setEdges, setNodes]);

  const saveAsTemplate = useCallback(async () => {
    const name = window.prompt('输入模板名称', `流程模板-${new Date().toLocaleString()}`)?.trim();
    if (!name) return;
    const description = window.prompt('输入模板说明（可选）', '') || '';

    try {
      setTemplateBusy(true);
      await workflowApi.createTemplate({
        name,
        description,
        graph: toWorkflowGraph(nodes, edges),
        tags: [],
      });
      await refreshTemplates();
      showToast('success', '模板已保存');
    } catch (error) {
      showToast('error', `保存模板失败：${(error as Error).message}`);
    } finally {
      setTemplateBusy(false);
    }
  }, [edges, nodes, refreshTemplates, showToast]);

  const updateTemplateById = useCallback(
    async (template: WorkflowTemplate) => {
      if (!window.confirm(`确认覆盖模板「${template.name}」吗？`)) return;
      try {
        setTemplateBusy(true);
        await workflowApi.updateTemplate(template.id, {
          graph: toWorkflowGraph(nodes, edges),
        });
        await refreshTemplates();
        showToast('success', '模板已更新');
      } catch (error) {
        showToast('error', `更新模板失败：${(error as Error).message}`);
      } finally {
        setTemplateBusy(false);
      }
    },
    [edges, nodes, refreshTemplates, showToast],
  );

  const loadTemplate = useCallback(
    (template: WorkflowTemplate) => {
      if (!template.graph || !isTemplateGraphSafe(template.graph)) {
        showToast('warning', '模板数据损坏，无法加载');
        return;
      }
      const restored = fromWorkflowGraph(template.graph);
      if (restored.nodes.length === 0) {
        showToast('warning', '模板没有节点');
        return;
      }
      setNodes(restored.nodes);
      setEdges(restored.edges);
      setSelectedNodeId(restored.nodes[0]?.id || null);
      showToast('success', `已加载模板：${template.name}`);
    },
    [setEdges, setNodes, showToast],
  );

  const deleteTemplateById = useCallback(
    async (template: WorkflowTemplate) => {
      if (!window.confirm(`确认删除模板「${template.name}」吗？`)) return;
      try {
        setTemplateBusy(true);
        await workflowApi.deleteTemplate(template.id);
        await refreshTemplates();
        showToast('success', '模板已删除');
      } catch (error) {
        showToast('error', `删除模板失败：${(error as Error).message}`);
      } finally {
        setTemplateBusy(false);
      }
    },
    [refreshTemplates, showToast],
  );

  const saveBridgeConfig = useCallback(async () => {
    try {
      setBridgeSaving(true);
      const next = await workflowApi.updateBridgeConfig(bridgeConfig);
      setBridgeConfig(next);
      await refreshAssets();
      showToast('success', 'Bridge 配置已保存');
    } catch (error) {
      showToast('error', `Bridge 配置保存失败：${(error as Error).message}`);
    } finally {
      setBridgeSaving(false);
    }
  }, [bridgeConfig, refreshAssets, showToast]);

  const removeBatchAsset = useCallback((assetId: string) => {
    setBatchSelectedAssetIds((prev) => prev.filter((id) => id !== assetId));
  }, []);

  const openBatchAssetPickerForMain = useCallback(() => {
    setBatchAssetPickerSearch('');
    setBatchAssetPickerTab('upload');
    setBatchAssetPickerDraftIds(batchSelectedAssetIds.filter((id) => localAssetMap.has(id)));
    setBatchAssetPickerOpen(true);
  }, [batchSelectedAssetIds, localAssetMap]);

  const closeBatchAssetPicker = useCallback(() => {
    setBatchAssetPickerOpen(false);
  }, []);

  const applyBatchAssetPickerSelection = useCallback(() => {
    setBatchSelectedAssetIds(batchAssetPickerDraftIds.filter((id) => localAssetMap.has(id)));
    setBatchAssetPickerOpen(false);
  }, [batchAssetPickerDraftIds, localAssetMap]);

  const toggleBatchAssetPickerDraft = useCallback((assetId: string) => {
    const aid = String(assetId || '').trim();
    if (!aid) return;
    setBatchAssetPickerDraftIds((prev) => {
      if (prev.includes(aid)) return prev.filter((id) => id !== aid);
      return [...prev, aid];
    });
  }, []);

  const triggerBatchAssetUpload = useCallback(() => {
    batchAssetUploadInputRef.current?.click();
  }, []);

  const handleBatchAssetUpload = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (files.length === 0) return;
      setBatchAssetUploading(true);
      try {
        const workspaceId = await ensureExecutorWorkspaceId();
        const uploaded = await studioApi.uploadAssets(files, workspaceId);
        const items = Array.isArray(uploaded.items) ? uploaded.items : [];
        await refreshAssets();
        if (items.length > 0) {
          const uploadedIds = items.map((item) => String(item.id || '').trim()).filter(Boolean);
          setBatchAssetPickerDraftIds((prev) => {
            const merged = new Set(prev);
            uploadedIds.forEach((id) => merged.add(id));
            return Array.from(merged);
          });
          setBatchAssetPickerTab('upload');
        }
        showToast('success', `上传完成：${items.length} 个素材`);
      } catch (error) {
        showToast('error', `上传失败：${(error as Error).message}`);
      } finally {
        setBatchAssetUploading(false);
      }
    },
    [ensureExecutorWorkspaceId, refreshAssets, showToast],
  );

  const importBridgeAssetToLocal = useCallback(
    async (asset: StudioAsset) => {
      const assetId = String(asset.id || '').trim();
      if (!assetId) return;
      const sourceUrl = resolveAssetUrl(String(asset.file_url || asset.thumbnail_url || ''));
      if (!sourceUrl) {
        showToast('warning', '该 Bridge 素材缺少可下载地址');
        return;
      }
      setBatchBridgeImportingId(assetId);
      try {
        const resp = await fetch(sourceUrl, { credentials: 'include' });
        if (!resp.ok) {
          throw new Error(`下载失败 (${resp.status})`);
        }
        const blob = await resp.blob();
        const rawTitle = String(asset.title || asset.id || 'bridge-asset');
        const safeBase = rawTitle.replace(/[\\/:*?"<>|]/g, '_').trim() || 'bridge-asset';
        const suffixFromTitle = rawTitle.match(/\.[a-zA-Z0-9]{2,5}$/)?.[0] || '';
        const suffix =
          suffixFromTitle ||
          (blob.type.includes('jpeg')
            ? '.jpg'
            : blob.type.includes('webp')
              ? '.webp'
              : blob.type.includes('gif')
                ? '.gif'
                : '.png');
        const file = new File([blob], `${safeBase}${suffix}`, { type: blob.type || 'image/png' });
        const workspaceId = await ensureExecutorWorkspaceId();
        const uploaded = await studioApi.uploadAssets([file], workspaceId);
        const items = Array.isArray(uploaded.items) ? uploaded.items : [];
        await refreshAssets();
        if (items.length > 0) {
          const uploadedIds = items.map((item) => String(item.id || '').trim()).filter(Boolean);
          setBatchAssetPickerDraftIds((prev) => {
            const merged = new Set(prev);
            uploadedIds.forEach((id) => merged.add(id));
            return Array.from(merged);
          });
          setBatchAssetPickerTab('upload');
          showToast('success', `已入库并勾选：${String(items[0]?.title || items[0]?.id || '素材')}`);
        } else {
          showToast('warning', 'Bridge 素材入库失败：未返回可用素材');
        }
      } catch (error) {
        showToast('error', `Bridge 素材入库失败：${(error as Error).message}`);
      } finally {
        setBatchBridgeImportingId('');
      }
    },
    [ensureExecutorWorkspaceId, refreshAssets, showToast],
  );

  const appendBatchPromptTemplateFromLibraryCard = useCallback((card: WorkflowPromptCard) => {
    const name = String(card.name || '').trim() || '未命名模板';
    const text = String(card.text || '').trim();
    if (!text) return;
    setBatchPromptTemplates((prev) => [
      ...prev,
      {
        id: makeId('prompt-card'),
        library_card_id: String(card.id || ''),
        name,
        text,
        enabled: true,
      },
    ]);
  }, []);

  const openBatchPromptPicker = useCallback(() => {
    setBatchPromptPickerOpen(true);
    setBatchPromptPickerTab('library');
    setBatchPromptPickerSearch('');
    setBatchPromptPickerSelectedIds([]);
  }, []);

  const closeBatchPromptPicker = useCallback(() => {
    setBatchPromptPickerOpen(false);
    setBatchTemplateMentionOpen(false);
    setBatchTemplateMentionQuery('');
    setBatchTemplateMentionRange(null);
    setBatchTemplateMentionTarget(null);
  }, []);

  const toggleBatchPromptPickerSelected = useCallback((cardId: string) => {
    const target = String(cardId || '').trim();
    if (!target) return;
    setBatchPromptPickerSelectedIds((prev) => {
      if (prev.includes(target)) return prev.filter((id) => id !== target);
      return [...prev, target];
    });
  }, []);

  const applyBatchPromptPickerSelection = useCallback(() => {
    if (batchPromptPickerSelectedIds.length === 0) {
      showToast('warning', '请先选择至少 1 张指令卡片');
      return;
    }
    const existingLibraryIds = new Set(
      batchPromptTemplates.map((item) => String(item.library_card_id || '').trim()).filter(Boolean),
    );
    const cardsToAdd: WorkflowPromptCard[] = [];
    let skipped = 0;
    batchPromptPickerSelectedIds.forEach((cardId) => {
      const card = batchPromptCardLibraryMap.get(cardId);
      if (!card) return;
      if (existingLibraryIds.has(cardId)) {
        skipped += 1;
        return;
      }
      cardsToAdd.push(card);
      existingLibraryIds.add(cardId);
    });
    if (cardsToAdd.length === 0) {
      showToast('info', skipped > 0 ? '所选卡片已在当前流程中，无新增' : '未找到可加入的卡片');
      return;
    }
    cardsToAdd.forEach((card) => appendBatchPromptTemplateFromLibraryCard(card));
    showToast('success', `已加入 ${cardsToAdd.length} 张卡片${skipped > 0 ? `，跳过重复 ${skipped} 张` : ''}`);
    setBatchPromptPickerSelectedIds([]);
    setBatchPromptPickerOpen(false);
  }, [
    appendBatchPromptTemplateFromLibraryCard,
    batchPromptCardLibraryMap,
    batchPromptPickerSelectedIds,
    batchPromptTemplates,
    showToast,
  ]);

  const saveBatchPromptCardToLibrary = useCallback(
    async (alsoAddToCurrent: boolean) => {
      const name = String(batchPromptCreateName || '').trim() || '未命名指令卡片';
      const text = String(batchPromptCreateText || '').trim();
      if (!text) {
        showToast('warning', '请先填写指令内容');
        return;
      }
      try {
        setBatchPromptCreateSaving(true);
        const created = await workflowApi.createPromptCard({ name, text, tags: [] });
        setBatchPromptCardLibrary((prev) => [created, ...prev.filter((item) => item.id !== created.id)]);
        if (alsoAddToCurrent) {
          appendBatchPromptTemplateFromLibraryCard(created);
        }
        setBatchPromptCreateName('');
        setBatchPromptCreateText('');
        setBatchPromptPickerTab('library');
        showToast('success', alsoAddToCurrent ? '已保存到全局卡片库并加入当前流程' : '已保存到全局卡片库');
      } catch (error) {
        showToast('error', `保存指令卡片失败：${(error as Error).message}`);
      } finally {
        setBatchPromptCreateSaving(false);
      }
    },
    [appendBatchPromptTemplateFromLibraryCard, batchPromptCreateName, batchPromptCreateText, showToast],
  );

  const deleteBatchPromptCardFromLibrary = useCallback(
    async (cardId: string) => {
      const targetId = String(cardId || '').trim();
      if (!targetId) return;
      const target = batchPromptCardLibraryMap.get(targetId);
      const confirmed = window.confirm(`确认删除全局卡片「${target?.name || targetId}」？`);
      if (!confirmed) return;
      try {
        setBatchPromptDeletingId(targetId);
        await workflowApi.deletePromptCard(targetId);
        setBatchPromptCardLibrary((prev) => prev.filter((item) => item.id !== targetId));
        setBatchPromptPickerSelectedIds((prev) => prev.filter((id) => id !== targetId));
        showToast('success', '已删除全局卡片');
      } catch (error) {
        showToast('error', `删除全局卡片失败：${(error as Error).message}`);
      } finally {
        setBatchPromptDeletingId('');
      }
    },
    [batchPromptCardLibraryMap, showToast],
  );

  const updateBatchPromptTemplate = useCallback((id: string, patch: Partial<BatchPromptTemplateCard>) => {
    setBatchPromptTemplates((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const duplicateBatchPromptTemplate = useCallback((id: string) => {
    setBatchPromptTemplates((prev) => {
      const source = prev.find((item) => item.id === id);
      if (!source) return prev;
      const copy: BatchPromptTemplateCard = {
        ...source,
        id: makeId('prompt-card'),
        library_card_id: '',
        name: `${source.name || '指令模板'}-副本`,
      };
      return [...prev, copy];
    });
  }, []);

  const removeBatchPromptTemplate = useCallback((id: string) => {
    setBatchPromptTemplates((prev) => {
      if (prev.length <= 1) {
        showToast('warning', '至少保留 1 个指令模板卡片');
        return prev;
      }
      return prev.filter((item) => item.id !== id);
    });
  }, [showToast]);

  const addBatchTaskCard = useCallback(() => {
    setBatchTaskCards((prev) => {
      const defaultPromptId = enabledPromptTemplateOptions[0]?.id || '';
      return [...prev, createBatchTaskCard(prev.length + 1, defaultPromptId)];
    });
  }, [enabledPromptTemplateOptions]);

  const updateBatchTaskCard = useCallback((id: string, patch: Partial<BatchTaskCard>) => {
    setBatchTaskCards((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const duplicateBatchTaskCard = useCallback(
    (id: string) => {
      setBatchTaskCards((prev) => {
        const source = prev.find((item) => item.id === id);
        if (!source) return prev;
        const copy: BatchTaskCard = {
          ...source,
          id: makeId('task-card'),
          name: `${source.name || '任务卡片'}-副本`,
        };
        return [...prev, copy];
      });
    },
    [],
  );

  const removeBatchTaskCard = useCallback(
    (id: string) => {
      setBatchTaskCards((prev) => {
        if (prev.length <= 1) {
          showToast('warning', '至少保留 1 张任务卡片');
          return prev;
        }
        return prev.filter((item) => item.id !== id);
      });
    },
    [showToast],
  );

  const onBatchMentionInputChange = useCallback(
    (nextValue: string, caret: number, target: BatchTemplateMentionTarget) => {
      const mention = detectMentionAtCursor(nextValue, caret);
      if (!mention) {
        setBatchTemplateMentionOpen(false);
        setBatchTemplateMentionQuery('');
        setBatchTemplateMentionRange(null);
        setBatchTemplateMentionTarget(null);
        return;
      }
      setBatchTemplateMentionQuery(mention.query);
      setBatchTemplateMentionRange({ start: mention.start, end: mention.end });
      setBatchTemplateMentionTarget(target);
      setBatchTemplateMentionOpen(true);
    },
    [],
  );

  const updateBatchSlotBinding = useCallback((index: number, patch: Partial<WorkflowRunSlotBindingInput>) => {
    setBatchSlotBindings((prev) =>
      normalizeBatchSlotBindings(
        prev.map((item, idx) => {
          if (idx !== index) return item;
          return {
            ...item,
            ...patch,
          };
        }),
      ),
    );
  }, []);

  const removeBatchSlotBinding = useCallback((index: number) => {
    setBatchSlotBindings((prev) => prev.filter((_, idx) => idx !== index));
  }, []);

  const addBatchSlotBindingByName = useCallback(
    (rawName?: string) => {
      const normalized = normalizeSlotName(rawName || '');
      const slotName = normalized || `slot_${batchSlotBindings.length + 1}`;
      if (!SLOT_NAME_PATTERN.test(slotName)) {
        showToast('warning', '槽位名需以中文或字母开头，后续可用中文/字母/数字/下划线');
        return false;
      }
      const duplicated = batchSlotBindings.some((item) => normalizeSlotName(item.slot_name || '') === slotName);
      if (duplicated) {
        showToast('warning', `槽位名重复：${slotName}`);
        return false;
      }
      setBatchSlotBindings((prev) =>
        normalizeBatchSlotBindings([
          ...prev,
          {
            slot_name: slotName,
            slot_type: 'fixed',
            required: false,
            asset_id: '',
          },
        ]),
      );
      return true;
    },
    [batchSlotBindings, showToast],
  );

  const addBatchSlotBinding = useCallback(() => {
    const ok = addBatchSlotBindingByName(batchNewSlotName);
    if (ok) setBatchNewSlotName('');
  }, [addBatchSlotBindingByName, batchNewSlotName]);

  const addBatchSuggestedSlotBinding = useCallback(
    (slotName: string) => {
      const ok = addBatchSlotBindingByName(slotName);
      if (ok) setBatchNewSlotName('');
    },
    [addBatchSlotBindingByName],
  );

  const closeBatchTemplateMentionMenu = useCallback(() => {
    setBatchTemplateMentionOpen(false);
    setBatchTemplateMentionQuery('');
    setBatchTemplateMentionRange(null);
    setBatchTemplateMentionTarget(null);
  }, []);

  const applyBatchTemplateMentionToken = useCallback(
    (token: string) => {
      const range = batchTemplateMentionRange;
      const target = batchTemplateMentionTarget;
      if (!range || !target) {
        closeBatchTemplateMentionMenu();
        return;
      }
      if (target.type === 'rule') {
        setBatchRecipeTemplate((prev) => `${prev.slice(0, range.start)}${token}${prev.slice(range.end)}`);
      } else if (target.type === 'prompt' && target.promptCardId) {
        setBatchPromptTemplates((prev) =>
          prev.map((item) =>
            item.id === target.promptCardId
              ? { ...item, text: `${item.text.slice(0, range.start)}${token}${item.text.slice(range.end)}` }
              : item,
          ),
        );
      } else if (target.type === 'prompt_create') {
        setBatchPromptCreateText((prev) => `${prev.slice(0, range.start)}${token}${prev.slice(range.end)}`);
      }
      closeBatchTemplateMentionMenu();
    },
    [batchTemplateMentionRange, batchTemplateMentionTarget, closeBatchTemplateMentionMenu, setBatchPromptCreateText],
  );

  const buildBatchRunPayload = useCallback((): WorkflowRunCreateRequest | null => {
    let assetItems: Array<{ id: string; title: string }> = [];
    let prompts: Array<{ id: string; title: string; text: string }> = [];
    let runCombinationMode: WorkflowCombinationMode = batchMode;

    if (batchUseTaskCards) {
      const enabledCards = batchTaskCards.filter((item) => item.enabled);
      if (enabledCards.length === 0) {
        showToast('warning', '任务卡片模式下，至少启用 1 张任务卡片');
        return null;
      }
      const seenAssetIds = new Set<string>();
      for (const card of enabledCards) {
        const assetId = String(card.asset_id || '').trim();
        if (!assetId) {
          showToast('warning', `任务卡片「${card.name || card.id}」未选择主图素材`);
          return null;
        }
        if (seenAssetIds.has(assetId)) {
          showToast('warning', `任务卡片模式暂不支持重复主图：${assetId}。请改为普通模式或更换主图。`);
          return null;
        }
        seenAssetIds.add(assetId);
        const asset = localAssetMap.get(assetId);
        if (!asset) {
          showToast('warning', `任务卡片主图不存在：${assetId}`);
          return null;
        }
        const promptCard = batchPromptTemplateMap.get(String(card.prompt_card_id || '').trim());
        if (!promptCard || !promptCard.enabled || !String(promptCard.text || '').trim()) {
          showToast('warning', `任务卡片「${card.name || card.id}」未绑定有效模板`);
          return null;
        }
        assetItems.push({
          id: String(asset.id || ''),
          title: String(asset.title || asset.id || ''),
        });
        prompts.push({
          id: `card-${card.id}`,
          title: String(card.name || '').trim() || `任务卡片-${card.id}`,
          text: String(promptCard.text || '').trim(),
        });
      }
      runCombinationMode = 'pairwise';
    } else {
      assetItems = batchSelectedAssetIds
        .map((id) => localAssetMap.get(id))
        .filter(Boolean)
        .map((asset) => ({
          id: String(asset?.id || ''),
          title: String(asset?.title || asset?.id || ''),
        }))
        .filter((item) => item.id);
      if (assetItems.length === 0) {
        showToast('warning', '请至少选择 1 个本地素材');
        return null;
      }

      prompts = promptsFromTemplateCards(batchPromptTemplates);
      if (prompts.length === 0) {
        showToast('warning', '请至少配置 1 个启用且有内容的指令模板');
        return null;
      }
    }

    const recipes = [
      {
        id: 'recipe-1',
        name: batchRecipeName.trim() || '默认配方',
        prompt_template: batchRecipeTemplate.trim(),
        model: (batchRecipeModel || imageModelOptions[0]?.id || 'xiaodoubao-nano-banana').trim(),
        aspect_ratio: batchRecipeAspectRatio,
        quality: batchRecipeQuality,
        reference_asset_ids: [],
        enabled: true,
      },
    ];
    const normalizedSlotBindings = normalizeBatchSlotBindings(batchSlotBindings)
      .map((item) => ({
        slot_name: normalizeSlotName(item.slot_name || ''),
        slot_type: 'fixed' as const,
        required: Boolean(item.required),
        asset_id: String(item.asset_id || '').trim(),
      }))
      .filter((item) => item.slot_name);

    const slotNames = normalizedSlotBindings.map((item) => item.slot_name);
    const duplicatedSlot = slotNames.find((name, index) => slotNames.indexOf(name) !== index);
    if (duplicatedSlot) {
      showToast('warning', `槽位名重复：${duplicatedSlot}`);
      return null;
    }
    const invalidSlot = normalizedSlotBindings.find((item) => !SLOT_NAME_PATTERN.test(item.slot_name));
    if (invalidSlot) {
      showToast('warning', `槽位名不合法：${invalidSlot.slot_name}`);
      return null;
    }
    const missingRequired = normalizedSlotBindings.find((item) => item.required && !item.asset_id);
    if (missingRequired) {
      showToast('warning', `必填槽位未绑定素材：${missingRequired.slot_name}`);
      return null;
    }
    const slotBindingMap = new Map(normalizedSlotBindings.map((item) => [item.slot_name, item]));
    const promptMentions = prompts.flatMap((item) => extractMentionTokens(item.text || ''));
    const templateMentions = extractMentionTokens(batchRecipeTemplate.trim());
    const allMentions = Array.from(new Set([...promptMentions, ...templateMentions]));
    const allowedMentions = new Set<string>([
      ...Array.from(slotBindingMap.keys()),
      ...PRIMARY_ASSET_MENTION_TOKENS.map((token) => token.slice(1)),
    ]);
    const invalidMention = allMentions.find((token) => !allowedMentions.has(token));
    if (invalidMention) {
      showToast('warning', `检测到未定义引用：@${invalidMention}。请从 @ 菜单选择有效槽位或主素材。`);
      return null;
    }
    const missingMentionBinding = allMentions.find((token) => {
      const slot = slotBindingMap.get(token);
      return Boolean(slot && !slot.asset_id);
    });
    if (missingMentionBinding) {
      showToast('warning', `模板引用槽位未绑定素材：${missingMentionBinding}`);
      return null;
    }

    return {
      name: '画布批运行',
      assets: assetItems,
      prompts,
      recipes,
      combination_mode: runCombinationMode,
      variants_per_item: clampInt(batchVariants, 1, 8),
      concurrency: clampInt(batchConcurrency, 1, 8),
      slot_bindings: normalizedSlotBindings,
    };
  }, [
    batchTaskCards,
    batchConcurrency,
    batchMode,
    batchPromptTemplates,
    batchPromptTemplateMap,
    batchRecipeAspectRatio,
    batchRecipeModel,
    batchRecipeName,
    batchRecipeQuality,
    batchSlotBindings,
    batchRecipeTemplate,
    batchSelectedAssetIds,
    batchUseTaskCards,
    batchVariants,
    imageModelOptions,
    localAssetMap,
    showToast,
  ]);

  const refreshBatchRunSnapshot = useCallback(
    async (runId?: string) => {
      const targetRunId = runId || batchRunSnapshot?.id;
      if (!targetRunId) return;
      try {
        const latest = await workflowApi.getRun(targetRunId);
        setBatchRunSnapshot(latest);
        if (latest.status !== 'running') {
          setBatchPolling(false);
        }
      } catch (error) {
        setBatchPolling(false);
        showToast('warning', `批运行状态拉取失败：${(error as Error).message}`);
      }
    },
    [batchRunSnapshot?.id, showToast],
  );

  const handleBatchPreview = useCallback(async () => {
    const payload = buildBatchRunPayload();
    if (!payload) return;
    const payloadSignature = JSON.stringify(payload);
    try {
      setBatchBusy(true);
      const preview = await workflowApi.previewRun(payload);
      setBatchPreview(preview);
      setBatchPreviewPayloadSignature(payloadSignature);
      showToast('success', `任务预估完成：${preview.total_tasks}/${preview.limit}`);
    } catch (error) {
      showToast('error', `任务预估失败：${(error as Error).message}`);
    } finally {
      setBatchBusy(false);
    }
  }, [buildBatchRunPayload, showToast]);

  const handleBatchRunStart = useCallback(async () => {
    const payload = buildBatchRunPayload();
    if (!payload) return;
    const payloadSignature = JSON.stringify(payload);
    if (!batchPreview || !batchPreviewPayloadSignature || batchPreviewPayloadSignature !== payloadSignature) {
      showToast('warning', '启动前请先点击“预估任务”，配置变更后需重新预估。');
      return;
    }
    if (batchPreview.total_tasks > batchPreview.limit) {
      showToast('warning', `任务数 ${batchPreview.total_tasks} 超过上限 ${batchPreview.limit}，请先缩减规模。`);
      return;
    }
    try {
      setBatchBusy(true);
      const created = await workflowApi.createRun(payload);
      setBatchRunSnapshot(created);
      setBatchPolling(created.status === 'running');
      showToast('success', `批运行已启动：${created.id}`);
    } catch (error) {
      showToast('error', `批运行启动失败：${(error as Error).message}`);
    } finally {
      setBatchBusy(false);
    }
  }, [batchPreview, batchPreviewPayloadSignature, buildBatchRunPayload, showToast]);

  const handleBatchRetryTask = useCallback(
    async (taskId: string) => {
      if (!batchRunSnapshot?.id) return;
      try {
        setBatchBusy(true);
        const latest = await workflowApi.retryRunTask(batchRunSnapshot.id, taskId);
        setBatchRunSnapshot(latest);
        if (latest.status === 'running') setBatchPolling(true);
        showToast('success', `已触发任务重试：${taskId}`);
      } catch (error) {
        showToast('error', `任务重试失败：${(error as Error).message}`);
      } finally {
        setBatchBusy(false);
      }
    },
    [batchRunSnapshot?.id, showToast],
  );

  useEffect(() => {
    if (!batchPolling || !batchRunSnapshot?.id) return undefined;
    const timer = window.setInterval(() => {
      void refreshBatchRunSnapshot(batchRunSnapshot.id);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [batchPolling, batchRunSnapshot?.id, refreshBatchRunSnapshot]);

  const batchPreviewReady = Boolean(batchPreview && batchPreviewPayloadSignature);
  const batchPreviewStale = Boolean(batchPreview && !batchPreviewPayloadSignature);
  const batchPreviewTasks = useMemo(() => {
    if (!batchPreview) return [];
    if (Array.isArray(batchPreview.expanded_tasks) && batchPreview.expanded_tasks.length > 0) {
      return batchPreview.expanded_tasks;
    }
    return batchPreview.sample_tasks.map((item) => ({
      task_id: item.task_id,
      source_asset_id: item.source_asset_id,
      source_asset_title: item.source_asset_title,
      prompt_id: item.prompt_id,
      prompt_title: item.prompt_id,
      prompt_text: '',
      recipe_id: item.recipe_id,
      recipe_name: item.recipe_id,
      variant_index: item.variant_index,
      effective_prompt: item.prompt_preview,
      slot_assets: item.slot_assets || [],
      attachment_asset_ids: item.attachment_asset_ids || [],
    }));
  }, [batchPreview]);
  const batchPreviewTaskGroups = useMemo(() => {
    const groupMap = new Map<
      string,
      {
        source_asset_id: string;
        source_asset_title: string;
        tasks: typeof batchPreviewTasks;
      }
    >();
    batchPreviewTasks.forEach((task) => {
      const sourceAssetId = String(task.source_asset_id || '');
      const groupKey = sourceAssetId || 'unknown-source';
      const existing = groupMap.get(groupKey);
      if (existing) {
        existing.tasks.push(task);
        return;
      }
      groupMap.set(groupKey, {
        source_asset_id: groupKey,
        source_asset_title: String(task.source_asset_title || sourceAssetId || '未命名主素材'),
        tasks: [task],
      });
    });
    return Array.from(groupMap.values());
  }, [batchPreviewTasks]);
  const batchRunTaskGroups = useMemo(() => {
    if (!batchRunSnapshot) return [];
    const groupMap = new Map<
      string,
      {
        source_asset_id: string;
        source_asset_title: string;
        tasks: WorkflowRunSnapshot['tasks'];
      }
    >();
    (batchRunSnapshot.tasks || []).forEach((task) => {
      const sourceAssetId = String(task.source_asset_id || '');
      const groupKey = sourceAssetId || 'unknown-source';
      const existing = groupMap.get(groupKey);
      if (existing) {
        existing.tasks.push(task);
        return;
      }
      groupMap.set(groupKey, {
        source_asset_id: groupKey,
        source_asset_title: String(task.source_asset_title || sourceAssetId || '未命名主素材'),
        tasks: [task],
      });
    });
    return Array.from(groupMap.values());
  }, [batchRunSnapshot]);
  const batchComposerCanvasNodes = useMemo(
    () =>
      BATCH_COMPOSER_SECTION_META.map((item, index) => {
        const column = index % 2;
        const row = Math.floor(index / 2);
        return {
          id: item.id,
          type: 'default' as const,
          position: {
            x: 80 + column * 280,
            y: 60 + row * 130,
          },
          data: {
            label: item.label,
          },
          style: {
            minWidth: 180,
            borderRadius: 12,
            border: batchComposerSection === item.id ? '2px solid #2d8cf0' : '1px solid #d0d7e2',
            background: batchComposerSection === item.id ? '#eaf4ff' : '#f8fbff',
            boxShadow: batchComposerSection === item.id ? '0 0 0 3px rgba(45,140,240,0.12)' : '0 4px 10px rgba(12,27,51,0.06)',
            padding: 8,
          },
        };
      }),
    [batchComposerSection],
  );
  const batchComposerCanvasEdges = useMemo(
    () =>
      ([
        { id: 'bce-1', source: 'assets', target: 'templates' },
        { id: 'bce-2', source: 'templates', target: 'task_cards' },
        { id: 'bce-3', source: 'task_cards', target: 'execute' },
        { id: 'bce-4', source: 'execute', target: 'slots' },
        { id: 'bce-5', source: 'slots', target: 'preview' },
      ] as FlowEdge[]).map((edge) => ({
        ...edge,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [],
  );
  const renderBatchComposerSection = useCallback(() => {
    if (batchComposerSection === 'assets') {
      return (
        <Stack spacing={0.8}>
          <Stack direction="row" spacing={0.8}>
            <Button size="small" variant="contained" onClick={openBatchAssetPickerForMain}>
              选择主图素材
            </Button>
            <Button size="small" variant="text" onClick={() => void refreshAssets()}>
              刷新素材
            </Button>
            <Button
              size="small"
              color="error"
              variant="text"
              onClick={() => setBatchSelectedAssetIds([])}
              disabled={batchSelectedAssetIds.length === 0}
            >
              清空已选
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            在弹窗内按来源 Tab 浏览素材，支持“上传 / 生成 / 素材库 / Bridge”，并可直接上传新素材。
          </Typography>
          <Typography variant="caption" fontWeight={600}>
            主素材（已选 {batchSelectedAssetIds.length}）
          </Typography>
          <Box sx={{ border: '1px solid #eef1f6', borderRadius: 1, p: 0.8, minHeight: 140 }}>
            {selectedBatchAssets.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                还没有主图卡片，请点击上方“选择主图素材”。
              </Typography>
            ) : (
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: 0.8,
                }}
              >
                {selectedBatchAssets.map((asset, idx) => {
                  const thumb = resolveAssetUrl(String(asset.thumbnail_url || asset.file_url || ''));
                  return (
                    <Box
                      key={`composer-selected-asset-${asset.id}`}
                      sx={{
                        border: '1px solid #edf1f7',
                        borderRadius: 1,
                        p: 0.7,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 0.6,
                      }}
                    >
                      <Box
                        sx={{
                          width: '100%',
                          height: 88,
                          borderRadius: 1,
                          overflow: 'hidden',
                          bgcolor: '#f6f8fc',
                          border: '1px solid #eef1f6',
                        }}
                      >
                        {thumb ? (
                          <Box
                            component="img"
                            src={thumb}
                            alt={String(asset.title || asset.id || '')}
                            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                        ) : (
                          <Stack sx={{ height: '100%' }} alignItems="center" justifyContent="center">
                            <Typography variant="caption" color="text.secondary">
                              无缩略图
                            </Typography>
                          </Stack>
                        )}
                      </Box>
                      <Typography variant="caption" sx={{ lineHeight: 1.3, minHeight: 34 }}>
                        主图#{idx + 1} · {String(asset.title || asset.id || '未命名素材')}
                      </Typography>
                      <Button size="small" color="error" onClick={() => removeBatchAsset(String(asset.id || ''))}>
                        移除
                      </Button>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
        </Stack>
      );
    }

    if (batchComposerSection === 'templates') {
      return (
        <Stack spacing={0.8}>
          <Typography variant="caption" fontWeight={600}>
            任务指令卡片（一个卡片=一条执行规则）
          </Typography>
          <Stack spacing={0.8} sx={{ border: '1px solid #eef1f6', borderRadius: 1, p: 0.8 }}>
            {batchPromptTemplates.map((card, index) => (
              <Box key={`composer-prompt-card-${card.id}`} sx={{ border: '1px solid #edf1f7', borderRadius: 1, p: 0.8 }}>
                <Stack direction="row" spacing={0.8} alignItems="center">
                  <TextField
                    size="small"
                    label={`模板名 #${index + 1}`}
                    value={card.name}
                    onChange={(event) => updateBatchPromptTemplate(card.id, { name: event.target.value })}
                    sx={{ flex: 1 }}
                  />
                  <FormControlLabel
                    control={<Switch checked={card.enabled} onChange={(_event, checked) => updateBatchPromptTemplate(card.id, { enabled: checked })} />}
                    label={card.enabled ? '启用' : '停用'}
                  />
                </Stack>
                {card.library_card_id ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.4 }}>
                    来源：全局卡片库（{card.library_card_id}）
                  </Typography>
                ) : null}
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.8, mb: 0.4 }}>
                  任务指令
                </Typography>
                <WorkflowRichPromptEditor
                  value={card.text}
                  minRows={2}
                  mentionOptions={slotMentionOptions}
                  placeholder="示例：将沙发替换为 @替换对象，同时参考 @风格基准。"
                  onChange={(nextValue, caret, anchorEl) => {
                    updateBatchPromptTemplate(card.id, { text: nextValue });
                    onBatchMentionInputChange(nextValue, caret, { type: 'prompt', promptCardId: card.id });
                    setBatchTemplateMentionAnchorEl(anchorEl);
                  }}
                  onCaretChange={(nextValue, caret, anchorEl) => {
                    onBatchMentionInputChange(nextValue, caret, { type: 'prompt', promptCardId: card.id });
                    setBatchTemplateMentionAnchorEl(anchorEl);
                  }}
                  onMentionPreview={(item) => {
                    const url = resolveAssetUrl(String(item.previewUrl || item.thumbnailUrl || ''));
                    if (!url) return;
                    setBatchMentionPreview({ url, title: item.assetTitle || item.token });
                  }}
                />
                <Stack direction="row" spacing={0.8} sx={{ mt: 0.8 }}>
                  <Button size="small" onClick={() => duplicateBatchPromptTemplate(card.id)}>
                    复制
                  </Button>
                  <Button size="small" color="error" onClick={() => removeBatchPromptTemplate(card.id)}>
                    删除
                  </Button>
                </Stack>
              </Box>
            ))}
            <Stack direction="row" spacing={0.8}>
              <Button size="small" variant="outlined" onClick={openBatchPromptPicker}>
                + 新增指令模板卡片
              </Button>
              <Button size="small" variant="text" onClick={() => void refreshPromptCardLibrary()} disabled={batchPromptCardLibraryBusy}>
                {batchPromptCardLibraryBusy ? '刷新中...' : '刷新全局卡片库'}
              </Button>
            </Stack>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {mentionHelpText}
          </Typography>
          <Menu
            open={batchTemplateMentionOpen && Boolean(batchTemplateMentionAnchorEl)}
            anchorEl={batchTemplateMentionAnchorEl}
            onClose={closeBatchTemplateMentionMenu}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            autoFocus={false}
            disableAutoFocusItem
            disableEnforceFocus
            disableRestoreFocus
            keepMounted
          >
            {filteredSlotMentionOptions.length === 0 ? (
              <MenuItem disabled>无可用槽位</MenuItem>
            ) : (
              filteredSlotMentionOptions.map((item) => (
                <MenuItem
                  key={`composer-slot-mention-${item.token}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyBatchTemplateMentionToken(item.token)}
                >
                  <Stack direction="row" spacing={0.7} alignItems="center">
                    {item.thumbnailUrl ? (
                      <Box
                        component="img"
                        src={item.thumbnailUrl}
                        alt={item.assetTitle || item.token}
                        sx={{ width: 18, height: 18, borderRadius: 0.4, objectFit: 'cover', border: '1px solid #c7d5f1' }}
                      />
                    ) : null}
                    <Box component="span">{item.label || item.token}</Box>
                  </Stack>
                </MenuItem>
              ))
            )}
          </Menu>
        </Stack>
      );
    }

    if (batchComposerSection === 'task_cards') {
      return (
        <Stack spacing={0.8}>
          <FormControlLabel
            control={<Switch checked={batchUseTaskCards} onChange={(_event, checked) => setBatchUseTaskCards(checked)} />}
            label={batchUseTaskCards ? '已启用任务卡片编排' : '启用任务卡片编排（每卡=选图+模板）'}
          />
          {batchUseTaskCards ? (
            <Stack spacing={0.8} sx={{ border: '1px solid #eef1f6', borderRadius: 1, p: 0.8 }}>
              <Alert severity="info" variant="outlined">
                任务卡片模式会按“图词一一配对”运行。当前为兼容后端限制，1 张主图只能在 1 张卡片里使用。
              </Alert>
              {batchTaskCards.map((card, index) => (
                <Box key={`composer-task-card-${card.id}`} sx={{ border: '1px solid #edf1f7', borderRadius: 1, p: 0.8 }}>
                  <Stack direction="row" spacing={0.8} alignItems="center">
                    <TextField
                      size="small"
                      label={`任务名 #${index + 1}`}
                      value={card.name}
                      onChange={(event) => updateBatchTaskCard(card.id, { name: event.target.value })}
                      sx={{ flex: 1 }}
                    />
                    <FormControlLabel
                      control={<Switch checked={card.enabled} onChange={(_event, checked) => updateBatchTaskCard(card.id, { enabled: checked })} />}
                      label={card.enabled ? '启用' : '停用'}
                    />
                  </Stack>
                  <Stack direction="row" spacing={0.8} sx={{ mt: 0.8 }}>
                    <FormControl size="small" sx={{ flex: 1 }}>
                      <InputLabel>主图素材</InputLabel>
                      <Select
                        label="主图素材"
                        value={String(card.asset_id || '')}
                        onChange={(event) => updateBatchTaskCard(card.id, { asset_id: String(event.target.value || '') })}
                      >
                        <MenuItem value="">请选择</MenuItem>
                        {localAssets.map((asset) => (
                          <MenuItem key={`composer-task-card-asset-${card.id}-${asset.id}`} value={asset.id}>
                            {asset.title || asset.id}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl size="small" sx={{ flex: 1 }}>
                      <InputLabel>绑定模板</InputLabel>
                      <Select
                        label="绑定模板"
                        value={String(card.prompt_card_id || '')}
                        onChange={(event) => updateBatchTaskCard(card.id, { prompt_card_id: String(event.target.value || '') })}
                      >
                        <MenuItem value="">请选择</MenuItem>
                        {enabledPromptTemplateOptions.map((item) => (
                          <MenuItem key={`composer-task-card-prompt-${card.id}-${item.id}`} value={item.id}>
                            {item.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Stack>
                  <Stack direction="row" spacing={0.8} sx={{ mt: 0.8 }}>
                    <Button size="small" onClick={() => duplicateBatchTaskCard(card.id)}>
                      复制
                    </Button>
                    <Button size="small" color="error" onClick={() => removeBatchTaskCard(card.id)}>
                      删除
                    </Button>
                  </Stack>
                </Box>
              ))}
              <Button size="small" variant="outlined" onClick={addBatchTaskCard}>
                + 新增任务卡片
              </Button>
            </Stack>
          ) : (
            <Alert severity="info" variant="outlined">
              当前未启用任务卡片。你可以在此打开并做“每卡=选图+模板”配置。
            </Alert>
          )}
        </Stack>
      );
    }

    if (batchComposerSection === 'execute') {
      return (
        <Stack spacing={0.8}>
          <FormControl size="small">
            <InputLabel>任务组合方式</InputLabel>
            <Select
              label="任务组合方式"
              value={batchMode}
              onChange={(event) => setBatchMode(event.target.value as WorkflowCombinationMode)}
              disabled={batchUseTaskCards}
            >
              <MenuItem value="broadcast">多图同规则 / 单图多规则</MenuItem>
              <MenuItem value="pairwise">图词一一配对</MenuItem>
              <MenuItem value="cartesian">全组合探索（每图 x 每规则）</MenuItem>
            </Select>
          </FormControl>
          <Typography variant="caption" color="text.secondary">
            {batchUseTaskCards ? '任务卡片模式固定为一一配对，不使用上方组合器。' : batchModeHints[batchMode]}
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              label="每图产出"
              type="number"
              value={batchVariants}
              onChange={(event) => setBatchVariants(clampInt(Number(event.target.value || 1), 1, 8))}
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label="并发数"
              type="number"
              value={batchConcurrency}
              onChange={(event) => setBatchConcurrency(clampInt(Number(event.target.value || 1), 1, 8))}
              sx={{ flex: 1 }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            每图产出：同一组“主图+规则”生成几张候选图。并发数：同时执行的任务数量。
          </Typography>
          <TextField
            size="small"
            label="配方名称"
            value={batchRecipeName}
            onChange={(event) => setBatchRecipeName(event.target.value)}
          />
          <Typography variant="caption" color="text.secondary">
            固定规则（所有任务都会附加，可选）
          </Typography>
          <WorkflowRichPromptEditor
            value={batchRecipeTemplate}
            minRows={4}
            mentionOptions={slotMentionOptions}
            placeholder={'示例：\n将沙发替换为 @替换对象，同时参考 @风格基准。\n保留原始空间构图与光线。'}
            onChange={(nextValue, caret, anchorEl) => {
              setBatchRecipeTemplate(nextValue);
              onBatchMentionInputChange(nextValue, caret, { type: 'rule' });
              setBatchTemplateMentionAnchorEl(anchorEl);
            }}
            onCaretChange={(nextValue, caret, anchorEl) => {
              onBatchMentionInputChange(nextValue, caret, { type: 'rule' });
              setBatchTemplateMentionAnchorEl(anchorEl);
            }}
            onMentionPreview={(item) => {
              const url = resolveAssetUrl(String(item.previewUrl || item.thumbnailUrl || ''));
              if (!url) return;
              setBatchMentionPreview({ url, title: item.assetTitle || item.token });
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {mentionHelpText}
          </Typography>
          <Menu
            open={batchTemplateMentionOpen && Boolean(batchTemplateMentionAnchorEl)}
            anchorEl={batchTemplateMentionAnchorEl}
            onClose={closeBatchTemplateMentionMenu}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            autoFocus={false}
            disableAutoFocusItem
            disableEnforceFocus
            disableRestoreFocus
            keepMounted
          >
            {filteredSlotMentionOptions.length === 0 ? (
              <MenuItem disabled>无可用槽位</MenuItem>
            ) : (
              filteredSlotMentionOptions.map((item) => (
                <MenuItem
                  key={`composer-execute-slot-mention-${item.token}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyBatchTemplateMentionToken(item.token)}
                >
                  <Stack direction="row" spacing={0.7} alignItems="center">
                    {item.thumbnailUrl ? (
                      <Box
                        component="img"
                        src={item.thumbnailUrl}
                        alt={item.assetTitle || item.token}
                        sx={{ width: 18, height: 18, borderRadius: 0.4, objectFit: 'cover', border: '1px solid #c7d5f1' }}
                      />
                    ) : null}
                    <Box component="span">{item.label || item.token}</Box>
                  </Stack>
                </MenuItem>
              ))
            )}
          </Menu>
          <FormControl size="small">
            <InputLabel>生图模型</InputLabel>
            <Select
              label="生图模型"
              value={batchRecipeModel || imageModelOptions[0]?.id || 'xiaodoubao-nano-banana'}
              onChange={(event) => setBatchRecipeModel(String(event.target.value || ''))}
            >
              {imageModelOptions.map((model) => (
                <MenuItem key={`composer-batch-model-${model.id}`} value={model.id}>
                  {model.name}
                </MenuItem>
              ))}
              <MenuItem value="xiaodoubao-nano-banana">xiaodoubao-nano-banana</MenuItem>
            </Select>
          </FormControl>
          <Stack direction="row" spacing={1}>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel>比例</InputLabel>
              <Select
                label="比例"
                value={batchRecipeAspectRatio}
                onChange={(event) => setBatchRecipeAspectRatio(String(event.target.value || IMAGE_DEFAULTS.aspect_ratio))}
              >
                {(options?.aspect_ratios || [IMAGE_DEFAULTS.aspect_ratio]).map((ratio) => (
                  <MenuItem key={`composer-batch-ratio-${ratio}`} value={ratio}>
                    {ratio}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel>质量</InputLabel>
              <Select
                label="质量"
                value={batchRecipeQuality}
                onChange={(event) => setBatchRecipeQuality(String(event.target.value || IMAGE_DEFAULTS.quality))}
              >
                {(options?.qualities || [IMAGE_DEFAULTS.quality]).map((quality) => (
                  <MenuItem key={`composer-batch-quality-${quality}`} value={quality}>
                    {quality}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </Stack>
      );
    }

    if (batchComposerSection === 'slots') {
      return (
        <Stack spacing={0.8}>
          <Typography variant="caption" fontWeight={600}>
            参考槽位绑定（固定）
          </Typography>
          <Typography variant="caption" color="text.secondary">
            槽位名就是“角色名”，例如：替换对象、风格基准。提示词里用 @槽位名 进行引用。
          </Typography>
          <Stack spacing={0.8} sx={{ border: '1px solid #eef1f6', borderRadius: 1, p: 0.8 }}>
            {batchSlotBindings.length === 0 ? (
              <Alert severity="info" variant="outlined">
                暂无参考变量。你可以先新增变量，再在模板里输入 @ 选择引用。
              </Alert>
            ) : null}
            {batchSlotBindings.map((slotItem, index) => (
              <Stack key={`composer-slot-binding-${index}`} spacing={0.6} sx={{ border: '1px solid #eef1f6', borderRadius: 1, p: 0.8 }}>
                <Stack direction="row" spacing={0.8} alignItems="center">
                  <TextField
                    size="small"
                    label="槽位名"
                    value={slotItem.slot_name || ''}
                    onChange={(event) => updateBatchSlotBinding(index, { slot_name: normalizeSlotName(event.target.value) })}
                    sx={{ flex: 1 }}
                  />
                  <FormControlLabel
                    control={<Switch checked={Boolean(slotItem.required)} onChange={(_event, checked) => updateBatchSlotBinding(index, { required: checked })} />}
                    label="必填"
                  />
                  <Button size="small" color="error" onClick={() => removeBatchSlotBinding(index)}>
                    删除
                  </Button>
                </Stack>
                <FormControl size="small">
                  <InputLabel>绑定素材</InputLabel>
                  <Select
                    label="绑定素材"
                    value={String(slotItem.asset_id || '')}
                    onChange={(event) => updateBatchSlotBinding(index, { asset_id: String(event.target.value || '') })}
                  >
                    <MenuItem value="">未绑定</MenuItem>
                    {localAssets.map((asset) => (
                      <MenuItem key={`composer-slot-asset-${index}-${asset.id}`} value={asset.id}>
                        {asset.title || asset.id}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
            ))}
            <Stack direction="row" spacing={0.8}>
              <TextField
                size="small"
                label="新增槽位名"
                value={batchNewSlotName}
                onChange={(event) => setBatchNewSlotName(event.target.value)}
                placeholder="例如 替换对象"
                sx={{ flex: 1 }}
              />
              <Button size="small" variant="outlined" onClick={addBatchSlotBinding}>
                新增槽位
              </Button>
            </Stack>
            <Stack direction="row" spacing={0.8}>
              <Button size="small" variant="text" onClick={() => addBatchSuggestedSlotBinding('替换对象')}>
                + 快捷变量：替换对象
              </Button>
              <Button size="small" variant="text" onClick={() => addBatchSuggestedSlotBinding('风格基准')}>
                + 快捷变量：风格基准
              </Button>
            </Stack>
          </Stack>
        </Stack>
      );
    }

    return (
      <Stack spacing={0.8}>
        <Typography variant="caption" fontWeight={600}>
          本地实时任务预演
        </Typography>
        {localBatchPairPreview.error ? (
          <Alert severity="warning" variant="outlined">
            {localBatchPairPreview.error}
          </Alert>
        ) : (
          <Alert severity={localBatchTaskEstimate > 50 ? 'error' : 'success'} variant="outlined">
            当前预演：{localBatchPairPreview.pairs.length} 组图词配对 x {clampInt(batchVariants, 1, 8)} 每图产出 = {localBatchTaskEstimate} 个任务
          </Alert>
        )}
        {batchPreview ? (
          <Box>
            <Alert severity={batchPreview.total_tasks > batchPreview.limit ? 'error' : 'info'} variant="outlined">
              任务预估：{batchPreview.total_tasks}/{batchPreview.limit}，素材 {batchPreview.assets_count}，提示词 {batchPreview.prompts_count}，配方 {batchPreview.recipes_count}
            </Alert>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              任务展开预览清单（{batchPreviewTasks.length} 条）
            </Typography>
            <List dense sx={{ maxHeight: 240, overflow: 'auto', border: '1px solid #eef1f6', borderRadius: 1 }}>
              {batchPreviewTaskGroups.map((group) => (
                <Box key={`composer-preview-group-${group.source_asset_id}`} sx={{ borderBottom: '1px solid #f0f2f7' }}>
                  <Typography variant="caption" sx={{ px: 1, py: 0.6, display: 'block', fontWeight: 700, bgcolor: '#f9fbff', borderBottom: '1px solid #eef1f6' }}>
                    主素材：{group.source_asset_title}（{group.tasks.length} 条）
                  </Typography>
                  {group.tasks.map((item) => (
                    <Box key={`composer-preview-${item.task_id}`} sx={{ px: 1, py: 0.7, borderBottom: '1px solid #f2f4f8' }}>
                      <Typography variant="caption" sx={{ display: 'block', fontWeight: 600 }}>
                        任务 {item.task_id}：{item.recipe_name || item.recipe_id} · v{item.variant_index}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              ))}
            </List>
          </Box>
        ) : (
          <Alert severity="info" variant="outlined">
            启动前建议先点击“预估任务”。
          </Alert>
        )}
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="outlined" onClick={() => void handleBatchPreview()} disabled={batchBusy}>
            预估任务
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => void handleBatchRunStart()}
            disabled={batchBusy || batchPolling || !batchPreviewReady || (batchPreview?.total_tasks || 0) > (batchPreview?.limit || 0)}
          >
            {batchPolling ? '批运行中...' : '启动批运行'}
          </Button>
        </Stack>
      </Stack>
    );
  }, [
    addBatchSlotBinding,
    addBatchSuggestedSlotBinding,
    addBatchTaskCard,
    batchBusy,
    batchComposerSection,
    batchConcurrency,
    batchMode,
    batchModeHints,
    batchNewSlotName,
    batchPolling,
    batchPromptCardLibraryBusy,
    batchPreview,
    batchPreviewReady,
    batchPreviewTaskGroups,
    batchPreviewTasks.length,
    batchPromptTemplates,
    batchRecipeAspectRatio,
    batchRecipeModel,
    batchRecipeName,
    batchRecipeQuality,
    batchRecipeTemplate,
    batchSelectedAssetIds.length,
    batchSlotBindings,
    batchTaskCards,
    batchUseTaskCards,
    batchVariants,
    duplicateBatchPromptTemplate,
    duplicateBatchTaskCard,
    enabledPromptTemplateOptions,
    handleBatchPreview,
    handleBatchRunStart,
    imageModelOptions,
    localAssets,
    localBatchPairPreview.error,
    localBatchTaskEstimate,
    mentionHelpText,
    slotMentionOptions,
    options?.aspect_ratios,
    options?.qualities,
    onBatchMentionInputChange,
    openBatchPromptPicker,
    closeBatchTemplateMentionMenu,
    filteredSlotMentionOptions,
    applyBatchTemplateMentionToken,
    batchTemplateMentionOpen,
    batchTemplateMentionAnchorEl,
    refreshPromptCardLibrary,
    openBatchAssetPickerForMain,
    refreshAssets,
    removeBatchAsset,
    removeBatchPromptTemplate,
    removeBatchSlotBinding,
    removeBatchTaskCard,
    selectedBatchAssets,
    updateBatchPromptTemplate,
    updateBatchSlotBinding,
    updateBatchTaskCard,
  ]);

  const appendStoredOutputItems = useCallback(
    (items: StoredOutputItem[]) => {
      if (items.length === 0) return;
      setStoredOutputs((prev) => {
        const next = [...items, ...prev].slice(0, MAX_STORED_OUTPUTS);
        writeStoredOutputs(next);
        return next;
      });
    },
    [setStoredOutputs],
  );
  const handleSaveBatchRunOutputs = useCallback(() => {
    if (!batchRunSnapshot) {
      showToast('warning', '暂无批运行结果可保存');
      return;
    }
    const completedTasks = (batchRunSnapshot.tasks || []).filter((task) => task.status === 'completed');
    if (completedTasks.length === 0) {
      showToast('warning', '当前批运行没有完成任务可保存');
      return;
    }

    const grouped = new Map<string, WorkflowRunSnapshot['tasks']>();
    completedTasks.forEach((task) => {
      const sourceAssetId = String(task.source_asset_id || '') || 'unknown-source';
      const prev = grouped.get(sourceAssetId) || [];
      grouped.set(sourceAssetId, [...prev, task]);
    });

    const draftItems: StoredOutputItem[] = Array.from(grouped.entries()).map(([sourceAssetId, tasks]) => {
      const sourceTitle = String(tasks[0]?.source_asset_title || sourceAssetId || '未命名主素材');
      const imageAssetIds = new Set<string>();
      const lines: string[] = [];
      tasks.forEach((task, index) => {
        const resultPayload = (task.result || {}) as { image_asset_ids?: unknown; response_text?: unknown; text?: unknown };
        const resultAssetIds = Array.isArray(resultPayload.image_asset_ids)
          ? (resultPayload.image_asset_ids || []).map((item) => String(item || '').trim()).filter(Boolean)
          : [];
        resultAssetIds.forEach((aid) => imageAssetIds.add(aid));
        const textResult = String(resultPayload.response_text || resultPayload.text || '').trim();
        lines.push(`任务${index + 1}: ${task.prompt_title || task.prompt_id} · ${task.recipe_name || task.recipe_id} · v${task.variant_index}`);
        if (resultAssetIds.length > 0) {
          lines.push(`产出素材ID: ${resultAssetIds.join(', ')}`);
        }
        if (textResult) {
          lines.push(`产出文本: ${textResult.slice(0, 300)}`);
        }
      });

      const resolvedAssets = Array.from(imageAssetIds)
        .map((aid) => localAssetMap.get(aid))
        .filter(Boolean) as StudioAsset[];
      const text = lines.join('\n');
      const hasAssets = resolvedAssets.length > 0;
      const hasText = Boolean(text.trim());
      const content: WorkflowNodeOutput = hasAssets
        ? { kind: hasText ? 'mixed' : 'image', text, assets: resolvedAssets }
        : { kind: 'text', text: text || '（无可展示文本）' };
      return {
        id: makeId('output'),
        run_id: batchRunSnapshot.id,
        node_id: `batch-source-${sourceAssetId}`,
        category: hasAssets ? (hasText ? 'mixed' : 'image') : 'text',
        title: `批运行结果 · ${sourceTitle} · ${new Date().toLocaleString()}`,
        content,
        created_at: nowIso(),
      };
    });

    const existingKeys = new Set(storedOutputs.map((item) => `${item.run_id}:${item.node_id}`));
    const deduped = draftItems.filter((item) => !existingKeys.has(`${item.run_id}:${item.node_id}`));
    if (deduped.length === 0) {
      showToast('info', '该批运行结果已保存，无新增分组');
      setStorageOpen(true);
      setStorageTab(0);
      return;
    }
    appendStoredOutputItems(deduped);
    showToast('success', `已保存 ${deduped.length} 个主素材分组到统一存储`);
    setStorageOpen(true);
    setStorageTab(0);
  }, [appendStoredOutputItems, batchRunSnapshot, localAssetMap, showToast, storedOutputs]);

  const executeWorkflow = useCallback(
    async (preserveReviewDecisions: boolean, branchRetry?: BranchRetryRequest) => {
      if (!preserveReviewDecisions) {
        reviewDecisionsRef.current = {};
      }

      if (nodes.length === 0) {
        showToast('warning', '请先创建节点');
        return;
      }

      const startNodes = nodes.filter((node) => node.type === 'start');
      if (startNodes.length === 0) {
        showToast('warning', '至少需要一个开始节点');
        return;
      }

      const endNodes = nodes.filter((node) => node.type === 'end');
      if (endNodes.length !== 1) {
        showToast('warning', endNodes.length === 0 ? '请添加一个结束节点' : '同一流程只允许一个结束节点');
        return;
      }

      const incomingIndex = buildIncomingIndex(edges);
      const outgoingIndex = buildOutgoingIndex(edges);
      const invalidStart = startNodes.find((node) => (incomingIndex.get(node.id)?.length || 0) > 0);
      if (invalidStart) {
        showToast('warning', `开始节点「${normalizeNodeLabel(invalidStart)}」不能有入边`);
        return;
      }
      const splitStart = startNodes.find((node) => (outgoingIndex.get(node.id)?.length || 0) > 1);
      if (splitStart) {
        showToast('warning', `开始节点「${normalizeNodeLabel(splitStart)}」只能连接一个下游`);
        return;
      }
      const endNode = endNodes[0];
      if ((outgoingIndex.get(endNode.id)?.length || 0) > 0) {
        showToast('warning', '结束节点不能有出边');
        return;
      }
      if ((incomingIndex.get(endNode.id)?.length || 0) !== 1) {
        showToast('warning', '结束节点必须且只能有一个上游输入，多分支请先走合并节点');
        return;
      }

      const reachable = new Set<string>();
      const queue = startNodes.map((node) => node.id);
      queue.forEach((id) => reachable.add(id));
      while (queue.length > 0) {
        const current = queue.shift() as string;
        (outgoingIndex.get(current) || []).forEach((next) => {
          if (reachable.has(next)) return;
          reachable.add(next);
          queue.push(next);
        });
      }
      if (!reachable.has(endNode.id)) {
        showToast('warning', '结束节点未与任一开始节点连通');
        return;
      }

      let orderedNodeIds: string[] = [];
      try {
        orderedNodeIds = sortNodesByTopo(nodes, edges);
      } catch (error) {
        showToast('error', (error as Error).message);
        return;
      }

      const workspaceId = await ensureExecutorWorkspaceId();
      const nodeMap = new Map(nodes.map((node) => [node.id, node]));
      const previousRun = run;
      const previousStepsByNode = new Map((previousRun?.steps || []).map((step) => [step.node_id, step]));

      let rerunScope: Set<string> | null = null;
      if (branchRetry) {
        rerunScope = computeBranchRetryScope(branchRetry.reviewNodeId, edges, branchRetry.sourceNodeId);
        if (!rerunScope.has(branchRetry.reviewNodeId)) {
          showToast('error', '分支重跑失败：找不到审核节点路径');
          return;
        }
      }

      const context: Record<string, WorkflowNodeOutput> = {};
      if (rerunScope) {
        previousStepsByNode.forEach((step, nodeId) => {
          if (rerunScope?.has(nodeId)) return;
          if (step.output) {
            context[nodeId] = step.output;
          }
        });
      }

      const runId = makeId('run');
      const createdAt = nowIso();
      const freshOutputs: StoredOutputItem[] = [];
      const draftRun: WorkflowRun = {
        id: runId,
        status: 'running',
        created_at: createdAt,
        updated_at: createdAt,
        steps: orderedNodeIds.map((nodeId) => {
          const node = nodeMap.get(nodeId);
          const base = {
            node_id: nodeId,
            node_label: node ? normalizeNodeLabel(node) : nodeId,
            node_type: ((node?.type as WorkflowNodeKind) || 'input') as WorkflowNodeKind,
            status: 'pending' as const,
            elapsed_seconds: 0,
          };
          if (!rerunScope || rerunScope.has(nodeId)) {
            return base;
          }
          const prev = previousStepsByNode.get(nodeId);
          if (prev?.output) {
            return {
              ...prev,
              status: 'completed' as const,
              error: undefined,
            };
          }
          return {
            ...base,
            status: 'skipped' as const,
          };
        }),
        outputs: rerunScope ? [...(previousRun?.outputs || [])] : [],
      };

      const syncRun = () => {
        setRun({
          ...draftRun,
          steps: [...draftRun.steps],
          outputs: [...draftRun.outputs],
        });
      };

      setPendingReview(null);
      setReviewEditText('');
      setReviewRetrySourceId('');
      setRun(draftRun);
      setRunning(true);

      try {
        const orderedIndexMap = new Map(orderedNodeIds.map((id, index) => [id, index]));
        const incomingByTarget = buildIncomingIndex(edges);
        const outgoingBySource = buildOutgoingIndex(edges);
        const activeNodeIds = orderedNodeIds.filter((nodeId) => !rerunScope || rerunScope.has(nodeId));
        const activeNodeSet = new Set(activeNodeIds);
        const remainingDeps = new Map<string, number>();
        activeNodeIds.forEach((nodeId) => {
          const deps = (incomingByTarget.get(nodeId) || []).filter((sourceId) => activeNodeSet.has(sourceId)).length;
          remainingDeps.set(nodeId, deps);
        });
        let readyNodeIds = activeNodeIds.filter((nodeId) => (remainingDeps.get(nodeId) || 0) === 0);

        type ExecuteNodeResult = {
          nodeId: string;
          node: FlowNode;
          nodeType: WorkflowNodeKind;
          nodeOutput: WorkflowNodeOutput;
          elapsedSeconds: number;
          pauseReview?: PendingReviewState;
        };

        const executeNode = async (nodeId: string): Promise<ExecuteNodeResult> => {
          const node = nodeMap.get(nodeId);
          if (!node) {
            throw new Error(`节点不存在：${nodeId}`);
          }
          const nodeType = ((node.type as WorkflowNodeKind) || 'input') as WorkflowNodeKind;
          const startedMs = Date.now();
          const upstreamOutputs = collectUpstreamOutputs(nodeId, edges, context);
          const upstreamText = collectUpstreamText(upstreamOutputs);
          const attachmentIds = collectAttachmentAssetIds(upstreamOutputs);

          let nodeOutput: WorkflowNodeOutput = { kind: 'none' };

          if (nodeType === 'start') {
            nodeOutput = { kind: 'none' };
          } else if (nodeType === 'input' || nodeType === 'transform') {
            const data = node.data as WorkflowInputNodeData | WorkflowTransformNodeData;
            const mode: StudioComposerMode = (data.mode as StudioComposerMode) || 'text';
            const model = String((data as WorkflowInputNodeData).model || (data as WorkflowTransformNodeData).model || '').trim();
            const rawPrompt =
              nodeType === 'transform'
                ? String((data as WorkflowTransformNodeData).prompt_template || '')
                : String((data as WorkflowInputNodeData).prompt || '');
            const withInput = rawPrompt.replace(/\{\{input\}\}/g, upstreamText);

            let prompt = resolvePromptMentions(withInput, context, mentionableNodeIds).trim();
            if (nodeType === 'input' && upstreamText && prompt && !rawPrompt.includes('{{input}}')) {
              prompt = `${upstreamText}\n\n${prompt}`;
            }
            if (!prompt && upstreamText) prompt = upstreamText;

            const localRefIds: string[] = [];
            const bridgeHintLines: string[] = [];
            if (nodeType === 'input') {
              ((data as WorkflowInputNodeData).references || []).forEach((ref) => {
                if (ref.source === 'local') {
                  localRefIds.push(ref.id);
                } else {
                  const bridgeAsset = bridgeAssetMap.get(ref.id);
                  if (!bridgeAsset) return;
                  const url = resolveAssetUrl(bridgeAsset.file_url || bridgeAsset.thumbnail_url || '');
                  if (!url) return;
                  bridgeHintLines.push(`${bridgeAsset.title || bridgeAsset.id}: ${url}`);
                }
              });
            }

            const finalAttachmentIds = Array.from(new Set([...attachmentIds, ...localRefIds]));
            if (bridgeHintLines.length > 0) {
              prompt = `${prompt}\n\n桥接参考素材：\n${bridgeHintLines.map((line) => `- ${line}`).join('\n')}`;
            }

            if (mode === 'text') {
              const text = await runTextModel(workspaceId, prompt, model || textModelOptions[0], finalAttachmentIds);
              nodeOutput = {
                kind: 'text',
                text,
              };
            } else {
              const imageData = node.data as WorkflowInputNodeData;
              const aspectRatio = String(imageData.aspect_ratio || IMAGE_DEFAULTS.aspect_ratio);
              const quality = String(imageData.quality || IMAGE_DEFAULTS.quality);
              const count = Number(imageData.count || IMAGE_DEFAULTS.count);

              const { text, assets } = await runImageModel(
                workspaceId,
                prompt,
                model || imageModelOptions[0]?.id || '',
                aspectRatio,
                quality,
                count,
                finalAttachmentIds,
              );

              nodeOutput = {
                kind: text ? 'mixed' : 'image',
                text: text || '',
                assets,
              };
            }
          } else if (nodeType === 'batch') {
            const payload = buildBatchRunPayload();
            if (!payload) {
              throw new Error('批量节点配置不完整，请先打开“批量编排器（子画布）”完成配置。');
            }
            payload.workspace_id = workspaceId;
            payload.name = `${normalizeNodeLabel(node)}-${new Date().toLocaleTimeString()}`;

            let latest: WorkflowRunSnapshot | null = null;
            setBatchBusy(true);
            try {
              latest = await workflowApi.createRun(payload);
              setBatchRunSnapshot(latest);
              setBatchPolling(latest.status === 'running');

              const waitStartedAt = Date.now();
              while (latest.status === 'running') {
                await new Promise((resolve) => window.setTimeout(resolve, 2000));
                latest = await workflowApi.getRun(latest.id);
                setBatchRunSnapshot(latest);
                if (Date.now() - waitStartedAt > 1000 * 60 * 20) {
                  throw new Error('批量节点执行超时（>20分钟），请检查任务规模或上游服务状态。');
                }
              }
            } finally {
              setBatchPolling(false);
              setBatchBusy(false);
            }
            if (!latest) {
              throw new Error('批量节点启动失败：未获取到运行快照');
            }

            if (latest.status === 'paused' || latest.status === 'failed') {
              const failedCount = Number(latest.summary?.failed || 0);
              throw new Error(`批量节点执行${latest.status === 'paused' ? '暂停' : '失败'}，失败任务 ${failedCount} 条。请在右侧“后端批运行（M2）”中重试后继续。`);
            }

            const completedTasks = (latest.tasks || []).filter((task) => task.status === 'completed');
            const resultAssetIds = Array.from(
              new Set(
                completedTasks.flatMap((task) => {
                  const resultPayload = (task.result || {}) as { image_asset_ids?: unknown };
                  if (!Array.isArray(resultPayload.image_asset_ids)) return [];
                  return (resultPayload.image_asset_ids || []).map((item) => String(item || '').trim()).filter(Boolean);
                }),
              ),
            );

            let assets: StudioAsset[] = [];
            if (resultAssetIds.length > 0) {
              const latestAssets = await workflowApi.listLocalAssets({ limit: 300, workspace_id: latest.workspace_id });
              const latestMap = new Map((latestAssets.items || []).map((item) => [item.id, item]));
              assets = resultAssetIds.map((id) => latestMap.get(id)).filter(Boolean) as StudioAsset[];
              if (Array.isArray(latestAssets.items)) {
                setLocalAssets(latestAssets.items);
              }
            }

            const completedCount = Number(latest.summary?.completed || completedTasks.length || 0);
            const totalCount = Number(latest.summary?.total || (latest.tasks || []).length || 0);
            const summaryText = `批量节点执行完成：${completedCount}/${totalCount}，run_id=${latest.id}`;
            nodeOutput = {
              kind: assets.length > 0 ? 'mixed' : 'text',
              text: summaryText,
              assets,
              value: {
                run_id: latest.id,
                total: totalCount,
                completed: completedCount,
                failed: Number(latest.summary?.failed || 0),
              },
            };
          } else if (nodeType === 'display') {
            const primary = upstreamOutputs[0];
            if (!primary) {
              nodeOutput = { kind: 'none', text: '显示节点没有可展示的上游输出' };
            } else {
              nodeOutput = primary;
            }
          } else if (nodeType === 'merge') {
            const mergeData = node.data as WorkflowMergeNodeData;
            if (mergeData.strategy === 'asset_collect') {
              const assets = upstreamOutputs.flatMap((item) => item.assets || []);
              nodeOutput = {
                kind: assets.length > 0 ? 'image' : 'none',
                assets,
                text: upstreamText,
              };
            } else {
              nodeOutput = {
                kind: 'text',
                text: upstreamText || '（上游无文本）',
              };
            }
          } else if (nodeType === 'review') {
            const reviewData = node.data as WorkflowReviewNodeData;
            const reviewInput = upstreamOutputs[0] || { kind: 'none', text: '审核节点没有上游输出' };
            const decision = reviewDecisionsRef.current[node.id];
            if (!decision) {
              const incomingSources = edges
                .filter((edge) => edge.target === node.id)
                .map((edge) => {
                  const sourceNode = nodeMap.get(edge.source);
                  return {
                    id: edge.source,
                    label: sourceNode ? normalizeNodeLabel(sourceNode) : edge.source,
                  };
                });
              return {
                nodeId,
                node,
                nodeType,
                nodeOutput: reviewInput,
                elapsedSeconds: Math.max(1, Math.floor((Date.now() - startedMs) / 1000)),
                pauseReview: {
                  node_id: node.id,
                  node_label: reviewData.label || NODE_TITLES.review,
                  output: reviewInput,
                  incoming_sources: incomingSources,
                },
              };
            }

            if (decision.action === 'edit') {
              const editedText = String(decision.editedText || '').trim();
              nodeOutput = {
                ...reviewInput,
                kind: reviewInput.assets && reviewInput.assets.length > 0 ? 'mixed' : 'text',
                text: editedText || outputToText(reviewInput),
              };
            } else {
              nodeOutput = reviewInput;
            }
          } else if (nodeType === 'save') {
            nodeOutput = upstreamOutputs[0] || { kind: 'none', text: '存储节点没有上游输出' };
          } else if (nodeType === 'end') {
            const assets = upstreamOutputs.flatMap((item) => item.assets || []);
            const text = collectUpstreamText(upstreamOutputs);
            if (assets.length > 0) {
              nodeOutput = {
                kind: text ? 'mixed' : 'image',
                assets,
                text,
              };
            } else if (text) {
              nodeOutput = {
                kind: 'text',
                text,
              };
            } else {
              nodeOutput = { kind: 'none', text: '结束节点没有上游输出' };
            }
          }

          return {
            nodeId,
            node,
            nodeType,
            nodeOutput,
            elapsedSeconds: Math.max(1, Math.floor((Date.now() - startedMs) / 1000)),
          };
        };

        const markStepRunning = (nodeId: string): void => {
          const stepIndex = stepIndexByNodeId(draftRun.steps, nodeId);
          if (stepIndex < 0) return;
          draftRun.steps[stepIndex] = {
            ...draftRun.steps[stepIndex],
            status: 'running',
            started_at: nowIso(),
            error: undefined,
          };
        };

        const finalizeCompletedNode = (result: ExecuteNodeResult): void => {
          const stepIndex = stepIndexByNodeId(draftRun.steps, result.nodeId);
          if (stepIndex < 0) return;
          context[result.nodeId] = result.nodeOutput;
          draftRun.steps[stepIndex] = {
            ...draftRun.steps[stepIndex],
            status: 'completed',
            finished_at: nowIso(),
            elapsed_seconds: result.elapsedSeconds,
            output: result.nodeOutput,
          };

          if (result.nodeType === 'save') {
            const saveCategory = String((result.node.data as { category?: unknown }).category || 'mixed') as
              | 'image'
              | 'text'
              | 'mixed';
            const outputItem: StoredOutputItem = {
              id: makeId('output'),
              run_id: runId,
              node_id: result.node.id,
              category: saveCategory,
              title: `${normalizeNodeLabel(result.node)} · ${new Date().toLocaleString()}`,
              content: result.nodeOutput,
              created_at: nowIso(),
            };
            draftRun.outputs.unshift(outputItem);
            freshOutputs.unshift(outputItem);
          }

          draftRun.updated_at = nowIso();
          syncRun();
        };

        const unlockDownstream = (nodeId: string): void => {
          (outgoingBySource.get(nodeId) || []).forEach((nextId) => {
            if (!activeNodeSet.has(nextId)) return;
            const left = (remainingDeps.get(nextId) || 0) - 1;
            remainingDeps.set(nextId, left);
            if (left === 0) {
              readyNodeIds.push(nextId);
            }
          });
        };

        while (readyNodeIds.length > 0) {
          const currentReady = [...readyNodeIds].sort((a, b) => (orderedIndexMap.get(a) || 0) - (orderedIndexMap.get(b) || 0));
          readyNodeIds = [];

          const reviewNodeIds: string[] = [];
          const normalNodeIds: string[] = [];
          currentReady.forEach((nodeId) => {
            const nodeType = ((nodeMap.get(nodeId)?.type as WorkflowNodeKind) || 'input') as WorkflowNodeKind;
            if (nodeType === 'review') {
              reviewNodeIds.push(nodeId);
            } else {
              normalNodeIds.push(nodeId);
            }
          });

          if (normalNodeIds.length > 0) {
            normalNodeIds.forEach((nodeId) => markStepRunning(nodeId));
            draftRun.updated_at = nowIso();
            syncRun();

            const settled = await Promise.allSettled(normalNodeIds.map((nodeId) => executeNode(nodeId)));
            const completedResults: ExecuteNodeResult[] = [];
            let batchError: Error | null = null;

            settled.forEach((item, index) => {
              const nodeId = normalNodeIds[index];
              if (item.status === 'fulfilled') {
                completedResults.push(item.value);
                return;
              }
              const message = item.reason instanceof Error ? item.reason.message : String(item.reason || '节点执行失败');
              const stepIndex = stepIndexByNodeId(draftRun.steps, nodeId);
              if (stepIndex >= 0) {
                draftRun.steps[stepIndex] = {
                  ...draftRun.steps[stepIndex],
                  status: 'failed',
                  finished_at: nowIso(),
                  error: message,
                };
              }
              if (!batchError) {
                const failedNode = nodeMap.get(nodeId);
                batchError = new Error(`${failedNode ? normalizeNodeLabel(failedNode) : nodeId} 执行失败：${message}`);
              }
            });

            completedResults.forEach((result) => {
              finalizeCompletedNode(result);
              unlockDownstream(result.nodeId);
            });

            if (batchError) {
              throw batchError;
            }
          }

          for (const nodeId of reviewNodeIds) {
            markStepRunning(nodeId);
            draftRun.updated_at = nowIso();
            syncRun();

            const result = await executeNode(nodeId);
            if (result.pauseReview) {
              const stepIndex = stepIndexByNodeId(draftRun.steps, nodeId);
              if (stepIndex >= 0) {
                draftRun.steps[stepIndex] = {
                  ...draftRun.steps[stepIndex],
                  status: 'paused',
                  finished_at: nowIso(),
                  elapsed_seconds: result.elapsedSeconds,
                  output: result.nodeOutput,
                };
              }
              draftRun.status = 'paused';
              draftRun.waiting_review_node_id = nodeId;
              draftRun.updated_at = nowIso();
              syncRun();

              setPendingReview(result.pauseReview);
              setReviewRetrySourceId(result.pauseReview.incoming_sources[0]?.id || '');
              setReviewEditText(outputToText(result.nodeOutput));
              setRunning(false);
              showToast('info', `流程在「${result.pauseReview.node_label || '审核节点'}」暂停，等待人工接管`);
              return;
            }

            finalizeCompletedNode(result);
            unlockDownstream(result.nodeId);
          }
        }

        draftRun.status = 'completed';
        draftRun.updated_at = nowIso();

        if (draftRun.outputs.length === 0) {
          const endStep = draftRun.steps.find((step) => step.node_id === endNode.id);
          const finalStep = endStep || draftRun.steps[draftRun.steps.length - 1];
          if (finalStep?.output) {
            const outputItem: StoredOutputItem = {
              id: makeId('output'),
              run_id: runId,
              node_id: finalStep.node_id,
              category: finalStep.output.kind === 'image' ? 'image' : finalStep.output.kind === 'text' ? 'text' : 'mixed',
              title: `流程终点输出 · ${new Date().toLocaleString()}`,
              content: finalStep.output,
              created_at: nowIso(),
            };
            draftRun.outputs.push(outputItem);
            freshOutputs.push(outputItem);
          }
        }

        syncRun();
        appendStoredOutputItems(freshOutputs);
        setRunning(false);
        showToast('success', '流程执行完成');
      } catch (error) {
        draftRun.status = 'failed';
        draftRun.updated_at = nowIso();

        const runningStep = draftRun.steps.find((step) => step.status === 'running');
        if (runningStep) {
          const idx = stepIndexByNodeId(draftRun.steps, runningStep.node_id);
          if (idx >= 0) {
            draftRun.steps[idx] = {
              ...draftRun.steps[idx],
              status: 'failed',
              finished_at: nowIso(),
              error: (error as Error).message,
            };
          }
        }

        syncRun();
        setRunning(false);
        showToast('error', `流程执行失败：${(error as Error).message}`);
      }
    },
    [
      appendStoredOutputItems,
      buildBatchRunPayload,
      bridgeAssetMap,
      edges,
      ensureExecutorWorkspaceId,
      imageModelOptions,
      mentionableNodeIds,
      nodes,
      run,
      showToast,
      textModelOptions,
    ],
  );

  const handleRunClick = useCallback(() => {
    void executeWorkflow(false);
  }, [executeWorkflow]);

  const handleReviewApprove = useCallback(() => {
    if (!pendingReview) return;
    reviewDecisionsRef.current[pendingReview.node_id] = { action: 'approve' };
    setPendingReview(null);
    setReviewEditText('');
    setReviewRetrySourceId('');
    void executeWorkflow(true);
  }, [executeWorkflow, pendingReview]);

  const handleReviewEdit = useCallback(() => {
    if (!pendingReview) return;
    reviewDecisionsRef.current[pendingReview.node_id] = {
      action: 'edit',
      editedText: reviewEditText,
    };
    setPendingReview(null);
    setReviewRetrySourceId('');
    void executeWorkflow(true);
  }, [executeWorkflow, pendingReview, reviewEditText]);

  const handleReviewRetry = useCallback(() => {
    reviewDecisionsRef.current = {};
    setPendingReview(null);
    setReviewEditText('');
    setReviewRetrySourceId('');
    void executeWorkflow(false);
  }, [executeWorkflow]);

  const handleReviewRetryBranch = useCallback(() => {
    if (!pendingReview) return;
    reviewDecisionsRef.current = {};
    setPendingReview(null);
    setReviewEditText('');
    setReviewRetrySourceId('');
    void executeWorkflow(false, {
      reviewNodeId: pendingReview.node_id,
      sourceNodeId: reviewRetrySourceId || undefined,
    });
  }, [executeWorkflow, pendingReview, reviewRetrySourceId]);

  const styledNodes = useMemo(() => {
    return nodes.map((node) => {
      const kind = (node.type as WorkflowNodeKind) || 'input';
      const visualType: Node['type'] = kind === 'start' ? 'input' : kind === 'end' ? 'output' : 'default';
      const isActive = selectedNodeId === node.id;
      return {
        ...node,
        type: visualType,
        style: {
          borderRadius: 12,
          border: isActive ? '2px solid #2d8cf0' : '1px solid #d0d7e2',
          background: NODE_COLORS[kind],
          minWidth: 180,
          boxShadow: isActive ? '0 0 0 3px rgba(45,140,240,0.12)' : '0 4px 10px rgba(12,27,51,0.06)',
          padding: 8,
        },
        data: {
          ...node.data,
          label: normalizeNodeLabel(node),
        },
      };
    });
  }, [nodes, selectedNodeId]);

  const selectedInputNodeData = selectedNode?.type === 'input' ? (selectedNode.data as WorkflowInputNodeData) : null;
  const selectedTransformNodeData = selectedNode?.type === 'transform' ? (selectedNode.data as WorkflowTransformNodeData) : null;
  const selectedReviewNodeData = selectedNode?.type === 'review' ? (selectedNode.data as WorkflowReviewNodeData) : null;

  const runStatusChipColor = run?.status === 'completed' ? 'success' : run?.status === 'failed' ? 'error' : run?.status === 'paused' ? 'warning' : 'info';

  return (
    <Box sx={{ height: '100vh', maxHeight: '100vh', display: 'flex', flexDirection: 'column', bgcolor: '#f4f6fb', overflow: 'hidden' }}>
      <Box
        sx={{
          px: { xs: 1.5, md: 2.5 },
          py: 1,
          borderBottom: '1px solid #e6eaf2',
          bgcolor: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          flexWrap: 'wrap',
        }}
      >
        <Stack direction="row" alignItems="center" spacing={1.2}>
          <Typography variant="h6" fontWeight={700}>
            画布流程模式
          </Typography>
          <Chip size="small" color={runStatusChipColor} label={`状态：${run?.status || 'idle'}`} />
          {running ? <Chip size="small" variant="outlined" label={`2s轮询中 ${Math.floor((Date.now() - pollStamp) / 1000)}s`} /> : null}
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
          <Button component={RouterLink} to="/" variant="outlined" size="small">
            返回原工作台
          </Button>
          <Button onClick={handleRunClick} variant="contained" size="small" disabled={running}>
            {running ? '运行中...' : '运行流程'}
          </Button>
          <Button onClick={saveAsTemplate} variant="outlined" size="small" disabled={templateBusy}>
            保存模板
          </Button>
          <Button onClick={() => setStorageOpen(true)} variant="outlined" size="small">
            打开统一存储
          </Button>
          <Button onClick={clearCanvas} variant="text" color="inherit" size="small" disabled={running}>
            清空画布
          </Button>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <Box
          sx={{
            width: { xs: 220, md: 260 },
            borderRight: '1px solid #e6eaf2',
            bgcolor: '#fff',
            p: 1.2,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            overflowY: 'scroll',
            overflowX: 'hidden',
            scrollbarGutter: 'stable',
            overscrollBehavior: 'contain',
            '&::-webkit-scrollbar': {
              width: 8,
            },
            '&::-webkit-scrollbar-track': {
              backgroundColor: '#f1f4f9',
            },
            '&::-webkit-scrollbar-thumb': {
              backgroundColor: '#c4ccda',
              borderRadius: 8,
            },
          }}
        >
          <Typography variant="subtitle2" fontWeight={700}>
            节点工具栏
          </Typography>
          <Stack spacing={0.8}>
            {(Object.keys(NODE_TITLES) as WorkflowNodeKind[]).map((kind) => (
              <Button key={kind} variant="outlined" size="small" onClick={() => addNode(kind)}>
                + {NODE_TITLES[kind]}
              </Button>
            ))}
          </Stack>

          <Divider sx={{ my: 1 }} />

          <Typography variant="subtitle2" fontWeight={700}>
            模板库
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="text" onClick={() => void refreshTemplates()} disabled={templateBusy}>
              刷新
            </Button>
            <Button
              size="small"
              variant="text"
              disabled={templateBusy || templates.length === 0}
              onClick={() => {
                const first = templates[0];
                if (first) {
                  void updateTemplateById(first);
                }
              }}
            >
              覆盖最近模板
            </Button>
          </Stack>

          <List dense sx={{ border: '1px solid #eef1f6', borderRadius: 1, maxHeight: 280, overflow: 'auto' }}>
            {templates.length === 0 ? (
              <ListItemText primary="暂无模板" sx={{ px: 1.5, py: 1 }} />
            ) : (
              templates.map((item) => (
                <Box key={item.id} sx={{ px: 0.8, py: 0.5 }}>
                  <ListItemButton
                    dense
                    onClick={() => loadTemplate(item)}
                    sx={{ borderRadius: 1, border: '1px solid #edf1f7', mb: 0.4 }}
                  >
                    <ListItemText
                      primary={item.name}
                      secondary={new Date(item.updated_at).toLocaleString()}
                      primaryTypographyProps={{ fontSize: 13, fontWeight: 600 }}
                      secondaryTypographyProps={{ fontSize: 11 }}
                    />
                  </ListItemButton>
                  <Stack direction="row" spacing={0.8} sx={{ px: 0.5 }}>
                    <Button size="small" onClick={() => void updateTemplateById(item)}>
                      更新
                    </Button>
                    <Button size="small" color="error" onClick={() => void deleteTemplateById(item)}>
                      删除
                    </Button>
                  </Stack>
                </Box>
              ))
            )}
          </List>

          <Divider sx={{ my: 1 }} />

          <Typography variant="subtitle2" fontWeight={700}>
            Bridge 配置（xhs-studio-unified）
          </Typography>
          <Stack spacing={1}>
            <TextField
              size="small"
              label="Bridge Base URL"
              value={bridgeConfig.base_url}
              onChange={(event) => setBridgeConfig((prev) => ({ ...prev, base_url: event.target.value }))}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={bridgeConfig.enabled}
                  onChange={(_event, checked) => setBridgeConfig((prev) => ({ ...prev, enabled: checked }))}
                />
              }
              label="启用 Bridge"
            />
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="outlined" onClick={() => void saveBridgeConfig()} disabled={bridgeSaving}>
                保存
              </Button>
              <Button size="small" onClick={() => void refreshAssets()}>
                拉取 Bridge 素材
              </Button>
            </Stack>
          </Stack>

          <Divider sx={{ my: 1 }} />

          <Typography variant="subtitle2" fontWeight={700}>
            批量运行（M2）
          </Typography>
          <Stack spacing={1}>
            <Alert severity="info" variant="outlined">
              批量配置已迁移到独立的“批量编排器（子画布）”，左侧仅保留摘要和入口，避免与普通节点配置混在一起。
            </Alert>
            <Button size="small" variant="contained" onClick={() => setBatchComposerOpen(true)}>
              打开批量编排器（子画布）
            </Button>
            <Box sx={{ border: '1px solid #eef1f6', borderRadius: 1, p: 0.9 }}>
              <Typography variant="caption" sx={{ display: 'block', fontWeight: 600 }}>
                当前摘要
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                主素材：{batchSelectedAssetIds.length} 个
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                指令模板：{batchPromptTemplates.filter((item) => item.enabled).length}/{batchPromptTemplates.length} 启用
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                任务卡片：{batchTaskCards.filter((item) => item.enabled).length}/{batchTaskCards.length} 启用
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                组合方式：{batchUseTaskCards ? '任务卡片一一配对' : batchModeHints[batchMode]}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                实时预演任务数：{localBatchTaskEstimate}
              </Typography>
              <Typography
                variant="caption"
                color={batchPreviewStale ? 'error.main' : batchPreviewReady ? 'success.main' : 'warning.main'}
                sx={{ display: 'block' }}
              >
                预估状态：{batchPreviewStale ? '配置已变更，请重新预估' : batchPreviewReady ? '已锁定，可运行' : '未锁定，请在编排器中先预估'}
              </Typography>
            </Box>
          </Stack>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <ReactFlow
            nodes={styledNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            fitView
            onSelectionChange={(params) => {
              const selected = params.nodes[0];
              setSelectedNodeId(selected?.id || null);
            }}
            onPaneClick={() => setSelectedNodeId(null)}
          >
            <MiniMap pannable zoomable />
            <Controls />
            <Background gap={24} size={1} color="#d5dbea" />
          </ReactFlow>
        </Box>

        <Box
          sx={{
            width: { xs: 280, md: 360 },
            borderLeft: '1px solid #e6eaf2',
            bgcolor: '#fff',
            p: 1.2,
            minHeight: 0,
            overflowY: 'scroll',
            overflowX: 'hidden',
            scrollbarGutter: 'stable',
            overscrollBehavior: 'contain',
            '&::-webkit-scrollbar': {
              width: 8,
            },
            '&::-webkit-scrollbar-track': {
              backgroundColor: '#f1f4f9',
            },
            '&::-webkit-scrollbar-thumb': {
              backgroundColor: '#c4ccda',
              borderRadius: 8,
            },
          }}
        >
          <Typography variant="subtitle2" fontWeight={700}>
            节点检查器
          </Typography>

          {!selectedNode ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              点击任意节点可编辑配置。
            </Typography>
          ) : (
            <Stack spacing={1.2} sx={{ mt: 1 }}>
              <TextField
                size="small"
                label="节点标题"
                value={String((selectedNode.data as { label?: unknown }).label || '')}
                onChange={(event) => {
                  const next = event.target.value;
                  patchSelectedNodeData((prev) => ({ ...prev, label: next }));
                }}
              />

              {selectedNode.type === 'start' ? (
                <Alert severity="info" variant="outlined">
                  开始节点仅用于触发流程，不执行模型调用。若要发起实际生成，请在后续“输入节点”中配置提示词与模型。
                </Alert>
              ) : null}

              {selectedNode.type === 'batch' ? (
                <Stack spacing={0.8}>
                  <Alert severity="info" variant="outlined">
                    批量节点会在运行到此处时，读取“批量编排器（子画布）”配置并触发后端批运行。执行完成后，产出会继续流向下游节点。
                  </Alert>
                  <Button variant="outlined" onClick={() => setBatchComposerOpen(true)}>
                    打开批量编排器
                  </Button>
                </Stack>
              ) : null}

              {selectedNode.type === 'input' ? (
                <>
                  <TextField
                    size="small"
                    label="提示词"
                    multiline
                    minRows={4}
                    value={selectedInputNodeData?.prompt || ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      patchSelectedNodeData((prev) => ({
                        ...(prev as WorkflowInputNodeData),
                        prompt: value,
                      }));
                    }}
                  />

                  <FormControl size="small">
                    <InputLabel>模型类型</InputLabel>
                    <Select
                      label="模型类型"
                      value={selectedInputNodeData?.mode || 'image'}
                      onChange={(event) => {
                        const mode = event.target.value as StudioComposerMode;
                        patchSelectedNodeData((prev) => ({
                          ...(prev as WorkflowInputNodeData),
                          mode,
                        }));
                      }}
                    >
                      <MenuItem value="image">生图模型</MenuItem>
                      <MenuItem value="text">文字模型</MenuItem>
                    </Select>
                  </FormControl>

                  <FormControl size="small">
                    <InputLabel>模型</InputLabel>
                    <Select
                      label="模型"
                      value={selectedInputNodeData?.model || ''}
                      onChange={(event) => {
                        const model = String(event.target.value || '');
                        patchSelectedNodeData((prev) => ({
                          ...(prev as WorkflowInputNodeData),
                          model,
                        }));
                      }}
                    >
                      {(selectedInputNodeData?.mode || 'image') === 'text'
                        ? textModelOptions.map((model) => (
                            <MenuItem key={model} value={model}>
                              {model}
                            </MenuItem>
                          ))
                        : imageModelOptions.map((model) => (
                            <MenuItem key={model.id} value={model.id}>
                              {model.name}
                            </MenuItem>
                          ))}
                    </Select>
                  </FormControl>

                  {(selectedInputNodeData?.mode || 'image') === 'image' ? (
                    <Stack direction="row" spacing={1}>
                      <FormControl size="small" sx={{ flex: 1 }}>
                        <InputLabel>比例</InputLabel>
                        <Select
                          label="比例"
                          value={selectedInputNodeData?.aspect_ratio || IMAGE_DEFAULTS.aspect_ratio}
                          onChange={(event) => {
                            const aspectRatio = String(event.target.value || IMAGE_DEFAULTS.aspect_ratio);
                            patchSelectedNodeData((prev) => ({
                              ...(prev as WorkflowInputNodeData),
                              aspect_ratio: aspectRatio,
                            }));
                          }}
                        >
                          {(options?.aspect_ratios || [IMAGE_DEFAULTS.aspect_ratio]).map((ratio) => (
                            <MenuItem key={ratio} value={ratio}>
                              {ratio}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>

                      <FormControl size="small" sx={{ flex: 1 }}>
                        <InputLabel>质量</InputLabel>
                        <Select
                          label="质量"
                          value={selectedInputNodeData?.quality || IMAGE_DEFAULTS.quality}
                          onChange={(event) => {
                            const quality = String(event.target.value || IMAGE_DEFAULTS.quality);
                            patchSelectedNodeData((prev) => ({
                              ...(prev as WorkflowInputNodeData),
                              quality,
                            }));
                          }}
                        >
                          {(options?.qualities || [IMAGE_DEFAULTS.quality]).map((quality) => (
                            <MenuItem key={quality} value={quality}>
                              {quality}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Stack>
                  ) : null}

                  <Typography variant="caption" color="text.secondary">
                    内容引用支持：{visibleMentionTokens.length > 0 ? visibleMentionTokens.join(' ') : '（暂无可引用节点）'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    输入节点可接上游也可接下游；若存在上游且未写 {'{{input}}'}，会自动拼接上游输出与当前提示词。
                  </Typography>
                  <Stack direction="row" spacing={0.6} sx={{ flexWrap: 'wrap', gap: 0.6 }}>
                    {visibleMentionTokens.map((token) => (
                      <Chip
                        key={`token-${token}`}
                        size="small"
                        label={token}
                        onClick={() => appendTokenToSelectedPrompt(token)}
                      />
                    ))}
                  </Stack>

                  <Divider />
                  <Typography variant="body2" fontWeight={600}>
                    参考素材（@xhs-studio-unified 打通）
                  </Typography>

                  <Stack direction="row" spacing={0.6} sx={{ flexWrap: 'wrap', gap: 0.6 }}>
                    {(selectedInputNodeData?.references || []).map((ref) => (
                      <Chip
                        key={`${ref.source}-${ref.id}`}
                        label={`${ref.source === 'bridge' ? '桥接' : '本地'}:${ref.title || ref.id}`}
                        size="small"
                        onDelete={() => {
                          patchSelectedNodeData((prev) => ({
                            ...(prev as WorkflowInputNodeData),
                            references: (prev as WorkflowInputNodeData).references.filter(
                              (item) => !(item.id === ref.id && item.source === ref.source),
                            ),
                          }));
                        }}
                      />
                    ))}
                  </Stack>

                  <Typography variant="caption" color="text.secondary">
                    点击下面素材可加入当前节点参考。
                  </Typography>

                  <Stack spacing={0.8} sx={{ maxHeight: 180, overflow: 'auto', border: '1px solid #eef1f6', borderRadius: 1, p: 0.8 }}>
                    <Typography variant="caption" fontWeight={600}>
                      本地素材
                    </Typography>
                    {localAssets.slice(0, 8).map((asset) => (
                      <Button
                        key={`local-${asset.id}`}
                        size="small"
                        variant="text"
                        sx={{ justifyContent: 'flex-start' }}
                        onClick={() => {
                          patchSelectedNodeData((prev) => {
                            const current = (prev as WorkflowInputNodeData).references || [];
                            if (current.some((item) => item.id === asset.id && item.source === 'local')) return prev;
                            return {
                              ...(prev as WorkflowInputNodeData),
                              references: [...current, { id: asset.id, source: 'local', title: asset.title }],
                            };
                          });
                        }}
                      >
                        {asset.title || asset.id}
                      </Button>
                    ))}

                    <Divider />
                    <Typography variant="caption" fontWeight={600}>
                      Bridge 素材
                    </Typography>
                    {bridgeAssets.slice(0, 8).map((asset) => (
                      <Button
                        key={`bridge-${asset.id}`}
                        size="small"
                        variant="text"
                        sx={{ justifyContent: 'flex-start' }}
                        onClick={() => {
                          patchSelectedNodeData((prev) => {
                            const current = (prev as WorkflowInputNodeData).references || [];
                            if (current.some((item) => item.id === asset.id && item.source === 'bridge')) return prev;
                            return {
                              ...(prev as WorkflowInputNodeData),
                              references: [...current, { id: asset.id, source: 'bridge', title: asset.title }],
                            };
                          });
                        }}
                      >
                        {asset.title || asset.id}
                      </Button>
                    ))}
                  </Stack>
                </>
              ) : null}

              {selectedNode.type === 'transform' ? (
                <>
                  <TextField
                    size="small"
                    label="转换提示词模板"
                    multiline
                    minRows={4}
                    value={selectedTransformNodeData?.prompt_template || ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      patchSelectedNodeData((prev) => ({
                        ...(prev as WorkflowTransformNodeData),
                        prompt_template: value,
                      }));
                    }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    支持变量 <code>{'{{input}}'}</code> 与 <code>@节点ID</code> 引用。
                  </Typography>
                  <Stack direction="row" spacing={0.6} sx={{ flexWrap: 'wrap', gap: 0.6 }}>
                    <Chip
                      size="small"
                      color="primary"
                      variant="outlined"
                      label="{{input}}"
                      onClick={() => appendTokenToSelectedPrompt('{{input}}')}
                    />
                    {visibleMentionTokens.map((token) => (
                      <Chip
                        key={`transform-token-${token}`}
                        size="small"
                        label={token}
                        onClick={() => appendTokenToSelectedPrompt(token)}
                      />
                    ))}
                  </Stack>
                  <FormControl size="small">
                    <InputLabel>输出模式</InputLabel>
                    <Select
                      label="输出模式"
                      value={selectedTransformNodeData?.mode || 'text'}
                      onChange={(event) => {
                        const mode = event.target.value as StudioComposerMode;
                        patchSelectedNodeData((prev) => ({
                          ...(prev as WorkflowTransformNodeData),
                          mode,
                        }));
                      }}
                    >
                      <MenuItem value="text">文字模型</MenuItem>
                      <MenuItem value="image">生图模型</MenuItem>
                    </Select>
                  </FormControl>
                </>
              ) : null}

              {selectedNode.type === 'review' ? (
                <TextField
                  size="small"
                  label="审核说明"
                  multiline
                  minRows={3}
                  value={selectedReviewNodeData?.instruction || ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    patchSelectedNodeData((prev) => ({
                      ...(prev as WorkflowReviewNodeData),
                      instruction: value,
                    }));
                  }}
                />
              ) : null}

              {selectedNode.type === 'merge' ? (
                <>
                  <FormControl size="small">
                    <InputLabel>合并策略</InputLabel>
                    <Select
                      label="合并策略"
                      value={String((selectedNode.data as WorkflowMergeNodeData).strategy || 'text_concat')}
                      onChange={(event) => {
                        const strategy = event.target.value as WorkflowMergeNodeData['strategy'];
                        patchSelectedNodeData((prev) => ({
                          ...(prev as WorkflowMergeNodeData),
                          strategy,
                        }));
                      }}
                    >
                      <MenuItem value="text_concat">文本拼接</MenuItem>
                      <MenuItem value="asset_collect">素材聚合</MenuItem>
                    </Select>
                  </FormControl>
                  <Typography variant="caption" color="text.secondary">
                    文本拼接：把所有上游文本按顺序合并为一段文本。素材聚合：汇总上游图片素材，并携带上游文本。
                  </Typography>
                </>
              ) : null}

              {selectedNode.type === 'save' ? (
                <FormControl size="small">
                  <InputLabel>存储分类</InputLabel>
                  <Select
                    label="存储分类"
                    value={String((selectedNode.data as { category?: string }).category || 'mixed')}
                    onChange={(event) => {
                      const category = event.target.value as 'image' | 'text' | 'mixed';
                      patchSelectedNodeData((prev) => ({
                        ...(prev as { label: string; category: 'image' | 'text' | 'mixed' }),
                        category,
                      }));
                    }}
                  >
                    <MenuItem value="image">图片</MenuItem>
                    <MenuItem value="text">文本</MenuItem>
                    <MenuItem value="mixed">混合</MenuItem>
                  </Select>
                </FormControl>
              ) : null}

              <Button color="error" onClick={removeSelectedNode}>
                删除当前节点
              </Button>
            </Stack>
          )}

          <Divider sx={{ my: 1.2 }} />

          <Typography variant="subtitle2" fontWeight={700}>
            运行可观测性
          </Typography>
          {!run ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              还没有运行记录。
            </Typography>
          ) : (
            <List dense sx={{ mt: 0.5, maxHeight: 340, overflow: 'auto' }}>
              {run.steps.map((step) => (
                <Box
                  key={`${run.id}-${step.node_id}`}
                  sx={{
                    px: 1,
                    py: 0.8,
                    border: '1px solid #edf1f7',
                    borderRadius: 1,
                    mb: 0.8,
                    bgcolor: '#fafcff',
                  }}
                >
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="body2" fontWeight={600}>
                      {step.node_label}
                    </Typography>
                    <Chip size="small" label={step.status} color={step.status === 'failed' ? 'error' : step.status === 'paused' ? 'warning' : step.status === 'completed' ? 'success' : 'info'} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {step.elapsed_seconds}s
                  </Typography>
                  <Box
                    sx={{
                      mt: 0.5,
                      p: 0.7,
                      borderRadius: 1,
                      border: '1px solid #edf1f7',
                      bgcolor: '#fff',
                      maxHeight: 96,
                      overflow: 'auto',
                    }}
                  >
                    <Typography variant="caption" sx={{ display: 'block', whiteSpace: 'pre-wrap' }} color="text.secondary">
                      {outputToText(step.output) || summarizeOutput(step.output)}
                    </Typography>
                  </Box>
                  {step.error ? (
                    <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.4 }}>
                      {step.error}
                    </Typography>
                  ) : null}
                </Box>
              ))}
            </List>
          )}

          <Divider sx={{ my: 1.2 }} />

          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="subtitle2" fontWeight={700}>
              后端批运行（M2）
            </Typography>
            <Stack direction="row" spacing={0.6}>
              <Button size="small" onClick={() => void refreshBatchRunSnapshot()} disabled={!batchRunSnapshot?.id || batchBusy}>
                刷新
              </Button>
              <Button size="small" onClick={handleSaveBatchRunOutputs} disabled={!batchRunSnapshot || batchBusy}>
                存储结果
              </Button>
              {batchRunSnapshot?.id ? (
                <Chip size="small" variant="outlined" label={batchRunSnapshot.status} color={batchRunSnapshot.status === 'completed' ? 'success' : batchRunSnapshot.status === 'paused' ? 'warning' : batchRunSnapshot.status === 'failed' ? 'error' : 'info'} />
              ) : null}
            </Stack>
          </Stack>

          {!batchRunSnapshot ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              暂无后端批运行记录。
            </Typography>
          ) : (
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                run_id: {batchRunSnapshot.id}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.8 }}>
                汇总：总计 {batchRunSnapshot.summary.total}，完成 {batchRunSnapshot.summary.completed}，运行中 {batchRunSnapshot.summary.running}，待处理 {batchRunSnapshot.summary.pending}，失败 {batchRunSnapshot.summary.failed}
              </Typography>

              <List dense sx={{ maxHeight: 260, overflow: 'auto' }}>
                {batchRunTaskGroups.map((group) => (
                  <Box key={`run-group-${group.source_asset_id}`} sx={{ mb: 0.8, border: '1px solid #edf1f7', borderRadius: 1, bgcolor: '#fcfdff' }}>
                    <Typography variant="caption" sx={{ px: 1, py: 0.6, display: 'block', fontWeight: 700, bgcolor: '#f9fbff', borderBottom: '1px solid #eef1f6' }}>
                      主素材：{group.source_asset_title}（{group.tasks.length} 条）
                    </Typography>
                    {group.tasks.map((task) => {
                      const taskResult = task.result || {};
                      const resultImageCount = Array.isArray((taskResult as { image_asset_ids?: unknown }).image_asset_ids)
                        ? ((taskResult as { image_asset_ids?: unknown[] }).image_asset_ids || []).length
                        : 0;
                      return (
                        <Box key={`${batchRunSnapshot.id}-${task.id}`} sx={{ px: 1, py: 0.8, borderBottom: '1px solid #eef1f6' }}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center">
                            <Typography variant="body2" fontWeight={600}>
                              {task.recipe_name} · v{task.variant_index}
                            </Typography>
                            <Chip
                              size="small"
                              label={task.status}
                              color={task.status === 'failed' ? 'error' : task.status === 'completed' ? 'success' : task.status === 'running' ? 'info' : 'default'}
                            />
                          </Stack>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            {task.elapsed_seconds}s · prompt={task.prompt_id}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', whiteSpace: 'pre-wrap' }}>
                            {task.effective_prompt.slice(0, 120)}
                          </Typography>
                          {Array.isArray(task.slot_assets) && task.slot_assets.length > 0 ? (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              槽位：
                              {task.slot_assets.map((slot) => `${slot.slot_name}=${slot.asset_title || slot.asset_id}`).join('，')}
                            </Typography>
                          ) : null}
                          {resultImageCount > 0 ? (
                            <Typography variant="caption" color="success.main" sx={{ display: 'block', mt: 0.4 }}>
                              产出图片：{resultImageCount} 张
                            </Typography>
                          ) : null}
                          {task.error ? (
                            <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.4 }}>
                              {task.error}
                            </Typography>
                          ) : null}
                          {task.status === 'failed' ? (
                            <Button
                              size="small"
                              variant="outlined"
                              sx={{ mt: 0.6 }}
                              onClick={() => void handleBatchRetryTask(task.id)}
                              disabled={batchBusy}
                            >
                              重试该任务
                            </Button>
                          ) : null}
                        </Box>
                      );
                    })}
                  </Box>
                ))}
              </List>
            </Box>
          )}
        </Box>
      </Box>

      <Dialog open={Boolean(pendingReview)} onClose={() => undefined} fullWidth maxWidth="md">
        <DialogTitle>人工审核节点</DialogTitle>
        <DialogContent>
          <Stack spacing={1.2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              当前节点：{pendingReview?.node_label || '-'}
            </Typography>
            <TextField
              multiline
              minRows={8}
              label="审核内容（可编辑）"
              value={reviewEditText}
              onChange={(event) => setReviewEditText(event.target.value)}
            />
            <FormControl size="small" disabled={!pendingReview || pendingReview.incoming_sources.length === 0}>
              <InputLabel>重跑分支</InputLabel>
              <Select
                label="重跑分支"
                value={reviewRetrySourceId}
                onChange={(event) => setReviewRetrySourceId(String(event.target.value || ''))}
              >
                {(pendingReview?.incoming_sources || []).map((source) => (
                  <MenuItem key={`retry-source-${source.id}`} value={source.id}>
                    {source.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="caption" color="text.secondary">
              通过：继续流程；编辑后通过：覆盖当前节点输出再继续；重跑上游分支：只重跑当前审核前的指定分支；全量重跑：从头执行。
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleReviewRetryBranch} disabled={!reviewRetrySourceId}>
            重跑上游分支
          </Button>
          <Button onClick={handleReviewRetry}>全量重跑</Button>
          <Button onClick={handleReviewApprove} variant="outlined">
            审核通过
          </Button>
          <Button onClick={handleReviewEdit} variant="contained">
            编辑后通过
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={storageOpen} onClose={() => setStorageOpen(false)} fullWidth maxWidth="lg">
        <DialogTitle>统一存储页</DialogTitle>
        <DialogContent>
          <Tabs value={storageTab} onChange={(_event, value) => setStorageTab(value)}>
            <Tab label="流程产出" />
            <Tab label="模板库" />
            <Tab label="素材库" />
          </Tabs>

          {storageTab === 0 ? (
            <Box sx={{ pt: 1.2 }}>
              {storedOutputs.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  暂无存储产出
                </Typography>
              ) : (
                <List dense>
                  {storedOutputs.map((item) => (
                    <Box key={item.id} sx={{ mb: 1, border: '1px solid #edf1f7', borderRadius: 1, p: 1 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography variant="body2" fontWeight={600}>
                          {item.title}
                        </Typography>
                        <Chip size="small" label={item.category} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {new Date(item.created_at).toLocaleString()} · run={item.run_id}
                      </Typography>
                      <Box
                        sx={{
                          mt: 0.8,
                          p: 0.8,
                          borderRadius: 1,
                          border: '1px solid #edf1f7',
                          bgcolor: '#fff',
                          maxHeight: 220,
                          overflow: 'auto',
                        }}
                      >
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                          {outputToText(item.content) || '（空）'}
                        </Typography>
                      </Box>
                    </Box>
                  ))}
                </List>
              )}
            </Box>
          ) : null}

          {storageTab === 1 ? (
            <Box sx={{ pt: 1.2 }}>
              {templates.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  暂无模板
                </Typography>
              ) : (
                <List dense>
                  {templates.map((item) => (
                    <Box key={item.id} sx={{ mb: 1, border: '1px solid #edf1f7', borderRadius: 1, p: 1 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography variant="body2" fontWeight={600}>
                          {item.name}
                        </Typography>
                        <Stack direction="row" spacing={0.8}>
                          <Button size="small" onClick={() => loadTemplate(item)}>
                            加载
                          </Button>
                          <Button size="small" color="error" onClick={() => void deleteTemplateById(item)}>
                            删除
                          </Button>
                        </Stack>
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {item.description || '无描述'}
                      </Typography>
                    </Box>
                  ))}
                </List>
              )}
            </Box>
          ) : null}

          {storageTab === 2 ? (
            <Box sx={{ pt: 1.2 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.8 }}>
                本地素材（{localAssets.length}）
              </Typography>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                {localAssets.slice(0, 24).map((asset) => (
                  <Chip key={`local-chip-${asset.id}`} size="small" label={asset.title || asset.id} />
                ))}
              </Stack>

              <Divider sx={{ my: 1.4 }} />

              <Typography variant="subtitle2" sx={{ mb: 0.8 }}>
                Bridge 素材（{bridgeAssets.length}）
              </Typography>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                {bridgeAssets.slice(0, 24).map((asset) => (
                  <Chip key={`bridge-chip-${asset.id}`} size="small" label={asset.title || asset.id} color="secondary" />
                ))}
              </Stack>
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setStoredOutputs([]);
              writeStoredOutputs([]);
            }}
            color="error"
          >
            清空本地产出
          </Button>
          <Button onClick={() => setStorageOpen(false)} variant="contained">
            关闭
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={batchComposerOpen}
        onClose={() => setBatchComposerOpen(false)}
        fullWidth
        maxWidth={false}
        PaperProps={{
          sx: {
            width: '92vw',
            height: '88vh',
            maxWidth: '92vw',
          },
        }}
      >
        <DialogTitle>批量编排器（子画布）</DialogTitle>
        <DialogContent sx={{ px: 0, py: 0, display: 'flex', minHeight: 0 }}>
          <Box
            sx={{
              width: 190,
              borderRight: '1px solid #e6eaf2',
              p: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 0.8,
            }}
          >
            {BATCH_COMPOSER_SECTION_META.map((item) => (
              <Button
                key={`composer-nav-${item.id}`}
                size="small"
                variant={batchComposerSection === item.id ? 'contained' : 'outlined'}
                onClick={() => setBatchComposerSection(item.id)}
              >
                {item.label}
              </Button>
            ))}
            <Divider sx={{ my: 0.6 }} />
            <Button size="small" variant="outlined" onClick={() => void handleBatchPreview()} disabled={batchBusy}>
              预估任务
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => void handleBatchRunStart()}
              disabled={batchBusy || batchPolling || !batchPreviewReady || (batchPreview?.total_tasks || 0) > (batchPreview?.limit || 0)}
            >
              {batchPolling ? '批运行中...' : '启动批运行'}
            </Button>
          </Box>

          <Box sx={{ flex: 1, minWidth: 0, borderRight: '1px solid #e6eaf2' }}>
            <ReactFlow
              nodes={batchComposerCanvasNodes}
              edges={batchComposerCanvasEdges}
              fitView
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              onNodeClick={(_event, node) => {
                const sectionId = String(node.id || '') as BatchComposerSection;
                if (BATCH_COMPOSER_SECTION_META.some((item) => item.id === sectionId)) {
                  setBatchComposerSection(sectionId);
                }
              }}
            >
              <MiniMap pannable zoomable />
              <Controls />
              <Background gap={20} size={1} color="#d8dfea" />
            </ReactFlow>
          </Box>

          <Box
            sx={{
              width: 520,
              minWidth: 520,
              p: 1.2,
              overflowY: 'auto',
            }}
          >
            {renderBatchComposerSection()}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBatchComposerOpen(false)} variant="contained">
            完成并关闭
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={batchAssetPickerOpen}
        onClose={closeBatchAssetPicker}
        fullWidth
        maxWidth="xl"
        PaperProps={{
          sx: {
            width: '88vw',
            maxWidth: '88vw',
            height: '78vh',
          },
        }}
      >
        <DialogTitle>主图素材库</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, minHeight: 0 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
            <Tabs
              value={batchAssetPickerTab}
              onChange={(_event, value) => setBatchAssetPickerTab(value as BatchAssetPickerTab)}
              sx={{ minHeight: 40 }}
            >
              {BATCH_ASSET_PICKER_TAB_META.map((tab) => (
                <Tab
                  key={`asset-picker-tab-${tab.id}`}
                  value={tab.id}
                  label={`${tab.label} (${batchAssetPickerTabCounts[tab.id] || 0})`}
                  sx={{ minHeight: 40 }}
                />
              ))}
            </Tabs>
            <Stack direction="row" spacing={0.8}>
              <input
                ref={batchAssetUploadInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(event) => void handleBatchAssetUpload(event)}
              />
              <Button size="small" variant="outlined" onClick={triggerBatchAssetUpload} disabled={batchAssetUploading}>
                {batchAssetUploading ? '上传中...' : '上传素材'}
              </Button>
              <Button size="small" variant="text" onClick={() => void refreshAssets()}>
                刷新
              </Button>
            </Stack>
          </Stack>

          <TextField
            size="small"
            placeholder="搜索素材标题 / ID / 标签"
            value={batchAssetPickerSearch}
            onChange={(event) => setBatchAssetPickerSearch(event.target.value)}
          />

          {batchAssetPickerTab === 'bridge' ? (
            <Alert severity="info" variant="outlined">
              Bridge 素材默认只读。可先点“入库到本地”，入库后会自动切回“上传”Tab并勾选。
            </Alert>
          ) : null}

          <Box sx={{ flex: 1, minHeight: 0, border: '1px solid #e9edf5', borderRadius: 1, p: 1, overflow: 'auto' }}>
            {batchAssetPickerVisibleAssets.length === 0 ? (
              <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 220 }}>
                <Typography variant="body2" color="text.secondary">
                  当前来源无素材
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  可切换 Tab、调整搜索，或直接上传素材。
                </Typography>
              </Stack>
            ) : (
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
                  gap: 1,
                }}
              >
                {batchAssetPickerVisibleAssets.map((asset) => {
                  const aid = String(asset.id || '');
                  const title = String(asset.title || aid || '未命名素材');
                  const thumb = resolveAssetUrl(String(asset.thumbnail_url || asset.file_url || ''));
                  const selected = batchAssetPickerDraftSet.has(aid);
                  const isBridge = batchAssetPickerTab === 'bridge';
                  return (
                    <Box
                      key={`asset-picker-card-${batchAssetPickerTab}-${aid}`}
                      onClick={() => {
                        if (isBridge) return;
                        toggleBatchAssetPickerDraft(aid);
                      }}
                      sx={{
                        border: selected ? '2px solid #2d8cf0' : '1px solid #e6eaf2',
                        borderRadius: 1.2,
                        p: 0.8,
                        bgcolor: selected ? '#edf6ff' : '#fff',
                        cursor: isBridge ? 'default' : 'pointer',
                      }}
                    >
                      <Box
                        sx={{
                          width: '100%',
                          height: 112,
                          borderRadius: 1,
                          overflow: 'hidden',
                          bgcolor: '#f5f7fc',
                          border: '1px solid #eef1f6',
                          mb: 0.7,
                        }}
                      >
                        {thumb ? (
                          <Box
                            component="img"
                            src={thumb}
                            alt={title}
                            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                        ) : (
                          <Stack sx={{ height: '100%' }} alignItems="center" justifyContent="center">
                            <Typography variant="caption" color="text.secondary">
                              无缩略图
                            </Typography>
                          </Stack>
                        )}
                      </Box>
                      <Typography
                        variant="caption"
                        sx={{
                          display: 'block',
                          lineHeight: 1.35,
                          minHeight: 34,
                          mb: 0.6,
                          wordBreak: 'break-all',
                        }}
                      >
                        {title}
                      </Typography>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={0.6}>
                        <Chip size="small" label={String(asset.kind || (isBridge ? 'bridge' : 'local'))} />
                        {isBridge ? (
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={(event) => {
                              event.stopPropagation();
                              void importBridgeAssetToLocal(asset);
                            }}
                            disabled={batchBridgeImportingId === aid}
                          >
                            {batchBridgeImportingId === aid ? '入库中' : '入库到本地'}
                          </Button>
                        ) : selected ? (
                          <Chip size="small" color="primary" label="已选中" />
                        ) : null}
                      </Stack>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeBatchAssetPicker}>取消</Button>
          <Button variant="contained" onClick={applyBatchAssetPickerSelection}>
            确认选择（{batchAssetPickerDraftIds.length}）
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={batchPromptPickerOpen}
        onClose={closeBatchPromptPicker}
        fullWidth
        maxWidth="lg"
        PaperProps={{
          sx: {
            width: '76vw',
            maxWidth: '76vw',
            height: '74vh',
          },
        }}
      >
        <DialogTitle>指令模板卡片库（全流程通用）</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, minHeight: 0 }}>
          <Tabs value={batchPromptPickerTab} onChange={(_event, value) => setBatchPromptPickerTab(value as BatchPromptPickerTab)}>
            {BATCH_PROMPT_PICKER_TAB_META.map((tab) => (
              <Tab key={`prompt-picker-tab-${tab.id}`} value={tab.id} label={tab.label} />
            ))}
          </Tabs>

          {batchPromptPickerTab === 'library' ? (
            <>
              <TextField
                size="small"
                placeholder="搜索卡片名称 / 内容关键词 / 标签"
                value={batchPromptPickerSearch}
                onChange={(event) => setBatchPromptPickerSearch(event.target.value)}
              />
              <Box sx={{ flex: 1, minHeight: 0, border: '1px solid #e9edf5', borderRadius: 1, p: 1, overflow: 'auto' }}>
                {batchPromptPickerVisibleCards.length === 0 ? (
                  <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 200 }}>
                    <Typography variant="body2" color="text.secondary">
                      卡片库暂无可选内容
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      你可以切到“新建卡片”创建后再加入流程。
                    </Typography>
                  </Stack>
                ) : (
                  <Stack spacing={0.8}>
                    {batchPromptPickerVisibleCards.map((card) => {
                      const selected = batchPromptPickerSelectedSet.has(card.id);
                      return (
                        <Box
                          key={`prompt-library-card-${card.id}`}
                          sx={{
                            border: selected ? '2px solid #2d8cf0' : '1px solid #e6eaf2',
                            borderRadius: 1,
                            p: 0.9,
                            bgcolor: selected ? '#edf6ff' : '#fff',
                          }}
                        >
                          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={0.8}>
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.4 }}>
                                {card.name}
                              </Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{
                                  display: 'block',
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                  maxHeight: 78,
                                  overflow: 'auto',
                                }}
                              >
                                {card.text}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.4 }}>
                                更新时间：{new Date(card.updated_at).toLocaleString()}
                              </Typography>
                            </Box>
                            <Stack spacing={0.6}>
                              <Button size="small" variant={selected ? 'contained' : 'outlined'} onClick={() => toggleBatchPromptPickerSelected(card.id)}>
                                {selected ? '已选中' : '选择'}
                              </Button>
                              <Button
                                size="small"
                                color="error"
                                variant="text"
                                onClick={() => void deleteBatchPromptCardFromLibrary(card.id)}
                                disabled={batchPromptDeletingId === card.id}
                              >
                                {batchPromptDeletingId === card.id ? '删除中...' : '移除卡片'}
                              </Button>
                            </Stack>
                          </Stack>
                        </Box>
                      );
                    })}
                  </Stack>
                )}
              </Box>
            </>
          ) : (
            <Stack spacing={1}>
              <Alert severity="info" variant="outlined">
                保存后的卡片将进入全局通用库，后续任意流程都可以直接复用。
              </Alert>
              <TextField
                size="small"
                label="卡片名称"
                placeholder="例如：沙发替换-现代风"
                value={batchPromptCreateName}
                onChange={(event) => setBatchPromptCreateName(event.target.value)}
              />
              <Typography variant="caption" color="text.secondary">
                指令内容
              </Typography>
              <WorkflowRichPromptEditor
                value={batchPromptCreateText}
                minRows={8}
                mentionOptions={slotMentionOptions}
                placeholder="例如：将沙发替换为 @替换对象，同时参考 @风格基准，保持空间构图不变。"
                onChange={(nextValue, caret, anchorEl) => {
                  setBatchPromptCreateText(nextValue);
                  onBatchMentionInputChange(nextValue, caret, { type: 'prompt_create' });
                  setBatchTemplateMentionAnchorEl(anchorEl);
                }}
                onCaretChange={(nextValue, caret, anchorEl) => {
                  onBatchMentionInputChange(nextValue, caret, { type: 'prompt_create' });
                  setBatchTemplateMentionAnchorEl(anchorEl);
                }}
                onMentionPreview={(item) => {
                  const url = resolveAssetUrl(String(item.previewUrl || item.thumbnailUrl || ''));
                  if (!url) return;
                  setBatchMentionPreview({ url, title: item.assetTitle || item.token });
                }}
              />
              <Typography variant="caption" color="text.secondary">
                {mentionHelpText}
              </Typography>
              <Menu
                open={batchTemplateMentionOpen && Boolean(batchTemplateMentionAnchorEl)}
                anchorEl={batchTemplateMentionAnchorEl}
                onClose={closeBatchTemplateMentionMenu}
                transformOrigin={{ vertical: 'top', horizontal: 'left' }}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                autoFocus={false}
                disableAutoFocusItem
                disableEnforceFocus
                disableRestoreFocus
                keepMounted
              >
                {filteredSlotMentionOptions.length === 0 ? (
                  <MenuItem disabled>无可用槽位</MenuItem>
                ) : (
                  filteredSlotMentionOptions.map((item) => (
                    <MenuItem
                      key={`prompt-picker-create-slot-mention-${item.token}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applyBatchTemplateMentionToken(item.token)}
                    >
                      <Stack direction="row" spacing={0.7} alignItems="center">
                        {item.thumbnailUrl ? (
                          <Box
                            component="img"
                            src={item.thumbnailUrl}
                            alt={item.assetTitle || item.token}
                            sx={{ width: 18, height: 18, borderRadius: 0.4, objectFit: 'cover', border: '1px solid #c7d5f1' }}
                          />
                        ) : null}
                        <Box component="span">{item.label || item.token}</Box>
                      </Stack>
                    </MenuItem>
                  ))
                )}
              </Menu>
              <Stack direction="row" spacing={0.8}>
                <Button
                  variant="outlined"
                  onClick={() => void saveBatchPromptCardToLibrary(false)}
                  disabled={batchPromptCreateSaving}
                >
                  {batchPromptCreateSaving ? '保存中...' : '仅保存到全局库'}
                </Button>
                <Button
                  variant="contained"
                  onClick={() => void saveBatchPromptCardToLibrary(true)}
                  disabled={batchPromptCreateSaving}
                >
                  {batchPromptCreateSaving ? '保存中...' : '保存并加入当前流程'}
                </Button>
              </Stack>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeBatchPromptPicker}>关闭</Button>
          {batchPromptPickerTab === 'library' ? (
            <Button variant="contained" onClick={applyBatchPromptPickerSelection}>
              加入流程（{batchPromptPickerSelectedIds.length}）
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(batchMentionPreview)}
        onClose={() => setBatchMentionPreview(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{batchMentionPreview?.title || '素材预览'}</DialogTitle>
        <DialogContent sx={{ pt: 1 }}>
          {batchMentionPreview?.url ? (
            <Box
              component="img"
              src={batchMentionPreview.url}
              alt={batchMentionPreview.title || 'mention-preview'}
              sx={{
                width: '100%',
                maxHeight: '70vh',
                objectFit: 'contain',
                borderRadius: 1,
                border: '1px solid #e5eaf2',
                bgcolor: '#f7f9fc',
              }}
            />
          ) : (
            <Alert severity="warning">未找到可预览图片</Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBatchMentionPreview(null)}>关闭</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={toast.open}
        autoHideDuration={2600}
        onClose={() => setToast((prev) => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity={toast.severity}
          variant="filled"
          onClose={() => setToast((prev) => ({ ...prev, open: false }))}
          sx={{ width: '100%' }}
        >
          {toast.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
