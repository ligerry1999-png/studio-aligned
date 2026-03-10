import { Box, Stack, Typography } from '@mui/material';
import { useMemo, useRef } from 'react';

import { resolveAssetUrl } from '../api/client';

export interface WorkflowRichMentionOption {
  token: string;
  label?: string;
  assetTitle?: string;
  thumbnailUrl?: string;
  previewUrl?: string;
}

interface WorkflowRichPromptEditorProps {
  value: string;
  placeholder?: string;
  minRows?: number;
  mentionOptions?: WorkflowRichMentionOption[];
  onChange: (nextValue: string, caret: number, anchorEl: HTMLElement) => void;
  onCaretChange?: (value: string, caret: number, anchorEl: HTMLElement) => void;
  onMentionPreview?: (option: WorkflowRichMentionOption) => void;
}

type RichSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; option?: WorkflowRichMentionOption };

const MENTION_PATTERN = /@([a-zA-Z0-9_\u4e00-\u9fa5]+)/g;

function splitRichSegments(value: string, mentionMap: Map<string, WorkflowRichMentionOption>): RichSegment[] {
  const source = String(value || '');
  const segments: RichSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = MENTION_PATTERN.exec(source);
  while (match) {
    const fullToken = `@${String(match[1] || '')}`;
    const start = match.index;
    const end = start + fullToken.length;
    if (start > lastIndex) {
      segments.push({ type: 'text', text: source.slice(lastIndex, start) });
    }
    segments.push({
      type: 'mention',
      text: fullToken,
      option: mentionMap.get(fullToken),
    });
    lastIndex = end;
    match = MENTION_PATTERN.exec(source);
  }
  if (lastIndex < source.length) {
    segments.push({ type: 'text', text: source.slice(lastIndex) });
  }
  if (segments.length === 0) {
    segments.push({ type: 'text', text: '' });
  }
  return segments;
}

function collectMentionOptionsInOrder(value: string, mentionMap: Map<string, WorkflowRichMentionOption>): WorkflowRichMentionOption[] {
  const out: WorkflowRichMentionOption[] = [];
  const seen = new Set<string>();
  const source = String(value || '');
  let match: RegExpExecArray | null = MENTION_PATTERN.exec(source);
  while (match) {
    const token = `@${String(match[1] || '')}`;
    if (!token || seen.has(token)) {
      match = MENTION_PATTERN.exec(source);
      continue;
    }
    seen.add(token);
    const option = mentionMap.get(token);
    if (option && option.thumbnailUrl) {
      out.push(option);
    }
    match = MENTION_PATTERN.exec(source);
  }
  return out;
}

export function WorkflowRichPromptEditor({
  value,
  placeholder,
  minRows = 4,
  mentionOptions = [],
  onChange,
  onCaretChange,
  onMentionPreview,
}: WorkflowRichPromptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const mentionMap = useMemo(() => {
    const map = new Map<string, WorkflowRichMentionOption>();
    mentionOptions.forEach((item) => {
      const token = String(item.token || '').trim();
      if (!token) return;
      map.set(token, item);
    });
    return map;
  }, [mentionOptions]);

  const segments = useMemo(() => splitRichSegments(value, mentionMap), [mentionMap, value]);
  const orderedMentionAssets = useMemo(() => collectMentionOptionsInOrder(value, mentionMap), [mentionMap, value]);

  return (
    <Stack spacing={0.7}>
      <Box
        sx={{
          border: '1px solid #d8deea',
          borderRadius: 1.2,
          bgcolor: '#fff',
          px: 1,
          py: 0.8,
        }}
      >
        <Box sx={{ display: 'grid' }}>
          <Box
            aria-hidden
            sx={{
              gridArea: '1 / 1',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'inherit',
              fontSize: 14,
              lineHeight: 1.55,
              color: '#1f2937',
              pointerEvents: 'none',
              minHeight: `${Math.max(2, minRows) * 22}px`,
            }}
          >
            {segments.map((segment, index) => {
              if (segment.type === 'text') {
                return (
                  <Box key={`rich-segment-text-${index}`} component="span">
                    {segment.text}
                  </Box>
                );
              }
              const thumb = resolveAssetUrl(String(segment.option?.thumbnailUrl || ''));
              if (thumb) {
                return (
                  <Box
                    key={`rich-segment-mention-${index}`}
                    component="span"
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.5,
                      px: 0.5,
                      py: 0.2,
                      mr: 0.3,
                      borderRadius: 0.8,
                      bgcolor: '#edf5ff',
                      border: '1px solid #c9ddff',
                      verticalAlign: 'middle',
                    }}
                  >
                    <Box
                      component="img"
                      src={thumb}
                      alt={segment.option?.assetTitle || segment.text}
                      sx={{
                        width: 18,
                        height: 18,
                        borderRadius: 0.5,
                        objectFit: 'cover',
                        display: 'block',
                        border: '1px solid #b9cdf3',
                        flexShrink: 0,
                      }}
                    />
                    <Box component="span" sx={{ color: '#214f85', fontWeight: 600 }}>
                      {segment.text}
                    </Box>
                  </Box>
                );
              }
              return (
                <Box
                  key={`rich-segment-mention-${index}`}
                  component="span"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    px: 0.5,
                    py: 0.15,
                    mr: 0.3,
                    borderRadius: 0.8,
                    bgcolor: '#f3f4f6',
                    color: '#374151',
                    border: '1px solid #dde2ea',
                    verticalAlign: 'middle',
                  }}
                >
                  {segment.text}
                </Box>
              );
            })}
            {String(value || '').length === 0 ? (
              <Box component="span" sx={{ color: '#9aa4b2' }}>
                {placeholder || ''}
              </Box>
            ) : null}
          </Box>

          <Box
            component="textarea"
            ref={textareaRef}
            value={value}
            rows={minRows}
            onChange={(event) => {
              const target = event.currentTarget;
              onChange(target.value, target.selectionStart ?? target.value.length, target);
            }}
            onClick={(event) => {
              if (!onCaretChange) return;
              const target = event.currentTarget;
              onCaretChange(target.value, target.selectionStart ?? target.value.length, target);
            }}
            onFocus={(event) => {
              if (!onCaretChange) return;
              const target = event.currentTarget;
              onCaretChange(target.value, target.selectionStart ?? target.value.length, target);
            }}
            onKeyUp={(event) => {
              if (!onCaretChange) return;
              const target = event.currentTarget;
              onCaretChange(target.value, target.selectionStart ?? target.value.length, target);
            }}
            placeholder={placeholder}
            sx={{
              gridArea: '1 / 1',
              width: '100%',
              border: 'none',
              outline: 'none',
              resize: 'vertical',
              background: 'transparent',
              fontFamily: 'inherit',
              fontSize: 14,
              lineHeight: 1.55,
              color: 'transparent',
              WebkitTextFillColor: 'transparent',
              caretColor: '#111827',
              p: 0,
              m: 0,
              '&::placeholder': {
                color: 'transparent',
              },
            }}
          />
        </Box>
      </Box>

      {orderedMentionAssets.length > 0 ? (
        <Stack direction="row" spacing={0.6} useFlexGap flexWrap="wrap">
          {orderedMentionAssets.map((item) => {
            const thumb = resolveAssetUrl(String(item.thumbnailUrl || item.previewUrl || ''));
            return (
              <Box
                key={`rich-editor-mention-preview-${item.token}`}
                component="button"
                type="button"
                onClick={() => onMentionPreview?.(item)}
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.55,
                  px: 0.65,
                  py: 0.45,
                  borderRadius: 1,
                  border: '1px solid #dce3f2',
                  bgcolor: '#fff',
                  cursor: 'pointer',
                  '&:hover': {
                    borderColor: '#98b7f0',
                    bgcolor: '#f7fbff',
                  },
                }}
              >
                {thumb ? (
                  <Box
                    component="img"
                    src={thumb}
                    alt={item.assetTitle || item.token}
                    sx={{
                      width: 22,
                      height: 22,
                      objectFit: 'cover',
                      borderRadius: 0.7,
                      border: '1px solid #c7d7f6',
                    }}
                  />
                ) : null}
                <Typography variant="caption" sx={{ fontWeight: 600, color: '#264a7a' }}>
                  {item.token}
                </Typography>
              </Box>
            );
          })}
        </Stack>
      ) : null}
    </Stack>
  );
}
