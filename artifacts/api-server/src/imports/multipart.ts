/**
 * Reading one bank file out of a `multipart/form-data` request.
 *
 * Every bound is declared here and enforced by the parser, not hoped for: how
 * many parts and fields may arrive, how long a field name or value may be, and
 * how many bytes the file may carry. Exceeding any of them ends the request
 * instead of allocating more.
 *
 * The caller decides whether the upload is allowed *before* its bytes are
 * consumed. Parts arrive in whatever order the client sent them, so a file
 * that precedes its `accountId` is refused rather than accepted against an
 * unvalidated destination: nothing is stored until the fields that say where
 * it belongs have been seen and checked.
 *
 * Authentication, origin and CSRF are already settled by middleware before
 * this runs, so no unauthenticated request ever reaches the parser.
 */
import { Busboy, type BusboyConfig, type BusboyHeaders } from "@fastify/busboy";
import { Transform, type Readable } from "node:stream";

export const MULTIPART_LIMITS = Object.freeze({
  /** `accountId` and `formatId`, with a little room to detect extras. */
  fields: 4,
  fieldNameSize: 100,
  fieldSize: 1024,
  files: 1,
  fileSize: 10 * 1024 * 1024,
  parts: 6,
  headerPairs: 20,
});

export const MULTIPART_MAX_BYTES = MULTIPART_LIMITS.fileSize + 64 * 1024;

export type MultipartFailure =
  | "not_multipart"
  | "too_many_parts"
  | "file_too_large"
  | "file_missing"
  | "file_before_fields"
  | "malformed_multipart";

export class MultipartError extends Error {
  constructor(readonly code: MultipartFailure) {
    // Nothing from the request body reaches this message.
    super({
      not_multipart: "Send this upload as multipart/form-data.",
      too_many_parts: "That upload carried more parts than this service accepts.",
      file_too_large: "That file is larger than the import limit.",
      file_missing: "That upload did not include a file.",
      file_before_fields: "Send the account and format fields before the file.",
      malformed_multipart: "The upload could not be read.",
    }[code]);
    this.name = "MultipartError";
  }
}

export interface MultipartUpload<T> {
  fields: Readonly<Record<string, string>>;
  filename: string | undefined;
  accepted: T;
}

export interface ReadMultipartOptions<T> {
  headers: BusboyHeaders;
  /**
   * Called once, when the file part begins and before any of its bytes are
   * consumed. Throwing here refuses the upload without storing anything.
   */
  authorize: (fields: Readonly<Record<string, string>>) => void;
  /** Consumes the file's bytes. Whatever it returns is handed back to the caller. */
  consume: (file: AsyncIterable<Uint8Array>) => Promise<T>;
  /** Fields that must have arrived before the file part. */
  requiredFields: readonly string[];
}

export async function readMultipartUpload<T>(
  request: Readable,
  options: ReadMultipartOptions<T>,
): Promise<MultipartUpload<T>> {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  let busboy: InstanceType<typeof Busboy>;
  const config: BusboyConfig = { headers: options.headers, limits: MULTIPART_LIMITS };
  try {
    busboy = new Busboy(config);
  } catch {
    // A missing boundary or a content type that is not multipart at all.
    throw new MultipartError("not_multipart");
  }

  let filename: string | undefined;
  /** The fields exactly as they stood when the upload was authorized. */
  let authorized: Readonly<Record<string, string>> | undefined;
  let consumed: Promise<T> | undefined;
  let failure: Error | undefined;
  let activeFile: Readable | undefined;
  let requestBytes = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      requestBytes += chunk.byteLength;
      callback(requestBytes > MULTIPART_MAX_BYTES ? new MultipartError("file_too_large") : null, chunk);
    },
  });
  /** The first failure wins: a later event must not overwrite the real cause. */
  const fail = (error: Error): void => { failure ??= error; };

  /**
   * Stops parsing instead of waiting for the parser to finish.
   *
   * A consumer that throws part-way through the file - the store out of room,
   * a write failing - leaves that part destroyed behind it, and a destroyed
   * part never reaches `finish`. Waiting for it would leave the request
   * unanswered for as long as the client held the connection open. Pause the
   * request instead of draining unlimited rejected bytes; HTTP closes it after
   * sending the refusal.
   */
  let settle: (() => void) | undefined;
  const stopParsing = (): void => {
    request.unpipe(bounded);
    bounded.unpipe(busboy);
    request.pause();
    activeFile?.destroy(failure);
    bounded.destroy();
    busboy.destroy();
    settle?.();
  };

  const finished = new Promise<void>(resolve => {
    settle = resolve;
    busboy.on("field", (name: string, value: string) => {
      if (typeof name === "string" && options.requiredFields.includes(name)) fields[name] = value;
    });

    busboy.on("file", (_name: string, file: Readable, suppliedName: string) => {
      file.on("error", () => {});
      if (failure !== undefined) {
        file.destroy();
        return;
      }
      if (consumed !== undefined) {
        // A second file: the parser's own limit reports it, and this one is
        // discarded rather than silently replacing the first. It never becomes
        // the active file, so cancelling still destroys the part being read.
        file.resume();
        return;
      }
      activeFile = file;
      filename = typeof suppliedName === "string" ? suppliedName : undefined;
      const missing = options.requiredFields.filter(name => fields[name] === undefined);
      if (missing.length > 0) {
        fail(new MultipartError("file_before_fields"));
        stopParsing();
        return;
      }
      // The fields are copied here, and it is the copy that is authorized and
      // handed back. A field part arriving *after* the file would otherwise
      // keep writing into the same object, so the caller would be given an
      // envelope that is not the one the checks were made against.
      authorized = Object.freeze({ ...fields });
      try {
        options.authorize(authorized);
      } catch (error) {
        // Refused before a single byte is stored; cancel without waiting for
        // the sender to finish the rejected body.
        fail(error as Error);
        stopParsing();
        return;
      }
      file.on("limit", () => {
        fail(new MultipartError("file_too_large"));
        stopParsing();
      });
      // The store must not observe EOF (and publish) until the entire envelope
      // passes validation. A late second part or malformed ending instead
      // throws inside receive(), which still owns and cleans the staging file.
      consumed = options.consume((async function* () {
        for await (const chunk of file) yield chunk as Uint8Array;
        await finished;
        if (failure !== undefined) throw failure;
      })());
      // The rejection is captured here so an early failure cannot become an
      // unhandled rejection while the parser is still running.
      consumed.catch((error: unknown) => {
        fail(error as Error);
        stopParsing();
      });
    });

    const tooMany = (): void => {
      fail(new MultipartError("too_many_parts"));
      stopParsing();
    };
    busboy.on("filesLimit", tooMany);
    busboy.on("fieldsLimit", tooMany);
    busboy.on("partsLimit", tooMany);
    busboy.on("error", (error: unknown) => {
      fail(error instanceof MultipartError ? error : new MultipartError("malformed_multipart"));
      stopParsing();
    });
    // v3 of the parser ends with `finish`; it never emits `close`.
    busboy.on("finish", () => resolve());
    bounded.on("error", error => { fail(error); stopParsing(); });
    request.on("error", onRequestError);
    request.on("close", onRequestClose);
    request.pipe(bounded).pipe(busboy);
  });

  function onRequestError(): void {
    fail(new MultipartError("malformed_multipart"));
    stopParsing();
  }
  function onRequestClose(): void {
    if (!request.readableEnded) onRequestError();
  }

  await finished;
  // Await the consumer before reporting: a store failure is the real outcome,
  // not whatever the parser happened to finish with.
  let accepted: T | undefined;
  if (consumed !== undefined) {
    try {
      accepted = await consumed;
    } catch (error) {
      fail(error as Error);
    }
  }
  request.off("error", onRequestError);
  request.off("close", onRequestClose);
  if (failure !== undefined) throw failure;
  if (consumed === undefined) throw new MultipartError("file_missing");
  return { fields: authorized ?? fields, filename, accepted: accepted as T };
}
