import { Navigate, createBrowserRouter } from 'react-router-dom';

import { StudioPage } from './pages/StudioPage';

export const appRouter = createBrowserRouter([
  {
    path: '/',
    element: <StudioPage />,
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
]);
