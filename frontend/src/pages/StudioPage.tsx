import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { studioApi, resolveAssetUrl } from '../api/client';
import { AnnotatorDialog, type AnnotationDraftContext } from '../components/AnnotatorDialog';
import { ApiSettingsDialog } from '../components/ApiSettingsDialog';
import {
  ChatThread,
  type ImageAction,
  type TextPromptImageSelectionPayload,
  type TextPromptOptionSelectionPayload,
} from '../components/ChatThread';
import { ComposerDock, type InsertAssetRequest } from '../components/ComposerDock';
import { ImageLightbox } from '../components/ImageLightbox';
import type { OfficialFilters } from '../components/ComposerDock';
import { WorkspaceSidebar } from '../components/WorkspaceSidebar';
import { useStudioStore } from '../store/useStudioStore';
import type {
  ComposerReference,
  GenerationParams,
  MentionSettings,
  MentionSourceItem,
  AnnotationContextPayload,
  RuntimeConfig,
  StudioAsset,
  StudioComposerMode,
  StudioMessage,
  StudioOptions,
  WorkspaceDetail,
  WorkspaceSummary,
} from '../types/studio';

const DEFAULT_PARAMS: GenerationParams = {
  model: '',
  aspect_ratio: '3:4',
  quality: '2K',
  count: 1,
};

const DEFAULT_FILTERS: OfficialFilters = {
  scene: '',
  style: '',
  material: '',
  lighting: '',
  search: '',
};
const WORKSPACE_PARAMS_STORAGE_KEY = 'studio_aligned_workspace_params_v1';

interface PendingTurn {
  id: string;
  workspaceId: string;
  mode: StudioComposerMode;
  text: string;
  params: GenerationParams;
  createdAt: string;
  startedAtMs: number | null;
  status: 'running';
}

interface ImageTurnRequest {
  text: string;
  params: GenerationParams;
  attachmentIds: string[];
  references: ComposerReference[];
  annotationPayloads: AnnotationContextPayload[];
}

const MAX_MATERIAL_UNITS = 9;
const OBJECT_LABELS: string[] = Array.from({ length: MAX_MATERIAL_UNITS }, (_, index) => `对象${index + 1}`);
const SYSTEM_OBJECT_LINE_REGEX = /^\s*(?:将)?【对象([1-9])】里的「([^」]*)」(?:移动到【对象([1-9])】)?(.*)$/;

interface ComposerAnnotationObject {
  id: string;
  shape_id: string;
  bbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
}

interface ComposerAnnotationContextState {
  mention_id: string;
  reference_slot: string;
  asset_id: string;
  objects: ComposerAnnotationObject[];
  move_relation: {
    source_id: string;
    target_id: string;
  } | null;
}

interface AnnotatorTargetState {
  asset: StudioAsset;
  reference: ComposerReference;
}

function dedupeAssets(list: StudioAsset[]): StudioAsset[] {
  const seen = new Set<string>();
  return list.filter((asset) => {
    if (seen.has(asset.id)) return false;
    seen.add(asset.id);
    return true;
  });
}

function buildDefaultParams(options: StudioOptions | null): GenerationParams {
  const models = options?.models || [];
  const aspectRatios = options?.aspect_ratios || [];
  const qualities = options?.qualities || [];
  const counts = options?.counts || [];
  return {
    model: models[0]?.id || DEFAULT_PARAMS.model,
    aspect_ratio: aspectRatios.includes('3:4') ? '3:4' : aspectRatios[0] || DEFAULT_PARAMS.aspect_ratio,
    quality: qualities.includes('2K') ? '2K' : qualities[0] || DEFAULT_PARAMS.quality,
    count: counts.includes(1) ? 1 : counts[0] || DEFAULT_PARAMS.count,
  };
}

function normalizeWorkspaceParams(raw: Partial<GenerationParams> | null | undefined, options: StudioOptions | null): GenerationParams {
  const defaults = buildDefaultParams(options);
  const models = (options?.models || []).map((item) => item.id);
  const aspectRatios = options?.aspect_ratios || [];
  const qualities = options?.qualities || [];
  const counts = options?.counts || [];

  const model = raw?.model && models.includes(raw.model) ? raw.model : defaults.model;
  const aspect_ratio = raw?.aspect_ratio && aspectRatios.includes(raw.aspect_ratio) ? raw.aspect_ratio : defaults.aspect_ratio;
  const quality = raw?.quality && qualities.includes(raw.quality) ? raw.quality : defaults.quality;
  const rawCount = Number(raw?.count);
  const count = Number.isFinite(rawCount) && counts.includes(rawCount) ? rawCount : defaults.count;

  return { model, aspect_ratio, quality, count };
}

function sameParams(a: GenerationParams, b: GenerationParams): boolean {
  return a.model === b.model && a.aspect_ratio === b.aspect_ratio && a.quality === b.quality && a.count === b.count;
}

function normalizeComposerMode(mode: unknown): StudioComposerMode {
  return mode === 'text' ? 'text' : 'image';
}

function readWorkspaceParamsMemory(): Record<string, Partial<GenerationParams>> {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_PARAMS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, Partial<GenerationParams>>;
  } catch {
    return {};
  }
}

function writeWorkspaceParamsMemory(memory: Record<string, Partial<GenerationParams>>): void {
  try {
    window.localStorage.setItem(WORKSPACE_PARAMS_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // 忽略本地存储写入异常
  }
}

function orderedReferencesFromText(text: string, references: ComposerReference[]): {
  ordered: ComposerReference[];
  missingSlots: string[];
} {
  const tokenSlots = extractOrderedSlots(text);

  const bySlot = new Map(references.map((ref) => [ref.slot, ref]));
  const ordered: ComposerReference[] = [];
  const missingSlots: string[] = [];
  tokenSlots.forEach((slot, index) => {
    const found = bySlot.get(slot);
    if (!found) {
      missingSlots.push(slot);
      return;
    }
    ordered.push({ ...found, order: index + 1 });
  });
  return { ordered, missingSlots };
}

function nextAvailableSlotFromReferences(references: ComposerReference[]): string | null {
  const used = new Set(references.map((item) => item.slot));
  for (let index = 1; index <= MAX_MATERIAL_UNITS; index += 1) {
    const slot = `图${index}`;
    if (!used.has(slot)) return slot;
  }
  return null;
}

async function blobToPng(blob: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      try {
        const width = image.naturalWidth || image.width || 1;
        const height = image.naturalHeight || image.height || 1;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error('画布上下文不可用'));
          return;
        }
        ctx.drawImage(image, 0, 0, width, height);
        canvas.toBlob((output) => {
          URL.revokeObjectURL(url);
          if (!output) {
            reject(new Error('PNG 转换失败'));
            return;
          }
          resolve(output);
        }, 'image/png');
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片加载失败，无法复制'));
    };
    image.src = url;
  });
}

async function copyAssetImage(asset: StudioAsset): Promise<'image' | 'text'> {
  const source = resolveAssetUrl(asset.file_url || asset.thumbnail_url);
  if (!source) throw new Error('图片地址不存在');
  const ClipboardItemCtor = (window as Window & { ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem })
    .ClipboardItem;

  if (navigator.clipboard?.write && ClipboardItemCtor) {
    try {
      const response = await fetch(source, { credentials: 'include' });
      if (response.ok) {
        const blob = await response.blob();
        let copyBlob = blob;
        if (copyBlob.type !== 'image/png') {
          copyBlob = await blobToPng(copyBlob);
        }
        await navigator.clipboard.write([new ClipboardItemCtor({ [copyBlob.type || 'image/png']: copyBlob })]);
        return 'image';
      }
    } catch {
      // 继续降级到文本复制
    }
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(source);
      return 'text';
    } catch {
      // 继续降级
    }
  }

  // 兼容旧浏览器的文本复制降级
  try {
    const input = document.createElement('textarea');
    input.value = source;
    input.setAttribute('readonly', 'true');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(input);
    if (ok) return 'text';
  } catch {
    // ignore
  }

  throw new Error('复制失败：浏览器权限或系统策略阻止了复制');
}

async function downloadAssetImage(asset: StudioAsset): Promise<{ saved_path: string; file_name: string }> {
  if (!asset.id) {
    throw new Error('素材 ID 不存在');
  }
  return studioApi.downloadAssetToLocal(asset.id);
}

function summaryFromDetail(detail: {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}): WorkspaceSummary {
  return {
    id: detail.id,
    name: detail.name,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
  };
}

function parseSystemObjectLines(
  text: string,
): Map<string, { content: string; target?: string; suffix?: string; lineIndex: number }> {
  const map = new Map<string, { content: string; target?: string; suffix?: string; lineIndex: number }>();
  const lines = text.split('\n');
  lines.forEach((line, lineIndex) => {
    const matched = line.match(SYSTEM_OBJECT_LINE_REGEX);
    if (!matched) return;
    const objectLabel = `对象${matched[1]}`;
    if (map.has(objectLabel)) return;
    const targetLabel = matched[3] ? `对象${matched[3]}` : undefined;
    const suffix = matched[4] ?? '';
    map.set(objectLabel, {
      content: matched[2] ?? '',
      target: targetLabel,
      suffix,
      lineIndex,
    });
  });
  return map;
}

function extractOrderedSlots(text: string): string[] {
  const tokenMatches = text.match(/@图[1-9]/g) || [];
  const tokenSlots: string[] = [];
  tokenMatches.forEach((token) => {
    const slot = token.slice(1);
    if (!tokenSlots.includes(slot)) {
      tokenSlots.push(slot);
    }
  });
  return tokenSlots;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureSlotTokenExists(text: string, slot: string): string {
  if (!slot) return text;
  const pattern = new RegExp(`@${escapeRegExp(slot)}(?=\\s|$)`);
  if (pattern.test(text)) return text;
  const trimmed = text.trim();
  if (!trimmed) return `@${slot}`;
  return `${trimmed} @${slot}`;
}

function stripSystemObjectLines(text: string): string {
  const kept = text
    .split('\n')
    .filter((line) => !SYSTEM_OBJECT_LINE_REGEX.test(line.trim()));
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') {
    kept.pop();
  }
  return kept.join('\n');
}

function buildSystemObjectLine(label: string, content: string, targetLabel?: string, suffix = ''): string {
  const normalized = content.trim() || '请填写';
  const core = targetLabel
    ? `【${label}】里的「${normalized}」移动到【${targetLabel}】`
    : `【${label}】里的「${normalized}」`;
  return `${core}${suffix || ''}`;
}

function normalizeSystemObjectSuffix(suffix: string): string {
  if (!suffix) return '';
  let normalized = String(suffix);
  normalized = normalized.replace(/(?:\s*(?:将)?【对象[1-9]】里的「[^」]*」(?:移动到【对象[1-9]】)?)/g, '');
  normalized = normalized.replace(/[ \t]{2,}/g, ' ');
  normalized = normalized.replace(/\s+$/g, '');
  return normalized;
}

function mergeComposerTextWithAnnotations(
  text: string,
  contexts: ComposerAnnotationContextState[],
): string {
  const existing = parseSystemObjectLines(text);
  if (contexts.length === 0) return stripSystemObjectLines(text).trim();

  const contextDefs = contexts
    .map((context) => {
      const sortedObjects = [...context.objects].sort(
        (a, b) => Number(a.id.replace('对象', '')) - Number(b.id.replace('对象', '')),
      );
      const objectIds = sortedObjects.map((item) => item.id);
      const objectLines = new Map<string, string>();
      sortedObjects.forEach((item) => {
        const existingItem = existing.get(item.id);
        const content = existingItem?.content ?? '请填写';
        const suffix = normalizeSystemObjectSuffix(existingItem?.suffix || '');
        const targetLabel =
          context.move_relation && context.move_relation.source_id === item.id
            ? context.move_relation.target_id
            : undefined;
        objectLines.set(item.id, buildSystemObjectLine(item.id, content, targetLabel, suffix));
      });
      const firstObjectOrder = Number((objectIds[0] || '').replace('对象', '')) || 999;
      return {
        slot: String(context.reference_slot || '').trim(),
        objectIds,
        objectLines,
        firstObjectOrder,
      };
    })
    .filter((item) => item.objectIds.length > 0)
    .sort((a, b) => a.firstObjectOrder - b.firstObjectOrder);

  const emittedObjectIds = new Set<string>();
  const outputLines: string[] = [];
  const outputLineIndexByObjectId = new Map<string, number>();
  const rawLines = text.split('\n');

  rawLines.forEach((rawLine) => {
    let line = rawLine;
    let lineObjectId: string | null = null;
    const matched = rawLine.match(SYSTEM_OBJECT_LINE_REGEX);
    if (matched) {
      const objectId = `对象${matched[1]}`;
      if (emittedObjectIds.has(objectId)) {
        // 重复对象行只保留尾部非对象文本，避免旧残留导致重复。
        line = normalizeSystemObjectSuffix(matched[4] || '');
      } else {
        let replacementLine = '';
        for (const def of contextDefs) {
          const candidate = def.objectLines.get(objectId);
          if (!candidate) continue;
          replacementLine = candidate;
          break;
        }
        if (replacementLine) {
          line = replacementLine;
          lineObjectId = objectId;
          emittedObjectIds.add(objectId);
        } else {
          line = normalizeSystemObjectSuffix(matched[4] || '');
        }
      }
    }

    const pendingInsertedBlocks: Array<{ objectIds: string[]; objectLines: string[] }> = [];
    contextDefs.forEach((def) => {
      if (!def.slot) return;
      if (def.objectIds.every((id) => emittedObjectIds.has(id))) return;
      const slotPattern = new RegExp(`@${escapeRegExp(def.slot)}(?=\\s|$)`);
      if (!slotPattern.test(line)) return;
      line = line.replace(slotPattern, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+$/g, '');
      const insertedIds: string[] = [];
      const insertedLines: string[] = [];
      def.objectIds.forEach((id) => {
        if (emittedObjectIds.has(id)) return;
        const objectLine = def.objectLines.get(id);
        if (!objectLine) return;
        insertedIds.push(id);
        insertedLines.push(objectLine);
        emittedObjectIds.add(id);
      });
      if (insertedLines.length > 0) {
        pendingInsertedBlocks.push({ objectIds: insertedIds, objectLines: insertedLines });
      }
    });

    if (line.trim().length > 0 || rawLine.trim().length === 0) {
      outputLines.push(line);
      if (lineObjectId) {
        outputLineIndexByObjectId.set(lineObjectId, outputLines.length - 1);
      }
    }

    pendingInsertedBlocks.forEach((entry) => {
      entry.objectLines.forEach((objectLine, idx) => {
        outputLines.push(objectLine);
        const objectId = entry.objectIds[idx];
        if (objectId) {
          outputLineIndexByObjectId.set(objectId, outputLines.length - 1);
        }
      });
    });
  });

  const anchoredInsertions: Array<{ index: number; lines: string[] }> = [];
  const tailAppendLines: string[] = [];
  contextDefs.forEach((def) => {
    const remainingIds = def.objectIds.filter((id) => !emittedObjectIds.has(id));
    if (remainingIds.length === 0) return;
    const remainingLines = remainingIds
      .map((id) => def.objectLines.get(id) || '')
      .filter(Boolean)
      .map((line) => String(line));
    if (remainingLines.length === 0) return;
    let anchorIndex = -1;
    def.objectIds.forEach((id) => {
      if (!emittedObjectIds.has(id)) return;
      const found = outputLineIndexByObjectId.get(id);
      if (typeof found === 'number') {
        anchorIndex = Math.max(anchorIndex, found);
      }
    });
    if (anchorIndex >= 0) {
      anchoredInsertions.push({ index: anchorIndex, lines: remainingLines });
    } else {
      tailAppendLines.push(...remainingLines);
    }
    remainingIds.forEach((id) => emittedObjectIds.add(id));
  });

  let insertedCount = 0;
  anchoredInsertions
    .sort((a, b) => a.index - b.index)
    .forEach((entry) => {
      const insertionIndex = entry.index + 1 + insertedCount;
      outputLines.splice(insertionIndex, 0, ...entry.lines);
      insertedCount += entry.lines.length;
    });

  if (tailAppendLines.length > 0) {
    outputLines.push(...tailAppendLines);
  }

  return outputLines.join('\n').trim();
}

function parseAnnotationTextsByObject(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = parseSystemObjectLines(text);
  lines.forEach((value, key) => {
    map.set(key, value.content.trim());
  });
  return map;
}

function isObjectDescriptionFilled(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed !== '请填写';
}

function moveRelationToPayload(
  relation: ComposerAnnotationContextState['move_relation'],
): AnnotationContextPayload['move_relation'] {
  if (!relation) return null;
  return {
    source_id: relation.source_id,
    target_id: relation.target_id,
  };
}

export function StudioPage() {
  const {
    options,
    sessions,
    currentWorkspace,
    setOptions,
    setSessions,
    setCurrentWorkspace,
    appendTurn,
    patchAssetInWorkspace,
  } = useStudioStore();

  const [initializing, setInitializing] = useState(true);
  const [officialLoading, setOfficialLoading] = useState(false);

  const [params, setParams] = useState<GenerationParams>(DEFAULT_PARAMS);
  const [composerMode, setComposerMode] = useState<StudioComposerMode>('image');
  const [textPromptPackEnabled, setTextPromptPackEnabled] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [composerReferences, setComposerReferences] = useState<ComposerReference[]>([]);
  const [savedAssets, setSavedAssets] = useState<StudioAsset[]>([]);
  const [workspaceUploadAssets, setWorkspaceUploadAssets] = useState<StudioAsset[]>([]);
  const [insertAssetRequest, setInsertAssetRequest] = useState<InsertAssetRequest | null>(null);

  const [officialAssets, setOfficialAssets] = useState<StudioAsset[]>([]);
  const [officialHasMore, setOfficialHasMore] = useState(false);
  const [officialFilters, setOfficialFilters] = useState<OfficialFilters>(DEFAULT_FILTERS);
  const officialCursorRef = useRef<string | null>(null);

  const [lightboxAsset, setLightboxAsset] = useState<StudioAsset | null>(null);
  const [annotatorTarget, setAnnotatorTarget] = useState<AnnotatorTargetState | null>(null);
  const [annotationContextsByMention, setAnnotationContextsByMention] = useState<Record<string, ComposerAnnotationContextState>>({});
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [mentionSettings, setMentionSettings] = useState<MentionSettings | null>(null);
  const [mentionSaving, setMentionSaving] = useState(false);
  const [pendingTurnsByWorkspace, setPendingTurnsByWorkspace] = useState<Record<string, PendingTurn[]>>({});
  const [textStreamingCountByWorkspace, setTextStreamingCountByWorkspace] = useState<Record<string, number>>({});
  const [progressNowMs, setProgressNowMs] = useState<number>(() => Date.now());
  const currentWorkspaceIdRef = useRef<string | null>(null);
  const currentWorkspaceRef = useRef<WorkspaceDetail | null>(null);
  const objectNameMapRef = useRef<Record<string, Record<string, string>>>({});

  const [toast, setToast] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  function showToast(message: string, severity: 'success' | 'error' = 'success') {
    setToast({ open: true, message, severity });
  }

  const adjustWorkspaceTextStreamingCount = useCallback((workspaceId: string, delta: number) => {
    if (!workspaceId) return;
    setTextStreamingCountByWorkspace((prev) => {
      const current = Number(prev[workspaceId] || 0);
      const nextCount = Math.max(0, current + delta);
      if (nextCount === current) return prev;
      const next = { ...prev };
      if (nextCount <= 0) {
        delete next[workspaceId];
      } else {
        next[workspaceId] = nextCount;
      }
      return next;
    });
  }, []);

  const patchWorkspaceIfCurrent = useCallback(
    (workspaceId: string, updater: (workspace: WorkspaceDetail) => WorkspaceDetail) => {
      const existing = currentWorkspaceRef.current;
      if (!existing || existing.id !== workspaceId) return;
      const next = updater(existing);
      currentWorkspaceRef.current = next;
      setCurrentWorkspace(next);
    },
    [setCurrentWorkspace],
  );

  const refreshSessions = useCallback(async (): Promise<WorkspaceSummary[]> => {
    const list = await studioApi.listWorkspaces();
    setSessions(list);
    return list;
  }, [setSessions]);

  const loadWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    const workspace = await studioApi.getWorkspace(workspaceId);
    setCurrentWorkspace(workspace);
  }, [setCurrentWorkspace]);

  const loadSavedAssets = useCallback(async (): Promise<void> => {
    const result = await studioApi.listAssetLibrary({ limit: 160 });
    setSavedAssets(result.items);
  }, []);
  const loadWorkspaceUploadAssets = useCallback(async (workspaceId?: string | null): Promise<void> => {
    const normalizedWorkspaceId = String(workspaceId || '').trim();
    if (!normalizedWorkspaceId) {
      setWorkspaceUploadAssets([]);
      return;
    }
    const result = await studioApi.listAssetLibrary({
      limit: 160,
      kind: 'upload',
      workspace_id: normalizedWorkspaceId,
    });
    setWorkspaceUploadAssets(result.items);
  }, []);
  const refreshDynamicSourceAssets = useCallback(async (): Promise<void> => {
    await Promise.all([
      loadSavedAssets(),
      loadWorkspaceUploadAssets(currentWorkspaceIdRef.current),
    ]);
  }, [loadSavedAssets, loadWorkspaceUploadAssets]);

  const loadOfficialAssets = useCallback(async (reset: boolean, filters: OfficialFilters): Promise<void> => {
    setOfficialLoading(true);
    try {
      const page = await studioApi.pageOfficialAssets({
        cursor: reset ? null : officialCursorRef.current,
        limit: 24,
        scene: filters.scene || undefined,
        style: filters.style || undefined,
        material: filters.material || undefined,
        lighting: filters.lighting || undefined,
        search: filters.search.trim() || undefined,
      });
      officialCursorRef.current = page.next_cursor;
      setOfficialHasMore(page.has_more);
      setOfficialAssets((prev) => (reset ? page.items : prev.concat(page.items)));
    } finally {
      setOfficialLoading(false);
    }
  }, []);

  const refreshOfficialMetaAndFirstPage = useCallback(async (): Promise<void> => {
    await loadOfficialAssets(true, officialFilters);
  }, [loadOfficialAssets, officialFilters]);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const [loadedOptions, loadedSessions, saved, loadedRuntimeConfig, loadedMentionSettings] = await Promise.all([
          studioApi.getOptions(),
          studioApi.listWorkspaces(),
          studioApi.listAssetLibrary({ limit: 160 }),
          studioApi.getRuntimeConfig(),
          studioApi.getMentionSettings(),
        ]);
        if (cancelled) return;

        setOptions(loadedOptions);
        setParams(buildDefaultParams(loadedOptions));

        let actualSessions = loadedSessions;
        if (actualSessions.length === 0) {
          const created = await studioApi.createWorkspace('室内设计会话');
          actualSessions = [summaryFromDetail(created)];
        }
        if (cancelled) return;

        setSessions(actualSessions);
        if (actualSessions.length > 0) {
          await loadWorkspace(actualSessions[0].id);
        }

        setMentionSettings(loadedMentionSettings);
        setSavedAssets(saved.items);
        setRuntimeConfig(loadedRuntimeConfig);
        await loadOfficialAssets(true, DEFAULT_FILTERS);
      } catch (error) {
        const message = error instanceof Error ? error.message : '初始化失败';
        showToast(message, 'error');
      } finally {
        if (!cancelled) setInitializing(false);
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [loadOfficialAssets, loadWorkspace, setOptions, setSessions]);

  useEffect(() => {
    if (initializing) return;
    const timer = window.setTimeout(() => {
      void loadOfficialAssets(true, officialFilters).catch((error) => {
        const message = error instanceof Error ? error.message : '加载官方素材失败';
        showToast(message, 'error');
      });
    }, 320);
    return () => window.clearTimeout(timer);
  }, [initializing, loadOfficialAssets, officialFilters]);

  useEffect(() => {
    currentWorkspaceIdRef.current = currentWorkspace?.id ?? null;
    currentWorkspaceRef.current = currentWorkspace ?? null;
    if (!currentWorkspace?.id) {
      setComposerMode('image');
      return;
    }
    setComposerMode(normalizeComposerMode(currentWorkspace.composer_mode));
  }, [currentWorkspace]);
  useEffect(() => {
    if (!options || !currentWorkspace?.id) return;
    const memory = readWorkspaceParamsMemory();
    const stored = memory[currentWorkspace.id];
    const next = normalizeWorkspaceParams(stored, options);
    setParams((prev) => {
      const normalizedPrev = normalizeWorkspaceParams(prev, options);
      return sameParams(normalizedPrev, next) ? normalizedPrev : next;
    });
  }, [currentWorkspace?.id, options]);
  useEffect(() => {
    if (!options || !currentWorkspace?.id) return;
    const normalized = normalizeWorkspaceParams(params, options);
    if (!sameParams(params, normalized)) {
      setParams(normalized);
      return;
    }
    const memory = readWorkspaceParamsMemory();
    const existing = normalizeWorkspaceParams(memory[currentWorkspace.id], options);
    if (sameParams(existing, normalized)) return;
    memory[currentWorkspace.id] = normalized;
    writeWorkspaceParamsMemory(memory);
  }, [currentWorkspace?.id, options, params]);
  useEffect(() => {
    void loadWorkspaceUploadAssets(currentWorkspace?.id).catch((error) => {
      const message = error instanceof Error ? error.message : '加载当前会话上传素材失败';
      showToast(message, 'error');
    });
  }, [currentWorkspace?.id, loadWorkspaceUploadAssets]);

  const totalPendingTurns = useMemo(
    () => Object.values(pendingTurnsByWorkspace).reduce((sum, list) => sum + list.length, 0),
    [pendingTurnsByWorkspace],
  );

  useEffect(() => {
    if (totalPendingTurns <= 0) return;
    const timer = window.setInterval(() => {
      setProgressNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [totalPendingTurns]);
  const isCurrentWorkspaceTextStreaming = useMemo(() => {
    if (!currentWorkspace?.id) return false;
    return Number(textStreamingCountByWorkspace[currentWorkspace.id] || 0) > 0;
  }, [currentWorkspace?.id, textStreamingCountByWorkspace]);
  const hasPersistedRunningMessage = useMemo(() => {
    if (!currentWorkspace) return false;
    return currentWorkspace.messages.some(
      (message) => message.role === 'assistant' && message.status === 'running',
    );
  }, [currentWorkspace]);
  useEffect(() => {
    if (!currentWorkspace?.id || !hasPersistedRunningMessage || isCurrentWorkspaceTextStreaming) return;
    let disposed = false;
    let inFlight = false;

    const tick = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        await loadWorkspace(currentWorkspace.id);
        await refreshSessions();
      } catch {
        // 轮询失败时静默，避免打断当前编辑
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => {
      void tick();
    }, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [currentWorkspace?.id, hasPersistedRunningMessage, isCurrentWorkspaceTextStreaming, loadWorkspace, refreshSessions]);

  const workspaceTitle = useMemo(() => currentWorkspace?.name || '未选择会话', [currentWorkspace]);
  const workspaceMeta = useMemo(() => {
    const messageCount = currentWorkspace?.messages.length || 0;
    const pendingTurns = currentWorkspace ? (pendingTurnsByWorkspace[currentWorkspace.id] || []) : [];
    if (pendingTurns.length === 0) {
      return `${messageCount} 条消息`;
    }
    return `${messageCount} 条消息 · 生成中 ${pendingTurns.length}`;
  }, [currentWorkspace, pendingTurnsByWorkspace]);
  const generatedAssets = useMemo(() => {
    if (!currentWorkspace) return [];
    const fromMessages = currentWorkspace.messages.flatMap((message) => message.images || []);
    return dedupeAssets(fromMessages.filter((asset) => asset.kind === 'generated'));
  }, [currentWorkspace]);
  const workspaceMessageUploadAssets = useMemo(() => {
    if (!currentWorkspace) return [];
    const fromMessages = currentWorkspace.messages.flatMap((message) => message.attachments || []);
    return dedupeAssets(fromMessages.filter((asset) => asset.kind === 'upload'));
  }, [currentWorkspace]);
  const uploadSourceAssets = useMemo(
    () => dedupeAssets(workspaceUploadAssets.concat(workspaceMessageUploadAssets)),
    [workspaceMessageUploadAssets, workspaceUploadAssets],
  );
  const generatedSourceAssets = useMemo(
    () => generatedAssets,
    [generatedAssets],
  );
  const savedSourceAssets = useMemo(
    () => savedAssets,
    [savedAssets],
  );
  const annotationContexts = useMemo(
    () => Object.values(annotationContextsByMention),
    [annotationContextsByMention],
  );

  const pendingMessagesForCurrentWorkspace = useMemo((): StudioMessage[] => {
    if (!currentWorkspace) return [];
    const pendingTurns = pendingTurnsByWorkspace[currentWorkspace.id] || [];
    if (pendingTurns.length === 0) return [];
    const nowMs = progressNowMs;
    const workspaceMessages = currentWorkspace.messages || [];
    const hasPersistedCounterpart = (turn: PendingTurn): boolean => {
      const targetText = String(turn.text || '').trim();
      const targetMode = turn.mode;
      if (!targetText) return false;
      for (let index = 0; index < workspaceMessages.length; index += 1) {
        const userMsg = workspaceMessages[index];
        if (!userMsg || userMsg.role !== 'user') continue;
        if ((userMsg.mode || 'image') !== targetMode) continue;
        if (String(userMsg.text || '').trim() !== targetText) continue;
        const assistantMsg = workspaceMessages[index + 1];
        if (!assistantMsg || assistantMsg.role !== 'assistant') continue;
        if ((assistantMsg.mode || 'image') !== targetMode) continue;
        const status = String(assistantMsg.status || '').trim().toLowerCase();
        if (status === 'running' || status === 'completed' || status === 'failed') {
          return true;
        }
      }
      return false;
    };
    return pendingTurns.flatMap((turn) => {
      if (hasPersistedCounterpart(turn)) {
        return [];
      }
      const parsedCreatedAtMs = Date.parse(turn.createdAt);
      const createdAtMs = Number.isFinite(parsedCreatedAtMs) ? parsedCreatedAtMs : nowMs;
      const runningSinceMs = turn.startedAtMs ?? createdAtMs;
      const elapsedSeconds = Math.max(1, Math.floor((nowMs - runningSinceMs) / 1000));
      const runningPrefix = turn.mode === 'text' ? '正在思考中' : '正在生成中';
      const assistantText = `${runningPrefix}... 已耗时 ${elapsedSeconds}s`;
      return [
        {
          id: `${turn.id}-user`,
          role: 'user',
          mode: turn.mode,
          text: turn.text,
          params: turn.params,
          status: 'pending',
          created_at: turn.createdAt,
        },
        {
          id: `${turn.id}-assistant`,
          role: 'assistant',
          mode: turn.mode,
          text: assistantText,
          params: turn.params,
          status: 'running',
          created_at: turn.createdAt,
        },
      ];
    });
  }, [currentWorkspace, pendingTurnsByWorkspace, progressNowMs]);

  const displayWorkspace = useMemo(() => {
    if (!currentWorkspace) return null;
    if (pendingMessagesForCurrentWorkspace.length === 0) return currentWorkspace;
    return {
      ...currentWorkspace,
      messages: currentWorkspace.messages.concat(pendingMessagesForCurrentWorkspace),
    };
  }, [currentWorkspace, pendingMessagesForCurrentWorkspace]);

  const isCurrentWorkspaceSending = useMemo(() => {
    if (!currentWorkspace) return false;
    const pendingTurns = pendingTurnsByWorkspace[currentWorkspace.id] || [];
    return pendingTurns.some((item) => item.status === 'running') || hasPersistedRunningMessage || isCurrentWorkspaceTextStreaming;
  }, [currentWorkspace, pendingTurnsByWorkspace, hasPersistedRunningMessage, isCurrentWorkspaceTextStreaming]);

  const handleAnnotationContextChange = useCallback((draft: AnnotationDraftContext) => {
    if (!annotatorTarget) return;
    const mentionId = String(annotatorTarget.reference.mention_id || '').trim();
    const referenceSlot = String(annotatorTarget.reference.slot || '').trim();
    const assetId = String(draft.asset_id || annotatorTarget.asset.id || '').trim();
    if (!mentionId || !referenceSlot || !assetId) return;

    const otherContexts = Object.values(annotationContextsByMention).filter((item) => item.mention_id !== mentionId);
    const reservedLabels = new Set(otherContexts.flatMap((item) => item.objects.map((obj) => obj.id)));
    const mentionSlots = extractOrderedSlots(composerText);
    const hasCurrentSlotToken = mentionSlots.includes(referenceSlot);
    const directReferenceCountWithoutCurrent = mentionSlots.length - (hasCurrentSlotToken ? 1 : 0);
    const otherObjectCount = otherContexts.reduce((sum, item) => sum + item.objects.length, 0);
    const maxObjectsForCurrent = Math.max(
      0,
      Math.min(3, MAX_MATERIAL_UNITS - directReferenceCountWithoutCurrent - otherObjectCount),
    );

    const previousMap = objectNameMapRef.current[mentionId] || {};
    const nextMap: Record<string, string> = {};
    const usedLabels = new Set<string>();
    const shapeIds = draft.boxes.map((item) => item.shape_id).filter(Boolean).slice(0, maxObjectsForCurrent);

    shapeIds.forEach((shapeId) => {
      const existing = previousMap[shapeId];
      if (!existing) return;
      if (!OBJECT_LABELS.includes(existing)) return;
      if (reservedLabels.has(existing)) return;
      if (usedLabels.has(existing)) return;
      nextMap[shapeId] = existing;
      usedLabels.add(existing);
    });

    const availableLabels = OBJECT_LABELS.filter((item) => !reservedLabels.has(item) && !usedLabels.has(item));
    shapeIds.forEach((shapeId) => {
      if (nextMap[shapeId]) return;
      const nextLabel = availableLabels.shift();
      if (!nextLabel) return;
      nextMap[shapeId] = nextLabel;
      usedLabels.add(nextLabel);
    });
    objectNameMapRef.current[mentionId] = nextMap;

    const objects: ComposerAnnotationObject[] = draft.boxes
      .filter((item) => Boolean(nextMap[item.shape_id]))
      .map((item) => ({
        id: nextMap[item.shape_id],
        shape_id: item.shape_id,
        bbox: {
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
        },
      }))
      .sort((a, b) => Number(a.id.replace('对象', '')) - Number(b.id.replace('对象', '')));

    let moveRelation: ComposerAnnotationContextState['move_relation'] = null;
    if (draft.move_relation) {
      const sourceId = nextMap[draft.move_relation.source_shape_id];
      const targetId = nextMap[draft.move_relation.target_shape_id];
      if (sourceId && targetId && sourceId !== targetId) {
        moveRelation = {
          source_id: sourceId,
          target_id: targetId,
        };
      }
    }

    const nextContextsByMention = { ...annotationContextsByMention };
    if (objects.length > 0) {
      nextContextsByMention[mentionId] = {
        mention_id: mentionId,
        reference_slot: referenceSlot,
        asset_id: assetId,
        objects,
        move_relation: moveRelation,
      };
    } else {
      delete nextContextsByMention[mentionId];
      delete objectNameMapRef.current[mentionId];
    }

    setAnnotationContextsByMention(nextContextsByMention);
    const nextContexts = Object.values(nextContextsByMention);
    if (objects.length > 0) {
      setComposerText((prev) => mergeComposerTextWithAnnotations(prev, nextContexts));
      return;
    }
    setComposerText((prev) => {
      const merged = mergeComposerTextWithAnnotations(prev, nextContexts);
      return ensureSlotTokenExists(merged, referenceSlot);
    });
  }, [annotatorTarget, annotationContextsByMention, composerText]);

  const annotationSendGuard = useMemo(() => {
    if (annotationContexts.length === 0) {
      return { disabled: false, reason: '' };
    }
    const textMap = parseAnnotationTextsByObject(composerText);
    const allObjects = annotationContexts.flatMap((item) => item.objects);
    const filledCount = allObjects.filter((item) => isObjectDescriptionFilled(textMap.get(item.id))).length;
    if (filledCount === 0) {
      return { disabled: true, reason: '请至少填写一个对象的编辑内容' };
    }
    for (const item of annotationContexts) {
      if (!item.move_relation) continue;
      const sourceText = textMap.get(item.move_relation.source_id);
      if (!isObjectDescriptionFilled(sourceText)) {
        return { disabled: true, reason: '请填写移动源对象的内容' };
      }
    }
    const directRefsCount = extractOrderedSlots(composerText).length;
    if (directRefsCount + allObjects.length > MAX_MATERIAL_UNITS) {
      return { disabled: true, reason: '单条消息最多 9 个素材单元（@图片 + 标注对象）' };
    }
    return { disabled: false, reason: '' };
  }, [annotationContexts, composerText]);

  const composerSendDisabledReason = useMemo(() => {
    if (annotationSendGuard.disabled) {
      return annotationSendGuard.reason || '当前内容暂不可发送';
    }
    return '';
  }, [annotationSendGuard.disabled, annotationSendGuard.reason]);

  const removePendingTurn = useCallback((workspaceId: string, pendingId: string) => {
    setPendingTurnsByWorkspace((prev) => {
      const list = prev[workspaceId] || [];
      const nextList = list.filter((item) => item.id !== pendingId);
      if (nextList.length === list.length) return prev;
      if (nextList.length === 0) {
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      }
      return {
        ...prev,
        [workspaceId]: nextList,
      };
    });
  }, []);

  const runImageTurn = useCallback(async (workspaceId: string, pendingId: string, requestPayload: ImageTurnRequest) => {
    if (!workspaceId) return;
    try {
      const result = await studioApi.createTurn(workspaceId, {
        text: requestPayload.text,
        params: requestPayload.params,
        attachment_asset_ids: requestPayload.attachmentIds,
        references: requestPayload.references,
        annotation_contexts: requestPayload.annotationPayloads,
      });
      if (currentWorkspaceIdRef.current === workspaceId) {
        appendTurn(result.user_message, result.assistant_message);
      }
      try {
        await refreshSessions();
        await refreshDynamicSourceAssets();
        if (currentWorkspaceIdRef.current === workspaceId) {
          await loadWorkspace(workspaceId);
        }
      } catch {
        // 后台生成成功后，列表刷新失败不应影响主流程
      }
      showToast('生成完成');
    } catch (error) {
      try {
        if (currentWorkspaceIdRef.current === workspaceId) {
          await loadWorkspace(workspaceId);
        }
        await refreshSessions();
      } catch {
        // 错误态消息刷新失败时不阻塞提示
      }
      const message = error instanceof Error ? error.message : '生成失败';
      showToast(message, 'error');
    } finally {
      removePendingTurn(workspaceId, pendingId);
    }
  }, [appendTurn, loadWorkspace, refreshDynamicSourceAssets, refreshSessions, removePendingTurn]);

  async function handleCreateWorkspace() {
    const name = window.prompt('会话名称', '室内设计会话');
    if (name === null) return;
    try {
      const created = await studioApi.createWorkspace(name || '室内设计会话');
      await refreshSessions();
      await loadWorkspace(created.id);
      showToast('会话已创建');
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建会话失败';
      showToast(message, 'error');
    }
  }

  async function handleDeleteWorkspace(workspaceId: string) {
    const ok = window.confirm('确定删除该会话吗？');
    if (!ok) return;
    try {
      await studioApi.deleteWorkspace(workspaceId);
      setPendingTurnsByWorkspace((prev) => {
        if (!prev[workspaceId]) return prev;
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
      setTextStreamingCountByWorkspace((prev) => {
        if (!prev[workspaceId]) return prev;
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
      const list = await refreshSessions();
      if (list.length === 0) {
        setCurrentWorkspace(null);
      } else if (currentWorkspace?.id === workspaceId) {
        await loadWorkspace(list[0].id);
      }
      showToast('会话已删除');
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除会话失败';
      showToast(message, 'error');
    }
  }

  async function handleSelectWorkspace(workspaceId: string) {
    try {
      await loadWorkspace(workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载会话失败';
      showToast(message, 'error');
    }
  }

  async function handleComposerModeChange(nextMode: StudioComposerMode) {
    if (composerMode === nextMode) return;
    const workspaceId = currentWorkspaceIdRef.current;
    if (!workspaceId) return;
    const previousMode = composerMode;
    setComposerMode(nextMode);
    try {
      const updatedWorkspace = await studioApi.updateWorkspaceMode(workspaceId, nextMode);
      if (currentWorkspaceIdRef.current === workspaceId) {
        currentWorkspaceRef.current = updatedWorkspace;
        setCurrentWorkspace(updatedWorkspace);
      }
      await refreshSessions();
    } catch (error) {
      setComposerMode(previousMode);
      const message = error instanceof Error ? error.message : '切换模式失败';
      showToast(message, 'error');
    }
  }

  function queueInsertAsset(asset: StudioAsset, source: InsertAssetRequest['source']) {
    setInsertAssetRequest({
      nonce: Date.now() + Math.floor(Math.random() * 10000),
      asset,
      source,
    });
  }

  function findAssetById(assetId: string): StudioAsset | null {
    const normalizedId = String(assetId || '').trim();
    if (!normalizedId) return null;
    const fromWorkspace = currentWorkspace
      ? currentWorkspace.messages.flatMap((message) => [...(message.attachments || []), ...(message.images || [])])
      : [];
    const pool = dedupeAssets(fromWorkspace.concat(savedAssets, generatedAssets, officialAssets));
    return pool.find((asset) => asset.id === normalizedId && asset.kind !== 'deleted') || null;
  }

  function handleAnnotateReference(reference: ComposerReference) {
    const mentionId = String(reference.mention_id || '').trim();
    const slot = String(reference.slot || '').trim();
    const normalizedId = String(reference.asset_id || '').trim();
    if (!normalizedId) return;
    const target = findAssetById(normalizedId);
    if (!target) {
      showToast('未找到可标注的图片，请先确认素材存在', 'error');
      return;
    }
    if (mentionId) {
      const nextContextsByMention = { ...annotationContextsByMention };
      if (nextContextsByMention[mentionId]) {
        delete nextContextsByMention[mentionId];
        delete objectNameMapRef.current[mentionId];
        setAnnotationContextsByMention(nextContextsByMention);
        setComposerText((prev) =>
          ensureSlotTokenExists(
            mergeComposerTextWithAnnotations(prev, Object.values(nextContextsByMention)),
            slot,
          ),
        );
      }
    }
    setAnnotatorTarget({ asset: target, reference });
  }

  function handleAnnotateAssetDirectly(asset: StudioAsset) {
    const existedReference = composerReferences.find((item) => item.asset_id === asset.id);
    const normalizedReference = existedReference
      ? existedReference
      : (() => {
          const slot = nextAvailableSlotFromReferences(composerReferences);
          if (!slot) return null;
          return {
            mention_id: `mention-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            slot,
            asset_id: asset.id,
            source: asset.kind === 'official' ? 'official' : asset.kind === 'generated' ? 'generated' : 'library',
            order: composerReferences.length + 1,
            asset_title: asset.title,
          } as ComposerReference;
        })();
    if (!normalizedReference) {
      showToast('同一条消息最多可引用 9 张图片素材', 'error');
      return;
    }
    if (!existedReference) {
      setComposerReferences((prev) => prev.concat(normalizedReference));
      setComposerText((prev) => ensureSlotTokenExists(prev, normalizedReference.slot));
    }
    handleAnnotateReference(normalizedReference);
  }

  async function handleUploadFiles(files: File[]): Promise<StudioAsset[]> {
    try {
      const result = await studioApi.uploadAssets(files, currentWorkspaceIdRef.current || undefined);
      await refreshDynamicSourceAssets();
      showToast(`已上传 ${result.items.length} 张图片`);
      return result.items;
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传失败';
      showToast(message, 'error');
      throw error;
    }
  }

  async function handleSendTurn() {
    if (!currentWorkspace) return;
    const targetWorkspaceId = currentWorkspace.id;
    const text = composerText.trim();
    const { ordered, missingSlots } = orderedReferencesFromText(text, composerReferences);
    const attachmentIds = ordered.map((item) => item.asset_id);
    if (!text && attachmentIds.length === 0) {
      showToast('请输入内容或添加素材', 'error');
      return;
    }
    if (missingSlots.length > 0) {
      showToast(`引用未绑定素材：${missingSlots.map((slot) => `@${slot}`).join('、')}`, 'error');
      return;
    }
    if (annotationSendGuard.disabled) {
      showToast(annotationSendGuard.reason || '标注对象填写不完整', 'error');
      return;
    }

    const objectTextMap = parseAnnotationTextsByObject(composerText);
    const annotationPayloads: AnnotationContextPayload[] = annotationContexts
      .filter((context) => context.objects.length > 0)
      .map((context) => ({
        asset_id: context.asset_id,
        objects: context.objects.map((item) => ({
          id: item.id,
          shape_id: item.shape_id,
          bbox: item.bbox,
          text: objectTextMap.get(item.id) || '',
        })),
        move_relation: moveRelationToPayload(context.move_relation),
      }));

    if (composerMode === 'text') {
      const pendingId = `pending-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const pendingTurn: PendingTurn = {
        id: pendingId,
        workspaceId: targetWorkspaceId,
        mode: 'text',
        text,
        params: { ...params },
        createdAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        status: 'running',
      };
      setPendingTurnsByWorkspace((prev) => ({
        ...prev,
        [targetWorkspaceId]: (prev[targetWorkspaceId] || []).concat(pendingTurn),
      }));

      setComposerText('');
      setComposerReferences([]);
      setAnnotationContextsByMention({});
      objectNameMapRef.current = {};
      setAnnotatorTarget(null);
      setLightboxAsset(null);

      let assistantMessageId = '';
      let streamErrorMessage = '';
      adjustWorkspaceTextStreamingCount(targetWorkspaceId, 1);
      try {
        const textTurnParams: GenerationParams = textPromptPackEnabled
          ? { ...params, prompt_pack_mode: 'stepped_image_prompts', prompt_pack_stage: 'phase1_options' }
          : { ...params };
        await studioApi.createTextTurnStream(
          targetWorkspaceId,
          {
            text,
            params: textTurnParams,
            attachment_asset_ids: attachmentIds,
            references: ordered,
            annotation_contexts: annotationPayloads,
          },
          {
            onStart: (event) => {
              removePendingTurn(targetWorkspaceId, pendingId);
              assistantMessageId = event.assistant_message.id;
              patchWorkspaceIfCurrent(targetWorkspaceId, (workspace) => {
                const messages = [...workspace.messages];
                const upsert = (message: StudioMessage) => {
                  const idx = messages.findIndex((item) => item.id === message.id);
                  if (idx >= 0) {
                    messages[idx] = { ...messages[idx], ...message };
                  } else {
                    messages.push(message);
                  }
                };
                upsert(event.user_message);
                upsert(event.assistant_message);
                return {
                  ...workspace,
                  messages,
                  updated_at: new Date().toISOString(),
                };
              });
            },
            onDelta: (event) => {
              if (!assistantMessageId) return;
              patchWorkspaceIfCurrent(targetWorkspaceId, (workspace) => ({
                ...workspace,
                messages: workspace.messages.map((message) =>
                  message.id === assistantMessageId
                    ? { ...message, text: event.assistant_text || `${message.text || ''}${event.delta || ''}`, status: 'running' }
                    : message,
                ),
                updated_at: new Date().toISOString(),
              }));
            },
            onDone: (event) => {
              patchWorkspaceIfCurrent(targetWorkspaceId, (workspace) => {
                const messages = [...workspace.messages];
                const upsert = (message: StudioMessage) => {
                  const idx = messages.findIndex((item) => item.id === message.id);
                  if (idx >= 0) {
                    messages[idx] = { ...messages[idx], ...message };
                  } else {
                    messages.push(message);
                  }
                };
                upsert(event.user_message);
                upsert(event.assistant_message);
                return {
                  ...workspace,
                  messages,
                  updated_at: new Date().toISOString(),
                };
              });
            },
            onError: (event) => {
              streamErrorMessage = event.message || '文本生成失败';
              patchWorkspaceIfCurrent(targetWorkspaceId, (workspace) => {
                const messages = workspace.messages.map((message) => {
                  if (event.assistant_message && message.id === event.assistant_message.id) {
                    return { ...message, ...event.assistant_message };
                  }
                  if (!event.assistant_message && assistantMessageId && message.id === assistantMessageId) {
                    return {
                      ...message,
                      status: 'failed',
                      text: `文本生成失败：${streamErrorMessage}`,
                    };
                  }
                  return message;
                });
                return {
                  ...workspace,
                  messages,
                  updated_at: new Date().toISOString(),
                };
              });
            },
          },
        );
        try {
          await refreshSessions();
          await refreshDynamicSourceAssets();
          if (currentWorkspaceIdRef.current === targetWorkspaceId) {
            await loadWorkspace(targetWorkspaceId);
          }
        } catch {
          // 文本回复完成后的刷新失败不阻塞主流程
        }
        if (streamErrorMessage) {
          showToast(streamErrorMessage, 'error');
        } else {
          showToast('文本回复完成');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '文本生成失败';
        showToast(message, 'error');
        try {
          if (currentWorkspaceIdRef.current === targetWorkspaceId) {
            await loadWorkspace(targetWorkspaceId);
          }
          await refreshSessions();
        } catch {
          // 失败态刷新异常时不阻塞提示
        }
      } finally {
        adjustWorkspaceTextStreamingCount(targetWorkspaceId, -1);
        removePendingTurn(targetWorkspaceId, pendingId);
      }
      return;
    }

    setComposerText('');
    setComposerReferences([]);
    setAnnotationContextsByMention({});
    objectNameMapRef.current = {};
    setAnnotatorTarget(null);
    setLightboxAsset(null);

    const pendingId = `pending-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const pendingTurn: PendingTurn = {
      id: pendingId,
      workspaceId: targetWorkspaceId,
      mode: 'image',
      text,
      params: { ...params },
      createdAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      status: 'running',
    };
    const requestPayload: ImageTurnRequest = {
      text,
      params: { ...params },
      attachmentIds,
      references: ordered,
      annotationPayloads,
    };
    setPendingTurnsByWorkspace((prev) => ({
      ...prev,
      [targetWorkspaceId]: (prev[targetWorkspaceId] || []).concat(pendingTurn),
    }));
    void runImageTurn(targetWorkspaceId, pendingId, requestPayload);
  }

  function handleGenerateImageFromTextPrompt(payload: TextPromptImageSelectionPayload) {
    const workspaceId = currentWorkspaceIdRef.current;
    const normalizedPrompt = String(payload.prompt || '').trim();
    if (!workspaceId) return;
    if (!normalizedPrompt) {
      showToast('提示词为空，无法生图', 'error');
      return;
    }
    const normalizedReferences = Array.isArray(payload.references)
      ? payload.references.map((item) => ({
          mention_id: String(item.mention_id || '').trim(),
          slot: String(item.slot || '').trim(),
          asset_id: String(item.asset_id || '').trim(),
          source: String(item.source || '').trim(),
          order: Number(item.order || 0) || undefined,
          asset_title: String(item.asset_title || '').trim(),
        })).filter((item) => item.mention_id && item.slot && item.asset_id)
      : [];
    const normalizedAttachmentIds = Array.isArray(payload.attachmentAssetIds)
      ? payload.attachmentAssetIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const dedupedAttachmentIds: string[] = [];
    for (const aid of normalizedReferences.map((item) => item.asset_id).concat(normalizedAttachmentIds)) {
      if (!aid || dedupedAttachmentIds.includes(aid)) continue;
      dedupedAttachmentIds.push(aid);
    }

    const pendingId = `pending-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const pendingTurn: PendingTurn = {
      id: pendingId,
      workspaceId,
      mode: 'image',
      text: normalizedPrompt,
      params: { ...params },
      createdAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      status: 'running',
    };
    setPendingTurnsByWorkspace((prev) => ({
      ...prev,
      [workspaceId]: (prev[workspaceId] || []).concat(pendingTurn),
    }));
    const requestPayload: ImageTurnRequest = {
      text: normalizedPrompt,
      params: { ...params },
      attachmentIds: dedupedAttachmentIds,
      references: normalizedReferences,
      annotationPayloads: [],
    };
    void runImageTurn(workspaceId, pendingId, requestPayload);
    showToast(dedupedAttachmentIds.length > 0 ? '已开始生图任务（已带上原参考图）' : '已开始生图任务');
  }

  async function handleSelectTextPromptOption(payload: TextPromptOptionSelectionPayload) {
    const targetWorkspaceId = currentWorkspaceIdRef.current;
    if (!targetWorkspaceId) return;
    const optionId = String(payload.optionId || '').trim() || 'optX';
    const optionTitle = String(payload.title || '').trim() || '已选方案';
    const optionSummary = String(payload.summary || '').trim();
    const sourceText = String(payload.sourceText || '').trim();
    const composedText = [
      `用户选择了改造方案：${optionTitle}（${optionId}）`,
      optionSummary ? `方案摘要：${optionSummary}` : '',
      sourceText ? `原始需求：${sourceText}` : '',
      '请继续生成3条可直接生图的提示词。',
    ]
      .filter(Boolean)
      .join('\n');
    const textTurnParams: GenerationParams = {
      ...params,
      prompt_pack_mode: 'stepped_image_prompts',
      prompt_pack_stage: 'phase2_prompts',
      selected_option_id: optionId,
      selected_option_title: optionTitle,
      selected_option_summary: optionSummary,
    };
    const attachmentAssetIds = Array.isArray(payload.attachmentAssetIds)
      ? payload.attachmentAssetIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const references = Array.isArray(payload.references)
      ? payload.references.map((item) => ({
          mention_id: String(item.mention_id || '').trim(),
          slot: String(item.slot || '').trim(),
          asset_id: String(item.asset_id || '').trim(),
          source: String(item.source || '').trim(),
          order: Number(item.order || 0) || undefined,
          asset_title: String(item.asset_title || '').trim(),
        })).filter((item) => item.mention_id && item.slot && item.asset_id)
      : [];

    const pendingId = `pending-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const pendingTurn: PendingTurn = {
      id: pendingId,
      workspaceId: targetWorkspaceId,
      mode: 'text',
      text: composedText,
      params: { ...textTurnParams },
      createdAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      status: 'running',
    };
    setPendingTurnsByWorkspace((prev) => ({
      ...prev,
      [targetWorkspaceId]: (prev[targetWorkspaceId] || []).concat(pendingTurn),
    }));

    let assistantMessageId = '';
    let streamErrorMessage = '';
    adjustWorkspaceTextStreamingCount(targetWorkspaceId, 1);
    try {
      await studioApi.createTextTurnStream(
        targetWorkspaceId,
        {
          text: composedText,
          params: textTurnParams,
          attachment_asset_ids: attachmentAssetIds,
          references,
          annotation_contexts: [],
        },
        {
          onStart: (event) => {
            removePendingTurn(targetWorkspaceId, pendingId);
            assistantMessageId = event.assistant_message.id;
            patchWorkspaceIfCurrent(targetWorkspaceId, (workspace) => {
              const messages = [...workspace.messages];
              const upsert = (message: StudioMessage) => {
                const idx = messages.findIndex((item) => item.id === message.id);
                if (idx >= 0) {
                  messages[idx] = { ...messages[idx], ...message };
                } else {
                  messages.push(message);
                }
              };
              upsert(event.user_message);
              upsert(event.assistant_message);
              return {
                ...workspace,
                messages,
                updated_at: new Date().toISOString(),
              };
            });
          },
          onDelta: (event) => {
            if (!assistantMessageId) return;
            patchWorkspaceIfCurrent(targetWorkspaceId, (workspace) => ({
              ...workspace,
              messages: workspace.messages.map((message) =>
                message.id === assistantMessageId
                  ? { ...message, text: event.assistant_text || `${message.text || ''}${event.delta || ''}`, status: 'running' }
                  : message,
              ),
              updated_at: new Date().toISOString(),
            }));
          },
          onDone: (event) => {
            patchWorkspaceIfCurrent(targetWorkspaceId, (workspace) => {
              const messages = [...workspace.messages];
              const upsert = (message: StudioMessage) => {
                const idx = messages.findIndex((item) => item.id === message.id);
                if (idx >= 0) {
                  messages[idx] = { ...messages[idx], ...message };
                } else {
                  messages.push(message);
                }
              };
              upsert(event.user_message);
              upsert(event.assistant_message);
              return {
                ...workspace,
                messages,
                updated_at: new Date().toISOString(),
              };
            });
          },
          onError: (event) => {
            streamErrorMessage = event.message || '文本生成失败';
            patchWorkspaceIfCurrent(targetWorkspaceId, (workspace) => {
              const messages = workspace.messages.map((message) => {
                if (event.assistant_message && message.id === event.assistant_message.id) {
                  return { ...message, ...event.assistant_message };
                }
                if (!event.assistant_message && assistantMessageId && message.id === assistantMessageId) {
                  return {
                    ...message,
                    status: 'failed',
                    text: `文本生成失败：${streamErrorMessage}`,
                  };
                }
                return message;
              });
              return {
                ...workspace,
                messages,
                updated_at: new Date().toISOString(),
              };
            });
          },
        },
      );
      try {
        await refreshSessions();
        await refreshDynamicSourceAssets();
        if (currentWorkspaceIdRef.current === targetWorkspaceId) {
          await loadWorkspace(targetWorkspaceId);
        }
      } catch {
        // 文本回复完成后的刷新失败不阻塞主流程
      }
      if (streamErrorMessage) {
        showToast(streamErrorMessage, 'error');
      } else {
        showToast(`已按“${optionTitle}”生成 3 条生图提示词`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '文本生成失败';
      showToast(message, 'error');
      try {
        if (currentWorkspaceIdRef.current === targetWorkspaceId) {
          await loadWorkspace(targetWorkspaceId);
        }
        await refreshSessions();
      } catch {
        // 失败态刷新异常时不阻塞提示
      }
    } finally {
      adjustWorkspaceTextStreamingCount(targetWorkspaceId, -1);
      removePendingTurn(targetWorkspaceId, pendingId);
    }
  }

  async function reloadCurrentWorkspace() {
    if (!currentWorkspace) return;
    await loadWorkspace(currentWorkspace.id);
  }

  async function handleDeleteImage(asset: StudioAsset) {
    const ok = window.confirm('删除后不可恢复，确认继续？');
    if (!ok) return;
    try {
      await studioApi.deleteImage(asset.id);
      await reloadCurrentWorkspace();
      const removedSlots = composerReferences.filter((item) => item.asset_id === asset.id).map((item) => item.slot);
      if (removedSlots.length > 0) {
        const regex = new RegExp(removedSlots.map((slot) => `@${slot}`).join('|'), 'g');
        setComposerText((prev) => prev.replace(regex, '').replace(/\\s{2,}/g, ' '));
        setComposerReferences((prev) => prev.filter((item) => item.asset_id !== asset.id));
      }
      const nextContextsByMention = Object.fromEntries(
        Object.entries(annotationContextsByMention).filter(([, item]) => item.asset_id !== asset.id),
      );
      if (Object.keys(nextContextsByMention).length !== Object.keys(annotationContextsByMention).length) {
        setAnnotationContextsByMention(nextContextsByMention);
        Object.keys(objectNameMapRef.current).forEach((key) => {
          if (!nextContextsByMention[key]) delete objectNameMapRef.current[key];
        });
        setComposerText((prev) => mergeComposerTextWithAnnotations(prev, Object.values(nextContextsByMention)));
      }
      if (lightboxAsset?.id === asset.id) setLightboxAsset(null);
      if (annotatorTarget?.asset.id === asset.id) setAnnotatorTarget(null);
      await refreshDynamicSourceAssets();
      showToast('图片已删除');
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除图片失败';
      showToast(message, 'error');
    }
  }

  async function handleRenameDynamicSourceAsset(assetId: string, title: string): Promise<StudioAsset> {
    const updated = await studioApi.updateAssetMeta(assetId, { title });
    setSavedAssets((prev) => prev.map((asset) => (asset.id === updated.id ? { ...asset, ...updated } : asset)));
    setWorkspaceUploadAssets((prev) => prev.map((asset) => (asset.id === updated.id ? { ...asset, ...updated } : asset)));
    patchAssetInWorkspace(updated);
    setLightboxAsset((prev) => (prev?.id === updated.id ? { ...prev, ...updated } : prev));
    setAnnotatorTarget((prev) => (prev?.asset.id === updated.id ? { ...prev, asset: { ...prev.asset, ...updated } } : prev));
    showToast('素材名称已更新');
    return updated;
  }

  async function handleDeleteDynamicSourceAsset(assetId: string): Promise<void> {
    await studioApi.deleteImage(assetId);
    await reloadCurrentWorkspace();
    const removedSlots = composerReferences.filter((item) => item.asset_id === assetId).map((item) => item.slot);
    if (removedSlots.length > 0) {
      const regex = new RegExp(removedSlots.map((slot) => `@${slot}`).join('|'), 'g');
      setComposerText((prev) => prev.replace(regex, '').replace(/\s{2,}/g, ' '));
      setComposerReferences((prev) => prev.filter((item) => item.asset_id !== assetId));
    }
    const nextContextsByMention = Object.fromEntries(
      Object.entries(annotationContextsByMention).filter(([, item]) => item.asset_id !== assetId),
    );
    if (Object.keys(nextContextsByMention).length !== Object.keys(annotationContextsByMention).length) {
      setAnnotationContextsByMention(nextContextsByMention);
      Object.keys(objectNameMapRef.current).forEach((key) => {
        if (!nextContextsByMention[key]) delete objectNameMapRef.current[key];
      });
      setComposerText((prev) => mergeComposerTextWithAnnotations(prev, Object.values(nextContextsByMention)));
    }
    if (lightboxAsset?.id === assetId) setLightboxAsset(null);
    if (annotatorTarget?.asset.id === assetId) setAnnotatorTarget(null);
    await refreshDynamicSourceAssets();
    showToast('上传素材已删除');
  }

  async function handleImageAction(action: ImageAction, asset: StudioAsset) {
    try {
      if (action === 'copy') {
        const copiedType = await copyAssetImage(asset);
        showToast(copiedType === 'image' ? '已复制图片' : '当前环境仅复制了图片地址');
        return;
      }
      if (action === 'download') {
        const result = await downloadAssetImage(asset);
        showToast(`已下载到 ${result.saved_path}`);
        return;
      }
      if (action === 'add') {
        const source = asset.kind === 'official' ? 'official' : asset.kind === 'generated' ? 'generated' : 'library';
        queueInsertAsset(asset, source);
        setLightboxAsset(null);
        showToast('已插入到对话框');
        return;
      }
      if (action === 'annotate') {
        handleAnnotateAssetDirectly(asset);
        return;
      }
      if (action === 'zoom') {
        setLightboxAsset(asset);
        return;
      }
      if (action === 'delete') {
        await handleDeleteImage(asset);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作失败';
      showToast(message, 'error');
    }
  }

  async function handleSaveRuntimeConfig(next: RuntimeConfig) {
    setRuntimeSaving(true);
    try {
      const saved = await studioApi.updateRuntimeConfig(next);
      setRuntimeConfig(saved);
      setRuntimeDialogOpen(false);
      showToast('API 设置已保存');
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存 API 设置失败';
      showToast(message, 'error');
    } finally {
      setRuntimeSaving(false);
    }
  }

  async function handleSaveMentionSettings(next: MentionSettings) {
    setMentionSaving(true);
    try {
      const saved = await studioApi.updateMentionSettings(next);
      setMentionSettings(saved);
      showToast('@弹窗设置已保存');
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存 @弹窗设置失败';
      showToast(message, 'error');
    } finally {
      setMentionSaving(false);
    }
  }

  async function handleUploadMentionStaticItem(sourceId: string, file: File): Promise<MentionSourceItem> {
    return studioApi.uploadMentionStaticItem(sourceId, file);
  }

  function handleComposerReferencesChange(nextReferences: ComposerReference[]) {
    const removedMentionIds = composerReferences
      .filter((item) => !nextReferences.some((next) => next.mention_id === item.mention_id))
      .map((item) => item.mention_id);
    setComposerReferences(nextReferences);
    if (removedMentionIds.length === 0) return;
    const nextContextsByMention = { ...annotationContextsByMention };
    let changed = false;
    removedMentionIds.forEach((mentionId) => {
      if (!nextContextsByMention[mentionId]) return;
      delete nextContextsByMention[mentionId];
      delete objectNameMapRef.current[mentionId];
      changed = true;
    });
    if (!changed) return;
    if (annotatorTarget && removedMentionIds.includes(annotatorTarget.reference.mention_id)) {
      setAnnotatorTarget(null);
    }
    setAnnotationContextsByMention(nextContextsByMention);
    setComposerText((prev) => mergeComposerTextWithAnnotations(prev, Object.values(nextContextsByMention)));
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <Box sx={{ flex: 1, p: { xs: 1, md: 2 }, pt: { xs: 1, md: 2 } }}>
        {initializing ? (
          <Stack alignItems="center" justifyContent="center" sx={{ minHeight: '60vh' }} spacing={1}>
            <CircularProgress size={28} />
            <Typography variant="body2" color="text.secondary">
              正在加载工作台...
            </Typography>
          </Stack>
        ) : (
          <Box
            sx={{
              height: { xs: 'auto', lg: 'calc(100vh - 60px)' },
              minHeight: { xs: 600, lg: 'auto' },
              display: 'flex',
              gap: 2,
            }}
          >
            <WorkspaceSidebar
              sessions={sessions}
              currentWorkspaceId={currentWorkspace?.id}
              onSelectWorkspace={handleSelectWorkspace}
              onCreateWorkspace={handleCreateWorkspace}
              onDeleteWorkspace={handleDeleteWorkspace}
              onRefresh={() => {
                void refreshSessions();
              }}
              onOpenSettings={() => setRuntimeDialogOpen(true)}
            />

            <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
              {/* Header */}
              <Box sx={{ mb: 2 }}>
                <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between">
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="h6" fontWeight={700} noWrap>
                      {workspaceTitle}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {workspaceMeta}
                    </Typography>
                  </Box>
                  <Button
                    component={RouterLink}
                    to="/workflow"
                    variant="outlined"
                    size="small"
                    sx={{ flexShrink: 0 }}
                  >
                    切换到画布模式
                  </Button>
                </Stack>
              </Box>
              
              {/* Workspace Content + Floating Composer */}
              <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <Box sx={{ height: '100%', minHeight: 0, pb: { xs: '20px', md: '16px' } }}>
                  <ChatThread
                    workspace={displayWorkspace}
                    onOpenAsset={(asset) => setLightboxAsset(asset)}
                    onImageAction={(action, asset) => {
                      void handleImageAction(action, asset);
                    }}
                    onGenerateTextPromptImage={(payload) => {
                      handleGenerateImageFromTextPrompt(payload);
                    }}
                    onSelectTextPromptOption={(payload) => {
                      void handleSelectTextPromptOption(payload);
                    }}
                  />
                </Box>

                <ComposerDock
                  workspaceId={currentWorkspace?.id || null}
                  mode={composerMode}
                  text={composerText}
                  references={composerReferences}
                  params={params}
                  options={options}
                  annotationActive={Boolean(annotatorTarget)}
                  annotationPreservedMentionIds={annotationContexts.map((item) => item.mention_id)}
                  sendDisabled={Boolean(composerSendDisabledReason)}
                  sendDisabledReason={composerSendDisabledReason}
                  uploadAssets={uploadSourceAssets}
                  generatedAssets={generatedAssets}
                  savedAssets={savedAssets}
                  mentionSettings={mentionSettings}
                  officialAssets={officialAssets}
                  officialHasMore={officialHasMore}
                  officialLoading={officialLoading}
                  officialFilters={officialFilters}
                  onOfficialFilterChange={(patch) => setOfficialFilters((prev) => ({ ...prev, ...patch }))}
                  onOfficialReload={() => {
                    void refreshOfficialMetaAndFirstPage();
                  }}
                  onOfficialLoadMore={() => {
                    void loadOfficialAssets(false, officialFilters);
                  }}
                  insertAssetRequest={insertAssetRequest}
                  sending={isCurrentWorkspaceSending}
                  onTextChange={setComposerText}
                  onReferencesChange={handleComposerReferencesChange}
                  onParamsChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
                  onModeChange={(nextMode) => {
                    void handleComposerModeChange(nextMode);
                  }}
                  textPromptPackEnabled={textPromptPackEnabled}
                  onTextPromptPackEnabledChange={setTextPromptPackEnabled}
                  onUploadFiles={handleUploadFiles}
                  onConsumeInsertAssetRequest={() => setInsertAssetRequest(null)}
                  onAnnotateReference={handleAnnotateReference}
                  onSend={() => {
                    void handleSendTurn();
                  }}
                />
              </Box>
            </Box>
          </Box>
        )}
      </Box>

      <ImageLightbox
        open={Boolean(lightboxAsset)}
        asset={lightboxAsset}
        onClose={() => setLightboxAsset(null)}
        onCopy={(asset) => {
          void handleImageAction('copy', asset);
        }}
        onDownload={(asset) => {
          void handleImageAction('download', asset);
        }}
        onAddToComposer={(asset) => {
          void handleImageAction('add', asset);
        }}
        onAnnotate={(asset) => {
          setLightboxAsset(null);
          handleAnnotateAssetDirectly(asset);
        }}
        onDelete={(asset) => {
          void handleImageAction('delete', asset);
        }}
      />

      <AnnotatorDialog
        open={Boolean(annotatorTarget)}
        asset={annotatorTarget?.asset || null}
        initialSnapshot={null}
        onClose={() => setAnnotatorTarget(null)}
        onContextChange={handleAnnotationContextChange}
      />

      <ApiSettingsDialog
        open={runtimeDialogOpen}
        value={runtimeConfig}
        saving={runtimeSaving}
        mentionSettings={mentionSettings}
        mentionSaving={mentionSaving}
        dynamicSourceAssets={{
          upload: uploadSourceAssets,
          generated: generatedSourceAssets,
          saved: savedSourceAssets,
        }}
        onClose={() => setRuntimeDialogOpen(false)}
        onSave={(next) => handleSaveRuntimeConfig(next)}
        onSaveMentionSettings={(next) => handleSaveMentionSettings(next)}
        onUploadMentionStaticItem={(sourceId, file) => handleUploadMentionStaticItem(sourceId, file)}
        onUploadDynamicSourceAssets={(files) => handleUploadFiles(files)}
        onRenameDynamicSourceAsset={(assetId, title) => handleRenameDynamicSourceAsset(assetId, title)}
        onDeleteDynamicSourceAsset={(assetId) => handleDeleteDynamicSourceAsset(assetId)}
        onRefreshDynamicSourceAssets={refreshDynamicSourceAssets}
        onSelectDirectory={async () => {
          const result = await studioApi.selectDirectory();
          return result.path;
        }}
      />

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
