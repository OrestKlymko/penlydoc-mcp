#!/usr/bin/env node
// PenlyDoc MCP server: lets an AI assistant send documents for e-signature and follow them, through the PenlyDoc REST API.
// Configuration: PENLY_API_KEY (required, from Console → Developers), PENLY_URL (optional, default https://penlydoc.com).
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.PENLY_URL || 'https://penlydoc.com').replace(/\/+$/, '');
const KEY = process.env.PENLY_API_KEY || '';
const VERSION = '0.1.1';

class PenlyError extends Error {}

async function call(method, route, { json, form, auth = true, headers = {}, raw = false } = {}) {
  if (auth && !KEY) throw new PenlyError('PENLY_API_KEY is not set. Create a key in the PenlyDoc console (Developers) and add it to this server\'s environment.');
  const init = { method, headers: { 'User-Agent': `penlydoc-mcp/${VERSION}`, ...headers } };
  if (auth) init.headers.Authorization = `Bearer ${KEY}`;
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers['Content-Type'] = 'application/json'; }
  if (form) init.body = form;
  const res = await fetch(BASE + route, init);
  if (raw && res.ok) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text.slice(0, 300) }; }
  if (!res.ok) throw new PenlyError(`${res.status} ${data?.code || ''}: ${data?.detail || data?.title || res.statusText}`.trim());
  return data;
}

const enc = encodeURIComponent;
const ok = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: e instanceof PenlyError ? e.message : `Unexpected error: ${e.message}` }] });
const safe = fn => async args => { try { return await fn(args); } catch (e) { return fail(e); } };

// Short views keep the assistant's context small; get_envelope returns the full record.
const person = r => ({ id: r.id, position: r.position, name: r.name, email: r.email, role: r.role, delivery: r.delivery,
  status: r.status, viewedAt: r.viewedAt, completedAt: r.completedAt, declineReason: r.declineReason || undefined });
const envelopeShort = e => ({ id: e.id, title: e.title, status: e.status, externalRef: e.externalRef, createdAt: e.createdAt,
  sentAt: e.sentAt, completedAt: e.completedAt, expiresAt: e.expiresAt,
  signed: `${e.recipients.filter(r => r.role !== 'CC' && r.status === 'COMPLETED').length}/${e.recipients.filter(r => r.role !== 'CC').length}`,
  people: e.recipients.map(r => `${r.name} <${r.email}>: ${r.status}`) });
const envelopeFull = e => ({ ...envelopeShort(e), message: e.message, signingOrder: e.signingOrder, pageCount: e.pageCount,
  voidReason: e.voidReason || undefined, finalSha256: e.finalSha256 || undefined, metadata: e.metadata,
  recipients: e.recipients.map(person), consoleUrl: `${BASE}/console/#/envelopes/${e.id}` });

async function readPdf(file) {
  const abs = path.resolve(file);
  const bytes = await fs.readFile(abs).catch(() => { throw new PenlyError(`Cannot read file ${abs}`); });
  return { abs, blob: new Blob([bytes], { type: /\.(png)$/i.test(abs) ? 'image/png' : /\.(jpe?g)$/i.test(abs) ? 'image/jpeg' : 'application/pdf' }) };
}

const server = new McpServer({ name: 'penlydoc', version: VERSION }, {
  instructions: 'PenlyDoc sends documents for electronic signature. Tools that send, remind or cancel e-mail real people: '
    + 'confirm names, e-mail addresses and the document with the user before calling them. Prefer templates when one fits.'
});

server.registerTool('get_organisation', {
  title: 'Organisation',
  description: 'Shows which PenlyDoc organisation the API key belongs to, its default language and its sending limit.',
  annotations: { readOnlyHint: true, openWorldHint: true }
}, safe(async () => ok(await call('GET', '/v1/me'))));

server.registerTool('list_templates', {
  title: 'List templates',
  description: 'Lists the organisation\'s templates: id, name, the roles to fill (e.g. "tenant", "landlord"), the data keys to fill, and whether the template is ready to send.',
  annotations: { readOnlyHint: true, openWorldHint: true }
}, safe(async () => {
  const list = await call('GET', '/v1/templates');
  return ok(list.filter(t => !t.archived).map(t => ({ id: t.id, name: t.name, title: t.title, ready: t.ready,
    roles: t.roles.map(r => ({ key: r.key, label: r.label, role: r.role || 'SIGNER', delivery: r.delivery || 'EMAIL' })),
    dataKeys: t.dataKeys, missing: t.missing?.length ? t.missing : undefined })));
}));

server.registerTool('send_from_template', {
  title: 'Send from a template',
  description: 'Creates a document from a template: one person per role, values for its data keys. With send=true PenlyDoc immediately '
    + 'e-mails the people with delivery EMAIL; confirm the people and values with the user first. With send=false it creates a draft '
    + 'the user can review in the console. Use the same externalRef/idempotencyKey to safely retry.',
  inputSchema: {
    templateId: z.string().uuid(),
    roles: z.record(z.object({
      name: z.string().min(1).max(200),
      email: z.string().email(),
      delivery: z.enum(['EMAIL', 'EMBEDDED']).optional().describe('EMBEDDED = no e-mail; you show the signing page in your own app'),
      language: z.enum(['en', 'sk', 'cs', 'uk', 'fr']).optional()
    })).describe('Keyed by role key from list_templates, e.g. {"tenant": {"name": "Mia Novak", "email": "mia@example.com"}}'),
    data: z.record(z.string().max(500)).optional().describe('Values for the template data keys, e.g. {"Rent": "950 EUR"}'),
    send: z.boolean().describe('true = e-mail people now; false = draft'),
    title: z.string().max(300).optional(),
    message: z.string().max(4000).optional(),
    externalRef: z.string().max(200).optional().describe('Your own reference, e.g. an order or contract number'),
    idempotencyKey: z.string().max(200).optional()
  },
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
}, safe(async ({ templateId, idempotencyKey, ...body }) => {
  const e = await call('POST', `/v1/templates/${enc(templateId)}/envelopes`, { json: body,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {} });
  return ok(envelopeFull(e));
}));

server.registerTool('send_document', {
  title: 'Send a document',
  description: 'Uploads local files (PDF, or PNG/JPEG photos of pages, joined in order) and creates a document for signature. '
    + 'Signature boxes come from {{sig:1}}-style tags in the PDF or from the fields argument (points, top-left origin). '
    + 'With send=true PenlyDoc e-mails the people right away; confirm with the user first. Without tags or fields, use send=false '
    + 'and let the user place the boxes in the console (the result has a link).',
  inputSchema: {
    files: z.array(z.string()).min(1).max(20).describe('Local file paths'),
    title: z.string().min(1).max(300),
    message: z.string().max(4000).optional(),
    recipients: z.array(z.object({
      name: z.string().min(1).max(200),
      email: z.string().email(),
      role: z.enum(['SIGNER', 'APPROVER', 'CC']).optional(),
      routingOrder: z.number().int().min(1).max(100).optional(),
      delivery: z.enum(['EMAIL', 'EMBEDDED']).optional(),
      language: z.enum(['en', 'sk', 'cs', 'uk', 'fr']).optional()
    })).min(1).max(25),
    signingOrder: z.enum(['SEQUENTIAL', 'PARALLEL']).optional(),
    fields: z.array(z.object({
      recipient: z.number().int().min(1).describe('1-based position in recipients'),
      type: z.enum(['SIGNATURE', 'INITIALS', 'DATE', 'NAME', 'TEXT', 'CHECKBOX']),
      page: z.number().int().min(1), x: z.number().min(0), y: z.number().min(0),
      width: z.number().positive(), height: z.number().positive(),
      required: z.boolean().optional(), label: z.string().max(100).optional()
    })).optional(),
    data: z.record(z.string().max(500)).optional().describe('Values for {{data:Key}} tags in the PDF'),
    send: z.boolean(),
    externalRef: z.string().max(200).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional()
  },
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
}, safe(async ({ files, ...envelope }) => {
  const form = new FormData();
  form.append('envelope', new Blob([JSON.stringify(envelope)], { type: 'application/json' }));
  for (const f of files) { const { abs, blob } = await readPdf(f); form.append('documents', blob, path.basename(abs)); }
  const e = await call('POST', '/v1/envelopes', { form });
  return ok(envelopeFull(e));
}));

server.registerTool('list_documents', {
  title: 'List documents',
  description: 'Lists documents sent for signature, newest first, with who has signed. Filter by status or by your externalRef.',
  inputSchema: {
    status: z.enum(['DRAFT', 'SENT', 'PARTIALLY_SIGNED', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']).optional(),
    externalRef: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(200).default(25)
  },
  annotations: { readOnlyHint: true, openWorldHint: true }
}, safe(async ({ status, externalRef, limit }) => {
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (externalRef) q.set('externalRef', externalRef);
  const list = await call('GET', '/v1/envelopes' + (q.size ? '?' + q : ''));
  return ok({ total: list.length, documents: list.slice(0, limit).map(envelopeShort) });
}));

server.registerTool('get_document', {
  title: 'Document status',
  description: 'Full status of one document: each person, whether they opened, signed or declined (with the reason), and when.',
  inputSchema: { id: z.string().uuid() },
  annotations: { readOnlyHint: true, openWorldHint: true }
}, safe(async ({ id }) => ok(envelopeFull(await call('GET', `/v1/envelopes/${enc(id)}`)))));

server.registerTool('get_history', {
  title: 'Document history',
  description: 'The hash-chained history of a document: every step with time, who and IP address, and whether the chain is intact.',
  inputSchema: { id: z.string().uuid() },
  annotations: { readOnlyHint: true, openWorldHint: true }
}, safe(async ({ id }) => {
  const a = await call('GET', `/v1/envelopes/${enc(id)}/audit`);
  return ok({ chainValid: a.chainValid, events: a.events.map(x => ({ at: x.createdAt, type: x.type, actor: x.actor, ip: x.ip || undefined })) });
}));

server.registerTool('send_draft', {
  title: 'Send a draft',
  description: 'Sends a DRAFT document: PenlyDoc e-mails the first people to sign. Confirm with the user first.',
  inputSchema: { id: z.string().uuid() },
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
}, safe(async ({ id }) => ok(envelopeFull(await call('POST', `/v1/envelopes/${enc(id)}/send`)))));

server.registerTool('send_reminder', {
  title: 'Remind',
  description: 'E-mails a reminder now to everyone whose turn it is on this document. Confirm with the user first.',
  inputSchema: { id: z.string().uuid() },
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
}, safe(async ({ id }) => ok(await call('POST', `/v1/envelopes/${enc(id)}/remind`))));

server.registerTool('cancel_document', {
  title: 'Cancel a document',
  description: 'Cancels (voids) a document that is still being signed. Signing links stop working and the people still to act are told by e-mail. '
    + 'This cannot be undone; confirm with the user first.',
  inputSchema: { id: z.string().uuid(), reason: z.string().min(1).max(1000) },
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true }
}, safe(async ({ id, reason }) => ok(envelopeFull(await call('POST', `/v1/envelopes/${enc(id)}/void`, { json: { reason } })))));

server.registerTool('create_signing_link', {
  title: 'Signing link for an embedded signer',
  description: 'Creates a one-hour signing link for a person with delivery EMBEDDED, to open in your own app or hand to that person. '
    + 'The link lets whoever has it sign as that person: share it only with them.',
  inputSchema: { id: z.string().uuid(), recipientId: z.string().uuid(), returnUrl: z.string().url().optional() },
  annotations: { destructiveHint: false, openWorldHint: true }
}, safe(async ({ id, recipientId, returnUrl }) => ok(await call('POST',
  `/v1/envelopes/${enc(id)}/recipients/${enc(recipientId)}/signing-url`, { json: returnUrl ? { returnUrl } : {} }))));

server.registerTool('download_signed_pdf', {
  title: 'Download the signed PDF',
  description: 'Saves the sealed, signed PDF (with the certificate of completion as last page) of a COMPLETED document to a local file.',
  inputSchema: { id: z.string().uuid(), saveTo: z.string().describe('Local path for the PDF, e.g. ./signed/contract.pdf') },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, safe(async ({ id, saveTo }) => {
  const res = await call('GET', `/v1/envelopes/${enc(id)}/documents/signed`, { raw: true });
  const abs = path.resolve(saveTo);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const bytes = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(abs, bytes, { flag: 'wx' }).catch(e => { throw new PenlyError(e.code === 'EEXIST' ? `${abs} already exists; choose another path` : e.message); });
  return ok(`Saved ${bytes.length} bytes to ${abs}`);
}));

server.registerTool('verify_pdf', {
  title: 'Check a signed PDF',
  description: 'Checks a local signed PDF: is the seal intact, when was it sealed, who signed. Works for any PDF; nothing is stored. No API key needed.',
  inputSchema: { file: z.string().describe('Local path of the PDF') },
  annotations: { readOnlyHint: true, openWorldHint: true }
}, safe(async ({ file }) => {
  const { abs, blob } = await readPdf(file);
  const form = new FormData();
  form.append('document', blob, path.basename(abs));
  return ok(await call('POST', '/api/verify', { form, auth: false }));
}));

await server.connect(new StdioServerTransport());
