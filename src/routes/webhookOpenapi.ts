import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { webhookCreateSchema, webhookMessageSchema, webhookUpdateSchema } from "./webhookSchemas";

type Json = Record<string, unknown>;

/** Request bodies come from the zod schemas the routes parse with, so the two can't disagree. */
function inputSchema(schema: z.ZodType): Json {
  const json = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12", unrepresentable: "any" }) as Json;
  delete json.$schema;
  return json;
}

const problemSchema = z.object({
  path: z.string().describe("Where in the payload, like `cards[0].fields[3].value`."),
  code: z.enum([
    "required", "wrong_type", "too_long", "too_many", "invalid_url", "invalid_color",
    "invalid_timestamp", "empty_card", "total_too_long", "invalid_format", "invalid",
  ]),
  limit: z.number().int().optional(),
  message: z.string(),
});

const warningSchema = z.object({
  path: z.string(),
  code: z.enum([
    "unknown_key", "blocked", "fetch_failed", "too_large", "timeout",
    "unsupported_type", "invalid_image", "media_budget", "store_failed",
  ]).describe("`unknown_key` is a key that was ignored. Every other code is a picture that was left out."),
  message: z.string(),
});

const sentSchema = z.object({
  message_id: z.string(),
  conversation_id: z.string(),
  warnings: z.array(warningSchema),
});

const invalidSchema = z.object({
  error: z.literal("invalid_payload"),
  message: z.string(),
  problems: z.array(problemSchema).max(20),
});

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const webhookSchema = z.object({
  webhook_id: z.string(),
  channel_id: z.string(),
  display_name: z.string(),
  avatar_file_id: z.string().nullable(),
  token: z.string(),
  created_by_server_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Json, description: string) => ({ description, content: { "application/json": { schema } } });
const idParam = { name: "webhookId", in: "path", required: true, schema: { type: "string" } };
const bearer = [{ bearerAuth: [] }];

/** The webhook endpoints, as OpenAPI 3.1. Written to openapi/webhooks.json, and a test fails when that drifts. */
export function buildWebhookOpenApi(): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "Gryt webhooks",
      version: "1",
      description:
        "Post messages into a Gryt channel from anywhere that can send an HTTP request, and manage the webhooks that do it. Every path is relative to your Gryt server.",
      license: { name: "AGPL-3.0-or-later", identifier: "AGPL-3.0-or-later" },
    },
    servers: [{ url: "https://{server}", variables: { server: { default: "gryt.example.com", description: "Your Gryt server's address." } } }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "A member's access token. Needs the manage_webhooks permission." },
      },
      schemas: {
        WebhookMessage: inputSchema(webhookMessageSchema),
        WebhookCreate: inputSchema(webhookCreateSchema),
        WebhookUpdate: inputSchema(webhookUpdateSchema),
        WebhookMessageSent: inputSchema(sentSchema),
        InvalidPayload: inputSchema(invalidSchema),
        Error: inputSchema(errorSchema),
        Webhook: inputSchema(webhookSchema),
      },
    },
    paths: {
      "/api/webhooks/{webhookId}/{token}": {
        post: {
          operationId: "executeWebhook",
          summary: "Post a message",
          security: [],
          description:
            "Posts text, cards or both into the webhook's channel. Pictures are downloaded by the server before it answers, so the call can take a few seconds. A picture that fails is left out and listed under `warnings`, and the message still posts. Limited to 30 messages a minute per webhook.",
          parameters: [idParam, { name: "token", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: ref("WebhookMessage") } } },
          responses: {
            "200": json(ref("WebhookMessageSent"), "Posted."),
            "400": {
              description: "The payload was refused, or the webhook has no channel. Nothing was posted.",
              content: { "application/json": { schema: { anyOf: [ref("InvalidPayload"), ref("Error")] } } },
            },
            "404": json(ref("Error"), "No webhook with that id and token."),
            "413": json(ref("Error"), "The body is over 256 KB."),
            "429": json({ type: "object", properties: { error: { const: "rate_limited" }, retry_after_ms: { type: "integer" } } }, "Too many messages. Try again after `retry_after_ms`."),
          },
        },
      },
      "/api/webhooks": {
        get: {
          operationId: "listWebhooks",
          summary: "List webhooks",
          security: bearer,
          responses: {
            "200": json({ type: "object", properties: { items: { type: "array", items: ref("Webhook") } } }, "The webhooks in channels you can see."),
            "403": json(ref("Error"), "No manage_webhooks permission."),
          },
        },
        post: {
          operationId: "createWebhook",
          summary: "Create a webhook",
          security: bearer,
          requestBody: { required: true, content: { "application/json": { schema: ref("WebhookCreate") } } },
          responses: {
            "201": json({ allOf: [ref("Webhook"), { type: "object", properties: { url: { type: "string" } } }] }, "Created. `url` is what to post to."),
            "400": json(ref("InvalidPayload"), "The body was refused."),
            "403": json(ref("Error"), "No manage_webhooks permission."),
            "404": json(ref("Error"), "The avatar file doesn't exist or you can't read it."),
          },
        },
      },
      "/api/webhooks/{webhookId}": {
        get: {
          operationId: "getWebhook",
          summary: "Get a webhook",
          security: bearer,
          parameters: [idParam],
          responses: {
            "200": json({ allOf: [ref("Webhook"), { type: "object", properties: { url: { type: "string" } } }] }, "The webhook."),
            "404": json(ref("Error"), "No such webhook."),
          },
        },
        patch: {
          operationId: "updateWebhook",
          summary: "Update a webhook",
          security: bearer,
          parameters: [idParam],
          requestBody: { required: true, content: { "application/json": { schema: ref("WebhookUpdate") } } },
          responses: {
            "200": json(ref("Webhook"), "Updated."),
            "400": json(ref("InvalidPayload"), "The body was refused."),
            "404": json(ref("Error"), "No such webhook, or an avatar file you can't read."),
          },
        },
        delete: {
          operationId: "deleteWebhook",
          summary: "Delete a webhook",
          security: bearer,
          parameters: [idParam],
          responses: {
            "200": json({ type: "object", properties: { ok: { const: true } } }, "Deleted."),
            "404": json(ref("Error"), "No such webhook."),
          },
        },
      },
    },
  };
}

export function webhookOpenApiJson(): string {
  return `${JSON.stringify(buildWebhookOpenApi(), null, 2)}\n`;
}

if (require.main === module) {
  const out = join(__dirname, "..", "..", "openapi", "webhooks.json");
  writeFileSync(out, webhookOpenApiJson());
  console.log(`wrote ${out}`);
}
