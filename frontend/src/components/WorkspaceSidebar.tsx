import AddCircleOutlineRoundedIcon from '@mui/icons-material/AddCircleOutlineRounded';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded';
import {
  Box,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import type { WorkspaceSummary } from '../types/studio';

interface WorkspaceSidebarProps {
  sessions: WorkspaceSummary[];
  currentWorkspaceId?: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
}

function getInitials(name: string): string {
  if (!name) return '?';
  const chars = name.slice(0, 2);
  return chars.toUpperCase();
}

export function WorkspaceSidebar({
  sessions,
  currentWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace,
  onRefresh,
  onOpenSettings,
}: WorkspaceSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        py: 2,
        px: collapsed ? 1.5 : 2,
        bgcolor: '#f5f0eb',
        borderRight: '1px solid rgba(0,0,0,0.04)',
        width: collapsed ? 72 : 240,
        transition: 'width 0.2s ease, padding 0.2s ease',
        overflow: 'hidden',
      }}
    >
      {/* Header with Logo and Collapse Button */}
      <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {!collapsed && (
          <Typography variant="h6" fontWeight={700} sx={{ fontSize: 16 }}>
            小巨人工作室
          </Typography>
        )}
        <IconButton
          size="small"
          onClick={() => setCollapsed(!collapsed)}
          sx={{
            width: 28,
            height: 28,
            color: 'text.secondary',
          }}
        >
          {collapsed ? <ChevronRightRoundedIcon /> : <ChevronLeftRoundedIcon />}
        </IconButton>
      </Box>

      {/* Workspace Section */}
      <Box sx={{ mb: 2 }}>
        {!collapsed && (
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 500, px: 1 }}>
            Workspace
          </Typography>
        )}
      </Box>

      {/* Sessions List */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Stack spacing={0.5}>
          {sessions.map((session) => {
            const active = session.id === currentWorkspaceId;
            return (
              <Tooltip
                key={session.id}
                title={collapsed ? (session.name || '未命名会话') : ''}
                placement="right"
              >
                <Box
                  onClick={() => onSelectWorkspace(session.id)}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    py: 1,
                    px: collapsed ? 1 : 1.5,
                    borderRadius: 2,
                    cursor: 'pointer',
                    bgcolor: active ? 'rgba(0,0,0,0.04)' : 'transparent',
                    '&:hover': {
                      bgcolor: active ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.02)',
                    },
                  }}
                >
                  <Box
                    sx={{
                      width: 36,
                      height: 36,
                      borderRadius: 2,
                      bgcolor: active ? 'primary.main' : 'rgba(0,0,0,0.04)',
                      color: active ? 'white' : 'text.primary',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 600,
                      fontSize: 13,
                      flexShrink: 0,
                    }}
                  >
                    {getInitials(session.name)}
                  </Box>
                  {!collapsed && (
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        fontWeight={600}
                        noWrap
                        sx={{ fontSize: 14 }}
                      >
                        {session.name || '未命名会话'}
                      </Typography>
                    </Box>
                  )}
                  {!collapsed && active && (
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteWorkspace(session.id);
                      }}
                      sx={{
                        width: 24,
                        height: 24,
                        color: 'error.main',
                        p: 0,
                      }}
                    >
                      <DeleteOutlineRoundedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  )}
                </Box>
              </Tooltip>
            );
          })}
        </Stack>
      </Box>

      {/* Bottom Actions */}
      <Stack spacing={1} sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
        <Tooltip title="API 设置">
          <Box
            onClick={onOpenSettings}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              py: 0.75,
              px: collapsed ? 1 : 1.5,
              borderRadius: 2,
              cursor: 'pointer',
              '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' },
            }}
          >
            <SettingsRoundedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
            {!collapsed && (
              <Typography variant="body2" color="text.secondary">
                设置
              </Typography>
            )}
          </Box>
        </Tooltip>
        
        <Tooltip title="刷新会话">
          <Box
            onClick={onRefresh}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              py: 0.75,
              px: collapsed ? 1 : 1.5,
              borderRadius: 2,
              cursor: 'pointer',
              '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' },
            }}
          >
            <RefreshRoundedIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
            {!collapsed && (
              <Typography variant="body2" color="text.secondary">
                刷新
              </Typography>
            )}
          </Box>
        </Tooltip>

        <Tooltip title="新建会话">
          <Box
            onClick={onCreateWorkspace}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              py: 1,
              px: collapsed ? 1 : 1.5,
              borderRadius: 2,
              cursor: 'pointer',
              bgcolor: 'primary.main',
              color: 'white',
              '&:hover': { bgcolor: 'primary.dark' },
            }}
          >
            <AddCircleOutlineRoundedIcon sx={{ fontSize: 20 }} />
            {!collapsed && (
              <Typography variant="body2" fontWeight={600}>
                新建会话
              </Typography>
            )}
          </Box>
        </Tooltip>
      </Stack>
    </Box>
  );
}
