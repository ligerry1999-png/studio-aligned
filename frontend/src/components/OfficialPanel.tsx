import AddCircleOutlineRoundedIcon from '@mui/icons-material/AddCircleOutlineRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import {
  Box,
  Button,
  Card,
  CardContent,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

import { resolveAssetUrl } from '../api/client';
import type { OfficialPrompt, OfficialTaxonomies, StudioAsset } from '../types/studio';

export interface OfficialFilters {
  scene: string;
  style: string;
  material: string;
  lighting: string;
  search: string;
}

interface OfficialPanelProps {
  taxonomies: OfficialTaxonomies;
  prompts: OfficialPrompt[];
  assets: StudioAsset[];
  hasMore: boolean;
  loading: boolean;
  filters: OfficialFilters;
  onFilterChange: (patch: Partial<OfficialFilters>) => void;
  onReload: () => void;
  onLoadMore: () => void;
  onOpenAsset: (asset: StudioAsset) => void;
  onAddAsset: (asset: StudioAsset) => void;
  onInsertPrompt: (prompt: OfficialPrompt) => void;
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <TextField select size="small" label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <MenuItem value="">全部</MenuItem>
      {options.map((option) => (
        <MenuItem key={option} value={option}>
          {option}
        </MenuItem>
      ))}
    </TextField>
  );
}

export function OfficialPanel({
  taxonomies,
  prompts,
  assets,
  hasMore,
  loading,
  filters,
  onFilterChange,
  onReload,
  onLoadMore,
  onOpenAsset,
  onAddAsset,
  onInsertPrompt,
}: OfficialPanelProps) {
  return (
    <Card sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ pb: 1.5 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography variant="h6" fontWeight={700}>
            官方素材生态
          </Typography>
          <Tooltip title="刷新素材">
            <IconButton size="small" onClick={onReload}>
              <RefreshRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
        <Stack spacing={1} sx={{ mt: 1 }}>
          <TextField
            size="small"
            label="搜索"
            placeholder="风格 / 场景 / 材质"
            value={filters.search}
            onChange={(event) => onFilterChange({ search: event.target.value })}
          />
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <FilterSelect
              label="场景"
              value={filters.scene}
              options={taxonomies.scene || []}
              onChange={(value) => onFilterChange({ scene: value })}
            />
            <FilterSelect
              label="风格"
              value={filters.style}
              options={taxonomies.style || []}
              onChange={(value) => onFilterChange({ style: value })}
            />
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            <FilterSelect
              label="材质"
              value={filters.material}
              options={taxonomies.material || []}
              onChange={(value) => onFilterChange({ material: value })}
            />
            <FilterSelect
              label="光照"
              value={filters.lighting}
              options={taxonomies.lighting || []}
              onChange={(value) => onFilterChange({ lighting: value })}
            />
          </Stack>
        </Stack>
      </CardContent>

      <Box sx={{ px: 1.5, pb: 1.5, flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: 'repeat(2, minmax(0, 1fr))',
              sm: 'repeat(3, minmax(0, 1fr))',
            },
            gap: 1,
          }}
        >
          {assets.map((asset) => (
            <Card key={asset.id} variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
              <Box
                component="img"
                src={resolveAssetUrl(asset.thumbnail_url || asset.file_url)}
                alt={asset.title}
                onClick={() => onOpenAsset(asset)}
                sx={{ width: '100%', display: 'block', aspectRatio: '4 / 3', objectFit: 'cover', cursor: 'pointer' }}
              />
              <Box sx={{ p: 0.8 }}>
                <Typography variant="caption" sx={{ display: 'block', fontWeight: 700 }} noWrap>
                  {asset.title || '官方素材'}
                </Typography>
                <Button
                  variant="text"
                  size="small"
                  startIcon={<AddCircleOutlineRoundedIcon fontSize="small" />}
                  onClick={() => onAddAsset(asset)}
                >
                  添加
                </Button>
              </Box>
            </Card>
          ))}
        </Box>
        {assets.length === 0 && !loading ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            暂无匹配素材
          </Typography>
        ) : null}
        <Button
          variant="outlined"
          fullWidth
          sx={{ mt: 1.2 }}
          onClick={onLoadMore}
          disabled={loading || !hasMore}
        >
          {hasMore ? (loading ? '加载中...' : '加载更多素材') : '已到底'}
        </Button>

        <Typography variant="subtitle2" fontWeight={700} sx={{ mt: 2, mb: 0.5 }}>
          官方提示词
        </Typography>
        <Stack spacing={0.8}>
          {prompts.map((prompt) => (
            <Card key={prompt.id} variant="outlined" sx={{ borderRadius: 1.2 }}>
              <CardContent sx={{ p: 1.2, '&:last-child': { pb: 1.2 } }}>
                <Typography variant="body2" fontWeight={700}>
                  {prompt.title}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                  {prompt.content}
                </Typography>
                <Button size="small" sx={{ mt: 0.6 }} onClick={() => onInsertPrompt(prompt)}>
                  插入输入框
                </Button>
              </CardContent>
            </Card>
          ))}
          {prompts.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              暂无官方提示词
            </Typography>
          ) : null}
        </Stack>
      </Box>
    </Card>
  );
}
