import { OpenAPIObject } from "@nestjs/swagger";
import {
  SchemaObject,
  ReferenceObject,
  OperationObject,
} from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";

type Schema = SchemaObject | ReferenceObject;
const string: SchemaObject = { type: "string" };
const boolean: SchemaObject = { type: "boolean" };
const integer: SchemaObject = { type: "integer" };
const uuid: SchemaObject = { type: "string", format: "uuid" };
const date: SchemaObject = { type: "string", format: "date-time" };
const nullable = (schema: SchemaObject): SchemaObject => ({ ...schema, nullable: true });
const ref = (name: string): ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
const array = (items: Schema): SchemaObject => ({ type: "array", items });
const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): SchemaObject => ({ type: "object", properties, required });
const enumeration = (...values: string[]): SchemaObject => ({ type: "string", enum: values });
const json: SchemaObject = {
  description: "JSON value stored by Pedirr or supplied by the metadata provider.",
};
const status = enumeration("PENDING", "APPROVED", "REJECTED", "DOWNLOADING", "AVAILABLE");
const page = (item: Schema, size: number): SchemaObject =>
  object({
    items: array(item),
    total: integer,
    page: integer,
    pageSize: { type: "integer", enum: [size] },
  });
const requestProperties = {
  id: uuid,
  entityId: uuid,
  entity: ref("CatalogEntity"),
  scopeKey: string,
  scope: ref("RequestScope"),
  status,
  integrationState: string,
  lastError: nullable(string),
  reviewedBy: nullable(uuid),
  rejectionReason: nullable(string),
  version: integer,
  createdAt: date,
  updatedAt: date,
  _count: object({ subscribers: integer }),
};
const schemas: Record<string, SchemaObject> = {
  PublicUser: object({
    id: uuid,
    email: { type: "string", format: "email" },
    role: enumeration("ADMIN", "USER"),
    active: boolean,
    locale: enumeration("en", "es"),
    timezone: string,
    autoApprove: nullable(boolean),
  }),
  Ok: object({ ok: { type: "boolean", enum: [true] } }),
  CsrfToken: object({
    token: {
      type: "string",
      description:
        "Send as x-csrf-token on writes. Fetch again after login; tokens are session-bound.",
    },
  }),
  ApiError: object(
    {
      code: string,
      message: { oneOf: [string, array(string)] },
      statusCode: integer,
      error: string,
      retryAfterSeconds: integer,
      upstreamStatus: integer,
      reason: string,
    },
    [],
  ),
  MetadataItem: {
    ...object(
      {
        id: string,
        name: string,
        shortId: nullable(string),
        tsdbId: nullable(string),
        leagueId: nullable(string),
        seasonId: nullable(string),
        scheduledStart: nullable(string),
      },
      ["id", "name"],
    ),
    additionalProperties: true,
    description:
      "Provider metadata. Optional fields may be absent or null; identifiers remain in their provider namespace.",
  },
  MetadataPage: object({
    items: array(ref("MetadataItem")),
    total: integer,
    page: integer,
    pageSize: integer,
    totalPages: integer,
  }),
  MetadataSearch: object({
    query: string,
    total: integer,
    results: array({
      allOf: [ref("MetadataItem"), object({ entityType: enumeration("league", "team", "event") })],
    }),
  }),
  ExternalIdentifier: object({
    id: uuid,
    entityId: uuid,
    provider: string,
    namespace: string,
    value: string,
  }),
  CatalogEntity: object({
    id: uuid,
    kind: enumeration("LEAGUE", "TEAM", "EVENT"),
    title: string,
    metadata: json,
    updatedAt: date,
    identifiers: array(ref("ExternalIdentifier")),
  }),
  RequestScope: {
    oneOf: [
      object({
        kind: enumeration("event"),
        provider: enumeration("hub"),
        event: ref("MetadataItem"),
        league: ref("MetadataItem"),
      }),
      object({
        kind: enumeration("season"),
        provider: enumeration("hub"),
        season: ref("MetadataItem"),
        league: ref("MetadataItem"),
      }),
    ],
  },
  ContentRequest: object(requestProperties),
  RequestListItem: object({ ...requestProperties, subscribed: boolean }),
  RequestDetail: object({
    ...requestProperties,
    subscribed: boolean,
    events: array(
      object({
        id: uuid,
        metadata: json,
        available: boolean,
        progress: { type: "number" },
        checkedAt: nullable(date),
      }),
    ),
    history: array(object({ id: uuid, action: string, details: json, createdAt: date })),
  }),
  CreateRequestResult: {
    oneOf: [
      object({ created: boolean, request: ref("ContentRequest") }),
      object({
        created: { type: "boolean", enum: [false] },
        available: { type: "boolean", enum: [true] },
        request: { type: "object", nullable: true, enum: [null] },
      }),
    ],
  },
  Availability: {
    oneOf: [
      object({ state: enumeration("requested"), request: object({ id: uuid, status }) }),
      object(
        {
          state: enumeration("available", "missing", "unknown"),
          reason: enumeration("not_configured", "unreachable", "identity", "incomplete"),
        },
        ["state"],
      ),
    ],
  },
  SportarrSettingsResult: object({
    configured: boolean,
    url: string,
    hasApiKey: boolean,
    rootFolderId: nullable(integer),
    qualityProfileId: nullable(integer),
  }),
  SportarrConnection: object({
    appName: enumeration("Sportarr"),
    version: string,
    leagues: integer,
    rootFolders: array(object({ id: integer, path: string })),
    qualityProfiles: array(object({ id: integer, name: string })),
  }),
  NotificationSettingsResult: object({
    emailEnabled: boolean,
    smtpHost: string,
    smtpPort: integer,
    smtpSecurity: enumeration("tls", "starttls", "plain"),
    smtpUser: string,
    emailFrom: string,
    discordEnabled: boolean,
    discordLocale: enumeration("en", "es"),
    emailSince: date,
    discordSince: date,
    hasSmtpPassword: boolean,
    hasDiscordWebhook: boolean,
  }),
  NotificationDelivery: object({
    id: uuid,
    eventId: uuid,
    channel: enumeration("email", "discord"),
    recipient: {
      type: "string",
      description: "Email address or SHA-256 webhook fingerprint; never a webhook URL.",
    },
    status: enumeration("pending", "sending", "sent", "failed"),
    attempts: integer,
    lastError: nullable(string),
    createdAt: date,
  }),
};

// Explicit response contracts supplement Nest's request DTO discovery. Missing routes fail startup.
const responses: Record<string, Schema> = {
  "GET health/live": object({ status: enumeration("ok"), service: enumeration("pedirr-api") }),
  "GET health/ready": object({
    status: enumeration("ok"),
    database: enumeration("ok"),
    queue: enumeration("ok"),
    worker: enumeration("ok"),
  }),
  "GET auth/csrf": ref("CsrfToken"),
  "GET auth/config": object({ registrationEnabled: boolean }),
  "POST auth/register": ref("PublicUser"),
  "POST auth/login": ref("PublicUser"),
  "POST auth/logout": ref("Ok"),
  "GET auth/me": ref("PublicUser"),
  "PATCH me": ref("PublicUser"),
  "POST me/password": ref("Ok"),
  "GET admin/users/{id}": ref("PublicUser"),
  "GET admin/users": page(ref("PublicUser"), 50),
  "POST admin/users": ref("PublicUser"),
  "PATCH admin/users/{id}": ref("PublicUser"),
  "GET admin/policies": ref("AccessPolicy"),
  "PATCH admin/policies": ref("AccessPolicy"),
  "GET catalog/search": ref("MetadataSearch"),
  "GET catalog/leagues": ref("MetadataPage"),
  "GET catalog/leagues/{id}": ref("MetadataItem"),
  "GET catalog/leagues/{id}/seasons": ref("MetadataPage"),
  "GET catalog/seasons/{id}": ref("MetadataItem"),
  "GET catalog/teams/{id}": ref("MetadataItem"),
  "GET catalog/events": ref("MetadataPage"),
  "GET catalog/events/{id}": ref("MetadataItem"),
  "GET catalog/upcoming": object({
    items: array(ref("MetadataItem")),
    page: integer,
    hasMore: boolean,
    nextPage: nullable(integer),
  }),
  "GET catalog/popular": object({
    basis: enumeration("local-requests"),
    items: array({ allOf: [ref("CatalogEntity"), object({ requestCount: integer })] }),
  }),
  "GET requests": page(ref("RequestListItem"), 30),
  "POST requests": ref("CreateRequestResult"),
  "GET requests/lookup": ref("Availability"),
  "GET requests/{id}": ref("RequestDetail"),
  "POST requests/{id}/review": ref("ContentRequest"),
  "GET admin/settings/sportarr": ref("SportarrSettingsResult"),
  "PUT admin/settings/sportarr": ref("SportarrSettingsResult"),
  "POST admin/settings/sportarr/test": ref("SportarrConnection"),
  "GET admin/settings/notifications": ref("NotificationSettingsResult"),
  "PUT admin/settings/notifications": ref("NotificationSettingsResult"),
  "GET admin/settings/notifications/deliveries": array(ref("NotificationDelivery")),
};

export function completeOpenApi(document: OpenAPIObject, origin: string): OpenAPIObject {
  document.components ??= {};
  document.components.schemas = { ...document.components.schemas, ...schemas };
  document.components.securitySchemes = {
    Session: {
      type: "apiKey",
      in: "cookie",
      name: new URL(origin).protocol === "https:" ? "__Host-pedirr_session" : "pedirr_session",
      description:
        "Obtain the HttpOnly session cookie from POST /api/v1/auth/login. Browser clients send cookies automatically.",
    },
  };
  document.info.description +=
    "\n\nWrite requests require the exact configured Origin and x-csrf-token from GET /api/v1/auth/csrf. Refresh the token after login. Administrators manage settings and approvals. Errors may use a stable code or Nest validation messages; clients must also handle the HTTP status. Dates use ISO 8601; page numbers start at 1. Secrets are write-only.";
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation: OperationObject | undefined = item?.[method];
      if (!operation) {
        continue;
      }
      const route = path.replace(/^\/api\/v1\//, "");
      const schema = responses[`${method.toUpperCase()} ${route}`];
      if (!schema) {
        throw new Error(`Missing OpenAPI response contract: ${method} ${path}`);
      }
      const publicRoute =
        route.startsWith("health/") ||
        ["auth/csrf", "auth/config", "auth/login", "auth/register"].includes(route);
      operation.security = publicRoute ? [] : [{ Session: [] }];
      const code = method === "post" ? "201" : "200";
      operation.responses[code] = {
        description: "Successful response",
        content: { "application/json": { schema } },
      };
      operation.responses.default = {
        description:
          "Error. Authentication: 401; CSRF/permissions: 403; invalid input: 400; stale review/identity conflict: 409; rate limit: 429; upstream failure: 502/503. Retry delays, when supplied, are in retryAfterSeconds.",
        content: { "application/json": { schema: ref("ApiError") } },
      };
      if (route.startsWith("admin/") || route.endsWith("/review")) {
        operation.description = `${operation.description ?? ""}\nRequires the ADMIN role.`.trim();
      }
      if (!["get"].includes(method)) {
        operation.parameters ??= [];
        operation.parameters.push(
          {
            name: "x-csrf-token",
            in: "header",
            required: true,
            schema: string,
            description: "Session-bound token from GET /api/v1/auth/csrf.",
          },
          {
            name: "Origin",
            in: "header",
            required: true,
            schema: string,
            description: "Must exactly equal APP_ORIGIN, including the port.",
          },
        );
      }
    }
  }
  return document;
}
