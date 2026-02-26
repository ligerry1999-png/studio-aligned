import { createTheme } from '@mui/material/styles';

export const appTheme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#2a2a2a',
      dark: '#1a1a1a',
      light: '#4a4a4a',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#8b7355',
      dark: '#6b5344',
      light: '#a89080',
    },
    background: {
      default: '#faf8f5',
      paper: '#ffffff',
    },
    text: {
      primary: '#2a2a2a',
      secondary: '#6b6b6b',
    },
    divider: 'rgba(0, 0, 0, 0.04)',
  },
  shape: {
    borderRadius: 16,
  },
  typography: {
    fontFamily: '"Inter", "Noto Sans SC", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif',
    h6: {
      letterSpacing: -0.2,
      fontWeight: 600,
    },
    button: {
      textTransform: 'none',
      fontWeight: 500,
    },
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          boxShadow: 'none',
          border: '1px solid rgba(0,0,0,0.04)',
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
        },
      },
    },
  },
});
