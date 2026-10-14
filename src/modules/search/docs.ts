import { z } from 'zod';
import { documentRoutes, uuid } from '../../platform/openapi/document.js';

const hit = z.object({ id: uuid.describe('Record id.'), title: z.string().describe('Display title.'), subtitle: z.string().nullable().optional().describe('Secondary text (status, email, company).') });

documentRoutes({
  searchGlobal: {
    successStatus: 200,
    response: z.object({
      query: z.string().describe('The search text.'),
      results: z.record(z.string(), z.array(hit)).describe('Hits grouped by type: `project`, `task`, `document`, `client`, `lead`, `contact`, `member`. Only types the caller may read (permission and module flag) appear.'),
    }),
    responseExample: { query: 'acme', results: { client: [{ id: '3d4e6a52-5d1e-4b0c-9a4e-1f2d3c4b5a44', title: 'Acme Ltd', subtitle: 'billing@example.test' }] } },
    description: 'Searches several modules at once (case-insensitive contains, min 2 characters). `types` restricts the sources (comma separated); `limit` is per type (1-20). Rate limited.',
  },
});
