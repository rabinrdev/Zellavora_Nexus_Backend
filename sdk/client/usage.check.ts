// Compile-time proof that the generated types resolve (built by `npm run typecheck`; never executed).
import { createApi } from './index.js';

export async function smoke() {
  let tokens: { accessToken: string; refreshToken: string } | null = null;
  const api = createApi({
    baseUrl: 'http://localhost:3000',
    getTokens: () => tokens,
    onTokens: (t) => { tokens = t; },
    onAuthLost: () => { tokens = null; },
  });
  const login = await api.loginWithPassword({ body: { email: 'amelia.hart@example.test', password: 'Correct-Horse-Battery-9' } });
  const org = login.data?.data.organizationId;
  const project = await api.createProject({ body: { name: 'Website refresh' } });
  const projectId = project.data?.data.id ?? '';
  const tasks = await api.listProjectTasks({ path: { projectId }, query: { limit: 10, status: 'todo' } });
  const next = tasks.data?.meta.nextCursor;
  const sent = await api.sendInvoice({ path: { invoiceId: '3d4e6a52-5d1e-4b0c-9a4e-1f2d3c4b5a44' }, header: { 'Idempotency-Key': 'abc' } });
  return { org, next, sent: sent.response.status, err: sent.error?.errorMessage[0]?.code };
}
