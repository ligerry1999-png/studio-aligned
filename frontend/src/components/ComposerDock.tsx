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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { resolveAssetUrl } from '../api/client';
import type {
  ComposerReference,
  GenerationParams,
  MentionSettings,
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
  references: ComposerReference[];
  params: GenerationParams;
  options: StudioOptions | null;
  annotationActive?: boolean;
  sendDisabled?: boolean;
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
  onUploadFiles: (files: File[]) => Promise<StudioAsset[]>;
  onConsumeInsertAssetRequest: () => void;
  onAnnotateReference: (assetId: string) => void;
  onSend: () => void;
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

function syncReferencesWithText(text: string, refs: ComposerReference[]): ComposerReference[] {
  const slots = new Set(extractOrderedSlots(text));
  return refs.filter((ref) => slots.has(ref.slot));
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
}

function splitComposerTextByMentions(text: string, highlightedSlots: Set<string>): HighlightSegment[] {
  if (!text) return [{ content: '', highlighted: false }];
  const segments: HighlightSegment[] = [];
  const regex = /@图[1-9]|【对象[1-3]】/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const token = match[0];
    const tokenStart = match.index;
    if (tokenStart > lastIndex) {
      segments.push({ content: text.slice(lastIndex, tokenStart), highlighted: false });
    }
    if (token.startsWith('@')) {
      segments.push({ content: token, highlighted: highlightedSlots.has(token.slice(1)) });
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
  onRemove,
  onAnnotate,
}: {
  refItem: ComposerReference;
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
      <Typography variant="caption" sx={{ fontWeight: 600, color: '#ffffff' }}>
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
  references,
  params,
  options,
  annotationActive = false,
  sendDisabled = false,
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
  onUploadFiles,
  onConsumeInsertAssetRequest,
  onAnnotateReference,
  onSend,
}: ComposerDockProps) {
  const dockRootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mentionUploadRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mode, setMode] = useState<'image' | 'text' | 'video'>('image');

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSource, setPickerSource] = useState<string>('upload');
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);
  const [pickerError, setPickerError] = useState('');
  const [pickerUploading, setPickerUploading] = useState(false);
  const [pickerUploads, setPickerUploads] = useState<StudioAsset[]>([]);
  const [quickTemplateDialogOpen, setQuickTemplateDialogOpen] = useState(false);
  const [quickTemplateName, setQuickTemplateName] = useState('');
  const [quickTemplateContent, setQuickTemplateContent] = useState('');
  const [quickTemplateIsDefault, setQuickTemplateIsDefault] = useState(false);
  const handledInsertNonceRef = useRef<number>(0);

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

  const sortedSources = useMemo(() => {
    const list = mentionSettings?.sources || [
      { id: 'upload', name: '上传', enabled: true, order: 1, kind: 'dynamic', items: [] },
      { id: 'generated', name: '生成', enabled: true, order: 2, kind: 'dynamic', items: [] },
      { id: 'saved', name: '素材库', enabled: true, order: 3, kind: 'dynamic', items: [] },
      { id: 'official', name: '官方', enabled: true, order: 4, kind: 'dynamic', items: [] },
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

  const highlightedSlots = useMemo(() => new Set(references.map((ref) => ref.slot)), [references]);
  const composerHighlightSegments = useMemo(
    () => splitComposerTextByMentions(text, highlightedSlots),
    [highlightedSlots, text],
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

  useEffect(() => {
    if (!insertAssetRequest) return;
    if (handledInsertNonceRef.current === insertAssetRequest.nonce) return;
    handledInsertNonceRef.current = insertAssetRequest.nonce;
    insertReferenceAsset(insertAssetRequest.asset, insertAssetRequest.source, false);
    onConsumeInsertAssetRequest();
  }, [insertAssetRequest, insertReferenceAsset, onConsumeInsertAssetRequest]);

  function handleTextareaChange(nextText: string, caret: number) {
    onTextChange(nextText);
    const synced = syncReferencesWithText(nextText, references);
    if (synced.length !== references.length) {
      onReferencesChange(synced);
    }
    openPickerFromText(nextText, caret);
  }

  function handleRemoveReference(refItem: ComposerReference) {
    const nextText = text.replace(new RegExp(`@${refItem.slot}\\s*`, 'g'), '').replace(/\s{2,}/g, ' ');
    onTextChange(nextText);
    onReferencesChange(references.filter((item) => item.mention_id !== refItem.mention_id));
  }

  async function handleMentionUpload(files: File[]) {
    if (files.length === 0) return;
    setPickerUploading(true);
    try {
      const items = await onUploadFiles(files);
      setPickerUploads((prev) => dedupeById(items.concat(prev)));
      setPickerSource('upload');
      setPickerError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传失败';
      setPickerError(message);
    } finally {
      setPickerUploading(false);
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
          {pickerSource === 'upload' ? (
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

          {currentCandidates.length > 0 ? (
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
          border: '1px solid rgba(0,0,0,0.08)',
          bgcolor: 'rgba(255,255,255,0.95)',
          backdropFilter: 'blur(10px)',
          p: { xs: 1.5, md: 2 },
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

        <Box sx={{ mt: 1.5 }}>
          <Box sx={{ display: 'grid', minHeight: 74 }}>
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
                <Box
                  key={`${segment.content}-${idx}`}
                  component="span"
                  sx={segment.highlighted ? {
                    bgcolor: segment.objectToken ? 'rgba(123, 165, 120, 0.24)' : 'rgba(195, 132, 76, 0.26)',
                    color: segment.objectToken ? '#2f5f34' : '#6d4423',
                    borderRadius: 0.8,
                    px: 0.3,
                  } : undefined}
                >
                  {segment.content}
                </Box>
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
                if (event.key === 'Escape') closePicker();
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
                caretColor: '#2a2a2a',
                p: 0,
                m: 0,
                '&::placeholder': {
                  color: 'transparent',
                },
              }}
            />
          </Box>

          <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap" sx={{ mt: 0.6 }}>
            {references.map((refItem) => (
              <MentionRefChip
                key={refItem.mention_id}
                refItem={refItem}
                onRemove={handleRemoveReference}
                onAnnotate={(item) => onAnnotateReference(item.asset_id)}
              />
            ))}
          </Stack>
        </Box>

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
          {/* Left: Mode Toggle */}
          <Stack direction="row" spacing={0.5} alignItems="center">
            <ToggleButtonGroup
              size="small"
              exclusive
              value={mode}
              onChange={(_event, value) => {
                if (value) setMode(value);
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
            </ToggleButtonGroup>
          </Stack>

          <Box sx={{ flex: 1 }} />

          <Stack direction="row" spacing={0.7} useFlexGap flexWrap="wrap" justifyContent="flex-end">
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
            <Button
              variant="contained"
              disabled={sending || sendDisabled}
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
