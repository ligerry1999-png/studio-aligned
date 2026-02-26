import AddCircleOutlineRoundedIcon from '@mui/icons-material/AddCircleOutlineRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import EditNoteRoundedIcon from '@mui/icons-material/EditNoteRounded';
import {
  Box,
  Dialog,
  IconButton,
  Stack,
  Tooltip,
} from '@mui/material';

import { resolveAssetUrl } from '../api/client';
import type { StudioAsset } from '../types/studio';

interface ImageLightboxProps {
  open: boolean;
  asset: StudioAsset | null;
  onClose: () => void;
  onCopy: (asset: StudioAsset) => void;
  onDownload: (asset: StudioAsset) => void;
  onAddToComposer: (asset: StudioAsset) => void;
  onAnnotate: (asset: StudioAsset) => void;
  onDelete: (asset: StudioAsset) => void;
}

export function ImageLightbox({
  open,
  asset,
  onClose,
  onCopy,
  onDownload,
  onAddToComposer,
  onAnnotate,
  onDelete,
}: ImageLightboxProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      PaperProps={{
        sx: {
          bgcolor: 'transparent',
          boxShadow: 'none',
          borderRadius: 0,
          overflow: 'visible',
          m: 0,
        },
      }}
    >
      <Box
        onClick={onClose}
        sx={{
          minHeight: '100vh',
          width: '100vw',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: { xs: 1.2, md: 2.5 },
          position: 'relative',
        }}
      >
        <Box
          className="lightbox-image-shell"
          onClick={(event) => event.stopPropagation()}
          sx={{
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            maxWidth: 'calc(100vw - 64px)',
            maxHeight: 'calc(100vh - 64px)',
          }}
        >
          <Box
            component="img"
            src={resolveAssetUrl(asset?.file_url || asset?.thumbnail_url)}
            alt={asset?.title || 'preview'}
            sx={{
              display: 'block',
              width: 'auto',
              maxWidth: '100%',
              height: 'auto',
              maxHeight: 'calc(100vh - 96px)',
              objectFit: 'contain',
              borderRadius: 0.5,
            }}
          />

          <Stack
            direction="column"
            spacing={1.1}
            sx={{
              position: 'absolute',
              right: { xs: 10, md: 14 },
              top: '50%',
              transform: 'translateY(-50%)',
              p: 0.55,
              borderRadius: 1.8,
              bgcolor: 'rgba(255,255,255,0.86)',
              border: '1px solid rgba(0,0,0,0.08)',
              backdropFilter: 'blur(6px)',
              opacity: 0,
              transition: 'opacity 140ms ease',
              pointerEvents: 'none',
              '.lightbox-image-shell:hover &': {
                opacity: 1,
                pointerEvents: 'auto',
              },
              '.lightbox-image-shell:focus-within &': {
                opacity: 1,
                pointerEvents: 'auto',
              },
              '@media (hover: none)': {
                opacity: 1,
                pointerEvents: 'auto',
              },
            }}
          >
            <Tooltip title="复制" placement="left" arrow>
              <IconButton
                onClick={() => asset && onCopy(asset)}
                disabled={!asset}
                sx={{ width: 42, height: 42 }}
              >
                <ContentCopyRoundedIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="下载" placement="left" arrow>
              <IconButton
                onClick={() => asset && onDownload(asset)}
                disabled={!asset}
                sx={{ width: 42, height: 42 }}
              >
                <DownloadRoundedIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="添加到对话框" placement="left" arrow>
              <IconButton
                onClick={() => asset && onAddToComposer(asset)}
                disabled={!asset}
                sx={{ width: 42, height: 42 }}
              >
                <AddCircleOutlineRoundedIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="标注" placement="left" arrow>
              <IconButton
                onClick={() => asset && onAnnotate(asset)}
                disabled={!asset}
                sx={{ width: 42, height: 42 }}
              >
                <EditNoteRoundedIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="删除" placement="left" arrow>
              <IconButton
                color="error"
                onClick={() => asset && onDelete(asset)}
                disabled={!asset}
                sx={{ width: 42, height: 42 }}
              >
                <DeleteOutlineRoundedIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>
      </Box>
    </Dialog>
  );
}
