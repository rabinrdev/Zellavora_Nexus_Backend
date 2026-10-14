/**
 * Naming rules shared by the route registry, the OpenAPI builder and the lint/tests.
 * operationIds are camelCase `verbNoun` and start with a verb from OPERATION_VERBS (docs/API_NAMING.md).
 */

/** Verbs an operationId may start with: the CRUD vocabulary plus the domain state-action verbs. */
export const OPERATION_VERBS = [
  'list', 'get', 'create', 'update', 'replace', 'delete', 'restore', 'purge', 'search', 'export', 'import', 'download', 'upload',
  'assign', 'unassign', 'add', 'remove', 'set', 'run', 'check', 'start', 'record', 'request', 'issue', 'raise',
  'login', 'logout', 'refresh', 'register', 'verify', 'reset', 'accept', 'switch', 'resend', 'revoke', 'rotate', 'regenerate',
  'confirm', 'disable', 'begin', 'submit', 'recall', 'approve', 'reject', 'deny', 'cancel', 'resubmit', 'reassign', 'delegate',
  'send', 'void', 'allocate', 'reconcile', 'publish', 'unpublish', 'schedule', 'rollback', 'preview', 'activate', 'suspend',
  'reactivate', 'convert', 'retry', 'replay', 'resolve', 'acknowledge', 'process', 'transition', 'move', 'comment', 'attach',
  'ingest', 'test', 'transfer', 'decide', 'invite', 'evaluate', 'mark', 'receive', 'trace', 'impersonate', 'save', 'stream',
  'link', 'persist', 'complete', 'respond', 'reorder', 'sign', 'provision', 'grant', 'change',
] as const;

const ACTION_SEGMENTS = new Set([
  'send', 'void', 'approve', 'reject', 'restore', 'publish', 'unpublish', 'schedule', 'submit', 'recall', 'revoke', 'resend',
  'rotate', 'cancel', 'reactivate', 'suspend', 'activate', 'convert', 'retry', 'replay', 'resolve', 'acknowledge', 'allocate',
  'reassign', 'resubmit', 'rollback', 'test', 'preview', 'process', 'accept', 'deny', 'export', 'import', 'run', 'transition',
  'verify', 'confirm', 'disable', 'setup', 'reconcile', 'move', 'purge', 'impersonate', 'login', 'logout', 'refresh', 'register',
  'regenerate', 'rotate-secret', 'request-changes', 'preview-link', 'read-all', 'from-template', 'from-timesheets', 'logout-all',
  'verify-email', 'resend-verification', 'forgot-password', 'reset-password', 'switch-organization', 'rotate-encryption-key',
  'set-password', 'first-admin', 'read', 'allocate', 'decision',
]);

const IRREGULAR_SINGULAR: Record<string, string> = {
  status: 'status', address: 'address', access: 'access', analytics: 'analytics', media: 'media', settings: 'settings',
  series: 'series', metadata: 'metadata', delegations: 'delegation', pdf: 'pdf', content: 'content', usage: 'usage',
  health: 'health', me: 'me',
};

export function singularize(word: string): string {
  if (IRREGULAR_SINGULAR[word]) return IRREGULAR_SINGULAR[word];
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(sses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export const pascal = (kebab: string): string =>
  kebab.split(/[-_]/).filter(Boolean).map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
export const camel = (kebab: string): string => {
  const p = pascal(kebab);
  return p.length ? p[0]!.toLowerCase() + p.slice(1) : p;
};

/**
 * `:id` is never exposed: it is renamed after the resource that precedes it (`/projects/:id` → `projectId`).
 * Returns { exposedName: internalName } so handlers and Zod schemas can keep reading `params.id`.
 */
export function describeParamNames(path: string): Record<string, string> {
  const segs = path.split('/').filter(Boolean);
  const out: Record<string, string> = {};
  const used = new Set(segs.filter((s) => s.startsWith(':')).map((s) => s.slice(1)));
  segs.forEach((s, i) => {
    if (s !== ':id') return;
    const prev = segs[i - 1];
    const prevPrev = segs[i - 2];
    if (!prev || prev.startsWith(':')) return;
    let base = singularize(prev);
    if (prevPrev && !prevPrev.startsWith(':') && ['versions', 'entries', 'instances', 'values', 'failures', 'items'].includes(prev)) {
      base = `${singularize(prevPrev)}-${base}`;
    }
    let name = `${camel(base)}Id`;
    while (used.has(name)) name = `${name}2`;
    used.add(name);
    out[name] = 'id';
  });
  return out;
}

export interface PathShape { statics: string[]; endsWithParam: boolean; lastStatic: string; hasParam: boolean }
export function shapeOf(path: string): PathShape {
  const segs = path.split('/').filter(Boolean);
  const statics = segs.filter((s) => !s.startsWith(':'));
  return {
    statics, endsWithParam: segs[segs.length - 1]?.startsWith(':') ?? false,
    lastStatic: statics[statics.length - 1] ?? '', hasParam: segs.some((s) => s.startsWith(':')),
  };
}

/** Best-effort default; the committed operation catalog is the reviewed source of truth. */
export function suggestOperationId(method: string, path: string): string {
  const segs = path.split('/').filter(Boolean);
  const { endsWithParam, lastStatic } = shapeOf(path);
  const isAction = !endsWithParam && ACTION_SEGMENTS.has(lastStatic) && method === 'post';
  // a parent resource is singular when a path param follows it (/projects/:id/tasks → ProjectTask)
  const parts: { s: string; parent: boolean }[] = [];
  segs.forEach((s, i) => {
    if (!s.startsWith(':')) parts.push({ s, parent: segs[i + 1]?.startsWith(':') ?? false });
  });
  const body = isAction ? parts.slice(0, -1) : parts;
  const lastIdx = body.length - 1;
  const single = endsWithParam || isAction || (method !== 'get' && method !== 'put');
  const noun = body.map((p, i) => pascal(p.parent || (i === lastIdx && single) ? singularize(p.s) : p.s)).join('');
  const collection = body.map((p) => pascal(p.parent ? singularize(p.s) : p.s)).join('');
  if (isAction) return `${camel(lastStatic)}${noun}`;
  switch (method) {
    case 'get': return endsWithParam ? `get${noun}ById` : `list${collection}`;
    case 'post': return `create${noun}`;
    case 'patch': return `update${noun}`;
    case 'put': return `replace${collection}`;
    case 'delete': return `delete${noun}`;
    default: return `${method}${noun}`;
  }
}
