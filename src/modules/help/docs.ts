import { z } from 'zod';
import { documentRoutes, uuid } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const article = rowOf('help_articles', { hide: ['organization_id'] });

documentRoutes({
  listHelpArticles: {
    response: article.extend({ scope: z.enum(['global', 'organization']).describe('Platform article or the organization\'s own.') }).pick({ id: true, slug: true, title: true, category: true, locale: true, updatedAt: true, scope: true }),
    responseName: 'HelpArticleSummary', list: { sortable: ['title', 'updated_at'], filterable: [], defaultSort: 'title' },
    description: 'Searches published help articles (platform plus organization). Extra filters: `category`, `locale` (default `en`).',
  },
  getHelpArticleBySlug: { response: article, responseName: 'HelpArticle', description: 'One article by slug for the given `locale`.' },
  submitHelpArticleFeedback: { successStatus: 200, response: z.object({ recorded: z.literal(true).describe('Always true.') }), description: 'Records whether the article was helpful.' },
  createHelpArticle: { successStatus: 201, response: z.object({ id: uuid.describe('Article id.'), slug: z.string().describe('Slug.') }), errors: [409], description: 'Creates an organization-specific article.' },
  updateHelpArticle: { successStatus: 200, response: z.object({ id: uuid.describe('Article id.') }), description: 'Updates an organization article. Platform articles cannot be changed here (`404`).' },
  replacePlatformHelpArticle: {
    successStatus: 200, response: z.object({ slug: z.string().describe('Slug.'), locale: z.string().describe('Locale.') }),
    description: 'Platform administrators only. Creates or replaces a global article.',
  },
  getOnboardingChecklist: {
    response: z.object({
      items: z.array(z.object({ key: z.string().describe('Step key.'), title: z.string().describe('What to do.'), done: z.boolean().describe('Computed from real data, never self-reported.') })).describe('Checklist steps.'),
      completed: z.number().int().describe('Steps done.'), total: z.number().int().describe('Total steps.'),
    }),
    responseName: 'OnboardingChecklist', description: 'Getting-started checklist for the organization.',
  },
  getHelpFeedbackSummary: {
    response: z.object({ articleId: uuid.describe('Article.'), title: z.string().describe('Title.'), total: z.number().int().describe('Feedback votes.'), helpful: z.number().int().describe('Helpful votes.') }),
    responseName: 'HelpFeedbackSummary', collection: true, description: 'Feedback totals per article.',
  },
});
