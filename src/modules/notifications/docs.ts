import { z } from 'zod';
import { documentRoutes, uuid } from '../../platform/openapi/document.js';
import { rowOf } from '../../platform/openapi/rows.js';

const channel = z.enum(['in_app', 'email']).describe('Delivery channel.');

documentRoutes({
  listMyNotifications: {
    response: rowOf('notifications', { hide: ['dedupe_key', 'in_app'] }), responseName: 'Notification',
    list: { sortable: ['created_at'], filterable: [], defaultSort: '-created_at', searchable: false },
    description: 'In-app notifications of the caller, newest first. Extra filter: `unread=true|false`.',
  },
  getMyUnreadNotificationCount: { response: z.object({ unread: z.number().int().describe('Unread notifications.') }), description: 'Badge counter.' },
  markAllNotificationsRead: { successStatus: 200, response: z.object({ updated: z.number().int().describe('Notifications marked.') }), description: 'Marks every unread notification as read.' },
  markNotificationRead: { successStatus: 200, response: z.object({ id: uuid.describe('Notification id.'), read: z.literal(true).describe('Always true.') }), description: 'Marks one notification as read.' },
  getMyNotificationPreferences: {
    response: z.object({ eventType: z.string().describe('Event type, e.g. `task.assigned`.'), channel, enabled: z.boolean().describe('Whether this channel is on (default on).') }),
    responseName: 'NotificationPreference', collection: true, description: 'One row per event type and channel.',
  },
  replaceMyNotificationPreferences: { successStatus: 200, response: z.object({ updated: z.number().int().describe('Preferences stored.') }), description: 'Upserts the given preferences.' },
  replaceNotificationTemplate: {
    successStatus: 201, response: z.object({ id: uuid.describe('Template id.'), version: z.number().int().describe('New version number.') }),
    description: 'Creates a new version of an organization override for an event type; placeholders use `{{name}}`.',
  },
  listNotificationTemplates: {
    response: z.object({
      defaults: z.array(z.object({ eventType: z.string().describe('Event type.'), subject: z.string().describe('Default subject.'), body: z.string().describe('Default body.') })).describe('Platform defaults.'),
      overrides: z.array(rowOf('notification_templates')).describe('Active organization overrides.'),
    }),
    responseName: 'NotificationTemplates', description: 'Default templates and the organization\'s overrides.',
  },
  previewNotificationTemplate: {
    successStatus: 200, response: z.object({ subject: z.string().describe('Rendered subject.'), text: z.string().describe('Plain-text body.'), html: z.string().describe('HTML body (escaped).') }),
    description: 'Renders a template with sample data without sending anything.',
  },
  listNotificationDeliveries: {
    response: z.record(z.string(), z.unknown()).describe('A delivery attempt row.'), responseName: 'NotificationDelivery',
    list: { sortable: ['created_at'], filterable: [], defaultSort: '-created_at', searchable: false }, description: 'Delivery attempts and failures per channel.',
  },
});
