import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import NorthEastRoundedIcon from '@mui/icons-material/NorthEastRounded';
import RectangleOutlinedIcon from '@mui/icons-material/RectangleOutlined';
import {
  Box,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DefaultColorStyle, type Editor, type TLEditorSnapshot, type TLStoreSnapshot } from '@tldraw/editor';
import { GeoShapeGeoStyle, Tldraw, getSnapshot } from 'tldraw';

import { resolveAssetUrl } from '../api/client';
import type { StudioAsset } from '../types/studio';

interface AnnotatorDialogProps {
  open: boolean;
  asset: StudioAsset | null;
  initialSnapshot?: Record<string, unknown> | null;
  onClose: () => void;
  onContextChange?: (context: AnnotationDraftContext) => void;
  backdropZIndex?: number;
  frameZIndex?: number;
}

interface ExtractedAnnotationContext extends AnnotationDraftContext {
  extra_box_shape_ids: string[];
  extra_arrow_shape_ids: string[];
}

export interface AnnotationDraftBox {
  shape_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnnotationDraftMoveRelation {
  shape_id: string;
  source_shape_id: string;
  target_shape_id: string;
}

export interface AnnotationDraftContext {
  asset_id: string;
  boxes: AnnotationDraftBox[];
  move_relation: AnnotationDraftMoveRelation | null;
  box_overflow: boolean;
  arrow_overflow: boolean;
}

type AnnotateTool = 'rectangle' | 'arrow';

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readStoreRecords(snapshot: unknown): Record<string, Record<string, unknown>> {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const raw = snapshot as Record<string, unknown>;
  const nestedStore = (raw.document as Record<string, unknown> | undefined)?.store;
  if (nestedStore && typeof nestedStore === 'object') {
    return nestedStore as Record<string, Record<string, unknown>>;
  }
  const directStore = raw.store;
  if (directStore && typeof directStore === 'object') {
    return directStore as Record<string, Record<string, unknown>>;
  }
  return {};
}

function findBoxContainingPoint(boxes: AnnotationDraftBox[], x: number, y: number): string | null {
  for (const box of boxes) {
    const withinX = x >= box.x && x <= box.x + box.w;
    const withinY = y >= box.y && y <= box.y + box.h;
    if (withinX && withinY) return box.shape_id;
  }
  return null;
}

function resolveArrowTerminalByPoint(
  arrowRecord: Record<string, unknown>,
  terminal: 'start' | 'end',
  boxes: AnnotationDraftBox[],
): string | null {
  const props = arrowRecord.props as Record<string, unknown> | undefined;
  const terminalPoint = props?.[terminal] as Record<string, unknown> | undefined;
  if (!terminalPoint) return null;
  const x = toNumber(arrowRecord.x) + toNumber(terminalPoint.x);
  const y = toNumber(arrowRecord.y) + toNumber(terminalPoint.y);
  return findBoxContainingPoint(boxes, x, y);
}

function extractAnnotationContext(snapshot: unknown, assetId: string): ExtractedAnnotationContext {
  const records = readStoreRecords(snapshot);
  const list = Object.values(records).filter((item) => item && typeof item === 'object');

  const shapeRecords = list.filter((item) => String(item.typeName || '') === 'shape');
  const rectangleRecords = shapeRecords
    .filter((item) => String(item.type || '') === 'geo' && String((item.props as Record<string, unknown> | undefined)?.geo || '') === 'rectangle')
    .sort((a, b) => String(a.index || '').localeCompare(String(b.index || '')));

  const allBoxes: AnnotationDraftBox[] = rectangleRecords.map((item) => {
    const props = (item.props as Record<string, unknown> | undefined) || {};
    return {
      shape_id: String(item.id || ''),
      x: toNumber(item.x),
      y: toNumber(item.y),
      w: toNumber(props.w),
      h: toNumber(props.h),
    };
  }).filter((item) => Boolean(item.shape_id));

  const boxes = allBoxes.slice(0, 3);
  const extraBoxShapeIds = allBoxes.slice(3).map((item) => item.shape_id).filter(Boolean);
  const boxOverflow = allBoxes.length > 3;
  const boxIdSet = new Set(boxes.map((item) => item.shape_id));

  const arrowRecords = shapeRecords
    .filter((item) => String(item.type || '') === 'arrow')
    .sort((a, b) => String(a.index || '').localeCompare(String(b.index || '')));
  const arrowOverflow = arrowRecords.length > 1;
  const extraArrowShapeIds = arrowRecords
    .slice(0, Math.max(0, arrowRecords.length - 1))
    .map((item) => String(item.id || ''))
    .filter(Boolean);
  const activeArrow = arrowRecords.length > 0 ? arrowRecords[arrowRecords.length - 1] : null;

  const bindingMap = new Map<string, { start_shape_id?: string; end_shape_id?: string }>();
  list.forEach((item) => {
    if (String(item.typeName || '') !== 'binding') return;
    if (String(item.type || '') !== 'arrow') return;
    const arrowId = String(item.fromId || '');
    const terminal = String((item.props as Record<string, unknown> | undefined)?.terminal || '');
    const targetShapeId = String(item.toId || '');
    if (!arrowId || !targetShapeId || !boxIdSet.has(targetShapeId)) return;
    if (terminal !== 'start' && terminal !== 'end') return;
    const current = bindingMap.get(arrowId) || {};
    if (terminal === 'start') current.start_shape_id = targetShapeId;
    if (terminal === 'end') current.end_shape_id = targetShapeId;
    bindingMap.set(arrowId, current);
  });

  let moveRelation: AnnotationDraftMoveRelation | null = null;
  if (activeArrow) {
    const arrowId = String(activeArrow.id || '');
    const binding = bindingMap.get(arrowId) || {};
    let startShapeId = binding.start_shape_id || '';
    let endShapeId = binding.end_shape_id || '';
    if (!startShapeId) {
      const found = resolveArrowTerminalByPoint(activeArrow, 'start', boxes);
      if (found) startShapeId = found;
    }
    if (!endShapeId) {
      const found = resolveArrowTerminalByPoint(activeArrow, 'end', boxes);
      if (found) endShapeId = found;
    }
    if (startShapeId && endShapeId && startShapeId !== endShapeId && boxIdSet.has(startShapeId) && boxIdSet.has(endShapeId)) {
      moveRelation = {
        shape_id: arrowId,
        source_shape_id: startShapeId,
        target_shape_id: endShapeId,
      };
    }
  }

  return {
    asset_id: assetId,
    boxes,
    move_relation: moveRelation,
    box_overflow: boxOverflow,
    arrow_overflow: arrowOverflow,
    extra_box_shape_ids: extraBoxShapeIds,
    extra_arrow_shape_ids: extraArrowShapeIds,
  };
}

export function AnnotatorDialog({
  open,
  asset,
  initialSnapshot = null,
  onClose,
  onContextChange,
  backdropZIndex = 140,
  frameZIndex = 170,
}: AnnotatorDialogProps) {
  const editorRef = useRef<Editor | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const lastContextSignatureRef = useRef('');
  const [activeTool, setActiveTool] = useState<AnnotateTool>('rectangle');
  const [hint, setHint] = useState('');
  const [imageRatio, setImageRatio] = useState(3 / 4);

  const snapshot = useMemo(() => {
    const raw = initialSnapshot;
    if (!raw || typeof raw !== 'object') return undefined;
    if (Object.keys(raw).length === 0) return undefined;
    return raw as unknown as TLEditorSnapshot | TLStoreSnapshot;
  }, [initialSnapshot]);

  const emitContext = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !asset) return;
    const data = getSnapshot(editor.store) as unknown as Record<string, unknown>;
    const context = extractAnnotationContext(data, asset.id);
    const autoDeleteIds = context.extra_box_shape_ids.concat(context.extra_arrow_shape_ids);
    if (autoDeleteIds.length > 0) {
      editor.deleteShapes(autoDeleteIds as never);
    }
    const signature = JSON.stringify(context);
    if (signature === lastContextSignatureRef.current) return;
    lastContextSignatureRef.current = signature;
    if (onContextChange) onContextChange(context);
    const hints: string[] = [];
    if (context.box_overflow) hints.push('最多 3 个矩形对象，超出部分不会生效。');
    if (context.arrow_overflow) hints.push('仅保留最新 1 条箭头关系。');
    setHint(hints.join(' '));
  }, [asset, onContextChange]);

  const applyTool = useCallback((tool: AnnotateTool) => {
    const editor = editorRef.current;
    setActiveTool(tool);
    if (!editor) return;
    if (tool === 'rectangle') {
      editor.run(() => {
        editor.setStyleForNextShapes(GeoShapeGeoStyle, 'rectangle');
        editor.setStyleForNextShapes(DefaultColorStyle, 'red');
        editor.updateInstanceState({ isToolLocked: true });
        editor.setCurrentTool('geo');
      });
      return;
    }
    editor.run(() => {
      editor.setStyleForNextShapes(DefaultColorStyle, 'red');
      editor.updateInstanceState({ isToolLocked: false });
      editor.setCurrentTool('arrow');
    });
  }, []);

  const closeDialog = useCallback(() => {
    onClose();
  }, [onClose]);

  const deleteSelected = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const selectedIds = editor.getSelectedShapeIds();
    if (selectedIds.length > 0) {
      editor.deleteShapes(selectedIds);
      return;
    }
    const allIds = Array.from(editor.getCurrentPageShapeIds());
    if (allIds.length > 0) {
      editor.deleteShapes([allIds[allIds.length - 1]]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDialog();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, closeDialog]);

  useEffect(() => {
    if (open) return;
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    lastContextSignatureRef.current = '';
  }, [open]);

  useEffect(() => () => {
    if (cleanupRef.current) cleanupRef.current();
  }, []);

  useEffect(() => {
    if (!open || !asset) return;
    const src = resolveAssetUrl(asset.file_url || asset.thumbnail_url);
    if (!src) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      if (w > 0 && h > 0) {
        setImageRatio(w / h);
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [open, asset]);

  if (!open || !asset) return null;

  const normalizedRatio = Number.isFinite(imageRatio) && imageRatio > 0
    ? Math.max(0.35, Math.min(imageRatio, 3.2))
    : 3 / 4;
  const frameWidth = `min(calc((100vh - 220px) * ${normalizedRatio}), calc(100vw - 120px))`;
  const frameHeight = `min(calc((100vw - 120px) / ${normalizedRatio}), calc(100vh - 220px))`;

  return (
    <>
      <Box
        sx={{
          position: 'fixed',
          inset: 0,
          zIndex: backdropZIndex,
          bgcolor: 'rgba(0,0,0,0.44)',
          pointerEvents: 'auto',
        }}
        onMouseDown={() => {
          closeDialog();
        }}
      />

      <Box
        sx={{
          position: 'fixed',
          inset: 0,
          zIndex: frameZIndex,
          pointerEvents: 'none',
        }}
      >
        <Box
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          sx={{
            position: 'absolute',
            left: '50%',
            top: 'calc(50% - 52px)',
            transform: 'translate(-50%, -50%)',
            width: frameWidth,
            height: frameHeight,
            minHeight: 260,
            borderRadius: 2,
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.26)',
            bgcolor: 'transparent',
            boxShadow: '0 24px 56px rgba(0,0,0,0.24)',
            pointerEvents: 'auto',
          }}
        >
          {hint ? (
            <Box
              sx={{
                position: 'absolute',
                left: 12,
                top: 12,
                zIndex: 4,
                px: 1,
                py: 0.45,
                borderRadius: 1,
                bgcolor: 'rgba(255,255,255,0.9)',
              }}
            >
              <Typography variant="caption" sx={{ color: '#5c4634', fontWeight: 700 }}>
                {hint}
              </Typography>
            </Box>
          ) : null}

          <Stack
            spacing={0.7}
            sx={{
              position: 'absolute',
              right: { xs: 10, md: 16 },
              top: '50%',
              transform: 'translateY(-50%)',
              p: 0.65,
              borderRadius: 99,
              bgcolor: 'rgba(255,255,255,0.94)',
              border: '1px solid rgba(0,0,0,0.08)',
              boxShadow: '0 10px 24px rgba(0,0,0,0.12)',
              zIndex: 4,
            }}
          >
            <Tooltip title="返回" placement="left">
              <span>
                <IconButton
                  onClick={closeDialog}
                  sx={{ width: 38, height: 38, color: '#6f6254' }}
                >
                  <ArrowBackRoundedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="矩形" placement="left">
              <IconButton
                onClick={() => applyTool('rectangle')}
                sx={{
                  width: 38,
                  height: 38,
                  color: activeTool === 'rectangle' ? '#8b5f3b' : '#6f6254',
                  bgcolor: activeTool === 'rectangle' ? 'rgba(139,95,59,0.12)' : 'transparent',
                }}
              >
                <RectangleOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="箭头" placement="left">
              <IconButton
                onClick={() => applyTool('arrow')}
                sx={{
                  width: 38,
                  height: 38,
                  color: activeTool === 'arrow' ? '#8b5f3b' : '#6f6254',
                  bgcolor: activeTool === 'arrow' ? 'rgba(139,95,59,0.12)' : 'transparent',
                }}
              >
                <NorthEastRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="删除" placement="left">
              <IconButton onClick={deleteSelected} sx={{ width: 38, height: 38, color: '#b94747' }}>
                <DeleteOutlineRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>

          <Box
            component="img"
            src={resolveAssetUrl(asset.file_url || asset.thumbnail_url)}
            alt={asset.title || 'annotate'}
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'fill',
              pointerEvents: 'none',
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              '& .tl-background': { backgroundColor: 'transparent !important' },
              '& .tl-canvas': { backgroundColor: 'transparent !important' },
            }}
          >
            <Tldraw
              key={`${asset.id || 'empty'}-${open ? 'open' : 'close'}`}
              snapshot={snapshot}
              hideUi
              onMount={(editor) => {
                editorRef.current = editor;
                setActiveTool('rectangle');
                editor.run(() => {
                  editor.setStyleForNextShapes(GeoShapeGeoStyle, 'rectangle');
                  editor.setStyleForNextShapes(DefaultColorStyle, 'red');
                  editor.updateInstanceState({ isToolLocked: true });
                  editor.setCurrentTool('geo');
                });

                if (cleanupRef.current) {
                  cleanupRef.current();
                  cleanupRef.current = null;
                }
                const listener = (editor.store as unknown as { listen?: (...args: unknown[]) => unknown }).listen;
                if (typeof listener === 'function') {
                  const rawCleanup = listener.call(editor.store, () => {
                    emitContext();
                  }, { scope: 'document' });
                  if (typeof rawCleanup === 'function') {
                    cleanupRef.current = rawCleanup as () => void;
                  } else if (rawCleanup && typeof (rawCleanup as { unsubscribe?: () => void }).unsubscribe === 'function') {
                    cleanupRef.current = () => {
                      (rawCleanup as { unsubscribe?: () => void }).unsubscribe?.();
                    };
                  }
                }

                emitContext();
              }}
              autoFocus={false}
            />
          </Box>
        </Box>
      </Box>
    </>
  );
}
