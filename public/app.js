const SETTINGS_KEY = 'chatTestSite.settings.v1';
const HISTORY_KEY = 'chatTestSite.history.v1';
const MAX_CHATS = 100;
const DEFAULTS = {
  model: 'deepseek-v4.1-flash',
  temperature: 0.7,
  maxTokens: 2048,
  systemPrompt: '',
  draft: '',
  currentId: null,
};

const el = (id) => document.getElementById(id);
const messagesEl = el('messages');
const emptyState = el('emptyState');
const messageEl = el('message');
const sendEl = el('send');
const stopEl = el('stop');
const modelEl = el('model');
const temperatureEl = el('temperature');
const maxTokensEl = el('maxTokens');
const systemPromptEl = el('systemPrompt');
const modelStatusEl = el('modelStatus');
const charCountEl = el('charCount');
const historyListEl = el('historyList');

let settings = loadJson(SETTINGS_KEY, DEFAULTS, { ...DEFAULTS });
let chats = loadChats();
let current = chats.find((chat) => chat.id === settings.currentId) || newChat();
let controller = null;
let streaming = false;
let saveTimer = null;
let assistantBubble = null;
let stopRequested = false;

function loadJson(key, fallback, shape) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback };
    return { ...shape, ...value };
  } catch {
    return { ...fallback };
  }
}

function loadChats() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((chat) => chat && typeof chat.id === 'string' && Array.isArray(chat.messages)).slice(0, MAX_CHATS);
  } catch {
    return [];
  }
}

function uid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function newChat() {
  return {
    id: uid(),
    title: '',
    model: settings.model || DEFAULTS.model,
    temperature: settings.temperature ?? DEFAULTS.temperature,
    maxTokens: settings.maxTokens ?? DEFAULTS.maxTokens,
    systemPrompt: settings.systemPrompt || '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function saveAll() {
  try {
    settings.currentId = current.id;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(chats.slice(0, MAX_CHATS)));
  } catch {
    modelStatusEl.textContent = 'Local storage is full';
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAll, 250);
}

function updateCurrentFromInputs() {
  current.model = modelEl.value || current.model;
  current.temperature = clamp(temperatureEl.value, 0, 2, DEFAULTS.temperature);
  current.maxTokens = Math.round(clamp(maxTokensEl.value, 1, 200000, DEFAULTS.maxTokens));
  current.systemPrompt = systemPromptEl.value;
  settings.model = current.model;
  settings.temperature = current.temperature;
  settings.maxTokens = current.maxTokens;
  settings.systemPrompt = current.systemPrompt;
  settings.draft = messageEl.value;
}

function restoreInputs() {
  modelEl.value = current.model;
  temperatureEl.value = current.temperature;
  maxTokensEl.value = current.maxTokens;
  systemPromptEl.value = current.systemPrompt;
  messageEl.value = settings.draft || '';
  updateCharCount();
}

function titleFrom(message) {
  return message.replace(/\s+/g, ' ').trim().slice(0, 64) || 'New chat';
}

function formatWhen(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderHistory() {
  historyListEl.replaceChildren();
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!sorted.length) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'No saved chats yet.';
    historyListEl.append(empty);
    return;
  }
  for (const chat of sorted) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `history-item${chat.id === current.id ? ' active' : ''}`;
    const text = document.createElement('span');
    text.className = 'history-text';
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = chat.title || 'New chat';
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    const count = chat.messages.filter((message) => message.role === 'user').length;
    meta.textContent = `${formatWhen(chat.updatedAt)} · ${count} message${count === 1 ? '' : 's'}`;
    text.append(title, meta);
    const remove = document.createElement('span');
    remove.className = 'history-delete';
    remove.setAttribute('role', 'button');
    remove.setAttribute('aria-label', 'Delete chat');
    remove.title = 'Delete chat';
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteChat(chat.id);
    });
    button.append(text, remove);
    button.addEventListener('click', () => selectChat(chat.id));
    li.append(button);
    historyListEl.append(li);
  }
}

function selectChat(id) {
  if (streaming) return;
  const chat = chats.find((item) => item.id === id);
  if (!chat) return;
  current = chat;
  settings.currentId = current.id;
  settings.draft = '';
  restoreInputs();
  renderHistory();
  renderMessages();
  saveAll();
}

function deleteChat(id) {
  if (streaming && current.id === id) return;
  chats = chats.filter((chat) => chat.id !== id);
  if (current.id === id) {
    current = newChat();
    settings.currentId = current.id;
    restoreInputs();
  }
  renderHistory();
  renderMessages();
  saveAll();
}

function messageNode(message) {
  const article = document.createElement('article');
  article.className = `msg ${message.role}`;
  article.dataset.id = message.id || '';
  const role = document.createElement('div');
  role.className = 'msg-role';
  role.textContent = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : 'System';
  if (message.stopped) {
    const stopped = document.createElement('span');
    stopped.className = 'stopped';
    stopped.textContent = 'Stopped';
    role.append(stopped);
  }
  article.append(role);

  if (message.reasoning) {
    const details = document.createElement('details');
    details.className = 'reasoning';
    const summary = document.createElement('summary');
    summary.textContent = 'Reasoning';
    const pre = document.createElement('pre');
    pre.textContent = message.reasoning;
    details.append(summary, pre);
    article.append(details);
  }

  const content = document.createElement('div');
  content.className = 'msg-content';
  content.textContent = message.content || '';
  article.append(content);
  return article;
}

function renderMessages() {
  messagesEl.replaceChildren();
  assistantBubble = null;
  if (!current.messages.length) {
    messagesEl.append(emptyState);
    return;
  }
  for (const message of current.messages) {
    const node = messageNode(message);
    messagesEl.append(node);
    if (message.role === 'assistant' && message === current.messages[current.messages.length - 1]) {
      assistantBubble = {
        article: node,
        role: node.querySelector('.msg-role'),
        content: node.querySelector('.msg-content'),
        reasoning: null,
      };
    }
  }
  scrollToBottom();
}

function ensureReasoning(message) {
  if (assistantBubble?.reasoning || !message.reasoning) return assistantBubble?.reasoning;
  const details = document.createElement('details');
  details.className = 'reasoning';
  const summary = document.createElement('summary');
  summary.textContent = 'Reasoning';
  const pre = document.createElement('pre');
  details.append(summary, pre);
  assistantBubble.article.insertBefore(details, assistantBubble.content);
  assistantBubble.reasoning = { details, pre };
  return assistantBubble.reasoning;
}

function updateAssistantBubble(message) {
  if (!assistantBubble) return;
  assistantBubble.content.textContent = message.content || '';
  if (message.reasoning) {
    const reasoning = ensureReasoning(message);
    if (reasoning) reasoning.pre.textContent = message.reasoning;
  }
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateCharCount() {
  const length = messageEl.value.length;
  charCountEl.textContent = length ? `${length} characters` : '';
}

function setStreaming(value) {
  streaming = value;
  sendEl.disabled = value;
  stopEl.hidden = !value;
  stopEl.disabled = !value;
}

function parseEventBlock(block, assistant) {
  for (const line of block.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    const delta = event?.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.reasoning_content === 'string') {
      assistant.reasoning = (assistant.reasoning || '') + delta.reasoning_content;
    }
    if (typeof delta.content === 'string') {
      assistant.content = (assistant.content || '') + delta.content;
    }
  }
}

async function sendMessage() {
  if (streaming) return;
  const text = messageEl.value.trim();
  if (!text) return;

  updateCurrentFromInputs();
  if (!chats.includes(current)) chats.unshift(current);
  if (!current.title) current.title = titleFrom(text);
  const now = Date.now();
  current.messages.push({ id: uid(), role: 'user', content: text, at: now });
  const assistant = { id: uid(), role: 'assistant', content: '', reasoning: '', at: now };
  current.messages.push(assistant);
  current.updatedAt = now;
  messageEl.value = '';
  settings.draft = '';
  updateCharCount();
  saveAll();
  renderHistory();
  renderMessages();

  const messages = [];
  if (current.systemPrompt.trim()) messages.push({ role: 'system', content: current.systemPrompt.trim() });
  for (const message of current.messages.slice(0, -1)) {
    if ((message.role === 'user' || message.role === 'assistant') && message.content) {
      messages.push({ role: message.role, content: message.content });
    }
  }

  controller = new AbortController();
  stopRequested = false;
  setStreaming(true);
  modelStatusEl.textContent = 'Waiting for OpenCode Go...';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: current.model,
        temperature: current.temperature,
        max_tokens: current.maxTokens,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = `Request failed (${response.status})`;
      try {
        const error = await response.json();
        detail = [error.error, error.detail].filter(Boolean).join(': ') || detail;
      } catch {
        // Keep the status-based message.
      }
      throw new Error(detail);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let started = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        parseEventBlock(block, assistant);
        if (!started && (assistant.content || assistant.reasoning)) {
          started = true;
          modelStatusEl.textContent = 'Streaming';
        }
        updateAssistantBubble(assistant);
        scrollToBottom();
        scheduleSave();
      }
    }
    if (buffer.trim()) parseEventBlock(buffer, assistant);
    updateAssistantBubble(assistant);
    modelStatusEl.textContent = 'Done';
  } catch (error) {
    if (error.name === 'AbortError' || stopRequested) {
      assistant.stopped = true;
      modelStatusEl.textContent = 'Stopped';
      if (!assistant.content && !assistant.reasoning) assistant.content = '(stopped before any output)';
      updateAssistantBubble(assistant);
      if (assistantBubble && !assistantBubble.role.querySelector('.stopped')) {
        const stopped = document.createElement('span');
        stopped.className = 'stopped';
        stopped.textContent = 'Stopped';
        assistantBubble.role.append(stopped);
      }
    } else {
      assistant.content = assistant.content || `Error: ${error.message}`;
      modelStatusEl.textContent = 'Error';
      updateAssistantBubble(assistant);
    }
    console.error(error);
  } finally {
    controller = null;
    setStreaming(false);
    current.updatedAt = Date.now();
    saveAll();
    renderHistory();
    assistantBubble = null;
  }
}

function stopStreaming() {
  stopRequested = true;
  controller?.abort();
}

async function loadModels() {
  modelStatusEl.textContent = 'Loading models...';
  const preferred = current.model || DEFAULTS.model;
  try {
    const response = await fetch('/api/models');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload.data) ? payload.data : [];
    modelEl.replaceChildren();
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name || model.id;
      modelEl.append(option);
    }
    if (preferred && !models.some((model) => model.id === preferred)) {
      const option = document.createElement('option');
      option.value = preferred;
      option.textContent = preferred;
      modelEl.append(option);
    }
    modelEl.value = preferred || payload.default || models[0]?.id || DEFAULTS.model;
    current.model = modelEl.value;
    modelStatusEl.textContent = `${models.length} models`;
  } catch (error) {
    modelEl.replaceChildren();
    const option = document.createElement('option');
    option.value = preferred || DEFAULTS.model;
    option.textContent = preferred || DEFAULTS.model;
    modelEl.append(option);
    modelEl.value = option.value;
    modelStatusEl.textContent = 'Model list unavailable';
    console.error(error);
  }
}

for (const input of [systemPromptEl, temperatureEl, maxTokensEl, modelEl]) {
  input.addEventListener('input', () => {
    updateCurrentFromInputs();
    scheduleSave();
  });
  input.addEventListener('change', () => {
    updateCurrentFromInputs();
    saveAll();
  });
}

messageEl.addEventListener('input', () => {
  settings.draft = messageEl.value;
  updateCharCount();
  scheduleSave();
});
messageEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});

el('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});
stopEl.addEventListener('click', stopStreaming);
el('newChat').addEventListener('click', () => {
  if (streaming) return;
  current = newChat();
  settings.currentId = current.id;
  settings.draft = '';
  restoreInputs();
  renderHistory();
  renderMessages();
  saveAll();
  messageEl.focus();
});
el('clearHistory').addEventListener('click', () => {
  if (!chats.length || streaming) return;
  if (!window.confirm('Clear all saved chats from this browser?')) return;
  chats = [];
  current = newChat();
  settings.currentId = current.id;
  settings.draft = '';
  restoreInputs();
  renderHistory();
  renderMessages();
  saveAll();
});

restoreInputs();
renderHistory();
renderMessages();
loadModels();
