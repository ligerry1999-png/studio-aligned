import AddRoundedIcon from '@mui/icons-material/AddRounded';
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import EditNoteRoundedIcon from '@mui/icons-material/EditNoteRounded';
import ImageRoundedIcon from '@mui/icons-material/ImageRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import SendRoundedIcon from '@mui/icons-material/SendRounded';

import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from 'react';

import { resolveAssetUrl } from '../api/client';
import type {
  ComposerReference,
  GenerationParams,
  MentionSettings,
  StudioComposerMode,
  StudioAsset,
  StudioOptions,
} from '../types/studio';

const MAX_REFERENCES = 9;

export type MentionAssetSource = string;

export interface InsertAssetRequest {
  nonce: number;
  asset: StudioAsset;
  source: MentionAssetSource;
}

export interface OfficialFilters {
  scene: string;
  style: string;
  material: string;
  lighting: string;
  search: string;
}

interface ComposerDockProps {
  workspaceId?: string | null;
  text: string;
  mode: StudioComposerMode;
  references: ComposerReference[];
  params: GenerationParams;
  options: StudioOptions | null;
  annotationActive?: boolean;
  annotationPreservedMentionIds?: string[];
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  uploadAssets: StudioAsset[];
  generatedAssets: StudioAsset[];
  savedAssets: StudioAsset[];
  mentionSettings: MentionSettings | null;
  officialAssets: StudioAsset[];
  officialHasMore: boolean;
  officialLoading: boolean;
  officialFilters: OfficialFilters;
  onOfficialFilterChange: (patch: Partial<OfficialFilters>) => void;
  onOfficialReload: () => void;
  onOfficialLoadMore: () => void;
  insertAssetRequest: InsertAssetRequest | null;
  sending: boolean;
  onTextChange: (value: string) => void;
  onReferencesChange: (references: ComposerReference[]) => void;
  onParamsChange: (patch: Partial<GenerationParams>) => void;
  onModeChange: (mode: StudioComposerMode) => void;
  textPromptPackEnabled: boolean;
  onTextPromptPackEnabledChange: (enabled: boolean) => void;
  onUploadFiles: (files: File[]) => Promise<StudioAsset[]>;
  onConsumeInsertAssetRequest: () => void;
  onAnnotateReference: (reference: ComposerReference) => void;
  onSend: () => void;
}

interface TextTemplateItem {
  id: string;
  title: string;
  content: string;
}

const PARAM_SELECT_BASE_SX = {
  height: 30,
  borderRadius: 1.8,
  px: 1.1,
  border: '1px solid rgba(129, 102, 77, 0.18)',
  bgcolor: '#ede6de',
  color: '#2a2a2a',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  outline: 'none',
};

function dedupeById(list: StudioAsset[]): StudioAsset[] {
  const seen = new Set<string>();
  return list.filter((item) => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function isImageFile(file: File): boolean {
  const mime = String(file.type || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name || '');
}

function collectImageFiles(list: FileList | File[] | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((file) => isImageFile(file));
}

function hasImageDataTransfer(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  const files = Array.from(dataTransfer.files || []);
  if (files.some((file) => isImageFile(file))) {
    return true;
  }
  const items = Array.from(dataTransfer.items || []);
  return items.some((item) => item.kind === 'file');
}

function collectClipboardImageFiles(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) return [];
  const directFiles = collectImageFiles(dataTransfer.files);
  if (directFiles.length > 0) {
    return directFiles;
  }
  const files: File[] = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file') continue;
    const type = String(item.type || '').toLowerCase();
    if (type && !type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file && isImageFile(file)) {
      files.push(file);
    }
  }
  return files;
}

function sourceFromAsset(asset: StudioAsset): MentionAssetSource {
  if (asset.kind === 'official') return 'official';
  if (asset.kind === 'generated') return 'generated';
  if (asset.kind === 'saved') return 'library';
  return 'upload';
}

function sourceContentType(value: unknown): 'image' | 'text' {
  return String(value || '').trim().toLowerCase() === 'text' ? 'text' : 'image';
}

function extractOrderedSlots(text: string): string[] {
  const matched = text.match(/@图[1-9]/g) || [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  matched.forEach((token) => {
    const slot = token.slice(1);
    if (!seen.has(slot)) {
      seen.add(slot);
      ordered.push(slot);
    }
  });
  return ordered;
}

function syncReferencesWithText(
  text: string,
  refs: ComposerReference[],
  preservedMentionIds: string[] = [],
): ComposerReference[] {
  const slots = new Set(extractOrderedSlots(text));
  const preserved = new Set(
    preservedMentionIds
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  return refs.filter((ref) => preserved.has(ref.mention_id) || slots.has(ref.slot));
}

function sameReferenceOrder(a: ComposerReference[], b: ComposerReference[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item.mention_id === b[index]?.mention_id);
}

function nextAvailableSlot(refs: ComposerReference[]): string | null {
  const used = new Set(refs.map((ref) => ref.slot));
  for (let i = 1; i <= MAX_REFERENCES; i += 1) {
    const slot = `图${i}`;
    if (!used.has(slot)) return slot;
  }
  return null;
}

function detectMentionContext(value: string, caret: number): { start: number; query: string } | null {
  if (caret < 0) return null;
  const prefix = value.slice(0, caret);
  const start = prefix.lastIndexOf('@');
  if (start < 0) return null;
  const query = prefix.slice(start + 1);
  if (/\s|\n/.test(query)) return null;
  return { start, query };
}

interface HighlightSegment {
  content: string;
  highlighted: boolean;
  objectToken?: boolean;
  mentionThumbnailUrl?: string;
  mentionTitle?: string;
}

function splitComposerTextByMentions(
  text: string,
  highlightedSlots: Set<string>,
  referenceBySlot: Map<string, ComposerReference>,
  mentionAssetMap: Map<string, StudioAsset>,
): HighlightSegment[] {
  if (!text) return [{ content: '', highlighted: false }];
  const segments: HighlightSegment[] = [];
  const regex = /@图[1-9]|【对象(?:[1-9])】/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const token = match[0];
    const tokenStart = match.index;
    if (tokenStart > lastIndex) {
      segments.push({ content: text.slice(lastIndex, tokenStart), highlighted: false });
    }
    if (token.startsWith('@')) {
      const slot = token.slice(1);
      const ref = referenceBySlot.get(slot);
      const matchedAsset = ref ? mentionAssetMap.get(String(ref.asset_id || '')) : undefined;
      const thumb = resolveAssetUrl(String(matchedAsset?.thumbnail_url || matchedAsset?.file_url || ''));
      segments.push({
        content: token,
        highlighted: highlightedSlots.has(slot),
        mentionThumbnailUrl: thumb || undefined,
        mentionTitle: ref?.asset_title || matchedAsset?.title || ref?.asset_id || slot,
      });
    } else {
      segments.push({ content: token, highlighted: true, objectToken: true });
    }
    lastIndex = tokenStart + token.length;
  }
  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), highlighted: false });
  }
  return segments;
}

function MentionRefChip({
  refItem,
  thumbnailUrl,
  onPreview,
  onRemove,
  onAnnotate,
}: {
  refItem: ComposerReference;
  thumbnailUrl?: string;
  onPreview?: (refItem: ComposerReference) => void;
  onRemove: (refItem: ComposerReference) => void;
  onAnnotate: (refItem: ComposerReference) => void;
}) {
  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        borderRadius: 1.5,
        px: 1,
        py: 0.4,
        background: '#2a2a2a',
        border: 'none',
      }}
    >
      {thumbnailUrl ? (
        <Box
          component="button"
          type="button"
          onClick={() => onPreview?.(refItem)}
          sx={{
            width: 22,
            height: 22,
            borderRadius: 0.7,
            border: '1px solid rgba(255,255,255,0.36)',
            overflow: 'hidden',
            p: 0,
            cursor: 'pointer',
            background: 'transparent',
            flexShrink: 0,
          }}
        >
          <Box
            component="img"
            src={thumbnailUrl}
            alt={refItem.asset_title || refItem.asset_id}
            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </Box>
      ) : null}
      <Typography variant="caption" sx={{ fontWeight: 600, color: '#ffffff', ml: thumbnailUrl ? 0 : 0 }}>
        @{refItem.slot}
      </Typography>
      <Typography variant="caption" sx={{ fontWeight: 400, color: 'rgba(255,255,255,0.7)', maxWidth: 120 }} noWrap>
        {refItem.asset_title || refItem.asset_id}
      </Typography>
      <IconButton
        size="small"
        sx={{
          width: 16,
          height: 16,
          color: 'rgba(255,255,255,0.78)',
          p: 0,
          '&:hover': { color: '#ffffff', bgcolor: 'transparent' },
        }}
        onClick={() => onAnnotate(refItem)}
      >
        <EditNoteRoundedIcon sx={{ fontSize: 12 }} />
      </IconButton>
      <IconButton 
        size="small" 
        sx={{ 
          width: 16, 
          height: 16, 
          color: 'rgba(255,255,255,0.7)',
          p: 0,
          '&:hover': { color: '#ffffff', bgcolor: 'transparent' }
        }} 
        onClick={() => onRemove(refItem)}
      >
        <CloseRoundedIcon sx={{ fontSize: 12 }} />
      </IconButton>
    </Box>
  );
}

export function ComposerDock({
  workspaceId = null,
  text,
  mode,
  references,
  params,
  options,
  annotationActive = false,
  annotationPreservedMentionIds = [],
  sendDisabled = false,
  sendDisabledReason = '',
  uploadAssets,
  generatedAssets,
  savedAssets,
  mentionSettings,
  officialAssets,
  officialHasMore,
  officialLoading,
  officialFilters,
  onOfficialFilterChange,
  onOfficialReload,
  onOfficialLoadMore,
  insertAssetRequest,
  sending,
  onTextChange,
  onReferencesChange,
  onParamsChange,
  onModeChange,
  textPromptPackEnabled,
  onTextPromptPackEnabledChange,
  onUploadFiles,
  onConsumeInsertAssetRequest,
  onAnnotateReference,
  onSend,
}: ComposerDockProps) {
  const dockRootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mentionUploadRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSource, setPickerSource] = useState<string>('upload');
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [pickerError, setPickerError] = useState('');
  const [pickerUploading, setPickerUploading] = useState(false);
  const [pickerUploads, setPickerUploads] = useState<StudioAsset[]>([]);
  const [composerDropActive, setComposerDropActive] = useState(false);
  const [composerDropUploading, setComposerDropUploading] = useState(false);
  const [quickTemplateDialogOpen, setQuickTemplateDialogOpen] = useState(false);
  const [quickTemplateName, setQuickTemplateName] = useState('');
  const [quickTemplateContent, setQuickTemplateContent] = useState('');
  const [quickTemplateIsDefault, setQuickTemplateIsDefault] = useState(false);
  const [mentionPreview, setMentionPreview] = useState<{ url: string; title: string } | null>(null);
  const handledInsertNonceRef = useRef<number>(0);
  const latestTextRef = useRef(text);
  const latestReferencesRef = useRef(references);
  const composerDragDepthRef = useRef(0);

  const modelOptions = useMemo(
    () => (options?.models || []).map((item) => ({ value: item.id, label: item.name })),
    [options?.models],
  );
  const ratioOptions = useMemo(
    () => (options?.aspect_ratios || []).map((item) => ({ value: item, label: item })),
    [options?.aspect_ratios],
  );
  const qualityOptions = useMemo(
    () => (options?.qualities || []).map((item) => ({ value: item, label: item.toUpperCase() })),
    [options?.qualities],
  );
  const countOptions = useMemo(
    () => (options?.counts || []).map((item) => ({ value: item, label: `${item} 张` })),
    [options?.counts],
  );

  const mentionComposerPlaceholder = mentionSettings?.composer_placeholder || '描述你的想法，输入@触发选择素材，单条消息最多9张素材';
  const mentionSearchPlaceholder = mentionSettings?.search_placeholder || '搜索素材标题...';
  const mentionUploadButtonText = mentionSettings?.upload_button_text || '点击 / 拖拽 / 粘贴 上传';
  const sendBlockedReason = sendDisabled
    ? sendDisabledReason || '当前内容暂不可发送'
    : '';
  const sendQueueHint = sending && !sendBlockedReason
    ? '当前会话正在生成中，可继续发送并发任务'
    : '';

  const sortedSources = useMemo(() => {
    const list = mentionSettings?.sources || [
      { id: 'upload', name: '上传', enabled: true, order: 1, kind: 'dynamic', content_type: 'image', items: [] },
      { id: 'generated', name: '生成', enabled: true, order: 2, kind: 'dynamic', content_type: 'image', items: [] },
      { id: 'saved', name: '素材库', enabled: true, order: 3, kind: 'dynamic', content_type: 'image', items: [] },
      { id: 'official', name: '官方', enabled: true, order: 4, kind: 'dynamic', content_type: 'image', items: [] },
    ];
    return [...list].sort((a, b) => a.order - b.order);
  }, [mentionSettings?.sources]);

  const enabledSources = useMemo(() => sortedSources.filter((item) => item.enabled), [sortedSources]);
  const officialTaxonomies = mentionSettings?.official_taxonomies || { scene: [], style: [], material: [], lighting: [] };
  const officialPrompts = mentionSettings?.official_prompts || [];

  useEffect(() => {
    if (enabledSources.length === 0) return;
    if (!enabledSources.some((source) => source.id === pickerSource)) {
      setPickerSource(enabledSources[0].id);
    }
  }, [enabledSources, pickerSource]);
  useEffect(() => {
    setPickerUploads([]);
    setPickerError('');
  }, [workspaceId]);
  useEffect(() => {
    latestTextRef.current = text;
  }, [text]);
  useEffect(() => {
    latestReferencesRef.current = references;
  }, [references]);

  const uploadCandidates = useMemo(
    () => dedupeById(pickerUploads.concat(uploadAssets)),
    [pickerUploads, uploadAssets],
  );
  const generatedCandidates = useMemo(() => dedupeById(generatedAssets), [generatedAssets]);
  const savedCandidates = useMemo(() => dedupeById(savedAssets), [savedAssets]);
  const staticCandidatesMap = useMemo(() => {
    const map = new Map<string, StudioAsset[]>();
    sortedSources.forEach((source) => {
      if (source.kind !== 'static') return;
      if (sourceContentType(source.content_type) !== 'image') return;
      const assets = dedupeById(
        (source.items || []).map((item) => ({
          id: item.id,
          kind: 'static',
          title: item.title,
          tags: item.tags || [],
          file_url: item.file_url,
          thumbnail_url: item.thumbnail_url,
        })),
      );
      map.set(source.id, assets);
    });
    return map;
  }, [sortedSources]);
  const staticTextTemplateMap = useMemo(() => {
    const map = new Map<string, TextTemplateItem[]>();
    sortedSources.forEach((source) => {
      if (source.kind !== 'static') return;
      if (sourceContentType(source.content_type) !== 'text') return;
      const templates: TextTemplateItem[] = (source.items || [])
        .map((item, index) => ({
          id: String(item.id || `template-${source.id}-${index}`),
          title: String(item.title || `模板${index + 1}`),
          content: String(item.content || '').trim(),
        }))
        .filter((item) => Boolean(item.content));
      map.set(source.id, templates);
    });
    return map;
  }, [sortedSources]);
  const staticCandidates = useMemo(
    () => dedupeById(Array.from(staticCandidatesMap.values()).flat()),
    [staticCandidatesMap],
  );

  const officialCandidates = useMemo(() => {
    const q = mentionQuery.trim().toLowerCase();
    if (!q) return officialAssets;
    return officialAssets.filter((item) => {
      const textValue = `${item.title || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
      return textValue.includes(q);
    });
  }, [officialAssets, mentionQuery]);

  const currentCandidates = useMemo(() => {
    let sourceList: StudioAsset[] = [];
    if (pickerSource === 'official') {
      sourceList = officialCandidates;
    } else if (pickerSource === 'upload') {
      sourceList = uploadCandidates;
    } else if (pickerSource === 'generated') {
      sourceList = generatedCandidates;
    } else if (pickerSource === 'saved') {
      sourceList = savedCandidates;
    } else {
      sourceList = staticCandidatesMap.get(pickerSource) || [];
    }
    const q = mentionQuery.trim().toLowerCase();
    if (!q) return sourceList;
    return sourceList.filter((item) => {
      const textValue = `${item.title || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
      return textValue.includes(q);
    });
  }, [
    generatedCandidates,
    mentionQuery,
    pickerSource,
    savedCandidates,
    uploadCandidates,
    officialCandidates,
    staticCandidatesMap,
  ]);
  const currentSource = useMemo(
    () => enabledSources.find((source) => source.id === pickerSource) || null,
    [enabledSources, pickerSource],
  );
  const isTextTemplateSource = Boolean(
    currentSource && currentSource.kind === 'static' && sourceContentType(currentSource.content_type) === 'text',
  );
  const currentTextTemplates = useMemo(() => {
    if (!isTextTemplateSource) return [];
    const list = staticTextTemplateMap.get(pickerSource) || [];
    const q = mentionQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((item) => `${item.title} ${item.content}`.toLowerCase().includes(q));
  }, [isTextTemplateSource, mentionQuery, pickerSource, staticTextTemplateMap]);
  const mentionAssetMap = useMemo(() => {
    const map = new Map<string, StudioAsset>();
    const merged = dedupeById([
      ...uploadCandidates,
      ...generatedCandidates,
      ...savedCandidates,
      ...officialAssets,
      ...staticCandidates,
    ]);
    merged.forEach((item) => {
      const id = String(item.id || '').trim();
      if (!id) return;
      map.set(id, item);
    });
    return map;
  }, [generatedCandidates, officialAssets, savedCandidates, staticCandidates, uploadCandidates]);
  const referenceBySlot = useMemo(() => {
    const map = new Map<string, ComposerReference>();
    references.forEach((ref) => {
      const slot = String(ref.slot || '').trim();
      if (!slot) return;
      map.set(slot, ref);
    });
    return map;
  }, [references]);

  const highlightedSlots = useMemo(() => new Set(references.map((ref) => ref.slot)), [references]);
  const composerHighlightSegments = useMemo(
    () => splitComposerTextByMentions(text, highlightedSlots, referenceBySlot, mentionAssetMap),
    [highlightedSlots, mentionAssetMap, referenceBySlot, text],
  );

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setMentionQuery('');
    setMentionStart(-1);
    setPickerError('');
  }, []);

  const openPickerFromText = useCallback((value: string, caret: number) => {
    const mention = detectMentionContext(value, caret);
    if (!mention) {
      closePicker();
      return;
    }
    setPickerOpen(true);
    setMentionStart(mention.start);
    setMentionQuery(mention.query);
    setPickerError('');
  }, [closePicker]);

  useEffect(() => {
    if (!pickerOpen) return;
    function handleOutsidePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (dockRootRef.current?.contains(target)) return;
      closePicker();
    }
    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    };
  }, [closePicker, pickerOpen]);

  const insertReferenceAsset = useCallback(
    (asset: StudioAsset, source: MentionAssetSource, replaceMention = true) => {
      const slot = nextAvailableSlot(references);
      if (!slot) {
        setPickerError('同一条消息最多可引用 9 张图片素材。');
        return;
      }

      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? text.length;
      const start = replaceMention && mentionStart >= 0 ? mentionStart : caret;
      const token = `@${slot}`;
      const nextText = `${text.slice(0, start)}${token} ${text.slice(caret)}`;
      const nextReferences: ComposerReference[] = [
        ...references,
        {
          mention_id: `mention-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          slot,
          asset_id: asset.id,
          source,
          order: references.length + 1,
          asset_title: asset.title,
        },
      ];

      onTextChange(nextText);
      onReferencesChange(nextReferences);
      closePicker();

      window.setTimeout(() => {
        const target = textareaRef.current;
        if (!target) return;
        const cursor = start + token.length + 1;
        target.focus();
        target.setSelectionRange(cursor, cursor);
      }, 0);
    },
    [closePicker, mentionStart, onReferencesChange, onTextChange, references, text],
  );

  const insertTextTemplate = useCallback(
    (templateContent: string, replaceMention = true) => {
      const normalized = String(templateContent || '').trim();
      if (!normalized) {
        setPickerError('模板内容为空，无法插入');
        return;
      }
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? text.length;
      const start = replaceMention && mentionStart >= 0 ? mentionStart : caret;
      const left = text.slice(0, start);
      const right = text.slice(caret);
      const needsPrefixNewline = left.trim().length > 0 && !/[\s\n]$/.test(left);
      const needsSuffixNewline = right.trim().length > 0 && !/^[\s\n]/.test(right);
      const inserted = `${needsPrefixNewline ? '\n' : ''}${normalized}${needsSuffixNewline ? '\n' : ''}`;
      const nextText = `${left}${inserted}${right}`;

      onTextChange(nextText);
      closePicker();
      window.setTimeout(() => {
        const target = textareaRef.current;
        if (!target) return;
        const cursor = left.length + inserted.length;
        target.focus();
        target.setSelectionRange(cursor, cursor);
      }, 0);
    },
    [closePicker, mentionStart, onTextChange, text],
  );

  const appendUploadedAssetsToComposer = useCallback((assets: StudioAsset[]) => {
    if (assets.length === 0) {
      return { insertedCount: 0, skippedCount: 0 };
    }

    let nextText = latestTextRef.current;
    let nextReferences = [...latestReferencesRef.current];
    let insertedCount = 0;

    for (const asset of assets) {
      if (!asset.id) continue;
      if (nextReferences.some((item) => item.asset_id === asset.id)) {
        continue;
      }

      const slot = nextAvailableSlot(nextReferences);
      if (!slot) break;

      const token = `@${slot}`;
      nextText = nextText
        ? `${nextText}${/\s$/.test(nextText) ? '' : ' '}${token} `
        : `${token} `;
      nextReferences.push({
        mention_id: `mention-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        slot,
        asset_id: asset.id,
        source: sourceFromAsset(asset),
        order: nextReferences.length + 1,
        asset_title: asset.title,
      });
      insertedCount += 1;
    }

    if (insertedCount > 0) {
      onTextChange(nextText);
      onReferencesChange(nextReferences);
      window.setTimeout(() => {
        const target = textareaRef.current;
        if (!target) return;
        const cursor = nextText.length;
        target.focus();
        target.setSelectionRange(cursor, cursor);
      }, 0);
    }

    return {
      insertedCount,
      skippedCount: Math.max(0, assets.length - insertedCount),
    };
  }, [onReferencesChange, onTextChange]);

  useEffect(() => {
    if (!insertAssetRequest) return;
    if (handledInsertNonceRef.current === insertAssetRequest.nonce) return;
    handledInsertNonceRef.current = insertAssetRequest.nonce;
    insertReferenceAsset(insertAssetRequest.asset, insertAssetRequest.source, false);
    onConsumeInsertAssetRequest();
  }, [insertAssetRequest, insertReferenceAsset, onConsumeInsertAssetRequest]);

  function handleTextareaChange(nextText: string, caret: number) {
    onTextChange(nextText);
    const synced = syncReferencesWithText(
      nextText,
      references,
      annotationPreservedMentionIds,
    );
    if (!sameReferenceOrder(synced, references)) {
      onReferencesChange(synced);
    }
    openPickerFromText(nextText, caret);
  }

  function handleRemoveReference(refItem: ComposerReference) {
    const nextText = text.replace(new RegExp(`@${refItem.slot}\\s*`, 'g'), '').replace(/\s{2,}/g, ' ');
    onTextChange(nextText);
    onReferencesChange(references.filter((item) => item.mention_id !== refItem.mention_id));
  }

  const handlePreviewReference = useCallback(
    (refItem: ComposerReference) => {
      const asset = mentionAssetMap.get(String(refItem.asset_id || '').trim());
      const url = resolveAssetUrl(String(asset?.file_url || asset?.thumbnail_url || ''));
      if (!url) return;
      setMentionPreview({
        url,
        title: refItem.asset_title || asset?.title || `@${refItem.slot}`,
      });
    },
    [mentionAssetMap],
  );

  async function handleMentionUpload(files: File[], options?: { autoInsertToComposer?: boolean }) {
    const imageFiles = collectImageFiles(files);
    if (imageFiles.length === 0) {
      if (files.length > 0) {
        setPickerError('仅支持图片文件上传');
      }
      return;
    }

    setPickerUploading(true);
    try {
      const items = await onUploadFiles(imageFiles);
      setPickerUploads((prev) => dedupeById(items.concat(prev)));
      setPickerSource('upload');
      if (options?.autoInsertToComposer) {
        const { insertedCount, skippedCount } = appendUploadedAssetsToComposer(items);
        if (insertedCount === 0 && skippedCount > 0) {
          setPickerError('同一条消息最多可引用 9 张图片素材');
        } else if (skippedCount > 0) {
          setPickerError(`已上传 ${items.length} 张，自动插入 ${insertedCount} 张（最多 9 张）`);
        } else {
          setPickerError('');
        }
      } else {
        setPickerError('');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传失败';
      setPickerError(message);
    } finally {
      setPickerUploading(false);
    }
  }

  function handleComposerDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasImageDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current += 1;
    if (!composerDropUploading) {
      setComposerDropActive(true);
    }
  }

  function handleComposerDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasImageDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    if (!composerDropUploading) {
      setComposerDropActive(true);
    }
  }

  function handleComposerDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasImageDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) {
      setComposerDropActive(false);
    }
  }

  async function handleComposerDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasImageDataTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = 0;
    setComposerDropActive(false);

    const files = collectImageFiles(event.dataTransfer.files);
    if (files.length === 0 || composerDropUploading) {
      return;
    }

    setComposerDropUploading(true);
    try {
      await handleMentionUpload(files, { autoInsertToComposer: true });
    } finally {
      setComposerDropUploading(false);
    }
  }

  async function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = collectClipboardImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (composerDropUploading || pickerUploading) {
      setPickerError('图片上传中，请稍后再试');
      return;
    }

    setComposerDropUploading(true);
    setComposerDropActive(false);
    composerDragDepthRef.current = 0;
    try {
      await handleMentionUpload(files, { autoInsertToComposer: true });
    } finally {
      setComposerDropUploading(false);
    }
  }

  const pickerPanel = pickerOpen ? (
    <Box
      sx={{
        position: 'absolute',
        bottom: 'calc(100% + 10px)',
        left: 0,
        right: 0,
        width: '100%',
        borderRadius: 0.8,
        border: '1px solid rgba(0,0,0,0.08)',
        bgcolor: '#faf8f5',
        boxShadow: '0 10px 30px rgba(0,0,0,0.12)',
        overflow: 'hidden',
        zIndex: 120,
      }}
    >
      <Box sx={{ p: 1.3 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Tabs
            value={pickerSource}
            onChange={(_event, value) => setPickerSource(String(value))}
            sx={{
              minHeight: 34,
              '& .MuiTab-root': {
                minHeight: 34,
                py: 0.2,
                px: 1.35,
                mr: 0.5,
                textTransform: 'none',
                fontWeight: 600,
                fontSize: 13,
                borderRadius: 1.5,
                color: '#6b7280',
                bgcolor: 'rgba(0,0,0,0.04)',
              },
              '& .Mui-selected': {
                bgcolor: 'rgba(0,0,0,0.08)',
                color: '#2a2a2a',
              },
              '& .MuiTabs-indicator': {
                display: 'none',
              },
            }}
          >
            {enabledSources.map((source) => (
              <Tab key={source.id} label={source.name} value={source.id} />
            ))}
          </Tabs>
          <Stack direction="row" spacing={0.7}>
            <input
              ref={mentionUploadRef}
              type="file"
              multiple
              hidden
              accept="image/*"
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = '';
                void handleMentionUpload(files);
              }}
            />
            {!isTextTemplateSource ? (
              <IconButton
                size="small"
                onClick={() => mentionUploadRef.current?.click()}
                disabled={pickerUploading}
                sx={{
                  border: '1px solid rgba(0,0,0,0.08)',
                  bgcolor: 'rgba(0,0,0,0.03)',
                }}
              >
                {pickerUploading ? <CircularProgress size={16} /> : <AttachFileRoundedIcon sx={{ fontSize: 18 }} />}
              </IconButton>
            ) : null}
            <IconButton
              size="small"
              onClick={closePicker}
              sx={{
                border: '1px solid rgba(0,0,0,0.08)',
                bgcolor: 'rgba(0,0,0,0.03)',
              }}
            >
              <CloseRoundedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Stack>
        </Stack>

        <TextField
          size="small"
          fullWidth
          value={mentionQuery}
          onChange={(event) => setMentionQuery(event.target.value)}
          placeholder={mentionSearchPlaceholder}
          sx={{ mt: 1 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchRoundedIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />

        <Box
          sx={{
            mt: 1,
            borderRadius: 0.8,
            border: '1px dashed rgba(0,0,0,0.1)',
            bgcolor: 'rgba(0,0,0,0.02)',
            minHeight: 300,
            maxHeight: '52vh',
            overflowY: 'auto',
            p: 1,
          }}
        >
          {pickerSource === 'upload' && !isTextTemplateSource ? (
            <Button
              fullWidth
              variant="outlined"
              startIcon={pickerUploading ? <CircularProgress size={14} /> : <AttachFileRoundedIcon />}
              onClick={() => mentionUploadRef.current?.click()}
              disabled={pickerUploading}
              sx={{ mb: 1, borderStyle: 'dashed' }}
            >
              {mentionUploadButtonText}
            </Button>
          ) : null}

          {pickerSource === 'official' ? (
            <>
              <Stack direction="row" spacing={0.8} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
                <Box
                  component="select"
                  value={officialFilters.scene}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onOfficialFilterChange({ scene: e.target.value })}
                  style={{ height: 28, borderRadius: 6, border: '1px solid rgba(0,0,0,0.08)', fontSize: 12, padding: '0 8px', background: 'rgba(0,0,0,0.03)', color: '#2a2a2a' }}
                >
                  <option value="">场景</option>
                  {(officialTaxonomies.scene || []).map((s) => (<option key={s} value={s}>{s}</option>))}
                </Box>
                <Box
                  component="select"
                  value={officialFilters.style}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onOfficialFilterChange({ style: e.target.value })}
                  style={{ height: 28, borderRadius: 6, border: '1px solid rgba(0,0,0,0.08)', fontSize: 12, padding: '0 8px', background: 'rgba(0,0,0,0.03)', color: '#2a2a2a' }}
                >
                  <option value="">风格</option>
                  {(officialTaxonomies.style || []).map((s) => (<option key={s} value={s}>{s}</option>))}
                </Box>
                <Box
                  component="select"
                  value={officialFilters.material}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onOfficialFilterChange({ material: e.target.value })}
                  style={{ height: 28, borderRadius: 6, border: '1px solid rgba(0,0,0,0.08)', fontSize: 12, padding: '0 8px', background: 'rgba(0,0,0,0.03)', color: '#2a2a2a' }}
                >
                  <option value="">材质</option>
                  {(officialTaxonomies.material || []).map((s) => (<option key={s} value={s}>{s}</option>))}
                </Box>
                <Box
                  component="select"
                  value={officialFilters.lighting}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onOfficialFilterChange({ lighting: e.target.value })}
                  style={{ height: 28, borderRadius: 6, border: '1px solid rgba(0,0,0,0.08)', fontSize: 12, padding: '0 8px', background: 'rgba(0,0,0,0.03)', color: '#2a2a2a' }}
                >
                  <option value="">光照</option>
                  {(officialTaxonomies.lighting || []).map((s) => (<option key={s} value={s}>{s}</option>))}
                </Box>
                <IconButton size="small" onClick={onOfficialReload} sx={{ width: 28, height: 28, border: '1px solid rgba(0,0,0,0.08)', bgcolor: 'rgba(0,0,0,0.03)' }}>
                  <SearchRoundedIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Stack>
            </>
          ) : null}

          {isTextTemplateSource ? (
            currentTextTemplates.length > 0 ? (
              <Stack spacing={0.8}>
                {currentTextTemplates.map((item) => (
                  <Box
                    key={item.id}
                    onClick={() => insertTextTemplate(item.content, true)}
                    sx={{
                      p: 1,
                      borderRadius: 0.7,
                      border: '1px solid rgba(0,0,0,0.08)',
                      bgcolor: '#ffffff',
                      cursor: 'pointer',
                      '&:hover': {
                        borderColor: 'rgba(0,0,0,0.14)',
                        bgcolor: 'rgba(0,0,0,0.015)',
                      },
                    }}
                  >
                    <Typography variant="caption" sx={{ display: 'block', fontWeight: 700, color: '#2a2a2a' }}>
                      {item.title}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{ display: 'block', color: '#5d6572', mt: 0.35, whiteSpace: 'pre-wrap' }}
                    >
                      {item.content}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            ) : (
              <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 230, color: '#6b7280' }} spacing={0.8}>
                <AutoAwesomeRoundedIcon />
                <Typography variant="body2" fontWeight={700}>
                  当前来源暂无文字模板
                </Typography>
                <Typography variant="caption">在设置里新增文字条目后，这里可直接一键插入</Typography>
              </Stack>
            )
          ) : currentCandidates.length > 0 ? (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: {
                  xs: 'repeat(2, minmax(0, 1fr))',
                  sm: 'repeat(3, minmax(0, 1fr))',
                  md: 'repeat(4, minmax(0, 1fr))',
                },
                gap: 0.9,
              }}
            >
              {currentCandidates.map((asset) => (
                <Box
                  key={asset.id}
                  onClick={() => insertReferenceAsset(asset, pickerSource === 'saved' ? 'library' : pickerSource, true)}
                  sx={{
                    borderRadius: 0.6,
                    border: '1px solid rgba(0,0,0,0.06)',
                    bgcolor: '#ffffff',
                    overflow: 'hidden',
                    cursor: 'pointer',
                    '&:hover': {
                      borderColor: 'rgba(0,0,0,0.12)',
                      transform: 'translateY(-1px)',
                    },
                  }}
                >
                  <Box
                    component="img"
                    src={resolveAssetUrl(asset.thumbnail_url || asset.file_url)}
                    alt={asset.title || asset.id}
                    sx={{
                      width: '100%',
                      height: 'auto',
                      maxHeight: 160,
                      objectFit: 'contain',
                      display: 'block',
                      bgcolor: '#f0ece6',
                    }}
                  />
                  <Typography sx={{ px: 0.9, py: 0.7, fontSize: 12, fontWeight: 600, color: '#2a2a2a' }} noWrap>
                    {asset.title || asset.id}
                  </Typography>
                </Box>
              ))}
            </Box>
          ) : (
            <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 230, color: '#6b7280' }} spacing={0.8}>
              <AttachFileRoundedIcon />
              <Typography variant="body2" fontWeight={700}>
                当前来源暂无素材
              </Typography>
              <Typography variant="caption">在这里选择素材并插入为 @图N 引用</Typography>
            </Stack>
          )}

          {pickerSource === 'official' && officialPrompts.length > 0 ? (
            <>
              <Typography variant="caption" sx={{ mt: 1.5, mb: 0.5, display: 'block', fontWeight: 600, color: '#2a2a2a' }}>
                官方提示词
              </Typography>
              <Stack spacing={0.6}>
                {officialPrompts.slice(0, 5).map((prompt) => (
                  <Box
                    key={prompt.id}
                    onClick={() => {
                      onTextChange(text.trim() ? `${text}\n${prompt.content}` : prompt.content);
                      closePicker();
                    }}
                    sx={{
                      p: 1,
                      borderRadius: 0.6,
                      border: '1px solid rgba(0,0,0,0.06)',
                      bgcolor: '#ffffff',
                      cursor: 'pointer',
                      '&:hover': { borderColor: 'rgba(0,0,0,0.12)', bgcolor: 'rgba(0,0,0,0.02)' },
                    }}
                  >
                    <Typography variant="caption" fontWeight={600} sx={{ color: '#2a2a2a' }}>
                      {prompt.title}
                    </Typography>
                    <Typography variant="caption" sx={{ display: 'block', color: '#6b7280', mt: 0.3 }} noWrap>
                      {prompt.content}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </>
          ) : null}

          {pickerSource === 'official' && officialHasMore ? (
            <Button
              variant="text"
              size="small"
              fullWidth
              onClick={onOfficialLoadMore}
              disabled={officialLoading}
              sx={{ mt: 1.5, color: '#2a2a2a', fontWeight: 600 }}
            >
              {officialLoading ? '加载中...' : '加载更多'}
            </Button>
          ) : null}
        </Box>

        {pickerError ? (
          <Typography variant="caption" sx={{ pt: 0.8, display: 'block', color: '#b2433d', fontWeight: 700 }}>
            {pickerError}
          </Typography>
        ) : null}
      </Box>
    </Box>
  ) : null;

  return (
    <Box
      ref={dockRootRef}
      sx={{ 
        position: 'absolute',
        bottom: 14,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(800px, calc(100% - 24px))',
        zIndex: annotationActive ? 180 : 100,
      }}
    >
      {pickerPanel}
      <Box
        sx={{
          borderRadius: 0.8,
          border: composerDropActive || composerDropUploading
            ? '1px solid rgba(138,91,53,0.44)'
            : '1px solid rgba(0,0,0,0.08)',
          bgcolor: 'rgba(255,255,255,0.95)',
          backdropFilter: 'blur(10px)',
          p: { xs: 1.5, md: 2 },
          transform: composerDropActive || composerDropUploading ? 'translateY(-4px)' : 'translateY(0)',
          transition: 'transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease',
          boxShadow: composerDropActive || composerDropUploading
            ? '0 14px 28px rgba(122, 84, 50, 0.2)'
            : 'none',
        }}
      >
        <Stack direction="row" alignItems="center" spacing={0.8}>
          <Chip
            size="small"
            icon={<AutoAwesomeRoundedIcon sx={{ fontSize: 14 }} />}
            label="现代简约改造"
            sx={{
              borderRadius: 6,
              bgcolor: 'rgba(0,0,0,0.04)',
              border: 'none',
              '& .MuiChip-label': { fontWeight: 500, fontSize: 12 },
              '& .MuiChip-icon': { color: '#6b7280' },
            }}
          />
          <IconButton
            size="small"
            onClick={() => setQuickTemplateDialogOpen(true)}
            sx={{
              width: 24,
              height: 24,
              color: '#6b7280',
            }}
          >
            <AddRoundedIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Stack>

        <Box
          sx={{ mt: 1.5, position: 'relative' }}
          onDragEnter={handleComposerDragEnter}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={(event) => {
            void handleComposerDrop(event);
          }}
        >
          <Box
            sx={{
              display: 'grid',
              minHeight: 74,
              position: 'relative',
              borderRadius: 1.2,
              px: 0.8,
              py: 0.7,
              bgcolor: composerDropActive || composerDropUploading
                ? 'rgba(138, 91, 53, 0.07)'
                : 'transparent',
              outline: composerDropActive || composerDropUploading
                ? '1.5px dashed rgba(138, 91, 53, 0.45)'
                : 'none',
              transition: 'background-color 120ms ease, outline-color 120ms ease',
            }}
          >
            <Box
              aria-hidden
              sx={{
                gridArea: '1 / 1',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'inherit',
                fontSize: '15px',
                lineHeight: 1.55,
                color: '#2a2a2a',
                pointerEvents: 'none',
              }}
            >
              {composerHighlightSegments.map((segment, idx) => (
                segment.mentionThumbnailUrl ? (
                  <Box
                    key={`${segment.content}-${idx}`}
                    component="span"
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.45,
                      px: 0.45,
                      py: 0.1,
                      mr: 0.25,
                      borderRadius: 0.8,
                      bgcolor: segment.highlighted ? 'rgba(195, 132, 76, 0.18)' : 'rgba(62, 100, 168, 0.12)',
                      border: segment.highlighted ? '1px solid rgba(195, 132, 76, 0.36)' : '1px solid rgba(62, 100, 168, 0.24)',
                      color: '#2e4f7e',
                      verticalAlign: 'middle',
                      boxDecorationBreak: 'clone',
                      WebkitBoxDecorationBreak: 'clone',
                    }}
                  >
                    <Box
                      component="img"
                      src={segment.mentionThumbnailUrl}
                      alt={segment.mentionTitle || segment.content}
                      sx={{
                        width: 17,
                        height: 17,
                        borderRadius: 0.5,
                        objectFit: 'cover',
                        display: 'block',
                        border: '1px solid rgba(87, 122, 186, 0.3)',
                        flexShrink: 0,
                      }}
                    />
                    <Box component="span" sx={{ fontWeight: 600 }}>
                      {segment.content}
                    </Box>
                  </Box>
                ) : (
                  <Box
                    key={`${segment.content}-${idx}`}
                    component="span"
                    sx={segment.highlighted ? {
                      bgcolor: segment.objectToken ? 'rgba(123, 165, 120, 0.24)' : 'rgba(195, 132, 76, 0.26)',
                      color: segment.objectToken ? '#2f5f34' : '#6d4423',
                      borderRadius: 0.8,
                      boxDecorationBreak: 'clone',
                      WebkitBoxDecorationBreak: 'clone',
                    } : undefined}
                  >
                    {segment.content}
                  </Box>
                )
              ))}
              {text.length === 0 ? <Box component="span" sx={{ color: '#8f857a' }}>{mentionComposerPlaceholder}</Box> : null}
            </Box>
            <Box
              ref={textareaRef}
              component="textarea"
              value={text}
              onChange={(event) =>
                handleTextareaChange(event.target.value, event.target.selectionStart ?? event.target.value.length)
              }
              onClick={(event) =>
                openPickerFromText(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)
              }
              onFocus={(event) =>
                openPickerFromText(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)
              }
              onKeyUp={(event) =>
                openPickerFromText(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  if (event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (!sendDisabled) {
                    onSend();
                  }
                  return;
                }
                if (event.key === 'Escape') closePicker();
              }}
              onPaste={(event) => {
                void handleComposerPaste(event);
              }}
              placeholder={mentionComposerPlaceholder}
              rows={3}
              sx={{
                gridArea: '1 / 1',
                width: '100%',
                border: 'none',
                outline: 'none',
                resize: 'vertical',
                background: 'transparent',
                fontFamily: 'inherit',
                fontSize: '15px',
                lineHeight: 1.55,
                color: 'transparent',
                WebkitTextFillColor: 'transparent',
                caretColor: '#2a2a2a',
                p: 0,
                m: 0,
                '&::placeholder': {
                  color: 'transparent',
                },
              }}
            />
          </Box>

          {composerDropActive || composerDropUploading ? (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                borderRadius: 1.2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'none',
                zIndex: 3,
                bgcolor: 'rgba(247, 239, 231, 0.86)',
              }}
            >
              <Stack spacing={0.7} alignItems="center" sx={{ color: '#6f4d2f' }}>
                {composerDropUploading ? <CircularProgress size={20} /> : <AttachFileRoundedIcon sx={{ fontSize: 22 }} />}
                <Typography variant="caption" sx={{ fontWeight: 700 }}>
                  {composerDropUploading ? '正在上传并插入当前消息...' : '松手上传并自动插入当前消息'}
                </Typography>
              </Stack>
            </Box>
          ) : null}

          <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap" sx={{ mt: 0.6 }}>
            {references.map((refItem) => {
              const matchedAsset = mentionAssetMap.get(String(refItem.asset_id || '').trim());
              const thumb = resolveAssetUrl(String(matchedAsset?.thumbnail_url || matchedAsset?.file_url || ''));
              return (
                <MentionRefChip
                  key={refItem.mention_id}
                  refItem={refItem}
                  thumbnailUrl={thumb || undefined}
                  onPreview={handlePreviewReference}
                  onRemove={handleRemoveReference}
                  onAnnotate={(item) => onAnnotateReference(item)}
                />
              );
            })}
          </Stack>
        </Box>

        <Stack spacing={0.7} sx={{ mt: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            {/* Left: Mode Toggle */}
            <Stack direction="row" spacing={0.5} alignItems="center">
              <ToggleButtonGroup
                size="small"
                exclusive
                value={mode}
                onChange={(_event, value) => {
                  if (value === 'image' || value === 'text') {
                    onModeChange(value);
                  }
                }}
                sx={{
                  '& .MuiToggleButton-root': {
                    border: 'none',
                    color: '#6b7280',
                    bgcolor: 'transparent',
                    borderRadius: '6px !important',
                    px: 1,
                    py: 0.4,
                    textTransform: 'none',
                    fontSize: 12,
                    fontWeight: 500,
                  },
                  '& .Mui-selected': {
                    bgcolor: 'rgba(0,0,0,0.06) !important',
                    color: '#1a1a1a !important',
                  },
                }}
              >
                <ToggleButton value="image">
                  <Stack direction="row" spacing={0.4} alignItems="center">
                    <ImageRoundedIcon sx={{ fontSize: 14 }} />
                    <span>Image</span>
                  </Stack>
                </ToggleButton>
                <ToggleButton value="text">
                  <Stack direction="row" spacing={0.4} alignItems="center">
                    <AutoAwesomeRoundedIcon sx={{ fontSize: 14 }} />
                    <span>Text</span>
                  </Stack>
                </ToggleButton>
              </ToggleButtonGroup>
            </Stack>
            <Box sx={{ flex: 1 }} />

            <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap" justifyContent="flex-end">
              {mode === 'image' ? (
                <Box
                  component="select"
                  value={params.model}
                  onChange={(event) => onParamsChange({ model: event.target.value })}
                  sx={{ ...PARAM_SELECT_BASE_SX, width: { xs: '100%', sm: 126 } }}
                  aria-label="模型"
                >
                  {modelOptions.map((item) => (
                    <option key={String(item.value)} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </Box>
              ) : null}
              {mode === 'text' ? (
                <Button
                  size="small"
                  onClick={() => onTextPromptPackEnabledChange(!textPromptPackEnabled)}
                  sx={{
                    height: 30,
                    minWidth: 88,
                    borderRadius: 1.6,
                    border: '1px solid rgba(129, 102, 77, 0.22)',
                    bgcolor: textPromptPackEnabled ? 'rgba(138, 91, 53, 0.16)' : '#ede6de',
                    color: textPromptPackEnabled ? '#6a4528' : '#72553c',
                    fontWeight: 700,
                    px: 1.1,
                  }}
                >
                  分步生图词
                </Button>
              ) : null}
              <IconButton
                size="small"
                onClick={() => inputRef.current?.click()}
                sx={{
                  width: 30,
                  height: 30,
                  borderRadius: 1.6,
                  border: '1px solid rgba(129, 102, 77, 0.18)',
                  bgcolor: '#ede6de',
                  color: '#72553c',
                }}
              >
                <ImageRoundedIcon sx={{ fontSize: 16 }} />
              </IconButton>
              {mode === 'image' ? (
                <>
                  <Box
                    component="select"
                    value={params.aspect_ratio}
                    onChange={(event) => onParamsChange({ aspect_ratio: event.target.value })}
                    sx={{ ...PARAM_SELECT_BASE_SX, width: { xs: 'calc(50% - 4px)', sm: 74 } }}
                    aria-label="比例"
                  >
                    {ratioOptions.map((item) => (
                      <option key={String(item.value)} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </Box>
                  <Box
                    component="select"
                    value={params.quality}
                    onChange={(event) => onParamsChange({ quality: event.target.value })}
                    sx={{ ...PARAM_SELECT_BASE_SX, width: { xs: 'calc(50% - 4px)', sm: 70 } }}
                    aria-label="清晰度"
                  >
                    {qualityOptions.map((item) => (
                      <option key={String(item.value)} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </Box>
                  <Box
                    component="select"
                    value={params.count}
                    onChange={(event) => onParamsChange({ count: Number(event.target.value) })}
                    sx={{ ...PARAM_SELECT_BASE_SX, width: { xs: 'calc(50% - 4px)', sm: 84 } }}
                    aria-label="同时生成"
                  >
                    {countOptions.map((item) => (
                      <option key={String(item.value)} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </Box>
                </>
              ) : null}
              <Button
                variant="contained"
                disabled={sendDisabled}
                onClick={onSend}
                sx={{
                  minWidth: 30,
                  width: 30,
                  height: 30,
                  borderRadius: 1.6,
                  p: 0,
                  bgcolor: '#8a5b35',
                  '&:hover': { bgcolor: '#744b2c' },
                }}
              >
                <SendRoundedIcon sx={{ fontSize: 16 }} />
              </Button>
            </Stack>
          </Stack>
          {sendBlockedReason ? (
            <Typography variant="caption" sx={{ color: '#b2433d', fontWeight: 700 }}>
              {sendBlockedReason}
            </Typography>
          ) : sendQueueHint ? (
            <Typography variant="caption" sx={{ color: '#7a6b5d', fontWeight: 600 }}>
              {sendQueueHint}
            </Typography>
          ) : mode === 'text' && textPromptPackEnabled ? (
            <Typography variant="caption" sx={{ color: '#7a6b5d', fontWeight: 600 }}>
              已开启分步生图词：先返回3个方案，再生成3条可生图提示词
            </Typography>
          ) : null}
        </Stack>

        {/* Hidden file input for upload */}
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept="image/*"
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            void handleMentionUpload(files);
          }}
        />
      </Box>

      <Dialog
        open={Boolean(mentionPreview)}
        onClose={() => setMentionPreview(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{mentionPreview?.title || '素材预览'}</DialogTitle>
        <DialogContent sx={{ pt: 1 }}>
          {mentionPreview?.url ? (
            <Box
              component="img"
              src={mentionPreview.url}
              alt={mentionPreview.title || 'mention-preview'}
              sx={{
                width: '100%',
                maxHeight: '70vh',
                objectFit: 'contain',
                borderRadius: 1,
                border: '1px solid #e5eaf2',
                bgcolor: '#f7f9fc',
              }}
            />
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMentionPreview(null)}>关闭</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={quickTemplateDialogOpen}
        onClose={() => setQuickTemplateDialogOpen(false)}
        fullWidth
        maxWidth="md"
        PaperProps={{
          sx: {
            borderRadius: 3,
            bgcolor: '#f3eee7',
            border: '1px solid rgba(124, 94, 67, 0.15)',
          },
        }}
      >
        <DialogTitle sx={{ fontWeight: 800, color: '#2d2a26', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
          新建快捷输入模板
        </DialogTitle>
        <DialogContent sx={{ pt: '18px !important' }}>
          <Stack spacing={1.2}>
            <Typography variant="caption" sx={{ fontWeight: 700, color: '#5f4c39' }}>
              模板名称 *
            </Typography>
            <TextField
              value={quickTemplateName}
              onChange={(event) => setQuickTemplateName(event.target.value)}
              placeholder="例如：现代简约风格"
              size="small"
              fullWidth
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: '#f7f3ed',
                  borderRadius: 1.5,
                },
              }}
            />

            <Typography variant="caption" sx={{ fontWeight: 700, color: '#5f4c39', mt: 0.6 }}>
              快捷输入内容 *
            </Typography>
            <TextField
              value={quickTemplateContent}
              onChange={(event) => setQuickTemplateContent(event.target.value)}
              placeholder=""
              multiline
              minRows={11}
              fullWidth
              sx={{
                '& .MuiOutlinedInput-root': {
                  bgcolor: '#f7f3ed',
                  borderRadius: 1.5,
                  alignItems: 'flex-start',
                },
              }}
            />

            <Typography variant="caption" sx={{ color: '#7f6a55' }}>
              语法：{'{{text:名称|placeholder=提示|default=默认}}'} / {'{{select:名称|options=展示1,展示2|default=展示名}}'} / {'{{image:名称}}'}
            </Typography>

            <FormControlLabel
              control={
                <Switch
                  checked={quickTemplateIsDefault}
                  onChange={(event) => setQuickTemplateIsDefault(event.target.checked)}
                  size="small"
                />
              }
              label={
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 700, color: '#4d3d2d' }}>
                    设为默认模板
                  </Typography>
                  <Typography variant="caption" sx={{ color: '#84705b' }}>
                    自动使用此模板作为输入内容
                  </Typography>
                </Box>
              }
              sx={{ mt: 0.5 }}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.4 }}>
          <Button
            onClick={() => setQuickTemplateDialogOpen(false)}
            sx={{ color: '#805b3a', fontWeight: 700 }}
          >
            取消
          </Button>
          <Button
            variant="contained"
            disabled={!quickTemplateName.trim() || !quickTemplateContent.trim()}
            onClick={() => setQuickTemplateDialogOpen(false)}
            sx={{
              borderRadius: 6,
              px: 3,
              bgcolor: '#e1dbd3',
              color: '#6c655d',
              boxShadow: 'none',
            }}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
