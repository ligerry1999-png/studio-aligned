import { create } from 'zustand';

import type { StudioAsset, StudioMessage, StudioOptions, WorkspaceDetail, WorkspaceSummary } from '../types/studio';

interface StudioStoreState {
  options: StudioOptions | null;
  sessions: WorkspaceSummary[];
  currentWorkspace: WorkspaceDetail | null;
  setOptions: (options: StudioOptions) => void;
  setSessions: (sessions: WorkspaceSummary[]) => void;
  setCurrentWorkspace: (workspace: WorkspaceDetail | null) => void;
  appendTurn: (userMessage: StudioMessage, assistantMessage: StudioMessage) => void;
  patchAssetInWorkspace: (asset: StudioAsset) => void;
}

function patchAsset(asset: StudioAsset, list: StudioAsset[] | undefined): StudioAsset[] | undefined {
  if (!list || list.length === 0) return list;
  let changed = false;
  const next = list.map((item) => {
    if (item.id !== asset.id) return item;
    changed = true;
    return { ...item, ...asset };
  });
  return changed ? next : list;
}

export const useStudioStore = create<StudioStoreState>((set) => ({
  options: null,
  sessions: [],
  currentWorkspace: null,
  setOptions: (options) => set({ options }),
  setSessions: (sessions) => set({ sessions }),
  setCurrentWorkspace: (workspace) => set({ currentWorkspace: workspace }),
  appendTurn: (userMessage, assistantMessage) =>
    set((state) => {
      if (!state.currentWorkspace) return state;
      return {
        currentWorkspace: {
          ...state.currentWorkspace,
          messages: [...state.currentWorkspace.messages, userMessage, assistantMessage],
          updated_at: new Date().toISOString(),
        },
      };
    }),
  patchAssetInWorkspace: (asset) =>
    set((state) => {
      if (!state.currentWorkspace) return state;
      return {
        currentWorkspace: {
          ...state.currentWorkspace,
          messages: state.currentWorkspace.messages.map((message) => ({
            ...message,
            attachments: patchAsset(asset, message.attachments),
            images: patchAsset(asset, message.images),
          })),
        },
      };
    }),
}));
