import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/space-grotesk';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
