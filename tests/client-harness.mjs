import { readFile } from 'node:fs/promises';

let importSequence = 0;

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function settle() {
  // Drain the bounded chains used by event handlers without advancing time.
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

export function createStream() {
  const track = { stopCalls: 0, readyState: 'live', stop() { this.stopCalls++; this.readyState = 'ended'; } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}

export class FakeStorage {
  constructor(entries = []) { this.data = new Map(entries); }
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(String(key)) ?? null; }
  setItem(key, value) { this.data.set(String(key), String(value)); }
  removeItem(key) { this.data.delete(String(key)); }
  clear() { this.data.clear(); }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.disabled = false;
    this.value = '';
    this.children = [];
    this.events = new Map();
    this._text = '';
    this._classNames = new Set();
    this.style = {};
    this.dataset = {};
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.classList = {
      add: (...names) => names.forEach(name => this._classNames.add(name)),
      remove: (...names) => names.forEach(name => this._classNames.delete(name)),
      contains: name => this._classNames.has(name),
      toggle: (name, force = !this._classNames.has(name)) => {
        force ? this._classNames.add(name) : this._classNames.delete(name);
        return force;
      },
    };
  }
  get className() { return [...this._classNames].join(' '); }
  set className(value) { this._classNames = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  set innerHTML(value) {
    if (value !== '') throw new Error('Offline DOM only supports clearing innerHTML; markup needs explicit nodes');
    this._text = ''; this.children = [];
  }
  get innerHTML() { return this.textContent; }
  appendChild(child) { this.children.push(child); this.scrollHeight += 1; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children = [...children]; this._text = ''; }
  setAttribute(name, value) { this[name] = String(value); }
  getAttribute(name) { return this[name] ?? null; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(type, handler, options = {}) {
    const entries = this.events.get(type) ?? [];
    entries.push({ handler, once: options === true ? false : !!options.once });
    this.events.set(type, entries);
  }
  removeEventListener(type, handler) {
    this.events.set(type, (this.events.get(type) ?? []).filter(entry => entry.handler !== handler));
  }
  async dispatch(type, event = {}) {
    const entries = [...(this.events.get(type) ?? [])];
    const pending = [];
    for (const entry of entries) {
      if (entry.once) this.removeEventListener(type, entry.handler);
      pending.push(entry.handler({ target: this, type, ...event }));
    }
    await Promise.all(pending);
    await settle();
  }
  async click() { if (!this.disabled) await this.dispatch('click'); }
}

export async function createClientHarness(options = {}) {
  const realDate = globalThis.Date;
  const clock = { now: options.now ?? 2_000_000_000_000, nextId: 1, timers: new Map() };
  const globals = new Map();
  const replaceGlobal = (name, value) => {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const restore = () => {
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  const storage = options.storage ?? new FakeStorage();
  const requests = [], sockets = [], contexts = [], streams = [], logs = [];
  const documentEvents = new FakeElement('document');
  const windowEvents = new FakeElement('window');
  const html = await readFile(new URL('../telegram/webapp/index.html', import.meta.url), 'utf8');
  const nodes = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const node = new FakeElement(match[1]);
    node.className = match[0].match(/\bclass="([^"]*)"/)?.[1] ?? '';
    nodes.set(node.id, node);
  }
  const document = {
    readyState: 'loading',
    getElementById: id => nodes.get(id) ?? null,
    querySelector: selector => selector.startsWith('.') ? [...nodes.values()].find(node => node.classList.contains(selector.slice(1))) ?? null : null,
    createElement: () => new FakeElement(),
    addEventListener: (...args) => documentEvents.addEventListener(...args),
    removeEventListener: (...args) => documentEvents.removeEventListener(...args),
  };
  const window = {
    Telegram: options.Telegram,
    addEventListener: (...args) => windowEvents.addEventListener(...args),
    removeEventListener: (...args) => windowEvents.removeEventListener(...args),
  };
  const schedule = (callback, delay = 0, ...args) => {
    const id = clock.nextId++;
    clock.timers.set(id, { callback, args, at: clock.now + Math.max(0, Number(delay) || 0) });
    return id;
  };
  class FakeDate extends realDate {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = String(url);
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.closeCalls = [];
      sockets.push(this);
    }
    send(data) {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error('Socket is not open');
      this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
    }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close(code = 1000, reason = '') {
      this.closeCalls.push({ code, reason });
      this.readyState = FakeWebSocket.CLOSING;
      queueMicrotask(() => this.finishClose(code, reason));
    }
    finishClose(code = 1006, reason = '') {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code, reason });
    }
    fail() { this.onerror?.({}); }
    addEventListener(type, handler) { this[`on${type}`] = handler; }
    removeEventListener(type, handler) { if (this[`on${type}`] === handler) this[`on${type}`] = null; }
  }
  class FakeAudioContext {
    constructor(config) {
      this.config = config;
      this.sampleRate = config?.sampleRate ?? 48000;
      this.state = 'suspended';
      this.closeCalls = 0;
      this.resumeCalls = 0;
      this.destination = {};
      this.audioWorklet = { addModule: async (url) => options.workletAddModule?.(this, url) };
      contexts.push(this);
    }
    resume() {
      this.resumeCalls++;
      if (options.resume) return options.resume(this);
      this.state = 'running'; return Promise.resolve();
    }
    close() { this.closeCalls++; this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource(stream) { return { stream, connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  }
  class FakeAudioWorkletNode {
    constructor(context, name) {
      this.context = context; this.name = name;
      this.port = { sent: [], postMessage: data => this.port.sent.push(data), close() {} };
    }
    connect() { return this; }
    disconnect() {}
  }
  const mediaDevices = {
    getUserMedia: constraints => {
      if (options.getUserMedia) return options.getUserMedia(constraints);
      const stream = createStream(); streams.push(stream); return Promise.resolve(stream);
    },
  };
  replaceGlobal('window', window);
  replaceGlobal('document', document);
  replaceGlobal('location', { search: options.search ?? '', href: 'https://demo.invalid/' });
  replaceGlobal('sessionStorage', storage);
  replaceGlobal('localStorage', { getItem() { throw new Error('Unexpected localStorage access'); } });
  replaceGlobal('WebSocket', FakeWebSocket);
  replaceGlobal('AudioContext', FakeAudioContext);
  replaceGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  replaceGlobal('navigator', { mediaDevices });
  replaceGlobal('setTimeout', schedule);
  replaceGlobal('clearTimeout', id => clock.timers.delete(id));
  replaceGlobal('Date', FakeDate);
  replaceGlobal('fetch', async (...args) => {
    requests.push(args);
    if (options.fetch) return options.fetch(...args);
    throw new Error('Unexpected network request in offline client test');
  });
  replaceGlobal('console', { ...globalThis.console, log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) });
  Object.assign(window, { AudioContext: FakeAudioContext, sessionStorage: storage, navigator: { mediaDevices } });
  let app;
  try {
    // Native import executes the actual client module. DOMContentLoaded remains
    // un-dispatched, so importing never starts a microphone or connection.
    const module = await import(new URL(`../telegram/webapp/app.js?test=${++importSequence}`, import.meta.url));
    app = module.__testing;
    if (!app) throw new Error('Client must export __testing for native offline imports');
  } catch (error) { restore(); throw error; }
  return {
    app, storage, nodes, documentEvents, windowEvents, clock,
    requests, sockets, contexts, streams, logs, FakeWebSocket,
    async tick(milliseconds) {
      const target = clock.now + milliseconds;
      for (let steps = 0; ; steps++) {
        if (steps > 1000) throw new Error('Timer loop exceeded offline test limit');
        await settle();
        const due = [...clock.timers.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, task] = due;
        clock.timers.delete(id); clock.now = task.at;
        task.callback(...task.args);
      }
      clock.now = target;
      await settle();
    },
    async boot() { await documentEvents.dispatch('DOMContentLoaded'); },
    socket(url = 'wss://offline.invalid/') { const ws = new FakeWebSocket(url); ws.open(); return ws; },
    async dispose() { await settle(); clock.timers.clear(); restore(); },
  };
}
