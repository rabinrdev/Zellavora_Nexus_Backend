import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

/** Must run before any schema is created (zod 4 binds methods at construction), so route.ts imports it first. */
extendZodWithOpenApi(z);
