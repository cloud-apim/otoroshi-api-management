import React from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import './portal.css';
import { initTheme } from '../shared/lib.js';
import { RouterProvider } from '../shared/router.jsx';
import { ToastProvider, ConfirmProvider } from '../shared/ui.jsx';
import { PortalProvider, runtime } from './context.jsx';
import { App } from './App.jsx';

initTheme();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider base={runtime.base}>
      <ToastProvider>
        <ConfirmProvider>
          <PortalProvider>
            <App />
          </PortalProvider>
        </ConfirmProvider>
      </ToastProvider>
    </RouterProvider>
  </React.StrictMode>
);
