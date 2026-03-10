import { Navigate, createBrowserRouter } from 'react-router-dom';

import { StudioPage } from './pages/StudioPage';
import { WorkflowCanvasPage } from './pages/WorkflowCanvasPage';

export const appRouter = createBrowserRouter([
  {
    path: '/',
    element: <StudioPage />,
  },
  {
    path: '/workflow',
    element: <WorkflowCanvasPage />,
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
]);
