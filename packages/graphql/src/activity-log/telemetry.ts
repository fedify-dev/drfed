// DrFed: A web-based platform for developing and debugging ActivityPub apps
// Copyright (C) 2026 DrFed team
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import diagnostics from "node:diagnostics_channel";

import {
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider,
  type Span,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";

import {
  type ObservedKeyFetch,
  type ObservedKeyLookup,
  type ObservedSpan,
  type Tracked,
  tracking,
} from "./tracking.ts";

/** The spans whose attributes and events Fedify documents as its report. */
const REPORTED_SPANS: ReadonlySet<string> = new Set([
  "activitypub.inbox",
  "activitypub.send_activity",
  "http_signatures.verify",
  "ld_signatures.verify",
  "object_integrity_proofs.verify",
]);
const SIGNATURE_METRIC = "activitypub.signature.verification.duration";
const KEY_FETCH_METRIC = "activitypub.signature.key_fetch.duration";
const KEY_LOOKUP_METRIC = "activitypub.key.lookup";
const OUTBOX_METRIC = "activitypub.outbox.activity";

const bindTo = (target: object, property: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
};

function observeSpan(name: string, span: Span): Span {
  const state = tracking();
  if (state == null || !REPORTED_SPANS.has(name)) return span;
  const attributes = new Map<string, unknown>();
  const events: ObservedSpan["events"][number][] = [];
  const observed = { name, attributes, events, failed: false };
  state.spans.push(observed);
  const proxy: Span = new Proxy(span, {
    get(target, property) {
      switch (property) {
        // Fedify records some attributes only on recording spans.
        case "isRecording":
          return () => true;
        case "setAttribute":
          return (key: string, value: Parameters<Span["setAttribute"]>[1]) => {
            attributes.set(key, value);
            target.setAttribute(key, value);
            return proxy;
          };
        case "setAttributes":
          return (values: Attributes) => {
            for (const [key, value] of Object.entries(values)) {
              attributes.set(key, value);
            }
            target.setAttributes(values);
            return proxy;
          };
        case "addEvent":
          return (event: string, ...rest: unknown[]) => {
            const [values] = rest;
            events.push({
              name: event,
              attributes:
                values != null &&
                typeof values === "object" &&
                !Array.isArray(values) &&
                !(values instanceof Date)
                  ? (values as Attributes)
                  : {},
            });
            (target.addEvent as (...args: unknown[]) => Span)(event, ...rest);
            return proxy;
          };
        case "setStatus":
          return (status: Parameters<Span["setStatus"]>[0]) => {
            if (status.code === SpanStatusCode.ERROR) observed.failed = true;
            target.setStatus(status);
            return proxy;
          };
        default:
          return bindTo(target, property);
      }
    },
  });
  return proxy;
}

function observeTracer(tracer: Tracer): Tracer {
  return {
    startSpan: (name, options, context) =>
      observeSpan(name, tracer.startSpan(name, options, context)),
    startActiveSpan: ((name: string, ...rest: unknown[]) => {
      const run = rest.pop() as (span: Span) => unknown;
      return (tracer.startActiveSpan as (...args: unknown[]) => unknown)(
        name,
        ...rest,
        (span: Span) => run(observeSpan(name, span)),
      );
    }) as Tracer["startActiveSpan"],
  };
}

/**
 * Let `trackRequest()` see the spans Fedify reports, while passing them on to
 * `provider` unchanged.
 * @returns A tracer provider to give Fedify instead.
 */
export function trackSpans(provider: TracerProvider): TracerProvider {
  return {
    getTracer: (name, version, options) =>
      observeTracer(provider.getTracer(name, version, options)),
  };
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** What a measurement adds to the tracked run it was made in. */
type Note = (state: Tracked, attributes: Attributes | undefined) => void;

/**
 * The key lookup and fetches Fedify measured whose verification it has not
 * measured yet.  It reads and writes the public-key cache and counts a lookup,
 * then measures the fetch that made them, and then the verification that
 * fetched.
 */
interface Pending {
  lookup: ObservedKeyLookup | null;
  fetches: { readonly kind: string; readonly fetch: ObservedKeyFetch }[];
}

const pending = new WeakMap<Tracked, Pending>();

function pendingOf(state: Tracked): Pending {
  const known = pending.get(state);
  if (known != null) return known;
  const created: Pending = { lookup: null, fetches: [] };
  pending.set(state, created);
  return created;
}

const noteKeyLookup: Note = (state, attributes) => {
  const status = attributes?.["http.response.status_code"];
  pendingOf(state).lookup = {
    result: text(attributes?.["activitypub.lookup.result"]),
    statusCode: typeof status === "number" ? status : null,
  };
};

const noteKeyFetch: Note = (state, attributes) => {
  const waiting = pendingOf(state);
  waiting.fetches.push({
    kind: text(attributes?.["activitypub.signature.kind"]),
    fetch: {
      result: text(attributes?.["activitypub.signature.key_fetch.result"]),
      lookup: waiting.lookup,
      keys: state.keys,
    },
  });
  waiting.lookup = null;
  state.keys = new Map();
};

const noteVerification: Note = (state, attributes) => {
  const waiting = pendingOf(state);
  const kind = text(attributes?.["activitypub.signature.kind"]);
  state.verifications.push({
    kind,
    result: text(attributes?.["activitypub.signature.result"]),
    keyFetches: waiting.fetches
      .filter((fetched) => fetched.kind === kind)
      .map(({ fetch }) => fetch),
  });
  waiting.fetches = waiting.fetches.filter((fetched) => fetched.kind !== kind);
};

const noteOutbox: Note = (state, attributes) => {
  state.outbox.push(text(attributes?.["activitypub.processing.result"]));
};

/** The instruments whose measurements the tracked run keeps, by how made. */
const NOTES = {
  createHistogram: {
    method: "record",
    notes: new Map([
      [SIGNATURE_METRIC, noteVerification],
      [KEY_FETCH_METRIC, noteKeyFetch],
    ]),
  },
  createCounter: {
    method: "add",
    notes: new Map([
      [OUTBOX_METRIC, noteOutbox],
      [KEY_LOOKUP_METRIC, noteKeyLookup],
    ]),
  },
} as const;

function observeInstrument<T extends Counter | Histogram>(
  instrument: T,
  method: "add" | "record",
  note: Note,
): T {
  return new Proxy(instrument, {
    get(target, property) {
      if (property !== method) return bindTo(target, property);
      return (value: number, attributes?: Attributes, ...rest: unknown[]) => {
        const state = tracking();
        if (state != null) note(state, attributes);
        (bindTo(target, method) as (...args: unknown[]) => void)(
          value,
          attributes,
          ...rest,
        );
      };
    },
  });
}

function observeMeter(meter: Meter): Meter {
  return new Proxy(meter, {
    get(target, property) {
      if (property !== "createHistogram" && property !== "createCounter") {
        return bindTo(target, property);
      }
      const { method, notes } = NOTES[property];
      return (name: string, ...rest: unknown[]) => {
        const instrument = (
          bindTo(target, property) as (
            ...args: unknown[]
          ) => Counter | Histogram
        )(name, ...rest);
        const note = notes.get(name);
        return note == null
          ? instrument
          : observeInstrument(instrument, method, note);
      };
    },
  });
}

/**
 * Let `trackRequest()` see the signature verifications, with the key fetches
 * each made and the keys `trackPublicKeys()` saw each bring, and the outbox
 * outcomes Fedify measures, while passing them on to `provider` unchanged.
 * @returns A meter provider to give Fedify instead.
 */
export function trackMetrics(provider: MeterProvider): MeterProvider {
  return {
    getMeter: (name, version, options) =>
      observeMeter(provider.getMeter(name, version, options)),
  };
}

interface UndiciRequest {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
}

interface UndiciResponse {
  readonly statusCode: number;
  /** Header names and values, in turn. */
  readonly headers: readonly Buffer[];
}

const header = (value: Buffer): string => value.toString("latin1");
const ascii = (value: Buffer): boolean => value.every((byte) => byte < 0x80);

/**
 * The URLs a response's `Location` may send the request following it to,
 * spelled as that request is: resolved against the URL answered, without a
 * fragment.  RFC 9110 keeps the value within ASCII; one outside it is read as
 * Latin-1 by Fedify, which follows a redirect itself when it signs the
 * request, and as UTF-8 by `fetch()`, which follows it otherwise.
 * @returns The URLs, without one that does not parse.
 */
function locationsOf(headers: readonly Buffer[], base: string): string[] {
  const index = headers.findIndex(
    (name, position) =>
      position % 2 === 0 && header(name).toLowerCase() === "location",
  );
  const value = index < 0 ? undefined : headers[index + 1];
  if (value == null) return [];
  const readings = ascii(value)
    ? [header(value)]
    : [header(value), value.toString("utf8")];
  const urls = readings.flatMap((reading) => {
    const url = URL.parse(reading, base);
    if (url == null) return [];
    url.hash = "";
    return [url.href];
  });
  return [...new Set(urls)];
}

// `fetch()` creates each request in its caller's context, but a response on a
// reused connection arrives in the connection's, so requests carry the run.
const requests = new WeakMap<UndiciRequest, Tracked>();
diagnostics.subscribe("undici:request:create", (message) => {
  const state = tracking();
  if (state != null) {
    requests.set((message as { request: UndiciRequest }).request, state);
  }
});
diagnostics.subscribe("undici:request:headers", (message) => {
  const { request, response } = message as {
    readonly request: UndiciRequest;
    readonly response: UndiciResponse;
  };
  const state = requests.get(request);
  if (state == null || state.closed) return;
  const url = new URL(request.path, request.origin).href;
  state.responses.push({
    method: request.method,
    url,
    status: response.statusCode,
    locations: locationsOf(response.headers, url),
  });
});
