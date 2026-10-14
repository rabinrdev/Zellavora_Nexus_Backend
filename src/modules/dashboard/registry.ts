import type { Trx } from '../../platform/scope.js';
import type { Services } from '../../platform/types.js';

export interface WidgetCtx {
  trx: Trx;
  svc: Services;
  organizationId: string;
  userId: string;
  from: Date;
  to: Date;
  granularity: 'day' | 'week' | 'month';
}

export interface WidgetDef {
  key: string;
  title: string;
  requiredPermission: string;
  /** Module flag that must be on; otherwise the widget reports a well-defined "module not enabled" state. */
  requiredModuleFlag?: string;
  query(ctx: WidgetCtx): Promise<unknown>;
}

const widgets = new Map<string, WidgetDef>();
export const registerWidget = (w: WidgetDef) => void widgets.set(w.key, w);
export const allWidgets = () => [...widgets.values()];
export const getWidget = (k: string) => widgets.get(k);

export interface ReportDef {
  key: string;
  title: string;
  requiredPermission: string;
  requiredModuleFlag?: string;
  run(ctx: { trx: Trx; svc: Services; organizationId: string; userId: string; params: Record<string, string | undefined> }): Promise<Record<string, unknown>[]>;
}
const reports = new Map<string, ReportDef>();
export const registerReport = (r: ReportDef) => void reports.set(r.key, r);
export const allReports = () => [...reports.values()];
export const getReport = (k: string) => reports.get(k);
