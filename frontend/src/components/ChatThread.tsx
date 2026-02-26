import AddCircleOutlineRoundedIcon from '@mui/icons-material/AddCircleOutlineRounded';
import CopyAllRoundedIcon from '@mui/icons-material/CopyAllRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import EditNoteRoundedIcon from '@mui/icons-material/EditNoteRounded';
import {
  Box,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMemo } from 'react';

import { resolveAssetUrl } from '../api/client';
import type { GenerationParams, StudioAsset, StudioMessage, WorkspaceDetail } from '../types/studio';

export type ImageAction = 'copy' | 'download' | 'add' | 'annotate' | 'zoom' | 'delete';

interface ChatThreadProps {
  workspace: WorkspaceDetail | null;
  onOpenAsset: (asset: StudioAsset) => void;
  onImageAction: (action: ImageAction, asset: StudioAsset) => void;
}

type TaskStatus = 'completed' | 'running' | 'failed';

interface TaskItem {
  id: string;
  text: string;
  created_at?: string;
  params?: Partial<GenerationParams>;
  attachments: StudioAsset[];
  images: StudioAsset[];
  status: TaskStatus;
  runningText: string;
}

function normalizeTaskStatus(value?: string): TaskStatus {
  if (value === 'running') return 'running';
  if (value === 'failed') return 'failed';
  return 'completed';
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
    tasks.push({
      id: current.id,
      text: current.text || '',
      created_at: current.created_at || assistant?.created_at,
      params: current.params || assistant?.params,
      attachments: current.attachments || [],
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
  onOpenAsset,
  onImageAction,
}: {
  task: TaskItem;
  order: number;
  onOpenAsset: (asset: StudioAsset) => void;
  onImageAction: (action: ImageAction, asset: StudioAsset) => void;
}) {
  const metaItems = formatTaskMetaItems(task.params);
  const hasResultPanel = task.status === 'running' || task.status === 'failed' || task.images.length > 0;
  const pendingImageCount = Math.max(1, Math.min(4, Number(task.params?.count || 1) || 1));

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
                label="IMAGE"
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
            {task.status === 'running' ? (
              <Typography variant="body2" sx={{ mb: 0.9, color: '#3d6a4e', fontWeight: 600 }}>
                {task.runningText || '正在生成中...'}
              </Typography>
            ) : null}

            {task.status === 'failed' ? (
              <Typography variant="body2" sx={{ mb: 0.9, color: '#b2433d', fontWeight: 700 }}>
                任务生成失败，请重试。
              </Typography>
            ) : null}

            {task.images.length > 0 ? (
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
                          width: { xs: 220, sm: 260 },
                          minHeight: 180,
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
                            maxWidth: { xs: 'calc(100vw - 106px)', sm: 280, md: 320 },
                            height: 'auto',
                            maxHeight: { xs: 340, md: 430 },
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
            ) : task.status === 'running' ? (
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

export function ChatThread({ workspace, onOpenAsset, onImageAction }: ChatThreadProps) {
  const messages = workspace?.messages;
  const tasks = useMemo(() => mergeMessagesToTasks(messages || []), [messages]);

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
            onOpenAsset={onOpenAsset}
            onImageAction={onImageAction}
          />
        ))}
      </Stack>
    </Box>
  );
}
