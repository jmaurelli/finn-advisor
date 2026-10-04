/**
 * The bound on how many uploads are processed at once.
 *
 * The property that matters is that a slot is taken before anything can await,
 * and given back on every way out - including a job that throws - so a failed
 * upload cannot leak capacity and leave the endpoint permanently busy.
 */
import { describe, expect, it } from "vitest";
import { createImportAdmission, ImportBusyError } from "../src/imports/admission.js";

/** A job that stays pending until the test lets it finish. */
function gate(): { job: () => Promise<string>; finish: () => void; fail: (error: Error) => void } {
  let settle: ((value: string) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const pending = new Promise<string>((resolve, rejectWith) => { settle = resolve; reject = rejectWith; });
  return { job: () => pending, finish: () => settle!("done"), fail: error => reject!(error) };
}

describe("import admission", () => {
  it("admits up to its limit and refuses beyond it", async () => {
    const admission = createImportAdmission({ limit: 2 });
    const first = gate();
    const second = gate();
    const running = [admission.run(first.job), admission.run(second.job)];
    expect(admission.active()).toBe(2);
    await expect(admission.run(() => Promise.resolve("third"))).rejects.toBeInstanceOf(ImportBusyError);
    first.finish();
    second.finish();
    expect(await Promise.all(running)).toEqual(["done", "done"]);
    expect(admission.active()).toBe(0);
  });

  it("never runs the refused job", async () => {
    const admission = createImportAdmission({ limit: 1 });
    const held = gate();
    const running = admission.run(held.job);
    let ran = false;
    await expect(admission.run(async () => { ran = true; return "ran"; })).rejects.toThrow(/already being processed/);
    expect(ran).toBe(false);
    held.finish();
    await running;
  });

  it("releases the slot when a job fails", async () => {
    const admission = createImportAdmission({ limit: 1 });
    const failing = gate();
    const running = admission.run(failing.job);
    failing.fail(new Error("storage unavailable"));
    await expect(running).rejects.toThrow("storage unavailable");
    expect(admission.active()).toBe(0);
    await expect(admission.run(() => Promise.resolve("next"))).resolves.toBe("next");
  });

  it("defaults to two and never admits fewer than one", () => {
    expect(createImportAdmission().limit()).toBe(2);
    for (const limit of [0, -5, 0.5]) expect(createImportAdmission({ limit }).limit()).toBe(1);
  });

  it("reports the limit on the refusal", async () => {
    const admission = createImportAdmission({ limit: 1 });
    const held = gate();
    const running = admission.run(held.job);
    const refusal = await admission.run(() => Promise.resolve("x")).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ImportBusyError);
    expect((refusal as ImportBusyError).limit).toBe(1);
    held.finish();
    await running;
  });
});
