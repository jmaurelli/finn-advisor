import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      // Emit header parameters so updates and deletes must pass If-Match.
      headers: true,
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
        // The catalog installs @tanstack/react-query 5; without this orval
        // cannot detect it from this package and emits v4 option types.
        query: {
          version: 5,
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      // No separate TypeScript types here: orval names an operation's
      // path-parameter zod schema and its query-parameter type both
      // `<Operation>Params`, which collide on re-export (TS2308). Use
      // z.infer<> on these schemas, or the types in @workspace/api-client-react.
      mode: "split",
      headers: true,
      // src/index.ts is hand-written; keep orval from appending to it.
      indexFiles: false,
      clean: true,
      prettier: true,
      override: {
        zod: {
          // Orval resolves `auto` from lib/api-spec/package.json, which has no
          // zod dependency, so orval >= 8.23 falls back to Zod 4 syntax while
          // the catalog installs zod 3. Pin to match the catalog.
          version: 3,
          // Money is a canonical integer string and dates are `YYYY-MM-DD`
          // strings (TDD section 2): never coerce bodies or responses to
          // bigint or Date. Query strings coerce only to numbers (page limits);
          // boolean coercion is omitted because z.coerce.boolean() turns the
          // string "false" into true.
          coerce: {
            query: ["number", "string"],
            param: ["string"],
          },
          // Reject unknown fields instead of silently stripping them (TDD
          // section 8). Headers stay open: requests carry many other headers.
          strict: {
            param: true,
            query: true,
            body: true,
            response: true,
            header: false,
          },
        },
      },
    },
  },
});
