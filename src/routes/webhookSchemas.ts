import { z } from "zod";

import { MESSAGE_MAX_LENGTH } from "../utils/messageLimits";

/** Limits for what a webhook can post. The OpenAPI document is generated from these schemas. */
export const WEBHOOK_LIMITS = {
  displayName: 64,
  url: 2048,
  cards: 10,
  title: 256,
  description: 4000,
  authorName: 256,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  /** Over every card's title, description, field names and values, author name and footer text. */
  cardsTotal: 6000,
  /** Problems listed in one refusal. */
  problems: 20,
} as const;

const L = WEBHOOK_LIMITS;

const httpUrl = z
  .url({ protocol: /^https?$/ })
  .max(L.url)
  .describe("An http or https URL.");

/** Fetched by the server once, when the message is posted. Viewers never load it. */
const imageUrl = z
  .url({ protocol: /^https?$/ })
  .max(L.url)
  .describe(
    "An http or https URL to a PNG, JPEG, WebP or GIF. The server fetches it once, when the message is posted, and stores a copy. Private and local addresses are refused.",
  );

const color = z
  .union([
    z.string().regex(/^#[0-9a-fA-F]{6}$/),
    z.number().int().min(0).max(0xffffff),
  ])
  .describe("The card's colour, as `#rrggbb` or an integer from 0 to 16777215.");

export const webhookCardFieldSchema = z.object({
  name: z.string().trim().min(1).max(L.fieldName).describe("Plain text."),
  value: z.string().trim().min(1).max(L.fieldValue).describe("Markdown."),
  inline: z.boolean().default(false).describe("Inline fields share a row."),
});

export const webhookCardSchema = z
  .object({
    title: z.string().trim().min(1).max(L.title).optional().describe("Plain text."),
    url: httpUrl.optional().describe("Makes the title a link."),
    description: z.string().trim().min(1).max(L.description).optional().describe("Markdown. Mentions don't notify anyone."),
    color: color.optional(),
    author: z
      .object({
        name: z.string().trim().min(1).max(L.authorName).describe("Plain text."),
        url: httpUrl.optional(),
        icon_url: imageUrl.optional(),
      })
      .optional(),
    fields: z.array(webhookCardFieldSchema).max(L.fields).optional(),
    image_url: imageUrl.optional(),
    thumbnail_url: imageUrl.optional(),
    footer: z
      .object({
        text: z.string().trim().min(1).max(L.footerText).describe("Plain text."),
        icon_url: imageUrl.optional(),
      })
      .optional(),
    timestamp: z.iso.datetime({ offset: true }).optional().describe("ISO 8601, with a time zone."),
  })
  .superRefine((card, ctx) => {
    const hasContent = card.title || card.description || card.fields?.length || card.image_url || card.author;
    if (!hasContent) {
      ctx.addIssue({
        code: "custom",
        params: { code: "empty_card" },
        message: "A card needs a title, description, fields, image_url or author.",
      });
    }
  });

export const webhookMessageSchema = z
  .object({
    text: z
      .string()
      .trim()
      .max(MESSAGE_MAX_LENGTH)
      .optional()
      .describe("Markdown. Required unless there are cards. The only part of a message whose mentions notify."),
    display_name: z
      .string()
      .optional()
      .describe(`Posts under this name instead of the webhook's. Cut to ${L.displayName} characters.`),
    avatar_url: imageUrl.optional().describe(
      "Posts with this picture instead of the webhook's. Fetched once and stored, same as card images.",
    ),
    cards: z.array(webhookCardSchema).max(L.cards).optional(),
  })
  .superRefine((body, ctx) => {
    const cards = body.cards ?? [];
    if (!body.text && cards.length === 0) {
      ctx.addIssue({ code: "custom", params: { code: "empty_message" }, message: "Send text, cards or both." });
    }
    const total = cards.reduce((sum, card) => sum + cardTextLength(card), 0);
    if (total > L.cardsTotal) {
      ctx.addIssue({
        code: "custom",
        path: ["cards"],
        params: { code: "total_too_long", limit: L.cardsTotal },
        message: `All cards together are limited to ${L.cardsTotal} characters.`,
      });
    }
  });

export type WebhookMessageInput = z.infer<typeof webhookMessageSchema>;
export type WebhookCardInput = z.infer<typeof webhookCardSchema>;

export function cardTextLength(card: WebhookCardInput): number {
  return (
    (card.title?.length ?? 0) +
    (card.description?.length ?? 0) +
    (card.author?.name.length ?? 0) +
    (card.footer?.text.length ?? 0) +
    (card.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}

export const webhookCreateSchema = z.object({
  channel_id: z.string().trim().default("").describe("The channel the webhook posts to."),
  display_name: z.string().optional().describe(`Cut to ${L.displayName} characters. Defaults to "Webhook".`),
  avatar_file_id: z.string().nullable().optional().describe("An uploaded file you can read."),
});

export const webhookUpdateSchema = z.object({
  channel_id: z.string().optional(),
  display_name: z.string().optional().describe(`Cut to ${L.displayName} characters.`),
  avatar_file_id: z.string().nullable().optional().describe("An uploaded file you can read, or null to remove it."),
});

export interface PayloadProblem {
  path: string;
  code: string;
  limit?: number;
  message: string;
}

export interface PayloadWarning {
  path: string;
  code: string;
  message: string;
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

/** One problem per zod issue, in the codes the API documents. */
export function problemsFrom(error: z.ZodError): PayloadProblem[] {
  const problems = error.issues.map((issue): PayloadProblem => {
    const path = formatPath(issue.path);
    const last = issue.path[issue.path.length - 1];
    const base = { path, message: issue.message };
    // A colour is a string or a number, and either can fail in its own way.
    if (last === "color" && issue.code !== "custom") {
      return { path, code: "invalid_color", message: "Use #rrggbb or an integer from 0 to 16777215." };
    }
    switch (issue.code) {
      case "custom": {
        const params = (issue.params ?? {}) as { code?: string; limit?: number };
        return { ...base, code: params.code ?? "invalid", ...(params.limit ? { limit: params.limit } : {}) };
      }
      case "invalid_type":
        return { ...base, code: issue.input === undefined ? "required" : "wrong_type" };
      case "too_big":
        return { ...base, code: issue.origin === "array" ? "too_many" : "too_long", limit: Number(issue.maximum) };
      case "too_small":
        return { ...base, code: "required" };
      case "invalid_format":
        if (issue.format === "url") return { ...base, code: "invalid_url" };
        if (issue.format === "datetime") return { ...base, code: "invalid_timestamp" };
        return { ...base, code: "invalid_format" };
      case "invalid_union":
        return { ...base, code: "wrong_type" };
      default:
        return { ...base, code: "invalid" };
    }
  });
  return problems.slice(0, L.problems);
}

const KNOWN = {
  message: new Set(Object.keys(webhookMessageSchema.shape)),
  card: new Set(Object.keys(webhookCardSchema.shape)),
  author: new Set(["name", "url", "icon_url"]),
  footer: new Set(["text", "icon_url"]),
  field: new Set(Object.keys(webhookCardFieldSchema.shape)),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys the schema drops. Reported rather than refused, so a payload written for another chat app mostly works. */
export function unknownKeys(body: unknown): PayloadWarning[] {
  const out: PayloadWarning[] = [];
  const check = (value: unknown, known: Set<string>, prefix: string) => {
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
      if (!known.has(key)) {
        const path = prefix ? `${prefix}.${key}` : key;
        out.push({ path, code: "unknown_key", message: `${path} isn't part of a webhook message and was ignored.` });
      }
    }
  };
  check(body, KNOWN.message, "");
  if (isRecord(body) && Array.isArray(body.cards)) {
    body.cards.forEach((card, i) => {
      check(card, KNOWN.card, `cards[${i}]`);
      if (!isRecord(card)) return;
      check(card.author, KNOWN.author, `cards[${i}].author`);
      check(card.footer, KNOWN.footer, `cards[${i}].footer`);
      if (Array.isArray(card.fields)) card.fields.forEach((f, j) => check(f, KNOWN.field, `cards[${i}].fields[${j}]`));
    });
  }
  return out.slice(0, L.problems);
}

export function colorToHex(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return `#${value.toString(16).padStart(6, "0")}`;
  return value.toLowerCase();
}
