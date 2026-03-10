import AddCircleOutlineRoundedIcon from '@mui/icons-material/AddCircleOutlineRounded';
import CopyAllRoundedIcon from '@mui/icons-material/CopyAllRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import EditNoteRoundedIcon from '@mui/icons-material/EditNoteRounded';
import {
  Button,
  Box,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import { resolveAssetUrl } from '../api/client';
import type { ComposerReference, GenerationParams, StudioAsset, StudioComposerMode, StudioMessage, WorkspaceDetail } from '../types/studio';

export type ImageAction = 'copy' | 'download' | 'add' | 'annotate' | 'zoom' | 'delete';

interface ChatThreadProps {
  workspace: WorkspaceDetail | null;
  onOpenAsset: (asset: StudioAsset) => void;
  onImageAction: (action: ImageAction, asset: StudioAsset) => void;
  onGenerateTextPromptImage: (payload: TextPromptImageSelectionPayload) => void;
  onSelectTextPromptOption: (payload: TextPromptOptionSelectionPayload) => void;
  bottomSpacerHeight?: number;
}

type TaskStatus = 'completed' | 'running' | 'failed';

interface TaskItem {
  id: string;
  mode: StudioComposerMode;
  text: string;
  assistantText: string;
  created_at?: string;
  params?: Partial<GenerationParams>;
  attachments: StudioAsset[];
  attachmentAssetIds: string[];
  references: ComposerReference[];
  images: StudioAsset[];
  status: TaskStatus;
  runningText: string;
}

export interface TextPromptOptionSelectionPayload {
  sourceTaskId: string;
  sourceText: string;
  optionId: string;
  title: string;
  summary: string;
  attachmentAssetIds: string[];
  references: ComposerReference[];
}

export interface TextPromptImageSelectionPayload {
  sourceTaskId: string;
  prompt: string;
  attachmentAssetIds: string[];
  references: ComposerReference[];
}

interface ParsedPhase1Option {
  id: string;
  title: string;
  summary: string;
}

interface ParsedPhase2Prompt {
  id: string;
  title: string;
  prompt: string;
}

interface ParsedPromptPackPhase1 {
  phase: 'phase1_options';
  options: ParsedPhase1Option[];
  anchors: string[];
  diagnosisPros: string[];
  diagnosisCons: string[];
  followUp: string;
}

interface ParsedPromptPackPhase2 {
  phase: 'phase2_prompts';
  prompts: ParsedPhase2Prompt[];
  selectedOptionTitle: string;
  followUp: string;
}

type ParsedPromptPack = ParsedPromptPackPhase1 | ParsedPromptPackPhase2;

function normalizeTaskStatus(value?: string): TaskStatus {
  if (value === 'running') return 'running';
  if (value === 'failed') return 'failed';
  return 'completed';
}

function normalizeMode(value?: string): StudioComposerMode {
  return value === 'text' ? 'text' : 'image';
}

function elapsedSecondsFromCreatedAt(createdAt?: string, nowMs: number = Date.now()): number | null {
  if (!createdAt) return null;
  const startedAtMs = Date.parse(createdAt);
  if (Number.isNaN(startedAtMs)) return null;
  return Math.max(1, Math.floor((nowMs - startedAtMs) / 1000));
}

function buildRunningText(text: string, createdAt: string | undefined, nowMs: number): string {
  const base = (text || '正在生成中...').trim() || '正在生成中...';
  if (/已耗时\s*\d+s/.test(base)) return base;
  const elapsed = elapsedSecondsFromCreatedAt(createdAt, nowMs);
  if (!elapsed) return base;
  const normalizedBase = base.replace(/\s*\.{3}\s*$/, '').replace(/\s*…\s*$/, '').trim() || '正在生成中';
  return `${normalizedBase}... 已耗时 ${elapsed}s`;
}

function formatTaskMetaItems(params?: Partial<GenerationParams>): string[] {
  if (!params) return [];
  const items: string[] = [];
  if (params.model) items.push(`模型: ${String(params.model)}`);
  if (params.aspect_ratio) items.push(`比例: ${String(params.aspect_ratio)}`);
  if (params.quality) items.push(`清晰度: ${String(params.quality).toUpperCase()}`);
  if (params.count !== undefined) items.push(`数量: ${params.count}`);
  return items;
}

function isDeletedAsset(asset: StudioAsset): boolean {
  return asset.kind === 'deleted' || Boolean(asset.deleted);
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return null;
      }
    }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = raw.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractBalancedArrayAfterKey(raw: string, key: string): string | null {
  const keyPattern = new RegExp(`["']?${key}["']?\\s*:\\s*\\[`, 'i');
  const matched = keyPattern.exec(raw);
  if (!matched) return null;
  const startBracket = raw.indexOf('[', matched.index);
  if (startBracket < 0) return null;
  let depth = 0;
  let inString = false;
  let stringQuote = '"';
  let escaped = false;
  for (let i = startBracket; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(startBracket, i + 1);
      }
    }
  }
  return null;
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function parsePhase2PromptItem(item: unknown, index: number): ParsedPhase2Prompt | null {
  if (typeof item === 'string') {
    const prompt = item.trim();
    if (!prompt) return null;
    return {
      id: `p${index + 1}`,
      title: `提示词${index + 1}`,
      prompt,
    };
  }
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const prompt = normalizeText(row.prompt || row.content || row.text);
  if (!prompt) return null;
  const title = normalizeText(row.title || row.name || row.label) || `提示词${index + 1}`;
  const id = normalizeText(row.id) || `p${index + 1}`;
  return { id, title, prompt };
}

function parsePhase1OptionItem(item: unknown, index: number): ParsedPhase1Option | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as Record<string, unknown>;
  const title = normalizeText(row.title || row.name || row.label) || `方案${index + 1}`;
  const summary = normalizeText(row.summary || row.desc || row.description || row.content || row.text || row.prompt);
  if (!summary) return null;
  const id = normalizeText(row.id) || `opt${index + 1}`;
  return { id, title, summary };
}

function parseLegacyPromptRows(rows: unknown[], followUp = ''): ParsedPromptPackPhase2 | null {
  const prompts = rows
    .map((item, index) => parsePhase2PromptItem(item, index))
    .filter((item): item is ParsedPhase2Prompt => Boolean(item))
    .slice(0, 3);
  if (prompts.length === 0) return null;
  return {
    phase: 'phase2_prompts',
    prompts,
    selectedOptionTitle: '',
    followUp,
  };
}

function parsePhase1OptionRows(rows: unknown[], followUp = ''): ParsedPromptPackPhase1 | null {
  const options = rows
    .map((item, index) => parsePhase1OptionItem(item, index))
    .filter((item): item is ParsedPhase1Option => Boolean(item))
    .slice(0, 3);
  if (options.length === 0) return null;
  return {
    phase: 'phase1_options',
    options,
    anchors: [],
    diagnosisPros: [],
    diagnosisCons: [],
    followUp,
  };
}

function parsePromptPackByRecovery(raw: string): ParsedPromptPack | null {
  const source = String(raw || '').trim();
  if (!source) return null;

  const repaired = source
    .replace(/^\s*\{?\s*['"]?options['"]?\s*:/i, '{"options":')
    .replace(/,\s*['"]?follow[\s_]?up['"]?\s*:/i, ',"follow_up":');
  const repairedClosed = repaired.endsWith('}') ? repaired : `${repaired}}`;
  const repairedParsed = tryParseJson(repairedClosed);
  if (repairedParsed && typeof repairedParsed === 'object') {
    const payload = repairedParsed as Record<string, unknown>;
    const optionsRaw = Array.isArray(payload.options) ? payload.options : null;
    if (optionsRaw && optionsRaw.length > 0) {
      return (
        parseLegacyPromptRows(optionsRaw, normalizeText(payload.follow_up || payload.followUp))
        || parsePhase1OptionRows(optionsRaw, normalizeText(payload.follow_up || payload.followUp))
      );
    }
  }

  const optionsArrayText = extractBalancedArrayAfterKey(source, 'options');
  if (!optionsArrayText) return null;
  try {
    const rows = JSON.parse(optionsArrayText) as unknown[];
    const followMatch = source.match(/["']?follow[\s_]?up["']?\s*:\s*"([^"]*)"/i);
    return (
      parseLegacyPromptRows(rows, normalizeText(followMatch?.[1] || ''))
      || parsePhase1OptionRows(rows, normalizeText(followMatch?.[1] || ''))
    );
  } catch {
    return null;
  }
}

function parsePromptPack(text: string): ParsedPromptPack | null {
  const parsed = tryParseJson(String(text || '').trim());
  if (!parsed || typeof parsed !== 'object') {
    return parsePromptPackByRecovery(text);
  }
  const payload = parsed as Record<string, unknown>;
  const phase = normalizeText(payload.phase);
  const followUp = normalizeText(payload.follow_up || payload.followUp);

  if (phase === 'phase1_options') {
    const optionsRaw = Array.isArray(payload.options) ? payload.options : [];
    const options = optionsRaw
      .map((item, index) => parsePhase1OptionItem(item, index))
      .filter((item): item is ParsedPhase1Option => Boolean(item))
      .slice(0, 3);
    if (options.length === 0) return null;
    const diagnosis = payload.diagnosis && typeof payload.diagnosis === 'object'
      ? payload.diagnosis as Record<string, unknown>
      : {};
    return {
      phase: 'phase1_options',
      options,
      anchors: parseStringArray(payload.anchors),
      diagnosisPros: parseStringArray(diagnosis.pros),
      diagnosisCons: parseStringArray(diagnosis.cons),
      followUp,
    };
  }

  if (phase === 'phase2_prompts') {
    const promptsRaw = Array.isArray(payload.prompts)
      ? payload.prompts
      : Array.isArray(payload.options)
        ? payload.options
        : [];
    const prompts = promptsRaw
      .map((item, index) => parsePhase2PromptItem(item, index))
      .filter((item): item is ParsedPhase2Prompt => Boolean(item))
      .slice(0, 3);
    if (prompts.length === 0) return null;
    const selected = payload.selected_option && typeof payload.selected_option === 'object'
      ? payload.selected_option as Record<string, unknown>
      : {};
    const selectedOptionTitle = normalizeText(selected.title || payload.selected_option_title);
    return {
      phase: 'phase2_prompts',
      prompts,
      selectedOptionTitle,
      followUp,
    };
  }

  const listRaw = Array.isArray(payload.prompts)
    ? payload.prompts
    : Array.isArray(payload.options)
      ? payload.options
      : Array.isArray(payload.variants)
        ? payload.variants
        : null;
  if (!listRaw || listRaw.length === 0) {
    return parsePromptPackByRecovery(text);
  }
  return parsePhase1OptionRows(listRaw, followUp) || parseLegacyPromptRows(listRaw, followUp);
}

function mergeMessagesToTasks(messages: StudioMessage[]): TaskItem[] {
  const tasks: TaskItem[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    if (current.role !== 'user') continue;

    let assistant: StudioMessage | null = null;
    if (index + 1 < messages.length && messages[index + 1].role === 'assistant') {
      assistant = messages[index + 1];
      index += 1;
    }

    const status = normalizeTaskStatus(assistant?.status || current.status);
    const mode = normalizeMode(assistant?.mode || current.mode);
    const attachments = current.attachments || [];
    const references = Array.isArray(current.references)
      ? current.references
          .map((item, refIndex): ComposerReference | null => {
            if (!item) return null;
            const mentionId = normalizeText(item.mention_id) || `mention-${current.id}-${refIndex + 1}`;
            const slot = normalizeText(item.slot);
            const assetId = normalizeText(item.asset_id);
            if (!slot || !assetId) return null;
            const orderRaw = Number(item.order);
            const order = Number.isFinite(orderRaw) && orderRaw > 0 ? orderRaw : refIndex + 1;
            return {
              mention_id: mentionId,
              slot,
              asset_id: assetId,
              source: normalizeText(item.source),
              order,
              asset_title: normalizeText(item.asset_title),
            };
          })
          .filter((item): item is ComposerReference => Boolean(item))
      : [];
    const attachmentAssetIds: string[] = [];
    for (const aid of attachments.map((asset) => normalizeText(asset.id)).concat(references.map((item) => normalizeText(item.asset_id)))) {
      if (!aid || attachmentAssetIds.includes(aid)) continue;
      attachmentAssetIds.push(aid);
    }
    tasks.push({
      id: current.id,
      mode,
      text: current.text || '',
      assistantText: assistant?.text || '',
      created_at: current.created_at || assistant?.created_at,
      params: current.params || assistant?.params,
      attachments,
      attachmentAssetIds,
      references,
      images: assistant?.images || current.images || [],
      status,
      runningText: status === 'running' ? assistant?.text || '正在生成中...' : '',
    });
  }

  return tasks;
}

function TaskCard({
  task,
  order,
  nowMs,
  onOpenAsset,
  onImageAction,
  onGenerateTextPromptImage,
  onSelectTextPromptOption,
}: {
  task: TaskItem;
  order: number;
  nowMs: number;
  onOpenAsset: (asset: StudioAsset) => void;
  onImageAction: (action: ImageAction, asset: StudioAsset) => void;
  onGenerateTextPromptImage: (payload: TextPromptImageSelectionPayload) => void;
  onSelectTextPromptOption: (payload: TextPromptOptionSelectionPayload) => void;
}) {
  const metaItems = formatTaskMetaItems(task.params);
  const hasTextResult = task.mode === 'text' && Boolean((task.assistantText || '').trim());
  const hasResultPanel = task.status === 'running' || task.status === 'failed' || task.images.length > 0 || hasTextResult;
  const pendingImageCount = Math.max(1, Math.min(4, Number(task.params?.count || 1) || 1));
  const runningText = task.status === 'running'
    ? buildRunningText(task.runningText || task.assistantText, task.created_at, nowMs)
    : '';
  const promptPackMode = normalizeText(task.params?.prompt_pack_mode);
  const isPromptPackTask = task.mode === 'text' && (promptPackMode === 'stepped_image_prompts' || promptPackMode === 'five_image_prompts');
  const parsedPromptPack = isPromptPackTask && task.status !== 'running' ? parsePromptPack(task.assistantText || '') : null;

  return (
    <Box sx={{ borderRadius: 2.2, border: '1px solid rgba(0,0,0,0.07)', bgcolor: '#f9f4ed', p: 1.1 }}>
      <Stack spacing={1}>
        <Box
          sx={{
            borderRadius: 1.6,
            border: '1px solid rgba(134,97,63,0.18)',
            bgcolor: '#f4ede4',
            px: 1,
            py: 0.9,
          }}
        >
          <Stack
            direction="row"
            spacing={0.8}
            alignItems="flex-start"
            justifyContent="space-between"
            sx={{ mb: 0.8 }}
          >
            <Stack direction="row" spacing={0.7} alignItems="center" useFlexGap flexWrap="wrap" sx={{ minWidth: 0, flex: 1 }}>
              <Chip
                size="small"
                label={task.mode.toUpperCase()}
                sx={{
                  height: 20,
                  borderRadius: 5,
                  bgcolor: '#3f3228',
                  color: '#fff',
                  '& .MuiChip-label': { fontSize: 11, px: 0.9, fontWeight: 700 },
                }}
              />
              <Chip
                size="small"
                label={`任务 ${order}`}
                sx={{
                  height: 20,
                  borderRadius: 5,
                  bgcolor: 'rgba(63,50,40,0.08)',
                  color: '#4b3a2e',
                  '& .MuiChip-label': { fontSize: 11, px: 0.9, fontWeight: 700 },
                }}
              />
              {metaItems.map((item) => (
                <Chip
                  key={`${task.id}-${item}`}
                  size="small"
                  label={item}
                  sx={{
                    height: 22,
                    borderRadius: 4,
                    bgcolor: '#f9f6f2',
                    color: '#5d4b3d',
                    border: '1px solid rgba(0,0,0,0.1)',
                    '& .MuiChip-label': { px: 0.9, fontSize: 11.5 },
                  }}
                />
              ))}
            </Stack>
            <Typography variant="caption" sx={{ color: '#8a7a6b', flexShrink: 0, pl: 0.8, pt: 0.15 }}>
              {task.created_at ? new Date(task.created_at).toLocaleString() : ''}
            </Typography>
          </Stack>

          <Typography variant="body2" sx={{ color: '#332a24', whiteSpace: 'pre-wrap' }}>
            {task.text || '(空输入)'}
          </Typography>

          {task.attachments.length > 0 ? (
            <Box sx={{ mt: 1 }}>
              <Stack direction="row" spacing={0.8} useFlexGap flexWrap="wrap">
                {task.attachments.map((asset) =>
                  isDeletedAsset(asset) ? (
                    <Box
                      key={asset.id}
                      sx={{
                        width: 66,
                        height: 66,
                        borderRadius: 1,
                        border: '1px dashed',
                        borderColor: 'divider',
                        bgcolor: 'action.hover',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        px: 0.6,
                      }}
                    >
                      <Typography variant="caption" color="text.secondary" align="center">
                        已删除
                      </Typography>
                    </Box>
                  ) : (
                    <Box
                      key={asset.id}
                      component="img"
                      src={resolveAssetUrl(asset.thumbnail_url || asset.file_url)}
                      alt={asset.title}
                      onClick={() => onOpenAsset(asset)}
                      sx={{
                        width: 66,
                        height: 66,
                        borderRadius: 1,
                        objectFit: 'cover',
                        cursor: 'pointer',
                        border: '1px solid',
                        borderColor: 'divider',
                      }}
                    />
                  ),
                )}
              </Stack>
            </Box>
          ) : null}
        </Box>

        {hasResultPanel ? (
          <Box
            sx={{
              display: 'inline-block',
              width: 'fit-content',
              maxWidth: '100%',
              alignSelf: 'flex-start',
              borderRadius: 1.6,
              border: '1px solid rgba(74,120,92,0.24)',
              bgcolor: 'transparent',
              px: 0.7,
              py: 0.7,
            }}
          >
            {task.status === 'running' && task.mode === 'image' ? (
              <Typography variant="body2" sx={{ mb: 0.9, color: '#3d6a4e', fontWeight: 600 }}>
                {runningText || '正在生成中...'}
              </Typography>
            ) : null}

            {task.status === 'failed' ? (
              <Typography variant="body2" sx={{ mb: 0.9, color: '#b2433d', fontWeight: 700 }}>
                {task.assistantText || '任务生成失败，请重试。'}
              </Typography>
            ) : null}

            {task.mode === 'text' && task.status !== 'failed' ? (
              task.status === 'running' ? (
                <Typography
                  variant="body2"
                  sx={{ color: '#2e2a25', whiteSpace: 'pre-wrap', lineHeight: 1.65 }}
                >
                  {runningText || '正在思考中...'}
                </Typography>
              ) : parsedPromptPack ? (
                <Stack spacing={0.8} sx={{ minWidth: 280 }}>
                  {parsedPromptPack.phase === 'phase1_options' ? (
                    <>
                      {parsedPromptPack.anchors.length > 0 ? (
                        <Typography variant="caption" sx={{ color: '#5f6a76' }}>
                          结构锚点：{parsedPromptPack.anchors.join('；')}
                        </Typography>
                      ) : null}
                      {parsedPromptPack.diagnosisPros.length > 0 ? (
                        <Typography variant="caption" sx={{ color: '#5f6a76' }}>
                          美学优点：{parsedPromptPack.diagnosisPros.join('；')}
                        </Typography>
                      ) : null}
                      {parsedPromptPack.diagnosisCons.length > 0 ? (
                        <Typography variant="caption" sx={{ color: '#5f6a76' }}>
                          待优化：{parsedPromptPack.diagnosisCons.join('；')}
                        </Typography>
                      ) : null}
                      {parsedPromptPack.options.map((item, index) => (
                        <Box
                          key={`${task.id}-prompt-pack-phase1-${item.id || index}`}
                          sx={{
                            borderRadius: 1.1,
                            border: '1px solid rgba(0,0,0,0.09)',
                            bgcolor: '#ffffff',
                            p: 0.8,
                          }}
                        >
                          <Stack direction="row" spacing={0.8} alignItems="center" justifyContent="space-between" sx={{ mb: 0.4 }}>
                            <Typography variant="caption" sx={{ fontWeight: 700, color: '#2e2a25' }}>
                              {item.title || `方案${index + 1}`}
                            </Typography>
                            <Button
                              size="small"
                              onClick={() => onSelectTextPromptOption({
                                sourceTaskId: task.id,
                                sourceText: task.text,
                                optionId: item.id || `opt${index + 1}`,
                                title: item.title || `方案${index + 1}`,
                                summary: item.summary,
                                attachmentAssetIds: task.attachmentAssetIds,
                                references: task.references,
                              })}
                              sx={{ minWidth: 78, px: 1, py: 0.1, fontSize: 12, fontWeight: 700 }}
                            >
                              选这个方案
                            </Button>
                          </Stack>
                          <Typography variant="body2" sx={{ color: '#2e2a25', whiteSpace: 'pre-wrap', lineHeight: 1.62 }}>
                            {item.summary}
                          </Typography>
                        </Box>
                      ))}
                    </>
                  ) : (
                    <>
                      {parsedPromptPack.selectedOptionTitle ? (
                        <Typography variant="caption" sx={{ color: '#5f6a76' }}>
                          已选方案：{parsedPromptPack.selectedOptionTitle}
                        </Typography>
                      ) : null}
                      {parsedPromptPack.prompts.map((item, index) => (
                        <Box
                          key={`${task.id}-prompt-pack-phase2-${item.id || index}`}
                          sx={{
                            borderRadius: 1.1,
                            border: '1px solid rgba(0,0,0,0.09)',
                            bgcolor: '#ffffff',
                            p: 0.8,
                          }}
                        >
                          <Stack direction="row" spacing={0.8} alignItems="center" justifyContent="space-between" sx={{ mb: 0.4 }}>
                            <Typography variant="caption" sx={{ fontWeight: 700, color: '#2e2a25' }}>
                              {item.title || `提示词${index + 1}`}
                            </Typography>
                            <Button
                              size="small"
                              onClick={() =>
                                onGenerateTextPromptImage({
                                  sourceTaskId: task.id,
                                  prompt: item.prompt,
                                  attachmentAssetIds: task.attachmentAssetIds,
                                  references: task.references,
                                })
                              }
                              sx={{ minWidth: 56, px: 1, py: 0.1, fontSize: 12, fontWeight: 700 }}
                            >
                              生图
                            </Button>
                          </Stack>
                          <Typography variant="body2" sx={{ color: '#2e2a25', whiteSpace: 'pre-wrap', lineHeight: 1.62 }}>
                            {item.prompt}
                          </Typography>
                        </Box>
                      ))}
                    </>
                  )}
                  {parsedPromptPack.followUp ? (
                    <Typography variant="caption" sx={{ color: '#5f6a76' }}>
                      {parsedPromptPack.followUp}
                    </Typography>
                  ) : null}
                </Stack>
              ) : (
                <Typography
                  variant="body2"
                  sx={{ color: '#2e2a25', whiteSpace: 'pre-wrap', lineHeight: 1.65 }}
                >
                  {task.assistantText || '已完成。'}
                </Typography>
              )
            ) : null}

            {task.mode === 'image' && task.images.length > 0 ? (
              <Box
                sx={{
                  mt: 0.8,
                  display: 'inline-flex',
                  flexWrap: 'wrap',
                  alignItems: 'flex-start',
                  width: 'fit-content',
                  maxWidth: '100%',
                  gap: 1.2,
                }}
              >
                {task.images.map((asset) => (
                  <Box
                    key={asset.id}
                    sx={{
                      position: 'relative',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      maxWidth: '100%',
                      borderRadius: 1.4,
                      overflow: 'hidden',
                    }}
                    className="result-image-shell"
                  >
                    {isDeletedAsset(asset) ? (
                      <Box
                        sx={{
                          width: { xs: 165, sm: 195 },
                          minHeight: 135,
                          bgcolor: 'action.hover',
                          border: '1px dashed',
                          borderColor: 'divider',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Typography variant="body2" color="text.secondary">
                          该图片已删除
                        </Typography>
                      </Box>
                    ) : (
                      <>
                        <Box
                          component="img"
                          src={resolveAssetUrl(asset.file_url || asset.thumbnail_url)}
                          alt={asset.title}
                          onClick={() => onOpenAsset(asset)}
                          sx={{
                            display: 'block',
                            width: 'auto',
                            maxWidth: { xs: 'calc(100vw - 150px)', sm: 210, md: 240 },
                            height: 'auto',
                            maxHeight: { xs: 255, md: 322 },
                            objectFit: 'contain',
                            cursor: 'pointer',
                            borderRadius: 1.4,
                          }}
                        />
                        <Stack
                          direction="row"
                          spacing={0.3}
                          sx={{
                            position: 'absolute',
                            left: '50%',
                            bottom: 10,
                            transform: 'translateX(-50%)',
                            width: 'max-content',
                            height: 34,
                            p: 0.35,
                            borderRadius: 999,
                            bgcolor: 'rgba(255,255,255,0.9)',
                            border: '1px solid rgba(0,0,0,0.08)',
                            backdropFilter: 'blur(6px)',
                            opacity: 0,
                            transition: 'opacity 140ms ease',
                            pointerEvents: 'none',
                            '.result-image-shell:hover &': {
                              opacity: 1,
                              pointerEvents: 'auto',
                            },
                            '.result-image-shell:focus-within &': {
                              opacity: 1,
                              pointerEvents: 'auto',
                            },
                            '@media (hover: none)': {
                              opacity: 1,
                              pointerEvents: 'auto',
                            },
                          }}
                        >
                          <Tooltip title="复制">
                            <IconButton size="small" onClick={() => onImageAction('copy', asset)}>
                              <CopyAllRoundedIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="下载">
                            <IconButton size="small" onClick={() => onImageAction('download', asset)}>
                              <DownloadRoundedIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="添加到输入框">
                            <IconButton size="small" onClick={() => onImageAction('add', asset)}>
                              <AddCircleOutlineRoundedIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="标注模式">
                            <IconButton size="small" onClick={() => onImageAction('annotate', asset)}>
                              <EditNoteRoundedIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="删除">
                            <IconButton size="small" color="error" onClick={() => onImageAction('delete', asset)}>
                              <DeleteOutlineRoundedIcon fontSize="inherit" />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </>
                    )}
                  </Box>
                ))}
              </Box>
            ) : task.mode === 'image' && task.status === 'running' ? (
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 0.8 }}>
                {Array.from({ length: pendingImageCount }).map((_, idx) => (
                  <Box
                    key={`pending-${task.id}-${idx}`}
                    sx={{
                      width: { xs: '100%', sm: 220 },
                      minHeight: 140,
                      borderRadius: 1.5,
                      bgcolor: 'rgba(0,0,0,0.05)',
                      border: '1px dashed rgba(0,0,0,0.12)',
                    }}
                  />
                ))}
              </Stack>
            ) : null}
          </Box>
        ) : null}
      </Stack>
    </Box>
  );
}

export function ChatThread({
  workspace,
  onOpenAsset,
  onImageAction,
  onGenerateTextPromptImage,
  onSelectTextPromptOption,
  bottomSpacerHeight = 0,
}: ChatThreadProps) {
  const messages = workspace?.messages;
  const tasks = useMemo(() => mergeMessagesToTasks(messages || []), [messages]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasRunningTask = useMemo(() => tasks.some((task) => task.status === 'running'), [tasks]);

  useEffect(() => {
    if (!hasRunningTask) return;
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningTask]);

  return (
    <Box sx={{ height: '100%', minHeight: 0, overflowY: 'auto', px: { xs: 0.4, md: 1.5 }, py: 0.6 }}>
      <Stack spacing={1.6}>
        {tasks.length === 0 ? (
          <Box
            sx={{
              borderRadius: 2,
              border: '1px dashed',
              borderColor: 'divider',
              bgcolor: 'rgba(255,255,255,0.5)',
              px: 2,
              py: 1.5,
            }}
          >
            <Typography variant="subtitle2" fontWeight={700}>
              系统提示
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              上传参考图或引用官方素材后，输入需求并选择模型、比例、清晰度、生成数量即可开始。
            </Typography>
          </Box>
        ) : null}
        {tasks.map((task, index) => (
          <TaskCard
            key={task.id}
            task={task}
            order={index + 1}
            nowMs={nowMs}
            onOpenAsset={onOpenAsset}
            onImageAction={onImageAction}
            onGenerateTextPromptImage={onGenerateTextPromptImage}
            onSelectTextPromptOption={onSelectTextPromptOption}
          />
        ))}
        {bottomSpacerHeight > 0 ? <Box sx={{ height: `${Math.ceil(bottomSpacerHeight)}px` }} /> : null}
      </Stack>
    </Box>
  );
}
