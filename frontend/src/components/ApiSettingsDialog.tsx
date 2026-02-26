import AddRoundedIcon from '@mui/icons-material/AddRounded';
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';

import { resolveAssetUrl } from '../api/client';

import type {
  MentionSettings,
  MentionSourceConfig,
  MentionSourceItem,
  RuntimeConfig,
  StudioAsset,
} from '../types/studio';

interface ApiSettingsDialogProps {
  open: boolean;
  value: RuntimeConfig | null;
  saving: boolean;
  mentionSettings: MentionSettings | null;
  mentionSaving: boolean;
  dynamicSourceAssets: {
    upload: StudioAsset[];
    generated: StudioAsset[];
    saved: StudioAsset[];
  };
  onClose: () => void;
  onSave: (next: RuntimeConfig) => Promise<void> | void;
  onSaveMentionSettings: (next: MentionSettings) => Promise<void> | void;
  onUploadMentionStaticItem: (sourceId: string, file: File) => Promise<MentionSourceItem>;
  onUploadDynamicSourceAssets: (files: File[]) => Promise<StudioAsset[]>;
  onRenameDynamicSourceAsset: (assetId: string, title: string) => Promise<StudioAsset>;
  onDeleteDynamicSourceAsset: (assetId: string) => Promise<void>;
  onRefreshDynamicSourceAssets: () => Promise<void>;
  onSelectDirectory: () => Promise<string>;
}

const DEFAULT_API_CONFIG: RuntimeConfig = {
  http: {
    endpoint: '',
    api_key: '',
    api_key_managed_by_env: false,
    response_format: 'url',
    timeout_seconds: 120,
    download_dir: '',
  },
};

const DEFAULT_MENTION_SETTINGS: MentionSettings = {
  composer_placeholder: '描述你的想法，输入@触发选择素材，单条消息最多9张素材',
  search_placeholder: '搜索素材标题...',
  upload_button_text: '点击 / 拖拽 / 粘贴 上传',
  sources: [
    { id: 'upload', name: '上传', enabled: true, order: 1, kind: 'dynamic', items: [] },
    { id: 'generated', name: '生成', enabled: true, order: 2, kind: 'dynamic', items: [] },
    { id: 'saved', name: '素材库', enabled: true, order: 3, kind: 'dynamic', items: [] },
    { id: 'official', name: '官方', enabled: true, order: 4, kind: 'dynamic', items: [] },
  ],
  official_prompts: [],
  official_taxonomies: {
    scene: [],
    style: [],
    material: [],
    lighting: [],
  },
};
const PROTECTED_MENTION_SOURCE_IDS = new Set(['upload', 'generated', 'saved']);

function normalizeRuntime(input: RuntimeConfig): RuntimeConfig {
  const timeout = Number.isFinite(input.http.timeout_seconds) ? Number(input.http.timeout_seconds) : 120;
  return {
    http: {
      endpoint: input.http.endpoint.trim(),
      api_key: input.http.api_key || '',
      api_key_managed_by_env: Boolean(input.http.api_key_managed_by_env),
      response_format: input.http.response_format === 'b64_json' ? 'b64_json' : 'url',
      timeout_seconds: Math.max(5, Math.min(Math.round(timeout), 600)),
      download_dir: String(input.http.download_dir || '').trim(),
    },
  };
}

function resequenceSources(sources: MentionSourceConfig[]): MentionSourceConfig[] {
  const sorted = [...sources].sort((a, b) => a.order - b.order);
  return sorted.map((source, index) => ({
    ...source,
    order: index + 1,
    items: source.kind === 'static'
      ? [...(source.items || [])]
          .sort((a, b) => a.order - b.order)
          .map((item, itemIndex) => ({ ...item, order: itemIndex + 1 }))
      : [],
  }));
}

function normalizeMention(input: MentionSettings): MentionSettings {
  const draft = input || DEFAULT_MENTION_SETTINGS;
  const sources = Array.isArray(draft.sources)
    ? draft.sources
        .filter((source) => source && source.id)
        .map((source, index): MentionSourceConfig => {
          const kind: MentionSourceConfig['kind'] = source.kind === 'static' ? 'static' : 'dynamic';
          return {
            ...source,
            id: String(source.id).trim(),
            name: String(source.name || source.id || '未命名来源').trim() || '未命名来源',
            enabled: Boolean(source.enabled),
            order: Number.isFinite(source.order) ? Number(source.order) : index + 1,
            kind,
            items:
              kind === 'static' && Array.isArray(source.items)
                ? source.items
                    .filter((item) => item && item.id)
                    .map((item, itemIndex) => ({
                      ...item,
                      id: String(item.id).trim(),
                      title: String(item.title || item.id || `素材${itemIndex + 1}`).trim() || `素材${itemIndex + 1}`,
                      order: Number.isFinite(item.order) ? Number(item.order) : itemIndex + 1,
                      tags: Array.isArray(item.tags)
                        ? item.tags.map((tag) => String(tag || '').trim()).filter(Boolean)
                        : [],
                      storage_key: String(item.storage_key || '').trim(),
                    }))
                : [],
          };
        })
    : DEFAULT_MENTION_SETTINGS.sources;

  const officialPrompts = Array.isArray(draft.official_prompts)
    ? draft.official_prompts
        .map((prompt, index) => ({
          id: String(prompt.id || `prompt-${index + 1}`).trim() || `prompt-${index + 1}`,
          title: String(prompt.title || `提示词${index + 1}`).trim() || `提示词${index + 1}`,
          content: String(prompt.content || '').trim(),
        }))
        .filter((prompt) => prompt.title || prompt.content)
    : [];

  const taxonomies = {
    scene: Array.isArray(draft.official_taxonomies?.scene)
      ? draft.official_taxonomies.scene.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    style: Array.isArray(draft.official_taxonomies?.style)
      ? draft.official_taxonomies.style.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    material: Array.isArray(draft.official_taxonomies?.material)
      ? draft.official_taxonomies.material.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    lighting: Array.isArray(draft.official_taxonomies?.lighting)
      ? draft.official_taxonomies.lighting.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  };

  return {
    composer_placeholder:
      String(draft.composer_placeholder || DEFAULT_MENTION_SETTINGS.composer_placeholder).trim() ||
      DEFAULT_MENTION_SETTINGS.composer_placeholder,
    search_placeholder:
      String(draft.search_placeholder || DEFAULT_MENTION_SETTINGS.search_placeholder).trim() ||
      DEFAULT_MENTION_SETTINGS.search_placeholder,
    upload_button_text:
      String(draft.upload_button_text || DEFAULT_MENTION_SETTINGS.upload_button_text).trim() ||
      DEFAULT_MENTION_SETTINGS.upload_button_text,
    sources: resequenceSources(sources),
    official_prompts: officialPrompts,
    official_taxonomies: taxonomies,
  };
}

function defaultSourceName(index: number): string {
  return `新来源${index}`;
}

export function ApiSettingsDialog({
  open,
  value,
  saving,
  mentionSettings,
  mentionSaving,
  dynamicSourceAssets,
  onClose,
  onSave,
  onSaveMentionSettings,
  onUploadMentionStaticItem,
  onUploadDynamicSourceAssets,
  onRenameDynamicSourceAsset,
  onDeleteDynamicSourceAsset,
  onRefreshDynamicSourceAssets,
  onSelectDirectory,
}: ApiSettingsDialogProps) {
  const [tab, setTab] = useState<'api' | 'mention'>('api');
  const [apiDraft, setApiDraft] = useState<RuntimeConfig>(DEFAULT_API_CONFIG);
  const [mentionDraft, setMentionDraft] = useState<MentionSettings>(DEFAULT_MENTION_SETTINGS);
  const [apiError, setApiError] = useState('');
  const [mentionError, setMentionError] = useState('');
  const [taxonomyInputs, setTaxonomyInputs] = useState<Record<'scene' | 'style' | 'material' | 'lighting', string>>({
    scene: '',
    style: '',
    material: '',
    lighting: '',
  });
  const [uploadingSourceId, setUploadingSourceId] = useState('');
  const [activeSourceId, setActiveSourceId] = useState('upload');
  const [dynamicSourceQuery, setDynamicSourceQuery] = useState('');
  const [dynamicSourceBusyId, setDynamicSourceBusyId] = useState('');
  const [dynamicSourceUploading, setDynamicSourceUploading] = useState(false);
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dynamicSourceInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadSourceIdRef = useRef<string>('');

  const sortedSources = useMemo(
    () => [...(mentionDraft.sources || [])].sort((a, b) => a.order - b.order),
    [mentionDraft.sources],
  );
  const filteredDynamicSourceAssets = useMemo(() => {
    const q = dynamicSourceQuery.trim().toLowerCase();
    const list =
      activeSourceId === 'upload'
        ? dynamicSourceAssets.upload || []
        : activeSourceId === 'generated'
          ? dynamicSourceAssets.generated || []
          : activeSourceId === 'saved'
            ? dynamicSourceAssets.saved || []
            : [];
    if (!q) return list;
    return list.filter((asset) => {
      const text = `${asset.title || ''} ${(asset.tags || []).join(' ')}`.toLowerCase();
      return text.includes(q);
    });
  }, [activeSourceId, dynamicSourceAssets.generated, dynamicSourceAssets.saved, dynamicSourceAssets.upload, dynamicSourceQuery]);
  const apiKeyManagedByEnv = Boolean(apiDraft.http.api_key_managed_by_env);

  function resetDrafts() {
    const nextMention = normalizeMention(mentionSettings || DEFAULT_MENTION_SETTINGS);
    setApiDraft(value ? normalizeRuntime(value) : DEFAULT_API_CONFIG);
    setMentionDraft(nextMention);
    setApiError('');
    setMentionError('');
    setTaxonomyInputs({ scene: '', style: '', material: '', lighting: '' });
    setUploadingSourceId('');
    setActiveSourceId(nextMention.sources?.[0]?.id || 'upload');
    setDynamicSourceQuery('');
    setDynamicSourceBusyId('');
    setDynamicSourceUploading(false);
    setSelectingDirectory(false);
  }

  useEffect(() => {
    if (!sortedSources.some((source) => source.id === activeSourceId)) {
      setActiveSourceId(sortedSources[0]?.id || 'upload');
    }
  }, [activeSourceId, sortedSources]);

  async function submitApi() {
    const normalized = normalizeRuntime(apiDraft);
    if (normalized.http.api_key_managed_by_env) {
      normalized.http.api_key = '';
    }
    if (!normalized.http.endpoint) {
      setApiError('请填写小豆包 API 地址。');
      return;
    }
    setApiError('');
    await onSave(normalized);
  }

  async function handleSelectDirectory() {
    setSelectingDirectory(true);
    try {
      const path = await onSelectDirectory();
      const normalized = String(path || '').trim();
      if (!normalized) return;
      setApiDraft((prev) => ({
        ...prev,
        http: { ...prev.http, download_dir: normalized },
      }));
      setApiError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '选择下载目录失败';
      if (message.includes('未选择目录')) {
        return;
      }
      setApiError(message);
    } finally {
      setSelectingDirectory(false);
    }
  }

  async function submitMention() {
    const normalized = normalizeMention(mentionDraft);
    if (normalized.sources.length === 0) {
      setMentionError('至少保留一个来源。');
      return;
    }
    setMentionError('');
    await onSaveMentionSettings(normalized);
  }

  function patchSource(sourceId: string, patch: Partial<MentionSourceConfig>) {
    setMentionDraft((prev) => {
      const next = prev.sources.map((source) => (source.id === sourceId ? { ...source, ...patch } : source));
      return { ...prev, sources: resequenceSources(next) };
    });
  }

  function deleteSource(sourceId: string) {
    if (PROTECTED_MENTION_SOURCE_IDS.has(sourceId)) {
      setMentionError('默认来源（上传 / 生成 / 素材库）不可删除。');
      return;
    }
    setMentionDraft((prev) => ({
      ...prev,
      sources: resequenceSources(prev.sources.filter((source) => source.id !== sourceId)),
    }));
  }

  function moveSource(sourceId: string, direction: -1 | 1) {
    setMentionDraft((prev) => {
      const sorted = [...prev.sources].sort((a, b) => a.order - b.order);
      const index = sorted.findIndex((source) => source.id === sourceId);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= sorted.length) return prev;
      const clone = [...sorted];
      const [item] = clone.splice(index, 1);
      clone.splice(targetIndex, 0, item);
      return { ...prev, sources: resequenceSources(clone) };
    });
  }

  function addStaticSource() {
    setMentionDraft((prev) => {
      const nextIndex = prev.sources.length + 1;
      const source: MentionSourceConfig = {
        id: `source-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        name: defaultSourceName(nextIndex),
        enabled: true,
        order: nextIndex,
        kind: 'static',
        items: [],
      };
      return {
        ...prev,
        sources: resequenceSources(prev.sources.concat(source)),
      };
    });
  }

  function addPrompt() {
    setMentionDraft((prev) => ({
      ...prev,
      official_prompts: prev.official_prompts.concat({
        id: `prompt-${Date.now()}-${Math.random().toString(16).slice(2, 5)}`,
        title: `提示词${prev.official_prompts.length + 1}`,
        content: '',
      }),
    }));
  }

  function patchPrompt(index: number, patch: { title?: string; content?: string }) {
    setMentionDraft((prev) => ({
      ...prev,
      official_prompts: prev.official_prompts.map((prompt, idx) => (idx === index ? { ...prompt, ...patch } : prompt)),
    }));
  }

  function deletePrompt(index: number) {
    setMentionDraft((prev) => ({
      ...prev,
      official_prompts: prev.official_prompts.filter((_prompt, idx) => idx !== index),
    }));
  }

  function addTaxonomyValue(key: 'scene' | 'style' | 'material' | 'lighting') {
    const raw = taxonomyInputs[key] || '';
    const valueText = raw.trim();
    if (!valueText) return;
    setMentionDraft((prev) => {
      const current = prev.official_taxonomies[key] || [];
      if (current.includes(valueText)) return prev;
      return {
        ...prev,
        official_taxonomies: {
          ...prev.official_taxonomies,
          [key]: current.concat(valueText),
        },
      };
    });
    setTaxonomyInputs((prev) => ({ ...prev, [key]: '' }));
  }

  function deleteTaxonomyValue(key: 'scene' | 'style' | 'material' | 'lighting', valueToDelete: string) {
    setMentionDraft((prev) => ({
      ...prev,
      official_taxonomies: {
        ...prev.official_taxonomies,
        [key]: (prev.official_taxonomies[key] || []).filter((valueItem) => valueItem !== valueToDelete),
      },
    }));
  }

  function moveStaticItem(sourceId: string, itemId: string, direction: -1 | 1) {
    setMentionDraft((prev) => {
      const nextSources = prev.sources.map((source) => {
        if (source.id !== sourceId || source.kind !== 'static') return source;
        const sortedItems = [...source.items].sort((a, b) => a.order - b.order);
        const index = sortedItems.findIndex((item) => item.id === itemId);
        const targetIndex = index + direction;
        if (index < 0 || targetIndex < 0 || targetIndex >= sortedItems.length) return source;
        const clone = [...sortedItems];
        const [item] = clone.splice(index, 1);
        clone.splice(targetIndex, 0, item);
        return {
          ...source,
          items: clone.map((itemValue, itemIndex) => ({ ...itemValue, order: itemIndex + 1 })),
        };
      });
      return {
        ...prev,
        sources: resequenceSources(nextSources),
      };
    });
  }

  function deleteStaticItem(sourceId: string, itemId: string) {
    setMentionDraft((prev) => ({
      ...prev,
      sources: resequenceSources(
        prev.sources.map((source) => {
          if (source.id !== sourceId || source.kind !== 'static') return source;
          const nextItems = source.items
            .filter((item) => item.id !== itemId)
            .map((item, index) => ({ ...item, order: index + 1 }));
          return { ...source, items: nextItems };
        }),
      ),
    }));
  }

  function patchStaticItemTitle(sourceId: string, itemId: string, title: string) {
    setMentionDraft((prev) => ({
      ...prev,
      sources: resequenceSources(
        prev.sources.map((source) => {
          if (source.id !== sourceId || source.kind !== 'static') return source;
          return {
            ...source,
            items: source.items.map((item) => (item.id === itemId ? { ...item, title } : item)),
          };
        }),
      ),
    }));
  }

  async function handleUploadItems(sourceId: string, files: File[]) {
    if (files.length === 0) return;
    setUploadingSourceId(sourceId);
    try {
      const uploadedItems: MentionSourceItem[] = [];
      for (const file of files) {
        const uploaded = await onUploadMentionStaticItem(sourceId, file);
        uploadedItems.push(uploaded);
      }
      setMentionDraft((prev) => ({
        ...prev,
        sources: resequenceSources(
          prev.sources.map((source) => {
            if (source.id !== sourceId || source.kind !== 'static') return source;
            const merged = source.items.concat(
              uploadedItems.map((item, index) => ({
                ...item,
                order: source.items.length + index + 1,
                tags: item.tags || [],
              })),
            );
            return {
              ...source,
              items: merged.map((item, index) => ({ ...item, order: index + 1 })),
            };
          }),
        ),
      }));
      setMentionError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传静态素材失败';
      setMentionError(message);
    } finally {
      setUploadingSourceId('');
    }
  }

  async function handleUploadToDynamicSource(sourceId: string, files: File[]) {
    if (sourceId !== 'upload' || files.length === 0) return;
    if (files.length === 0) return;
    setDynamicSourceUploading(true);
    try {
      await onUploadDynamicSourceAssets(files);
      await onRefreshDynamicSourceAssets();
      setMentionError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传到上传来源失败';
      setMentionError(message);
    } finally {
      setDynamicSourceUploading(false);
    }
  }

  async function handleRenameDynamicSourceAsset(asset: StudioAsset) {
    const currentTitle = String(asset.title || '').trim();
    const nextTitle = window.prompt('素材名称', currentTitle) || '';
    const normalized = nextTitle.trim();
    if (!normalized || normalized === currentTitle) return;
    setDynamicSourceBusyId(asset.id);
    try {
      await onRenameDynamicSourceAsset(asset.id, normalized);
      await onRefreshDynamicSourceAssets();
      setMentionError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '重命名失败';
      setMentionError(message);
    } finally {
      setDynamicSourceBusyId('');
    }
  }

  async function handleDeleteDynamicSourceAsset(asset: StudioAsset) {
    const ok = window.confirm(`确认删除素材「${asset.title || asset.id}」？删除后不可恢复。`);
    if (!ok) return;
    setDynamicSourceBusyId(asset.id);
    try {
      await onDeleteDynamicSourceAsset(asset.id);
      await onRefreshDynamicSourceAssets();
      setMentionError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除上传素材失败';
      setMentionError(message);
    } finally {
      setDynamicSourceBusyId('');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={saving || mentionSaving ? undefined : onClose}
      fullWidth
      maxWidth="lg"
      TransitionProps={{
        onEntered: () => {
          resetDrafts();
        },
      }}
    >
      <DialogTitle>设置</DialogTitle>
      <DialogContent dividers>
        <Tabs value={tab} onChange={(_e, value) => setTab(value === 'mention' ? 'mention' : 'api')} sx={{ mb: 1.5 }}>
          <Tab label="API 设置" value="api" />
          <Tab label="@弹窗设置" value="mention" />
        </Tabs>

        {tab === 'api' ? (
          <Stack spacing={1.5} sx={{ pt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              已固定为真实 API 调用（小豆包 Nano-banana）。
            </Typography>

            <TextField
              label="小豆包 API 地址"
              placeholder="https://your-domain.com/v1/images/generations"
              value={apiDraft.http.endpoint}
              onChange={(event) =>
                setApiDraft((prev) => ({
                  ...prev,
                  http: { ...prev.http, endpoint: event.target.value },
                }))
              }
              size="small"
              fullWidth
            />

            {apiKeyManagedByEnv ? (
              <Alert severity="info">API Key 已由服务器环境变量托管，前端设置中已隐藏。</Alert>
            ) : (
              <TextField
                label="API Key"
                type="password"
                value={apiDraft.http.api_key}
                onChange={(event) =>
                  setApiDraft((prev) => ({
                    ...prev,
                    http: { ...prev.http, api_key: event.target.value },
                  }))
                }
                size="small"
                fullWidth
              />
            )}

            <TextField
              select
              label="返回格式"
              value={apiDraft.http.response_format}
              onChange={(event) =>
                setApiDraft((prev) => ({
                  ...prev,
                  http: { ...prev.http, response_format: event.target.value === 'b64_json' ? 'b64_json' : 'url' },
                }))
              }
              size="small"
            >
              <MenuItem value="url">url</MenuItem>
              <MenuItem value="b64_json">b64_json</MenuItem>
            </TextField>

            <TextField
              label="超时（秒）"
              type="number"
              inputProps={{ min: 5, max: 600, step: 1 }}
              value={apiDraft.http.timeout_seconds}
              onChange={(event) =>
                setApiDraft((prev) => ({
                  ...prev,
                  http: { ...prev.http, timeout_seconds: Number(event.target.value || 120) },
                }))
              }
              size="small"
            />

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField
                label="下载目录"
                placeholder="/Users/xxx/Downloads/AIStudio"
                value={apiDraft.http.download_dir}
                onChange={(event) =>
                  setApiDraft((prev) => ({
                    ...prev,
                    http: { ...prev.http, download_dir: event.target.value },
                  }))
                }
                size="small"
                fullWidth
              />
              <Button
                variant="outlined"
                onClick={() => {
                  void handleSelectDirectory();
                }}
                disabled={selectingDirectory || saving}
                sx={{ whiteSpace: 'nowrap' }}
              >
                {selectingDirectory ? '选择中...' : '选择目录'}
              </Button>
            </Stack>

            {apiError ? <Alert severity="error">{apiError}</Alert> : null}
          </Stack>
        ) : (
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.2}>
              <TextField
                label="输入框占位文案"
                value={mentionDraft.composer_placeholder}
                onChange={(event) => setMentionDraft((prev) => ({ ...prev, composer_placeholder: event.target.value }))}
                size="small"
                fullWidth
              />
              <TextField
                label="搜索框占位文案"
                value={mentionDraft.search_placeholder}
                onChange={(event) => setMentionDraft((prev) => ({ ...prev, search_placeholder: event.target.value }))}
                size="small"
                fullWidth
              />
              <TextField
                label="上传按钮文案"
                value={mentionDraft.upload_button_text}
                onChange={(event) => setMentionDraft((prev) => ({ ...prev, upload_button_text: event.target.value }))}
                size="small"
                fullWidth
              />
            </Stack>

            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, p: 1.2 }}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                <Typography variant="subtitle2" fontWeight={700}>
                  来源配置（新增仅支持静态来源）
                </Typography>
                <Button size="small" startIcon={<AddRoundedIcon />} onClick={addStaticSource}>
                  新增静态来源
                </Button>
              </Stack>

              <Stack spacing={1}>
                {sortedSources.map((source, index) => {
                  const isActive = activeSourceId === source.id;
                  const isDynamicManageable = source.kind === 'dynamic' && ['upload', 'generated', 'saved'].includes(source.id);
                  const isProtectedSource = PROTECTED_MENTION_SOURCE_IDS.has(source.id);
                  return (
                    <Box
                      key={source.id}
                      sx={{
                        border: '1px solid',
                        borderColor: isActive ? 'primary.main' : 'divider',
                        borderRadius: 1.2,
                        p: 1,
                      }}
                    >
                      <Stack
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        onClick={() => setActiveSourceId(source.id)}
                        sx={{ cursor: 'pointer' }}
                      >
                        <Checkbox
                          size="small"
                          checked={source.enabled}
                          onChange={(event) => patchSource(source.id, { enabled: event.target.checked })}
                        />
                        <TextField
                          size="small"
                          value={source.name}
                          onChange={(event) => patchSource(source.id, { name: event.target.value })}
                          sx={{ minWidth: 180 }}
                        />
                        <Chip label={source.kind === 'static' ? '静态来源' : '动态来源'} size="small" />
                        <Typography variant="caption" color="text.secondary">
                          顺序 {source.order}
                        </Typography>
                        <IconButton size="small" onClick={() => moveSource(source.id, -1)} disabled={index === 0}>
                          <ArrowUpwardRoundedIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                          size="small"
                          onClick={() => moveSource(source.id, 1)}
                          disabled={index === sortedSources.length - 1}
                        >
                          <ArrowDownwardRoundedIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => deleteSource(source.id)}
                          disabled={isProtectedSource}
                        >
                          <DeleteOutlineRoundedIcon fontSize="small" />
                        </IconButton>
                      </Stack>

                      {isActive ? (
                        source.kind === 'dynamic' ? (
                          <Box sx={{ mt: 0.8 }}>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              动态条目固定按时间倒序。
                            </Typography>
                            {isDynamicManageable ? (
                              <Box sx={{ mt: 1 }}>
                                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.8 }}>
                                  <Typography variant="caption" color="text.secondary">
                                    {source.name || source.id}素材（可改名 / 管理素材{source.id === 'upload' ? ' / 上传' : ''}）
                                  </Typography>
                                  <Stack direction="row" spacing={0.8}>
                                    <Button
                                      size="small"
                                      onClick={() => {
                                        void onRefreshDynamicSourceAssets();
                                      }}
                                      disabled={dynamicSourceUploading || Boolean(dynamicSourceBusyId)}
                                    >
                                      刷新
                                    </Button>
                                    {source.id === 'upload' ? (
                                      <Button
                                        size="small"
                                        startIcon={<UploadFileRoundedIcon />}
                                        onClick={() => dynamicSourceInputRef.current?.click()}
                                        disabled={dynamicSourceUploading || Boolean(dynamicSourceBusyId)}
                                      >
                                        {dynamicSourceUploading ? '上传中...' : '上传素材'}
                                      </Button>
                                    ) : null}
                                  </Stack>
                                </Stack>
                                <TextField
                                  size="small"
                                  value={dynamicSourceQuery}
                                  onChange={(event) => setDynamicSourceQuery(event.target.value)}
                                  placeholder={`搜索${source.name || source.id}素材...`}
                                  fullWidth
                                  sx={{ mb: 0.8 }}
                                />
                                <Stack spacing={0.8} sx={{ maxHeight: 220, overflowY: 'auto' }}>
                                  {filteredDynamicSourceAssets.length > 0 ? (
                                    filteredDynamicSourceAssets.map((asset) => (
                                      <Stack
                                        key={asset.id}
                                        direction="row"
                                        spacing={1}
                                        alignItems="center"
                                        sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 0.7 }}
                                      >
                                        <Box
                                          component="img"
                                          src={resolveAssetUrl(asset.thumbnail_url || asset.file_url)}
                                          alt={asset.title || asset.id}
                                          sx={{
                                            width: 42,
                                            height: 42,
                                            borderRadius: 0.8,
                                            objectFit: 'cover',
                                            bgcolor: 'action.hover',
                                          }}
                                        />
                                        <Typography variant="body2" sx={{ flex: 1 }} noWrap>
                                          {asset.title || asset.id}
                                        </Typography>
                                        <Button
                                          size="small"
                                          onClick={() => {
                                            void handleRenameDynamicSourceAsset(asset);
                                          }}
                                          disabled={dynamicSourceBusyId === asset.id || dynamicSourceUploading}
                                        >
                                          改名
                                        </Button>
                                        <IconButton
                                          size="small"
                                          color="error"
                                          onClick={() => {
                                            void handleDeleteDynamicSourceAsset(asset);
                                          }}
                                          disabled={dynamicSourceBusyId === asset.id || dynamicSourceUploading}
                                        >
                                          <DeleteOutlineRoundedIcon fontSize="small" />
                                        </IconButton>
                                      </Stack>
                                    ))
                                  ) : (
                                    <Typography variant="caption" color="text.secondary">
                                      当前没有可管理素材
                                    </Typography>
                                  )}
                                </Stack>
                              </Box>
                            ) : (
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                                该来源内容由系统维护；官方来源请在下方编辑“官方提示词 / 官方素材分类”。
                              </Typography>
                            )}
                          </Box>
                        ) : (
                          <Box sx={{ mt: 1 }}>
                            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.8 }}>
                              <Typography variant="caption" color="text.secondary">
                                静态条目（可上传、排序、删除）
                              </Typography>
                              <Button
                                size="small"
                                startIcon={<UploadFileRoundedIcon />}
                                disabled={mentionSaving || Boolean(uploadingSourceId)}
                                onClick={() => {
                                  pendingUploadSourceIdRef.current = source.id;
                                  fileInputRef.current?.click();
                                }}
                              >
                                {uploadingSourceId === source.id ? '上传中...' : '添加素材'}
                              </Button>
                            </Stack>
                            <Stack spacing={0.8}>
                              {(source.items || []).map((item, itemIndex) => (
                                <Stack
                                  key={item.id}
                                  direction="row"
                                  spacing={1}
                                  alignItems="center"
                                  sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 0.7 }}
                                >
                                  <Box
                                    component="img"
                                    src={resolveAssetUrl(item.thumbnail_url || item.file_url)}
                                    alt={item.title}
                                    sx={{ width: 42, height: 42, borderRadius: 0.8, objectFit: 'cover', bgcolor: 'action.hover' }}
                                  />
                                  <TextField
                                    size="small"
                                    value={item.title}
                                    onChange={(event) => patchStaticItemTitle(source.id, item.id, event.target.value)}
                                    sx={{ flex: 1 }}
                                  />
                                  <Typography variant="caption" color="text.secondary">
                                    {item.order}
                                  </Typography>
                                  <IconButton
                                    size="small"
                                    onClick={() => moveStaticItem(source.id, item.id, -1)}
                                    disabled={itemIndex === 0}
                                  >
                                    <ArrowUpwardRoundedIcon fontSize="small" />
                                  </IconButton>
                                  <IconButton
                                    size="small"
                                    onClick={() => moveStaticItem(source.id, item.id, 1)}
                                    disabled={itemIndex === source.items.length - 1}
                                  >
                                    <ArrowDownwardRoundedIcon fontSize="small" />
                                  </IconButton>
                                  <IconButton size="small" color="error" onClick={() => deleteStaticItem(source.id, item.id)}>
                                    <DeleteOutlineRoundedIcon fontSize="small" />
                                  </IconButton>
                                </Stack>
                              ))}
                            </Stack>
                          </Box>
                        )
                      ) : null}
                    </Box>
                  );
                })}
              </Stack>
            </Box>

            {activeSourceId === 'official' ? (
              <>
                <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, p: 1.2 }}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                    <Typography variant="subtitle2" fontWeight={700}>
                      官方提示词
                    </Typography>
                    <Button size="small" startIcon={<AddRoundedIcon />} onClick={addPrompt}>
                      新增提示词
                    </Button>
                  </Stack>
                  <Stack spacing={0.9}>
                    {mentionDraft.official_prompts.map((prompt, index) => (
                      <Stack key={prompt.id} direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems="flex-start">
                        <TextField
                          size="small"
                          label="标题"
                          value={prompt.title}
                          onChange={(event) => patchPrompt(index, { title: event.target.value })}
                          sx={{ minWidth: 200 }}
                        />
                        <TextField
                          size="small"
                          label="内容"
                          value={prompt.content}
                          onChange={(event) => patchPrompt(index, { content: event.target.value })}
                          fullWidth
                        />
                        <IconButton color="error" onClick={() => deletePrompt(index)}>
                          <DeleteOutlineRoundedIcon />
                        </IconButton>
                      </Stack>
                    ))}
                  </Stack>
                </Box>

                <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, p: 1.2 }}>
                  <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
                    官方素材分类
                  </Typography>
                  <Stack spacing={1.1}>
                    {(['scene', 'style', 'material', 'lighting'] as const).map((key) => (
                      <Box key={key}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                          {key === 'scene' ? '场景' : key === 'style' ? '风格' : key === 'material' ? '材质' : '光照'}
                        </Typography>
                        <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap" sx={{ mb: 0.6 }}>
                          {(mentionDraft.official_taxonomies[key] || []).map((valueItem) => (
                            <Chip
                              key={`${key}-${valueItem}`}
                              size="small"
                              label={valueItem}
                              onDelete={() => deleteTaxonomyValue(key, valueItem)}
                            />
                          ))}
                        </Stack>
                        <Stack direction="row" spacing={0.7}>
                          <TextField
                            size="small"
                            value={taxonomyInputs[key]}
                            onChange={(event) => setTaxonomyInputs((prev) => ({ ...prev, [key]: event.target.value }))}
                            placeholder={`新增${key === 'scene' ? '场景' : key === 'style' ? '风格' : key === 'material' ? '材质' : '光照'}`}
                            fullWidth
                          />
                          <Button size="small" variant="outlined" onClick={() => addTaxonomyValue(key)}>
                            添加
                          </Button>
                        </Stack>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              </>
            ) : null}

            {mentionError ? <Alert severity="error">{mentionError}</Alert> : null}

            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              accept="image/*"
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = '';
                const sourceId = pendingUploadSourceIdRef.current;
                if (!sourceId || files.length === 0) return;
                void handleUploadItems(sourceId, files);
              }}
            />
            <input
              ref={dynamicSourceInputRef}
              type="file"
              hidden
              multiple
              accept="image/*"
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = '';
                void handleUploadToDynamicSource(activeSourceId, files);
              }}
            />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving || mentionSaving}>
          取消
        </Button>
        {tab === 'api' ? (
          <Button onClick={() => void submitApi()} variant="contained" disabled={saving || mentionSaving}>
            保存
          </Button>
        ) : (
          <Button onClick={() => void submitMention()} variant="contained" disabled={saving || mentionSaving}>
            保存
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
