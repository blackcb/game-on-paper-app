// JSON Schema contract validator for the Python /cfb/process
// response. Mirrors the Express side's wiring in games.js:7-24 +
// 254-266. Warn-only — never blocks a response. The schema lives
// at shared/process-response.schema.json (canonical) and is
// duplicated into worker/src/data/ so wrangler bundles it.
//
// Validation surface kept narrow on purpose: only the Python →
// Worker boundary. KV-cached payloads aren't re-validated because
// they were already validated when written. ESPN responses aren't
// in scope (different upstream, different schema).

import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../data/process-response.schema.json";

// strict:false because the Python-side schema uses
// `additionalProperties: true` everywhere and ajv's strict mode
// flags those as warnings; we want quiet-success.
// allErrors:true so we can log every problem in one go rather
// than bailing on the first.
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

// ajv.compile narrows the validated value to the JSON-Schema's
// inferred type. The Python schema is loose (additionalProperties:
// true everywhere) so the inferred type collapses to `{}` and
// poisons callers' downstream property access. Wrap as a plain
// boolean check that never narrows the input.
const compiledValidator = ajv.compile(schema);
export const validateProcessResponse: ((data: unknown) => boolean) & {
  errors?: SchemaError[] | null;
} = (data) => compiledValidator(data);
Object.defineProperty(validateProcessResponse, "errors", {
  get: () => compiledValidator.errors ?? null,
});

interface SchemaError {
  instancePath?: string;
  schemaPath?: string;
  keyword?: string;
  message?: string;
  params?: unknown;
}

// Defense-in-depth check on the Python → Worker boundary.
// Returns true on success; on failure, emits a structured-JSON
// log line (event: 'schema_validation_failure') and returns false.
// Caller proceeds with the unvalidated payload either way —
// Python is the canonical validator and rejecting here would
// turn schema drift into user-visible errors.
export function logSchemaFailure(gameId: string | number, errors: SchemaError[]): void {
  try {
    console.log(
      JSON.stringify({
        event: "schema_validation_failure",
        source: "worker",
        gameId,
        error_count: errors.length,
        errors: errors.slice(0, 5),
      }),
    );
  } catch {
    // logging must never break a response
  }
}
