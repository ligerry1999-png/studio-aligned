import {
  Alert,
  Box,
  CircularProgress,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { studioApi, resolveAssetUrl } from '../api/client';
import { AnnotatorDialog, type AnnotationDraftContext } from '../components/AnnotatorDialog';
import { ApiSettingsDialog } from '../components/ApiSettingsDialog';
import { ChatThread, type ImageAction } from '../components/ChatThread';
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
  StudioMessage,
  StudioOptions,
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
  text: string;
  params: GenerationParams;
  createdAt: string;
  startedAtMs: number;
}

const OBJECT_LABELS = ['对象1', '对象2', '对象3'] as const;
const SYSTEM_OBJECT_LINE_REGEX = /^\s*将【对象([1-3])】里的「([^」]*)」(?:移动到【对象([1-3])】)?(.*)$/;

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
  asset_id: string;
  objects: ComposerAnnotationObject[];
  move_relation: {
    source_id: string;
    target_id: string;
  } | null;
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
  const tokenMatches = text.match(/@图[1-9]/g) || [];
  const tokenSlots: string[] = [];
  tokenMatches.forEach((token) => {
    const slot = token.slice(1);
    if (!tokenSlots.includes(slot)) {
      tokenSlots.push(slot);
    }
  });

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

function parseSystemObjectLines(text: string): Map<string, { content: string; target?: string; suffix?: string }> {
  const map = new Map<string, { content: string; target?: string; suffix?: string }>();
  const lines = text.split('\n');
  lines.forEach((line) => {
    const matched = line.match(SYSTEM_OBJECT_LINE_REGEX);
    if (!matched) return;
    const objectLabel = `对象${matched[1]}`;
    const targetLabel = matched[3] ? `对象${matched[3]}` : undefined;
    const suffix = matched[4] ?? '';
    map.set(objectLabel, {
      content: matched[2] ?? '',
      target: targetLabel,
      suffix,
    });
  });
  return map;
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
    ? `将【${label}】里的「${normalized}」移动到【${targetLabel}】`
    : `将【${label}】里的「${normalized}」`;
  return `${core}${suffix || ''}`;
}

function mergeComposerTextWithAnnotation(
  text: string,
  context: ComposerAnnotationContextState | null,
): string {
  const existing = parseSystemObjectLines(text);
  const base = stripSystemObjectLines(text).trim();
  if (!context || context.objects.length === 0) {
    return base;
  }
  const lines = context.objects.map((item) => {
    const existingItem = existing.get(item.id);
    const content = existingItem?.content ?? '请填写';
    const targetLabel =
      context.move_relation && context.move_relation.source_id === item.id
        ? context.move_relation.target_id
        : undefined;
    return buildSystemObjectLine(item.id, content, targetLabel, existingItem?.suffix || '');
  });
  return [base, ...lines].filter((item) => item.length > 0).join('\n');
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
  const [savingAnnotation, setSavingAnnotation] = useState(false);

  const [params, setParams] = useState<GenerationParams>(DEFAULT_PARAMS);
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
  const [annotatorAsset, setAnnotatorAsset] = useState<StudioAsset | null>(null);
  const [annotationContext, setAnnotationContext] = useState<ComposerAnnotationContextState | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [mentionSettings, setMentionSettings] = useState<MentionSettings | null>(null);
  const [mentionSaving, setMentionSaving] = useState(false);
  const [pendingTurnsByWorkspace, setPendingTurnsByWorkspace] = useState<Record<string, PendingTurn[]>>({});
  const [progressNowMs, setProgressNowMs] = useState<number>(() => Date.now());
  const currentWorkspaceIdRef = useRef<string | null>(null);
  const objectNameMapRef = useRef<Record<string, Record<string, string>>>({});

  const [toast, setToast] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  function showToast(message: string, severity: 'success' | 'error' = 'success') {
    setToast({ open: true, message, severity });
  }

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
  }, [currentWorkspace?.id]);
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

  const workspaceTitle = useMemo(() => currentWorkspace?.name || '未选择会话', [currentWorkspace]);
  const workspaceMeta = useMemo(() => {
    const messageCount = currentWorkspace?.messages.length || 0;
    const pendingCount = currentWorkspace ? (pendingTurnsByWorkspace[currentWorkspace.id]?.length ?? 0) : 0;
    return pendingCount > 0 ? `${messageCount} 条消息 · 生成中 ${pendingCount}` : `${messageCount} 条消息`;
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

  const pendingMessagesForCurrentWorkspace = useMemo((): StudioMessage[] => {
    if (!currentWorkspace) return [];
    const pendingTurns = pendingTurnsByWorkspace[currentWorkspace.id] || [];
    if (pendingTurns.length === 0) return [];
    const hasPersistedRunningMessage = currentWorkspace.messages.some(
      (message) => message.role === 'assistant' && message.status === 'running',
    );
    if (hasPersistedRunningMessage) return [];
    const nowMs = progressNowMs;
    return pendingTurns.flatMap((turn) => {
      const elapsedSeconds = Math.max(1, Math.floor((nowMs - turn.startedAtMs) / 1000));
      return [
        {
          id: `${turn.id}-user`,
          role: 'user',
          text: turn.text,
          params: turn.params,
          status: 'pending',
          created_at: turn.createdAt,
        },
        {
          id: `${turn.id}-assistant`,
          role: 'assistant',
          text: `正在生成中... 已耗时 ${elapsedSeconds}s`,
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
    return (pendingTurnsByWorkspace[currentWorkspace.id]?.length ?? 0) > 0;
  }, [currentWorkspace, pendingTurnsByWorkspace]);

  const handleAnnotationContextChange = useCallback((draft: AnnotationDraftContext) => {
    const assetId = draft.asset_id;
    if (!assetId) return;

    const previousMap = objectNameMapRef.current[assetId] || {};
    const nextMap: Record<string, string> = {};
    const usedLabels = new Set<string>();
    const shapeIds = draft.boxes.map((item) => item.shape_id).filter(Boolean).slice(0, 3);

    shapeIds.forEach((shapeId) => {
      const existing = previousMap[shapeId];
      if (!existing) return;
      if (!OBJECT_LABELS.includes(existing as (typeof OBJECT_LABELS)[number])) return;
      if (usedLabels.has(existing)) return;
      nextMap[shapeId] = existing;
      usedLabels.add(existing);
    });

    const availableLabels = OBJECT_LABELS.filter((item) => !usedLabels.has(item));
    shapeIds.forEach((shapeId) => {
      if (nextMap[shapeId]) return;
      const nextLabel = availableLabels.shift();
      if (!nextLabel) return;
      nextMap[shapeId] = nextLabel;
      usedLabels.add(nextLabel);
    });
    objectNameMapRef.current[assetId] = nextMap;

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

    const nextContext: ComposerAnnotationContextState | null =
      objects.length > 0
        ? {
            asset_id: assetId,
            objects,
            move_relation: moveRelation,
          }
        : null;

    setAnnotationContext(nextContext);
    setComposerText((prev) => mergeComposerTextWithAnnotation(prev, nextContext));
  }, []);

  const annotationSendGuard = useMemo(() => {
    if (!annotationContext || annotationContext.objects.length === 0) {
      return { disabled: false, reason: '' };
    }
    const textMap = parseAnnotationTextsByObject(composerText);
    const filledCount = annotationContext.objects.filter((item) => isObjectDescriptionFilled(textMap.get(item.id))).length;
    if (filledCount === 0) {
      return { disabled: true, reason: '请至少填写一个对象的编辑内容' };
    }
    if (annotationContext.move_relation) {
      const sourceText = textMap.get(annotationContext.move_relation.source_id);
      if (!isObjectDescriptionFilled(sourceText)) {
        return { disabled: true, reason: '请填写移动源对象的内容' };
      }
    }
    return { disabled: false, reason: '' };
  }, [annotationContext, composerText]);

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

  function queueInsertAsset(asset: StudioAsset, source: InsertAssetRequest['source']) {
    setInsertAssetRequest({
      nonce: Date.now() + Math.floor(Math.random() * 10000),
      asset,
      source,
    });
  }

  function handleAnnotateReference(assetId: string) {
    const normalizedId = String(assetId || '').trim();
    if (!normalizedId) return;
    const fromWorkspace = currentWorkspace
      ? currentWorkspace.messages.flatMap((message) => [...(message.attachments || []), ...(message.images || [])])
      : [];
    const pool = dedupeAssets(fromWorkspace.concat(savedAssets, generatedAssets, officialAssets));
    const target = pool.find((asset) => asset.id === normalizedId && asset.kind !== 'deleted');
    if (!target) {
      showToast('未找到可标注的图片，请先确认素材存在', 'error');
      return;
    }
    setAnnotatorAsset(target);
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
    if (!currentWorkspace || isCurrentWorkspaceSending) return;
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
    const annotationPayload: AnnotationContextPayload | undefined =
      annotationContext && annotationContext.objects.length > 0
        ? {
            asset_id: annotationContext.asset_id,
            objects: annotationContext.objects.map((item) => ({
              id: item.id,
              shape_id: item.shape_id,
              bbox: item.bbox,
              text: objectTextMap.get(item.id) || '',
            })),
            move_relation: moveRelationToPayload(annotationContext.move_relation),
          }
        : undefined;

    const pendingId = `pending-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const pendingTurn: PendingTurn = {
      id: pendingId,
      workspaceId: targetWorkspaceId,
      text,
      params: { ...params },
      createdAt: new Date().toISOString(),
      startedAtMs: Date.now(),
    };
    setPendingTurnsByWorkspace((prev) => ({
      ...prev,
      [targetWorkspaceId]: (prev[targetWorkspaceId] || []).concat(pendingTurn),
    }));
    setComposerText('');
    setComposerReferences([]);
    setAnnotationContext(null);
    // 发送即退出标注模式，回到消息流视图
    setAnnotatorAsset(null);
    setLightboxAsset(null);

    try {
      const result = await studioApi.createTurn(targetWorkspaceId, {
        text,
        params,
        attachment_asset_ids: attachmentIds,
        references: ordered,
        annotation_context: annotationPayload,
      });
      setPendingTurnsByWorkspace((prev) => {
        const list = prev[targetWorkspaceId] || [];
        const nextList = list.filter((item) => item.id !== pendingId);
        if (nextList.length === list.length) return prev;
        if (nextList.length === 0) {
          const next = { ...prev };
          delete next[targetWorkspaceId];
          return next;
        }
        return {
          ...prev,
          [targetWorkspaceId]: nextList,
        };
      });
      if (currentWorkspaceIdRef.current === targetWorkspaceId) {
        appendTurn(result.user_message, result.assistant_message);
      }
      try {
        await refreshSessions();
        await refreshDynamicSourceAssets();
        if (currentWorkspaceIdRef.current === targetWorkspaceId) {
          await loadWorkspace(targetWorkspaceId);
        }
      } catch {
        // 后台生成成功后，列表刷新失败不应影响主流程
      }
      showToast('生成完成');
    } catch (error) {
      setPendingTurnsByWorkspace((prev) => {
        const list = prev[targetWorkspaceId] || [];
        const nextList = list.filter((item) => item.id !== pendingId);
        if (nextList.length === list.length) return prev;
        if (nextList.length === 0) {
          const next = { ...prev };
          delete next[targetWorkspaceId];
          return next;
        }
        return {
          ...prev,
          [targetWorkspaceId]: nextList,
        };
      });
      try {
        if (currentWorkspaceIdRef.current === targetWorkspaceId) {
          await loadWorkspace(targetWorkspaceId);
        }
        await refreshSessions();
      } catch {
        // 错误态消息刷新失败时不阻塞提示
      }
      const message = error instanceof Error ? error.message : '生成失败';
      showToast(message, 'error');
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
      if (annotationContext?.asset_id === asset.id) {
        setAnnotationContext(null);
        setComposerText((prev) => mergeComposerTextWithAnnotation(prev, null));
      }
      if (lightboxAsset?.id === asset.id) setLightboxAsset(null);
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
    setAnnotatorAsset((prev) => (prev?.id === updated.id ? { ...prev, ...updated } : prev));
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
    if (annotationContext?.asset_id === assetId) {
      setAnnotationContext(null);
      setComposerText((prev) => mergeComposerTextWithAnnotation(prev, null));
    }
    if (lightboxAsset?.id === assetId) setLightboxAsset(null);
    if (annotatorAsset?.id === assetId) setAnnotatorAsset(null);
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
        showToast('已插入到对话框');
        return;
      }
      if (action === 'annotate') {
        setAnnotatorAsset(asset);
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

  async function handleSaveAnnotation(snapshot: Record<string, unknown>) {
    if (!annotatorAsset) return;
    setSavingAnnotation(true);
    try {
      const updated = await studioApi.saveAnnotation(annotatorAsset.id, snapshot);
      patchAssetInWorkspace(updated);
      setOfficialAssets((prev) => prev.map((asset) => (asset.id === updated.id ? { ...asset, ...updated } : asset)));
      setSavedAssets((prev) => prev.map((asset) => (asset.id === updated.id ? { ...asset, ...updated } : asset)));
      setLightboxAsset((prev) => (prev?.id === updated.id ? { ...prev, ...updated } : prev));
      setAnnotatorAsset(null);
      showToast('标注已保存');
    } catch (error) {
      const message = error instanceof Error ? error.message : '标注保存失败';
      showToast(message, 'error');
    } finally {
      setSavingAnnotation(false);
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
                <Typography variant="h6" fontWeight={700}>
                  {workspaceTitle}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {workspaceMeta}
                </Typography>
              </Box>
              
              {/* Chat Thread - with bottom padding for floating composer */}
              <Box sx={{ flex: 1, minHeight: 0, pb: '200px' }}>
                <ChatThread
                  workspace={displayWorkspace}
                  onOpenAsset={(asset) => setLightboxAsset(asset)}
                  onImageAction={(action, asset) => {
                    void handleImageAction(action, asset);
                  }}
                />
              </Box>
            </Box>
            
            {/* Floating Composer Dock */}
            <ComposerDock
              workspaceId={currentWorkspace?.id || null}
              text={composerText}
              references={composerReferences}
              params={params}
              options={options}
              annotationActive={Boolean(annotatorAsset)}
              sendDisabled={annotationSendGuard.disabled}
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
              onReferencesChange={setComposerReferences}
              onParamsChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
              onUploadFiles={handleUploadFiles}
              onConsumeInsertAssetRequest={() => setInsertAssetRequest(null)}
              onAnnotateReference={handleAnnotateReference}
              onSend={() => {
                void handleSendTurn();
              }}
            />
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
          setAnnotatorAsset(asset);
        }}
        onDelete={(asset) => {
          void handleImageAction('delete', asset);
        }}
      />

      <AnnotatorDialog
        open={Boolean(annotatorAsset)}
        asset={annotatorAsset}
        saving={savingAnnotation}
        onClose={() => setAnnotatorAsset(null)}
        onContextChange={handleAnnotationContextChange}
        onSave={(snapshot) => {
          void handleSaveAnnotation(snapshot);
        }}
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
