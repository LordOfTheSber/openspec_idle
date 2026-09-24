import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { vscodeHost } from './lib/host.js';
import './styles.css';

const host = document.getElementById('root');
if (!host) throw new Error('Не найден корневой элемент #root');

// В панели VS Code запросы идут сообщениями webview, а оформление — по теме
// редактора. Переключение делается до первого запроса интерфейса.
if (vscodeHost() !== null) document.documentElement.dataset['host'] = 'vscode';

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
